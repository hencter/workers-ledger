#!/usr/bin/env node
// 用无头浏览器真实测量渲染后的几何，而不是靠算术推断。
//
//   node site/checks/measure-layout.mjs                    测量默认的一组视口宽度
//   node site/checks/measure-layout.mjs 1512 1280 1920     指定宽度
//
// 为什么要这个脚本：本仓库的版面问题（右侧留白、导航标题折行）讨论过三轮，
// 前两轮我都是用「可用宽度 − 上限」估算的。估算错了会得出「已经修好」的结论，
// 而用户看到的截图里留白仍然很大——因为 .entry 上还有一层 max-width，
// 光看 .main 的规则发现不了。测量必须落到真实渲染盒子上。
//
// 实现走 Chrome DevTools 协议，无第三方依赖：起一个无头浏览器、读 WebSocket 地址、
// 用 Node 内置 WebSocket 发命令。如果本机没有 Chrome/Edge，脚本报错退出，不静默跳过。

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const SITE = resolve(HERE, '..')
const PUBLIC = join(SITE, 'public')

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

const exe = BROWSERS.find((p) => existsSync(p))
if (!exe) {
  console.error('[环境错误] 找不到 Chrome 或 Edge，无法做真实几何测量。')
  console.error('  本脚本刻意不静默跳过：没有测量就不要声称版面问题已解决。')
  process.exit(2)
}
if (!existsSync(PUBLIC)) {
  console.error(`[环境错误] 找不到产物：${PUBLIC}\n先跑 node tools/build-prod.mjs`)
  process.exit(2)
}

const widths = process.argv.slice(2).map(Number).filter((n) => n > 0)
const WIDTHS = widths.length ? widths : [1512, 1280, 1920]

/** 起一个只读静态服务。
 * 必须走 http 而不是 file://：站点是按子路径部署的（baseURL 形如
 * https://user.github.io/workers-ledger/），产出的资源地址是 /workers-ledger/css/…
 * 这种根绝对路径。用 file:// 打开时浏览器会去文件系统根目录找，找不到样式表，
 * 于是量到的「布局」其实是没有任何 CSS 的裸 HTML —— 我第一版就踩了这个坑，
 * 量出主区宽 1496px、边距 8px，看着像样式写错了，实际是样式根本没加载。
 * 这里把所有路径都映射到 public/ 下，兼容带前缀与不带前缀两种情况。 */
function serve(root) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  }
  const server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0])
    // 去掉可能存在的子路径前缀：把第一段当 baseURL 段丢弃
    const parts = p.split('/').filter(Boolean)
    if (parts.length && !existsSync(join(root, parts[0]))) parts.shift()
    let file = join(root, parts.join('/'))
    try {
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
      if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
      res.end(readFileSync(file))
    } catch (e) {
      res.writeHead(500); res.end(String(e))
    }
  })
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server)))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等 DevTools 端口就绪，返回**页面级** target 的 WebSocket 调试地址。
 * 注意不能连 /json/version 给的那个地址：那是浏览器级端点，不认 Runtime/Page 命令
 * （实测报 `'Runtime.enable' wasn't found`）。测量要连一个具体页面。 */
async function pageWsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (r.ok) {
        const list = await r.json()
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) return page.webSocketDebuggerUrl
      }
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('无头浏览器未在预期时间内就绪')
}

/** 极简 CDP 客户端：只用到发命令、收结果 */
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : res(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

const port = 9222 + (process.pid % 500)
const profile = mkdtempSync(join(tmpdir(), 'wrc-measure-'))
const proc = spawn(exe, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' })

let cdp
let server
try {
  server = await serve(PUBLIC)
  const origin = `http://127.0.0.1:${server.address().port}`
  const ws = new WebSocket(await pageWsUrl(port))
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true })
  })
  cdp = new CDP(ws)

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  for (const w of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: 1000, deviceScaleFactor: 1, mobile: false,
    })
    const targets = [
      { name: '首页', url: `${origin}/`, sel: { 主区: 'main.main', 检索面板: '[data-search-app]', 结果列表: '.results__list' } },
      { name: '节页', url: `${origin}/02-在职工资与工时/`, sel: { 主区: 'main.main', 侧栏: '.sidebar', 卡片列表: '.card-list, .results__list' } },
      { name: '条目页', url: `${origin}/02-在职工资与工时/01-加班费三档平日一点五倍休息日两倍法定节假日三倍/`, sel: { 主区: 'main.main', 条目容器: '.entry', 字段表: 'dl.fields', 说人话块: '.lead-block' } },
    ]
    for (const t of targets) {
      await cdp.send('Page.navigate', { url: t.url })
      await sleep(500)
      const expr = `(() => {
        const out = { viewport: window.innerWidth, body: document.body.clientWidth };
        for (const [label, sel] of Object.entries(${JSON.stringify(t.sel)})) {
          const el = document.querySelector(sel);
          if (!el) { out[label] = null; continue }
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          out[label] = {
            left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
            maxWidth: cs.maxWidth, paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight,
          };
        }
        const main = document.querySelector('main.main');
        if (main) {
          const mr = main.getBoundingClientRect();
          out['主区右侧到视口'] = Math.round(window.innerWidth - mr.right);
          out['主区内容右缘'] = Math.round(mr.right);
        }
        return JSON.stringify(out);
      })()`
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
      const m = JSON.parse(result.value)
      console.log(`\n视口 ${w}px · ${t.name}`)
      console.log(`  视口内宽 ${m.viewport} · body ${m.body}`)
      for (const [k, v] of Object.entries(m)) {
        if (k === 'viewport' || k === 'body') continue
        if (v && typeof v === 'object') {
          console.log(`  ${k}: left ${v.left} / right ${v.right} / width ${v.width} / max-width ${v.maxWidth}`)
        } else {
          console.log(`  ${k}: ${v}`)
        }
      }
    }
  }
} finally {
  try { await cdp?.send('Browser.close') } catch { /* 忽略 */ }
  proc.kill()
  server?.close()
}
