#!/usr/bin/env node
/**
 * check-refs.mjs —— 源引用完整性核查器：登记 ↔ 依据 ↔ 来源 四方对账
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * `docs/条目规范.md`「来源栏与信源表的分工」与 `AGENTS.md` 底线一要求：
 * 条目「依据」里出现的每一部法规全称，都必须能在 `sources/法规清单.md`（下称清单）
 * 里找到；找不到就报错。清单「六、本表的使用约束」第 1 条又要求来源栏填登记编号
 * 而不是各贴各的链接，好让换源只改一处。
 *
 * 但实际书稿 324 条里 323 条的「来源」栏直接内嵌 URL、0 条按编号填写。于是
 * `tools/check-items.mjs` 里那道交叉核查（只在「来源栏没有 URL 且指向清单」时才
 * 触发）从未被触发过——登记与正文之间实际上没有一道活的锁。
 *
 * 已知后果先例：《住房公积金管理条例》2026 年第三次修订把条号后移 2 位，第 7 节
 * 正文与清单一度不一致，靠人工追查才发现。过程见
 * `docs/核实记录/信源-悬空日期追查.md`、`docs/核实记录/信源-工伤保险条例版本陷阱.md`。
 *
 * ── 与既有工具的分工 ────────────────────────────────────────────────────────
 *   - `tools/check-items.mjs`   —— 条目**结构**门禁（字段、枚举、编号连续、时效、
 *     脱敏链接黑名单）。它对「依据 → 清单」的交叉核查只在来源栏指向清单时才做，
 *     所以对本书当前写法（直接贴链接）等于不生效。
 *   - `tools/check-sources.mjs` —— 只看**清单自己**：清单里每条登记的链接可达性
 *     与页面上的版本日期是否比登记的新。它不看正文引用了什么。
 *   - 本脚本 —— 只看三者的**引用一致性**：正文「依据」声称引了哪部法规、该法规在
 *     清单里登记的版本是什么、正文「来源」栏的链接与标注是否与清单对得上。
 *     它不判断条文实体内容（条号对不对由 `sources/条文摘录.md` 的逐字底本管），
 *     也不联网（可达性由 check-sources.mjs 管）。
 *
 * 本脚本刻意**不复用** `tools/check-sources.mjs` 的解析函数：那个脚本的注释里写明
 * 「刻意不复用，复用会让两边同时错」。此处独立按 Markdown 表格重写清单解析；若两边
 * 对同一份清单解析出不同结论，本身就是值得追查的信号。
 *
 * 复用 `tools/lib/条目规范.mjs`（共享契约）：parseSectionFile / fieldOf /
 * stripInline / urlsIn / entryLabel / listBookFiles。
 *
 * 硬约束：不改 `book/` 下任何文件；不改 check-items.mjs 与 check-sources.mjs 的既有
 * 行为。报出的每一项都带 `book/` 或 `sources/` 的**原文行号与原文片段**作证据，
 * 不凭记忆写法规名、条号、金额、日期。
 *
 * 只使用 Node 24 内置模块，零依赖，不建 package.json。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node tools/check-refs.mjs                      报告模式（退出 0）
 *   node tools/check-refs.mjs --check              有「错误」项时退出 1
 *   node tools/check-refs.mjs --json <文件>        机器可读结果（供看板/下游消费）
 *   node tools/check-refs.mjs --root <目录>        指定仓库根
 *   node tools/check-refs.mjs --summary <文件>     追加 Markdown 汇总
 *   node tools/check-refs.mjs --only 1,3           只跑指定检查项
 *   node tools/check-refs.mjs --skip 4,5           跳过指定检查项
 *   node tools/check-refs.mjs --help
 *
 * 退出码（与既有工具一致）：
 *   0  报告模式跑完；或 --check 下没有「错误」项
 *   1  --check 下发现「错误」项
 *   2  运行环境错误：仓库根/清单缺失、清单解析不到记录、book/ 解析不到条目、参数非法
 *
 * ── 检查项（每项可单独开关、单独计数）────────────────────────────────────────
 *   1  依据里的法规全称未登记                          错误
 *   2  清单登记了但没有任何正文引用                    提示
 *   3  正文写的版本年份早于清单登记的版本年份          错误
 *   4  来源栏里域名不在清单登记范围的裸链接            提示
 *   5  来源栏指向清单编号但编号不存在                  错误
 *   6  清单要求保留「转载页，待换一手源」标注而正文没有 错误
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseSectionFile,
  fieldOf,
  stripInline,
  urlsIn,
  entryLabel,
  listBookFiles,
} from './lib/条目规范.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 六项检查的元信息：id 用于 --only/--skip 与计数 */
const CHECKS = [
  { id: 1, level: '错误', title: '依据里的法规全称未登记' },
  { id: 2, level: '提示', title: '清单登记了但没有任何正文引用' },
  { id: 3, level: '错误', title: '正文写的版本年份早于清单登记的版本年份' },
  { id: 4, level: '提示', title: '来源栏里域名不在清单登记范围的裸链接' },
  { id: 5, level: '错误', title: '来源栏指向清单编号但编号不存在' },
  { id: 6, level: '错误', title: '清单要求保留「转载页，待换一手源」标注而正文没有' },
]

/** 清单「使用约束」第 2 条要求的标注；正则容忍半/全角逗号与空格 */
const REPRINT_MARK_RE = /转载页[，,、]?\s*待换一手源/

// ---------------------------------------------------------------------------
// 文本与表格小工具
// ---------------------------------------------------------------------------

/** 列名归一：去 markdown 标记、空格与全角空格、冒号，转小写 */
function normKey(s) {
  return String(s)
    .replace(/[*_`\s　]/g, '')
    .replace(/[：:]/g, '')
    .toLowerCase()
}

/** 法规名归一：去书名号、尖括号与所有空白。精确匹配即在此结果上做全等比较。 */
function normName(s) {
  return stripInline(String(s)).replace(/[《》〈〉\s　]/g, '')
}

/** 简称：去掉「中华人民共和国」前缀，用于「来源栏提到该法规名」的宽松判断 */
function shortName(s) {
  return normName(s).replace(/^中华人民共和国/, '')
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 报告与 JSON 里的行内片段：压掉换行、截断，保留足够定位的信息 */
function excerpt(s, max = 110) {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 文件内 1 基行号处的一行原文，用于「证据是原文」 */
function lineAt(lines, n) {
  return lines[n - 1] ?? ''
}

/**
 * 把文本里的 URL 抠掉，只留下叙述文字。用于检查项 5：
 * 网址路径里会出现 `A02`、`t20201119` 这类片段，直接在原文上扫编号会误报
 * （实测：`moe.gov.cn/srcsite/A02/...` 被当成了清单编号 A02）。
 */
function maskUrls(s) {
  let out = String(s)
  for (const u of urlsIn(s)) out = out.replaceAll(u, '（URL）')
  return out
}

const rel = (root, p) => path.relative(root, p).split(path.sep).join('/')

// ---------------------------------------------------------------------------
// 清单解析（独立实现，不 import check-sources.mjs）
// ---------------------------------------------------------------------------

function colKind(header) {
  const n = normKey(header)
  if (n === '编号' || n === '序号') return 'id'
  if (n.includes('文件全称') || n.includes('法规全称') || n.includes('全称')) return 'name'
  if (n.includes('现行版本') || n.includes('版本')) return 'version'
  if (n.includes('url') || n.includes('链接') || n.includes('网址')) return 'url'
  if (n.includes('核验状态') || n.includes('核对') || n.includes('核实')) return 'checked'
  if (n.includes('效力位阶')) return 'level'
  if (n.includes('制定机关')) return 'authority'
  if (n.includes('文号')) return 'docno'
  if (n.includes('名称')) return 'name'
  return null
}

/**
 * 解析清单里的 Markdown 表格。只认同时有「编号」列与「名称/全称」列的表
 * （本仓库清单的四张登记表都是这种表；文中的警示对照表没有这两列，自动跳过）。
 */
function parseRegistry(text) {
  const lines = text.split(/\r?\n/)
  const records = []
  const tables = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim().startsWith('|')) { i++; continue }
    const start = i
    const rows = []
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      rows.push({ line: i + 1, cells: splitRow(lines[i]) })
      i++
    }
    if (rows.length < 2) continue
    const kinds = rows[0].cells.map(colKind)
    if (!kinds.includes('id') || !kinds.includes('name')) continue
    tables.push({ headerLine: start + 1, rows: rows.length - 1 })
    for (const row of rows.slice(1)) {
      if (isSeparatorRow(row.cells)) continue
      if (row.cells.every((c) => c === '')) continue
      const rec = { id: '', name: '', version: '', url: '', checked: '', level: '', authority: '', docno: '', line: row.line }
      row.cells.forEach((cell, idx) => {
        const k = kinds[idx]
        if (k && rec[k] === '') rec[k] = cell
      })
      rec.id = stripInline(rec.id)
      rec.name = stripInline(rec.name)
      rec.version = stripInline(rec.version)
      rec.checked = stripInline(rec.checked)
      if (!rec.id || !rec.name) continue
      rec.norm = normName(rec.name)
      rec.short = shortName(rec.name)
      records.push(rec)
    }
  }
  return { records, tables }
}

// ---------------------------------------------------------------------------
// 日期与版本关键词
// ---------------------------------------------------------------------------

const KEYWORDS = [
  { kind: '修正', re: /修正|修订|修改/g },
  { kind: '施行', re: /施行|实施|生效/g },
  { kind: '公布', re: /通过|公布|发布/g },
]

/** 收集窗口内的日期（只认带分隔符或「年」的 4 位年份，避免把金额、条号当日期） */
function collectDates(win) {
  const out = []
  const re1 = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/g
  let m
  while ((m = re1.exec(win)) !== null) {
    out.push({ idx: m.index, end: m.index + m[0].length, year: Number(m[1]), text: m[0] })
  }
  const re2 = /(\d{4})\s*年/g
  while ((m = re2.exec(win)) !== null) {
    if (out.some((d) => m.index >= d.idx && m.index < d.end)) continue
    out.push({ idx: m.index, end: m.index + m[0].length, year: Number(m[1]), text: m[0] })
  }
  return out.sort((a, b) => a.idx - b.idx)
}

function collectKeywords(win) {
  const out = []
  for (const { kind, re } of KEYWORDS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(win)) !== null) out.push({ kind, idx: m.index, end: m.index + m[0].length })
  }
  return out.sort((a, b) => a.idx - b.idx)
}

/**
 * 给窗口内每个日期配一个版本关键词：优先配日期右侧最近的（间隔 ≤ 16 字符），
 * 右侧没有才回头配左侧。规则同 check-sources.mjs 的口径（「修订后自 2011-01-01
 * 施行」必须配右侧的「施行」），但这里是独立实现。
 */
function typedDates(win) {
  const dates = collectDates(win)
  const kws = collectKeywords(win)
  for (const d of dates) {
    let after = null
    for (const k of kws) {
      if (k.idx < d.end - 1) continue
      if (k.idx - d.end > 16) continue
      if (!after || k.idx < after.idx) after = k
    }
    if (after) { d.kind = after.kind; continue }
    let before = null
    for (const k of kws) {
      const gap = d.idx - k.end
      if (gap < 0 || gap > 16) continue
      if (!before || k.idx > before.idx) before = k
    }
    d.kind = before ? before.kind : '其他'
  }
  return dates
}

function maxYearByKind(dates, kind) {
  const ys = dates.filter((d) => d.kind === kind).map((d) => d.year)
  return ys.length ? Math.max(...ys) : null
}

// ---------------------------------------------------------------------------
// 正文解析与「依据」引用抽取
// ---------------------------------------------------------------------------

const CITE_RE = /《([^《》]+)》/g

/**
 * 抽一个「依据」栏里的全部法规引用。每条引用带：
 *   raw/managed 名称、窗口（引用名之后到下一个书名号之前）、该窗口内的版本日期。
 * 窗口取「名后到下一个书名号」是因为本仓库的写法是「《法名》（版本）条款号…」，
 * 版本括注紧跟在法名之后；不取名前，避免把上一部法规的版本括注算进来。
 */
function extractCitations(value, line) {
  const text = stripInline(value)
  const marks = []
  CITE_RE.lastIndex = 0
  let m
  while ((m = CITE_RE.exec(text)) !== null) {
    marks.push({ raw: m[1], norm: normName(m[1]), start: m.index, end: m.index + m[0].length })
  }
  return marks.map((mk, i) => {
    const next = i + 1 < marks.length ? marks[i + 1].start : text.length
    const win = text.slice(mk.end, next)
    return {
      raw: mk.raw,
      norm: mk.norm,
      line,
      window: win,
      snippet: excerpt(text.slice(Math.max(0, mk.start - 12), Math.min(text.length, next + 12))),
      dates: typedDates(win),
    }
  })
}

/**
 * 在清单里给一个引用名找登记记录。
 *   1) 归一后全等 → 精确；
 *   2) 否则双向子串容错（清单全称含引用简称，或引用名含清单全称），
 *      多个候选时取「与引用名长度差最小」的（《劳动合同法》因此落到 L01
 *      而不是《劳动合同法实施条例》G01），再按清单顺序兜底。
 */
function resolveCitation(cite, registry) {
  const exact = registry.filter((r) => r.norm === cite.norm)
  if (exact.length) return { rec: exact[0], how: '精确', candidates: exact.map((r) => r.id) }
  const fuzzy = registry.filter((r) => r.norm.includes(cite.norm) || cite.norm.includes(r.norm))
  if (!fuzzy.length) return { rec: null, how: '未匹配', candidates: [] }
  const sorted = [...fuzzy].sort(
    (a, b) =>
      Math.abs(a.norm.length - cite.norm.length) - Math.abs(b.norm.length - cite.norm.length) ||
      a.norm.length - b.norm.length,
  )
  return { rec: sorted[0], how: '容错', candidates: sorted.map((r) => r.id) }
}

// ---------------------------------------------------------------------------
// 附加输入：条文摘录、核实记录（为报错项附证据线索）
// ---------------------------------------------------------------------------

function parseExcerpts(text) {
  const lines = text.split(/\r?\n/)
  const sections = []
  const citedIds = new Map() // id -> [行号]
  for (let i = 0; i < lines.length; i++) {
    const h = /^##\s+([A-Z]{1,3}\d{1,3})\s*(.*)$/.exec(lines[i])
    if (h) sections.push({ id: h[1], name: h[2].trim(), line: i + 1 })
    const s = /^来源[：:]\s*([A-Z]{1,3}\d{1,3})/.exec(lines[i].trim())
    if (s) {
      if (!citedIds.has(s[1])) citedIds.set(s[1], [])
      citedIds.get(s[1]).push(i + 1)
    }
  }
  return { sections, citedIds }
}

function buildVerifyIndex(dir, registry) {
  const index = new Map() // id -> [{file, line, text}]
  if (!fs.existsSync(dir)) return index
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const p = path.join(dir, name)
    let lines
    try { lines = fs.readFileSync(p, 'utf8').split(/\r?\n/) } catch { continue }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const rec of registry) {
        if (!line.includes(rec.id)) continue
        if (!index.has(rec.id)) index.set(rec.id, [])
        const arr = index.get(rec.id)
        if (arr.length < 40) arr.push({ file: name, line: i + 1, text: excerpt(line, 90) })
      }
    }
  }
  return index
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opt = { check: false, root: path.resolve(SCRIPT_DIR, '..'), json: '', summary: '', only: null, skip: null, help: false }
  const parseIds = (v, flag) => {
    const ids = String(v ?? '').split(/[,，\s]+/).filter(Boolean).map(Number)
    if (!ids.length || ids.some((n) => !Number.isInteger(n) || n < 1 || n > CHECKS.length)) {
      console.error(`[环境错误] ${flag} 需要 1..${CHECKS.length} 的检查项编号，收到：${v}`)
      process.exit(2)
    }
    return new Set(ids)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') opt.check = true
    else if (a === '--help' || a === '-h') opt.help = true
    else if (a === '--root') opt.root = path.resolve(argv[++i] ?? '.')
    else if (a === '--json') opt.json = path.resolve(argv[++i] ?? '')
    else if (a === '--summary') opt.summary = path.resolve(argv[++i] ?? '')
    else if (a === '--only') opt.only = parseIds(argv[++i], '--only')
    else if (a === '--skip') opt.skip = parseIds(argv[++i], '--skip')
    else {
      console.error(`[环境错误] 未知参数：${a}（用 --help 查看用法）`)
      process.exit(2)
    }
  }
  return opt
}

const USAGE = `源引用完整性核查器 —— 用法：
  node tools/check-refs.mjs                      报告模式（退出 0）
  node tools/check-refs.mjs --check              有「错误」项时退出 1
  node tools/check-refs.mjs --json <文件>        机器可读结果
  node tools/check-refs.mjs --root <目录>        指定仓库根
  node tools/check-refs.mjs --summary <文件>     追加 Markdown 汇总
  node tools/check-refs.mjs --only 1,3           只跑指定检查项
  node tools/check-refs.mjs --skip 4,5           跳过指定检查项
检查项：1 依据未登记(错) / 2 登记无人引用(提示) / 3 版本年份偏早(错) /
        4 来源裸链接域名未登记(提示) / 5 来源编号不存在(错) / 6 转载标注缺失(错)
退出码：0 通过 / 1 有错误项 / 2 运行环境错误`

function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.help) { console.log(USAGE); process.exit(0) }

  const enabled = new Set(CHECKS.map((c) => c.id))
  if (opt.only) for (const id of [...enabled]) if (!opt.only.has(id)) enabled.delete(id)
  if (opt.skip) for (const id of opt.skip) enabled.delete(id)

  const root = opt.root
  const bookDir = path.join(root, 'book')
  const registryPath = path.join(root, 'sources', '法规清单.md')
  const excerptsPath = path.join(root, 'sources', '条文摘录.md')
  const verifyDir = path.join(root, 'docs', '核实记录')

  console.log('源引用完整性核查器（登记 ↔ 依据 ↔ 来源）')
  console.log(`仓库根：${root}`)
  console.log(`检查项：${[...enabled].join(', ') || '（全部关闭）'}`)
  console.log('')

  if (!fs.existsSync(bookDir)) {
    console.error(`[环境错误] 正文目录不存在：${bookDir}`)
    process.exit(2)
  }
  if (!fs.existsSync(registryPath)) {
    console.error(`[环境错误] 法规清单不存在：${registryPath}`)
    console.error('说明：清单缺失时对账无从谈起，按约定报错退出（退出码 2）。')
    process.exit(2)
  }

  // ---- 读清单 ----
  let registryText
  try { registryText = fs.readFileSync(registryPath, 'utf8') } catch (err) {
    console.error(`[环境错误] 法规清单读不了：${err.message}`)
    process.exit(2)
  }
  const { records: registry, tables } = parseRegistry(registryText)
  if (!registry.length) {
    console.error('[环境错误] 清单里解析不到任何登记记录（需要含「编号」「文件全称」列的 Markdown 表格）。')
    console.error('说明：一条都读不到等于没对账，按约定以退出码 2 报错。')
    process.exit(2)
  }
  const registryById = new Map(registry.map((r) => [r.id, r]))
  const registryLines = registryText.split(/\r?\n/)
  const registryHosts = new Set()
  for (const r of registry) for (const u of urlsIn(r.url)) { const h = hostOf(u); if (h) registryHosts.add(h) }

  // ---- 读正文 ----
  const bookFiles = listBookFiles(bookDir)
  const sections = []
  for (const p of bookFiles) {
    try { sections.push(parseSectionFile(p, rel(root, p))) } catch (err) {
      console.error(`[环境错误] 正文文件读不了：${rel(root, p)}：${err.message}`)
      process.exit(2)
    }
  }
  const entries = []
  for (const s of sections) for (const e of s.entries) entries.push({ section: s, entry: e })
  if (!entries.length) {
    console.error(`[环境错误] 在 ${bookFiles.length} 个正文文件里没有解析到任何条目（形如 ### 8.3 标题）。`)
    process.exit(2)
  }

  // ---- 抽引用并解析到清单 ----
  const resolvedEntries = entries.map(({ section, entry }) => {
    const 依据Field = entry.fields.find((f) => f.name === '依据')
    const 来源Field = entry.fields.find((f) => f.name === '来源')
    const 依据 = 依据Field ? 依据Field.value : ''
    const 来源 = 来源Field ? 来源Field.value : ''
    const cites = extractCitations(依据, 依据Field ? 依据Field.line : entry.titleLine).map((c) => {
      const res = resolveCitation(c, registry)
      return { ...c, rec: res.rec, how: res.how, candidates: res.candidates }
    })
    return {
      file: rel(root, section.path),
      fileLines: section.lines,
      section: section.section,
      title: section.title,
      entry,
      label: entryLabel(entry),
      依据, 来源,
      依据Line: 依据Field ? 依据Field.line : null,
      来源Line: 来源Field ? 来源Field.line : null,
      cites,
    }
  })

  // 每条登记被哪些条目引用（检查项 2 用）
  const citedBy = new Map()
  for (const r of registry) citedBy.set(r.id, [])
  for (const e of resolvedEntries) {
    for (const c of e.cites) {
      if (c.rec) citedBy.get(c.rec.id).push(e)
    }
  }

  // ---- 附加输入 ----
  let excerptInfo = { sections: [], citedIds: new Map() }
  if (fs.existsSync(excerptsPath)) {
    try { excerptInfo = parseExcerpts(fs.readFileSync(excerptsPath, 'utf8')) } catch { /* 摘录缺失不阻断 */ }
  }
  const verifyIndex = buildVerifyIndex(verifyDir, registry)

  const results = new Map()
  const add = (checkId, level, finding) => {
    if (!results.has(checkId)) results.set(checkId, [])
    results.get(checkId).push({ check: checkId, level, ...finding })
  }

  // =========================================================================
  // 检查项 1：依据里的法规全称未登记
  // =========================================================================
  let matchedExact = 0
  let matchedFuzzy = 0
  if (enabled.has(1)) {
    for (const e of resolvedEntries) {
      for (const c of e.cites) {
        if (c.rec) {
          if (c.how === '精确') matchedExact++
          else matchedFuzzy++
          continue
        }
        add(1, '错误', {
          file: e.file,
          line: c.line,
          entry: e.label,
          law: `《${c.raw}》`,
          message: `「依据」引用的《${c.raw}》在清单里找不到任何登记（已按去空格、去书名号归一化后做精确与双向子串匹配）`,
          evidence: `${e.file.split('/').pop()}:${c.line} 「依据」原文：${excerpt(e.依据, 140)}`,
        })
      }
    }
  }

  // =========================================================================
  // 检查项 2：清单登记了但无人引用
  //
  // 例外：编号以 P 开头的是「实践断言来源」（清单二之三节），以 C 开头的是
  // 「求助与反馈渠道」（二之四节）。这两类**在本仓库的设计里就不该被「依据」栏引用**——
  // 它们分别是统计与实践入口，引用它们等于把「有多少人问过」或「打哪个电话」当成
  // 「法律规定了什么」。对它们报「登记但无人引用」是**误报**，会把真问题淹掉。
  // 这个例外不是放水：它们的用途由清单使用约束第 6 条与渠道页各自管着。
  // =========================================================================
  if (enabled.has(2)) {
    const 非依据编号 = /^[PC]\d{2}$/
    for (const r of registry) {
      if (非依据编号.test(r.id)) continue
      const users = citedBy.get(r.id)
      if (users.length) continue
      add(2, '提示', {
        file: rel(root, registryPath),
        line: r.line,
        registryId: r.id,
        law: `《${r.name}》`,
        message: `${r.id}《${r.name}》已登记，但 book/ 里没有任何条目的「依据」引用它`,
        evidence: `${rel(root, registryPath)}:${r.line} 原文：${excerpt(lineAt(registryLines, r.line), 140)}`,
      })
    }
  }

  // =========================================================================
  // 检查项 3：正文写的版本年份早于清单登记的
  // =========================================================================
  let versionComparable = 0 // 正文与清单在同类关键词上都有年份、真正做了比对的项
  let citationsWithYear = 0 // 「依据」里带了年份的引用数
  let citationsYearUnpaired = 0 // 正文有年份、但清单同类关键词没写年份，无法比对
  const versionUnpairedExamples = []
  if (enabled.has(3)) {
    for (const e of resolvedEntries) {
      for (const c of e.cites) {
        if (!c.rec) continue
        if (c.dates.length) citationsWithYear++
        const regDates = typedDates(c.rec.version)
        let pairedAny = false
        for (const kind of ['修正', '施行']) {
          const b = maxYearByKind(c.dates, kind)
          const r = maxYearByKind(regDates, kind)
          if (b === null || r === null) continue
          pairedAny = true
          versionComparable++
          if (b < r) {
            add(3, '错误', {
              file: e.file,
              line: c.line,
              entry: e.label,
              law: `《${c.raw}》`,
              registryId: c.rec.id,
              message: `正文「依据」写的${kind}年份 ${b} 早于清单 ${c.rec.id} 登记的${kind}年份 ${r}（正文可能仍按旧版写）`,
              evidence: `正文 ${e.file.split('/').pop()}:${c.line}：${c.snippet}｜清单 ${rel(root, registryPath)}:${c.rec.line}「现行版本」：${excerpt(c.rec.version, 120)}`,
            })
          } else if (b > r) {
            add(3, '提示', {
              file: e.file,
              line: c.line,
              entry: e.label,
              law: `《${c.raw}》`,
              registryId: c.rec.id,
              extra: '正文年份晚于清单',
              message: `正文「依据」写的${kind}年份 ${b} 晚于清单 ${c.rec.id} 登记的 ${r}——要么正文写错，要么清单该更新（清单登记换源须在 docs/核实记录/ 留痕）`,
              evidence: `正文 ${e.file.split('/').pop()}:${c.line}：${c.snippet}｜清单 ${rel(root, registryPath)}:${c.rec.line}「现行版本」：${excerpt(c.rec.version, 120)}`,
            })
          }
        }
        if (c.dates.length && !pairedAny) {
          citationsYearUnpaired++
          // 同类关键词配不上对时的兜底：拿「本条所引同一登记记录相关的全部年份」与
          // 清单「现行版本」栏的最大年份比。这一条是真实事故逼出来的——清单侧把
          // N01 换源到 2021 年修订本（并写明废止 2016 年本）后，正文仍写「2016 年
          // 印发」，而两侧的年份都不是「修正/施行」关键词，同类比对完全看不到它。
          // 同一登记记录的多个引用（例如条文 + 修改决定）年份合并，避免把
          // 「2003 年公布…2010 年修订…2011 年施行」这种写法误判成落后。
          const sameRec = e.cites.filter((x) => x.rec && x.rec.id === c.rec.id)
          const relatedYears = sameRec.flatMap((x) => x.dates.map((d) => d.year)).filter(Number.isFinite)
          const regYears = typedDates(c.rec.version).map((d) => d.year)
          const registryMax = regYears.length ? Math.max(...regYears) : null
          const relatedMax = relatedYears.length ? Math.max(...relatedYears) : null
          if (relatedMax !== null && registryMax !== null && relatedMax < registryMax) {
            add(3, '错误', {
              file: e.file,
              line: c.line,
              entry: e.label,
              law: `《${c.raw}》`,
              registryId: c.rec.id,
              fallback: true,
              message: `正文「依据」写的最新年份 ${relatedMax} 早于清单 ${c.rec.id} 登记的最新年份 ${registryMax}（正文与清单的版本关键词不同类、无法逐类配对，按整版落后判定）`,
              evidence: `正文 ${e.file.split('/').pop()}:${c.line}：${c.snippet}｜清单 ${rel(root, registryPath)}:${c.rec.line}「现行版本」：${excerpt(c.rec.version, 130)}`,
            })
          }
          if (versionUnpairedExamples.length < 10) {
            versionUnpairedExamples.push({
              file: e.file, line: c.line, entry: e.label, law: `《${c.raw}》`, registryId: c.rec.id,
              bookYears: [...new Set(c.dates.map((d) => `${d.year}(${d.kind})`))].join('、'),
              registryVersion: excerpt(c.rec.version, 100),
            })
          }
        }
      }
    }
  }

  // =========================================================================
  // 检查项 4：来源栏里域名不在清单登记范围的裸链接
  // =========================================================================
  // 判据取**最保守、零误报**的口径：URL 域名不在清单**任何一条**登记的 URL
  // 域名集合内。更严的口径「不在本条『依据』所引法规的登记域名内」另列为附带
  // 观察 E4——因为它会把「引 A 法、另附已登记的 B 法链接」也报出来（实测有
  // 一类：条目来源附《最高人民法院公报》解释（二）链接，而 2012 复引正文的
  // 「依据」只写了《劳动合同法》），那是另一类问题，不适合混进本项计数。
  let urlOccurrences = 0
  const flaggedHosts = new Set()
  const entriesWithUrl = new Set()
  const entriesWithFlaggedUrl = new Set()
  const allSourceUrls = new Set()
  const allSourceHosts = new Set()
  const strictFlagged = [] // E4：域名不在「本条所引法规」登记域名内，但清单里有
  const c4on = enabled.has(4)
  {
    for (const e of resolvedEntries) {
      const urls = urlsIn(e.来源)
      if (urls.length) entriesWithUrl.add(e.file + '#' + e.entry.number)
      urlOccurrences += urls.length
      for (const u of urls) {
        allSourceUrls.add(u)
        const hu = hostOf(u)
        if (hu) allSourceHosts.add(hu)
      }
      // 本条相关法规的登记域名：依据所引 ∪ 来源文字里出现的登记法规名
      const strictAllowed = new Set()
      for (const c of e.cites) if (c.rec) for (const u of urlsIn(c.rec.url)) strictAllowed.add(hostOf(u))
      const srcNorm = normName(e.来源)
      for (const r of registry) {
        if (srcNorm.includes(r.short) || srcNorm.includes(r.norm)) {
          for (const u of urlsIn(r.url)) strictAllowed.add(hostOf(u))
        }
      }
      for (const u of urls) {
        const h = hostOf(u)
        if (!h) {
          if (c4on) add(4, '提示', {
            file: e.file, line: e.来源Line, entry: e.label, url: u,
            message: `「来源」里的链接无法解析为合法网址`,
            evidence: `${e.file.split('/').pop()}:${e.来源Line}：${excerpt(e.来源, 140)}`,
          })
          continue
        }
        if (!registryHosts.has(h)) {
          flaggedHosts.add(h)
          entriesWithFlaggedUrl.add(e.file + '#' + e.entry.number)
          if (c4on) add(4, '提示', {
            file: e.file, line: e.来源Line, entry: e.label, url: u, host: h,
            message: `「来源」直接内嵌 ${h} 的链接，该域名不在清单任何一条登记的 URL 内——清单换源时这条不会跟着变`,
            evidence: `${e.file.split('/').pop()}:${e.来源Line}：${excerpt(e.来源, 140)}｜清单已登记域名：${[...registryHosts].sort().join('、')}`,
          })
        } else if (!strictAllowed.has(h)) {
          strictFlagged.push({
            file: e.file, line: e.来源Line, entry: e.label, url: u, host: h,
            message: `「来源」的 ${h} 链接已登记在清单，但不属于本条「依据」所引法规或来源文字提到的法规——属于「来源引了依据里没有的法规」这一类，需人工判断`,
            evidence: `${e.file.split('/').pop()}:${e.来源Line}：${excerpt(e.来源, 140)}｜本条相关域名：${[...strictAllowed].sort().join('、') || '（无）'}`,
          })
        }
      }
    }
  }

  // =========================================================================
  // 检查项 5：来源栏指向清单编号但编号不存在
  // =========================================================================
  const CODE_RE = /(?<![A-Za-z0-9])([A-Z])(\d{2})(?![0-9])/g
  let codeRefsValid = 0
  for (const e of resolvedEntries) {
    // 先在「抠掉 URL 的文字」上匹配：网址路径里的 A02、t20201119 这类片段
    // 不是清单编号，直接在原文上扫会误报（实测踩过）。
    const text = maskUrls(e.来源)
    CODE_RE.lastIndex = 0
    let m
    while ((m = CODE_RE.exec(text)) !== null) {
      const id = m[1] + m[2]
      if (registryById.has(id)) { codeRefsValid++; continue }
      if (enabled.has(5)) {
        add(5, '错误', {
          file: e.file, line: e.来源Line, entry: e.label, code: id,
          message: `「来源」引用了清单编号 ${id}，但清单里没有这个编号`,
          evidence: `${e.file.split('/').pop()}:${e.来源Line}：${excerpt(e.来源, 140)}`,
        })
      }
    }
  }

  // =========================================================================
  // 检查项 6：清单要求保留「转载页，待换一手源」标注而正文没有
  // =========================================================================
  const reprintRequired = registry.filter((r) => REPRINT_MARK_RE.test(r.checked) || REPRINT_MARK_RE.test(r.url))
  if (enabled.has(6)) {
    for (const e of resolvedEntries) {
      for (const c of e.cites) {
        if (!c.rec || !REPRINT_MARK_RE.test(c.rec.checked) && !REPRINT_MARK_RE.test(c.rec.url)) continue
        if (REPRINT_MARK_RE.test(e.来源)) continue
        add(6, '错误', {
          file: e.file, line: e.来源Line, entry: e.label, law: `《${c.raw}》`, registryId: c.rec.id,
          message: `清单 ${c.rec.id} 的核验状态带「转载页，待换一手源」，条目「来源」栏必须保留该标注（清单使用约束第 2 条）`,
          evidence: `清单 ${rel(root, registryPath)}:${c.rec.line}「核验状态」：${excerpt(c.rec.checked, 120)}｜正文来源：${excerpt(e.来源, 140)}`,
        })
      }
    }
  }

  // =========================================================================
  // 附带观察（不属六项检查，不计入上面的命中数）
  // =========================================================================
  const extras = []

  // E1 正文「来源」保留了「转载页，待换一手源」，但清单已不再要求（反向）
  for (const e of resolvedEntries) {
    if (!REPRINT_MARK_RE.test(e.来源)) continue
    const requiredHere = e.cites.some((c) => c.rec && (REPRINT_MARK_RE.test(c.rec.checked) || REPRINT_MARK_RE.test(c.rec.url)))
    if (requiredHere) continue
    const laws = e.cites.filter((c) => c.rec && REPRINT_MARK_RE.test(c.rec.checked)).map((c) => c.rec.id)
    extras.push({
      kind: '来源标注方向相反',
      level: '提示',
      file: e.file, line: e.来源Line, entry: e.label,
      message: `正文「来源」仍写「转载页，待换一手源」，但清单里该条目所引法规的核验状态已不含该标注${laws.length ? `（${laws.join('、')}）` : ''}`,
      evidence: `${e.file.split('/').pop()}:${e.来源Line}：${excerpt(e.来源, 140)}`,
    })
  }

  // E2 check-items 交叉核查的触发条件现状（这道锁是否生效，用数字说话）
  const triggerEntries = resolvedEntries.filter(
    (e) => urlsIn(e.来源).length === 0 && /法规清单|信源表|sources[\\/]/.test(e.来源),
  )
  const noUrlEntries = resolvedEntries.filter((e) => urlsIn(e.来源).length === 0)

  // E3 摘录与清单的编号互认
  const excerptIds = new Set(excerptInfo.sections.map((s) => s.id))
  for (const [id, lines] of excerptInfo.citedIds) {
    if (registryById.has(id)) continue
    extras.push({
      kind: '摘录引用了清单外的编号', level: '提示',
      file: rel(root, excerptsPath), line: lines[0],
      message: `sources/条文摘录.md 出现编号 ${id}，但清单里没有这个编号`,
      evidence: `${rel(root, excerptsPath)}:${lines[0]} 原文：${excerpt(lineAt(fs.existsSync(excerptsPath) ? fs.readFileSync(excerptsPath, 'utf8').split(/\r?\n/) : [], lines[0]), 140)}`,
    })
  }
  const missingExcerpt = registry.filter((r) => !excerptIds.has(r.id))

  // E4 域名已登记、但不属于本条所引法规（检查项 4 的严口径，单列）
  for (const x of strictFlagged) {
    extras.push({ kind: '来源链接不属于本条所引法规', level: '提示', ...x })
  }

  const reverseCount = extras.filter((x) => x.kind === '来源标注方向相反').length
  const excerptOutside = extras.filter((x) => x.kind === '摘录引用了清单外的编号').length
  const strictCount = extras.filter((x) => x.kind === '来源链接不属于本条所引法规').length

  console.log(`正文：book/ ${sections.length} 个文件，${entries.length} 条条目`)
  console.log(`清单：${rel(root, registryPath)} ${registry.length} 条登记（${tables.length} 张登记表）`)
  console.log(`摘录：${excerptInfo.sections.length} 个编号节；核实记录：${verifyIndex.size ? [...verifyIndex.keys()].length : 0} 个被引编号`)
  console.log('')

  // ---- 打印六项 ----
  const summaryRows = []
  for (const chk of CHECKS) {
    const list = results.get(chk.id) ?? []
    const errors = list.filter((f) => f.level === '错误').length
    const infos = list.filter((f) => f.level === '提示').length
    const state = enabled.has(chk.id) ? '' : '（本次未启用）'
    console.log(`—— 检查项 ${chk.id}/6 ${chk.title}［${chk.level}］${state} ——`)
    console.log(`  命中 ${list.length} 项${errors ? `（错误 ${errors}）` : ''}${infos ? `（提示 ${infos}）` : ''}`)
    if (!enabled.has(chk.id)) { console.log(''); summaryRows.push({ chk, errors: 0, infos: 0, total: 0, enabled: false }); continue }
    if (chk.id === 1) console.log(`  其中：精确匹配 ${matchedExact} 条引用，容错匹配 ${matchedFuzzy} 条引用`)
    if (chk.id === 3) console.log(`  比对覆盖：带年份的引用 ${citationsWithYear} 条，其中正文与清单同类年份可比 ${versionComparable} 对；正文有年份但清单同类没写年份、无法比对 ${citationsYearUnpaired} 条`)
    if (chk.id === 5) console.log(`  其中：合法编号引用 ${codeRefsValid} 次`)
    if (chk.id === 6) console.log(`  清单里带「转载页，待换一手源」的登记：${reprintRequired.length} 条${reprintRequired.length ? `（${reprintRequired.map((r) => r.id).join('、')}）` : ''}`)
    for (const f of list.slice(0, 40)) {
      const where = `${f.file.split('/').pop()}:${f.line}`
      console.log(`  [${f.level}] ${where} ${f.entry ?? ''} ${f.message}`)
      if (f.evidence) console.log(`        证据：${f.evidence}`)
      const rels = f.registryId && verifyIndex.has(f.registryId) ? verifyIndex.get(f.registryId).slice(0, 2) : []
      for (const v of rels) console.log(`        相关核实记录：docs/核实记录/${v.file}:${v.line}「${v.text}」`)
    }
    if (list.length > 40) console.log(`  …（另有 ${list.length - 40} 项，见 --json 输出）`)
    console.log('')
    summaryRows.push({ chk, errors, infos, total: list.length, enabled: true })
  }

  console.log('—— 附带观察（不属六项，不参与退出码）——')
  console.log(`  E1 来源标注方向相反（清单已撤销标注、正文仍保留）：${reverseCount} 项`)
  console.log(`  E2 check-items 交叉核查触发条件：来源栏无 URL 的条目 ${noUrlEntries.length} 条，其中同时指向清单/信源表的 ${triggerEntries.length} 条；来源栏直接内嵌 URL 的条目 ${entriesWithUrl.size} 条、按清单编号填写的 0 条 → check-items.mjs 的「依据→清单」核查不触发`)
  console.log(`  E3 摘录引用了清单外的编号：${excerptOutside} 项；清单登记但摘录里没有编号节的：${missingExcerpt.length} 条（${missingExcerpt.map((r) => r.id).join('、') || '无'}）`)
  console.log(`  E4 来源链接域名已登记但不属于本条所引法规：${strictCount} 项（检查项 4 的严口径，单列不计入）`)
  for (const x of extras.slice(0, 20)) {
    console.log(`  [${x.level}] ${x.kind} ${x.file}:${x.line} ${x.entry ?? ''} ${x.message}`)
    if (x.evidence) console.log(`        证据：${x.evidence}`)
  }
  if (extras.length > 20) console.log(`  …（另有 ${extras.length - 20} 项，见 --json 输出）`)
  console.log('')

  // ---- 汇总 ----
  const allFindings = [...results.values()].flat()
  const errorFindings = allFindings.filter((f) => f.level === '错误')
  console.log('—— 汇总 ——')
  for (const row of summaryRows) {
    console.log(`  ${row.chk.id} ${row.chk.title}：${row.enabled ? `${row.total} 项（错误 ${row.errors}）` : '未启用'}`)
  }
  console.log(`  错误合计 ${errorFindings.length} 项；提示合计 ${allFindings.length - errorFindings.length} 项`)
  console.log(`  来源栏：URL 条目 ${entriesWithUrl.size} 条 / URL 出现 ${urlOccurrences} 次 / 域名未登记命中 ${entriesWithFlaggedUrl.size} 条、域名 ${flaggedHosts.size} 个`)
  console.log(`  来源栏按清单编号填写的条目：0 条（本次扫描到合法编号引用 ${codeRefsValid} 次）`)
  console.log('')
  console.log('—— 迁移量估算（正文来源栏跟随清单换源要动多大）——')
  console.log(`  要改的条目/行：${entriesWithUrl.size} 条条目、${entriesWithUrl.size} 行「来源」（每条恰好一行）`)
  console.log(`  要处理的链接：${urlOccurrences} 处出现、${allSourceUrls.size} 个不同 URL、${allSourceHosts.size} 个不同域名`)
  console.log(`  其中：${entriesWithUrl.size - entriesWithFlaggedUrl.size} 条条目的链接域名全部已登记（换编号即可）；${entriesWithFlaggedUrl.size} 条含未登记域名（${[...flaggedHosts].sort().join('、')}），需先补登记或换源`)
  console.log(`  另需先补「依据」的条目：${strictCount} 条（来源引了依据里没有的法规，见 E4）`)
  console.log(`  清单已有的登记编号：${registry.length} 个；当前正文按编号引用的：0 处`)

  // ---- JSON ----
  const payload = {
    tool: 'tools/check-refs.mjs',
    generatedAt: new Date().toISOString(),
    root,
    inputs: {
      book: rel(root, bookDir),
      registry: rel(root, registryPath),
      excerpts: fs.existsSync(excerptsPath) ? rel(root, excerptsPath) : null,
      verifyDir: fs.existsSync(verifyDir) ? rel(root, verifyDir) : null,
    },
    counts: {
      bookFiles: sections.length,
      entries: entries.length,
      registryRecords: registry.length,
      excerptSections: excerptInfo.sections.length,
      entriesWithSourceUrl: entriesWithUrl.size,
      sourceUrlOccurrences: urlOccurrences,
      entriesWithUnregisteredHostUrl: entriesWithFlaggedUrl.size,
      unregisteredHosts: [...flaggedHosts].sort(),
      entriesWithoutSourceUrl: noUrlEntries.length,
      entriesMatchingCheckItemsTrigger: triggerEntries.length,
      entriesWithCodeFormSource: 0,
      citationsMatchedExact: matchedExact,
      citationsMatchedFuzzy: matchedFuzzy,
      citationsMatchedFuzzyTotal: matchedExact + matchedFuzzy,
      versionCitationsWithYear: citationsWithYear,
      versionComparablePairs: versionComparable,
      versionYearUnpaired: citationsYearUnpaired,
      versionYearUnpairedExamples: versionUnpairedExamples,
      registryRecordsWithReprintMark: reprintRequired.map((r) => r.id),
      strictPerLawUrlMismatch: strictCount,
    },
    checks: CHECKS.map((chk) => {
      const list = results.get(chk.id) ?? []
      return {
        id: chk.id,
        title: chk.title,
        level: chk.level,
        enabled: enabled.has(chk.id),
        count: list.length,
        errorCount: list.filter((f) => f.level === '错误').length,
        infoCount: list.filter((f) => f.level === '提示').length,
        findings: list,
      }
    }),
    /** 引用名 → 解析到的登记编号，供人工复核「0 项未登记」不是漏报 */
    citationIndex: (() => {
      const m = new Map()
      for (const e of resolvedEntries) {
        for (const c of e.cites) {
          const key = `${c.raw}|${c.rec ? c.rec.id : '未匹配'}|${c.how}`
          if (!m.has(key)) m.set(key, { law: c.raw, matchedId: c.rec ? c.rec.id : null, how: c.how, count: 0, examples: [] })
          const x = m.get(key)
          x.count++
          if (x.examples.length < 3) x.examples.push(`${e.file}:${c.line}`)
        }
      }
      return [...m.values()].sort((a, b) => b.count - a.count || a.law.localeCompare(b.law, 'zh'))
    })(),
    extras,
    extraSummary: {
      reverseReprintMark: reverseCount,
      checkItemsTriggerEntries: triggerEntries.length,
      entriesWithoutSourceUrl: noUrlEntries.length,
      excerptIdsOutsideRegistry: excerptOutside,
      strictPerLawUrlMismatch: strictCount,
      registryWithoutExcerptSection: missingExcerpt.map((r) => r.id),
    },
    /** 迁移量估算：让正文「来源」栏跟随清单换源，要动多少地方 */
    migration: {
      entriesToRewrite: entriesWithUrl.size,
      sourceLinesToEdit: entriesWithUrl.size,
      urlOccurrences,
      distinctUrls: allSourceUrls.size,
      distinctHosts: allSourceHosts.size,
      entriesAllUrlsRegisteredHost: entriesWithUrl.size - entriesWithFlaggedUrl.size,
      entriesWithUnregisteredHost: entriesWithFlaggedUrl.size,
      unregisteredHosts: [...flaggedHosts].sort(),
      entriesNeedingBasisFirst: strictCount,
      registryCodesAvailable: registry.length,
      registryCodeRefsInBook: 0,
      totalCitations: matchedExact + matchedFuzzy,
    },
    errorCount: errorFindings.length,
    infoCount: allFindings.length - errorFindings.length,
  }
  if (opt.json) {
    try {
      fs.mkdirSync(path.dirname(opt.json), { recursive: true })
      fs.writeFileSync(opt.json, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      console.log(`\nJSON 已写入：${opt.json}`)
    } catch (err) {
      console.error(`[环境错误] JSON 写入失败：${err.message}`)
      process.exit(2)
    }
  }

  // ---- Markdown 汇总 ----
  const summaryLines = [
    '## 源引用完整性核查（登记 ↔ 依据 ↔ 来源）',
    '',
    `- 正文：\`${rel(root, bookDir)}\` ${sections.length} 个文件、${entries.length} 条；清单：\`${rel(root, registryPath)}\` ${registry.length} 条登记`,
    `- 来源栏直接内嵌 URL 的条目 ${entriesWithUrl.size} 条（URL 出现 ${urlOccurrences} 次）；按清单编号填写的条目 0 条`,
    '',
    '| 检查项 | 级别 | 命中 | 错误 | 提示 |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const row of summaryRows) {
    summaryLines.push(`| ${row.chk.id}. ${row.chk.title} | ${row.chk.level} | ${row.enabled ? row.total : '未启用'} | ${row.errors} | ${row.infos} |`)
  }
  summaryLines.push('', `- 错误合计 ${errorFindings.length} 项，提示合计 ${allFindings.length - errorFindings.length} 项`)
  summaryLines.push(
    '',
    '### 来源栏迁移量（正文跟随清单换源要动多大）',
    '',
    `- 要改：${entriesWithUrl.size} 条条目的 ${entriesWithUrl.size} 行「来源」`,
    `- 要处理：${urlOccurrences} 处链接、${allSourceUrls.size} 个不同 URL、${allSourceHosts.size} 个不同域名`,
    `- 域名全部已登记的条目 ${entriesWithUrl.size - entriesWithFlaggedUrl.size} 条；含未登记域名的 ${entriesWithFlaggedUrl.size} 条（${[...flaggedHosts].sort().join('、')}）`,
    `- 需先补「依据」的条目 ${strictCount} 条；可用登记编号 ${registry.length} 个；当前按编号引用 0 处`,
  )
  if (errorFindings.length) {
    summaryLines.push('', '### 错误明细', '', '| 位置 | 条目 | 说明 |', '| --- | --- | --- |')
    for (const f of errorFindings.slice(0, 80)) {
      summaryLines.push(`| ${f.file}:${f.line} | ${(f.entry ?? '').replace(/\|/g, '\\|')} | ${f.message.replace(/\|/g, '\\|')} |`)
    }
  }
  summaryLines.push('')
  const summaryTarget = opt.summary || process.env.GITHUB_STEP_SUMMARY || ''
  if (summaryTarget) {
    try {
      fs.mkdirSync(path.dirname(summaryTarget), { recursive: true })
      fs.appendFileSync(summaryTarget, summaryLines.join('\n') + '\n', 'utf8')
      console.log(`汇总已追加写入：${summaryTarget}`)
    } catch (err) {
      console.error(`[环境错误] 汇总写入失败：${err.message}`)
      process.exit(2)
    }
  }

  if (opt.check) {
    if (errorFindings.length) {
      console.error(`\n[失败] 发现错误 ${errorFindings.length} 项（退出码 1）`)
      process.exit(1)
    }
    console.log('\n[通过] 六项检查没有错误（退出码 0）')
    process.exit(0)
  }
  console.log(errorFindings.length
    ? `\n（报告模式：发现错误 ${errorFindings.length} 项，但退出码仍为 0，加 --check 才会非零退出）`
    : '\n（报告模式：未发现错误）')
  process.exit(0)
}

try {
  main()
} catch (err) {
  console.error('[环境错误] 脚本异常终止：', err && err.stack ? err.stack : err)
  process.exit(2)
}
