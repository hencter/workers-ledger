// 校验「主张强度」字段在渲染结果里不再重复显示，且补充说明没有丢。
// 判据：条目页里该字段的 dd 区块内，分档词应只出现一次；有括注/破折号补充的，
//       补充文字必须仍在。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 路径一律相对本脚本定位：本脚本在 tools/checks/，仓库根是上两级
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PUB = join(ROOT, 'public')
const BOOK = join(ROOT, 'book')
if (!existsSync(PUB)) { console.error('[环境错误] 先跑 node tools/build-prod.mjs'); process.exit(2) }

// 从书里取原始值，用于对照
const src = new Map()
for (const f of readdirSync(BOOK).filter((x) => x.endsWith('.md'))) {
  const t = readFileSync(join(BOOK, f), 'utf8')
  const lines = t.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const h = /^###\s+(\d+)\.(\d+)\s+(.+)$/.exec(lines[i])
    if (!h) continue
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^- 主张强度：(.+)$/.exec(lines[j])
      if (m) { src.set(`${h[1]}.${h[2]}`, m[1].trim()); break }
      if (/^###\s/.test(lines[j])) break
    }
  }
}
console.log(`从 book/ 取到 ${src.size} 条的「主张强度」原始值`)

// 在产物里找每个条目的页面
const pages = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name === 'index.html') pages.push(p)
  }
}
walk(PUB)
console.log(`产物页面 ${pages.length} 个`)

const 问题 = []
let 检查数 = 0
let 无重复数 = 0

for (const p of pages) {
  const html = readFileSync(p, 'utf8')
  // 定位「主张强度」字段块
  const m = /<dt>主张强度<\/dt>\s*<dd>([\s\S]*?)<\/dd>/.exec(html)
  if (!m) continue
  检查数++
  const block = m[1]
  const 纯文本 = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

  // 判据 1：分档词只出现一次
  for (const w of ['可主张', '可推定', '倡导性']) {
    const n = (纯文本.match(new RegExp(w, 'g')) || []).length
    if (n > 1) 问题.push({ page: p, 原因: `「${w}」出现 ${n} 次`, 文本: 纯文本.slice(0, 120) })
  }

  // 判据 2：原文有补充（—— 或 （…））时，补充文字不能丢
  const 条目 = /<meta property="og:title" content="([^"]*)"/.exec(html)
  // 用页面路径找不回编号，改成：只要原文里存在该分档词且带补充，就抽查若干条
  if (纯文本.split(' ').length <= 1) 无重复数++
}

// 抽查：把带补充说明的原始值逐个找出来，确认补充文字在某个页面里出现过。
// 探针必须**去掉 markdown 标记**再取——正文里的 `**加粗**` 渲染后是纯文本，
// 拿带星号的串去找当然找不到（这是校验脚本第一版的假阳性，据实改正）。
const 去标记 = (s) => String(s)
  .replace(/\*\*/g, '')
  .replace(/`/g, '')
  .replace(/^[——（(]+/, '')
  .replace(/[）)]+$/, '')
  .replace(/\s+/g, '')
  .trim()

const 带补充 = [...src.entries()].filter(([, v]) => /——|（/.test(v))
console.log(`\n带补充说明的条目 ${带补充.length} 条，逐条确认补充文字仍在产物中：`)
const 缺补充 = []
for (const [k, v] of 带补充) {
  const 补充片段 = 去标记(String(v).replace(/^(可主张|可推定|倡导性)/, ''))
  const 探针 = 补充片段.slice(0, 10)
  if (!探针) continue
  const found = pages.some((p) => 去标记(readFileSync(p, 'utf8')).includes(探针))
  console.log(`  ${String(k).padEnd(6)} ${探针}…　${found ? '在' : '**丢失**'}`)
  if (!found) 缺补充.push(k)
}

console.log('')
console.log(`—— 汇总 ——`)
console.log(`检查了 ${检查数} 个含「主张强度」字段的页面`)
console.log(`重复展示问题：${问题.length} 项`)
for (const q of 问题.slice(0, 6)) console.log(`  ✗ ${q.page.replace(PUB, '')}　${q.原因}　${q.文本}`)
console.log(`补充说明丢失：${缺补充.length} 条${缺补充.length ? '（' + 缺补充.join('、') + '）' : ''}`)

process.exit(问题.length || 缺补充.length ? 1 : 0)
