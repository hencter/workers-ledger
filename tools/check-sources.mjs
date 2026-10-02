#!/usr/bin/env node
/**
 * check-sources.mjs —— 法规时效与链接监控
 *
 * 读取 sources/法规清单.md，抓取每份法规的官方页面，判定三类问题：
 *   ① 链接失效 —— 只认 404、410，以及 DOI 在 doi.org 登记处查无此号；
 *   ② 版本不一致 —— 页面出现的修正/施行/通过日期比注册表记录更新；
 *   ③ 注册表缺少必填字段。
 *
 * 分类原则（决定工作流会不会天天红，务必遵守）：
 *   - gov.cn 系站点挡境外机房 IP，超时、连不上、5xx 一律进「没连上」一档，不判失效；
 *   - 老政府站 TLS 握手不被 Node 接受，单独一档「握手不兼容」；
 *   - 其余 4xx（401/403/429 等）进「待人工确认」，不判失效；
 *   - 只有 404、410、DOI 登记处查无此号，才算「确定失效」。
 *
 * 只使用 Node 24 内置模块，无外部依赖。
 *
 * 用法：
 *   node tools/check-sources.mjs                    联网全量检查（报告模式）
 *   node tools/check-sources.mjs --check            联网全量检查，硬问题退出 1
 *   node tools/check-sources.mjs --offline          不联网，只校验注册表字段
 *   node tools/check-sources.mjs --root <目录>       指定仓库根目录
 *   node tools/check-sources.mjs --list <文件>       指定法规清单路径
 *   node tools/check-sources.mjs --timeout <毫秒>    单次请求超时（默认 15000）
 *   node tools/check-sources.mjs --concurrency <数>  并发数（默认 4）
 *   node tools/check-sources.mjs --filter <子串>     只检查名称含该子串的记录
 *   node tools/check-sources.mjs --doi-api <前缀>    DOI 登记处前缀（默认 https://doi.org）
 *   node tools/check-sources.mjs --summary <文件>    汇总追加写入该文件
 *
 * 退出码：
 *   0  通过（或报告模式下已完成报告）
 *   1  发现「确定失效」或「版本不一致」（只在 --check 模式下出现）
 *   2  运行环境错误：法规清单不存在或读不了、清单里一条记录都没有
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 官方站点多半按浏览器 UA 放行，用普通 UA 会被 403 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 抓下来只看前这么多字符，避免整站首页把内存吃光 */
const MAX_BODY = 400000

/** 注册表字段别名：列名或键名对上任一个即算命中 */
const FIELD_ALIASES = {
  id: ['编号', '序号'],
  name: ['法规名称', '文件全称', '名称', '标题', '法规', '文件名称', '全称'],
  link: ['官方链接', '官方全文URL', '链接', '来源链接', '来源', '官方来源', 'url', '网址', '地址'],
  version: ['现行版本', '版本', '版本信息', '版本与施行日期', '修正日期', '施行日期', '发布日期', '版本日期'],
  checked: ['核验状态', '核对日期', '复核日期', '最近核对', '核对', '核验', '核实'],
}

/** 列名带括号说明时（例如「现行版本（修正日期 + 施行日期）」「官方全文 URL」），按子串兜底匹配 */
const ALIAS_SUBSTR = [
  { key: 'id', words: ['编号', '序号'] },
  { key: 'name', words: ['文件全称', '法规全称', '全称', '名称', '标题'] },
  { key: 'link', words: ['url', '链接', '网址', '官方全文', '地址'] },
  { key: 'version', words: ['现行版本', '版本', '修正日期', '施行日期', '发布日期'] },
  { key: 'checked', words: ['核验状态', '核对日期', '复核日期', '核验', '核对', '核实'] },
]

const REQUIRED_RECORD_FIELDS = [
  { key: 'name', label: '文件全称' },
  { key: 'link', label: '官方全文 URL' },
  { key: 'version', label: '现行版本（修正日期 + 施行日期）' },
  { key: 'checked', label: '核验状态／核对日期' },
]

const BUCKET = {
  OK: '正常',
  DEAD: '确定失效', // 硬
  VERSION: '版本不一致', // 硬
  VERSION_MAYBE: '疑似版本不一致', // 软
  UNREACHABLE: '没连上', // 软
  TLS: '握手不兼容', // 软
  MANUAL: '待人工确认', // 软
  MISSING_FIELD: '注册表缺字段', // 软
  OFFLINE: '未联网',
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function normalizeKey(s) {
  return String(s)
    .replace(/[*_`\s　]/g, '')
    .replace(/[：:]/g, '')
    .toLowerCase()
}

function buildAliasMap() {
  const map = new Map()
  for (const [canon, list] of Object.entries(FIELD_ALIASES)) {
    for (const a of list) if (!map.has(normalizeKey(a))) map.set(normalizeKey(a), canon)
  }
  return map
}
const ALIAS_MAP = buildAliasMap()

/** 把一个列名／键名判定成规范字段名：先精确别名，再按子串兜底 */
function canonField(header) {
  const n = normalizeKey(header)
  if (ALIAS_MAP.has(n)) return ALIAS_MAP.get(n)
  for (const { key, words } of ALIAS_SUBSTR) {
    if (words.some((w) => n.includes(normalizeKey(w)))) return key
  }
  return null
}

function stripTitle(s) {
  return String(s).replace(/[《》「」【】\s]/g, '')
}

/** 从单元格里抠出所有网址（一行可能登记正本 + 转载页 + 行政法规库多个链接） */
function urlsIn(text) {
  const found = String(text).match(/https?:\/\/[^\s<>"'）)】\]]+/gi) || []
  // 去掉正文标记残留与句末标点（例如 <url>**、url。、url,）
  return found.map((u) => u.replace(/[*_`"'.,;。，；]+$/, ''))
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 记录显示名：有编号就带上，方便对着信源表找 */
function labelOf(rec) {
  const id = (rec.raw.id || '').trim()
  const name = (rec.raw.name || `（第 ${rec.line} 行无名称）`).trim()
  return id ? `${id} ${name}` : name
}

// ---------------------------------------------------------------------------
// 注册表解析：兼容 Markdown 表格与「标题 + 键值列表」两种写法
// ---------------------------------------------------------------------------

function splitRow(line) {
  const t = line.trim()
  const inner = t.replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map((c) => c.trim())
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))
}

function parseTable(text, startingLine) {
  const lines = text.split(/\r\n|\n|\r/)
  const records = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim().startsWith('|')) {
      i++
      continue
    }
    const start = i
    const rows = []
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      rows.push({ line: i + 1, cells: splitRow(lines[i]) })
      i++
    }
    if (rows.length < 2) continue
    const header = rows[0].cells
    const canonCols = header.map((h) => canonField(h))
    const hasName = canonCols.includes('name')
    const hasOther = canonCols.includes('link') || canonCols.includes('version')
    if (!hasName || !hasOther) continue
    for (const row of rows.slice(1)) {
      if (isSeparatorRow(row.cells)) continue
      if (row.cells.every((c) => c === '')) continue
      const rec = { line: row.line, raw: {}, source: `表格（表头在第 ${start + 1} 行）` }
      row.cells.forEach((cell, idx) => {
        const canon = canonCols[idx]
        if (!canon) return
        if (rec.raw[canon] === undefined) rec.raw[canon] = cell
      })
      records.push(rec)
    }
  }
  return records
}

function parseBlocks(text) {
  const lines = text.split(/\r\n|\n|\r/)
  const records = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const h = /^(#{2,4})\s*(.+?)\s*$/.exec(line)
    if (h) {
      if (cur) records.push(cur)
      cur = { line: i + 1, raw: { name: h[2].trim() }, source: '分条（键值列表）' }
      continue
    }
    if (!cur) continue
    const m = /^\s*[-*+]?\s*([^：:]{1,24})[：:]\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const canon = canonField(m[1])
    if (!canon) continue
    if (cur.raw[canon] === undefined) cur.raw[canon] = m[2]
  }
  if (cur) records.push(cur)
  return records.filter((r) => Object.keys(r.raw).length > 1)
}

function parseRegistry(text) {
  const tableRecs = parseTable(text, 1)
  if (tableRecs.length > 0) return { shape: '表格', records: tableRecs }
  const blockRecs = parseBlocks(text)
  if (blockRecs.length > 0) return { shape: '分条', records: blockRecs }
  return { shape: '未识别', records: [] }
}

// ---------------------------------------------------------------------------
// 日期解析与版本比对
// ---------------------------------------------------------------------------

const DATE_RE =
  /(\d{4})-(\d{1,2})-(\d{1,2})|(\d{4})\/(\d{1,2})\/(\d{1,2})|(\d{4})\.(\d{1,2})\.(\d{1,2})|(\d{4})年(\d{1,2})月(\d{1,2})日|(\d{4})年(\d{1,2})月|(\d{4})年/g

/**
 * 版本关键词只收「修正」「施行」两类——这也是任务书要求的比对范围。
 *
 * 为什么不算「通过/公布/发布」：实测发现政府网站页面自带元数据（「发布日期：2008年09月19日」），
 * 那是网页的发布时间，不是法规的公布日期，与注册表记录相差一两天很常见。
 * 把它当法规日期会直接把正常条目判成「版本不一致」——首轮真实联网检查 15 条里误报 7 条，
 * 全部由这一类元数据引起。宁可少报，也不能让工作流天天红。
 */
const KIND_RES = [
  { kind: '修正', re: /修正|修订|修改|修正案/g },
  { kind: '施行', re: /施行|实施|生效/g },
]

function pad2(n) {
  return String(n).padStart(2, '0')
}

function extractDates(text) {
  const out = []
  DATE_RE.lastIndex = 0
  let m
  while ((m = DATE_RE.exec(text)) !== null) {
    let y = 0
    let mo = 1
    let d = 1
    if (m[1]) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    else if (m[4]) [y, mo, d] = [Number(m[4]), Number(m[5]), Number(m[6])]
    else if (m[7]) [y, mo, d] = [Number(m[7]), Number(m[8]), Number(m[9])]
    else if (m[10]) [y, mo, d] = [Number(m[10]), Number(m[11]), Number(m[12])]
    else if (m[13]) [y, mo, d] = [Number(m[13]), Number(m[14]), 1]
    else if (m[16]) [y, mo, d] = [Number(m[16]), 1, 1]
    if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) continue
    out.push({ idx: m.index, len: m[0].length, date: `${y}-${pad2(mo)}-${pad2(d)}`, text: m[0] })
  }
  return out
}

/**
 * 给每个日期贴上「修正/施行」标签。
 *
 * 规则（按词序配对，不能取「最近的关键词」）：
 *   1. 优先配日期右侧的第一个关键词，且两者之间不得再夹着别的日期——
 *      「2012-12-28 修正，2013-07-01 施行」里，「修正」不能跨过 2013-07-01 去配；
 *      「修订后自 2011-01-01 施行」里，也必须配右侧的「施行」而不是左侧的「修订」。
 *   2. 右侧找不到关键词时，才回头配左侧（覆盖「修正于 2012 年」这类写法）。
 */
function typedDates(text) {
  const dates = extractDates(text)
  const marks = []
  for (const { kind, re } of KIND_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) marks.push({ idx: m.index, len: m[0].length, kind, used: false })
  }
  const tokens = [
    ...dates.map((d) => ({ idx: d.idx, len: d.len, type: 'date', ref: d })),
    ...marks.map((k) => ({ idx: k.idx, len: k.len, type: 'mark', ref: k })),
  ].sort((a, b) => a.idx - b.idx || b.len - a.len)

  const MAX_GAP = 20
  let openDate = null
  for (const t of tokens) {
    if (t.type === 'date') {
      openDate = { ref: t.ref, end: t.idx + t.len, assigned: false }
    } else if (openDate && !openDate.assigned) {
      const gap = t.idx - openDate.end
      if (gap >= 0 && gap <= MAX_GAP) {
        openDate.ref.kind = t.ref.kind
        t.ref.used = true
        openDate.assigned = true
      }
    }
  }

  // 兜底：关键词在日期左侧的写法
  for (const d of dates) {
    if (d.kind) continue
    let best = null
    for (const k of marks) {
      if (k.used) continue
      const gap = d.idx - (k.idx + k.len)
      if (gap >= 0 && gap <= MAX_GAP && (!best || k.idx > best.idx)) best = k
    }
    if (best) {
      d.kind = best.kind
      best.used = true
    }
  }

  return dates.map((d) => ({ ...d, kind: d.kind || '其他' }))
}

function maxDate(list) {
  let best = null
  for (const x of list) if (!best || x.date > best) best = x.date
  return best
}

// ---------------------------------------------------------------------------
// 抓取与分类
// ---------------------------------------------------------------------------

function classifyThrown(err) {
  const msg = [
    err?.name || '',
    err?.message || '',
    err?.code || '',
    err?.cause?.code || '',
    err?.cause?.message || '',
    err?.cause?.errno || '',
  ].join(' ')
  if (/ssl|tls|handshake|certificate|wrong version number|self.signed|altname|eproto/i.test(msg)) {
    return { bucket: BUCKET.TLS, detail: 'TLS 握手失败：' + msg.trim().slice(0, 160) }
  }
  if (/timeout|timed out|abort/i.test(msg)) {
    return { bucket: BUCKET.UNREACHABLE, detail: '请求超时：' + msg.trim().slice(0, 160) }
  }
  return { bucket: BUCKET.UNREACHABLE, detail: '连接失败：' + msg.trim().slice(0, 160) }
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  let text = ''
  try {
    text = (await res.text()).slice(0, MAX_BODY)
  } catch {
    text = ''
  }
  return { status: res.status, ok: res.ok, finalUrl: res.url, text }
}

const DOI_RE = /10\.\d{4,9}\/[^\s"'<>()（）【】\]]+/

function extractDoi(link) {
  const m = DOI_RE.exec(link || '')
  return m ? m[0].replace(/[.,;。，；]+$/, '') : null
}

/**
 * DOI 只查 doi.org 登记处，不查出版商页面：
 * 登记处返回 responseCode 100 表示号已登记；404 或 responseCode 200 表示查无此号。
 */
async function checkDoi(doi, opt) {
  // 斜杠是 DOI 的固有结构（10.xxxx/后缀），整串编码成 %2F 会让登记处找不到号；
  // 只逐段转义，保留斜杠。
  const doiPath = doi.split('/').map(encodeURIComponent).join('/')
  const url = `${opt.doiApi.replace(/\/+$/, '')}/api/handles/${doiPath}`
  let res
  try {
    res = await fetchText(url, opt.timeout)
  } catch (err) {
    return classifyThrown(err)
  }
  let body = {}
  try {
    body = JSON.parse(res.text)
  } catch {
    body = {}
  }
  const code = body.responseCode
  if (code === 100) return { bucket: BUCKET.OK, detail: `DOI 登记处已登记：${doi}` }
  if (code === 200) return { bucket: BUCKET.DEAD, detail: `DOI 登记处查无此号：${doi}（登记处 responseCode=200）` }
  if (res.status === 404) return { bucket: BUCKET.DEAD, detail: `DOI 登记处 HTTP 404，号未登记：${doi}` }
  if (res.status >= 500) return { bucket: BUCKET.UNREACHABLE, detail: `DOI 登记处 HTTP ${res.status}：${url}` }
  return { bucket: BUCKET.MANUAL, detail: `DOI 登记处返回无法判定：HTTP ${res.status}，responseCode=${code}` }
}

function compareVersions(rec, normPage, lawKey, evidenceOut) {
  const regRaw = stripTitle(rec.raw.version || '')
  const regTyped = typedDates(regRaw)
  const regByName = new Map()
  for (const d of regTyped) {
    if (!regByName.has(d.kind)) regByName.set(d.kind, [])
    regByName.get(d.kind).push(d)
  }
  const pageTyped = typedDates(normPage)
  const pageByName = new Map()
  for (const d of pageTyped) {
    if (!pageByName.has(d.kind)) pageByName.set(d.kind, [])
    pageByName.get(d.kind).push(d)
  }

  const nearLaw = (d) => {
    if (!lawKey) return false
    const from = Math.max(0, d.idx - 150)
    const to = Math.min(normPage.length, d.idx + d.len + 150)
    return normPage.slice(from, to).includes(lawKey)
  }
  const snippet = (d) => normPage.slice(Math.max(0, d.idx - 40), d.idx + d.len + 40)

  const findings = []
  for (const kind of ['修正', '施行']) {
    const regList = regByName.get(kind) || []
    if (regList.length === 0) continue
    const regMax = maxDate(regList)
    const pageList = (pageByName.get(kind) || []).filter((d) => d.date > regMax)
    if (pageList.length === 0) continue
    const hard = pageList.filter(nearLaw)
    if (hard.length) {
      const d = hard.reduce((a, b) => (a.date > b.date ? a : b))
      evidenceOut.push(`页面「${kind}」日期 ${d.date} 晚于注册表 ${regMax}；上下文：…${snippet(d)}…`)
      findings.push({
        bucket: BUCKET.VERSION,
        detail: `页面出现更新的「${kind}」版本：页面 ${d.date} > 注册表 ${regMax}`,
      })
    } else {
      const d = pageList.reduce((a, b) => (a.date > b.date ? a : b))
      evidenceOut.push(`页面「${kind}」日期 ${d.date} 晚于注册表 ${regMax}，但该日期附近未出现法规名称；上下文：…${snippet(d)}…`)
      findings.push({
        bucket: BUCKET.VERSION_MAYBE,
        detail: `疑似有更新的「${kind}」版本：页面 ${d.date} > 注册表 ${regMax}（日期附近未见法规名称，需人工核对）`,
      })
    }
  }

  if (findings.length === 0 && regTyped.length === 0) {
    const regAll = maxDate(extractDates(regRaw))
    const pageAll = pageTyped.filter((d) => d.kind !== '其他' && nearLaw(d))
    if (regAll && pageAll.length) {
      const d = pageAll.reduce((a, b) => (a.date > b.date ? a : b))
      if (d.date > regAll) {
        evidenceOut.push(`注册表「版本」栏只写了 ${regAll} 未标类别；页面附近出现 ${d.date}；上下文：…${snippet(d)}…`)
        findings.push({
          bucket: BUCKET.VERSION_MAYBE,
          detail: `注册表「版本」栏无类别标注，页面出现更晚日期 ${d.date}（注册表 ${regAll}），需人工核对`,
        })
      }
    }
  }
  return findings
}

/** 结论强弱排序：数字越大越严重，一条记录按最严重的那个链接定性 */
const BUCKET_RANK = {
  [BUCKET.OK]: 0,
  [BUCKET.OFFLINE]: 0,
  [BUCKET.MISSING_FIELD]: 1,
  [BUCKET.MANUAL]: 2,
  [BUCKET.UNREACHABLE]: 3,
  [BUCKET.TLS]: 4,
  [BUCKET.VERSION_MAYBE]: 5,
  [BUCKET.VERSION]: 8,
  [BUCKET.DEAD]: 9,
}

/** 只查一个链接，返回 [{bucket, detail}] 与证据 */
async function checkOneLink(link, rec, opt, evidence) {
  const out = []

  // DOI 类：只查 doi.org 登记处，不查出版商页面
  const doi = extractDoi(link)
  if (doi) {
    const r = await checkDoi(doi, opt)
    out.push(r)
    return out
  }

  let url
  try {
    url = new URL(link)
  } catch {
    out.push({ bucket: BUCKET.MANUAL, detail: `链接无法解析为网址：${link}` })
    return out
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    out.push({ bucket: BUCKET.MANUAL, detail: `非常见协议，无法自动检查：${url.protocol}` })
    return out
  }

  let res
  try {
    res = await fetchText(url.href, opt.timeout)
  } catch (err) {
    out.push(classifyThrown(err))
    return out
  }

  if (res.status === 404 || res.status === 410) {
    out.push({ bucket: BUCKET.DEAD, detail: `HTTP ${res.status}，按约定判定为确定失效` })
    return out
  }
  if (res.status >= 500) {
    out.push({ bucket: BUCKET.UNREACHABLE, detail: `HTTP ${res.status}（服务端错误，可能是机房 IP 被挡，不判失效）` })
    return out
  }
  if (!res.ok) {
    out.push({ bucket: BUCKET.MANUAL, detail: `HTTP ${res.status}（非 404/410，无法判定，需人工确认）` })
    return out
  }
  if (!res.text || res.text.length < 50) {
    out.push({ bucket: BUCKET.MANUAL, detail: '响应正文为空或过短，无法比对版本' })
    return out
  }

  // 版本比对
  const normPage = res.text.replace(/\s+/g, '')
  const lawKey = stripTitle(rec.raw.name || '')
  const key = normPage.includes(lawKey) ? lawKey : lawKey.slice(-6)
  if (lawKey && !normPage.includes(lawKey) && !normPage.includes(key)) {
    out.push({ bucket: BUCKET.MANUAL, detail: '页面未出现法规名称，疑似检索页或动态加载页，跳过版本比对' })
    return out
  }
  const findings = compareVersions(rec, normPage, key, evidence)
  if (findings.length) {
    out.push(...findings)
  } else {
    out.push({ bucket: BUCKET.OK, detail: `HTTP ${res.status}，版本比对一致（注册表版本：${rec.raw.version || '—'}）` })
  }
  return out
}

async function checkRecord(rec, opt) {
  const result = { rec, bucket: BUCKET.OK, details: [], evidence: [] }
  const findings = []

  // ③ 注册表缺少必填字段
  const missing = REQUIRED_RECORD_FIELDS.filter((f) => !rec.raw[f.key])
  if (missing.length) {
    findings.push({ bucket: BUCKET.MISSING_FIELD, detail: `缺少必填字段：${missing.map((f) => f.label).join('、')}` })
  }

  // 一行可能登记多个官方链接（正本 + 转载页 + 行政法规库），逐个查
  const links = urlsIn(rec.raw.link || '')
  if (links.length === 0) {
    if (findings.length === 0) {
      findings.push({ bucket: BUCKET.MISSING_FIELD, detail: '官方链接栏里没有任何可解析的网址' })
    }
    result.bucket = findings.reduce((a, b) => (BUCKET_RANK[b.bucket] > BUCKET_RANK[a] ? b : a)).bucket
    result.details = findings.map((f) => f.detail)
    return result
  }

  if (opt.offline) {
    result.details.push(`离线模式：未联网检查 ${links.length} 个链接与版本`)
    if (findings.length === 0) findings.push({ bucket: BUCKET.OFFLINE, detail: '离线模式：未联网检查链接与版本' })
    result.bucket = findings.reduce((a, b) => (BUCKET_RANK[b.bucket] > BUCKET_RANK[a] ? b : a)).bucket
    result.details = findings.map((f) => f.detail)
    return result
  }

  for (let i = 0; i < links.length; i++) {
    const one = await checkOneLink(links[i], rec, opt, result.evidence)
    const host = hostOf(links[i]) || links[i]
    for (const f of one) {
      findings.push({ ...f, detail: links.length > 1 ? `[链接 ${i + 1} ${host}] ${f.detail}` : f.detail })
    }
  }

  const worst = findings.reduce((a, b) => (BUCKET_RANK[b.bucket] > BUCKET_RANK[a] ? b : a))
  result.bucket = worst.bucket
  result.details = findings.map((f) => f.detail)
  return result
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opt = {
    check: false,
    offline: false,
    root: path.resolve(SCRIPT_DIR, '..'),
    list: '',
    timeout: 15000,
    concurrency: 4,
    filter: '',
    doiApi: 'https://doi.org',
    summary: '',
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') opt.check = true
    else if (a === '--offline') opt.offline = true
    else if (a === '--help' || a === '-h') opt.help = true
    else if (a === '--root') opt.root = path.resolve(argv[++i] ?? '.')
    else if (a === '--list') opt.list = path.resolve(argv[++i] ?? '')
    else if (a === '--timeout') opt.timeout = Math.max(500, Number(argv[++i]) || 15000)
    else if (a === '--concurrency') opt.concurrency = Math.max(1, Math.min(16, Number(argv[++i]) || 4))
    else if (a === '--filter') opt.filter = argv[++i] ?? ''
    else if (a === '--doi-api') opt.doiApi = argv[++i] ?? 'https://doi.org'
    else if (a === '--summary') opt.summary = argv[++i] ?? ''
    else {
      console.error(`未知参数：${a}（用 --help 查看用法）`)
      process.exit(2)
    }
  }
  return opt
}

const USAGE = `法规时效与链接监控 —— 用法：
  node tools/check-sources.mjs                    联网全量检查（报告模式）
  node tools/check-sources.mjs --check            硬问题非零退出
  node tools/check-sources.mjs --offline          不联网，只校验注册表字段
  node tools/check-sources.mjs --root <目录>       指定仓库根目录
  node tools/check-sources.mjs --list <文件>       指定法规清单路径
  node tools/check-sources.mjs --timeout <毫秒>    单次请求超时（默认 15000）
  node tools/check-sources.mjs --concurrency <数>  并发数（默认 4）
  node tools/check-sources.mjs --filter <子串>     只检查名称含该子串的记录
  node tools/check-sources.mjs --doi-api <前缀>    DOI 登记处前缀（默认 https://doi.org）
  node tools/check-sources.mjs --summary <文件>    汇总追加写入该文件
退出码：0 通过 / 1 确定失效或版本不一致 / 2 运行环境错误`

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = cursor++
      if (idx >= items.length) return
      try {
        out[idx] = await fn(items[idx], idx)
      } catch (err) {
        out[idx] = {
          rec: items[idx],
          bucket: BUCKET.MANUAL,
          details: ['检查过程异常：' + (err && err.message ? err.message : String(err))],
          evidence: [],
        }
      }
    }
  })
  await Promise.all(workers)
  return out
}

const HARD_BUCKETS = [BUCKET.DEAD, BUCKET.VERSION]

async function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.help) {
    console.log(USAGE)
    process.exit(0)
  }

  const listPath = opt.list || path.join(opt.root, 'sources', '法规清单.md')

  console.log('法规时效与链接监控')
  console.log(`法规清单：${listPath}`)
  console.log(`模式：${opt.offline ? '离线（只校验注册表字段）' : '联网全量'}`)
  console.log('')

  if (!fs.existsSync(listPath)) {
    console.error(`[环境错误] 法规清单不存在：${listPath}`)
    console.error('说明：清单缺失时无法监控，按约定报错退出（退出码 2）。')
    process.exit(2)
  }

  let text
  try {
    text = fs.readFileSync(listPath, 'utf8')
  } catch (err) {
    console.error(`[环境错误] 法规清单读不了：${err.message}`)
    process.exit(2)
  }

  const { shape, records: allRecords } = parseRegistry(text)
  const records = opt.filter
    ? allRecords.filter((r) => (r.raw.name || '').includes(opt.filter))
    : allRecords

  console.log(`清单格式识别为：${shape}；记录 ${allRecords.length} 条` + (opt.filter ? `，按「${opt.filter}」过滤后 ${records.length} 条` : ''))

  if (allRecords.length === 0) {
    console.error('[环境错误] 法规清单里解析不到任何记录（需要 Markdown 表格，或「## 名称」+「- 官方链接：…」式分条）。')
    console.error('说明：一条都监控不到等于没监控，按约定以退出码 2 报错。')
    process.exit(2)
  }

  const started = Date.now()
  const results = await mapLimit(records, opt.concurrency, (rec) => checkRecord(rec, opt))
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  for (const r of results) {
    const name = labelOf(r.rec)
    const mark = HARD_BUCKETS.includes(r.bucket) ? '!!!' : r.bucket === BUCKET.OK ? ' ok' : '  ~'
    console.log(`${mark} [${r.bucket}] ${name}`)
    for (const d of r.details) console.log(`        ${d}`)
    for (const e of r.evidence) console.log(`        证据：${e}`)
  }

  const counts = new Map()
  for (const r of results) counts.set(r.bucket, (counts.get(r.bucket) || 0) + 1)

  console.log('\n—— 汇总 ——')
  console.log(`记录 ${results.length} 条，耗时 ${elapsed} 秒`)
  for (const b of Object.values(BUCKET)) {
    if (counts.has(b)) console.log(`  ${b}：${counts.get(b)} 条${HARD_BUCKETS.includes(b) ? '（硬问题，--check 下非零退出）' : ''}`)
  }

  const summaryLines = [
    '## 来源时效与链接监控',
    '',
    `- 法规清单：\`${path.relative(opt.root, listPath).split(path.sep).join('/')}\``,
    `- 模式：${opt.offline ? '离线（只校验注册表字段）' : '联网全量'}，记录 ${results.length} 条，耗时 ${elapsed} 秒`,
    `- 汇总：` + [...counts.entries()].map(([k, v]) => `${k} ${v}`).join('，'),
    '',
    '| 结论 | 法规 | 位置 | 说明 |',
    '| --- | --- | --- | --- |',
  ]
  for (const r of results) {
    const name = labelOf(r.rec).replace(/\|/g, '\\|')
    const detail = (r.details.join('；') + (r.evidence.length ? '｜证据：' + r.evidence.join('；') : '')).replace(/\|/g, '\\|').slice(0, 400)
    summaryLines.push(`| ${r.bucket} | ${name} | ${path.relative(opt.root, listPath).split(path.sep).join('/')}:${r.rec.line} | ${detail} |`)
  }
  summaryLines.push('')
  const summaryText = summaryLines.join('\n')

  const summaryTarget = opt.summary || process.env.GITHUB_STEP_SUMMARY || ''
  if (summaryTarget) {
    try {
      fs.appendFileSync(summaryTarget, summaryText + '\n', 'utf8')
      console.log(`\n汇总已追加写入：${summaryTarget}`)
    } catch (err) {
      console.error(`[环境错误] 汇总写入失败：${err.message}`)
      process.exit(2)
    }
  } else {
    console.log('\n（未设置 --summary，也未检测到 GITHUB_STEP_SUMMARY 环境变量，未写汇总文件）')
  }

  const hard = results.filter((r) => HARD_BUCKETS.includes(r.bucket))
  if (opt.check) {
    if (hard.length) {
      console.error(`\n[失败] 发现硬问题 ${hard.length} 条（确定失效 / 版本不一致），退出码 1`)
      process.exit(1)
    }
    console.log('\n[通过] 没有确定失效，也没有版本不一致（退出码 0）')
    process.exit(0)
  }

  console.log(hard.length ? '\n（报告模式：发现硬问题但退出码仍为 0，加 --check 才会非零退出）' : '\n（报告模式：未发现硬问题）')
  process.exit(0)
}

main().catch((err) => {
  console.error('[环境错误] 脚本异常终止：', err && err.stack ? err.stack : err)
  process.exit(2)
})
