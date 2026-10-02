#!/usr/bin/env node
// 独立核实 tools/build-pdf.mjs 产出的 PDF：本脚本不调用导出脚本的任何函数，
// 自己从 PDF 字节里解 Flate 内容流、用 ToUnicode CMap 还原文字，再逐项判定。
//
// 为什么必须自己解：本机没有 pdftotext / mutool / PDF 工具链，而「文件生成了」
// 不等于「内容对了」——空壳、丢样式、豆腐块都可能发生。PDF 里中文走的是
// Identity-H（CID）编码，只有顺着 CMap 还原成 Unicode 才能判断是不是真中文。
//
// 用法：
//   node tools/verify-pdf.mjs <pdf路径> [选项]
//     --site <目录>        站点产物目录（默认 site/public），用来取 entries.json 逐条核对
//     --print-html <路径>  合成后的打印源 HTML，用来证明「DOM 里有、PDF 里没有」
//     --expect-title <串>  期望的 PDF /Title（默认「劳动者的账本」）
//     --expect-author <串> 期望的 PDF /Author（默认「亦幸和幸知」）
//     --link-base <网址>   期望 PDF 内链接指向的发布地址（默认 https://hencter.github.io/workers-ledger/）
//     --browser <路径|命令> 截图用的浏览器（默认自动探测；也可用 WRC_PDF_BROWSER）
//     --no-sandbox         截图浏览器加 --no-sandbox --disable-dev-shm-usage（容器/CI）
//     --shots <目录>       把 PDF 若干页截图（用浏览器渲染真实 PDF 页面，肉眼查豆腐块）
//     --shot-pages 1,2,300 截图页号（默认 1,2,3）
//     --json               以 JSON 汇总结果
// 退出码：0 = 全部通过；1 = 有断言失败；2 = 环境或参数问题。

import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateSync, inflateRawSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log('用法：node tools/verify-pdf.mjs <pdf路径> [--site <目录>] [--print-html <路径>] [--link-base <网址>] [--shots <目录>] [--shot-pages 1,2,3] [--json]')
  process.exit(args.length ? 0 : 2)
}
const pdfPath = args[0]
const opt = {
  site: 'site/public', printHtml: null,
  expectTitle: '劳动者的账本', expectAuthor: '亦幸和幸知',
  linkBase: 'https://hencter.github.io/workers-ledger/',
  browser: process.env.WRC_PDF_BROWSER || process.env.CHROME_PATH || null,
  noSandbox: /^(1|true|yes)$/i.test(process.env.WRC_PDF_NO_SANDBOX || ''),
  shots: null, shotPages: [1, 2, 3], json: false,
}
for (let i = 1; i < args.length; i++) {
  const a = args[i]
  if (a === '--site') opt.site = args[++i]
  else if (a === '--print-html') opt.printHtml = args[++i]
  else if (a === '--expect-title') opt.expectTitle = args[++i]
  else if (a === '--expect-author') opt.expectAuthor = args[++i]
  else if (a === '--link-base') opt.linkBase = args[++i]
  else if (a === '--browser') opt.browser = args[++i]
  else if (a === '--no-sandbox') opt.noSandbox = true
  else if (a === '--shots') opt.shots = args[++i]
  else if (a === '--shot-pages') opt.shotPages = args[++i].split(',').map(Number).filter((n) => n > 0)
  else if (a === '--json') opt.json = true
}
if (!existsSync(pdfPath)) { console.error(`找不到 PDF：${pdfPath}`); process.exit(2) }

const checks = []
const add = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!opt.json) console.log(`${ok ? '  [通过]' : '  [不通过]'} ${name}${detail ? ` —— ${detail}` : ''}`) }

/* ------------------------------------------------------------ PDF 结构解析 */

const buf = readFileSync(pdfPath)
const S = buf.toString('latin1') // 1 字符 = 1 字节，便于按偏移切片
const noWs = (t) => t.replace(/\s+/g, '')

function eolSkip(text, i) {
  if (text[i] === '\r') i++
  if (text[i] === '\n') i++
  return i
}

/** 线性扫出全部对象：{ dict, stream(Buffer|null) }；同号对象后出现的覆盖先出现的（增量更新的新实例在后） */
const objects = new Map()
{
  const re = /\n(\d+)\s+0\s+obj\b/g
  let m
  while ((m = re.exec(S))) {
    const bodyStart = m.index + m[0].length
    const endObj = S.indexOf('endobj', bodyStart)
    if (endObj === -1) continue
    let streamKw = -1
    for (let i = S.indexOf('stream', bodyStart); i !== -1 && i < endObj; i = S.indexOf('stream', i + 1)) {
      const after = S[i + 6]
      if (after === '\n' || after === '\r') { streamKw = i; break }
    }
    const dict = streamKw === -1 ? S.slice(bodyStart, endObj) : S.slice(bodyStart, streamKw)
    let stream = null
    if (streamKw !== -1) {
      const dataStart = eolSkip(S, streamKw + 6)
      const lenM = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)
      let dataEnd
      if (lenM) dataEnd = dataStart + Number(lenM[1])
      else {
        dataEnd = S.indexOf('endstream', dataStart)
        while (dataEnd > dataStart && (S[dataEnd - 1] === '\n' || S[dataEnd - 1] === '\r')) dataEnd--
      }
      stream = buf.subarray(dataStart, dataEnd)
    }
    objects.set(m[1], { dict, stream })
    re.lastIndex = endObj
  }
}

function inflate(stream) {
  if (!stream) return null
  try { return inflateSync(stream).toString('latin1') } catch { /* 也许没有压缩 */ }
  try { return inflateRawSync(stream).toString('latin1') } catch { /* 吞掉 */ }
  return null
}
const streamText = (obj) => (obj && obj.stream ? (inflate(obj.stream) ?? obj.stream.toString('latin1')) : null)

const refOf = (dict, key) => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict)
  return m ? m[1] : null
}
const dictOf = (id) => (id != null && objects.has(String(id)) ? objects.get(String(id)).dict : null)

/* -------------------------------------------------------- PDF 字符串解码 */

/** 带 BOM 的按 UTF-16BE 解，否则按 PDF 单字节处理 */
function bytesToText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = ''
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
    return out
  }
  return Buffer.from(bytes).toString('latin1')
}

function decodePdfString(tok) {
  if (tok.startsWith('<')) {
    const hex = tok.slice(1, -1).replace(/\s+/g, '')
    const bytes = []
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
    return bytesToText(bytes)
  }
  const body = tok.slice(1, -1)
  const bytes = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\') {
      const n = body[++i]
      if (n === 'n') bytes.push(10)
      else if (n === 'r') bytes.push(13)
      else if (n === 't') bytes.push(9)
      else if (n === 'b') bytes.push(8)
      else if (n === 'f') bytes.push(12)
      else if (n === '\n') { /* 续行 */ }
      else if (n >= '0' && n <= '7') {
        let oct = n
        while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') oct += body[++i]
        bytes.push(parseInt(oct, 8))
      } else bytes.push(n.charCodeAt(0))
    } else bytes.push(ch.charCodeAt(0) & 0xff)
  }
  return bytesToText(bytes)
}

function infoValue(dict, key) {
  if (!dict) return null
  const m = new RegExp(`/${key}\\s*(\\([^)]*\\)|<[0-9A-Fa-f\\s]*>)`).exec(dict)
  return m ? decodePdfString(m[1]) : null
}

const infoRef = (() => {
  const trailers = [...S.matchAll(/trailer\s*<<([\s\S]*?)>>/g)]
  return trailers.length ? trailers[trailers.length - 1][1] : null
})()
const infoDict = infoRef ? dictOf(refOf(infoRef, 'Info')) : null
const rootId = infoRef ? refOf(infoRef, 'Root') : null
const catalog = dictOf(rootId)
const lang = catalog ? (/\/Lang\s*\(([^)]*)\)/.exec(catalog)?.[1] ?? null) : null
const title = infoValue(infoDict, 'Title')
const author = infoValue(infoDict, 'Author')
const producer = infoValue(infoDict, 'Producer')

/* ------------------------------------------------------------- 字体与 CMap */

const cmapCache = new Map()
function cmapFor(fontId) {
  if (cmapCache.has(fontId)) return cmapCache.get(fontId)
  const dict = fontId != null ? dictOf(fontId) : null
  let map = null
  let twoByte = false
  if (dict) {
    twoByte = /\/Subtype\s*\/Type0/.test(dict) || /\/Encoding\s*\/Identity-H/.test(dict)
    const tu = refOf(dict, 'ToUnicode')
    if (tu) {
      const cmapText = streamText(objects.get(String(tu)))
      if (cmapText) map = parseCMap(cmapText)
    }
  }
  if (map && !twoByte) twoByte = [...map.keys()].every((k) => k > 0xff) && map.size > 1
  const val = { map, twoByte }
  cmapCache.set(fontId, val)
  return val
}

function hexToUtf16(hex) {
  const bytes = []
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  let out = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
  return out
}

function parseCMap(text) {
  const map = new Map()
  for (const sec of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of sec[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(m[1], 16), hexToUtf16(m[2]))
  }
  for (const sec of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of sec[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g)) {
      const lo = parseInt(m[1], 16)
      const hi = parseInt(m[2], 16)
      if (m[4]) {
        const base = m[4].replace(/\s+/g, '')
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          const bumped = (BigInt('0x' + base) + BigInt(c - lo)).toString(16).padStart(base.length, '0')
          map.set(c, hexToUtf16(bumped))
        }
      } else {
        const items = [...m[5].matchAll(/<([0-9A-Fa-f]+)>/g)]
        items.forEach((it, i) => map.set(lo + i, hexToUtf16(it[1])))
      }
    }
  }
  return map
}

/* --------------------------------------------------------------- 页面与文本 */

function pageOrder() {
  const out = []
  const seen = new Set()
  const walk = (id, depth = 0) => {
    if (!id || seen.has(id) || depth > 40) return
    seen.add(id)
    const dict = dictOf(id)
    if (!dict) return
    if (/\/Type\s*\/Page[^s]/.test(dict)) { out.push(id); return }
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(dict)
    if (kids) for (const m of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(m[1], depth + 1)
  }
  walk(catalog ? refOf(catalog, 'Pages') : null)
  return out
}

const unmapped = { count: 0 }
function decodeShow(tok, cm) {
  let bytes = []
  if (tok.startsWith('<')) {
    const hex = tok.slice(1, -1).replace(/\s+/g, '')
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  } else {
    const body = tok.slice(1, -1)
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (ch === '\\') {
        const n = body[++i]
        if (n >= '0' && n <= '7') { let o = n; while (o.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') o += body[++i]; bytes.push(parseInt(o, 8)) }
        else if (n === 'n') bytes.push(10)
        else if (n === 'r') bytes.push(13)
        else if (n === 't') bytes.push(9)
        else bytes.push(n.charCodeAt(0) & 0xff)
      } else bytes.push(ch.charCodeAt(0) & 0xff)
    }
  }
  if (!cm || !cm.map) { unmapped.count += bytes.length; return '' }
  let out = ''
  if (cm.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const v = cm.map.get((bytes[i] << 8) | bytes[i + 1])
      if (v === undefined) { unmapped.count++; continue }
      out += v
    }
  } else {
    for (const b of bytes) {
      const v = cm.map.get(b)
      if (v === undefined) { unmapped.count++; continue }
      out += v
    }
  }
  return out
}

const TOKEN_RE = /\/([^\s/\[\]<>()]+)\s+-?[\d.]+\s+Tf|\[((?:[^\[\]\\]|\\.)*)\]\s*TJ|(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)\s*(Tj|'|")|\b(Td|TD|T\*|ET)\b/g

/** 从 '<' 开始做平衡扫描取一个 <<…>> 字典（资源字典里嵌套 >> 很多，非贪婪正则会被截断） */
function balancedDictAt(text, idx) {
  let depth = 0
  for (let i = idx; i < text.length - 1; i++) {
    if (text[i] === '<' && text[i + 1] === '<') { depth++; i++ }
    else if (text[i] === '>' && text[i + 1] === '>') { depth--; i++; if (!depth) return text.slice(idx, i + 1) }
  }
  return null
}

/** 取页面的 /Font 资源字典（可能在页面字典里内联，也可能挂在一个 Resources 对象上） */
function findFontDict(dict) {
  const inline = /\/Font\s*<</.exec(dict)
  if (inline) return balancedDictAt(dict, inline.index + inline[0].length - 2)
  const rId = refOf(dict, 'Resources')
  if (rId) {
    const rd = dictOf(rId)
    if (rd) {
      const m = /\/Font\s*<</.exec(rd)
      if (m) return balancedDictAt(rd, m.index + m[0].length - 2)
      const fId = refOf(rd, 'Font')
      if (fId) return dictOf(fId)
    }
  }
  const fId = refOf(dict, 'Font')
  return fId ? dictOf(fId) : null
}

function pageText(pageId) {
  const dict = dictOf(pageId)
  const fontMap = new Map()
  const fontDict = findFontDict(dict)
  if (fontDict) for (const m of fontDict.matchAll(/\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g)) fontMap.set(m[1], m[2])
  const contents = []
  const single = refOf(dict, 'Contents')
  if (single) contents.push(single)
  else {
    const arr = /\/Contents\s*\[([\s\S]*?)\]/.exec(dict)?.[1]
    if (arr) for (const m of arr.matchAll(/(\d+)\s+\d+\s+R/g)) contents.push(m[1])
  }
  let text = ''
  for (const cid of contents) {
    const content = streamText(objects.get(String(cid)))
    if (!content) continue
    let cur = null
    let lastWasText = false
    for (const m of content.matchAll(TOKEN_RE)) {
      if (m[1]) { cur = cmapFor(fontMap.get(m[1])); lastWasText = false; continue }
      if (m[2] !== undefined) {
        for (const t of m[2].matchAll(/(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/g)) text += decodeShow(t[1], cur)
        lastWasText = true
        continue
      }
      if (m[3]) { text += decodeShow(m[3], cur); lastWasText = true; continue }
      if (m[5] && lastWasText) { text += '\n'; lastWasText = false }
    }
  }
  return text
}

const pages = pageOrder()
const pageTexts = pages.map(pageText)
const fullText = pageTexts.join('\n')
const fullNoWs = noWs(fullText)

/* ------------------------------------------------------------------ 断言 */

const cjk = (fullText.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length
const sizeMB = buf.length / 1024 / 1024

console.log(`\n=== 核实 ${pdfPath}`)
console.log(`字节 ${buf.length}（${sizeMB.toFixed(2)} MB）· 对象 ${objects.size} 个 · 页面 ${pages.length} 页 · 提取文字 ${fullText.length} 字符（汉字 ${cjk} 个）`)
console.log(`/Title ${JSON.stringify(title)} · /Author ${JSON.stringify(author)} · /Lang ${JSON.stringify(lang)} · /Producer ${JSON.stringify(producer)}`)
if (!opt.json) console.log('\n--- 断言 ---')

add('文件大小不是空壳（≥ 1 MB）', sizeMB >= 1, `${sizeMB.toFixed(2)} MB`)
add('页数与条目规模相称（≥ 100 页）', pages.length >= 100, `${pages.length} 页`)
add('提取到大量汉字（≥ 50000）', cjk >= 50000, `${cjk} 个汉字`)
add('没有大量无法还原的字符', unmapped.count < Math.max(2000, fullText.length * 0.05), `未映射字符 ${unmapped.count} 个 / 共 ${fullText.length}`)
add('/Title 为中文书名', noWs(String(title || '')) === noWs(opt.expectTitle), JSON.stringify(title))
add('/Author 为指定署名', noWs(String(author || '')) === noWs(opt.expectAuthor), JSON.stringify(author))
add('/Lang 声明 zh-CN', String(lang || '') === 'zh-CN', JSON.stringify(lang))

// 书签（Chrome 的 generateDocumentOutline）
let outlineCount = 0
{
  const seen = new Set()
  const walk = (id) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    const dict = dictOf(id)
    if (!dict) return
    outlineCount++
    const first = refOf(dict, 'First')
    if (first) {
      let cur = first
      let guard = 0
      while (cur && guard++ < 5000) {
        const d = dictOf(cur)
        if (!d) break
        outlineCount++
        walk(refOf(d, 'First'))
        cur = refOf(d, 'Next')
      }
    }
  }
  walk(catalog ? refOf(catalog, 'Outlines') : null)
}
add('含 PDF 书签（大纲）', outlineCount > 0, `${outlineCount} 个书签节点`)

// 链接：PDF 里的 /URI 注解应当指向公开发布地址
const uris = [...S.matchAll(/\/URI\s*\(([^)]*)\)/g)].map((m) => m[1])
const linkBase = opt.linkBase.endsWith('/') ? opt.linkBase : `${opt.linkBase}/`
const offBase = uris.filter((u) => !u.startsWith(linkBase))
add('PDF 内含可点链接注解', uris.length > 0, `${uris.length} 个 /URI 注解`)
add(`链接都指向发布地址 ${linkBase}`, uris.length > 0 && offBase.length === 0,
  offBase.length ? `有 ${offBase.length} 个不是，例如 ${offBase.slice(0, 2).join('、')}` : `例如 ${uris[0] || '（无）'}`)

// 抽查：三处指定条目正文
const spots = [
  ['第 2 节·加班费', '加班费分三档：平时加班一点五倍工资'],
  ['第 12 节·竞业限制', '竞业限制有两种写法，规则不一样'],
  ['第 13 节·工亡三笔钱', '因工死亡有三笔'],
]
for (const [name, phrase] of spots) {
  add(`抽查命中 ${name}`, fullNoWs.includes(noWs(phrase)), `「${phrase}」`)
}

// 全量核对：entries.json 里每一条的标题与「说人话」正文都应在 PDF 里。
// 标题在目录页也有一份，所以「说人话」才真正证明条目正文进了 PDF。
let perEntry = null
{
  const ep = join(opt.site, 'entries.json')
  if (existsSync(ep)) {
    const list = JSON.parse(readFileSync(ep, 'utf8')).entries || []
    const missTitle = list.filter((e) => !fullNoWs.includes(noWs(String(e.标题 || ''))))
    const leaded = list.filter((e) => noWs(String(e.说人话 || '')).length >= 8)
    const missLead = leaded.filter((e) => !fullNoWs.includes(noWs(String(e.说人话)).slice(0, 12)))
    perEntry = {
      total: list.length, missTitle: missTitle.length, leadChecked: leaded.length, missLead: missLead.length,
      sample: missLead.slice(0, 3).map((e) => `${e.节号}.${e.条号}`),
    }
    add(`全部条目标题都在 PDF 里（${list.length} 条）`, missTitle.length === 0, missTitle.length ? `缺 ${missTitle.length} 条，例如 ${missTitle.slice(0, 3).map((e) => `${e.节号}.${e.条号} ${e.标题}`).join('；')}` : '一条不缺')
    add(`全部条目的正文片段都在 PDF 里（${leaded.length} 条「说人话」首 12 字）`, missLead.length === 0, missLead.length ? `缺 ${missLead.length} 条，例如 ${perEntry.sample.join('、')}` : '一条不缺')
  }
}

// 打印样式生效：首页 DOM 里有导航/顶栏/检索面板，PDF 里必须一个都没有
const forbidden = [
  ['顶栏副标题', '中国大陆 · 循证指南'],
  ['左侧栏标题', '全书目录'],
  ['跳转正文链接', '跳到正文'],
]
for (const [name, phrase] of forbidden) {
  add(`PDF 里没有${name}`, !fullNoWs.includes(noWs(phrase)), `「${phrase}」`)
}
if (opt.printHtml && existsSync(opt.printHtml)) {
  const src = noWs(readFileSync(opt.printHtml, 'utf8'))
  const inSource = forbidden.filter(([, p]) => src.includes(noWs(p))).map(([n]) => n)
  add('打印源 HTML 里确实带着这些元素（否则「PDF 里没有」不成为证据）', inSource.length === 3, `源里有：${inSource.join('、')}`)
}

// 封面署名、目录、页脚
add('封面/目录含署名「亦幸和幸知」', fullNoWs.includes(noWs(opt.expectAuthor)), `出现 ${(fullText.match(new RegExp(opt.expectAuthor, 'g')) || []).length} 次`)
add('目录页覆盖全部节（≥ 10 个节标题）', (fullText.match(/第 \d+ 节 · /g) || []).length >= 10, `${(fullText.match(/第 \d+ 节 · /g) || []).length} 个节标题`)
add('页脚含页码', /第\s*\d+\s*页/.test(fullText), (fullText.match(/第\s*\d+\s*页/g) || []).slice(0, 2).join(' '))

// 空白页统计
const shortPages = pageTexts.map((t, i) => [i + 1, t.replace(/\s+/g, '').length]).filter(([, n]) => n < 20)
add('没有大量空白页（正文少于 20 字的页 < 5%）', shortPages.length < pages.length * 0.05, `${shortPages.length}/${pages.length} 页${shortPages.length ? `，例如第 ${shortPages.slice(0, 5).map(([p]) => p).join('、')} 页` : ''}`)

/* ------------------------------------------------------------------ 截图 */

const shotFiles = []
if (opt.shots) {
  const CANDIDATES = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  const exe = opt.browser && (opt.browser.includes('/') || opt.browser.includes('\\'))
    ? (existsSync(opt.browser) ? opt.browser : null)
    : (opt.browser || CANDIDATES.find((p) => existsSync(p)))
  if (!exe) add('用浏览器渲染 PDF 页面截图', false, '找不到 Chrome/Edge（可用 --browser 指定）')
  else {
    mkdirSync(opt.shots, { recursive: true })
    const port = 9390 + (process.pid % 400)
    const profile = mkdtempSync(join(tmpdir(), 'wrc-verify-'))
    const flags = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars']
    if (opt.noSandbox) flags.push('--no-sandbox', '--disable-dev-shm-usage')
    const proc = spawn(exe, [...flags, 'about:blank'], { stdio: 'ignore' })
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    try {
      let wsUrl = null
      for (let i = 0; i < 80 && !wsUrl; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/json/list`)
          if (r.ok) wsUrl = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl || null
        } catch { /* 等 */ }
        if (!wsUrl) await sleep(250)
      }
      if (!wsUrl) throw new Error('无头浏览器未就绪')
      const ws = new WebSocket(wsUrl)
      await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('连接失败')), { once: true }) })
      let id = 0
      const pending = new Map()
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
      })
      const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })) })
      await send('Page.enable')
      await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1250, deviceScaleFactor: 1, mobile: false })
      const fileUrl = pathToFileURL(resolve(pdfPath)).href
      for (const p of opt.shotPages) {
        await send('Page.navigate', { url: `${fileUrl}#page=${p}&zoom=100` })
        await sleep(2500)
        const shot = await send('Page.captureScreenshot', { format: 'png' })
        const out = join(opt.shots, `第${String(p).padStart(3, '0')}页.png`)
        writeFileSync(out, Buffer.from(shot.data, 'base64'))
        shotFiles.push(out)
      }
      await send('Browser.close').catch(() => {})
    } catch (e) {
      add('用浏览器渲染 PDF 页面截图', false, e.message)
    } finally {
      proc.kill()
    }
    if (shotFiles.length) add('用浏览器渲染 PDF 页面截图', true, shotFiles.join('、'))
  }
}

/* ------------------------------------------------------------------ 汇总 */

const failed = checks.filter((c) => !c.ok)
const summary = {
  pdf: pdfPath, bytes: buf.length, pages: pages.length, textChars: fullText.length, cjk,
  unmapped: unmapped.count, title, author, lang, producer, outlineCount, uriCount: uris.length, uris: uris.slice(0, 3),
  perEntry, shots: shotFiles, passed: checks.length - failed.length, total: checks.length, failed: failed.map((f) => f.name),
}
if (opt.json) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`\n=== 结果：${checks.length - failed.length}/${checks.length} 项通过`)
  if (failed.length) console.log(`未通过：${failed.map((f) => f.name).join('、')}`)
  console.log(`\n文字样本（前 260 字）：\n${fullText.replace(/\s+/g, ' ').slice(0, 260)}`)
}
process.exit(failed.length ? 1 : 0)
