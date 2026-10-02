#!/usr/bin/env node
/**
 * lib/条目规范.mjs —— 条目规范的程序化契约
 *
 * 这是「唯一格式权威」docs/条目规范.md 的代码映射，供 tools/ 下的新建、看板、
 * 改节号三个工具共用。**不要在这里自创口径**：任何常量或规则都必须能在
 * docs/条目规范.md 或 tools/check-items.mjs 里找到出处，注释里写明是哪一条。
 *
 * 与 check-items.mjs 的分工：
 *   - check-items.mjs 是**判定**：给已有条目判错误/警告/提示，是对外门禁；
 *   - 本模块是**构造**：给工具提供字段模板、解析结果与写回位置，让新条目一出生
 *     就符合规范。两者若在某条规则上不一致，以 docs/条目规范.md 为准，并改这里。
 *
 * 只使用 Node 24 内置模块，零依赖。
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// 常量：出处见 docs/条目规范.md
// ---------------------------------------------------------------------------

/** 条目必备字段，顺序即规范里的字段顺序（规范「条目格式」：顺序不可调换）。 */
export const REQUIRED_FIELDS = Object.freeze([
  '适用', '成本', '收益', '说人话', '依据', '效力位阶', '主张强度',
  '举证难度', '地域', '时效', '来源', '核对日期', '备注',
])

/** 三套独立标注的取值白名单（规范「效力位阶只有八种取值」等节）。 */
export const ENUMS = Object.freeze({
  效力位阶: Object.freeze(['法律', '行政法规', '部门规章', '地方性法规', '司法解释', '规范性文件', '地方口径', '无明文依据']),
  主张强度: Object.freeze(['可主张', '可推定', '倡导性']),
  举证难度: Object.freeze(['易', '中', '难']),
})

/** 成本标签五项顺序与取值（规范「成本标签」一节）。 */
export const COST_TAG_ORDER = Object.freeze(['钱', '时间', '毅力', '收益', '口径'])
export const COST_TAG_ENUMS = Object.freeze({
  钱: Object.freeze(['0', '少', '多']),
  时间: Object.freeze(['少', '中', '多']),
  毅力: Object.freeze(['否', '些', '是']),
  收益: Object.freeze(['大', '中', '小']),
  口径: Object.freeze(['金钱', '时间', '自由', '健康']),
})

/** 效力位阶为「无明文依据」时，主张强度只能是「倡导性」（规范强制联动）。 */
export const NO_LEGAL_BASIS = '无明文依据'
export const NO_BASIS_ALLOWED_CLAIM = Object.freeze(['倡导性'])

/** 未定稿标记：中间态，不是可发布状态（规范「『待核实』是中间态」一节）。 */
export const PENDING_MARK = '待核实'

/** 核对日期超过这么多天即报「待复核」（仓库约定值，非法规要求）。 */
export const STALE_DAYS = 180

/**
 * 每个字段的占位值。**新条目一律以「待核实」起手**，绝不留空——空值在
 * check-items.mjs 里是错误，而「待核实」是有意义的中间态，能一路带到校验通过
 * 之前，提醒作者这里还没追到官方原文。
 *
 * `说人话` 与 `核对日期` 除外：前者是正文，后者落盘当天就填。
 */
export const PLACEHOLDER = Object.freeze({
  适用: '待核实——谁在什么条件下能用上这一条（写明身份、情形、前提，不写「所有人」）',
  成本: '待核实——分钱和时间两项写，能写数额区间就写，写不出就写口径',
  收益: '待核实——这一条能换回什么，金额、期限、比例都要写出来',
  说人话: '待核实——把成本和收益翻成一句没有法律训练的人一遍能读懂的话',
  依据: '待核实——法律文件全称 + 条款号 + 版本与施行日期',
  效力位阶: '待核实',
  主张强度: '待核实',
  举证难度: '待核实',
  地域: '待核实——全国 / 或写明地方口径差异',
  时效: '待核实——程序时效、起算点、不适用时效的例外，三层都要写',
  来源: '待核实——官方全文链接，或「见 sources/法规清单.md 编号 X」',
  核对日期: '',
  备注: '待核实——例外、争议、地方差异、常见误解、要提防的坑',
})

/** 成本标签的占位值。口径默认金钱，其余按最保守取。 */
export const PLACEHOLDER_COST_TAG = Object.freeze({
  钱: '0', 时间: '少', 毅力: '否', 收益: '中', 口径: '金钱',
})

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

/** 今天（东八区）的 YYYY-MM-DD。核对日期一律按东八区落盘。 */
export function today(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  return parts // en-CA 的格式即 YYYY-MM-DD
}

/** 把 YYYY-MM-DD 转成距今天数；非法日期返回 null。与 check-items.mjs 同算法。 */
export function daysSince(yyyymmdd, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(yyyymmdd))
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  const [ny, nm, nd] = today(now).split('-').map(Number)
  return Math.round((Date.UTC(ny, nm - 1, nd) - t) / 86400000)
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

/** 去掉行内 markdown 标记，得到适合放 front matter 与 JSON 的纯文本。 */
export function stripInline(s) {
  return String(s)
    .replace(/<((?:https?:\/\/)[^>\s]+)>/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** YAML 双引号标量：只做必要转义，避免破坏中文。与 build-site.mjs 同实现。 */
export function yamlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}

/** 生成安全的目录/文件名：保留中文，去掉文件系统不便的字符。与 build-site.mjs 同实现。 */
export function safeSlug(s) {
  return String(s).replace(/[\\/:*?"<>|#%]/g, '').replace(/\s+/g, '-').trim()
}

/** 解析一行成本标签注释；返回 null 表示这行不是成本标签。 */
export function parseCostTag(line) {
  const m = /<!--\s*成本标签\s*[:：]\s*(.+?)\s*-->/.exec(line)
  if (!m) return null
  const tag = {}
  for (const pair of m[1].split(/\s+/)) {
    const kv = /^([^=＝]+)[=＝](.+)$/.exec(pair)
    if (kv) tag[kv[1].trim()] = kv[2].trim()
  }
  return Object.keys(tag).length ? tag : null
}

/** 把成本标签对象序列化成规范行（写回正文用）。 */
export function costTagLine(tag) {
  const parts = COST_TAG_ORDER.map((k) => `${k}=${tag[k] ?? PLACEHOLDER_COST_TAG[k]}`)
  return `<!-- 成本标签: ${parts.join(' ')} -->`
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

const HEADING_RE = /^#{1,6}\s*(.*)$/
const ENTRY_HEADING_RE = /^###\s+(\d{1,3})\.(\d{1,3})\s+(.+?)\s*$/
const FIELD_RE = /^-\s*([^：:]{1,24})[：:]\s*(.*)$/

/** 解析一个条目的字段行；返回 [{name, value, line}]。line 为文件内 1 基行号。 */
export function parseEntryFields(lines) {
  const fields = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = FIELD_RE.exec(line.trim())
    if (!m) continue
    const name = m[1].trim()
    if (!REQUIRED_FIELDS.includes(name)) continue
    fields.push({ name, value: m[2].trim(), line: i + 1 })
  }
  return fields
}

/**
 * 读一个正文文件并解析成结构。**不改动文件**。
 *
 * 返回：
 *   {
 *     path, rel, text, lines,
 *     h1: {text, line} | null,             // 顶层 # 标题（节名）
 *     section: number | null,              // 文件名节号（01-… → 1）
 *     title: string,                       // 文件名节名
 *     entries: [Entry],                    // 三级标题条目，按文件顺序
 *   }
 *
 * Entry：
 *   { number, title, titleLine, startLine, endLine, fields, 成本标签, 成本标签行 }
 *   - startLine/endLine 为条目块覆盖的行区间（1 基，含标题行）
 *   - fields 是 [{name, value, line}]，line 是文件内绝对行号
 */
export function parseSectionFile(path, rel = path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/)

  const base = rel.split(/[\\/]/).pop()
  const fm = /^(\d+)\s*[-—－]\s*(.+)\.md$/.exec(base)
  const section = fm ? Number(fm[1]) : null
  const title = fm ? fm[2].trim() : ''

  let h1 = null
  for (let i = 0; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i])
    if (m) { h1 = { text: stripInline(m[1]), line: i + 1 }; break }
  }

  const marks = []
  for (let i = 0; i < lines.length; i++) {
    const m = ENTRY_HEADING_RE.exec(lines[i])
    if (!m) continue
    marks.push({ index: i, sectionNumber: Number(m[1]), number: Number(m[2]), title: stripInline(m[3]) })
  }

  const entries = []
  for (let k = 0; k < marks.length; k++) {
    const cur = marks[k]
    const endIdx = k + 1 < marks.length ? marks[k + 1].index : lines.length
    const body = lines.slice(cur.index + 1, endIdx)
    const offset = cur.index + 2 // 1 基行号 = 索引 + 1，body[0] 对应 cur.index+2
    const fields = parseEntryFields(body).map((f) => ({ ...f, line: f.line + offset - 1 }))

    let 成本标签 = null
    let 成本标签行 = null
    for (let i = 0; i < body.length; i++) {
      const tag = parseCostTag(body[i])
      if (tag) { 成本标签 = tag; 成本标签行 = offset + i; break }
    }

    entries.push({
      sectionNumber: cur.sectionNumber,
      number: cur.number,
      title: cur.title,
      titleLine: cur.index + 1,
      startLine: cur.index + 1,
      endLine: endIdx, // 含尾部空行/分隔线，写回时按此区间替换
      fields,
      成本标签,
      成本标签行,
    })
  }

  return { path, rel, text, lines, h1, section, title, entries }
}

/** 列出 book/ 下的正文文件（按文件名排序，节号自然有序）。 */
export function listBookFiles(bookDir) {
  return readdirSync(bookDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => join(bookDir, f))
}

/** 取某字段的值（首个匹配）；不存在返回 ''。 */
export function fieldOf(entry, name) {
  const f = entry.fields.find((x) => x.name === name)
  return f ? f.value : ''
}

/** 取枚举字段的主值：允许「中——工资流水…」「法律 + 司法解释」的写法。 */
export function enumHead(raw, multi = false) {
  const cleaned = String(raw).replace(/\*\*|__|`/g, '').replace(/^[*_\s]+|[*_\s]+$/g, '').trim()
  const head = cleaned.split(/——|—|–|:|：|（|\(|；|;/)[0]
  if (!multi) return head.trim()
  return head.split(/\s*[+＋、,，/]\s*/).map((s) => s.trim()).filter(Boolean)
}

/** 从「备注」等文本里抽出所有 URL。 */
export function urlsIn(text) {
  const found = String(text).match(/https?:\/\/[^\s<>"'）)】\]]+/gi) || []
  return found.map((u) => u.replace(/[.,;。，；]+$/, ''))
}

// ---------------------------------------------------------------------------
// 构造：新条目模板
// ---------------------------------------------------------------------------

/**
 * 生成一个合规的条目文本块（含成本标签行）。**字段顺序、字段名、占位取值
 * 全部按规范**，所以生成物天然能过 check-items.mjs 的结构校验（会报「未定稿」
 * 警告，那是应有的：占位值就是「还没查完」的意思）。
 *
 * 三级标题必须写成「节号.条号 标题」——check-items.mjs 与 build-site.mjs 都按
 * `/^###\s+(\d+)\.(\d+)\s+/` 解析，只写条号会整条解析不到（静默丢条目）。
 *
 * 「说人话」的处理要贴合 check-items.mjs 的实际判据：那一行**必须在**（缺行报
 * 「缺字段：说人话」），但**值为空不算错**。所以这里始终渲染 `- 说人话：` 这一行，
 * 有内容就填进去；预检 lintEntry 对它的空值豁免。两处必须成对，缺一会误红。
 *
 * @param {{sectionNumber:number, number:number, title:string}} entry
 * @param {{todayOverride?:string, 说人话?:string}} [opts]
 * @returns {string} 形如「### 16.1 标题\n\n- 适用：…\n…\n<!-- 成本标签: … -->\n」
 */
export function renderEntry(entry, opts = {}) {
  const heading = entry.sectionNumber === undefined || entry.sectionNumber === null
    ? `${entry.number}`
    : `${entry.sectionNumber}.${entry.number}`
  const out = [`### ${heading} ${entry.title}`, '']
  for (const name of REQUIRED_FIELDS) {
    let value = PLACEHOLDER[name]
    if (name === '核对日期') value = opts.todayOverride || today()
    if (name === '说人话' && opts['说人话']) value = String(opts['说人话']).trim()
    out.push(`- ${name}：${value}`)
  }
  out.push(costTagLine(PLACEHOLDER_COST_TAG))
  out.push('')
  return out.join('\n')
}

/** 生成一个合规的节文件文本（一级标题 + 读法提示 + 首个条目）。 */
export function renderSection(section, firstEntry, opts = {}) {
  const lines = [
    `# ${section.number}. ${section.title}`,
    '',
    `本节回答：待核实——用一句话写清本节覆盖哪些问题。`,
    '',
    `节内条目按实际可用性从高到低排。**本条目的法律依据以 ${opts.todayOverride || today()} 核对日为准**，引用条文均取自官方全文页（信源见 \`sources/法规清单.md\`）。`,
    '',
    renderEntry({ ...firstEntry, sectionNumber: section.number }, opts).trimEnd(),
    '',
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 校验：写回前的同规则预检
// ---------------------------------------------------------------------------

/**
 * 对一个条目做规范预检，返回 issue 列表 [{level:'错误'|'警告'|'提示', message}]。
 * 判据与 check-items.mjs 一致但更窄——只做**新条目落盘前必然会撞上**的那些项，
 * 真正的门禁仍然是 `node tools/check-items.mjs --check`。
 */
export function lintEntry(entry) {
  const issues = []
  const seen = new Set()
  for (const f of entry.fields) {
    if (seen.has(f.name)) issues.push({ level: '错误', message: `字段重复：${f.name}` })
    seen.add(f.name)
  }
  const missing = REQUIRED_FIELDS.filter((n) => !seen.has(n))
  if (missing.length) issues.push({ level: '错误', message: `缺少字段：${missing.join('、')}` })

  const known = entry.fields.map((f) => f.name)
  if (entry.fields.length === REQUIRED_FIELDS.length) {
    for (let i = 0; i < REQUIRED_FIELDS.length; i++) {
      if (known[i] !== REQUIRED_FIELDS[i]) {
        issues.push({ level: '错误', message: `字段顺序不符：第 ${i + 1} 位应为「${REQUIRED_FIELDS[i]}」，实际「${known[i]}」` })
        break
      }
    }
  }

  for (const f of entry.fields) {
    // 注意：「说人话」没有例外——check-items.mjs 的空值检查是通用的，空值一律判错
    // （实测确认：`- 说人话：` 空行会被报为「字段『说人话』为空」）。所以模板必须给
    // 它一个「待核实」占位，而不是留空。这条是本文件与门禁对齐的关键，别改成豁免。
    if (f.value.trim() === '') issues.push({ level: '错误', message: `字段「${f.name}」为空` })
  }

  for (const [name, allowed] of Object.entries(ENUMS)) {
    const raw = fieldOf(entry, name)
    if (!raw || raw.includes(PENDING_MARK)) continue
    const tokens = enumHead(raw, name === '效力位阶')
    for (const t of tokens) {
      if (!allowed.includes(t)) issues.push({ level: '错误', message: `「${name}」取值非法：「${t}」（允许：${allowed.join(' / ')}）` })
    }
  }

  const 效力 = fieldOf(entry, '效力位阶')
  const 主张 = enumHead(fieldOf(entry, '主张强度'))
  if (效力.includes(NO_LEGAL_BASIS) && 主张 && !NO_BASIS_ALLOWED_CLAIM.includes(主张)) {
    issues.push({ level: '错误', message: `效力位阶为「${NO_LEGAL_BASIS}」时主张强度只能是「倡导性」，当前「${主张}」` })
  }

  const 定稿 = REQUIRED_FIELDS.filter((n) => fieldOf(entry, n).includes(PENDING_MARK))
  if (定稿.length) {
    issues.push({
      level: '警告',
      message: `未定稿：${定稿.join('、')} 仍为「待核实」——这类条目不得随版本发布，结项前必须追到原文或改写为「无明文依据 + 倡导性」`,
    })
  }

  if (!entry.成本标签) {
    issues.push({ level: '错误', message: '缺少成本标签注释' })
  } else {
    for (const k of COST_TAG_ORDER) {
      if (!(k in entry.成本标签)) issues.push({ level: '错误', message: `成本标签缺少项：${k}` })
      else if (!COST_TAG_ENUMS[k].includes(entry.成本标签[k])) {
        issues.push({ level: '错误', message: `成本标签「${k}」取值非法：「${entry.成本标签[k]}」` })
      }
    }
  }

  const 核对日期 = fieldOf(entry, '核对日期').replace(/\*\*|`/g, '').trim()
  if (核对日期) {
    const days = daysSince(核对日期)
    if (days === null) issues.push({ level: '错误', message: `「核对日期」格式非法：${核对日期}` })
    else if (days > STALE_DAYS) issues.push({ level: '错误', message: `「核对日期」距今 ${days} 天，超过 ${STALE_DAYS} 天，报为「待复核」`, kind: '待复核' })
  }

  return issues
}

/** 把 Entry 转成 check-items.mjs 那样的 where 标签，便于打印。 */
export function entryLabel(entry) {
  return `${entry.sectionNumber}.${entry.number} ${entry.title}`
}
// ---------------------------------------------------------------------------
// 写回
// ---------------------------------------------------------------------------

/** 写文件，强制 LF 与 UTF-8，末尾补一个换行。 */
export function writeText(path, text) {
  const normalized = text.replace(/\r\n/g, '\n')
  writeFileSync(path, normalized.endsWith('\n') ? normalized : `${normalized}\n`, 'utf8')
}
