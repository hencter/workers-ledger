#!/usr/bin/env node
// 用浏览器把一个汉字的**字形轮廓**提取成 SVG 路径。
//
//   node site/checks/extract-glyph.mjs 劳
//
// 为什么需要它：favicon 里直接写 <text>劳</text> 依赖系统字体，在没有中文字体的
// 环境会回退甚至渲染成方块——favicon 恰恰最不该依赖字体。而手工画一个「劳」
// 试过一次，出来的是抽象方框，辨识度不够。
//
// 办法：让浏览器（本机装了中文字体）用 Canvas 把这个字渲染成轮廓，
// 取 Path2D 的路径数据，按 unitsPerEm 归一化后写成 SVG 的 <path>。
// 这样既是真字形，又完全不依赖字体。

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const char = process.argv[2] || '劳'
const fontStack = process.argv[3] || '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif'

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const exe = BROWSERS.find((p) => existsSync(p))
if (!exe) {
  console.error('[环境错误] 找不到 Chrome 或 Edge')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageWsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (r.ok) {
        const t = (await r.json()).find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
        if (t) return t.webSocketDebuggerUrl
      }
    } catch { /* 未就绪 */ }
    await sleep(250)
  }
  throw new Error('无头浏览器未就绪')
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

const port = 9700 + (process.pid % 200)
const profile = mkdtempSync(join(tmpdir(), 'wrc-glyph-'))
const proc = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
proc.stderr?.on('data', () => {})

let cdp
try {
  const ws = new WebSocket(await pageWsUrl(port))
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true })
  })
  cdp = new CDP(ws)
  await cdp.send('Runtime.enable')

  const expr = `(() => {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const size = 200;
    const font = '700 ' + size + 'px ' + ${JSON.stringify(fontStack)};
    ctx.font = font;
    const m = ctx.measureText(${JSON.stringify(char)});
    const upm = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    // getPathData 只有 Chromium 支持；取不到就让上层报错，不静默退化
    if (typeof m.getPathData !== 'function') {
      return JSON.stringify({ error: 'metric.getPathData 不可用' });
    }
    const pd = m.getPathData();
    return JSON.stringify({
      upm,
      ascent: m.fontBoundingBoxAscent,
      descent: m.fontBoundingBoxDescent,
      width: m.width,
      actualLeft: m.actualBoundingBoxLeft,
      actualRight: m.actualBoundingBoxRight,
      left: m.actualBoundingBoxLeft,
      commands: pd.map((x) => ({ t: x.type, v: Array.from(x.values || []) })),
    });
  })()`

  const { result } = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
  const data = JSON.parse(result.value)
  if (data.error) {
    console.error(`[失败] ${data.error}`)
    process.exit(1)
  }

  // 把 200px 字号下的路径归一化到 1em 见方的坐标：除以 upm，再按实际外接框平移
  const upm = data.upm
  const seg = (v, fn) => v.map((n) => Number(fn(n).toFixed(3)))
  const parts = []
  for (const c of data.commands) {
    const v = c.v
    if (c.t === 'M') parts.push(`M${seg([v[0], v[1]], (n) => n / upm).join(' ')}`)
    else if (c.t === 'L') parts.push(`L${seg([v[0], v[1]], (n) => n / upm).join(' ')}`)
    else if (c.t === 'Q') parts.push(`Q${seg(v.slice(0, 4), (n) => n / upm).join(' ')}`)
    else if (c.t === 'C') parts.push(`C${seg(v.slice(0, 6), (n) => n / upm).join(' ')}`)
    else if (c.t === 'Z') parts.push('Z')
    else parts.push(`${c.t}${seg(v, (n) => n / upm).join(' ')}`)
  }
  const d = parts.join('')
  console.log(`字形「${char}」`)
  console.log(`  unitsPerEm 估算 ${upm}`)
  console.log(`  路径段数 ${data.commands.length}`)
  console.log(`  路径长度 ${d.length} 字符`)
  console.log('')
  console.log(d)
} finally {
  try { await cdp?.send('Browser.close') } catch { /* 忽略 */ }
  proc.kill()
}
