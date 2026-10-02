#!/usr/bin/env node
/**
 * 看板.mjs —— 全书内容状态一览（只读）
 *
 *   node tools/看板.mjs              打印看板
 *   node tools/看板.mjs --json <文件> 输出机器可读结果
 *   node tools/看板.mjs --section N   只看第 N 节
 *   node tools/看板.mjs --root <目录> 指定仓库根目录
 *
 * 为什么需要它：本书正文有三百多条，分散在每节一个文件里。「哪节薄、哪条该复核、
 * 哪些还没定稿、哪些依据还没追到原文」这些问题，靠翻文件看不出来——本仓库
 * 已经因此让 docs/条目规范.md 里写死的条目数漂到了真实值的近两倍（看板第五节
 * 专门对账这一类手写数字）。
 *
 * **这个脚本只读，不改任何文件**（除了你显式指定的 --json 输出路径）。
 * 「发现的问题怎么改」由人决定；它是看板，不是自动修复器。
 *
 * 与既有工具的分工：
 *   - check-items.mjs 判**对错**（字段缺失、枚举越界、编号跳号）→ 门禁
 *   - check-sources.mjs 判**登记源**的链接与版本 → 门禁
 *   - 看板.mjs 看**分布与待办**（薄节、待复核、未定稿、缺取证时机）→ 决策
 *   看板不重复做上面两个的判定，只把它们关心的量摆出来。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REQUIRED_FIELDS, ENUMS, PENDING_MARK, STALE_DAYS, NO_LEGAL_BASIS,
  parseSectionFile, listBookFiles, fieldOf, enumHead, daysSince, urlsIn, today,
} from './lib/条目规范.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const ROOT = resolve(argOf('--root', resolve(HERE, '..')))
const BOOK = join(ROOT, 'book')
const JSON_OUT = argOf('--json', '')
const ONLY_SECTION = argOf('--section', '') ? Number(argOf('--section', '')) : null

const C = process.stdout.isTTY !== false
const dim = (s) => (C ? `\u001b[2m${s}\u001b[0m` : s)
const bold = (s) => (C ? `\u001b[1m${s}\u001b[0m` : s)
const red = (s) => (C ? `\u001b[31m${s}\u001b[0m` : s)
const yellow = (s) => (C ? `\u001b[33m${s}\u001b[0m` : s)

if (!existsSync(BOOK)) {
  console.error(`[环境错误] 找不到正文目录：${BOOK}`)
  process.exit(2)
}

const files = listBookFiles(BOOK)
const sections = []
const all = []

for (const path of files) {
  let parsed
  try {
    parsed = parseSectionFile(path, path)
  } catch (err) {
    console.error(`[环境错误] 读不了 ${path}：${err.message}`)
    process.exit(2)
  }
  if (parsed.section === null) continue
  sections.push(parsed)
  for (const e of parsed.entries) {
    all.push({
      ...e,
      sectionNumber: parsed.section,
      sectionTitle: parsed.title,
      file: parsed.rel,
      依据法规: [...fieldOf(e, '依据').matchAll(/《([^》]+)》/g)].map((m) => m[1].replace(/\s/g, '')),
    })
  }
}

if (all.length === 0) {
  console.error(`[环境错误] ${BOOK} 下一个条目都解析不到，看板无意义（需形如 ### 8.3 标题）`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 逐条派生状态
// ---------------------------------------------------------------------------

for (const e of all) {
  const 效力 = fieldOf(e, '效力位阶')
  const 主张 = enumHead(fieldOf(e, '主张强度'))
  const 举证 = enumHead(fieldOf(e, '举证难度'))
  const 核对日期 = fieldOf(e, '核对日期').replace(/\*\*|`/g, '').trim()
  const 定稿字段 = REQUIRED_FIELDS.filter((n) => fieldOf(e, n).includes(PENDING_MARK))

  e.状态 = {
    未定稿: 定稿字段.length > 0,
    未定稿字段: 定稿字段,
    无明文依据: 效力.includes(NO_LEGAL_BASIS),
    可推定: 主张 === '可推定',
    举证难: 举证 === '难',
    核对天数: daysSince(核对日期),
    待复核: (() => { const d = daysSince(核对日期); return d !== null && d > STALE_DAYS })(),
    无来源链接: urlsIn(fieldOf(e, '来源')).length === 0,
  }
}

// ---------------------------------------------------------------------------
// 打印
// ---------------------------------------------------------------------------

const staleLimit = STALE_DAYS
const stale = all.filter((e) => e.状态.待复核)
const pending = all.filter((e) => e.状态.未定稿)
const noBasis = all.filter((e) => e.状态.无明文依据)
const noLink = all.filter((e) => e.状态.无来源链接)

console.log(bold('《劳动者的账本》内容看板'))
console.log(dim(`仓库根：${ROOT}`))
console.log(dim(`生成日：${today()}　（核对日期超过 ${staleLimit} 天报「待复核」，仓库约定值）`))
console.log('')

console.log(bold('一、分布'))
console.log(dim('  节  条目  无明文  可推定  举证难  待复核  未定稿  节名'))
for (const s of sections) {
  if (ONLY_SECTION !== null && s.section !== ONLY_SECTION) continue
  const list = all.filter((e) => e.sectionNumber === s.section)
  const n = (f) => String(list.filter(f).length).padStart(4)
  console.log(
    `  ${String(s.section).padStart(2)}  ${String(list.length).padStart(4)}` +
    `  ${n((e) => e.状态.无明文依据)}  ${n((e) => e.状态.可推定)}` +
    `  ${n((e) => e.状态.举证难)}  ${n((e) => e.状态.待复核)}` +
    `  ${n((e) => e.状态.未定稿)}   ${s.title}`,
  )
}
console.log(
  `  ${dim('合计')} ${String(all.length).padStart(4)}  ` +
  `${String(noBasis.length).padStart(4)}  ${String(all.filter((e) => e.状态.可推定).length).padStart(4)}  ` +
  `${String(all.filter((e) => e.状态.举证难).length).padStart(4)}  ${String(stale.length).padStart(4)}  ` +
  `${String(pending.length).padStart(4)}`,
)

console.log('')
console.log(bold('二、待办'))
const todo = []
if (pending.length) todo.push(red(`未定稿 ${pending.length} 条`) + dim('　——含「待核实」，不得随版本发布'))
if (stale.length) todo.push(yellow(`待复核 ${stale.length} 条`) + dim(`　——核对日期超过 ${staleLimit} 天`))
if (noLink.length) todo.push(yellow(`无来源链接 ${noLink.length} 条`) + dim('　——效力位阶为无明文依据时属正常'))
if (todo.length === 0) console.log(dim('  无——未定稿 0、待复核 0'))
for (const t of todo) console.log(`  ${t}`)

const showList = (title, list, fmt) => {
  if (!list.length) return
  console.log('')
  console.log(dim(`  ${title}（${list.length}）`))
  for (const e of list.slice(0, 20)) console.log(`    ${e.sectionNumber}.${e.number} ${fmt(e)}`)
  if (list.length > 20) console.log(dim(`    ……其余 ${list.length - 20} 条省略`))
}
showList('未定稿', pending, (e) => `${e.title}　[${e.状态.未定稿字段.join('、')}]`)
showList('待复核', stale, (e) => `${e.title}　[核对日期 ${fieldOf(e, '核对日期')}，${e.状态.核对天数} 天前]`)
showList('无来源链接', noLink, (e) => `${e.title}　[效力位阶：${fieldOf(e, '效力位阶').slice(0, 20)}]`)

// 举证难度标「难」但没写取证时机——规范「举证难度怎么定」一节的要求
const TIMING_WORDS = ['离职前', '事前', '提前', '及时', '立即', '当场', '第一时间', '尽快', '留存', '保存', '导出',
  '备份', '拍照', '截图', '录音', '书面', '固化', '在职期间', '在职时']
const hardNoTiming = all.filter((e) => e.状态.举证难
  && !TIMING_WORDS.some((w) => fieldOf(e, '备注').includes(w) || fieldOf(e, '举证难度').includes(w)))
showList('举证难度「难」但未写取证时机（规范要求写）', hardNoTiming, (e) => e.title)

// 可推定但备注没写本地口径查询渠道
const LOCAL_WORDS = ['12333', '社保经办', '经办机构', '仲裁委', '人社', '当地', '地方口径', '本地口径', '咨询', '查询']
const presumNoChannel = all.filter((e) => e.状态.可推定 && !LOCAL_WORDS.some((w) => fieldOf(e, '备注').includes(w)))
showList('主张强度「可推定」但备注未写本地口径查询渠道（规范要求写）', presumNoChannel, (e) => e.title)

// ---------------------------------------------------------------------------
// 三、来源
// ---------------------------------------------------------------------------

console.log('')
console.log(bold('三、来源'))
const directUrl = all.filter((e) => urlsIn(fieldOf(e, '来源')).length > 0)
const viaRegistry = all.filter((e) => urlsIn(fieldOf(e, '来源')).length === 0
  && /法规清单|信源表|sources[\\/]/.test(fieldOf(e, '来源')))
console.log(`  来源栏直接内嵌 URL：${directUrl.length} 条`)
console.log(`  来源栏指向 sources/法规清单.md 的登记编号：${viaRegistry.length} 条`)
console.log(dim('  sources/法规清单.md「六、本表的使用约束」第 1 条要求这 324 条都填登记编号，'))
console.log(dim('  实际由本看板如实反映——这个数不达标时，清单换源不会传导到正文。'))

const registryPath = join(ROOT, 'sources', '法规清单.md')
let registryRecords = 0
let registryChecked = ''
if (existsSync(registryPath)) {
  const reg = readFileSync(registryPath, 'utf8')
  registryRecords = (reg.match(/^\|\s*[A-Z]\d{2}\s*\|/gm) || []).length
  const m = /最近全量复核日期[^0-9]*(\d{4}-\d{2}-\d{2})/.exec(reg)
  registryChecked = m ? m[1] : ''
  console.log(`  法规清单登记记录：${registryRecords} 条` + (registryChecked ? `，最近全量复核：${registryChecked}（${daysSince(registryChecked)} 天前）` : dim('，未标「最近全量复核日期」——清单侧没有时效机制')))
}

// 依据引用的法规 vs 清单登记
const cited = new Map()
for (const e of all) for (const name of e.依据法规) cited.set(name, (cited.get(name) || 0) + 1)
const citedSorted = [...cited.entries()].sort((a, b) => b[1] - a[1])
console.log('')
console.log(dim(`  正文「依据」引用的法规全称共 ${cited.size} 部，按引用条目数排序（前 12）：`))
for (const [name, n] of citedSorted.slice(0, 12)) console.log(`    ${String(n).padStart(4)} 条　《${name}》`)

// ---------------------------------------------------------------------------
// 四、覆盖与留痕
// ---------------------------------------------------------------------------

console.log('')
console.log(bold('四、覆盖与留痕'))
const skillPath = join(ROOT, 'skills', 'workers-ledger', 'SKILL.md')
if (existsSync(skillPath)) {
  const skill = readFileSync(skillPath, 'utf8')
  console.log(`  AI skill 体量：${skill.length} 字符`)
}
const recordDir = join(ROOT, 'docs', '核实记录')
if (existsSync(recordDir)) {
  const recs = readdirSync(recordDir).filter((f) => f.endsWith('.md'))
  const total = recs.reduce((a, f) => a + readFileSync(join(recordDir, f), 'utf8').length, 0)
  console.log(`  核实记录：${recs.length} 份，共 ${total} 字符`)
}
const toolsDir = join(ROOT, 'tools')
const tools = readdirSync(toolsDir).filter((f) => f.endsWith('.mjs'))
console.log(`  校验/构建脚本：${tools.length} 个`)

// 手写数字漂移检查：仓库文档里写死的「全书总量」是否与真实值一致。
//
// 判据必须精确到**全集量级声明**，不能扫所有「N 条 / N 节」：
//   - 「写「650 条建议，34 节」」是在描述**上游项目**，不是本书；
//   - 「第 11 至 14 节」「指到第 14 节对应条目」是**节内引用**，不是总数；
//   - 「143 条逐字摘录」指 sources/条文摘录.md 的摘录块数（实测 143，正确）。
// 把这些当漂移就是假阳性——一个会喊狼来了的看板没人看。所以只匹配明确的总量说法。
console.log('')
console.log(bold('五、手写数字对账'))
console.log(dim(`  真实值：${sections.length} 节 ${all.length} 条。只检查「全集量级」的声明，不检查节内引用。`))

const TOTAL_PATTERNS = [
  { re: /合计\s*(\d{2,4})\s*条/g, kind: '条' },
  { re: /全书\s*(\d{2,4})\s*条/g, kind: '条' },
  { re: /本书\s*(\d{2,4})\s*条/g, kind: '条' },
  { re: /共\s*(\d{2,4})\s*条/g, kind: '条' },
  { re: /本仓库\s*(\d{2,4})\s*条/g, kind: '条' },
  { re: /(\d{1,3})\s*节\s*(\d{2,4})\s*条/g, kind: '节条' },
]
const docTargets = [
  join(ROOT, 'docs', '条目规范.md'),
  join(ROOT, 'README.md'),
  join(ROOT, 'skills', 'workers-ledger', 'SKILL.md'),
  join(ROOT, 'AGENTS.md'),
]
let drift = 0
let checked = 0
for (const p of docTargets) {
  if (!existsSync(p)) continue
  const rel = p.replace(ROOT + '\\', '').replace(ROOT + '/', '')
  const lines = readFileSync(p, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    for (const { re, kind } of TOTAL_PATTERNS) {
      for (const m of line.matchAll(re)) {
        checked++
        if (kind === '条') {
          const n = Number(m[1])
          if (n !== all.length) {
            drift++
            console.log(`  ${yellow('≠')} ${rel}:${i + 1}　写「${m[0]}」，实际 ${all.length} 条　${dim(line.trim().slice(0, 58))}`)
          }
        } else {
          const [secN, itemN] = [Number(m[1]), Number(m[2])]
          if (secN !== sections.length || itemN !== all.length) {
            drift++
            console.log(`  ${yellow('≠')} ${rel}:${i + 1}　写「${secN} 节 ${itemN} 条」，实际 ${sections.length} 节 ${all.length} 条　${dim(line.trim().slice(0, 58))}`)
          }
        }
      }
    }
    // 形如「第 11 至 14 节」的区间声明：右端应等于最大节号
    for (const m of line.matchAll(/第\s*(\d{1,3})\s*(?:至|到|—|-|~|～)\s*(\d{1,3})\s*节/g)) {
      const hi = Number(m[2])
      if (hi !== sections.length) {
        drift++
        console.log(`  ${yellow('≠')} ${rel}:${i + 1}　写「${m[0]}」，但最大节号是 ${sections.length}　${dim(line.trim().slice(0, 58))}`)
      }
    }
  })
}
if (drift === 0) console.log(dim(`  未发现漂移（检查了 ${checked} 处全集量级声明）`))
else console.log(dim(`  共 ${drift} 处不一致。修法：改文档里的数字，或改成动态引用——本仓库不写死数字更好。`))

// ---------------------------------------------------------------------------
// JSON 输出
// ---------------------------------------------------------------------------

if (JSON_OUT) {
  const report = {
    生成日: today(),
    节数: sections.length,
    条目数: all.length,
    每节: sections.map((s) => ({
      节号: s.section,
      节名: s.title,
      条目数: all.filter((e) => e.sectionNumber === s.section).length,
    })),
    待办: {
      未定稿: pending.map((e) => ({ 条: `${e.sectionNumber}.${e.number}`, 标题: e.title, 字段: e.状态.未定稿字段 })),
      待复核: stale.map((e) => ({ 条: `${e.sectionNumber}.${e.number}`, 标题: e.title, 核对日期: fieldOf(e, '核对日期') })),
      无来源链接: noLink.map((e) => ({ 条: `${e.sectionNumber}.${e.number}`, 标题: e.title })),
      举证难未写取证时机: hardNoTiming.map((e) => `${e.sectionNumber}.${e.number}`),
      可推定未写查询渠道: presumNoChannel.map((e) => `${e.sectionNumber}.${e.number}`),
    },
    来源: {
      直接内嵌URL: directUrl.length,
      指向法规清单编号: viaRegistry.length,
      清单登记记录: registryRecords,
      清单最近全量复核: registryChecked || null,
    },
    依据引用法规数: cited.size,
  }
  try {
    writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(`\n看板 JSON 已写入：${JSON_OUT}`)
  } catch (err) {
    console.error(`[环境错误] JSON 写入失败：${err.message}`)
    process.exit(2)
  }
}
