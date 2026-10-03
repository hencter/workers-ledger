#!/usr/bin/env node
/**
 * 新建条目.mjs —— 按 docs/条目规范.md 的模板长出合规的新条目 / 新节
 *
 *   node tools/新建条目.mjs <节号> "条目标题"
 *   node tools/新建条目.mjs <节号> "条目标题" --after 12
 *   node tools/新建条目.mjs --new-section "节标题"
 *   node tools/新建条目.mjs <节号> "条目标题" --dry-run
 *
 * 为什么需要它：新增条目要同时满足一堆彼此牵连的约束——13 个字段一个不少、
 * 字段顺序固定、编号在节内连续、成本标签五项齐全、节名要与文件名对齐。
 * 手工写错一个，要跑到 `node tools/check-items.mjs` 才知道。本工具把「模板」
 * 这一步自动化：**新条目一出生就是结构合规的**，剩下的是内容质量，不是格式。
 *
 * 设计前提（与 build-site.mjs 一致）：book/ 是唯一真相源。本工具**只写 book/**，
 * 绝不写 content/（那是派生物，由 build-site.mjs 生成，手改会被下次生成抹掉）。
 * 同理，Hugo 的 `hugo new` 也不能用来写正文——它只能往 content/ 里写，
 * 而那里每次构建都被整体重建。这也是本仓库不需要 `archetypes/` 的原因（已于 2026-10-04 删除）。
 *
 * 新条目的占位取值一律是「待核实」——按 AGENTS.md 底线一，追不到官方原文时
 * 标「待核实」是正确行为；但它是**中间态，不得随版本发布**，落盘后会一直在
 * 看板与 check-items 的「未定稿」里亮着，直到你追到原文。
 *
 * 只使用 Node 24 内置模块，零依赖。
 *
 * 退出码：0 成功 / 1 参数或前置条件不满足 / 2 环境错误
 */

import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseSectionFile, listBookFiles, renderEntry, renderSection,
  safeSlug, today, lintEntry, entryLabel, writeText, REQUIRED_FIELDS,
} from './lib/条目规范.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BOOK = join(ROOT, 'book')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)
const DRY = has('--dry-run')
const NEW_SECTION = has('--new-section')
const AFTER = argOf('--after', '') ? Number(argOf('--after', '')) : null

/** 去掉 --flag value 这类参数，剩下的位置参数即节号与标题 */
function positionals() {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      if (['--after', '--section-title', '--title'].includes(a)) i++
      continue
    }
    out.push(a)
  }
  return out
}

const die = (msg) => { console.error(`[失败] ${msg}`); process.exit(1) }
const envDie = (msg) => { console.error(`[环境错误] ${msg}`); process.exit(2) }

/** 「插入后自检失败」这一类错误的统一出口：先把文件改回原样，再退出。
 * 本工具不自动修复编号——一旦它认为写入结果不对，正确做法是原样退回、
 * 由人先跑 check-items.mjs 看清既有问题，而不是替人猜一个编号。 */
function rollbackAndDie(section, msg) {
  if (section) writeText(section.path, section.lines.join('\n'))
  console.error(`[失败] ${msg}`)
  console.error('已把文件改回写入前的内容。建议先跑 node tools/check-items.mjs --check 看清既有问题再重试。')
  process.exit(1)
}

if (!existsSync(BOOK)) envDie(`找不到正文目录：${BOOK}`)

const bookFiles = listBookFiles(BOOK)
if (!bookFiles.length) envDie(`${BOOK} 下没有正文文件`)

/** 读全部节，建立节号 → 文件 的索引 */
function loadSections() {
  const map = new Map()
  for (const p of bookFiles) {
    const s = parseSectionFile(p, p)
    if (s.section === null) continue
    map.set(s.section, s)
  }
  return map
}

const sections = loadSections()
const maxSection = Math.max(...sections.keys())

function reportLint(entry) {
  const issues = lintEntry(entry)
  const errors = issues.filter((i) => i.level === '错误')
  const warns = issues.filter((i) => i.level === '警告')
  for (const w of warns) console.log(`  [警告] ${w.message}`)
  if (errors.length) {
    for (const e of errors) console.error(`  [错误] ${e.message}`)
    die(`模板自检不通过（${errors.length} 项）——这是本工具的缺陷，请把上面的输出连同命令一起报给维护者`)
  }
}

// ---------------------------------------------------------------------------
// 用法
// ---------------------------------------------------------------------------

if (argv.length === 0 || has('--help') || has('-h')) {
  console.log(`新建条目 —— 用法：
  node tools/新建条目.mjs <节号> "条目标题"              追加到该节末尾
  node tools/新建条目.mjs <节号> "条目标题" --after <编号>  插到该条之后（节内重新连续编号）
  node tools/新建条目.mjs --new-section "节标题"          新建一节（节号为当前最大节号 + 1）
  node tools/新建条目.mjs ... --dry-run                  只打印将写入的内容，不落盘

现有节（共 ${sections.size} 节）：
${[...sections.entries()].sort((a, b) => a[0] - b[0]).map(([n, s]) => `  ${String(n).padStart(2)}  ${s.title}（${s.entries.length} 条）`).join('\n')}

说明：新条目的 13 个字段会以「待核实」占位生成。这是**中间态，不得随版本发布**——
按 AGENTS.md 底线一，追不到官方原文时标「待核实」是正确行为，但结项前必须追到原文，
或改写为「无明文依据 + 倡导性」。落盘后它会一直在看板与 check-items 里亮着，直到你处理。
写完后跑：node tools/check-items.mjs --check
`)
  process.exit(argv.length === 0 ? 1 : 0)
}

// ---------------------------------------------------------------------------
// 新建一节
// ---------------------------------------------------------------------------

if (NEW_SECTION) {
  const title = argOf('--new-section', '').trim()
  if (!title || title.startsWith('--')) die('--new-section 后面要跟节标题，例如 --new-section "试用期陷阱"')
  const number = maxSection + 1
  if (sections.has(number)) die(`节号 ${number} 已被占用`)

  const file = `${String(number).padStart(2, '0')}-${safeSlug(title)}.md`
  const target = join(BOOK, file)
  if (existsSync(target)) die(`文件已存在：${target}`)

  const entry = { number: 1, title: '待核实——第一条的标题（说清这一条解决什么问题）' }
  const text = renderSection({ number, title }, entry, { todayOverride: today() })

  // 模板自检要**校验真正生成的内容**，不能拿手写的假条目顶替：
  // 假条目里的替身取值（例如 'x'）不是合法枚举，会报出根本不存在的问题。
  // 这里把生成文本落到系统临时目录再解析回来，校验的就是将要写入的那份内容。
  const tmpDir = mkdtempSync(join(tmpdir(), 'newsection-'))
  const tmpFile = join(tmpDir, `${String(number).padStart(2, '0')}-${safeSlug(title)}.md`)
  try {
    writeText(tmpFile, text)
    const parsed = parseSectionFile(tmpFile, tmpFile)
    const generated = parsed.entries[0]
    if (!generated) die('模板自检：生成的内容里解析不到条目——这是本工具的缺陷，请报给维护者')
    reportLint(generated)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`将新建第 ${number} 节：${title}`)
  console.log(`  文件：book/${file}`)
  console.log(`  首个条目编号：${number}.1（占位标题，需你改）`)
  if (!DRY) {
    writeText(target, text)
    console.log(`\n已写入。接下来：`)
    console.log(`  1. 编辑 book/${file}，把占位标题和 13 个字段的「待核实」逐项落实`)
    console.log(`  2. node tools/check-items.mjs --check`)
    console.log(`  3. node tools/build-site.mjs  （生成站点内容与索引）`)
    console.log(`  注意：README.md 与 .agents/skills/ 里若写死了「N 节 N 条」，要同步改（跑 node tools/看板.mjs 的第五节会对账）`)
  } else {
    console.log(`\n[--dry-run] 未落盘。将写入的内容：\n`)
    console.log(text)
  }
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 新建条目
// ---------------------------------------------------------------------------

const pos = positionals()
if (pos.length < 2) die(`参数不足。用法：node tools/新建条目.mjs <节号> "条目标题"（现有节：${[...sections.keys()].sort((a, b) => a - b).join('、')}）`)
const sectionNumber = Number(pos[0])
const title = pos.slice(1).join(' ').trim()

if (!Number.isInteger(sectionNumber) || !sections.has(sectionNumber)) {
  die(`节号 ${pos[0]} 不存在。现有节：${[...sections.keys()].sort((a, b) => a - b).join('、')}`)
}
if (!title) die('条目标题不能为空')

const section = sections.get(sectionNumber)
let insertAt = section.entries.length // 默认追加到末尾
if (AFTER !== null) {
  if (!Number.isInteger(AFTER) || AFTER < 1 || AFTER > section.entries.length) {
    die(`--after 必须是 1 到 ${section.entries.length} 之间的编号（第 ${sectionNumber} 节现有 ${section.entries.length} 条）`)
  }
  insertAt = AFTER
}

// 节内的目标编号：追加=末尾+1；插入=被插入位置的新编号
const targetNumber = AFTER !== null ? AFTER + 1 : section.entries.length + 1

/**
 * `--block <文件>`：直接用文件里已经渲染好的条目块，而不是用内置模板重新渲染。
 *
 * 存在的理由：让「块内容」与「放置」分开——本工具负责**放置**（编号、连续性、
 * 写后自检、回滚），调用方负责**块内容**，职责不重叠。
 * （原先还有第二个模板来源：Hugo archetype + tools/新建条目-archetype.mjs，
 * 两者已于 2026-10-04 一并删除，现在条目模板只有 tools/lib/条目规范.mjs 一个来源。）
 *
 * 传入的块若已有三级标题，其条号会被重写成目标编号——只改编号，不动其余文字。
 */
const BLOCK_FILE = argOf('--block', '')
let 外部块 = null
if (BLOCK_FILE) {
  if (!existsSync(BLOCK_FILE)) die(`--block 指定的文件不存在：${BLOCK_FILE}`)
  const raw = readFileSync(BLOCK_FILE, 'utf8').replace(/\r\n/g, '\n').trim()
  if (!/^###\s+\d+\.\d+\s+/m.test(raw)) die(`--block 文件里找不到形如「### 节号.条号 标题」的三级标题：${BLOCK_FILE}`)
  外部块 = raw.replace(/^###\s+\d+\.\d+\s+/, `### ${sectionNumber}.${targetNumber} `)
}

// 节内必须连续：若原编号本身不连续，先拒绝，避免把既有问题改得更乱
const nums = section.entries.map((e) => e.number)
for (let i = 0; i < nums.length; i++) {
  if (nums[i] !== i + 1) die(`第 ${sectionNumber} 节的既有编号不连续（第 ${i + 1} 个位置的编号是 ${nums[i]}）。请先修好既有编号，或跑 node tools/check-items.mjs 看详情`)
}

const lines = section.lines.slice()

/** 生成条目文本：有外部块（--block）就用外部块，否则用内置模板渲染 */
const 条目文本 = () => (外部块
  ? `${外部块.split('\n').join('\n')}\n`
  : renderEntry({ sectionNumber, number: targetNumber, title }))

if (AFTER === null) {
  // 追加：在文件末尾补一个分隔线 + 新条目
  const tail = lines.length && lines[lines.length - 1].trim() !== '' ? [''] : []
  lines.push(...tail, '---', '', ...条目文本().split('\n'))
} else {
  // 插入：从被插入条目之后、到下一个条目标题之前的位置切开。
  // 目标条目（AFTER）的块区间是 [startLine, endLine)（1 基，endLine 为下一标题行）。
  const anchor = section.entries[AFTER - 1]
  const cutIdx = anchor.endLine - 1 // 0 基索引：下一个标题行（或文件末）
  // 从锚点之后的块尾往上退，退掉空白，保留分隔线结构
  let back = cutIdx
  while (back > anchor.startLine && lines[back - 1].trim() === '') back--
  const before = lines.slice(0, back)
  const after = lines.slice(back)
  const block = ['', '---', '', ...条目文本().split('\n')]
  // 改名必须在拼接之后、按**位移后的真实行号**做。
  //
  // 这里踩过一次坑：先按旧行号（entry.titleLine）改名，而插入点就在这些行之前，
  // 于是每条都改错了一行——插入位置之后的第一条根本没被改名，它的编号变成了重复的。
  // 所以先把原行号 → 新行号算清楚，再从后往前改名（从后往前是为了避免替换
  // `### 1.4 ` 时误伤还没处理的 `### 1.40 `，虽然当前每节不足 100 条，仍按安全序做）。
  lines.length = 0
  lines.push(...before, ...block, ...after)

  const firstMovedIdx = back + block.length
  const moved = section.entries
    .filter((e) => e.number >= targetNumber)
    .map((e) => ({
      number: e.number,
      newNumber: e.number + 1,
      newIdx: firstMovedIdx + (e.titleLine - 1 - back),
    }))
    .sort((a, b) => b.newIdx - a.newIdx)

  for (const m of moved) {
    const idx = m.newIdx
    if (idx < 0 || idx >= lines.length) {
      rollbackAndDie(section, `插入后定位标题行失败（编号 ${sectionNumber}.${m.number} 落到第 ${idx + 1} 行，文件共 ${lines.length} 行）`)
    }
    const titleLine = lines[idx]
    if (!new RegExp(`^###\\s+${sectionNumber}\\.${m.number}\\s`).test(titleLine)) {
      rollbackAndDie(section, `插入后第 ${idx + 1} 行不是预期的「### ${sectionNumber}.${m.number} 」标题，实为：${titleLine.slice(0, 60)}`)
    }
    lines[idx] = titleLine.replace(
      new RegExp(`^###\\s+${sectionNumber}\\.${m.number}\\s`),
      `### ${sectionNumber}.${m.newNumber} `,
    )
  }
}

const newText = lines.join('\n')

// 落盘前：对将写入的结果整体重解析 + 预检，确认节内编号连续、字段齐备
if (!DRY) {
  writeText(section.path, newText)
  const check = parseSectionFile(section.path, section.path)
  const after2 = check.entries.map((e) => e.number)
  let bad = null
  for (let i = 0; i < after2.length; i++) {
    if (after2[i] !== i + 1) { bad = `第 ${i + 1} 个位置的编号是 ${after2[i]}（应为 ${i + 1}）`; break }
  }
  if (bad) {
    console.error(`[失败] 写入后编号不连续：${bad}`)
    console.error('已把文件改回写入前的内容（本工具只做一次性写入，不做自动修复）。')
    console.error('建议：先跑 node tools/check-items.mjs --check 看清既有问题，再重试。')
    writeText(section.path, section.lines.join('\n'))
    process.exit(1)
  }
  const added = check.entries.find((e) => e.title === title)
  if (added) {
    console.log(`已写入：${section.path}`)
    console.log(`  条目 ${sectionNumber}.${added.number}　${title}`)
    console.log('')
    console.log('结构预检：')
    reportLint(added)
  }
  console.log('')
  console.log('请注意：新条目的字段值是「待核实」占位，属于未定稿，不得随版本发布。')
  console.log('下一步：')
  console.log(`  1. 编辑 book/${section.file || basename(section.path)}，把 13 个字段逐项落实到官方原文`)
  console.log('  2. node tools/check-items.mjs --check')
  console.log('  3. node tools/build-site.mjs && node tools/check-site.mjs')
  process.exit(0)
}

console.log(`[--dry-run] 未落盘。将在第 ${sectionNumber} 节${AFTER !== null ? `第 ${AFTER} 条之后` : '末尾'}插入条目 ${sectionNumber}.${targetNumber}：`)
console.log('')
console.log(条目文本())
console.log(`（写入后该节共 ${section.entries.length + 1} 条）`)
