#!/usr/bin/env node
// 生成哨兵：比对 book/ 原文与 site/data/entries.json 的每一个字段。
//
//   node tools/check-site.mjs
//
// 为什么需要它：site/content/ 是生成产物，不跟着源码一起被审阅。如果没有这道比对，
// 生成脚本漏读、截断或改写字段时，阅读正文的人不会发现，站点上的内容却已经和
// 正文不一致了。这里直接从 book/*.md 独立解析一遍，逐字段与索引对账。
//
// 退出码：0 一致 / 1 有差异 / 2 环境错误

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BOOK_DIR = join(ROOT, 'book')
const INDEX = join(ROOT, 'site', 'data', 'entries.json')

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
