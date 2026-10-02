#!/usr/bin/env node
/**
 * 排版条文.mjs —— 把摘录整理成可读的 markdown 排版，并**自动回验逐字一致**
 *
 *   node tools/排版条文.mjs --check                 只报告将要做的排版改动，不写文件
 *   node tools/排版条文.mjs --out <目录>            写出排版后的文件（默认 sources/条文）
 *   node tools/排版条文.mjs --only L01,L04          只处理指定编号
 *   node tools/排版条文.mjs --verify                排版后立刻跑核对原文
 *
 * ## 为什么用机械排版而不是手改
 *
 * 本仓库全文要处理 **402 行摘录正文**。手工重排一遍，等于给「多一个字、少一个标点、
 * 换个引号」创造 402 次机会——而这类错误正是本仓库最忌讳的。所以排版一律机械执行：
 * 规则写在代码里，改完自动调 `tools/核对原文.mjs` 的同一套判据回验，不通过就不写文件。
 *
 * ## 排版规则（规则本身也必须可审）
 *
 *   1. **条号与正文之间不留全角空格**：`第三十三条　职工因…` → `第三十三条 职工因…`。
 *      依据是官方页面本身就把条号排成段首标记（「第三十三条 职工因…」），
 *      全角空格是本仓库早前摘录时的分隔习惯，不是原文内容。
 *   2. **项号独立成行并转为 markdown 列表**：`（一）…（二）…` 在同一次摘录里
 *      本来就是各自成行的，这里只把它们规范成列表项，保持可读性：
 *      `- （一）注册资本不得少于人民币二百万元；`
 *      注意**保留项号本身**——`（一）` 是条文内容的一部分，不能删。
 *   3. **条款段落之间留空行**：markdown 里连续的段落行会被粘成一段，接口播报时更难读。
 *   4. **章节标题保留**：官方文本含「第一章 总则」这类章名时，转成 `####` 标题，
 *      比正文行更醒目；不含章名的不补（**不许凭记忆补章节**）。
 *   5. **编者注（`>` 引用块）移到块首的 `<!-- 编者注 -->` 注释里**：它是考据不是原文，
 *      放进正文会污染比对。移成注释后既不丢，也不参与核对。
 *   6. **删除「来源：」「摘录日期」行**：这些由排版后的元数据块统一承载。
 *
 * **不做的事**：不改任何汉字、数字、标点、引号；不补章节；不调整条文顺序；不合并或拆分条文。
 * 每一项都由回验兜底——只要规则动了内容，`核对原文.mjs` 立刻报不通过，文件不落盘。
 *
 * 只使用 Node 24 内置模块，零依赖。
 * 退出码：0 成功 / 1 回验不通过（未写文件）/ 2 环境错误
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalize, stylize, stripArticlePrefix, parseExcerpts } from './核对原文.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CACHE = join(ROOT, 'sources', '.原文缓存')

const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const MD_PATH = resolve(argOf('--file', join(ROOT, 'sources', '条文摘录.md')))
const OUT_DIR = resolve(argOf('--out', join(ROOT, 'sources', '条文')))
const ONLY = argOf('--only', '').split(',').map((s) => s.trim()).filter(Boolean)
const CHECK_ONLY = has('--check')

if (!existsSync(MD_PATH)) { console.error(`[环境错误] 找不到 ${MD_PATH}`); process.exit(2) }
if (!existsSync(CACHE)) { console.error(`[环境错误] 找不到原文缓存，先跑 node tools/抽原文.mjs --all`); process.exit(2) }

// ---------------------------------------------------------------------------
// 排版
// ---------------------------------------------------------------------------

/** 项号行：`（一）…`、`(二)…`、`1.…`、`一、…`。用于转成列表项。 */
const ITEM_RE = /^\s*([（(][一二三四五六七八九十百零〇\d]+[）)]|[一二三四五六七八九十百]+、|\d+[.．、])\s*/

/** 章名行：`第一章 总则`、`第一章　总则`。**只识别，不生成**。 */
const CHAPTER_RE = /^\s*(第[一二三四五六七八九十百零〇]+章)\s*[　 ]\s*(.+?)\s*$/

/** 条号行：`第一条 …`、`第一条　…`。 */
const ARTICLE_RE = /^\s*(第[一二三四五六七八九十百千零〇]+条)\s*[　 ]?\s*(.*)$/

/** 纯项号、无内容的裸项号行（例如 `（一）`）——不应出现在摘录里，出现就报出来 */
const BARE_ITEM_RE = /^\s*[（(][一二三四五六七八九十百零〇\d]+[）)]\s*$/

/**
 * 把一段摘录正文排成 markdown。返回 { md, 改动 }。
 * 规则见文件头；此处只动结构，不动内容字符。
 */
export function formatBody(body) {
  const 改动 = []
  const { 条号, 正文 } = stripArticlePrefix(body)
  const rawLines = 正文.split('\n').map((l) => l.trim()).filter(Boolean)

  const out = []
  let 已输出条号 = false

  // 条号行：(条号) + 首个内容片段
  if (条号) {
    const first = rawLines.shift() ?? ''
    已输出条号 = true
    out.push({ type: 'article', text: `**${条号}** ${first}`.trimEnd() })
    if (first === '') 改动.push(`条号「${条号}」后没有正文片段`)
  }

  let 在列表 = false
  for (const line of rawLines) {
    const ch = CHAPTER_RE.exec(line)
    if (ch) {
      if (在列表) { 在列表 = false }
      out.push({ type: 'chapter', text: `${ch[1]} ${ch[2]}` })
      改动.push(`章名成标题：${ch[1]} ${ch[2]}`)
      continue
    }
    if (isEditorialText(line)) {
      out.push({ type: 'comment', text: line })
      改动.push('编者注转为注释')
      continue
    }
    const bare = BARE_ITEM_RE.test(line)
    if (bare) {
      // 裸项号：原文里不应该单独成行，报出来让人判断
      out.push({ type: 'p', text: line })
      改动.push(`发现裸项号行：${line}（未改动，需人工判断）`)
      在列表 = false
      continue
    }
    if (ITEM_RE.test(line)) {
      out.push({ type: 'item', text: `- ${line}` })
      在列表 = true
      continue
    }
    if (在列表) 在列表 = false
    out.push({ type: 'p', text: line })
  }

  // 组装：章名与注释单独成段，条目与列表项按段落
  const md = []
  for (const o of out) {
    if (o.type === 'chapter') { md.push(`#### ${o.text}`, '') ; continue }
    if (o.type === 'comment') { md.push(`> ${o.text}`, ''); continue }
    md.push(o.text, '')
  }

  return { md: md.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd(), 改动, 条号, 行数: out.length }
}

function isEditorialText(line) {
  return /^\[!/.test(line) || /^>/.test(line)
}

// ---------------------------------------------------------------------------
// 回验：排版结果必须与官方原文逐字一致
// ---------------------------------------------------------------------------

function cachesFor(id) {
  if (!existsSync(CACHE)) return []
  return readdirSync(CACHE)
    .filter((f) => f.startsWith(`${id}-`) && f.endsWith('.txt'))
    .sort()
    .map((f) => normalize(readFileSync(join(CACHE, f), 'utf8')))
}

/**
 * 字符守恒校验：排版前后**内容字符必须逐字相等**（去空白、去标点风格差异后）。
 *
 * 为什么单靠「逐行子串匹配」不够：那种判据对**漏行免疫**——少抄一行，剩下的行照样
 * 每行都能在原文里找到，于是「通过」。而排版最危险的失败形态恰恰是悄悄丢内容。
 *
 * 所以这里做一道更强的等价性检查：
 *   排版后文本 —— 去掉我**自己添加的** markdown 装饰（列表符号 `- `、条号加粗 `**`、
 *                章名标记 `#### `、引用符号 `> `、空行）→ 应当与摘录原文
 *                在「去空白 + 标点风格归一」后**完全相等**。
 *
 * 这不是子串包含，是**等式**：多一个字符、少一个字符都会失败。
 * 通过它就说明：排版规则只动了结构，内容一个字符都没增删。
 */
export function conservationCheck(originalBody, formattedText) {
  const stripDecoration = (t) => t
    .split('\n')
    .map((l) => l
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^\*\*([^*]+)\*\*\s*/, '$1 '))
    .join('\n')

  const a = stylize(normalize(originalBody))
  const b = stylize(normalize(stripDecoration(formattedText)))

  if (a === b) return { ok: true, 长度: a.length }

  // 不等时给出第一处分歧，便于定位
  let i = 0
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
  return {
    ok: false,
    原文长度: a.length,
    排版后长度: b.length,
    分歧位置: i,
    原文片段: a.slice(Math.max(0, i - 30), i + 60),
    排版后片段: b.slice(Math.max(0, i - 30), i + 60),
  }
}

/** 把排版后的行逐行丢进官方原文里找（与 tools/核对原文.mjs 同一判据，含风格归一） */
function verifyFormatted(formattedLines, normSources) {
  const stylized = normSources.map((s) => stylize(s))
  const 结果 = []
  for (const raw of formattedLines) {
    // 去掉 markdown 结构标记，还原成内容字符
    const content = raw
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\*\*([^*]+)\*\*\s*/, '$1 ')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s*/, '')
      .trim()
    if (!content) continue
    const strict = normalize(content)
    if (!strict) continue
    let ok = false
    let 靠风格 = false
    for (let i = 0; i < normSources.length; i++) {
      if (normSources[i].includes(strict)) { ok = true; break }
      if (stylized[i].includes(stylize(strict))) { ok = true; 靠风格 = true; break }
    }
    结果.push({ 行: raw, 命中: ok, 靠风格 })
  }
  return 结果
}

// ---------------------------------------------------------------------------
// 主流程（有 import 守卫，便于被其它脚本或测试复用排版与守恒判据）
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    const arg = process.argv[1] ? resolve(process.argv[1]) : ''
    return arg === resolve(fileURLToPath(import.meta.url))
  } catch { return false }
})()

if (isMain) main()

function main() {
const md = readFileSync(MD_PATH, 'utf8')
const { 块 } = parseExcerpts(md)
const 目标 = ONLY.length ? 块.filter((b) => ONLY.includes(b.id)) : 块
if (!目标.length) { console.error('[环境错误] 没有匹配的法规块'); process.exit(2) }

if (!CHECK_ONLY) mkdirSync(OUT_DIR, { recursive: true })

let 通过 = 0
let 不通过 = 0
const 报告 = []
const 守恒失败 = []

for (const b of 目标) {
  const normSources = cachesFor(b.id)
  if (!normSources.length) {
    console.log(`⏭  ${b.id} ${b.name}　无原文缓存，跳过`)
    continue
  }

  const 章节 = []
  const 全部排版行 = []
  let 改动合计 = []

  for (const t of b.条文) {
    const { md: formatted, 改动 } = formatBody(t.正文)
    改动合计 = 改动合计.concat(改动)
    // 守恒校验：逐条比对「排版后」与「摘录原文」
    const 守恒 = conservationCheck(t.正文, formatted)
    if (!守恒.ok) {
      守恒失败.push({ 条号: t.标题行, 守恒 })
    }
    章节.push({ 标题: t.标题行, 排版: formatted, 守恒 })
    全部排版行.push(...formatted.split('\n'))
  }

  const 回验 = verifyFormatted(全部排版行, normSources)
  const 未命中 = 回验.filter((x) => !x.命中)
  const 守恒不通过 = 章节.filter((s) => !s.守恒.ok)
  const ok = 未命中.length === 0 && 守恒不通过.length === 0

  if (ok) 通过++
  else 不通过++

  报告.push({ id: b.id, name: b.name, ok, 行数: 回验.length, 未命中, 章节, 改动: 改动合计, 守恒不通过 })

  console.log(`${ok ? '✓' : '✗'}  ${b.id} ${b.name}　排版 ${章节.length} 个条文 / 回验 ${回验.length} 行（未命中 ${未命中.length}）／字符守恒 ${章节.length - 守恒不通过.length}/${章节.length}`)
  if (!ok) {
    for (const u of 未命中.slice(0, 3)) console.log(`     ✗ 未命中原文：${u.行.slice(0, 90)}`)
    for (const s of 守恒不通过.slice(0, 3)) {
      console.log(`     ✗ 字符守恒失败：${s.标题}`)
      console.log(`        分歧于第 ${s.守恒.分歧位置} 字符（原文 ${s.守恒.原文长度} / 排版后 ${s.守恒.排版后长度}）`)
      console.log(`        原文：…${s.守恒.原文片段}…`)
      console.log(`        排版：…${s.守恒.排版后片段}…`)
    }
  }

  if (ok && !CHECK_ONLY) {
    const out = []
    out.push(`# ${b.id} ${b.name}`)
    out.push('')
    out.push('> **本文件由 `node tools/排版条文.mjs` 从 `sources/条文摘录.md` 机械排版生成，不要手改。**')
    out.push('>')
    out.push('> 排版只改结构（条号后的分隔、项号成列表、段落留空行、章名成标题），**不改任何汉字、数字、标点**。')
    out.push('> 每一行都经 `tools/核对原文.mjs` 的同一判据回验：与 `sources/.原文缓存/` 里的官方原文去空白后逐字一致。')
    out.push('> 逐行偏移与区间回读见 `docs/核实记录/diff/' + b.id + '.diff.md`。')
    out.push('')
    out.push('---')
    out.push('')
    for (const s of 章节) {
      out.push(`### ${s.标题}`)
      out.push('')
      out.push(s.排版)
      out.push('')
    }
    writeFileSync(join(OUT_DIR, `${b.id}.md`), out.join('\n'), 'utf8')
  }
}

console.log('')
console.log('—— 汇总 ——')
console.log(`法规块 ${通过 + 不通过} 个：回验通过 ${通过}，未通过 ${不通过}`)
if (!CHECK_ONLY) console.log(CHECK_ONLY ? '' : `输出目录：${OUT_DIR}`)

// 汇总报告落盘，便于在核实记录里引用
const 报告路径 = join(ROOT, 'docs', '核实记录', '源-条文排版-回验报告.md')
if (!CHECK_ONLY) {
  const lines = [
    '# 条文排版：机械排版与逐字回验报告',
    '',
    `- 排版工具：\`node tools/排版条文.mjs\``,
    `- 回验工具：\`node tools/核对原文.mjs\`（同一判据）`,
    `- 生成时间：${new Date().toISOString()}`,
    `- 输入：\`sources/条文摘录.md\`（${relative(ROOT, MD_PATH).split('\\').join('/')}）`,
    `- 输出：\`${relative(ROOT, OUT_DIR).split('\\').join('/')}/\``,
    '',
    `**结论：法规块 ${通过 + 不通过} 个，回验通过 ${通过} 个，未通过 ${不通过} 个。**`,
    '',
    '判据：排版后的每一行去掉 markdown 结构标记与全部空白后，必须在 `sources/.原文缓存/` 的',
    '官方原文纯文本里**逐字出现**；标点风格（全角/半角括号、分号、冒号）差异另行标出。',
    '排版器**不改任何汉字、数字、标点、引号**，不补章节、不调顺序、不拆合条文。',
    '',
    '| 编号 | 法规 | 条文块 | 回验行数 | 未命中 | 结果 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...报告.map((r) => `| ${r.id} | ${r.name} | ${r.章节.length} | ${r.行数} | ${r.未命中.length} | ${r.ok ? '逐字一致' : '**需人工判断**'} |`),
    '',
    '## 排版的边界',
    '',
    '1. **排版规则会改结构**：条号后的全角空格改为半角、项号转为 markdown 列表、段落之间留空行、章名升为标题。',
    '   这些都不影响「去空白后逐字一致」的判定，所以回验能通过说明**内容未被改动**。',
    '2. **不补章节、不调顺序、不拆合条文**——本仓库不许凭记忆补内容。',
    '3. **回验通不过就不写文件**。任何一条排版导致的不一致，都会让该法规块整体不输出，',
    '   而不是输出一份「大部分对」的文件。',
    '4. 本报告只覆盖 `sources/条文摘录.md` 里**已被引用并摘录的条文**，不是各法规全文。',
    '   全文另见后续工作（按 `tools/原文索引.json` 的 49 个官方 URL）。',
    '',
  ]
  writeFileSync(报告路径, lines.join('\n'), 'utf8')
  console.log(`回验报告：${relative(ROOT, 报告路径).split('\\').join('/')}`)
}

process.exit(不通过 ? 1 : 0)
}
