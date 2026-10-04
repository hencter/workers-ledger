#!/usr/bin/env node
// 生成哨兵：比对 book/ 原文与 data/entries.json 的每一个字段。
//
//   node tools/check-site.mjs
//
// 为什么需要它：content/ 是生成产物，不跟着源码一起被审阅。如果没有这道比对，
// 生成脚本漏读、截断或改写字段时，阅读正文的人不会发现，站点上的内容却已经和
// 正文不一致了。这里直接从 book/*.md 独立解析一遍，逐字段与索引对账。
//
// 退出码：0 一致 / 1 有差异 / 2 环境错误

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BOOK_DIR = join(ROOT, 'book')
const INDEX = join(ROOT, 'data', 'entries.json')

if (!existsSync(INDEX)) {
  console.error(`[环境错误] 找不到站点索引：${INDEX}\n先跑 node tools/build-site.mjs`)
  process.exit(2)
}

const FIELDS = [
  '适用', '成本', '收益', '依据', '效力位阶', '主张强度',
  '举证难度', '地域', '时效', '来源', '核对日期', '备注',
]

const norm = (s) => String(s ?? '')
  .replace(/<((?:https?:\/\/)[^>\s]+)>/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\s+/g, '')
  .trim()

/** 独立重解析一遍原文。刻意不复用 build-site.mjs 的代码——复用会让两边同时错。 */
function parseBook() {
  const out = []
  for (const name of readdirSync(BOOK_DIR).filter((f) => f.endsWith('.md')).sort()) {
    const secM = /^(\d+)[-—－](.+)\.md$/.exec(name)
    if (!secM) continue
    const lines = readFileSync(join(BOOK_DIR, name), 'utf8').split(/\r?\n/)
    const marks = []
    for (let i = 0; i < lines.length; i++) {
      const m = /^###\s+(\d+)\.(\d+)\s+(.+?)\s*$/.exec(lines[i])
      if (m) marks.push({ index: i, sec: Number(m[1]), num: Number(m[2]), title: m[3].trim() })
    }
    for (let k = 0; k < marks.length; k++) {
      const cur = marks[k]
      const end = k + 1 < marks.length ? marks[k + 1].index : lines.length
      const fields = {}
      const tag = {}
      for (const line of lines.slice(cur.index + 1, end)) {
        const t = /<!--\s*成本标签\s*[:：]\s*(.+?)\s*-->/.exec(line)
        if (t) {
          for (const pair of t[1].split(/\s+/)) {
            const kv = /^([^=]+)=(.+)$/.exec(pair)
            if (kv) tag[kv[1].trim()] = kv[2].trim()
          }
          continue
        }
        const m = /^-\s*([^：:]{1,12})[：:]\s*(.*)$/.exec(line.trim())
        if (!m) continue
        const n = m[1].trim()
        if (![...FIELDS, '说人话'].includes(n)) continue
        fields[n] = fields[n] ? `${fields[n]} ${m[2].trim()}` : m[2].trim()
      }
      out.push({ 节号: Number(secM[1]), 节名: secM[2].trim(), 条号: cur.num, 标题: cur.title, fields, tag })
    }
  }
  return out
}

const expected = parseBook()
const index = JSON.parse(readFileSync(INDEX, 'utf8'))

const diffs = []
if (expected.length !== index.length) {
  diffs.push(`条目数不一致：原文 ${expected.length} 条，索引 ${index.length} 条`)
}

// 索引按节号+条号建键；重复键说明生成端有覆盖或重复
const key = (e) => `${e.节号}.${e.条号}`
const seen = new Set()
for (const e of index) {
  const k = key(e)
  if (seen.has(k)) diffs.push(`索引中键重复：${k}`)
  seen.add(k)
}

const idxByKey = new Map(index.map((e) => [key(e), e]))
for (const exp of expected) {
  const k = key(exp)
  const got = idxByKey.get(k)
  if (!got) { diffs.push(`索引缺少条目：${k} ${exp.标题}`); continue }
  if (norm(got.标题) !== norm(exp.标题)) {
    diffs.push(`${k} 标题不一致：原文「${exp.标题}」索引「${got.标题}」`)
  }
  for (const f of FIELDS) {
    if (norm(got[f]) !== norm(exp.fields[f])) {
      diffs.push(`${k} 字段「${f}」不一致\n    原文：${(exp.fields[f] || '(空)').slice(0, 120)}\n    索引：${(got[f] || '(空)').slice(0, 120)}`)
    }
  }
  if (norm(got.说人话) !== norm(exp.fields['说人话'])) {
    diffs.push(`${k} 字段「说人话」不一致`)
  }
  const tagKeys = new Set([...Object.keys(exp.tag), ...Object.keys(got.成本标签 || {})])
  for (const tk of tagKeys) {
    if (exp.tag[tk] !== (got.成本标签 || {})[tk]) {
      diffs.push(`${k} 成本标签「${tk}」不一致：原文「${exp.tag[tk]}」索引「${(got.成本标签 || {})[tk]}」`)
    }
  }
}

// 样例：来源栏里的尖括号链接必须被还原成可点的 URL，不能留着 < >
const broken = index.filter((e) => /<(?:https?:\/\/)/.test(e.来源 || ''))
if (broken.length) diffs.push(`索引里有 ${broken.length} 条的来源仍残留尖括号：${broken.slice(0, 3).map(key).join('、')}`)

console.log(`生成哨兵：原文 ${expected.length} 条，索引 ${index.length} 条，逐字段比对完成`)
if (diffs.length) {
  console.error(`\n不一致 ${diffs.length} 项：`)
  for (const d of diffs.slice(0, 30)) console.error(`  - ${d}`)
  if (diffs.length > 30) console.error(`  ……其余 ${diffs.length - 30} 项省略`)
  process.exit(1)
}
console.log('结论：索引与正文逐字段一致。')

/* ------------------------- 生成物与 book/ 是否同步
 *
 * content/ 与 data/ 现在**进了版本库**（原因见 .gitignore 里的说明：
 * 腾讯 EdgeOne Pages 的构建环境只保证有 Hugo，不保证有 Node，而生成内容这一步
 * 需要 Node。把生成物提交上去，Hugo 就能独立构建，实测 344 页、canonical 正确）。
 *
 * 代价是仓库里存在两份会漂移的东西：book/ 是真相源，content/ 是它的影子。
 * 所以这里补一道同步检查：把生成脚本重跑一遍，逐个文件比对磁盘上的结果——
 * 只要改了 book/ 却忘了重新生成，这里就会报错。
 * 写进仓库的生成物不手工编辑，出问题一律重跑生成脚本。 */
{
  const contentDir = join(ROOT, 'content')
  const buildScript = join(ROOT, 'tools', 'build-site.mjs')
  if (existsSync(buildScript) && existsSync(contentDir)) {
    // 记录生成前各文件的指纹，跑完生成后比对哪些文件内容变了
    const fingerprint = (dir) => {
      const out = new Map()
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name)
          if (e.isDirectory()) walk(p)
          else out.set(p, createHash('sha256').update(readFileSync(p)).digest('hex'))
        }
      }
      walk(dir)
      return out
    }
    const before = fingerprint(contentDir)
    const dataFile = join(ROOT, 'data', 'entries.json')
    const beforeData = existsSync(dataFile) ? readFileSync(dataFile) : null

    const res = spawnSync(process.execPath, [buildScript], { encoding: 'utf8', cwd: ROOT })
    if (res.status !== 0) {
      console.error('\n[失败] 重跑生成脚本出错，无法判断生成物是否与 book/ 同步')
      console.error(res.stdout?.slice(-800) || res.stderr?.slice(-800) || '')
      process.exit(1)
    }
    const after = fingerprint(contentDir)
    const changed = []
    for (const [p, h] of after) if (before.get(p) !== h) changed.push(p)
    for (const p of before.keys()) if (!after.has(p)) changed.push(`${p}（已删除）`)
    const dataChanged = beforeData && existsSync(dataFile)
      ? !beforeData.equals(readFileSync(dataFile)) : false

    if (changed.length || dataChanged) {
      console.error(`\n[失败] 提交的生成物与 book/ 不同步：${changed.length} 个内容文件${dataChanged ? '、索引已变化' : ''}`)
      for (const p of changed.slice(0, 10)) console.error(`  - ${p.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`)
      console.error('  生成脚本刚刚重写/新增了它们，说明有人改了 book/ 却没有重新生成。')
      console.error('  修复：node tools/build-site.mjs，然后把 content 与 data 一起提交。')
      process.exit(1)
    }
    console.log(`生成物同步检查：content/ 下 ${after.size} 个文件与 book/ 一致。`)
  }
}

/* ------------------------- 离线单文件版是否与正文同步
 *
 * `index.html`（离线单文件检索页）是**对外发布的**：README 让读者下载它、微信直接传。
 * 但它不在任何体检步骤里，而生成它的 `tools/build-offline.mjs` 是个独立脚本——
 * 谁也不会顺手跑它。于是它漂过：2026-10-04 时它写着 324 条，而 book/ 已经是 325 条，
 * 一直没被发现（是核对站点迁移时人工数出来的）。这道检查就是为了让「漏跑生成脚本」
 * 变得看得见。
 *
 * **不复用 tools/build-offline.mjs 的代码**，与上面 content/ 的同步检查同一原则：
 * 独立从产物里把 `const DATA = [...]` 抠出来解析，再和 data/entries.json 逐条比对。
 * 复用生成逻辑的话，两边会同时错。
 *
 * 只比对**内容字段**，不逐字节：格式差异（空格、键序）不是漂移，内容差异才是。
 */
{
  const offlinePath = join(ROOT, 'index.html')
  const dataPath = join(ROOT, 'data', 'entries.json')
  if (!existsSync(offlinePath) || !existsSync(dataPath)) {
    console.log('离线单文件版同步检查：index.html 或 data/entries.json 不存在，跳过。')
  } else {
    const html = readFileSync(offlinePath, 'utf8')
    const MARKER = 'const DATA = '
    const at = html.indexOf(MARKER)
    let parsed = null
    let why = ''
    if (at < 0) why = `找不到 \`${MARKER.trim()}\` 标记（生成脚本改了输出格式？）`
    else {
      const from = at + MARKER.length
      const eol = html.indexOf('\n', from)
      const raw = html.slice(from, eol < 0 ? undefined : eol).trim().replace(/;$/, '')
      try { parsed = JSON.parse(raw) } catch (err) { why = err.message }
    }
    if (!Array.isArray(parsed)) {
      console.error(`\n[失败] index.html 里的条目数据解析不出来：${why}`)
      console.error('  它是给读者的离线版，内容必须能从产物里独立读出来。')
      process.exit(1)
    }

    const 索引 = JSON.parse(readFileSync(dataPath, 'utf8'))
    if (parsed.length !== 索引.length) {
      console.error(`\n[失败] 离线单文件版与正文不同步：index.html 里 ${parsed.length} 条，data/entries.json 里 ${索引.length} 条`)
      console.error('  修复：node tools/build-offline.mjs，然后把 index.html 一起提交。')
      process.exit(1)
    }

    // 逐条比对内容字段。抽出来的字段名与 data/entries.json 应当完全同源。
    const 比对字段 = ['节号', '节名', '条号', '标题', '说人话', '依据', '主张强度', '举证难度', '效力位阶', '时效', '备注', '核对日期']
    for (let i = 0; i < parsed.length; i++) {
      for (const k of 比对字段) {
        if (String(parsed[i][k] ?? '') !== String(索引[i][k] ?? '')) {
          console.error(`\n[失败] 离线单文件版与正文内容不一致：第 ${i + 1} 条「${k}」`)
          console.error(`  index.html：${JSON.stringify(parsed[i][k] ?? '').slice(0, 80)}`)
          console.error(`  正文索引　：${JSON.stringify(索引[i][k] ?? '').slice(0, 80)}`)
          console.error('  修复：node tools/build-offline.mjs，然后把 index.html 一起提交。')
          process.exit(1)
        }
      }
    }
    console.log(`离线单文件版同步检查：index.html 里 ${parsed.length} 条与 data/entries.json 逐字段一致。`)
  }
}
