#!/usr/bin/env node
// 从 book/ 生成 Hugo 站点的内容页与检索索引。
//
//   node tools/build-site.mjs            生成到 site/
//   node tools/build-site.mjs --check    只校验解析结果，不写文件（CI 用）
//   node tools/build-site.mjs --root X   指定仓库根目录
//
// 设计前提（重要）：book/ 下的 markdown 是唯一真相源——它既是仓库里可以直接读的
// 正文，也是 AI skill 检索的依据。站点只是它的一个视图。所以这里做的是单向生成：
// book/*.md → site/content/**（Hugo 内容页）+ site/data/entries.json（前端索引）。
// 不许反向写回，也不许让站点内容成为需要单独维护的第二份。
//
// 字段解析依赖 docs/条目规范.md 的条目格式：三级标题为条目，其后一组
// 「- 字段名：值」行，末尾一行成本标签 HTML 注释。

import {
  readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync, statSync,
} from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const ROOT = resolve(argOf('--root', resolve(HERE, '..')))
const CHECK_ONLY = argv.includes('--check')
const BOOK_DIR = join(ROOT, 'book')
const SITE_DIR = join(ROOT, 'site')
const CONTENT_DIR = join(SITE_DIR, 'content')
const DATA_DIR = join(SITE_DIR, 'data')

/** 条目必备字段，顺序即规范里的字段顺序 */
const FIELDS = [
  '适用', '成本', '收益', '说人话', '依据', '效力位阶', '主张强度',
  '举证难度', '地域', '时效', '来源', '核对日期', '备注',
]

const problems = []
const report = (file, line, msg) => problems.push({ file, line, msg })

/** 去掉行内 markdown 标记，得到适合放 front matter 与 JSON 的纯文本 */
function stripInline(s) {
  return s
    .replace(/<((?:https?:\/\/)[^>\s]+)>/g, '$1')   // <url> → url
    .replace(/\*\*([^*]+)\*\*/g, '$1')              // 粗体
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')        // 斜体
    .replace(/`([^`]+)`/g, '$1')                    // 行内代码
    .replace(/\s+/g, ' ')
    .trim()
}

/** YAML 双引号标量：只做必要的转义，避免破坏中文 */
function yamlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}

/** 解析一行成本标签注释；返回 null 表示这行不是成本标签 */
function parseCostTag(line) {
  const m = /<!--\s*成本标签\s*[:：]\s*(.+?)\s*-->/.exec(line)
  if (!m) return null
  const tag = {}
  for (const pair of m[1].split(/\s+/)) {
    const kv = /^([^=]+)=(.+)$/.exec(pair)
    if (kv) tag[kv[1].trim()] = kv[2].trim()
  }
  return Object.keys(tag).length ? tag : null
}

/** 把「- 字段名：值」解析成字段表；同一字段重复出现时后者追加 */
function parseFields(lines, file, startLine) {
  const fields = {}
  const unknown = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const m = /^-\s*([^：:]{1,12})[：:]\s*(.*)$/.exec(line.trim())
    if (!m) {
      // 条目之间的分隔线、空注释、成本标签行都不是游离内容
      if (/^-{3,}$/.test(line.trim())) continue
      if (parseCostTag(line)) continue
      unknown.push({ line: startLine + i, text: line.trim().slice(0, 60) })
      continue
    }
    const name = m[1].trim()
    const value = m[2].trim()
    if (!FIELDS.includes(name)) {
      unknown.push({ line: startLine + i, text: line.trim().slice(0, 60) })
      continue
    }
    fields[name] = fields[name] ? `${fields[name]} ${value}` : value
  }
  return { fields, unknown }
}

/** 生成一个安全的目录名：保留中文，去掉文件系统不便的字符 */
function safeSlug(s) {
  return s.replace(/[\\/:*?"<>|#%]/g, '').replace(/\s+/g, '-').trim()
}

function buildSection(name) {
  const m = /^(\d+)[-—－](.+)\.md$/.exec(name)
  if (!m) return null
  return { number: m[1], title: m[2].trim(), file: name }
}

function parseFile(fileName) {
  const path = join(BOOK_DIR, fileName)
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split(/\r?\n/)

  // 顶层 # 标题 = 节名；## 二级标题 = 节内分组（仅作排版，不单独成页）
  const h1 = lines.findIndex((l) => /^#\s+/.test(l))
  const h1Text = h1 >= 0 ? stripInline(lines[h1].replace(/^#\s+/, '')) : ''

  // 定位所有三级标题。条目编号用规范里的「节号.条号」形式，例如 1.1、13.24。
  const entries = []
  const marks = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^###\s+(\d+)\.(\d+)\s+(.+?)\s*$/.exec(lines[i])
    if (m) {
      marks.push({
        index: i,
        sectionNumber: Number(m[1]),
        number: Number(m[2]),
        title: stripInline(m[3]),
      })
    }
  }

  for (let k = 0; k < marks.length; k++) {
    const cur = marks[k]
    const end = k + 1 < marks.length ? marks[k + 1].index : lines.length
    const body = lines.slice(cur.index + 1, end)

    // 成本标签可以在条目块内任意位置，取出后从字段行里剔除
    let costTag = null
    const fieldLines = []
    for (const line of body) {
      const tag = parseCostTag(line)
      if (tag && !costTag) { costTag = tag; continue }
      fieldLines.push(line)
    }

    const { fields, unknown } = parseFields(fieldLines, fileName, cur.index + 2)
    for (const u of unknown) report(fileName, u.line, `游离行（既不是字段也不是成本标签）：${u.text}`)

    for (const f of FIELDS) {
      if (f === '说人话') continue // 正文承载
      if (!fields[f]) report(fileName, cur.index + 1, `条目「${cur.number}. ${cur.title}」缺字段：${f}`)
    }
    if (!fields['说人话']) {
      // 规范要求「说人话」栏存在；若缺失，正文取空并报出
      report(fileName, cur.index + 1, `条目「${cur.number}. ${cur.title}」缺字段：说人话`)
    }
    if (!costTag) report(fileName, cur.index + 1, `条目「${cur.number}. ${cur.title}」缺成本标签注释`)

    entries.push({
      number: cur.number,
      sectionNumber: cur.sectionNumber,
      title: cur.title,
      fields,
      说人话: fields['说人话'] || '',
      成本标签: costTag || {},
      line: cur.index + 1,
    })
  }

  // 节内条号必须连续、不重复
  const numbers = entries.map((e) => e.number)
  const dup = numbers.filter((n, i) => numbers.indexOf(n) !== i)
  if (dup.length) report(fileName, 1, `条目编号重复：${[...new Set(dup)].join('、')}`)
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) {
      report(fileName, 1, `条目编号不连续：第 ${i + 1} 个位置的编号是 ${numbers[i]}`)
      break
    }
  }

  return { h1Text, entries }
}

/** 每个条目一页。正文只放「说人话」——它本来就是给读者看的那一段；其余字段进 front matter。
 * 其余字段不是可有可无的元数据：这个仓库的卖点就是证据维度，所以它们必须随页走，
 * 让模板与前端索引都能读到，也让 AI 读单页就能拿到全部判断依据。 */
function entryPage(section, entry) {
  const fm = []
  fm.push('---')
  fm.push(`title: ${yamlString(entry.title)}`)
  fm.push(`linkTitle: ${yamlString(`${entry.number}. ${entry.title}`)}`)
  fm.push(`weight: ${entry.number}`)
  fm.push(`date: ${entry.fields['核对日期'] || '2026-01-01'}`)
  const desc = entry.说人话 || entry.fields['收益'] || ''
  fm.push(`description: ${yamlString(desc.slice(0, 110))}`)
  fm.push('params:')
  fm.push(`  节号: ${Number(section.number)}`)
  fm.push(`  节名: ${yamlString(section.title)}`)
  fm.push(`  条号: ${entry.number}`)
  for (const f of FIELDS) {
    const v = entry.fields[f]
    if (v) fm.push(`  ${f}: ${yamlString(stripInline(v))}`)
  }
  if (Object.keys(entry.成本标签).length) {
    fm.push('  成本标签:')
    for (const [k, v] of Object.entries(entry.成本标签)) fm.push(`    ${k}: ${yamlString(v)}`)
  }
  fm.push('---')
  fm.push('')
  // 正文：说人话。备注里的例外与争议由模板单独成块渲染，不混进正文段落。
  fm.push(entry.说人话 ? stripInline(entry.说人话) : '')
  fm.push('')
  return fm.join('\n')
}

function sectionIndex(section, entries) {
  return [
    '---',
    `title: ${yamlString(`${section.number}. ${section.title}`)}`,
    `linkTitle: ${yamlString(section.title)}`,
    `weight: ${Number(section.number)}`,
    `description: ${yamlString(`本节 ${entries.length} 条，按实际可用性排序。`)}`,
    '---',
    '',
  ].join('\n')
}

function main() {
  if (!existsSync(BOOK_DIR)) {
    console.error(`[环境错误] 找不到正文目录：${BOOK_DIR}`)
    process.exit(2)
  }
  const files = readdirSync(BOOK_DIR).filter((f) => f.endsWith('.md')).sort()
  const sections = files.map(buildSection).filter(Boolean)
  if (!sections.length) {
    console.error(`[环境错误] ${BOOK_DIR} 下没有符合「编号-节名.md」的正文文件`)
    process.exit(2)
  }
  sections.sort((a, b) => Number(a.number) - Number(b.number))

  const allEntries = []
  const out = []
  for (const section of sections) {
    const { h1Text, entries } = parseFile(section.file)
    if (h1Text) {
      // 正文一级标题惯例写成「1. 签合同之前」，文件名是「01-签合同之前」。
      // 节名要一致，节号也要一致——节号对不上说明文件被挪过位。
      const m = /^(\d+)\s*[.、．]\s*(.+)$/.exec(h1Text)
      const h1Num = m ? Number(m[1]) : null
      const h1Name = m ? m[2].trim() : h1Text
      if (h1Num !== null && h1Num !== Number(section.number)) {
        report(section.file, 1, `正文一级标题的节号「${h1Num}」与文件名的节号「${Number(section.number)}」不一致`)
      }
      if (h1Name !== section.title) {
        report(section.file, 1, `文件名节名「${section.title}」与正文一级标题节名「${h1Name}」不一致`)
      }
    }
    if (!entries.length) report(section.file, 1, '本节没有任何条目')
    const slug = `${section.number}-${safeSlug(section.title)}`
    const secForPage = { number: Number(section.number), title: section.title }
    const pages = entries.map((e) => ({
      slug,
      file: `${String(e.number).padStart(2, '0')}-${safeSlug(e.title)}.md`,
      content: entryPage(secForPage, e),
    }))
    out.push({ section, slug, index: sectionIndex(section, entries), pages })
    for (const e of entries) {
      allEntries.push({
        节号: Number(section.number),
        节名: section.title,
        条号: e.number,
        标题: e.title,
        说人话: stripInline(e.说人话),
        ...Object.fromEntries(FIELDS.filter((f) => f !== '说人话').map((f) => [f, stripInline(e.fields[f] || '')])),
        成本标签: e.成本标签,
        路径: `/${slug}/${String(e.number).padStart(2, '0')}-${safeSlug(e.title)}/`,
      })
    }
  }

  const total = allEntries.length
  console.log(`解析完成：${sections.length} 节，${total} 条`)
  for (const o of out) console.log(`  ${o.section.number}. ${o.section.title}  ${o.pages.length} 条`)

  if (problems.length) {
    console.error(`\n解析问题 ${problems.length} 项：`)
    for (const p of problems.slice(0, 40)) console.error(`  ${p.file}:${p.line}  ${p.msg}`)
    if (problems.length > 40) console.error(`  ……其余 ${problems.length - 40} 项省略`)
  }

  if (CHECK_ONLY) {
    process.exit(problems.length ? 1 : 0)
  }

  // 生成。整个 content/ 由本脚本掌管，先清空避免残留旧页面。
  if (existsSync(CONTENT_DIR)) rmSync(CONTENT_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })
  for (const o of out) {
    const dir = join(CONTENT_DIR, o.slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '_index.md'), o.index, 'utf8')
    for (const p of o.pages) writeFileSync(join(dir, p.file), p.content, 'utf8')
  }
  // 首页：站点根内容，若已存在则不覆盖（由站点作者维护欢迎语）
  const homePath = join(CONTENT_DIR, '_index.md')
  if (!existsSync(homePath)) {
    writeFileSync(
      homePath,
      ['---', 'title: 劳动权益与合规指南', 'description: 中国大陆劳动权益与合规的循证指南', '---', ''].join('\n'),
      'utf8',
    )
  }
  writeFileSync(
    join(DATA_DIR, 'entries.json'),
    `${JSON.stringify(allEntries, null, 2)}\n`,
    'utf8',
  )
  console.log(`\n已生成：site/content/（${out.length} 节 ${total} 页）与 site/data/entries.json`)
  if (problems.length) process.exit(1)
}

main()
