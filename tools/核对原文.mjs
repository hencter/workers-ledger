#!/usr/bin/env node
/**
 * 核对原文.mjs —— 排版后的 markdown 与官方原文纯文本逐字 diff 验证
 *
 *   node tools/核对原文.mjs                          核对 sources/条文摘录.md 全部块
 *   node tools/核对原文.mjs --file <md>              核对指定文件
 *   node tools/核对原文.mjs --only L01,L04           只核对指定编号
 *   node tools/核对原文.mjs --require-diff           任何一条没有 diff 记录就算失败
 *   node tools/核对原文.mjs --json <文件>            机器可读报告
 *   node tools/核对原文.mjs --summary <文件>         Markdown 汇总
 *
 * ## 这个工具到底证明什么（读之前务必看清，别把它当万能）
 *
 * 它证明的是：**markdown 里的每一段正文，都能在官方原文的纯文本里找到逐字一致的
 * 连续片段。** 判据是把两边**所有空白字符去掉**（含全角空格）之后做子串匹配，
 * 并记录匹配到的字符偏移。
 *
 * 由此可推出两件事：
 *   1. 排版（换行、缩进、标题层级、强调）可以任意改——空白不参与判定；
 *   2. 一旦改了字、漏了字、加了字、换了标点，匹配立即失败并给出上下文 diff。
 *
 * ## 它不证明什么（同样是重点）
 *   - **不证明完整性**：少摘一段它不报——它只核对「写进去的」，不核对「该有没有」。
 *   - **不证明版本正确**：页面可能是旧版（本仓库已命中四例「旧版页面不自我标注已被取代」）。
 *     版本判断在 `sources/法规清单.md` 与 `docs/核实记录/`，不在本工具。
 *   - **不证明条号归属**：某一章的条文可能被页面排版拆散，本工具只看字符是否连续出现。
 *
 * ## 输入
 *   - 待核对的 markdown：默认 `sources/条文摘录.md`（格式见其文件头「摘录规则」）
 *   - 官方原文缓存：`sources/.原文缓存/`，由 `tools/抽原文.mjs` 抓取落盘。
 *     本工具**只读缓存、不联网**——这是刻意的：验证必须离线可复跑，否则页面改版后
 *     就再也复核不了当时的结论。要更新原文先跑 `抽原文.mjs --force`。
 *
 * 退出码：0 全部通过 / 1 有不一致 / 2 环境错误
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CACHE = join(ROOT, 'sources', '.原文缓存')
/** 允许用本地文件替代抓取：`sources/.原文缓存/<编号>-NN.txt` 存在但缺 .json 时，
 *  视为**人工核对过的来源**，并在报告里标出来源为「本地人工核对件」。
 *  存在的理由：S02 的最高人民法院公报页已被 JS 校验拦住（本仓库三路独立实测一致），
 *  但该页的条文在本仓库较早的核验中已取到并落盘。与其假装它可抓，不如让这条
 *  条文**有可比对的对象**，同时把来源性质写清楚——留下「本轮未取得一手复核」的记录。 */
const LOCAL_SOURCE = true

const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const MD_PATH = resolve(argOf('--file', join(ROOT, 'sources', '条文摘录.md')))
const ONLY = argOf('--only', '').split(',').map((s) => s.trim()).filter(Boolean)
const JSON_OUT = argOf('--json', '')
const SUMMARY = argOf('--summary', '')
const REQUIRE_DIFF = has('--require-diff')

/** 归一化：去掉全部空白字符（含全角空格 U+3000、NBSP U+00A0）。
 *
 *  为什么去空白而不是「统一成单个空格」：法规原文在官方 HTML 里的换行位置与本仓库
 *  markdown 的换行位置必然不同（这正是「排版」自由度的来源），所以空白必须完全不参与
 *  判定。只要不动汉字、数字、标点，去空白后的字符串就应当逐字一致。
 *
 *  注意：这里**不做任何标点转换**。全角括号、全角逗号一律保留原样——本仓库
 *  「摘录规则」第 5 条明确要求项号括号按所引页面实际字符照录，不作统一。 */
export function normalize(s) {
  return String(s)
    .replace(/[\s\u00a0\u3000\ufeff]+/g, '')
    .replace(/\u200b/g, '')
}

/**
 * 标点风格归一：把全角括号/分号/冒号折成半角，**只用于比对**。
 *
 * 为什么必须允许这一种差异：同一部法规在不同官方页面上，项号括号的风格不同——
 * 国家行政法规库用半角 `(一)`，中国人大网与中国政府网用全角 `（一）`。这是同一官方
 * 文本的排版差异，不构成内容差异。仓库规范 `docs/条目规范.md` 与
 * `sources/法规清单.md` 第五节第 6 条都明确记录并要求「照录所引页面的实际字符，不作统一」。
 *
 * 实测依据：`book/` 第 6 节引《反不正当竞争法》「第十条第四款」时，**核验员曾据 2019 版
 * 条序把正确的引用误判为不存在**（见 `docs/核实记录/信源-全仓条号审计.md`）。标点风格之争
 * 制造过假阳性，所以这里明确把「风格」与「内容」分开处理。
 *
 * **只归一这几种，且必须报出用了几处**（见 verifyBody 的 风格归一 计数）：
 * 全角括号 ↔ 半角括号、全角分号 ↔ 半角分号、全角冒号 ↔ 半角冒号。
 * 引号（「」/“”/「」）、书名号、破折号**一律不归一**——那些可能承载内容差异。
 */
export function stylize(s) {
  return s
    .replace(/[（）]/g, (c) => (c === '（' ? '(' : ')'))
    .replace(/[；]/g, ';')
    .replace(/[：]/g, ':')
}

/** 统计两段文本在标点风格上的差异处数（归一前 vs 归一后） */
function styleDiffCount(a, b) {
  let n = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) n++
  return n + Math.abs(a.length - b.length)
}

/** 编者注判据：markdown 引用块中的内容。
 *
 *  为什么必须排除：本文件里 `> [!note] 条号说明` / `> [!danger] 版本陷阱` 这类块是
 *  **本仓库的考据**（说明为什么这样录、哪里容易错），不是法规原文。把它们算进比对，
 *  它们永远不可能逐字一致——而那是**正确**的，不该报错。
 *
 *  这个判据不是拍脑袋定的：本文件全部 `>` 开头的行已逐行查看过，**无一处是原文引用**，
 *  全部是编者注（含版本对照表、提醒、留档警示）。所以「引用块一律不算原文」是安全的。
 *  若将来确有「引用官方另一处原文」的需求，应另起独立的摘录块，不要把原文写进引用块。 */
function isEditorial(line) {
  return /^\s*>/.test(line)
}

/** 从正文开头剥掉条号前缀。
 *
 *  摘录约定写成「第三十三条　职工因工作…」（条号 + 全角空格 + 正文），而官方页把条号
 *  排成独立段首（「第三十三条 职工因工作…」）。去空白后两者本可相接，但官方页条号与
 *  正文分属两个块级元素，中间可能夹着别的结构字符，所以**整段**连续匹配会假失败。
 *  判据因此拆成两条：
 *    ① 条号前缀：只与**正文的第一行**比；
 *    ② 正文其余行：逐行在原文里找连续片段（见 verifyBody）。
 *  这样既保住「逐字一致」的强度，又不因排版差异误报。 */
export function stripArticlePrefix(body) {
  const lines = body.split('\n')
  const m = /^\s*(第[一二三四五六七八九十百千零〇]+条|第[一二三四五六七八九十百]+项|[一二三四五六七八九十]+、)\s*[　 ]?\s*(.*)$/.exec(lines[0] || '')
  if (!m) return { 条号: '', 正文: body }
  const rest = [m[2], ...lines.slice(1)].join('\n')
  return { 条号: m[1], 正文: rest }
}

/** 列出某段文本在长文本里的所有匹配位置（用于检出重复条文、判断是否有歧义） */
function findAll(haystack, needle) {
  const out = []
  if (!needle) return out
  let i = haystack.indexOf(needle)
  while (i >= 0) {
    out.push(i)
    i = haystack.indexOf(needle, i + 1)
    if (out.length > 50) break
  }
  return out
}

/**
 * 核验一段摘录正文：逐行要求每一行都能在官方原文里找到逐字一致的连续片段。
 *
 * 为什么按行而不是整段：官方 HTML 的段落切分与本仓库 markdown 的段落切分不可能完全
 * 一致（前者把项号拆成独立块、后者按语义分段），整段去空白后匹配会因为中间多出结构
 * 字符而假失败。按行核验则对排版差异免疫，同时对改字极其敏感——**漏一行、错一字、
 * 换一个标点，那一行立刻找不到匹配**。
 *
 * 这是有意的取舍：强度上略低于「整段连续」，换来的是判据稳定、不误报。
 * 每行的字符数与命中偏移都会记进报告，便于人工抽查。
 */
export function verifyBody(normSource, body, normSourceStylized) {
  const { 条号, 正文 } = stripArticlePrefix(body)
  const rows = 正文.split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  if (!rows.length) return { ok: false, lines: [], reason: '正文为空' }
  const srcSty = normSourceStylized ?? stylize(normSource)
  const lines = []
  let allOk = true
  let 风格归一处数 = 0
  for (const raw of rows) {
    const strict = normalize(raw)
    if (!strict) continue
    // 两级判据：
    //   ① 严格：只去空白 —— 两边都按原文实际字符比；
    //   ② 风格：两边都把全角/半角括号、分号、冒号折成半角后再比。
    // **两边都要折**：只折一侧会把「原文本来就半角、摘录写全角」的情况漏掉
    // （实测踩过：来源写 `(一)`、摘录写 `（一）`，只折摘录侧就匹配不上）。
    let needle = strict
    let at = normSource.indexOf(needle)
    let 靠风格归一 = false
    if (at < 0) {
      const sty = stylize(strict)
      const at2 = srcSty.indexOf(sty)
      if (at2 >= 0) {
        needle = sty
        at = at2
        靠风格归一 = true
        风格归一处数 += styleDiffCount(strict, sty)
      }
    }
    const hay = 靠风格归一 ? srcSty : normSource
    const n = at >= 0 ? findAll(hay, needle).length : 0
    if (at < 0) allOk = false
    lines.push({ 原行: raw, 字符数: strict.length, 命中: at >= 0, 偏移: at, 命中次数: n, 靠风格归一 })
  }
  return { 条号, ok: allOk, lines, 风格归一处数 }
}

// ---------------------------------------------------------------------------
// 解析待核对的 markdown
// ---------------------------------------------------------------------------

/**
 * 解析「摘录规则」定义的格式：
 *   ## <编号> <法规全称>
 *   …可选说明…
 *   ### <条号>（说明）
 *   <原文正文，可能多段>
 *   来源：<编号>　摘录日期：YYYY-MM-DD
 *
 * 返回：{ 块: [{ id, name, 条文: [{ 条号, 标题行, 正文, 来源, 起始行 }] }], 无原文块: [...] }
 */
export function parseExcerpts(md) {
  const eol = md.includes('\r\n') ? '\r\n' : '\n'
  const lines = md.split(eol)

  const 块 = []
  const 无原文块 = []
  let cur = null
  let cur条文 = null
  const 条文数组 = []

  const close条文 = () => {
    if (cur条文) 条文数组.push(cur条文)
    cur条文 = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const h2 = /^##\s+(\S+)\s*(.*)$/.exec(line)
    if (h2 && !line.startsWith('###')) {
      close条文()
      const id = h2[1]
      const name = h2[2].trim()
      if (/未获取到原文/.test(line)) {
        无原文块.push({ id, name, 行: i + 1 })
        cur = null
        continue
      }
      cur = { id, name, 条文: [], 行: i + 1 }
      块.push(cur)
      continue
    }

    const h3 = /^###\s+(.*)$/.exec(line)
    if (h3 && cur) {
      close条文()
      cur条文 = { 标题行: h3[1].trim(), 起始行: i + 1, 正文行: [] }
      continue
    }

    if (!cur) continue
    if (!cur条文) continue

    if (/^来源：/.test(line)) {
      cur条文.来源 = line.trim()
      close条文()
      continue
    }
    if (/^<!--.*-->$/.test(line.trim())) continue
    if (isEditorial(line)) continue
    cur条文.正文行.push(line)
  }
  close条文()

  // 条文按起始行号归属到所属法规块（块按出现顺序，行号递增，取最后一个起始行 ≤ 条文行的块）
  const blockOf = (lineNo) => {
    let found = null
    for (const b of 块) if (b.行 <= lineNo) found = b
    return found
  }
  for (const t of 条文数组) {
    const b = blockOf(t.起始行)
    if (b) b.条文.push(t)
  }

  for (const b of 块) {
    for (const t of b.条文) {
      t.正文 = t.正文行.join('\n').replace(/^\n+|\n+$/g, '')
    }
  }

  return { 块, 无原文块, 条文总数: 条文数组.length }
}

// ---------------------------------------------------------------------------
// 缓存读取
// ---------------------------------------------------------------------------

function cacheFor(id) {
  if (!existsSync(CACHE)) return []
  return readdirSync(CACHE)
    .filter((f) => f.startsWith(`${id}-`) && f.endsWith('.txt'))
    .sort()
    .map((f) => {
      const stem = f.replace(/\.txt$/, '')
      const metaPath = join(CACHE, `${stem}.json`)
      let meta = {}
      let 种类 = '抓取'
      if (existsSync(metaPath)) {
        try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) } catch { /* 元数据损坏不阻断比对 */ }
      } else {
        // 有 txt 无 json：人工放的核对件（见 LOCAL_SOURCE 说明）。
        // **必须标出来**，否则会被误读成「本工具抓过这个页面」。
        种类 = '本地人工核对件'
      }
      return { stem, path: join(CACHE, f), meta, 种类, text: readFileSync(join(CACHE, f), 'utf8') }
    })
}

// ---------------------------------------------------------------------------
// 主流程（有 import 守卫，便于被其它脚本或测试复用其中的判据函数）
// ---------------------------------------------------------------------------

/** 仅当作为主模块直接运行时才执行核对；被 import 时只暴露纯函数。 */
const isMain = (() => {
  try {
    const arg = process.argv[1] ? resolve(process.argv[1]) : ''
    return arg === resolve(fileURLToPath(import.meta.url))
  } catch { return false }
})()

if (isMain) main()

function main() {
  if (!existsSync(MD_PATH)) {
    console.error(`[环境错误] 找不到待核对文件：${MD_PATH}`)
    process.exit(2)
  }
  if (!existsSync(CACHE)) {
    console.error(`[环境错误] 找不到原文缓存：${CACHE}`)
    console.error('先跑：node tools/抽原文.mjs --all')
    process.exit(2)
  }

  const md = readFileSync(MD_PATH, 'utf8')
  const { 块, 无原文块, 条文总数 } = parseExcerpts(md)

  if (!块.length) {
    console.error(`[环境错误] 在 ${MD_PATH} 里解析不到任何「## <编号> <名称>」法规块`)
    console.error('说明：一个块都解析不到，等于这道防线没生效，按约定以退出码 2 报错。')
    process.exit(2)
  }

  console.log('原文逐字核对（markdown ↔ 官方原文纯文本）')
  console.log(`待核对：${MD_PATH}`)
  console.log(`原文缓存：${CACHE}`)
  console.log('判据：逐行要求每行在官方原文里去空白后逐字匹配；标点风格差异（全角/半角括号、分号、冒号）允许，且必须报出用了几处')
  console.log('')

const 结果 = []
const 无缓存 = []
let passCount = 0
let failCount = 0
let 风格归一总处数 = 0

for (const b of 块) {
  if (ONLY.length && !ONLY.includes(b.id)) continue
  const caches = cacheFor(b.id)
  if (!caches.length) {
    无缓存.push(b)
    console.log(`⏭  ${b.id} ${b.name}　无原文缓存（跑 tools/抽原文.mjs --only ${b.id}）`)
    continue
  }

  // 多个官方页并存时（例如正本 + 转载页 + 法规库），任一处匹配即算通过；
  // 但要记录命中的是哪个页面，便于人工判断主源。
  const normalCaches = caches.map((c) => {
    const norm = normalize(c.text)
    return { ...c, norm, normSty: stylize(norm) }
  })

  const 条结果 = []
  for (const t of b.条文) {
    // 逐行核验；多个官方页并存时，任一处全部行命中即算通过
    let best = null
    for (const c of normalCaches) {
      const v = verifyBody(c.norm, t.正文, c.normSty)
      const 命中行 = v.lines.filter((l) => l.命中).length
      const score = { stem: c.stem, ...v, 命中行, 总行: v.lines.length }
      if (!best || score.命中行 > best.命中行) best = score
      if (v.ok) { best = score; break }
    }
    const 未命中 = best.lines.filter((l) => !l.命中)
    if (best.ok) {
      passCount++
      const 风格行 = best.lines.filter((l) => l.靠风格归一).length
      if (风格行) 风格归一总处数 += best.风格归一处数
      条结果.push({
        条号: t.标题行, ok: true,
        行数: best.总行, 字符数: best.lines.reduce((a, l) => a + l.字符数, 0),
        命中页: best.stem, 命中行: best.命中行,
        重复行: best.lines.filter((l) => l.命中次数 > 1).length,
        风格归一: 风格行 ? { 行数: 风格行, 处数: best.风格归一处数 } : null,
      })
    } else {
      failCount++
      const first = 未命中[0]
      const cmp = first ? locateDivergence(normalCaches.find((c) => c.stem === best.stem).norm, normalize(first.原行)) : null
      条结果.push({
        条号: t.标题行, ok: false,
        行数: best.总行, 命中行: best.命中行,
        对照页: best.stem,
        reason: `${best.总行} 行中 ${未命中.length} 行在官方原文里找不到逐字一致的片段`,
        未命中行: 未命中.slice(0, 5).map((l) => ({ 原行: l.原行.slice(0, 120), 字符数: l.字符数 })),
        diff: cmp,
      })
    }
  }

  const bad = 条结果.filter((x) => !x.ok)
  const mark = bad.length ? '✗' : '✓'
  const detail = bad.length
    ? `${条结果.length} 条中 ${bad.length} 条不匹配`
    : `${条结果.length} 条全部逐字一致`
  console.log(`${mark}  ${b.id} ${b.name}　${detail}　（对照页 ${caches.length} 个）`)
  for (const x of bad) {
    console.log(`     ✗ ${x.条号}`)
    console.log(`       ${x.reason}`)
    for (const l of x.未命中行 || []) {
      console.log(`       未命中（${l.字符数} 字符）：${l.原行}`)
    }
    if (x.diff) {
      console.log(`       最长一致前缀 ${x.diff.前缀长} 字符，分歧处：`)
      console.log(`         官方原文：…${x.diff.原文片段}…`)
      console.log(`         本仓库　：…${x.diff.摘录片段}…`)
    }
  }
  // 重复命中：同一段文字在页面上出现多次（例如目录 + 正文），提示但不判错
  const dup = 条结果.filter((x) => x.ok && x.重复行 > 0)
  if (dup.length) {
    console.log(`     [提示] ${dup.length} 条里有正文行在原文里出现多次（目录/正文重复）`)
  }

  结果.push({ id: b.id, name: b.name, 行: b.行, 对照页: caches.map((c) => ({ stem: c.stem, url: c.meta.url, sha256: c.meta.HTML_SHA256 })), 条结果 })
}

/** 定位两段文本的分歧点：最长公共前缀 + 最长公共后缀，用于给人看。 */
function locateDivergence(origin, excerpt) {
  let p = 0
  const maxP = Math.min(origin.length, excerpt.length)
  while (p < maxP && origin[p] === excerpt[p]) p++

  let s = 0
  while (s < maxP - p && origin[origin.length - 1 - s] === excerpt[excerpt.length - 1 - s]) s++

  const 原文片段 = origin.slice(Math.max(0, p - 20), Math.min(origin.length, p + 40))
  const 摘录片段 = excerpt.slice(Math.max(0, p - 20), Math.min(excerpt.length, p + 40))
  return { 前缀长: p, 后缀长: s, 原文片段, 摘录片段 }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log('')
console.log('—— 汇总 ——')
console.log(`法规块 ${结果.length} 个，条文 ${passCount + failCount} 条`)
console.log(`逐字一致 ${passCount} 条，不匹配 ${failCount} 条`)
if (无缓存.length) {
  console.log(`无原文缓存 ${无缓存.length} 个块：${无缓存.map((b) => b.id).join('、')}`)
}
if (无原文块.length) {
  console.log(`文件中标记「未获取到原文」的块 ${无原文块.length} 个：${无原文块.map((b) => b.id).join('、')}（按约定跳过核对）`)
}

const 重复命中 = 结果.flatMap((b) => b.条结果.filter((x) => x.ok && x.重复行 > 0).map((x) => `${b.id} ${x.条号}`))
if (重复命中.length) {
  console.log(`[提示] ${重复命中.length} 条里有正文行在官方页面上出现多次（目录/正文重复）`)
}

if (JSON_OUT) {
  const report = {
    待核对文件: MD_PATH,
    判据: '逐行要求每行在官方原文中去空白后逐字匹配；标点风格差异（全角/半角括号、分号、冒号）允许且单独计数',
    生成时间: new Date().toISOString(),
    法规块数: 结果.length,
    条文总数: passCount + failCount,
    逐字一致: passCount,
    不匹配: failCount,
    无原文缓存: 无缓存.map((b) => b.id),
    未获取到原文块: 无原文块.map((b) => b.id),
    结果,
  }
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(`\nJSON 报告：${JSON_OUT}`)
} else {
  console.log('\n（未指定 --json，未写机器可读报告）')
}

if (SUMMARY) {
  const lines = [
    '## 原文逐字核对',
    '',
    `- 待核对：\`${MD_PATH.replace(ROOT + '\\', '').replace(ROOT + '/', '')}\``,
    `- 判据：逐行要求每行在官方原文中去空白后逐字匹配；标点风格差异（全角/半角括号、分号、冒号）允许且单独计数`,
    `- 法规块 ${结果.length} 个，条文 ${passCount + failCount} 条；**逐字一致 ${passCount}，不匹配 ${failCount}**`,
    '',
    '| 编号 | 法规 | 条文 | 一致 | 不匹配 | 对照页 SHA256 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const b of 结果) {
    const ok = b.条结果.filter((x) => x.ok).length
    const bad = b.条结果.length - ok
    const sha = b.对照页.map((c) => `${c.stem}:${(c.sha256 || '').slice(0, 12)}`).join('<br>')
    lines.push(`| ${b.id} | ${b.name} | ${b.条结果.length} | ${ok} | ${bad} | ${sha} |`)
  }
  lines.push('')
  writeFileSync(SUMMARY, lines.join('\n'), 'utf8')
  console.log(`Markdown 汇总：${SUMMARY}`)
}

if (无缓存.length) {
  console.error(`\n[失败] 有 ${无缓存.length} 个法规块没有原文缓存，无法核对：${无缓存.map((b) => b.id).join('、')}`)
  console.error('先跑 node tools/抽原文.mjs --all')
  process.exit(1)
}

if (failCount > 0) {
  console.error(`\n[失败] ${failCount} 条与官方原文不一致（退出码 1）`)
  process.exit(1)
}

if (REQUIRE_DIFF) {
    const diffDir = join(ROOT, 'docs', '核实记录', 'diff')
    const missing = 结果.filter((b) => !existsSync(join(diffDir, `${b.id}.diff.md`)))
    if (missing.length) {
      console.error(`\n[失败] --require-diff：${missing.length} 个法规块没有 diff 记录（docs/核实记录/diff/<编号>.diff.md）：${missing.map((b) => b.id).join('、')}`)
      process.exit(1)
    }
    console.log(`\n[通过] 逐字一致，且 ${结果.length} 个法规块都有 diff 记录`)
  } else {
    console.log('\n[通过] 全部逐字一致（退出码 0）')
  }
  process.exit(0)
}
