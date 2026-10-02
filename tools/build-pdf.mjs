#!/usr/bin/env node
// 把站点正文导出成 PDF 电子书。
//
// 为什么用浏览器打印：本机没有 pandoc / typst / LaTeX / wkhtmltopdf / LibreOffice，
// Hugo 与 mdbook 都不出 PDF。站点已经把 book/ 渲染成带样式的页面（中文字体、
// 证据徽章、行宽都调过），直接让无头 Chrome/Edge 打印，既保住排版又零新依赖。
//
// 做法：把「封面 + 首页 + 目录 + 每节 + 全部条目」合成一个打印源 HTML，
// 起一个只读静态服务托管站点产物，用 DevTools 协议让浏览器加载它再 Page.printToPDF。
// 骨架复用 site/checks/measure-layout.mjs，并且踩的是同一个坑：
//   · 必须连 /json/list 里的**页面** target，不能连 /json/version（浏览器级端点不认 Runtime.enable）
//   · 必须走 http 不能走 file://（站点资源是根绝对路径，file:// 下加载不到样式表，
//     打印出来就是裸 HTML）
//
// 两点与骨架不同，都是踩过坑之后改的：
//   1. 样式表**内联**进打印源。site/public 可能被别的构建并发改写（实测发生两次：
//      开发版与生产版互相覆盖），内联后打印源自洽，不必赌打印期间磁盘不变。
//      内联前会按产物的 integrity 属性做 SRI 校验，样式没对上就直接失败。
//   2. 打印源声明 <base href="公开发布地址">。站点是按子路径部署的，PDF 里的链接
//      如果只解析到本地服务，点开就是死链；声明发布地址后，链接指向线上路径。
//
// 兼容开发版（属性带引号）与生产压缩版（属性不带引号、样式表带指纹与 SRI）两种产物。
// 用法见 --help；核实方法与已知限制见 docs/核实记录/前端-PDF导出.md。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const BOOK_TITLE = '劳动者的账本'
const BOOK_AUTHOR = '亦幸和幸知'

/** 发布地址读仓库根的 site.config.json 的 publishUrl（PDF 里链接的基准）。
 * 换域名只改那一个文件，或用 --link-base 覆盖。 */
const BOOK_PUBLIC_BASE = (() => {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'))
    if (cfg.publishUrl) return cfg.publishUrl
  } catch { /* 读不到时退回默认，下面这行是兜底 */ }
  return 'https://hencter.github.io/workers-ledger/'
})()

// 无头浏览器候选：Windows 常见安装位置 + Linux/macOS。可用 --browser 或环境变量覆盖。
const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

const HELP = `把站点正文导出为 PDF 电子书（零第三方依赖，只用 Node 内置模块）

用法：
  node tools/build-pdf.mjs [选项]

选项：
  --out <路径>         输出文件路径。默认 dist/劳动者的账本.pdf
  --only <节号>        只导出某一节（如 2 / 02 / 第2节），
                       默认输出 dist/劳动者的账本-第NN节-<节名>.pdf
  --site <目录>        站点产物目录（默认 site/public）
  --base <网址>        改用该已部署站点作为内容来源（如
                       site.config.json 的 publishUrl）；不给则用本地产物目录
  --browser <路径|命令> 浏览器可执行文件；也可用环境变量 WRC_PDF_BROWSER 或 CHROME_PATH。
                       给命令名（如 google-chrome）时按 PATH 查找——CI 上这么用
  --no-sandbox         给浏览器加 --no-sandbox --disable-dev-shm-usage（容器/CI 上常需要）
                       也可用环境变量 WRC_PDF_NO_SANDBOX=1
  --link-base <网址>   打印源声明的发布地址，决定 PDF 里链接指向哪里。
                       默认 ${BOOK_PUBLIC_BASE}
                       传 none 则不声明（链接会指向本地服务，等于死链）
  --keep-html <路径>   把合成后的打印源 HTML 落盘，排查样式问题时用
  --no-page-numbers    不打印页脚页码（默认打印「第 N 页 / 共 M 页」）
  -h, --help           显示本帮助

产物：
  整本 = 封面 + 首页 + 目录 + 全部节与条目，按节顺序；
  单节 = 该节标题页 + 该节全部条目。

CI 用法（Ubuntu 上无头 Chrome 一般装在 PATH 里，且容器里要关沙箱）：
  node tools/build-pdf.mjs --browser google-chrome --no-sandbox
`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const opts = {
    out: null, only: null, site: join(ROOT, 'site', 'public'), base: null, browser: null,
    noSandbox: /^(1|true|yes)$/i.test(process.env.WRC_PDF_NO_SANDBOX || ''),
    linkBase: BOOK_PUBLIC_BASE, linkBaseExplicit: false,
    keepHtml: null, pageNumbers: true, help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--only') opts.only = argv[++i]
    else if (a === '--site') opts.site = resolve(argv[++i])
    else if (a === '--base') opts.base = argv[++i]
    else if (a === '--browser') opts.browser = argv[++i]
    else if (a === '--no-sandbox') opts.noSandbox = true
    else if (a === '--link-base') { opts.linkBase = argv[++i]; opts.linkBaseExplicit = true }
    else if (a === '--keep-html') opts.keepHtml = argv[++i]
    else if (a === '--no-page-numbers') opts.pageNumbers = false
    else throw new Error(`未知参数：${a}（用 --help 看用法）`)
  }
  return opts
}

/** 找浏览器：显式指定的优先；给命令名就交给 PATH；都没给才按候选路径找 */
function resolveBrowser(explicit) {
  const want = explicit || process.env.WRC_PDF_BROWSER || process.env.CHROME_PATH || null
  if (want) {
    if (want.includes('/') || want.includes('\\')) {
      if (!existsSync(want)) throw new Error(`指定的浏览器不存在：${want}`)
      return { exe: want, source: explicit ? '--browser' : '环境变量' }
    }
    return { exe: want, source: `${explicit ? '--browser' : '环境变量'}（按 PATH 查找）` }
  }
  const hit = BROWSER_CANDIDATES.find((p) => existsSync(p))
  if (!hit) {
    throw new Error('找不到 Chrome 或 Edge。用 --browser <路径|命令> 或环境变量 WRC_PDF_BROWSER 指定；'
      + 'CI 上一般写 --browser google-chrome --no-sandbox。本脚本刻意不静默跳过：没有浏览器就不要声称导出了 PDF。')
  }
  return { exe: hit, source: '自动探测' }
}

/* ---------------------------------------------------------------- 读取站点 */

/** 属性取值：兼容 class="x"、class='x'、class=x 三种写法（生产压缩版会去掉引号） */
function attrOf(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag)
  return m ? (m[1] ?? m[2] ?? m[3]) : null
}
const classList = (tag) => (attrOf(tag, 'class') || '').split(/\s+/).filter(Boolean)

/** 抠出某个 class 的整段标签（按同名标签深度配对，不怕嵌套） */
function sliceTag(html, tag, className) {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
  let m
  while ((m = openRe.exec(html))) {
    if (!classList(m[0]).includes(className)) continue
    const pairRe = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi')
    pairRe.lastIndex = openRe.lastIndex
    let depth = 1
    let m2
    while ((m2 = pairRe.exec(html))) {
      if (m2[0][1] === '/') { depth--; if (!depth) return html.slice(m.index, m2.index + m2[0].length) }
      else depth++
    }
    return null
  }
  return null
}

/** 打印源里只保留正文：脚本一律丢掉（livereload、检索脚本都不需要，也不该在打印时跑） */
const stripScripts = (html) => html.replace(/<script\b[\s\S]*?<\/script>/gi, '')

function pickStylesheet(headHtml) {
  for (const m of headHtml.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attrOf(m[0], 'rel') || '').toLowerCase().split(/\s+/)
    if (!rel.includes('stylesheet')) continue
    return { href: attrOf(m[0], 'href'), integrity: attrOf(m[0], 'integrity') }
  }
  return null
}

/** 站点按子路径部署时资源地址带前缀（/workers-ledger/css/…），前缀在产物目录里不存在就丢掉 */
function assetPath(dir, href) {
  const clean = decodeURIComponent(String(href).split('?')[0])
  const direct = join(dir, clean)
  if (existsSync(direct)) return direct
  const parts = clean.split('/').filter(Boolean)
  if (parts.length > 1) {
    const shifted = join(dir, parts.slice(1).join('/'))
    if (existsSync(shifted)) return shifted
  }
  return null
}

function localPageReader(dir) {
  return {
    kind: 'local',
    async text(relPath) {
      const file = assetPath(dir, relPath)
      if (!file) throw new Error(`产物里找不到：${relPath}（产物目录 ${dir}）\n先跑 node tools/build-prod.mjs 或 hugo`)
      return readFileSync(file, 'utf8')
    },
  }
}

function remotePageReader(base) {
  const root = base.endsWith('/') ? base : `${base}/`
  return {
    kind: 'remote',
    base: root,
    async text(relPath) {
      const url = new URL(String(relPath).replace(/^\//, ''), root).href
      const r = await fetch(url)
      if (!r.ok) throw new Error(`取不到 ${url}（HTTP ${r.status}）`)
      return r.text()
    },
  }
}

/** 给抠出来的整段标签补一个 id，供目录做 PDF 内部跳转锚点 */
const withId = (html, id) => html.replace(/^<([a-zA-Z]+)\b/, (m, tag) => `<${tag} id="${id}"`)

async function loadBook(opts, reader) {
  const entriesRaw = JSON.parse(await reader.text('/entries.json'))
  const all = entriesRaw.entries || []
  if (!all.length) throw new Error('entries.json 里没有条目，产物可能不完整')

  for (const e of all) { e.节号 = Number(e.节号) || 0; e.条号 = Number(e.条号) || 0 }
  all.sort((a, b) => a.节号 - b.节号 || a.条号 - b.条号) // 「按节顺序」

  let wanted = all
  if (opts.only != null) {
    const n = Number(String(opts.only).replace(/[^0-9]/g, ''))
    if (!Number.isInteger(n) || n < 1) throw new Error(`--only 的节号看不懂：${opts.only}`)
    wanted = all.filter((e) => e.节号 === n)
    if (!wanted.length) throw new Error(`产物里没有第 ${n} 节`)
  }

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
      headHtml = stripScripts(sliceTag(await reader.text(`${sectionPath}index.html`), 'header', 'page-head') || '')
    } catch { /* 取不到就用兜底标题 */ }
    if (!headHtml) {
      headHtml = `<header class="page-head"><p class="page-head__eyebrow">第 ${num} 节 · ${list.length} 条</p>`
        + `<h1>${String(num).padStart(2, '0')}. ${escapeHtml(list[0].节名 || '')}</h1>`
        + `<div class="rule" aria-hidden="true"></div></header>`
    }
    const entries = []
    for (const e of list) {
      const article = sliceTag(stripScripts(await reader.text(`${e.url}index.html`)), 'article', 'entry')
      if (!article) throw new Error(`条目页里找不到 <article class="entry">：${e.url}`)
      entries.push({ meta: e, html: withId(demoteHeadings(article), `entry-${e.节号}-${e.条号}`) })
    }
    sections.push({ num, name: list[0].节名 || '', headHtml: withId(headHtml, `sec-${num}`), entries })
  }
  return { sections, total: wanted.length }
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/** 把条目标题从 h1 降为 h2，子标题顺延（h2→h3、h3→h4）。
 *
 * 为什么必须降级：浏览器只按 h1–h6 的嵌套生成 PDF 书签，标题级别就是目录层级。
 * 站点里节与条目各是一页、各自都用 h1，拼成一个打印源后两者同级，
 * 实测第一版 346 个书签有 342 个在第 1 级——目录完全没有层级（用户反馈的就是这个）。
 * 降到 h2 后，节的 h1 成为父节点，条目挂到所属节下面。
 * 从 h3 → h4 倒序替换，避免先改 h2 又把刚生成的 h2 二次降级。 */
function demoteHeadings(html) {
  return html
    .replace(/<(\/?)h3(\s[^>]*)?>/g, '<$1h4$2>')
    .replace(/<(\/?)h2(\s[^>]*)?>/g, '<$1h3$2>')
    .replace(/<(\/?)h1(\s[^>]*)?>/g, '<$1h2$2>')
}

/* ------------------------------------------------------- 合成打印源 HTML */

const PRINT_CSS = `
/* 由 tools/build-pdf.mjs 注入：站点 print.css 的补丁 + 分页控制。
   站点的 print.css 已经隐藏 .topbar/.sidebar/.footer/.app/.pager/.rule/.crumbs，
   这里补它没覆盖的（跳转链接、分节过滤条），并负责分页。 */
@page { size: A4; margin: 16mm 15mm; }
html, body { background: #fff !important; }
.skip-link, .listbar, .nav-toggle { display: none !important; }
.shell { display: block !important; padding: 0 !important; }
.main { padding: 0 !important; max-width: none !important; }
.entry, .page-head { max-width: none !important; }

/* 分页：封面独立一页，目录与每节另起一页 */
.book-titlepage { break-after: page; text-align: center; padding-top: 45mm; }
.book-front, .book-part { break-before: page; }

/* 书签层级（PDF 目录树）。
   浏览器只按 h1–h6 的嵌套关系生成书签，所以标题级别就等于目录层级。
   站点里节与条目分属不同页面、各自都是 h1，拼成一个打印源后层级就平了——
   实测第一版 346 个书签里有 342 个都在第 1 级，目录完全没有层级。
   所以把条目标题降为 h2：节的 h1 成为父节点，每个条目挂到所属节下面。
   字号手动补回章节标题该有的大小（条目原本就是按 h1 排的）。 */
.entry > h2 {
  font-size: 15pt; font-weight: 700; line-height: 1.35;
  margin: 0 0 .5em;
}
.book-toc__entries .book-toc__sub { padding-left: 1.2em; }

/* 标题不留在页底；能整块放下的条目块不要被切断 */
h1, h2, h3, h4 { break-after: avoid-page; }
.entry > h2, .entry__eyebrow, .badges, .lead-block, .field, .note, .card,
.dist__col, .gauge, .page-head { break-inside: avoid; }
.entry__eyebrow, .badges { break-after: avoid-page; }

/* 条目头（标题 + 小标签 + 徽章）当一页放不下时不要被撕开：
   让它们作为整体挪到下一页，而不是标题留在上一页、徽章跑到下一页。
   这一条配合上面 .entry > h2 的 break-after，解决「条目开头被拆散」。 */
.entry__eyebrow, .badges { break-before: avoid-page; }
.entry__eyebrow { display: inline-block; }
.badges { display: flex; }

/* 表格与字段列表不跨页断开：一行拆到两页会看不懂 */
tr, dd, dt { break-inside: avoid; }
dl.fields { break-inside: auto; }

/* 孤行寡行：段末只剩一行被推到下一页（孤行），或段首只带一行过来（寡行），
   是中文长段落里最刺眼的排版问题。三行起算。 */
p, li { orphans: 3; widows: 3; }

/* 字段区里「栏目名 + 内容」成对，别让栏目名留在页底而内容翻页 */
dt + dd { break-before: avoid-page; }

/* 条目之间给一道分隔线，翻页时能看清从哪儿开始 */
.entry + .entry { border-top: 1px solid #ccc; margin-top: 1.5em; padding-top: 1.1em; }

/* 封面与目录（本脚本自带，站点没有这两页） */
.book-titlepage__eyebrow { color: #555; font-size: 12pt; margin: 0 0 1em; }
.book-titlepage__title { font-size: 34pt; margin: 0 0 .25em; letter-spacing: .04em; }
.book-titlepage__sub { font-size: 13pt; color: #333; margin: 0 0 3em; }
.book-titlepage__meta { font-size: 11pt; color: #555; margin: 0 0 6em; }
.book-titlepage__author { font-size: 14pt; margin: 0; }
.book-toc { font-size: 10.5pt; }
.book-toc h1 { font-size: 19pt; margin: 0 0 .3em; }
.book-toc__note { color: #555; font-size: 9.5pt; margin: 0 0 1.2em; }
.book-toc ol { list-style: none; margin: 0; padding: 0; }
.book-toc__sec { display: block; font-weight: 700; font-size: 11.5pt; margin: .9em 0 .25em; break-after: avoid-page; color: inherit; text-decoration: none; }
.book-toc__entries { padding-left: 1.5em !important; }
.book-toc__entries li { margin: .16em 0; break-inside: avoid; }
.book-toc__link { color: inherit; text-decoration: none; }
.book-toc__num { color: #555; margin-right: .45em; font-variant-numeric: tabular-nums; }
.book-toc__group { break-inside: avoid; }
`

function buildTitlePage(sections, total) {
  return `<section class="shell book-titlepage"><main class="main">
  <p class="book-titlepage__eyebrow">中国大陆 · 劳动权益与合规</p>
  <h1 class="book-titlepage__title">${BOOK_TITLE}</h1>
  <p class="book-titlepage__sub">法律允许什么，是一回事；拿不拿得到，是另一回事</p>
  <p class="book-titlepage__meta">循证指南 · ${sections.length} 节 ${total} 条</p>
  <p class="book-titlepage__author">${BOOK_AUTHOR}</p>
</main></section>`
}

function buildToc(sections) {
  const parts = sections.map((s) => `    <div class="book-toc__group">
      <a class="book-toc__sec" href="#sec-${s.num}">第 ${s.num} 节 · ${escapeHtml(s.name)}（${s.entries.length} 条）</a>
      <ol class="book-toc__entries">
        ${s.entries.map((e) => `<li><a class="book-toc__link" href="#entry-${e.meta.节号}-${e.meta.条号}"><span class="book-toc__num">${e.meta.节号}.${e.meta.条号}</span>${escapeHtml(e.meta.标题 || '')}</a></li>`).join('\n        ')}
      </ol>
    </div>`)
  return `<section class="shell book-front"><main class="main">
  <nav class="book-toc" aria-label="目录">
    <h1>目录</h1>
    <p class="book-toc__note">本目录条目可直接跳转（PDF 内部链接），但没有页码：浏览器打印无法把实际页码回填到正文里。</p>
    <p class="book-toc__note">${BOOK_TITLE} · ${BOOK_AUTHOR}</p>
${parts.join('\n')}
  </nav>
</main></section>`
}

function buildHtml({ homeBody, siteCss, sections, total, only, baseHref, title }) {
  const chunks = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="author" content="${BOOK_AUTHOR}">`,
    '<meta name="description" content="中国大陆劳动权益与合规的循证指南">',
    baseHref ? `<base href="${baseHref}">` : '',
    `<style>${siteCss}</style>`,
    `<style>${PRINT_CSS}</style>`,
    '</head>',
    '<body>',
  ].filter(Boolean)
  if (!only) {
    chunks.push(buildTitlePage(sections, total))
    if (homeBody) chunks.push(`<div class="book-cover">\n${homeBody}\n</div>`)
    chunks.push(buildToc(sections))
  }
  for (const s of sections) {
    chunks.push(`<section class="shell book-part"><main class="main">\n${s.headHtml}\n${s.entries.map((e) => e.html).join('\n')}\n</main></section>`)
  }
  chunks.push('</body>\n</html>\n')
  return chunks.join('\n')
}

/* ------------------------------------------------------------ 只读静态服务 */

function serve(root, virtualPath, virtualHtml) {
  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.webp': 'image/webp', '.woff2': 'font/woff2', '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  }
  const server = createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0])
    if (p.endsWith(virtualPath)) { // 打印源文档走内存，不落盘
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(virtualHtml)
      return
    }
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
 * 不能连 /json/version：那是浏览器级端点，不认 Runtime.enable（实测报 `'Runtime.enable' wasn't found`）。 */
async function pageWsUrl(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (r.ok) {
        const page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
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
  once(method, timeoutMs = 60000) {
    return new Promise((res, rej) => {
      const arr = this.listeners.get(method) || []
      const fn = (p) => {
        this.listeners.set(method, (this.listeners.get(method) || []).filter((f) => f !== fn))
        clearTimeout(t); res(p)
      }
      arr.push(fn)
      this.listeners.set(method, arr)
      const t = setTimeout(() => rej(new Error(`等 ${method} 超时`)), timeoutMs)
    })
  }
}

/* ------------------------------------------------------------ PDF 元数据补写 */

/** PDF 字符串字面量的 UTF-16BE 十六进制写法（Chrome 的 /Title 就是这么写的） */
function utf16beHex(str) {
  let hex = 'FEFF'
  for (const ch of str) {
    const cp = ch.codePointAt(0)
    if (cp > 0xffff) {
      const v = cp - 0x10000
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0').toUpperCase()
      hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0').toUpperCase()
    } else {
      hex += cp.toString(16).padStart(4, '0').toUpperCase()
    }
  }
  return `<${hex}>`
}

/** 补 /Author：Page.printToPDF 没有元数据参数，Chrome 只写 /Title（取自 <title>）。
 * 用 PDF 标准的增量更新追加一个新 Info 对象与一张 xref 表，/Prev 指回原来的 startxref——
 * 原字节一个都不动，读不了增量部分的阅读器仍能完整读到原文档。 */
function patchInfoAuthor(buf, author) {
  const s = buf.toString('latin1')
  const trailerMatches = [...s.matchAll(/trailer\s*<<([\s\S]*?)>>/g)]
  if (!trailerMatches.length) throw new Error('找不到 trailer')
  const t = trailerMatches[trailerMatches.length - 1][1]
  const infoId = /\/Info\s+(\d+)\s+\d+\s+R/.exec(t)?.[1]
  const rootId = /\/Root\s+(\d+)\s+\d+\s+R/.exec(t)?.[1]
  const size = Number(/\/Size\s+(\d+)/.exec(t)?.[1])
  const startxref = Number(/startxref\s+(\d+)/g.exec(s.slice(-2000))?.[1])
  if (!infoId || !rootId || !size) throw new Error('trailer 里缺 /Info、/Root 或 /Size')
  const info = new RegExp(`\\n${infoId}\\s+0\\s+obj([\\s\\S]*?)endobj`).exec(s)
  if (!info) throw new Error(`找不到 Info 对象 ${infoId}`)
  let dict = info[1].trim()
  if (/\/Author\b/.test(dict)) return buf // 已经有了就不动
  const close = dict.lastIndexOf('>>')
  if (close < 0) throw new Error('Info 不是字典')
  dict = `${dict.slice(0, close)}/Author ${utf16beHex(author)}\n${dict.slice(close)}`

  const newId = size
  const head = buf.length
  const obj = `${newId} 0 obj\n${dict}\nendobj\n`
  const xrefStart = head + Buffer.byteLength(obj, 'latin1')
  const xref = `xref\n${newId} 1\n${String(head).padStart(10, '0')} 00000 n \n`
  const tail = `trailer\n<</Size ${newId + 1}\n/Root ${rootId} 0 R\n/Info ${newId} 0 R\n/Prev ${startxref}>>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.concat([buf, Buffer.from(obj + xref + tail, 'latin1')])
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const t0 = Date.now()
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { process.stdout.write(HELP); return 0 }

  const browser = resolveBrowser(opts.browser)
  // 来源：默认本地产物目录；给了 --base 就改从已部署站点取
  const reader = opts.base ? remotePageReader(opts.base) : localPageReader(opts.site)
  const remoteBase = reader.kind === 'remote' ? reader.base : null
  // 链接基址：显式给了就听 --link-base；否则 --base 时用它，本地时用书的发布地址
  const linkBaseRaw = opts.linkBaseExplicit ? opts.linkBase : (remoteBase || BOOK_PUBLIC_BASE)
  if (reader.kind === 'local' && !existsSync(opts.site)) {
    throw new Error(`找不到站点产物目录：${opts.site}\n先构建站点，或把 --site 指到已有产物上`)
  }

  console.log(`[1/6] 读取站点内容（${reader.kind === 'local' ? `本地 ${opts.site}` : `远程 ${reader.base}`}）`)
  const book = await loadBook(opts, reader)
  console.log(`      ${book.sections.length} 节 · ${book.total} 条`)

  // 首页：整份 body 原样带进去（顶栏、侧栏、检索面板都在 DOM 里）。
  // 它们在打印媒体下由 print.css 隐藏——PDF 里看不到它们，才是打印样式生效的证据，
  // 所以这里刻意**不**自己删掉它们。
  const homeHtml = await reader.text('/index.html')
  const homeBody = opts.only ? null : (/<body[^>]*>([\s\S]*)<\/body>/i.exec(homeHtml)?.[1] ?? null)
  if (!opts.only && !homeBody) throw new Error('首页里找不到 <body>')

  // 样式表内联（见文件头注释）：先按 integrity 校验，再整段塞进打印源
  const sheet = pickStylesheet(homeHtml)
  if (!sheet?.href) throw new Error('首页里找不到样式表链接，无法保证样式生效')
  let siteCss = null
  let cssNote = ''
  if (reader.kind === 'local') {
    const cssFile = assetPath(opts.site, sheet.href)
    if (!cssFile) throw new Error(`产物里找不到样式表：${sheet.href}（样式加载不到，打印出来会是裸 HTML）`)
    const bytes = readFileSync(cssFile)
    if (sheet.integrity?.startsWith('sha256-')) {
      const hash = createHash('sha256').update(bytes).digest('base64')
      if (`sha256-${hash}` !== sheet.integrity) throw new Error(`样式表内容与 integrity 不符：${sheet.href}`)
      cssNote = 'SRI 校验通过'
    }
    siteCss = bytes.toString('utf8')
    console.log(`      样式表 ${sheet.href}（已内联${cssNote ? `，${cssNote}` : ''}，${bytes.length} 字节）`)
  } else {
    const r = await fetch(new URL(sheet.href.replace(/^\//, ''), reader.base).href)
    if (!r.ok) throw new Error(`取不到样式表：${sheet.href}（HTTP ${r.status}）`)
    siteCss = await r.text()
    console.log(`      样式表 ${sheet.href}（已内联，${Buffer.byteLength(siteCss)} 字节）`)
  }

  const linkBase = linkBaseRaw && linkBaseRaw !== 'none' ? (linkBaseRaw.endsWith('/') ? linkBaseRaw : `${linkBaseRaw}/`) : null
  console.log(`      链接基址 ${linkBase || '（未声明，PDF 内链接会指向本地服务）'}`)

  const title = opts.only
    ? `${BOOK_TITLE} · 第 ${String(book.sections[0].num).padStart(2, '0')} 节 ${book.sections[0].name}`
    : BOOK_TITLE
  const html = buildHtml({
    homeBody, siteCss, sections: book.sections, total: book.total,
    only: !!opts.only, baseHref: linkBase, title,
  })
  if (opts.keepHtml) {
    mkdirSync(dirname(resolve(opts.keepHtml)), { recursive: true })
    writeFileSync(resolve(opts.keepHtml), html, 'utf8')
    console.log(`      打印源 HTML 已落盘：${resolve(opts.keepHtml)}`)
  }

  const VIRTUAL = '__print-book__.html'
  const server = await serve(opts.site, `/${VIRTUAL}`, html)
  const origin = `http://127.0.0.1:${server.address().port}`
  const port = 9222 + (process.pid % 500)
  const profile = mkdtempSync(join(tmpdir(), 'wrc-pdf-'))
  const flags = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
  ]
  if (opts.noSandbox) flags.push('--no-sandbox', '--disable-dev-shm-usage')
  const proc = spawn(browser.exe, [...flags, 'about:blank'], { stdio: 'ignore' })

  let cdp
  try {
    console.log(`[2/6] 起无头浏览器并加载打印源（${browser.exe}，来源：${browser.source}）`)
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
    const loaded = cdp.once('Page.loadEventFired').catch(() => null) // 先挂监听再导航，免得错过事件
    await cdp.send('Page.navigate', { url: `${origin}/${VIRTUAL}` })
    await loaded
    await sleep(600)

    console.log('[3/6] 打印前自检：样式是否真的生效')
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
    const info = JSON.parse((await cdp.send('Runtime.evaluate', { expression: guardExpr, returnByValue: true })).result.value)
    console.log(`      样式表 ${info.sheets} 张 · 打印规则 ${info.printRules} 条 · 条目 ${info.entries} 个 · 目录 ${info.toc} 条 · 分节 ${info.parts} 个`)
    console.log(`      body 背景 ${info.bodyBg} · 字体 ${info.fontFamily.slice(0, 58)}…`)
    for (const [k, v] of Object.entries(info.hidden)) console.log(`      ${k} 打印时 display = ${v}`)
    if (info.entries !== book.total) info.problems.push(`条目数不符：DOM ${info.entries} ≠ 预期 ${book.total}`)
    if (opts.only && info.parts !== 1) info.problems.push(`单节导出应该只有 1 个分节，实际 ${info.parts}`)
    if (info.problems.length) {
      console.error('[自检失败] 打印源没有达到可打印状态：')
      for (const p of info.problems) console.error(`  · ${p}`)
      return 3
    }

    console.log('[4/6] Page.printToPDF')
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
    let buf = Buffer.from(pdf.data, 'base64')
    if (buf.length < 100 * 1024) throw new Error(`PDF 只有 ${buf.length} 字节，像是空壳，判为失败`)

    console.log('[5/6] 补写 PDF 元数据（作者）')
    const before = buf.length
    try {
      buf = patchInfoAuthor(buf, BOOK_AUTHOR)
      console.log(`      /Author 已补写为「${BOOK_AUTHOR}」（增量更新，+${buf.length - before} 字节）`)
    } catch (e) {
      console.log(`      警告：/Author 补写失败，保留浏览器原样输出（${e.message}）`)
    }

    const outPath = resolve(opts.out || defaultOut(opts, book))
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, buf)

    const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
    console.log('[6/6] 完成')
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
  if (!opts.only) return join(ROOT, 'dist', `${BOOK_TITLE}.pdf`)
  const s = book.sections[0]
  const name = `${BOOK_TITLE}-第${String(s.num).padStart(2, '0')}节-${s.name}`.replace(/[\\/:*?"<>|]/g, '_')
  return join(ROOT, 'dist', `${name}.pdf`)
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`[失败] ${e.message}`)
  process.exit(1)
})
