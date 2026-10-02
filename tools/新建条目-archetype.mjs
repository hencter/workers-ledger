#!/usr/bin/env node
/**
 * 新建条目-archetype.mjs —— 用 Hugo archetype 生成条目，再落进 book/
 *
 *   node tools/新建条目-archetype.mjs <节号> "条目标题"
 *   node tools/新建条目-archetype.mjs <节号> "条目标题" --after <编号>
 *   node tools/新建条目-archetype.mjs <节号> "条目标题" --show    只打印将写入的 block
 *   node tools/新建条目-archetype.mjs --check-archetype           校验 archetype 本身可渲染
 *
 * ## 这一层解决什么
 *
 * `hugo new` 是 Hugo 原生的内容脚手架，模板放在 `site/archetypes/` 下，写一次就复用。
 * 但本仓库的真相源是 `book/`，而 `hugo new` **只能写进 Hugo 的 contentDir**——
 * 直接 `hugo new` 会落到 `site/content/`，那是 `tools/build-site.mjs` 每次构建
 * 整体重建的生成物，写了会被抹掉（这也是 site/archetypes/default.md 长期失效的原因）。
 *
 * 实测过两条"正路"都走不通：
 *   - `hugo new -c book` → Hugo 报 `no existing content directory configured for this project`
 *     （-c 会覆盖 contentDir，Hugo 随后找不到已配置的内容目录）；
 *   - 把 book/ 配成 contentDir → 会把正文变成 Hugo 页面集合，破坏现有单向往生成链
 *     （book/ 是真相源，site/content 是它的视图，方向不能反）。
 *
 * 所以采用：**在临时 Hugo 项目里渲染 archetype → 把渲染结果按条目格式落进 book/。**
 * 模板本体仍然是真正的 archetype 文件（`site/archetypes/条目.md`），
 * 改模板不用改代码；编号连续、字段顺序、枚举合法性仍由已验证的工具链守着。
 *
 * 只使用 Node 24 内置模块，零依赖。
 * 退出码：0 成功 / 1 参数或前置条件不满足 / 2 环境错误
 */

import {
  readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, copyFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REQUIRED_FIELDS, COST_TAG_ORDER, costTagLine, listBookFiles, parseSectionFile } from './lib/条目规范.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SITE = join(ROOT, 'site')
const ARCHETYPE_DIR = join(SITE, 'archetypes')
const ARCHETYPE = join(ARCHETYPE_DIR, '条目.md')
const BOOK = join(ROOT, 'book')

const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const die = (m) => { console.error(`[失败] ${m}`); process.exit(1) }
const envDie = (m) => { console.error(`[环境错误] ${m}`); process.exit(2) }

if (has('--help') || argv.length === 0) {
  console.log(`新建条目（Hugo archetype 版）—— 用法：
  node tools/新建条目-archetype.mjs <节号> "条目标题" [--after <编号>] [--show]
  node tools/新建条目-archetype.mjs --check-archetype

模板：site/archetypes/条目.md（真正的 Hugo archetype，改它即可改模板）
落盘：调用经过验证的 tools/新建条目.mjs 插入 book/，编号连续由它保证
说明：新条目字段为「待核实」占位，属未定稿；跑 node tools/看板.mjs 能看到它。`)
  process.exit(argv.length === 0 ? 1 : 0)
}

if (!existsSync(ARCHETYPE)) envDie(`找不到 archetype：${ARCHETYPE}`)
if (!existsSync(SITE)) envDie(`找不到站点目录：${SITE}`)

const pos = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { if (['--after'].includes(argv[i])) i++; continue }
  pos.push(argv[i])
}

/** 在临时 Hugo 项目里渲染 archetype，返回渲染出的 markdown */
function renderArchetype(sectionNumber, title) {
  const tmp = mkdtempSync(join(tmpdir(), 'wrc-archetype-'))
  try {
    mkdirSync(join(tmp, 'content'), { recursive: true })
    mkdirSync(join(tmp, 'archetypes'), { recursive: true })
    writeFileSync(join(tmp, 'hugo.toml'), "title = 'wrc-archetype-scaffold'\n", 'utf8')
    copyFileSync(ARCHETYPE, join(tmp, 'archetypes', '条目.md'))

    // 文件名只用于渲染（.File.ContentBaseName 会进 front matter 的 title）；
    // 编号前缀用节号补齐，便于人看出归属，但真正的编号由插入工具决定。
    const base = title.replace(/[\\/:*?"<>|#%]/g, '').replace(/\s+/g, '-')
    const rel = `${String(sectionNumber).padStart(2, '0')}-${base}/${base}.md`
    const r = spawnSync('hugo', ['new', 'content', rel, '--kind', '条目'], {
      cwd: tmp, encoding: 'utf8',
    })
    if (r.error) envDie(`无法执行 hugo：${r.error.message}`)
    const out = `${r.stdout || ''}${r.stderr || ''}`
    if (r.status !== 0) {
      die(`hugo new 失败（退出码 ${r.status}）：\n${out.trim()}\n` +
        '提示：archetype 模板语法出错时 Hugo 会打印具体字段名。用 --check-archetype 单独验证。')
    }
    const created = join(tmp, 'content', String(sectionNumber).padStart(2, '0') + '-' + base, `${base}.md`)
    if (!existsSync(created)) die(`hugo new 报了成功但找不到产物：${created}\n输出：${out.trim()}`)
    return { md: readFileSync(created, 'utf8'), 日志: out.trim() }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * 把 archetype 渲染出的 markdown（YAML front matter + 正文）转成 book/ 的条目格式：
 *   ### <节号>.<条号> <标题>
 *   - 字段：值
 *   <!-- 成本标签: … -->
 *
 * 为什么需要转换：archetype 产出 front matter 是为了**将来站点能直接吃 Hugo 原生内容**；
 * 而 book/ 的 `- 字段：值` 格式是 docs/条目规范.md 的权威格式，也是 AI skill 与校验脚本的输入。
 * 两者必须保持可机械互转，所以映射写在代码里、不靠人脑记。
 */
function frontMatterToEntry(md, sectionNumber, entryNumber) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md)
  if (!m) die('archetype 渲染结果里找不到 YAML front matter（应为 --- 包围）')
  const [, fmRaw, bodyRaw] = m

  // 极简 YAML 取值：只处理 archetype 用到的「键: "值"」与两级缩进（params 下的字段与成本标签）。
  // 不引 YAML 库（本仓库零依赖），所以刻意只支持这一种结构，并在取不到时报错而不是静默给空值。
  const params = {}
  const 成本标签 = {}
  let inParams = false
  let inCost = false
  for (const line of fmRaw.split(/\r?\n/)) {
    if (!line.trim()) continue
    const top = /^([^\s][^:]*):\s*(.*)$/.exec(line)
    if (top) {
      inParams = top[1].trim() === 'params'
      inCost = false
      continue
    }
    const p2 = /^ {2}([^\s][^:]*):\s*(.*)$/.exec(line)
    if (p2 && inParams) {
      inCost = p2[1].trim() === '成本标签'
      if (!inCost) params[p2[1].trim()] = unq(p2[2])
      continue
    }
    const p4 = /^ {4}([^\s][^:]*):\s*(.*)$/.exec(line)
    if (p4 && inCost) { 成本标签[p4[1].trim()] = unq(p4[2]); continue }
  }

  const 标题 = params['节名'] ? String(params['节名']) : ''
  const title = pickTitle(fmRaw) || '（待填标题）'

  const out = [`### ${sectionNumber}.${entryNumber} ${title}`, '']
  for (const f of REQUIRED_FIELDS) {
    const v = params[f]
    if (v === undefined) {
      die(`archetype 没有提供字段「${f}」——请检查 ${ARCHETYPE} 的 params 段与 docs/条目规范.md 的字段表`)
    }
    out.push(`- ${f}：${f === '说人话' ? stripInlineLite(v) : v}`)
  }
  const tag = {}
  for (const k of COST_TAG_ORDER) tag[k] = 成本标签[k] ?? '0'
  out.push(costTagLine(tag))
  out.push('')
  return { entry: out.join('\n'), title }
}

const unq = (s) => String(s).trim().replace(/^["']|["']$/g, '')
const stripInlineLite = (s) => String(s).replace(/\*\*/g, '').replace(/`/g, '').trim()
const pickTitle = (fm) => {
  const m = /^title:\s*["']?(.*?)["']?\s*$/m.exec(fm)
  return m ? m[1].trim() : ''
}

// ---------------------------------------------------------------------------

if (has('--check-archetype')) {
  const r = renderArchetype(16, 'archetype-自检')
  const { entry } = frontMatterToEntry(r.md, 16, 1)
  console.log('archetype 自检通过：渲染成功，且 13 个字段齐备、可转换为条目格式。')
  console.log(`渲染出的 front matter 长度：${r.md.length} 字符`)
  console.log('')
  console.log(entry.slice(0, 480) + (entry.length > 480 ? '\n…' : ''))
  process.exit(0)
}

if (pos.length < 2) die(`参数不足。用法：node tools/新建条目-archetype.mjs <节号> "条目标题"（现有节见 node tools/新建条目.mjs --help）`)
const sectionNumber = Number(pos[0])
const title = pos.slice(1).join(' ').trim()
if (!Number.isInteger(sectionNumber) || sectionNumber < 1) die(`节号非法：${pos[0]}`)
if (!title) die('条目标题不能为空')

// 节必须已存在（新建节请用 tools/新建条目.mjs --new-section）
const sections = new Map()
for (const p of listBookFiles(BOOK)) {
  const s = parseSectionFile(p, p)
  if (s.section !== null) sections.set(s.section, s)
}
if (!sections.has(sectionNumber)) {
  die(`节号 ${sectionNumber} 不存在。现有节：${[...sections.keys()].sort((a, b) => a - b).join('、')}\n` +
    `若要在末尾新建一节：node tools/新建条目.mjs --new-section "节标题"`)
}
const sec = sections.get(sectionNumber)

console.log('新建条目（archetype 版）')
console.log(`节：${sec.section}. ${sec.title}（现有 ${sec.entries.length} 条）`)
console.log(`标题：${title}`)
console.log(`模板：site/archetypes/条目.md`)
console.log('')

const r = renderArchetype(sectionNumber, title)
const { entry, title: renderedTitle } = frontMatterToEntry(r.md, sectionNumber, sec.entries.length + 1)

if (renderedTitle && renderedTitle !== title) {
  console.log(`[提示] archetype 渲染出的标题是「${renderedTitle}」，命令行给的是「${title}」——以命令行为准。`)
}

if (has('--show')) {
  console.log('将写入的条目块：')
  console.log('')
  console.log(entry)
  process.exit(0)
}

// 交给已验证的插入工具：它保证编号连续、字段顺序、写后自检与回滚。
// 把 block 落到临时文件，再让 新建条目.mjs 读它——避免复制一份插入逻辑。
const tmpBlock = join(BOOK, `.archetype-block-${process.pid}.md`)
try {
  writeFileSync(tmpBlock, entry, 'utf8')
  const args = ['tools/新建条目.mjs', String(sectionNumber), title]
  const after = argOf('--after', '')
  if (after) args.push('--after', after)
  // 捕获内层输出后**只转述到「下一步」之前**：内层自己也会打印一段「下一步」，
  // 直接 inherit 会让提示出现两遍。用 pipe + 手动转发而不是 stdio:'inherit'，
  // 是为了精确控制这段边界。
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
  if (res.error) die(`调用 tools/新建条目.mjs 失败：${res.error.message}`)
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const cut = out.indexOf('下一步：')
  process.stdout.write(cut >= 0 ? out.slice(0, cut) : out)
  if (res.status !== 0) die(`tools/新建条目.mjs 退出码 ${res.status}，条目未插入`)
} finally {
  rmSync(tmpBlock, { force: true })
}

console.log('')
console.log('下一步：')
// 只用文件名，不要打印绝对路径：parseSectionFile 返回的 .rel 是调用方给的值，
// 这里传的是绝对路径，直接拼进提示会得到「book/C:\...\book\01-x.md」这种残留。
console.log(`  1. 编辑 book/${basename(sec.path)}，把 13 个字段的「待核实」逐项落实到官方原文`)
console.log('  2. node tools/check-items.mjs --check')
console.log('  3. node tools/build-site.mjs && node tools/check-site.mjs')
