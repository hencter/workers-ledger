#!/usr/bin/env node
/**
 * 抽原文.mjs —— 把官方页面抓成本地纯文本缓存，供排版与 diff 验证使用
 *
 *   node tools/抽原文.mjs <编号> <URL> […更多编号 URL 对]   抓取并写入缓存
 *   node tools/抽原文.mjs --index <索引.json>              按索引文件批量抓
 *   node tools/抽原文.mjs --all                             抓索引里所有记录
 *   node tools/抽原文.mjs --list                            只列出索引，不抓
 *   node tools/抽原文.mjs --force                           已有缓存也重抓
 *
 * 为什么要有「缓存」这一层：
 *   本仓库的规矩是「不许凭记忆写条文」。但只有一个网址、一次抓取，事后无法复核
 *   当时页面到底写了什么——页面改版、下架、加反爬之后，谁也证明不了 markdown 里
 *   的字来自官方原文。所以这里把抓到的**纯文本与响应哈希**落盘：验证器只比对
 *   缓存，离线可复跑，任何人都能重新抓一次核对哈希。
 *
 * 缓存位置：sources/.原文缓存/<编号>-<序号>.txt + 同名 .json（元数据）。
 * 该目录在 .gitignore 里（属临时取证材料），哈希与结论写进核实记录。
 *
 * 只使用 Node 24 内置模块，零依赖。
 * 退出码：0 全部成功 / 1 有失败 / 2 环境错误
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CACHE = join(ROOT, 'sources', '.原文缓存')

const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAX_BODY = 3_000_000

/** HTML 里代表「块级边界」的标签：转纯文本时换成换行，避免把两条条文粘成一行。
 *  注意：本文件产出的纯文本只用于**比对**，比对前会去掉全部空白，
 *  所以换行数量多一个少一个都不影响结论；这里的目的是让人读缓存时也是通顺的。 */
const BLOCK_TAGS = 'p|div|br|li|tr|h[1-6]|section|article|blockquote|pre|table|thead|tbody|ul|ol|dl|dt|dd|hr|figure|figcaption|header|footer|nav|aside|main|form|fieldset|legend|caption|colgroup|col|address|center|details|summary|dialog|template|noscript|iframe|option|select|textarea|button|label|article|time|mark|ruby|rt|rp|bdi|bdo|wbr|area|map|picture|source|track|video|audio|canvas|svg|math|output|progress|meter|datalist|keygen|menu|menuitem|slot|portal|hgroup'

/** HTML → 纯文本。刻意手写、不用正则一次到底，因为要控制块级边界。 */
export function htmlToText(html) {
  let h = String(html)
  h = h.replace(/<!--[\s\S]*?-->/g, '')
  h = h.replace(/<script[\s\S]*?<\/script\s*>/gi, '')
  h = h.replace(/<style[\s\S]*?<\/style\s*>/gi, '')
  h = h.replace(/<head[\s\S]*?<\/head\s*>/gi, '')
  h = h.replace(/<\!\w[^>]*>/g, '')
  // 块级标签 → 换行标记
  h = h.replace(new RegExp(`<\\s*(?:${BLOCK_TAGS})(?:\\s[^>]*)?/?\\s*>`, 'gi'), '\n')
  h = h.replace(new RegExp(`<\\s*/\\s*(?:${BLOCK_TAGS})\\s*>`, 'gi'), '\n')
  // 其余标签直接去掉（行内标签不产生边界）
  h = h.replace(/<[^>]+>/g, '')
  h = decodeEntities(h)
  return h
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v\u00a0\u3000 ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…',
  middot: '·', bull: '•', sect: '§', copy: '©', reg: '®', trade: '™', deg: '°',
  times: '×', divide: '÷', larr: '←', rarr: '→', laquo: '«', raquo: '»', prime: '′',
  Prime: '″', minus: '−', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾',
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => (name in NAMED ? NAMED[name] : m))
}

function safeCodePoint(n) {
  try { return String.fromCodePoint(n) } catch { return '' }
}

/**
 * 从 docx 里抽出正文纯文本。
 *
 * 为什么需要这条路：有些官方文件的**正文只在附件里**，网页本身只有发文信息。
 * 已知实例：N01《职业学校学生实习管理规定》的通知页不含任何条文，规定全文是附件 1
 * 的 .docx（`tools/核对原文.mjs` 首次跑就对 N01 报了 9 条不匹配，暴露了这个缺口）。
 *
 * 实现：按 Node 24 自带的 zlib 手工解出 zip 里的 `word/document.xml`。**刻意不引 npm
 * 包**（本仓库零依赖），也不依赖系统命令（跨平台与沙箱下都不可靠）。
 *
 * 段落映射：`</w:p>` → 换行，`<w:tab/>` → 制表符，`<w:br/>` → 换行。
 * 这样每一条条文会落在自己那一行，与人读 docx 的版式一致。
 */
export function docxToText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml')
  if (xml === null) throw new Error('zip 里找不到 word/document.xml（不是合法的 docx）')
  let t = xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p\s*>/g, '\n')
    .replace(/<[^>]+>/g, '')
  t = decodeEntities(t)
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** zip 文件尾记录（EOCD）签名 */
const EOCD_SIG = 0x06054b50
const CDH_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** 从 zip 里按名字取出一个条目并 inflate。找不到返回 null。 */
export function unzipEntry(buf, name) {
  // 1) 找 EOCD（从尾部往前找，允许注释所以给足窗口）
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('找不到 zip 的 EOCD 记录')
  const cdCount = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  // 2) 遍历中央目录
  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const entryName = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (entryName === name) {
      // 3) 从本地头定位数据起点
      if (buf.readUInt32LE(localOff) !== LOCAL_SIG) throw new Error(`本地头签名不对：${name}`)
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const data = buf.subarray(dataStart, dataStart + compSize)
      if (method === 0) return data.toString('utf8')
      if (method === 8) return inflateRawSync(data).toString('utf8')
      throw new Error(`不支持的压缩方式 ${method}：${name}`)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

/** 页面标题（用于核对抓到的确实是那部法规，而不是站点的 404 页或首页） */
export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html))
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''
}

async function fetchOne(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(Number(argOf('--timeout', '30000'))),
  })
  const raw = Buffer.from(await res.arrayBuffer())
  const buf = raw.subarray(0, MAX_BODY)
  return { status: res.status, finalUrl: res.url, buf, text: buf.toString('utf8') }
}

/** 从索引文件（JSON）读记录：[{ id, name, urls: [..], kind }] */
function loadIndex(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const list = Array.isArray(data) ? data : data.记录 || data.records || []
  return list.map((r) => ({
    id: r.id ?? r.编号,
    name: r.name ?? r.全称 ?? r.名称,
    urls: r.urls ?? r.链接 ?? [],
    kind: r.kind ?? r.类型 ?? 'html',
  }))
}

/** 内置索引：由 tools/生成原文索引.mjs 从 sources/法规清单.md 机械生成。
 *  刻意落成文件而不是「运行时自动从清单抓」——自动抓会在清单格式变化时静默少抓
 *  几部，那是本仓库最怕的失败形态（看着正常，实际漏了）。清单换源后重新生成索引，
 *  并跑 --list 核对条数。 */
const INDEX = JSON.parse(readFileSync(join(HERE, '原文索引.json'), 'utf8'))

// ---------------------------------------------------------------------------

if (has('--help') || argv.length === 0) {
  console.log(`抽原文 —— 用法：
  node tools/抽原文.mjs <编号> <URL> [...]     抓指定编号的指定 URL
  node tools/抽原文.mjs --all                  抓索引里全部记录（已有缓存跳过）
  node tools/抽原文.mjs --all --force          重抓
  node tools/抽原文.mjs --list                 列出索引
  node tools/抽原文.mjs --only L01,L04         只抓指定编号
  node tools/抽原文.mjs --timeout 60000        单次请求超时（默认 30000）

缓存：sources/.原文缓存/<编号>-<n>.txt 与 .json（含 URL、状态码、标题、字节数、SHA256）
说明：验证器只比对缓存，所以落盘后**可离线复跑**；要更新原文用 --force 重抓。`)
  process.exit(argv.length === 0 ? 1 : 0)
}

if (has('--list')) {
  let total = 0
  for (const r of INDEX.记录) {
    console.log(`${r.id}  ${r.name}`)
    for (const u of r.urls) { console.log(`    ${u}`); total++ }
  }
  console.log(`\n登记 ${INDEX.记录.length} 条，URL ${total} 个`)
  process.exit(0)
}

mkdirSync(CACHE, { recursive: true })

/** 要抓的 (id, url, name) 列表 */
const jobs = []
const onlyArg = argOf('--only', '')
const onlySet = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null

if (has('--all') || onlySet) {
  // --only 可以单独用（等价于「只抓索引里的这些编号」），不必再写 --all
  for (const r of INDEX.记录) {
    if (onlySet && !onlySet.has(r.id)) continue
    r.urls.forEach((u, i) => jobs.push({ id: r.id, name: r.name, url: u, seq: i + 1 }))
  }
} else {
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { if (['--timeout', '--only'].includes(argv[i])) i++; continue }
    pos.push(argv[i])
  }
  if (pos.length % 2 !== 0) {
    console.error('[失败] 参数必须成对：<编号> <URL>。例如 node tools/抽原文.mjs L01 https://example.gov.cn/x.html')
    process.exit(2)
  }
  for (let i = 0; i < pos.length; i += 2) {
    const base = pos[i]
    const seq = jobs.filter((j) => j.id === base).length + 1
    jobs.push({ id: base, name: base, url: pos[i + 1], seq })
  }
}

if (!jobs.length) {
  console.error('[环境错误] 没有可抓的 URL')
  process.exit(2)
}

let ok = 0
let fail = 0
const failures = []

for (const job of jobs) {
  const stem = `${job.id}-${String(job.seq).padStart(2, '0')}`
  const txtPath = join(CACHE, `${stem}.txt`)
  const metaPath = join(CACHE, `${stem}.json`)

  if (existsSync(txtPath) && !has('--force')) {
    console.log(`⏭  ${stem}  已有缓存（用 --force 重抓）　${job.name}`)
    ok++
    continue
  }

  process.stdout.write(`→  ${stem}  ${job.id}　${job.url.slice(0, 70)}\n`)
  try {
    const r = await fetchOne(job.url)
    // docx 附件：zip 魔数 PK。按 docx 解析，不按 HTML。
    const isDocx = r.buf.length > 4 && r.buf[0] === 0x50 && r.buf[1] === 0x4b
    const title = isDocx ? `（docx 附件）${basename(new URL(job.url).pathname)}` : pageTitle(r.text)
    const plain = isDocx ? docxToText(r.buf) : htmlToText(r.text)
    const sha = createHash('sha256').update(r.buf).digest('hex')
    const 类型 = isDocx ? 'docx' : 'html'

    if (r.status !== 200) {
      console.log(`   ✗ HTTP ${r.status}　不写缓存（非 200 的页面不是可用原文）`)
      fail++
      failures.push(`${stem} ${job.url} HTTP ${r.status}`)
      continue
    }
    if (plain.length < 200) {
      console.log(`   ✗ 纯文本仅 ${plain.length} 字符，疑似反爬页/空页　不写缓存`)
      fail++
      failures.push(`${stem} ${job.url} 纯文本过短（${plain.length} 字符）：${plain.slice(0, 80)}`)
      continue
    }

    writeFileSync(txtPath, plain, 'utf8')
    writeFileSync(metaPath, JSON.stringify({
      编号: job.id,
      名称: job.name,
      seq: job.seq,
      url: job.url,
      最终URL: r.finalUrl,
      状态码: r.status,
      类型,
      页面标题: title,
      原始字节: r.buf.length,
      HTML_SHA256: sha,
      SHA256: sha,
      纯文本字符数: plain.length,
      抓取时间: new Date().toISOString(),
    }, null, 2), 'utf8')

    console.log(`   ✓ ${r.buf.length} 字节（${类型}）→ 纯文本 ${plain.length} 字符　${isDocx ? '' : '标题：'}${title.slice(0, 60)}`)
    console.log(`     SHA256 ${sha.slice(0, 16)}…　→ ${basename(txtPath)}`)
    ok++
  } catch (err) {
    const msg = `${err?.name || ''} ${err?.message || ''}`.trim()
    console.log(`   ✗ 抓取失败：${msg.slice(0, 160)}`)
    fail++
    failures.push(`${stem} ${job.url} 抓取失败：${msg.slice(0, 160)}`)
  }
}

console.log('')
console.log(`—— 汇总 ——`)
console.log(`成功/已缓存 ${ok}，失败 ${fail}`)
if (failures.length) {
  console.log('失败清单：')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log(`缓存目录：${CACHE}`)
const cached = existsSync(CACHE) ? readdirSync(CACHE).filter((f) => f.endsWith('.txt')).length : 0
console.log(`缓存文件数：${cached}`)
process.exit(fail ? 1 : 0)
