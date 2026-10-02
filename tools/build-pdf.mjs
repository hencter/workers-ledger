#!/usr/bin/env node
// 把站点正文导出成 PDF 电子书。
//
// 为什么用浏览器打印：本机没有 pandoc / typst / LaTeX / wkhtmltopdf / LibreOffice，
// Hugo 与 mdbook 都不出 PDF。站点已经把 book/ 渲染成带样式的页面（中文字体、
// 证据徽章、行宽都调过），直接让无头 Chrome/Edge 打印，既保住排版又零新依赖。
//
// 做法：把「首页 + 目录 + 14 节 + 全部条目」合成一个打印源 HTML，
// 起一个只读静态服务托管 site/public/，用 DevTools 协议让浏览器加载它再 Page.printToPDF。
// 骨架复用 site/checks/measure-layout.mjs，并且踩的是同一个坑：
//   · 必须连 /json/list 里的**页面** target，不能连 /json/version（浏览器级端点不认 Runtime.enable）
//   · 必须走 http 不能走 file://（站点资源是 /work-rights-cn/css/… 这类根绝对路径，file:// 下加载不到样式表）
//
// 用法见 --help；核实方法与已知限制见 docs/核实记录/前端-PDF导出.md。

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PUBLIC = join(ROOT, 'site', 'public')
const DIST = join(ROOT, 'dist')

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

const HELP = `把站点正文导出为 PDF 电子书（零第三方依赖，只用 Node 内置模块）

用法：
  node tools/build-pdf.mjs [选项]

选项：
  --out <路径>        输出文件路径。默认 dist/劳动权益与合规指南.pdf
  --only <节号>       只导出某一节（如 2 / 02 / 第2节），
                      默认输出 dist/劳动权益与合规指南-第02节-<节名>.pdf
  --base <网址>       内容与样式改用该已部署站点（如 https://user.github.io/work-rights-cn/）；
                      不给则用本地 site/public/ + 内置只读服务
  --keep-html <路径>  把合成后的打印源 HTML 落盘，排查样式问题时用
  --no-page-numbers   不打印页脚页码（默认打印「第 N 页 / 共 M 页」）
  -h, --help          显示本帮助

产物：
  整本 = 首页 + 目录 + 14 节 + 全部 300 条条目，按节顺序；
  单节 = 该节标题页 + 该节全部条目。
`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const opts = { out: null, only: null, base: null, keepHtml: null, pageNumbers: true, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--only') opts.only = argv[++i]
    else if (a === '--base') opts.base = argv[++i]
    else if (a === '--keep-html') opts.keepHtml = argv[++i]
    else if (a === '--no-page-numbers') opts.pageNumbers = false
    else throw new Error(`未知参数：${a}（用 --help 看用法）`)
  }
  return opts
}

/* ---------------------------------------------------------------- 读取站点 */

/** 本地来源：目录名 → 能直接读盘 */
function localPageReader() {
  return {
    kind: 'local',
    async text(relPath) {
      const file = join(PUBLIC, decodeURIComponent(relPath))
      if (!existsSync(file)) throw new Error(`产物里找不到：${file}\n先跑 node tools/build-site.mjs 与 node tools/build-prod.mjs`)
      return readFileSync(file, 'utf8')
    },
  }
}

/** 远程来源：按网址取，用于复用已部署的站点 */
function remotePageReader(base) {
  const root = base.endsWith('/') ? base : `${base}/`
  return {
    kind: 'remote',
    base: root,
    async text(relPath) {
      const url = new URL(relPath.replace(/^\//, ''), root).href
      const r = await fetch(url)
      if (!r.ok) throw new Error(`取不到 ${url}（HTTP ${r.status}）`)
      return r.text()
    },
  }
}

/** 从 HTML 里抠出一段平衡标签之间的内容（站点模板稳定，不必上解析器） */
function sliceTag(html, tag, className) {
  const open = new RegExp(`<${tag}\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i')
  const m = open.exec(html)
  if (!m) return null
  const start = m.index
  const closer = `</${tag}>`
  const end = html.indexOf(closer, start + m[0].length)
  if (end === -1) return null
  return html.slice(start, end + closer.length)
}

/** 打印源里只保留正文相关的资源：脚本一律丢掉（livereload、检索脚本都不需要，也不该在打印时跑） */
function stripScripts(html) {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, '')
}

function firstMatch(html, re) {
  const m = re.exec(html)
  return m ? m[1] : null
}

async function loadBook(opts, reader) {
  const entriesRaw = JSON.parse(await reader.text('/entries.json'))
  const all = entriesRaw.entries || []
  if (!all.length) throw new Error('entries.json 里没有条目，产物可能不完整')

  // 按节号、条号排序，保证「按节顺序」
  for (const e of all) {
    e.节号 = Number(e.节号) || 0
    e.条号 = Number(e.条号) || 0
  }
  all.sort((a, b) => a.节号 - b.节号 || a.条号 - b.条号)

  let wanted = all
  if (opts.only != null) {
    const n = Number(String(opts.only).replace(/[^0-9]/g, ''))
    if (!Number.isInteger(n) || n < 1) throw new Error(`--only 的节号看不懂：${opts.only}`)
    wanted = all.filter((e) => e.节号 === n)
    if (!wanted.length) throw new Error(`产物里没有第 ${n} 节`)
  }

  // 节 → 条目
  const bySection = new Map()
  for (const e of wanted) {
    if (!bySection.has(e.节号)) bySection.set(e.节号, [])
    bySection.get(e.节号).push(e)
  }

  const sections = []
  for (const [num, list] of [...bySection.entries()].sort((a, b) => a[0] - b[0])) {
    const sectionPath = `/${list[0].url.split('/').filter(Boolean)[0]}/`
    let headHtml = null
    try {
      const secHtml = await reader.text(`${sectionPath}index.html`)
      headHtml = sliceTag(secHtml, 'header', 'page-head')
      headHtml = headHtml ? stripScripts(headHtml) : null
    } catch { /* 取不到就用兜底标题 */ }
    if (!headHtml) {
      headHtml = `<header class="page-head"><p class="page-head__eyebrow">第 ${num} 节 · ${list.length} 条</p>`
        + `<h1>${String(num).padStart(2, '0')}. ${escapeHtml(list[0].节名 || '')}</h1>`
        + `<div class="rule" aria-hidden="true"></div></header>`
    }
    const entries = []
    for (const e of list) {
      const html = stripScripts(await reader.text(`${e.url}index.html`))
      const article = sliceTag(html, 'article', 'entry')
      if (!article) throw new Error(`条目页里找不到 <article class="entry">：${e.url}`)
      entries.push({ meta: e, html: article })
    }
    sections.push({ num, name: list[0].节名 || '', headHtml, entries })
  }
  return { sections, total: wanted.length, entriesRaw }
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/* ------------------------------------------------------- 合成打印源 HTML */

const PRINT_CSS = `
/* 由 tools/build-pdf.mjs 注入：站点 print.css 的补丁 + 分页控制。
   站点的 print.css 已经隐藏 .topbar/.sidebar/.footer/.app/.pager/.rule/.crumbs，
   这里补它没覆盖的（跳转链接、分节过滤条），并负责分页。 */
@page { size: A4; margin: 16mm 15mm; }
html, body { background: #fff !important; }
.skip-link, .listbar, .nav-toggle, .mobile-only { display: none !important; }
.shell { display: block !important; padding: 0 !important; }
.main { padding: 0 !important; max-width: none !important; }
.entry, .page-head { max-width: none !important; }

/* 分页：目录与每节另起一页 */
.book-front, .book-part { break-before: page; }

/* 标题不留在页底；能整块放下的条目块不要被切断 */
h1, h2, h3, h4 { break-after: avoid-page; }
.entry > h1, .entry__eyebrow, .badges, .lead-block, .field, .note, .card,
.dist__col, .gauge, .page-head { break-inside: avoid; }
.entry__eyebrow, .badges { break-after: avoid-page; }

/* 条目之间给一道分隔线，翻页时能看清从哪儿开始 */
.entry + .entry { border-top: 1px solid #ccc; margin-top: 1.5em; padding-top: 1.1em; }

/* 目录（本脚本自带，站点没有这一页） */
.book-toc { font-size: 10.5pt; }
.book-toc h1 { font-size: 19pt; margin: 0 0 .3em; }
.book-toc__note { color: #555; font-size: 9.5pt; margin: 0 0 1.2em; }
.book-toc ol { list-style: none; margin: 0; padding: 0; }
.book-toc__sec { display: block; font-weight: 700; font-size: 11.5pt; margin: .9em 0 .25em; break-after: avoid-page; }
.book-toc__entries { padding-left: 1.5em !important; }
.book-toc__entries li { margin: .16em 0; break-inside: avoid; }
.book-toc__num { color: #555; margin-right: .45em; font-variant-numeric: tabular-nums; }
.book-toc__group { break-inside: avoid; }
`

function buildToc(sections, only) {
  const parts = []
  for (const s of sections) {
    const items = s.entries
      .map((e) => `<li><span class="book-toc__num">${e.meta.节号}.${e.meta.条号}</span>${escapeHtml(e.meta.标题 || '')}</li>`)
      .join('\n        ')
    parts.push(`    <div class="book-toc__group">
      <span class="book-toc__sec">第 ${s.num} 节 · ${escapeHtml(s.name)}（${s.entries.length} 条）</span>
      <ol class="book-toc__entries">
        ${items}
      </ol>
    </div>`)
  }
  const note = only
    ? '本目录只含本节的条目。'
    : '本目录不含页码：浏览器打印无法把实际页码回填到正文里，这是本方法的已知限制。'
  return `<section class="shell book-front"><main class="main">
  <nav class="book-toc" aria-label="目录">
    <h1>目录</h1>
    <p class="book-toc__note">${note}</p>
${parts.join('\n')}
  </nav>
</main></section>`
}

function buildHtml({ homeBody, stylesheetHref, sections, only, baseHref }) {
  const head = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>劳动权益与合规指南</title>',
    '<meta name="author" content="劳动权益与合规指南">',
    '<meta name="description" content="中国大陆劳动权益与合规的循证指南">',
    baseHref ? `<base href="${baseHref}">` : '',
    stylesheetHref ? `<link rel="stylesheet" href="${stylesheetHref}">` : '',
    `<style>${PRINT_CSS}</style>`,
    '</head>',
    '<body>',
  ].join('\n')

  const chunks = [head]
  if (homeBody) chunks.push(`<div class="book-cover">\n${homeBody}\n</div>`)
  if (!only) chunks.push(buildToc(sections, only)) // 单节导出不带全书目录
  for (const s of sections) {
    chunks.push(`<section class="shell book-part"><main class="main">
${s.headHtml}
${s.entries.map((e) => e.html).join('\n')}
</main></section>`)
  }
  chunks.push('</body>\n</html>\n')
  return chunks.join('\n')
}

/* ------------------------------------------------------------ 只读静态服务 */

function serve(root, virtualPath, virtualHtml) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
  }
  const server = createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0])
    // 打印源文档走内存，不落盘
    if (p.endsWith(virtualPath)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(virtualHtml)
      return
    }
    // 站点按子路径部署时资源地址带前缀（/work-rights-cn/css/…）。
    // 前缀在 public/ 下不存在就丢掉，带前缀与不带前缀两种情况都能落到同一份文件。
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

/* ------------------------------------------------------------ DevTools 协议 */

/** 等 DevTools 就绪，返回**页面级** target 的调试地址。
 * 不能连 /json/version：那是浏览器级端点，不认 Runtime.enable（实测报
 * `'Runtime.enable' wasn't found`）。 */
async function pageWsUrl(port) {
  for (let i = 0; i < 80; i++) {
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

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : res(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params)
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
  once(method, timeoutMs = 30000) {
    return new Promise((res, rej) => {
      const arr = this.listeners.get(method) || []
      const fn = (p) => { this.listeners.set(method, (this.listeners.get(method) || []).filter((f) => f !== fn)); clearTimeout(t); res(p) }
      arr.push(fn)
      this.listeners.set(method, arr)
      const t = setTimeout(() => rej(new Error(`等 ${method} 超时`)), timeoutMs)
    })
  }
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const t0 = Date.now()
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { process.stdout.write(HELP); return 0 }

  const exe = BROWSERS.find((p) => existsSync(p))
  if (!exe) {
    console.error('[环境错误] 找不到 Chrome 或 Edge，无法打印 PDF。')
    console.error('  本脚本刻意不静默跳过：没有浏览器就不要声称导出了 PDF。')
    return 2
  }

  const reader = opts.base ? remotePageReader(opts.base) : localPageReader()
  if (reader.kind === 'local' && !existsSync(PUBLIC)) {
    console.error(`[环境错误] 找不到站点产物：${PUBLIC}\n先跑 node tools/build-site.mjs 与 node tools/build-prod.mjs`)
    return 2
  }

  console.log(`[1/5] 读取站点内容（${reader.kind === 'local' ? '本地 site/public/' : `远程 ${reader.base}`}）`)
  const book = await loadBook(opts, reader)
  const entryCount = book.total
  console.log(`      ${book.sections.length} 节 · ${entryCount} 条`)

  // 首页：整份 body 原样带进去（顶栏、侧栏、检索面板都在 DOM 里）。
  // 它们在打印媒体下由 print.css 隐藏——PDF 里看不到它们，才是打印样式生效的证据，
  // 所以这里刻意**不**自己删掉它们。
  let homeBody = null
  if (!opts.only) {
    const home = await reader.text('/index.html')
    const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(home)
    if (!m) throw new Error('首页里找不到 <body>')
    homeBody = stripScripts(m[1])
  }
  const stylesheetHref = firstMatch(homeBody || '', /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/i)
    || firstMatch(await reader.text('/index.html'), /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/i)
  if (!stylesheetHref) throw new Error('首页里找不到样式表链接，无法保证样式生效')
  const baseHref = reader.kind === 'remote' ? reader.base : null

  const html = buildHtml({ homeBody, stylesheetHref, sections: book.sections, only: !!opts.only, baseHref })
  if (opts.keepHtml) {
    mkdirSync(dirname(resolve(opts.keepHtml)), { recursive: true })
    writeFileSync(resolve(opts.keepHtml), html, 'utf8')
    console.log(`      打印源 HTML 已落盘：${resolve(opts.keepHtml)}`)
  }

  const VIRTUAL = '__print-book__.html'
  const server = await serve(PUBLIC, `/${VIRTUAL}`, html)
  const origin = `http://127.0.0.1:${server.address().port}`

  const port = 9222 + (process.pid % 500)
  const profile = mkdtempSync(join(tmpdir(), 'wrc-pdf-'))
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
  try {
    console.log('[2/5] 起无头浏览器并加载打印源')
    const ws = new WebSocket(await pageWsUrl(port))
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true })
    })
    cdp = new CDP(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    // 强制浅色 + 打印媒体：站点是浅深双主题，电子书只出浅色
    await cdp.send('Emulation.setEmulatedMedia', {
      media: 'print',
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    })

    // 先挂监听再导航，避免加载极快时错过事件（错过就只能干等超时）
    const loaded = cdp.once('Page.loadEventFired', 60000).catch(() => null)
    await cdp.send('Page.navigate', { url: `${origin}/${VIRTUAL}` })
    await loaded
    await sleep(600)
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => 1) : 1',
      awaitPromise: true, returnByValue: true,
    })
    void result

    console.log('[3/5] 打印前自检：样式是否真的生效')
    const guardExpr = `(() => {
      const out = { problems: [], hidden: {} };
      const sheets = [...document.styleSheets];
      out.sheets = sheets.length;
      let printRules = 0;
      for (const s of sheets) {
        let rules; try { rules = s.cssRules } catch (e) { out.problems.push('样式表读不到规则：' + (s.href || 'inline')); continue }
        for (const r of rules) if (r.type === 4 && /print/.test(r.media.mediaText)) printRules += r.cssRules.length;
      }
      out.printRules = printRules;
      if (!printRules) out.problems.push('没有加载到任何打印样式规则（样式表可能没加载）');
      for (const sel of ['header.topbar', 'aside.sidebar', 'section.app', 'footer.footer']) {
        const el = document.querySelector(sel);
        out.hidden[sel] = el ? getComputedStyle(el).display : '（DOM 里没有）';
        if (el && getComputedStyle(el).display !== 'none') out.problems.push('打印媒体下没有被隐藏：' + sel);
      }
      out.entries = document.querySelectorAll('article.entry').length;
      out.parts = document.querySelectorAll('.book-part').length;
      out.toc = document.querySelectorAll('.book-toc__entries li').length;
      out.bodyBg = getComputedStyle(document.body).backgroundColor;
      out.fontFamily = getComputedStyle(document.body).fontFamily;
      return JSON.stringify(out);
    })()`
    const g = await cdp.send('Runtime.evaluate', { expression: guardExpr, returnByValue: true })
    const info = JSON.parse(g.result.value)
    console.log(`      样式表 ${info.sheets} 张 · 打印规则 ${info.printRules} 条 · 条目 ${info.entries} 个 · 目录 ${info.toc} 条 · 分节 ${info.parts} 个`)
    console.log(`      body 背景 ${info.bodyBg} · 字体 ${info.fontFamily.slice(0, 60)}…`)
    for (const [k, v] of Object.entries(info.hidden)) console.log(`      ${k} 打印时 display = ${v}`)
    if (info.entries !== entryCount) info.problems.push(`条目数不符：DOM ${info.entries} ≠ 预期 ${entryCount}`)
    if (opts.only && info.parts !== 1) info.problems.push(`单节导出应该只有 1 个分节，实际 ${info.parts}`)
    if (info.problems.length) {
      console.error('[自检失败] 打印源没有达到可打印状态：')
      for (const p of info.problems) console.error(`  · ${p}`)
      return 3
    }

    console.log('[4/5] Page.printToPDF')
    const footer = opts.pageNumbers
      ? '<div style="width:100%;font-size:9px;color:#555;text-align:center;'
        + 'font-family:\'Microsoft YaHei\',Arial,sans-serif">'
        + '第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>'
      : '<div></div>'
    const full = {
      printBackground: true,
      paperWidth: 8.27,   // A4 210mm
      paperHeight: 11.69, // A4 297mm
      marginTop: 0.63, marginBottom: 0.71, marginLeft: 0.59, marginRight: 0.59, // 16/18/15/15mm
      preferCSSPageSize: false,
      displayHeaderFooter: opts.pageNumbers,
      headerTemplate: '<div></div>',
      footerTemplate: footer,
      generateTaggedPDF: true,
      generateDocumentOutline: true,
      transferMode: 'ReturnAsBase64',
    }
    let pdf
    for (const drop of [[], ['generateDocumentOutline'], ['generateDocumentOutline', 'generateTaggedPDF']]) {
      const params = { ...full }
      for (const k of drop) delete params[k]
      try {
        pdf = await cdp.send('Page.printToPDF', params)
        if (drop.length) console.log(`      注：浏览器不支持 ${drop.join('、')}，已降级重试`)
        break
      } catch (e) {
        if (drop.length === 2) throw e
      }
    }
    const buf = Buffer.from(pdf.data, 'base64')
    if (buf.length < 100 * 1024) throw new Error(`PDF 只有 ${buf.length} 字节，像是空壳，判为失败`)

    const outPath = resolve(opts.out || defaultOut(opts, book))
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, buf)

    const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
    console.log('[5/5] 完成')
    console.log(`      输出：${outPath}`)
    console.log(`      大小：${(buf.length / 1024 / 1024).toFixed(2)} MB（${buf.length} 字节）· 页数：${pages} · 耗时：${((Date.now() - t0) / 1000).toFixed(1)} 秒`)
    return 0
  } finally {
    try { await cdp?.send('Browser.close') } catch { /* 忽略 */ }
    proc.kill()
    server.close()
  }
}

function defaultOut(opts, book) {
  if (!opts.only) return join(DIST, '劳动权益与合规指南.pdf')
  const s = book.sections[0]
  const name = `劳动权益与合规指南-第${String(s.num).padStart(2, '0')}节-${s.name}`.replace(/[\\/:*?"<>|]/g, '_')
  return join(DIST, `${name}.pdf`)
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`[失败] ${e.message}`)
  process.exit(1)
})
