#!/usr/bin/env node
// 诊断 PDF 的排版质量：书签层级深度分布、每页内容占比（留白）、分页缺陷。
//
//   node tools/diagnose-pdf.mjs dist/劳动者的账本.pdf
//
// 为什么需要它：用户在排版上提了两个问题——「目录没有层级」「分页没做好」。
// 这两个判断靠肉眼看容易得出模糊结论（「好像好点了」），也无法比较改前改后。
// 这里把它们变成可量化的指标：
//   层级深度  —— 解析 /Outlines 树，统计书签深度分布（扁平=只有 1 级）
//   每页留白  —— 解析每页内容流里的文本定位算子，量最后一段文字的 y 坐标，
//                与页面可用高度比较，得出该页内容占比
//   空白页    —— 内容占比极低的页直接列出来
// 不引第三方依赖：PDF 文本流用 zlib 自己解（FlateDecode），文本定位算子直接匹配。

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const file = process.argv[2] || 'dist/劳动者的账本.pdf'
const buf = readFileSync(file)
const src = buf.toString('latin1')

/* ---------------------------------------------- 一、书签层级 */

/** 收集所有间接对象：num -> {start, end, body} */
function collectObjects(s) {
  const objs = new Map()
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  const marks = []
  let m
  while ((m = re.exec(s))) marks.push({ num: Number(m[1]), start: m.index, bodyStart: re.lastIndex })
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : s.length
    objs.set(marks[i].num, { body: s.slice(marks[i].bodyStart, end), start: marks[i].start })
  }
  return objs
}

function decodePdfString(lit) {
  // 支持 /Title (…) 与 /Title <hex>
  // 注意：Node 的 Buffer 没有 utf16be 编码，必须自己交换字节序后再按 utf16le 解。
  if (lit.startsWith('<')) {
    const hex = lit.slice(1, -1).replace(/[^0-9A-Fa-f]/g, '')
    const bytes = Buffer.from(hex, 'hex')
    const swapped = Buffer.from(bytes)
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t
    }
    return swapped.toString('utf16le').replace(/^\uFEFF/, '')
  }
  let s = lit.slice(1, -1)
  s = s.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] ?? c))
  return s
}

const objs = collectObjects(src)

/** 从一个 outline 项出发，取它的标题、下一个兄弟、第一个孩子 */
function outlineItem(body) {
  const titleM = /\/Title\s*(\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>)/.exec(body)
  const first = /\/First\s+(\d+)\s+\d+\s+R/.exec(body)
  const next = /\/Next\s+(\d+)\s+\d+\s+R/.exec(body)
  const dest = /\/Dest\s*\[?\s*(\d+)/.exec(body) || /\/Dest\s*\[?\s*(\d+)\s+\d+\s+R/.exec(body)
  return {
    title: titleM ? decodePdfString(titleM[1]) : '(无标题)',
    first: first ? Number(first[1]) : null,
    next: next ? Number(next[1]) : null,
    page: dest ? Number(dest[1]) : null,
  }
}

function findOutlinesRoot() {
  for (const [num, o] of objs) {
    if (/\/Type\s*\/Outlines/.test(o.body)) return outlineItem(o.body)
  }
  return null
}

const depthCount = new Map()
const flatTitles = []
function walkOutline(nodeNum, depth, seen = new Set()) {
  let cur = nodeNum
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    const o = objs.get(cur)
    if (!o) break
    const item = outlineItem(o.body)
    depthCount.set(depth, (depthCount.get(depth) || 0) + 1)
    if (depth === 1) flatTitles.push(item.title)
    if (item.first) walkOutline(item.first, depth + 1, seen)
    cur = item.next
  }
}

const root = findOutlinesRoot()
if (root?.first) walkOutline(root.first, 1)

console.log(`文件：${file}`)
console.log(`大小：${(buf.length / 1024 / 1024).toFixed(2)} MB`)
console.log('')
console.log('=== 书签层级 ===')
if (!depthCount.size) {
  console.log('  未解析到书签树')
} else {
  const total = [...depthCount.values()].reduce((a, b) => a + b, 0)
  console.log(`  书签总数：${total}`)
  for (const d of [...depthCount.keys()].sort((a, b) => a - b)) {
    console.log(`  第 ${d} 级：${depthCount.get(d)} 个`)
  }
  const maxDepth = Math.max(...depthCount.keys())
  console.log(`  最大深度：${maxDepth}${maxDepth <= 1 ? '  ← 扁平，没有层级' : ''}`)
  console.log('  第 1 级前若干项：')
  for (const t of flatTitles.slice(0, 8)) console.log(`    ${t.slice(0, 60)}`)
}

/* ---------------------------------------------- 二、每页内容占比（留白） */

// 页面 MediaBox 高度：取第一个 /MediaBox
const mb = /\/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]/.exec(src)
const pageH = mb ? Math.abs(Number(mb[4]) - Number(mb[2])) : 842

// 抓每页对象里的 Contents 流
const contentStreams = []
for (const [num, o] of objs) {
  if (!/\/Type\s*\/Page\b/.test(o.body)) continue
  const cRef = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(o.body)
  if (!cRef) continue
  contentStreams.push(Number(cRef[1]))
}

/** 解出一个对象的流内容（可能 FlateDecode） */
function streamOf(num) {
  const o = objs.get(num)
  if (!o) return null
  const idx = o.body.indexOf('stream')
  if (idx < 0) return null
  let p = idx + 'stream'.length
  if (o.body[p] === '\r') p++
  if (o.body[p] === '\n') p++
  const endIdx = o.body.indexOf('endstream', p)
  if (endIdx < 0) return null
  let raw = Buffer.from(o.body.slice(p, endIdx), 'latin1')
  if (/\/FlateDecode/.test(o.body.slice(0, idx))) {
    try { raw = inflateSync(raw) } catch { return null }
  }
  return raw.toString('latin1')
}


/* 取一段内容流里所有文字在**页面坐标系**下的 y。
   坑（踩过三次）：页面开头常有一句全局变换，例如
     .24 0 0 -.24 0 841.92 cm
   文字 TM 写在内层坐标系（1 0 0 -1 x y Tm）。直接把 Tm 的 y 当页面坐标，
   会量出跨度 421 倍的荒谬值；只重置 BT 也不够，因为 cm 一直在作用。
   做法：维护 q/Q 图形状态栈，累积 cm，把 Tm 的 y 映射回页面空间：
   y' = d * ty + f（矩阵 a b c d e f 只取纵向分量）。 */
function textYsFixed(stream) {
  const ys = []
  const stack = []
  let base = [1, 0, 0, 1, 0, 0]

  const mul = (m1, m2) => [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]

  // 一个正则按顺序抓出：cm(1-6) / Tm(7-12) / Td|TD(13-14) / 无参算子(15)
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\b|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm\b|(-?[\d.]+)\s+(-?[\d.]+)\s+(?:Td|TD)\b|(q|Q|BT|ET|T\*)\b/g
  let match
  let tmY = 0
  while ((match = re.exec(stream))) {
    if (match[6] !== undefined) {
      base = mul(base, [1, 2, 3, 4, 5, 6].map((i) => Number(match[i])))
      continue
    }
    if (match[12] !== undefined) {
      tmY = Number(match[12])
      ys.push(base[3] * tmY + base[5])
      continue
    }
    if (match[14] !== undefined) {
      tmY += Number(match[14])
      ys.push(base[3] * tmY + base[5])
      continue
    }
    const op = match[15]
    if (op === 'q') stack.push(base.slice())
    else if (op === 'Q') { if (stack.length) base = stack.pop() }
    else if (op === 'BT') tmY = 0
  }
  return ys
}

const ratios = []
for (const num of contentStreams) {
  const st = streamOf(num)
  if (!st) continue
  const ys = textYsFixed(st)
  if (!ys.length) continue
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  // 内容流可能带 cm 变换，y 不一定是页面绝对坐标（第一版直接拿 y 比页面高度，
  // 得出中位数 -31% 的荒谬值）。所以改量「本页文字纵向跨度」占页面高度的比例：
  // 跨度大说明这一页用得满，跨度小说明有大片空白。页眉页脚会略微抬高下限，
  // 但不影响比较改前改后。
  ratios.push({ num, minY, maxY, ratio: (maxY - minY) / pageH })
}

if (ratios.length) {
  const sorted = ratios.map((r) => r.ratio).sort((a, b) => a - b)
  const pct = (x) => `${(x * 100).toFixed(0)}%`
  const median = sorted[Math.floor(sorted.length / 2)]
  const sparse = ratios.filter((r) => r.ratio < 0.7)
  console.log('')
  console.log('=== 每页内容密度（留白诊断）===')
  console.log(`  统计页数：${ratios.length}`)
  console.log(`  纵向跨度占页面高度 中位数：${pct(median)}`)
  console.log(`  最低：${pct(sorted[0])}  最高：${pct(sorted[sorted.length - 1])}`)
  console.log(`  密度 < 70% 的页面：${sparse.length} 页（${pct(sparse.length / ratios.length)}）`)
  console.log(`  密度 < 50% 的页面：${ratios.filter((r) => r.ratio < 0.5).length} 页`)
  console.log(`  密度 < 30% 的页面：${ratios.filter((r) => r.ratio < 0.3).length} 页`)
  const buckets = [0, 0.3, 0.5, 0.7, 0.85, 1.01]
  const hist = new Array(buckets.length - 1).fill(0)
  for (const r of ratios) {
    for (let i = 0; i < hist.length; i++) {
      if (r.ratio >= buckets[i] && r.ratio < buckets[i + 1]) { hist[i]++; break }
    }
  }
  console.log('  分布：')
  for (let i = 0; i < hist.length; i++) {
    console.log(`    ${pct(buckets[i]).padStart(5)}–${pct(buckets[i + 1]).padStart(5)}：${hist[i]} 页`)
  }
  // 最空的若干页，供定位是哪些内容造成的
  const emptiest = [...ratios].sort((a, b) => a.ratio - b.ratio).slice(0, 8)
  console.log('  最空的 8 页（对象号 / 密度）：')
  for (const e of emptiest) console.log(`    对象 ${e.num}：${pct(e.ratio)}`)
}
