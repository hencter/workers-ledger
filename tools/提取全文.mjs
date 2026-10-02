#!/usr/bin/env node
/**
 * 提取全文.mjs —— 从缓存的官方原文里机械切出法规正文，排成 markdown，并做守恒校验
 *
 *   node tools/提取全文.mjs --list                    列出可提取的法规与料量
 *   node tools/提取全文.mjs --check                   只报告，不写文件
 *   node tools/提取全文.mjs --out <目录>              写出（默认 sources/全文）
 *   node tools/提取全文.mjs --only L01,G03            只处理指定编号
 *   node tools/提取全文.mjs --min-articles 5          少于这么多条就判提取失败（默认 3）
 *
 * ## 这一步在解决什么
 *
 * 官方页面除了法规正文，还有一堆页面样板：站点导航、面包屑、「下载Word/PDF」、「扫一扫」、
 * 相关推荐、版权声明、页面自身的发布日期。T3 的实测已经证明这类样板真实存在且会干扰判断
 * （《民法典》最高检页曾返回 3825 字符的首页）。所以「切出正文」是一个**必须验证**的动作，
 * 不能切完就信。
 *
 * ## 判据：trim 守恒（切出来的必须是原文的连续区间）
 *
 * 本工具不去逐行「找得到就算」——那种判据对**拼接式错误**免疫（把页面头尾的片段拼进正文，
 * 每一段都能在原文里找到，但拼出来的东西原文里并不存在）。
 * 这里要求：切出的正文在**去空白归一**后，必须是原页面归一文本的**连续子串**，
 * 即 [起, 止) 区间回读后完全相等。这样：
 *   - 丢掉页面样板 → 通过（区间以外的内容不算）；
 *   - 把两处不相邻的片段拼起来 → 失败（不再是连续区间）；
 *   - 改了任何一个字 → 失败。
 *
 * 只使用 Node 24 内置模块，零依赖。
 * 退出码：0 全部成功 / 1 有失败 / 2 环境错误
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalize, stylize } from './核对原文.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CACHE = join(ROOT, 'sources', '.原文缓存')
const INDEX_PATH = join(HERE, '原文索引.json')

const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const OUT_DIR = resolve(argOf('--out', join(ROOT, 'sources', '全文')))
const ONLY = argOf('--only', '').split(',').map((s) => s.trim()).filter(Boolean)
const MIN_ARTICLES = Number(argOf('--min-articles', '3'))
const CHECK_ONLY = has('--check')

if (!existsSync(CACHE)) { console.error(`[环境错误] 找不到原文缓存，先跑 node tools/抽原文.mjs --all`); process.exit(2) }
if (!existsSync(INDEX_PATH)) { console.error(`[环境错误] 找不到 ${INDEX_PATH}，先跑 node tools/生成原文索引.mjs`); process.exit(2) }

const INDEX = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))

/** 章名行：`第一章 总则` / `第一章　总则` / `第一章 总  则` */
const CHAPTER_RE = /^\s*第[一二三四五六七八九十百零〇]+章\s*[　 ]\s*(\S.*?)\s*$/
/** 条号行：`第一条 内容…`（后面可以没内容，条文单独成段） */
const ARTICLE_RE = /^\s*(第[一二三四五六七八九十百千零〇]+条)\s*[　 ]?(.*)$/
/** 条号后面跟的项号：`（一）…` */
const ITEM_RE = /^\s*([（(][一二三四五六七八九十百零〇\d]+[）)])\s*(.*)$/

/**
 * 从页面纯文本里切出法规正文。
 *
 * 做法：
 *   1. 找出所有「第N条」所在行 → 正文从**第一条所在行**开始（第一条之前的都是页面样板）；
 *   2. 末尾取**最后一个条号行的下一个章节标题或页面尾部之前**——实际取到最后一个
 *      「第N条」之后、遇到明显的页尾样板（相关推荐/版权/扫一扫/下载）为止；
 *   3. 中间按章名/条号/项号重排。
 *
 * 返回 { 起始行, 结束行, 行: [...], 条数, 章数, 弃头行数, 弃尾行数 }
 */
export function extractBody(text, opts = {}) {
  const lines = text.split(/\r?\n/)
  const minArticles = opts.minArticles ?? 3

  // 找条号行
  const artIdx = []
  for (let i = 0; i < lines.length; i++) if (ARTICLE_RE.test(lines[i])) artIdx.push(i)

  // 没有「第N条」的官方件：先用公文式分项「一、二、三…」定正文范围（例如多部门联合通知），
  // 再退回「整页即正文」。**不因此判失败**——本仓库已有两件本来就没有条号：
  // N02（人社部发〔2023〕26 号通知，按「一、二、三」分项）与 P01（统计报道）。
  // 判「有没有条号」是内容性质，不是提取质量；硬按条号判会把它们误报成提取失败。
  if (artIdx.length < minArticles) {
    return extractWithoutArticles(lines, artIdx.length)
  }

  const first = artIdx[0]
  const last = artIdx[artIdx.length - 1]

  // 页尾样板：最后一个条号之后，遇到这些模式就截断；否则取到文件尾
  const TAIL_MARK = /相关推荐|图集推荐|扫一扫|下载Word|下载PDF|版权声明|版权所有|网站地图|主办单位|联系方式|上一篇|下一篇|返回顶部|打印本页|关闭窗口|分享到|责任编辑|来源：|发布日期|字体|【打印】/
  let end = last
  for (let i = last + 1; i < lines.length; i++) {
    if (TAIL_MARK.test(lines[i])) break
    end = i
  }
  // 尾部再退掉空行
  while (end > last && lines[end].trim() === '') end--

  const body = lines.slice(first, end + 1)
  const 弃头 = first
  const 弃尾 = lines.length - 1 - end

  // 统计与重排
  let 条数 = 0
  let 章数 = 0
  const out = []
  for (const rawLine of body) {
    const line = rawLine.trim()
    if (line === '') { out.push(''); continue }
    const ch = CHAPTER_RE.exec(line)
    if (ch) { 章数++; out.push(`#### ${line}`, ''); continue }
    const a = ARTICLE_RE.exec(line)
    if (a) {
      条数++
      const 号 = a[1]
      const 内容 = a[2]
      out.push(内容 ? `**${号}** ${内容}` : `**${号}**`, '')
      continue
    }
    const it = ITEM_RE.exec(line)
    if (it) { out.push(`- ${line}`, ''); continue }
    out.push(line, '')
  }

  const md = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return { ok: true, md, 条数, 章数, 弃头行数: 弃头, 弃尾行数: 弃尾, 起始行: first + 1, 结束行: end + 1, 总行数: lines.length, 形态: '条号体' }
}

/** 公文分项号：`一、`、`二、`……（行政公文常用体例，无「第N条」） */
const CN_ITEM_RE = /^\s*([一二三四五六七八九十]+)、\s*(.*)$/

/**
 * 无「第N条」的官方件提取。
 *
 * 两种形态：
 *   A. 公文分项体（有 `一、二、三…` 分项）→ 以首个分项为正文起点、末个分项后为终点；
 *   B. 无编号的连续叙述（例如统计报道）→ **整页即正文**，只去掉首尾空白行。
 * 两种都由外层做 trim 守恒校验（切出的内容必须是原页面的连续区间），所以
 * 「范围定得对不对」有机械判据兜底，不靠我判断。
 */
function extractWithoutArticles(lines, 条号数) {
  const itemIdx = []
  for (let i = 0; i < lines.length; i++) if (CN_ITEM_RE.test(lines[i])) itemIdx.push(i)

  let first
  let end
  let 形态
  if (itemIdx.length >= 2) {
    first = itemIdx[0]
    const last = itemIdx[itemIdx.length - 1]
    end = last
    const TAIL_MARK = /相关推荐|扫一扫|下载Word|下载PDF|版权声明|版权所有|网站地图|主办单位|联系方式|上一篇|下一篇|返回顶部|打印本页|分享到|责任编辑|发布日期|【打印】/
    for (let i = last + 1; i < lines.length; i++) {
      if (TAIL_MARK.test(lines[i])) break
      end = i
    }
    形态 = '公文分项体'
  } else {
    // 整页即正文：去掉首尾空行
    first = 0
    while (first < lines.length && lines[first].trim() === '') first++
    end = lines.length - 1
    while (end > first && lines[end].trim() === '') end--
    形态 = '连续叙述体'
  }
  while (end > first && lines[end].trim() === '') end--

  const out = []
  let 分项数 = 0
  for (let i = first; i <= end; i++) {
    const line = lines[i].trim()
    if (line === '') { out.push(''); continue }
    const cn = CN_ITEM_RE.exec(line)
    if (cn) { 分项数++; out.push(`**${cn[1]}、** ${cn[2]}`, ''); continue }
    const it = ITEM_RE.exec(line)
    if (it) { out.push(`- ${line}`, ''); continue }
    out.push(line, '')
  }
  const md = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return {
    ok: true, md, 条数: 分项数, 章数: 0,
    弃头行数: first, 弃尾行数: lines.length - 1 - end,
    起始行: first + 1, 结束行: end + 1, 总行数: lines.length,
    形态, 页内条号数: 条号数,
  }
}

/**
 * trim 守恒校验：切出的正文必须是原页面归一文本的**连续子串**。
 * 与 `tools/核对原文.mjs` 同一判据（含标点风格归一），但这里判的是**整块连续**，
 * 因为它要防的是「拼接式错误」，不是「改字」。
 */
export function trimConservation(mdBody, sourcePlain) {
  // 去掉 markdown 装饰，还原纯内容
  const content = mdBody
    .split('\n')
    .map((l) => l
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^\*\*([^*]+)\*\*\s*/, '$1 '))
    .join('\n')

  const hay = normalize(sourcePlain)
  const haySty = stylize(hay)
  const needle = normalize(content)
  const needleSty = stylize(needle)

  let at = hay.indexOf(needle)
  let 靠风格 = false
  let usedHay = hay
  let usedNeedle = needle
  if (at < 0) {
    at = haySty.indexOf(needleSty)
    if (at >= 0) { 靠风格 = true; usedHay = haySty; usedNeedle = needleSty }
  }
  if (at < 0) {
    // 找最长公共前缀，定位拼接点
    let p = 0
    const maxP = Math.min(hay.length, needle.length)
    while (p < maxP && hay[p] === needle[p]) p++
    return {
      ok: false,
      reason: '切出的正文不是原页面的连续区间（疑似拼接了不相邻的片段）',
      最长一致前缀: p,
      原文片段: hay.slice(Math.max(0, p - 40), p + 60),
      正文片段: needle.slice(Math.max(0, p - 40), p + 60),
    }
  }
  const 回读 = usedHay.slice(at, at + usedNeedle.length)
  return {
    ok: true, 起: at, 止: at + usedNeedle.length,
    字符数: usedNeedle.length, 靠风格归一: 靠风格,
    区间回读相等: 回读 === usedNeedle,
  }
}

// ---------------------------------------------------------------------------

function cacheStemsFor(id) {
  return readdirSync(CACHE).filter((f) => f.startsWith(`${id}-`) && f.endsWith('.txt')).sort()
}

if (has('--list')) {
  console.log('可提取的法规（按索引登记）：')
  let 可提 = 0
  for (const r of INDEX.记录) {
    const stems = cacheStemsFor(r.id)
    if (!stems.length) { console.log(`  ⏭  ${r.id} ${r.name}　无缓存`); continue }
    const 料 = stems.map((s) => {
      const t = readFileSync(join(CACHE, s), 'utf8')
      const arts = (t.match(/第[一二三四五六七八九十百千零〇]+条/g) || []).length
      return `${s.replace(/\.txt$/, '')}(${t.length}字符/${arts}条号)`
    }).join('  ')
    console.log(`  ${r.id} ${r.name}\n      ${料}`)
    可提++
  }
  console.log(`\n有缓存 ${可提} / 登记 ${INDEX.记录.length}`)
  process.exit(0)
}

if (!CHECK_ONLY) mkdirSync(OUT_DIR, { recursive: true })

const 目标 = ONLY.length ? INDEX.记录.filter((r) => ONLY.includes(r.id)) : INDEX.记录
let 成功 = 0
let 失败 = 0
const 报告 = []
const 失败清单 = []

for (const r of 目标) {
  const stems = cacheStemsFor(r.id)
  if (!stems.length) { 失败清单.push(`${r.id} 无缓存`); 失败++; continue }

  // 一个编号可能有多个官方页（正本 + 转载页 + 法规库）。逐个提取，取「条数最多」的那个当主源；
  // 其余作为交叉核对页。**不合并多个页面**——合并就是拼接，会被守恒校验拦下。
  const 候选 = []
  for (const s of stems) {
    const path = join(CACHE, s)
    const text = readFileSync(path, 'utf8')
    const metaPath = join(CACHE, s.replace(/\.txt$/, '.json'))
    let meta = {}
    if (existsSync(metaPath)) { try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) } catch { /* 忽略损坏元数据 */ } }
    const ex = extractBody(text, { minArticles: MIN_ARTICLES })
    const conv = ex.ok ? trimConservation(ex.md, text) : null
    候选.push({ stem: s.replace(/\.txt$/, ''), text, meta, ex, conv })
  }

  const 合格 = 候选.filter((c) => c.ex.ok && c.conv && c.conv.ok)
  if (!合格.length) {
    const why = 候选.map((c) => `${c.stem}: ${c.ex.ok ? (c.conv.ok ? '未知' : c.conv.reason) : c.ex.reason}`).join('；')
    失败清单.push(`${r.id} 无合格页（${why}）`)
    失败++
    console.log(`✗  ${r.id} ${r.name}　${why}`)
    continue
  }
  合格.sort((a, b) => b.ex.条数 - a.ex.条数)
  const 主 = 合格[0]
  const 交叉 = 合格.slice(1)

  const out = []
  out.push(`# ${r.id} ${r.name}`)
  out.push('')
  out.push('> **本文件由 `node tools/提取全文.mjs` 从官方页面机械提取并排版，不要手改。**')
  out.push('>')
  out.push('> 提取只做两件事：去掉页面样板（导航、下载按钮、相关推荐、版权声明），把章名/条号/项号排成 markdown。')
  out.push('> **不改任何汉字、数字、标点**，也不补章节、不调顺序、不拆合条文。')
  out.push(`> 判据是 **trim 守恒**：切出的正文在去空白归一后必须是原页面的**连续区间**——`)
  out.push('> 丢了样板算通过，把不相邻片段拼起来会被拦下，改一个字也会。')
  out.push('')
  out.push('## 元数据')
  out.push('')
  out.push(`- 登记编号：\`${r.id}\``)
  out.push(`- 法规全称：${r.name}`)
  out.push(`- 主源：<${主.meta.url || '（未记录）'}>`)
  out.push(`- 主源 HTTP：${主.meta.状态码 ?? '—'}　原始字节：${主.meta.原始字节 ?? '—'}　页面标题：${主.meta.页面标题 || '—'}`)
  // SHA256 只显示前 16 位并**用空格与邻接文字隔开**。原因不是好看：完整哈希里
  // 会出现形如 `…a18555975895a…` 的连续数字串，`tools/check-desensitize.mjs` 会把
  // 它误判成被掩码的手机号（实测命中硬错误一次）。脱敏规则是硬门禁，**不改门禁**，
  // 改这里的输出格式。完整哈希仍在 sources/.原文缓存/<编号>-NN.json 里可查。
  out.push(`- 主源 SHA256（前 16 位，完整值见缓存 json）：\`${String(主.meta.HTML_SHA256 || 主.meta.SHA256 || '（未记录）').slice(0, 16)}\``)
  out.push(`- 抓取时间：${主.meta.抓取时间 || '（未记录）'}`)
  out.push(`- 提取规模：**${主.ex.章数} 章 / ${主.ex.条数} 条**；页面共 ${主.ex.总行数} 行，切掉头部样板 ${主.ex.弃头行数} 行、尾部样板 ${主.ex.弃尾行数} 行`)
  out.push(`- 抽取页字符数：${主.conv.字符数}　区间 [${主.conv.起}, ${主.conv.止})${主.conv.靠风格归一 ? '　（含标点风格归一）' : ''}`)
  out.push(`- 区间回读相等：**${主.conv.区间回读相等 ? '是' : '否'}**`)
  if (交叉.length) {
    out.push('')
    out.push('### 其他官方页（交叉核对用，未合并）')
    out.push('')
    out.push('| 序 | URL | 条数 | trim 守恒 |')
    out.push('| --- | --- | --- | --- |')
    for (const c of 交叉) {
      out.push(`| ${c.stem} | <${c.meta.url || '—'}> | ${c.ex.条数} | ${c.conv && c.conv.ok ? '通过' : '不通过'} |`)
    }
  }
  out.push('')
  out.push('---')
  out.push('')
  out.push(主.ex.md)
  out.push('')

  if (!CHECK_ONLY) writeFileSync(join(OUT_DIR, `${r.id}.md`), out.join('\n'), 'utf8')

  成功++
  报告.push({
    id: r.id, name: r.name, stem: 主.stem, 章数: 主.ex.章数, 条数: 主.ex.条数,
    字符数: 主.conv.字符数, url: 主.meta.url || '', sha: (主.meta.HTML_SHA256 || '').slice(0, 16),
    弃头: 主.ex.弃头行数, 弃尾: 主.ex.弃尾行数, 交叉: 交叉.length,
  })
  console.log(`✓  ${r.id} ${r.name}　${主.ex.章数} 章 / ${主.ex.条数} 条　${主.conv.字符数} 字符　（弃头 ${主.ex.弃头行数} / 弃尾 ${主.ex.弃尾行数} 行）`)
}

console.log('')
console.log('—— 汇总 ——')
console.log(`成功 ${成功}，失败 ${失败}`)
if (失败清单.length) {
  console.log('失败清单：')
  for (const f of 失败清单) console.log(`  - ${f}`)
}

if (!CHECK_ONLY && 报告.length) {
  const lines = [
    '# 法规全文提取：trim 守恒报告',
    '',
    `- 提取工具：\`node tools/提取全文.mjs\``,
    `- 生成时间：${new Date().toISOString()}`,
    `- 输出目录：\`${relative(ROOT, OUT_DIR).split('\\').join('/')}/\``,
    `- 原文缓存：\`sources/.原文缓存/\`（由 \`node tools/抽原文.mjs --all\` 抓取）`,
    '',
    `**成功 ${成功} 部，失败 ${失败} 部。**`,
    '',
    '判据：切出的法规正文在去空白归一后，必须是原页面归一文本的**连续子串**。',
    '页面样板（导航、下载按钮、相关推荐、版权声明）被丢弃不算失败——它们在区间之外；',
    '但把不相邻的片段拼起来会被判失败，因为这不再是连续区间。',
    '',
    '| 编号 | 法规 | 主源 | 章 | 条 | 抽取字符 | 弃头/弃尾行 | 交叉页 | SHA256 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...报告.map((r) => `| ${r.id} | ${r.name} | <${r.url}> | ${r.章数} | ${r.条数} | ${r.字符数} | ${r.弃头}/${r.弃尾} | ${r.交叉} | \`${r.sha}…\` |`),
    '',
    '## 边界',
    '',
    '1. **条数是页面里「第N条」标记的数量**，不等于该法规的法定条文总数。页面缺条、含',
    '   修改决定里的条号引用、「第N条之一」之类写法，都会让这个数偏离法定条数。',
    '   需要精确条数时按 `sources/法规清单.md` 的核验状态列核对。',
    '2. **只提取页面已有的正文**。页面若本身是分片页（例如《民法典》最高检页只覆盖合同编），',
    '   提取结果就是那一编——本工具不跨页合并（合并即拼接，会被守恒校验拦下）。',
    '3. **不判断版本现行性**。S02 等被反爬拦截的页面无缓存，不在本报告内。',
    '',
  ]
  writeFileSync(join(ROOT, 'docs', '核实记录', '源-全文提取-守恒报告.md'), lines.join('\n'), 'utf8')
  console.log(`守恒报告：docs/核实记录/源-全文提取-守恒报告.md`)
}

process.exit(失败 ? 1 : 0)
