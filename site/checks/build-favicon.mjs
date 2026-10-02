#!/usr/bin/env node
// 从 favicon.svg 生成 PNG 与 ICO 回退图标。
//
//   node site/checks/build-favicon.mjs
//
// 为什么需要它：SVG favicon 在 Chromium 与 Firefox 上可用，但 Safari 不支持，
// 一些抓取器、RSS 阅读器与旧浏览器同样只认 favicon.ico。只在 static/ 放一个 svg
// 会让这些场景没有图标。
//
// 本机没有 ImageMagick、没有 sharp、也不打算装——但**有 Chrome/Edge**，
// 它的 DevTools 协议能把任意 HTML 截成 PNG（Page.captureScreenshot），
// 于是用同一套「起无头浏览器 + CDP」的骨架把 SVG 渲染成 PNG。
// ICO 格式本身很简单（6 字节头 + 每张图 16 字节目录项 + PNG 数据），
// 可以直接拼出来，不必引依赖。

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SITE = resolve(HERE, '..')
const SVG = join(SITE, 'themes', 'ledger', 'static', 'favicon.svg')
const OUT_DIR = join(SITE, 'themes', 'ledger', 'static')

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

if (!existsSync(SVG)) {
  console.error(`[环境错误] 找不到 ${SVG}`)
  process.exit(2)
}
const exe = BROWSERS.find((p) => existsSync(p))
if (!exe) {
  console.error('[环境错误] 找不到 Chrome 或 Edge，无法把 SVG 栅格化。')
  console.error('  SVG favicon 已可用；PNG/ICO 回退需要浏览器。不静默跳过。')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageWsUrl(port) {
  let lastErr = ''
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (r.ok) {
        const t = (await r.json()).find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
        if (t) return t.webSocketDebuggerUrl
        lastErr = '/json/list 有响应但没有 page target'
      } else {
        lastErr = `HTTP ${r.status}`
      }
    } catch (e) {
      lastErr = e.message
    }
    await sleep(250)
  }
  throw new Error(`无头浏览器未就绪（端口 ${port}，最后一次：${lastErr}）`)
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve: res, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : res(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

/** 把 SVG 栅格化成 PNG 字节。size 为像素边长。 */
async function rasterize(cdp, svgText, size) {
  // 用 data: URL 承载 SVG，页面背景透明，截图带 alpha
  const html = `<!doctype html><meta charset=utf-8>
<style>html,body{margin:0;padding:0;background:transparent}
svg{display:block;width:${size}px;height:${size}px}</style>${svgText}`
  await cdp.send('Page.navigate', {
    url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  })
  await sleep(350)
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
  })
  return Buffer.from(data, 'base64')
}

/** 拼一个 ICO：头 6 字节 + 每图 16 字节目录 + 各图数据（这里放 PNG，Vista 起支持）。 */
function buildIco(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)      // reserved
  header.writeUInt16LE(1, 2)      // type: 1 = icon
  header.writeUInt16LE(count, 4)
  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  pngs.forEach(({ size, buf }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o + 0)      // 宽（256 记 0）
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)      // 高
    dir.writeUInt8(0, o + 2)                            // 调色板数
    dir.writeUInt8(0, o + 3)                            // reserved
    dir.writeUInt16LE(1, o + 4)                         // color planes
    dir.writeUInt16LE(32, o + 6)                        // bits per pixel
    dir.writeUInt32LE(buf.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += buf.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)])
}

const port = 9300 + (process.pid % 400)
const profile = mkdtempSync(join(tmpdir(), 'wrc-favicon-'))
const proc = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = ''
proc.stderr?.on('data', (d) => { stderr += d.toString() })
proc.on('exit', (code) => {
  if (code !== 0 && code !== null) console.error(`  [浏览器提前退出，code ${code}] ${stderr.slice(0, 400)}`)
})

let cdp
try {
  const ws = new WebSocket(await pageWsUrl(port))
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true })
  })
  cdp = new CDP(ws)
  await cdp.send('Page.enable')
  const svgText = readFileSync(SVG, 'utf8')

  const sizes = [16, 32, 48]
  const pngs = []
  for (const size of sizes) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size, height: size, deviceScaleFactor: 1, mobile: false,
    })
    const buf = await rasterize(cdp, svgText, size)
    pngs.push({ size, buf })
    writeFileSync(join(OUT_DIR, `favicon-${size}.png`), buf)
    console.log(`  favicon-${size}.png  ${buf.length} 字节`)
  }

  // favicon.ico 用 16/32/48 三档
  const ico = buildIco(pngs)
  writeFileSync(join(OUT_DIR, 'favicon.ico'), ico)
  console.log(`  favicon.ico  ${ico.length} 字节（含 ${pngs.length} 档）`)

  // 校验：PNG 魔数与 ICO 头
  const check = (p, magic, label) => {
    const b = readFileSync(p)
    const ok = b.subarray(0, magic.length).equals(Buffer.from(magic))
    console.log(`  ${label} 魔数 ${ok ? '正确' : '错误'}`)
    return ok
  }
  const pngOk = check(join(OUT_DIR, 'favicon-32.png'), [0x89, 0x50, 0x4e, 0x47], 'PNG')
  const icoBuf = readFileSync(join(OUT_DIR, 'favicon.ico'))
  const icoOk = icoBuf.readUInt16LE(0) === 0 && icoBuf.readUInt16LE(2) === 1 && icoBuf.readUInt16LE(4) === 3
  console.log(`  ICO 头 reserved=0 type=1 count=3 ${icoOk ? '正确' : '错误'}`)
  if (!pngOk || !icoOk) {
    console.error('[失败] 生成的图标文件头不正确')
    process.exit(1)
  }
} finally {
  try { await cdp?.send('Browser.close') } catch { /* 忽略 */ }
  proc.kill()
}
