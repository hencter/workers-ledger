#!/usr/bin/env node
/**
 * 生成dig报告.mjs —— 为每部法规产出一份人可审的逐行 diff 记录
 *
 *   node tools/生成diff报告.mjs                      为全部法规块生成
 *   node tools/生成diff报告.mjs --only L01,L04       只生成指定编号
 *   node tools/生成diff报告.mjs --out <目录>         指定输出目录
 *
 * ## 这份报告要回答什么
 *
 * 用户要的是「与原文进行 diff 对比验证」。`tools/核对原文.mjs` 给出**结论**
 * （通过/不通过），本工具给出**证据**：每一条摘录的每一行，对应官方原文
 * 归一化文本里的哪个字符区间，区间内容是否与摘录逐字相同。
 *
 * ## 记录什么（每一项都可复核）
 *
 *   1. 官方来源：URL、HTTP 状态、字节数、SHA256、页面标题、抓取时间；
 *   2. 逐行对账：摘录行 → 原文偏移 [起, 止)、该区间归一化字符数、是否逐字一致；
 *   3. 区间原文回读：从官方文本里把 [起, 止) 切回来，与摘录行并列显示，
 *      让人**肉眼就能比**，不必相信任何一方的话；
 *   4. 标点风格差异处单独标出（本仓库照录所引页面的括号/分号风格，不作统一）；
 *   5. 未命中行与分歧点（若有）——失败也要留下证据，不是只报个红。
 *
 * ## 它不证明什么
 *   不证明完整（少摘一段不报）、不证明版本现行（旧版页面不自我标注，本仓库已命中四例）、
 *   不证明条号归属。这三件事分别在 `sources/法规清单.md` 与 `docs/核实记录/` 里管。
 *
 * 只使用 Node 24 内置模块，零依赖。
 * 退出码：0 生成完成 / 1 有块无法生成（缺缓存）/ 2 环境错误
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
const OUT_DIR = resolve(argOf('--out', join(ROOT, 'docs', '核实记录', 'diff')))
const ONLY = argOf('--only', '').split(',').map((s) => s.trim()).filter(Boolean)

if (!existsSync(MD_PATH)) { console.error(`[环境错误] 找不到 ${MD_PATH}`); process.exit(2) }
if (!existsSync(CACHE)) { console.error(`[环境错误] 找不到原文缓存，先跑 node tools/抽原文.mjs --all`); process.exit(2) }

mkdirSync(OUT_DIR, { recursive: true })

/** 与核对原文.mjs 同源：读取某编号的原文缓存（含本地人工核对件） */
function cacheFor(id) {
  return readdirSync(CACHE)
    .filter((f) => f.startsWith(`${id}-`) && f.endsWith('.txt'))
    .sort()
    .map((f) => {
      const stem = f.replace(/\.txt$/, '')
      const metaPath = join(CACHE, `${stem}.json`)
      let meta = {}
      let 种类 = '抓取'
      if (existsSync(metaPath)) {
        try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) } catch { /* 忽略损坏的元数据 */ }
        if (meta.类型 === '本地人工核对件') 种类 = '本地人工核对件'
      } else {
        种类 = '本地人工核对件'
      }
      const text = readFileSync(join(CACHE, f), 'utf8')
      return {
        stem, meta, 种类, text,
        norm: normalize(text),
        normSty: stylize(normalize(text)),
        sha: createHash('sha256').update(text).digest('hex'),
      }
    })
}

/** 对一行做两级判定，返回区间与回读内容 */
function matchLine(c, raw) {
  const strict = normalize(raw)
  if (!strict) return { 跳过: true }
  let at = c.norm.indexOf(strict)
  let 靠风格 = false
  let needle = strict
  let hay = c.norm
  if (at < 0) {
    const sty = stylize(strict)
    const at2 = c.normSty.indexOf(sty)
    if (at2 >= 0) { at = at2; needle = sty; 靠风格 = true; hay = c.normSty }
  }
  if (at < 0) return { 命中: false, 摘录: raw, 归一字符数: strict.length }
  const 回读 = hay.slice(at, at + needle.length)
  return {
    命中: true,
    摘录: raw,
    起: at,
    止: at + needle.length,
    归一字符数: needle.length,
    逐字一致: 回读 === needle,
    回读: 回读.slice(0, 200),
    靠风格,
  }
}

const md = readFileSync(MD_PATH, 'utf8')
const { 块 } = parseExcerpts(md)

const 生成 = []
const 缺缓存 = []

for (const b of 块) {
  if (ONLY.length && !ONLY.includes(b.id)) continue
  const caches = cacheFor(b.id)
  if (!caches.length) { 缺缓存.push(b); continue }

  const lines = []
  lines.push(`# ${b.id} ${b.name} —— 原文 diff 记录`)
  lines.push('')
  lines.push(`- 待核对文件：\`${relative(ROOT, MD_PATH).split('\\').join('/')}\`（第 ${b.行} 行起）`)
  lines.push(`- 生成工具：\`node tools/生成diff报告.mjs\``)
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push(`- **判据**：逐行要求摘录正文在官方原文中去掉全部空白后**逐字出现**；标点风格差异（全角/半角括号、分号、冒号）允许，且逐处标出。`)
  lines.push('')
  lines.push('## 一、官方来源')
  lines.push('')
  lines.push('| 序 | 种类 | URL | HTTP | 字节 | 纯文本字符 | SHA256（原始响应） | 页面标题 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const c of caches) {
    const m = c.meta || {}
    lines.push('| ' + [
      c.stem,
      c.种类,
      m.url || '（未记录）',
      m.状态码 ?? '—',
      m.原始字节 ?? '—',
      c.norm.length,
      m.HTML_SHA256 || m.SHA256 ? `\`${String(m.HTML_SHA256 || m.SHA256).slice(0, 16)}…\`` : '—',
      (m.页面标题 || '—').replace(/\|/g, '\\|').slice(0, 60),
    ].join(' | ') + ' |')
  }
  lines.push('')
  if (caches.some((c) => c.种类 === '本地人工核对件')) {
    lines.push('> [!warning] 本记录含「本地人工核对件」')
    lines.push('> 上表中种类为「本地人工核对件」的行**不是本工具抓取的结果**，而是人工放入的核对对象。')
    lines.push('> 因此它只能证明「摘录与已取到的那份文本一致」，**不构成联网复核证据**。')
    lines.push('> 逐条的来源性质见 `sources/.原文缓存/<编号>-NN.json` 的 `来源性质` 字段。')
    lines.push('')
  }
  lines.push('## 二、逐行对账')
  lines.push('')

  let 总行 = 0
  let 命中行 = 0
  let 风格行 = 0
  let 失败行 = 0

  for (const t of b.条文) {
    const { 条号, 正文 } = stripArticlePrefix(t.正文)
    const rows = 正文.split('\n').map((l) => l.trim()).filter(Boolean)
    lines.push(`### ${t.标题行}`)
    lines.push('')
    if (!rows.length) {
      lines.push('正文为空——无法核对。')
      lines.push('')
      continue
    }
    lines.push(`条号「${条号 || '（无）'}」＋正文 ${rows.length} 行。`)
    lines.push('')
    lines.push('| # | 摘录行（本仓库） | 命中页 | 原文偏移 | 归一字符数 | 逐字一致 | 风格差异 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]
      // 任一处缓存命中即可
      let best = null
      for (const c of caches) {
        const r = matchLine(c, raw)
        if (r.命中) { best = { ...r, stem: c.stem }; break }
      }
      总行++
      if (!best) {
        失败行++
        lines.push(`| ${i + 1} | ${raw.replace(/\|/g, '\\|')} | **未命中** | — | — | ✗ | — |`)
        continue
      }
      命中行++
      if (best.靠风格) 风格行++
      lines.push('| ' + [
        i + 1,
        raw.replace(/\|/g, '\\|').slice(0, 200),
        best.stem,
        `[${best.起}, ${best.止})`,
        best.归一字符数,
        best.逐字一致 ? '✓' : '✗',
        best.靠风格 ? '全角↔半角' : '',
      ].join(' | ') + ' |')
    }
    lines.push('')
  }

  // 区间回读：抽前 5 行做「切回来看」的并列展示，这是最直观的一层
  lines.push('## 三、区间回读（从官方文本切回来肉眼对）')
  lines.push('')
  lines.push('说明：把上表记录的 `[起, 止)` 区间**从官方归一化文本里切回来**，与摘录行并列。')
  lines.push('不需要相信任何一方的结论——直接看两边是否一样。')
  lines.push('')
  let 展示 = 0
  for (const t of b.条文) {
    if (展示 >= 6) break
    const { 正文 } = stripArticlePrefix(t.正文)
    const rows = 正文.split('\n').map((l) => l.trim()).filter(Boolean)
    for (const raw of rows) {
      if (展示 >= 6) break
      let hit = null
      for (const c of caches) {
        const r = matchLine(c, raw)
        if (r.命中) { hit = { ...r, c }; break }
      }
      if (!hit) continue
      const hay = hit.靠风格 ? hit.c.normSty : hit.c.norm
      const 回读 = hay.slice(hit.起, hit.止)
      const 摘 = normalize(raw)
      lines.push(`- ${t.标题行}　第 ${rows.indexOf(raw) + 1} 行`)
      lines.push(`  - 官方 \`[${hit.起}, ${hit.止})\`：\`${回读}\``)
      lines.push(`  - 摘录（归一）：\`${摘}\``)
      lines.push(`  - 一致：**${回读 === 摘 || hit.靠风格 ? '是' : '否'}**${hit.靠风格 ? '（经标点风格归一后一致）' : ''}`)
      展示++
    }
  }
  lines.push('')
  lines.push('## 四、小结')
  lines.push('')
  lines.push(`- 条文块 ${b.条文.length} 个，正文行 ${总行} 行`)
  lines.push(`- 逐字命中 ${命中行} 行，未命中 ${失败行} 行`)
  lines.push(`- 其中 ${风格行} 行是靠**标点风格归一**（全角↔半角）才命中的——这是本仓库照录所引页面字符风格的正常结果，不是内容差异`)
  lines.push(`- 结论：**${失败行 === 0 ? '与官方原文逐字一致' : `有 ${失败行} 行需人工判断`}**`)
  lines.push('')
  lines.push('## 五、本记录的边界')
  lines.push('')
  lines.push('1. **不证明完整性**：只核对写进去的摘录行，不核对「该条该不该有」。')
  lines.push('2. **不证明版本现行**：页面可能是已被取代的旧版（本仓库已命中四例「旧版页面不自我标注已被取代」）。版本判断见 `sources/法规清单.md` 与 `docs/核实记录/源-版本复审-2026-10-03.md`。')
  lines.push('3. **不证明条号归属**：只认字符连续出现，不判断该条文是否属于该章该节。')
  lines.push(`4. **单时点快照**：来源为 ${new Date().toISOString().slice(0, 10)} 抓取的缓存，政府站改版后需重抓复核。`)
  if (caches.some((c) => c.种类 === '本地人工核对件')) {
    lines.push('5. **含本地人工核对件**：见第一节警示，不构成联网复核证据。')
  }
  lines.push('')

  const out = join(OUT_DIR, `${b.id}.diff.md`)
  writeFileSync(out, lines.join('\n'), 'utf8')
  生成.push({ id: b.id, name: b.name, out, 总行, 命中行, 失败行, 风格行 })
  console.log(`${失败行 === 0 ? '✓' : '✗'}  ${b.id} ${b.name}　${命中行}/${总行} 行命中（风格归一 ${风格行} 行）→ ${relative(ROOT, out).split('\\').join('/')}`)
}

console.log('')
console.log('—— 汇总 ——')
const 总行和 = 生成.reduce((a, x) => a + x.总行, 0)
const 命中行和 = 生成.reduce((a, x) => a + x.命中行, 0)
const 失败行和 = 生成.reduce((a, x) => a + x.失败行, 0)
const 风格行和 = 生成.reduce((a, x) => a + x.风格行, 0)
console.log(`已生成 ${生成.length} 份 diff 记录，覆盖 ${总行和} 行摘录正文`)
console.log(`逐字命中 ${命中行和} 行，未命中 ${失败行和} 行，其中靠风格归一 ${风格行和} 行`)
if (缺缓存.length) console.log(`[警告] ${缺缓存.length} 个块无原文缓存，未生成：${缺缓存.map((b) => b.id).join('、')}`)
console.log(`输出目录：${OUT_DIR}`)

// 索引文件，便于从核实记录目录一眼看到覆盖情况
const index = [
  '# 原文 diff 记录索引',
  '',
  '本目录由 `node tools/生成diff报告.mjs` 生成，**不要手改**。',
  '',
  '判据与边界见每份记录的开头与结尾。重新生成：`node tools/生成diff报告.mjs`，',
  '然后跑 `node tools/核对原文.mjs --require-diff` 确认全部一致且覆盖齐全。',
  '',
  '| 编号 | 法规 | 摘录行 | 逐字命中 | 未命中 | 风格归一 | 记录 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...生成.map((x) => `| ${x.id} | ${x.name} | ${x.总行} | ${x.命中行} | ${x.失败行} | ${x.风格行} | [${x.id}.diff.md](${x.id}.diff.md) |`),
  '',
  `合计 ${生成.length} 部，摘录正文 ${总行和} 行，逐字命中 ${命中行和} 行，未命中 ${失败行和} 行。`,
  '',
]
writeFileSync(join(OUT_DIR, 'INDEX.md'), index.join('\n'), 'utf8')
console.log(`索引：${relative(ROOT, join(OUT_DIR, 'INDEX.md')).split('\\').join('/')}`)

process.exit(缺缓存.length || 失败行和 ? 1 : 0)
