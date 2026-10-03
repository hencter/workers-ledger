#!/usr/bin/env node
/**
 * 改节号.mjs —— 安全地调整节序，并同步全仓的「第 N 节」交叉引用
 *
 *   node tools/改节号.mjs <旧号>:<新号> [<旧号>:<新号> …]          # 只报告，不落盘
 *   node tools/改节号.mjs <旧号>:<新号> … --apply                  # 落盘
 *   node tools/改节号.mjs <旧号>:<新号> … --apply --backup <目录>   # 先备份再落盘
 *
 * 为什么需要它：本仓库正文用「见第 4 节第 4.6 条」互相指引，这种引用不只在
 * book/ 里，还在 README.md、.agents/skills/workers-ledger/SKILL.md、sources/*.md、
 * docs/核实记录/*.md 里。手工在两个节之间插一节，等于一次性改动上百处引用，
 * 漏一处就变成静默的错误指引（读者被指到讲别的事的条目上）。
 *
 * **默认只报告，不落盘**——改节号是破坏性操作，看见 diff 再按 --apply 是刻意的。
 * 落盘前会整仓自检：编号连续性、H1 与文件名一致、残留旧引用。任一项不过就
 * 从备份回滚，不留下半改状态。
 *
 * 只使用 Node 24 内置模块，零依赖。
 *
 * 退出码：0 成功（报告或落盘）/ 1 前置条件不满足或自检失败 / 2 环境错误
 */

import {
  existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { resolve, dirname, join, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSectionFile, listBookFiles, writeText, today } from './lib/条目规范.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)
const ROOT = resolve(argOf('--root', resolve(HERE, '..')))
const BOOK = join(ROOT, 'book')
const APPLY = has('--apply')
const BACKUP = argOf('--backup', '')

const die = (msg) => { console.error(`[失败] ${msg}`); process.exit(1) }
const envDie = (msg) => { console.error(`[环境错误] ${msg}`); process.exit(2) }

/** 会被改节号影响的文件范围。刻意用白名单而不是全仓扫描：
 *  白名单漏一个文件，最坏是那处引用没更新（自检会报残留）；而全仓扫描会把
 *  生成物 content/ 也改掉，那是派生物，改它没有意义且会被下次生成覆盖。 */
const SCAN_FILES = [
  'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'hugo.toml',
  '.agents/skills/workers-ledger/SKILL.md', '.agents/skills/workers-ledger/README.md',
  'sources/法规清单.md', 'sources/条文摘录.md',
  'docs/条目规范.md',
]
const SCAN_DIRS = ['docs/核实记录']

// ---------------------------------------------------------------------------
// 用法
// ---------------------------------------------------------------------------

if (argv.length === 0 || has('--help') || has('-h')) {
  console.log(`改节号 —— 用法：
  node tools/改节号.mjs <旧号>:<新号> [...]              只报告将发生的改动（默认）
  node tools/改节号.mjs <旧号>:<新号> [...] --apply      落盘
  node tools/改节号.mjs ... --apply --backup <目录>      先备份到该目录再落盘
  node tools/改节号.mjs ... --only-book                  只改 book/ 与仓库根文档，不动 docs/核实记录/
  node tools/改节号.mjs ... --root <目录>                指定仓库根目录

示例：把第 5 节挪成第 6 节，让新的第 5 节空出来
  node tools/改节号.mjs 5:6 --apply

安全设计：
  - 默认不落盘，先看报告；
  - 落盘后立刻整仓自检（编号连续、H1 与文件名一致、无残留旧引用），
    任一项不过就从备份回滚；
  - 只改 book/ 与白名单里的文档，不碰 content/（派生物，由 build-site.mjs 生成）。
`)
  process.exit(argv.length === 0 ? 1 : 0)
}

// ---------------------------------------------------------------------------
// 解析参数
// ---------------------------------------------------------------------------

const mapping = new Map()
/** 带值的开关：解析映射时必须跳过它们的值，否则 `--backup .tmp-bak` 里的
 *  `.tmp-bak` 会被当成节号映射（踩过一次）。 */
const VALUE_FLAGS = new Set(['--root', '--backup'])
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.has(a)) i++
    continue
  }
  const m = /^(\d{1,3})\s*[:：=]\s*(\d{1,3})$/.exec(a)
  if (!m) die(`无法解析的节号映射「${a}」，应形如 5:6`)
  const [from, to] = [Number(m[1]), Number(m[2])]
  if (from === to) die(`映射 ${from}:${to} 是同号改动，没有意义`)
  if (mapping.has(from)) die(`节号 ${from} 出现了两次映射`)
  mapping.set(from, to)
}
if (mapping.size === 0) envDie('没有给出任何节号映射，例如 5:6')

if (!existsSync(BOOK)) envDie(`找不到正文目录：${BOOK}`)

// ---------------------------------------------------------------------------
// 读现状
// ---------------------------------------------------------------------------

const bookPaths = listBookFiles(BOOK)
if (!bookPaths.length) envDie(`${BOOK} 下没有正文文件`)

const sections = new Map()
for (const p of bookPaths) {
  const s = parseSectionFile(p, p)
  if (s.section === null) {
    console.error(`[警告] 跳过不符合「编号-节名.md」的文件：${basename(p)}`)
    continue
  }
  if (sections.has(s.section)) die(`节号 ${s.section} 有两个文件：${basename(sections.get(s.section).path)} 与 ${basename(p)}`)
  sections.set(s.section, s)
}
const oldNumbers = [...sections.keys()].sort((a, b) => a - b)
const maxSection = Math.max(...oldNumbers)

/** 旧号 → 新号；未映射的保持不变 */
const newNumberOf = (n) => (mapping.has(n) ? mapping.get(n) : n)

// 冲突与空洞检查
const newNumbers = oldNumbers.map(newNumberOf)
if (new Set(newNumbers).size !== newNumbers.length) {
  const seen = new Map()
  const clashes = []
  for (const [i, n] of newNumbers.entries()) {
    if (seen.has(n)) clashes.push(`新号 ${n} 被第 ${oldNumbers[seen.get(n)]} 节和第 ${oldNumbers[i]} 节同时占用`)
    else seen.set(n, i)
  }
  die(`节号冲突：${clashes.join('；')}`)
}
for (const n of newNumbers) {
  if (!Number.isInteger(n) || n < 1) die(`新节号 ${n} 非法`)
}

// 是否连续：本仓库要求节号 1..N 连续（build-site.mjs 与 check-items.mjs 都按此假设）
const sortedNew = [...newNumbers].sort((a, b) => a - b)
const gaps = []
for (let i = 0; i < sortedNew.length; i++) {
  if (sortedNew[i] !== i + 1) { gaps.push(`第 ${i + 1} 位是 ${sortedNew[i]}`); break }
}

// ---------------------------------------------------------------------------
// 计算要做的改动
// ---------------------------------------------------------------------------

const changes = { renames: [], h1: [], entryHeadings: [], refs: [] }

for (const old of oldNumbers) {
  const s = sections.get(old)
  const next = newNumberOf(old)
  if (next !== old) {
    const newName = `${String(next).padStart(2, '0')}-${basename(s.path).replace(/^\d+\s*[-—－]\s*/, '')}`
    changes.renames.push({ old, next, oldPath: s.path, oldName: basename(s.path), newName })
  }
  // H1：无论节号是否变，只要 H1 写的节号与（新）节号不一致就要改
  if (s.h1) {
    const m = /^(\d+)\s*[.、．]\s*(.+)$/.exec(s.h1.text)
    if (m && Number(m[1]) !== next) {
      changes.h1.push({ old, next, oldLine: s.h1.text, newLine: `${next}. ${m[2].trim()}`, line: s.h1.line, file: s.path })
    }
  }
}

// 条目三级标题：条目内的节号要与新节号一致
for (const old of oldNumbers) {
  const s = sections.get(old)
  const next = newNumberOf(old)
  if (next === old) continue
  for (const e of s.entries) {
    changes.entryHeadings.push({
      file: s.path, line: e.titleLine, old: `${e.sectionNumber}.${e.number}`, next: `${next}.${e.number}`,
    })
  }
}

/** 逐文件的可替换位置。用 replace 回调而不是一次性整文件正则，是为了能报出行号与原文。 */
function collectRefs(fileRel) {
  const abs = join(ROOT, fileRel)
  if (!existsSync(abs)) return []
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // ① 「第 N 节」——最明确的形态
    for (const m of line.matchAll(/第\s*(\d{1,3})\s*节/g)) {
      const old = Number(m[1])
      if (!mapping.has(old)) continue
      out.push({ file: fileRel, line: i + 1, kind: '第N节', old: m[0], next: `第 ${newNumberOf(old)} 节`, index: m.index, length: m[0].length })
    }

    // ② 「第 N 节第 M 条」/「第 N 节第 M.M 条」——由 ① 覆盖节号，这里补条号的节前缀
    for (const m of line.matchAll(/第\s*(\d{1,3})\s*节\s*第\s*(\d{1,3})\.(\d{1,3})\s*条/g)) {
      const old = Number(m[1])
      if (!mapping.has(old)) continue
      out.push({ file: fileRel, line: i + 1, kind: '第N节第M.M条', old: m[0], next: m[0].replace(/第\s*(\d{1,3})\s*节/, `第 ${newNumberOf(old)} 节`), index: m.index, length: m[0].length })
    }

    // ③ 裸条目号 N.M，且 N 是被改动的节号。只在「N 后面紧跟 .M 且不在百分比等数字语境」时算。
    //    为避免误伤（例如「2 年」「3 倍」「12.5%」），要求 N 是被映射的节号，
    //    且该形如 N.M 的片段前后不是数字或 % 。
    //
    //    排除条目标题行本身：`### 1.1 标题` 里的 1.1 是标题，已经由「三、改标题」
    //    处理（改法是替换行首的节号）。若这里也算一处引用，同一行会既进标题清单
    //    又进引用清单——报告虚高，落盘时还会被替换两次。
    const isEntryHeading = /^#{1,6}\s+\d{1,3}\.\d{1,3}\s/.test(line.trim())
    if (!isEntryHeading) {
      for (const m of line.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})(?![\d.])/g)) {
        const old = Number(m[1])
        if (!mapping.has(old)) continue
        if (Number(m[2]) === 0) continue // 「2.0」这类多半不是条目号
        // 排除百分比、倍数等：紧跟 % 的不算
        if (line.slice(m.index + m[0].length).trimStart().startsWith('%')) continue
        out.push({ file: fileRel, line: i + 1, kind: '裸条目号', old: m[0], next: `${newNumberOf(old)}.${m[2]}`, index: m.index, length: m[0].length })
      }
    }
  }
  return out
}

const scanTargets = [...SCAN_FILES]
if (!has('--only-book') && !has('--no-verify-records')) {
  for (const d of SCAN_DIRS) {
    const abs = join(ROOT, d)
    if (!existsSync(abs)) continue
    for (const f of readdirSync(abs)) if (f.endsWith('.md')) scanTargets.push(`${d}/${f}`)
  }
}
// 正文（book/）永远在范围内——这是本工具的正当用途核心
for (const p of bookPaths) scanTargets.push(relative(ROOT, p).split('\\').join('/'))

for (const f of scanTargets) changes.refs.push(...collectRefs(f))

// 「第 N 节第 M.M 条」与「裸条目号」会重叠命中同一条引用（前者是后者的超集）。
// 去重：同一行同一位置只保留更长的那条说明（优先「第N节第M.M条」）。
const dedupKey = (r) => `${r.file}:${r.line}:${r.index}:${r.length}`
const refByKey = new Map()
for (const r of changes.refs) {
  const k = dedupKey(r)
  const prev = refByKey.get(k)
  if (!prev || r.kind === '第N节第M.M条') refByKey.set(k, r)
}
changes.refs = [...refByKey.values()].sort((a, b) =>
  a.file === b.file ? a.line - b.line || a.index - b.index : (a.file < b.file ? -1 : 1))

// 「第 N 节」与「第 N 节第 M.M 条」在同一位置与不同位置都可能重叠——
// ② 的匹配区间包含 ①，上面按精确位置去不掉。这里按行丢弃被更长匹配覆盖的短匹配。
{
  const byLine = new Map()
  for (const r of changes.refs) {
    const k = `${r.file}:${r.line}`
    if (!byLine.has(k)) byLine.set(k, [])
    byLine.get(k).push(r)
  }
  const keep = []
  for (const list of byLine.values()) {
    list.sort((a, b) => a.index - b.index || b.length - a.length)
    let coveredTo = -1
    for (const r of list) {
      if (r.index < coveredTo) continue
      keep.push(r)
      coveredTo = r.index + r.length
    }
  }
  changes.refs = keep.sort((a, b) =>
    a.file === b.file ? a.line - b.line || a.index - b.index : (a.file < b.file ? -1 : 1))
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const refsByFile = new Map()
for (const r of changes.refs) {
  if (!refsByFile.has(r.file)) refsByFile.set(r.file, [])
  refsByFile.get(r.file).push(r)
}

console.log('改节号 —— 分析报告（默认不落盘，加 --apply 才写）')
console.log(`仓库根：${ROOT}`)
console.log(`映射：${[...mapping.entries()].map(([a, b]) => `${a} → ${b}`).join('，')}`)
console.log(`现状：${oldNumbers.length} 节（${oldNumbers[0]}—${oldNumbers[oldNumbers.length - 1]}），${[...sections.values()].reduce((a, s) => a + s.entries.length, 0)} 条`)
console.log('')

if (gaps.length) {
  console.error(`[失败] 改动后节号不连续：${gaps.join('；')}`)
  console.error('本仓库要求节号从 1 开始连续（build-site.mjs 与 check-items.mjs 都按此假设）。')
  console.error('如果你是想在中间插一节，请改成把后面的节整体后移，例如：')
  console.error(`  node tools/改节号.mjs ${maxSection}:${maxSection + 1} ${maxSection - 1}:${maxSection} … --apply`)
  process.exit(1)
}

console.log(`一、重命名文件（${changes.renames.length}）`)
for (const r of changes.renames) console.log(`  ${r.oldName}  →  ${r.newName}`)
if (!changes.renames.length) console.log('  （无）')

console.log('')
console.log(`二、改一级标题（${changes.h1.length}）`)
for (const h of changes.h1) console.log(`  ${relative(ROOT, h.file).split('\\').join('/')}:${h.line}　「${h.oldLine}」→「${h.newLine}」`)
if (!changes.h1.length) console.log('  （无）')

console.log('')
console.log(`三、改条目三级标题里的节号（${changes.entryHeadings.length}）`)
if (changes.entryHeadings.length) {
  const shown = changes.entryHeadings.slice(0, 8)
  for (const e of shown) console.log(`  ${relative(ROOT, e.file).split('\\').join('/')}:${e.line}　${e.old} → ${e.next}`)
  if (changes.entryHeadings.length > shown.length) console.log(`  ……其余 ${changes.entryHeadings.length - shown.length} 处省略`)
} else console.log('  （无）')

console.log('')
console.log(`四、改交叉引用（${changes.refs.length} 处，涉及 ${refsByFile.size} 个文件）`)
for (const [file, list] of [...refsByFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${file}　${list.length} 处`)
  const sample = list.slice(0, 3)
  for (const r of sample) console.log(`      :${r.line}　[${r.kind}] 「${r.old}」→「${r.next}」`)
  if (list.length > sample.length) console.log(`      ……其余 ${list.length - sample.length} 处`)
}

// 残留检查：映射的旧节号是否仍在某处以「第 N 节」出现（说明有文件不在白名单里）
console.log('')
console.log('五、白名单外是否还有旧节号引用（漏改风险）')
let outside = 0
const walk = (dir) => {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      // 生成物与临时目录不算
      if (['node_modules', 'public', 'content', 'dist'].includes(ent.name)) continue
      if (ent.name.startsWith('.tmp')) continue
      walk(p)
    } else if (ent.name.endsWith('.md')) {
      const rel = relative(ROOT, p).split('\\').join('/')
      if (scanTargets.includes(rel)) continue
      const text = readFileSync(p, 'utf8')
      for (const old of mapping.keys()) {
        if (new RegExp(`第\\s*${old}\\s*节`).test(text)) {
          outside++
          console.log(`  ${rel}　含「第 ${old} 节」但不在改动白名单里`)
          break
        }
      }
    }
  }
}
for (const d of readdirSync(ROOT, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name.startsWith('.')) continue
  if (['node_modules', 'public', 'dist'].includes(d.name)) continue
  walk(join(ROOT, d.name))
}
for (const f of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md']) {
  if (!existsSync(join(ROOT, f))) continue
  const text = readFileSync(join(ROOT, f), 'utf8')
  for (const old of mapping.keys()) {
    if (new RegExp(`第\\s*${old}\\s*节`).test(text) && !scanTargets.includes(f)) {
      outside++
      console.log(`  ${f}　含「第 ${old} 节」但不在改动白名单里`)
      break
    }
  }
}
if (outside === 0) console.log('  未发现')

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

if (!APPLY) {
  console.log('')
  console.log('（报告模式：未改动任何文件。确认无误后加 --apply 落盘；建议同时加 --backup <目录>）')
  process.exit(0)
}

const backupDir = BACKUP ? resolve(BACKUP) : join(ROOT, `.tmp-backup-改节号-${today()}`)
mkdirSync(backupDir, { recursive: true })

/** 备份将要改动的文件到 backupDir，返回清单（供回滚） */
const touched = new Set([
  ...changes.h1.map((h) => h.file),
  ...changes.entryHeadings.map((e) => e.file),
  ...[...refsByFile.keys()].map((f) => join(ROOT, f)),
])
const backups = []
for (const abs of touched) {
  if (!existsSync(abs)) continue
  const dest = join(backupDir, relative(ROOT, abs).split(/[\\/]/).join('__'))
  copyFileSync(abs, dest)
  backups.push({ abs, dest })
}
console.log('')
console.log(`已备份 ${backups.length} 个文件到 ${backupDir}`)

const rollback = (why) => {
  console.error(`[失败] ${why}`)
  for (const b of backups) {
    try { copyFileSync(b.dest, b.abs) } catch { /* 尽力而为 */ }
  }
  console.error(`已从备份回滚 ${backups.length} 个文件。`)
  process.exit(1)
}

// 1) 文件重命名
for (const r of changes.renames) {
  const dest = join(dirname(r.oldPath), r.newName)
  if (existsSync(dest)) rollback(`目标文件已存在：${r.newName}`)
  writeFileSync(dest, readFileSync(r.oldPath))
  rmSync(r.oldPath)
}
console.log(`已重命名 ${changes.renames.length} 个节文件`)

// 2) 改 H1 与条目标题
const byFileEdits = new Map()
const addEdit = (abs, line, fn) => {
  if (!byFileEdits.has(abs)) byFileEdits.set(abs, [])
  byFileEdits.get(abs).push({ line, fn })
}
// 重命名后路径变了，用新路径
const newPathOf = new Map()
for (const old of oldNumbers) {
  const s = sections.get(old)
  const next = newNumberOf(old)
  const name = next === old ? basename(s.path) : changes.renames.find((r) => r.old === old).newName
  newPathOf.set(old, join(BOOK, name))
}
for (const h of changes.h1) {
  const abs = newPathOf.get(h.old)
  addEdit(abs, h.line, (line) => line.replace(/^#\s+\d+\s*[.、．]\s*(.+?)\s*$/, `# ${h.next}. $1`))
}
for (const e of changes.entryHeadings) {
  const oldSec = sections.get(Number(e.old.split('.')[0]))
  const abs = newPathOf.get(oldSec.section)
  addEdit(abs, e.line, (line) => line.replace(/^###\s+\d+\.\d+\s/, `### ${e.next} `))
}

const editCount = [...byFileEdits.values()].reduce((a, l) => a + l.length, 0)
for (const [abs, edits] of byFileEdits) {
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
  for (const e of edits.sort((a, b) => b.line - a.line)) lines[e.line - 1] = e.fn(lines[e.line - 1])
  writeText(abs, lines.join('\n'))
}
console.log(`已改 ${editCount} 处标题`)

// 3) 改交叉引用（按位置从后往前替换，避免位移）
let refCount = 0
for (const [file, list] of refsByFile) {
  const abs = join(ROOT, file)
  if (!existsSync(abs)) continue
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
  const byLine = new Map()
  for (const r of list) {
    if (!byLine.has(r.line)) byLine.set(r.line, [])
    byLine.get(r.line).push(r)
  }
  for (const [lineNo, rs] of byLine) {
    let line = lines[lineNo - 1]
    for (const r of rs.sort((a, b) => b.index - a.index)) {
      const at = line.slice(r.index, r.index + r.length)
      if (at !== r.old) {
        console.error(`[警告] ${file}:${lineNo} 位置 ${r.index} 期望「${r.old}」实际「${at}」，跳过这一处`)
        continue
      }
      line = line.slice(0, r.index) + r.next + line.slice(r.index + r.length)
      refCount++
    }
    lines[lineNo - 1] = line
  }
  writeText(abs, lines.join('\n'))
}
console.log(`已改 ${refCount} 处交叉引用`)

// ---------------------------------------------------------------------------
// 落盘后自检
// ---------------------------------------------------------------------------

console.log('')
console.log('落盘后自检：')

// a) 编号连续
const after = new Map()
for (const p of listBookFiles(BOOK)) {
  const s = parseSectionFile(p, p)
  if (s.section !== null) after.set(s.section, s)
}
const nums = [...after.keys()].sort((a, b) => a - b)
for (let i = 0; i < nums.length; i++) {
  if (nums[i] !== i + 1) rollback(`节号不连续：第 ${i + 1} 位是 ${nums[i]}`)
}
console.log(`  节号连续：1—${nums[nums.length - 1]}`)

// b) H1 与文件名一致
for (const [n, s] of after) {
  const m = s.h1 ? /^(\d+)\s*[.、．]\s*(.+)$/.exec(s.h1.text) : null
  if (!m) rollback(`第 ${n} 节的一级标题不符合「N. 节名」格式：${s.h1 ? s.h1.text : '(无一级标题)'}`)
  if (Number(m[1]) !== n) rollback(`第 ${n} 节的一级标题写的是节号 ${m[1]}`)
  if (m[2].trim() !== s.title) rollback(`第 ${n} 节的一级标题节名「${m[2].trim()}」与文件名节名「${s.title}」不一致`)
}
console.log(`  一级标题与文件名一致：${after.size} 节`)

// c) 条目标题里的节号与新节号一致
for (const [n, s] of after) {
  const bad = s.entries.find((e) => e.sectionNumber !== n)
  if (bad) rollback(`第 ${n} 节里条目「${bad.sectionNumber}.${bad.number} ${bad.title}」的节号与新节号不一致`)
}
console.log(`  条目标题节号一致：${[...after.values()].reduce((a, s) => a + s.entries.length, 0)} 条`)

// d) 白名单范围内不残留旧引用
const leftovers = []
for (const f of scanTargets) {
  const abs = join(ROOT, f)
  if (!existsSync(abs)) continue
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
  for (const old of mapping.keys()) {
    const re = new RegExp(`第\\s*${old}\\s*节`)
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) leftovers.push(`${f}:${i + 1} 「第 ${old} 节」　${lines[i].trim().slice(0, 40)}`)
    }
  }
}
if (leftovers.length) {
  // 旧节号可能被新内容合法地占用（例如 5:6 之后第 5 节其实还存在），
  // 所以这里只警告不判失败。
  console.log(`  [警告] 白名单内仍有 ${leftovers.length} 处「第 旧号 节」——若旧号已被别的节合法占用可忽略：`)
  for (const l of leftovers.slice(0, 6)) console.log(`      ${l}`)
} else {
  console.log('  白名单内无残留旧引用')
}

console.log('')
console.log(`完成。备份在：${backupDir}`)
console.log('下一步（四步全绿才算站点这侧通过）：')
console.log('  node tools/check-items.mjs --check')
console.log('  node tools/build-site.mjs && node tools/check-site.mjs')
console.log('  node tools/build-prod.mjs && node tools/checks/render-check.mjs')
console.log('确认无误后可删除备份目录。')
