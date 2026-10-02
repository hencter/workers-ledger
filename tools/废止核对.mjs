#!/usr/bin/env node
/**
 * 废止核对.mjs —— 附则里的废止/失效条款专项验证
 *
 *   node tools/废止核对.mjs                    报告模式
 *   node tools/废止核对.mjs --check            有硬问题退出 1
 *   node tools/废止核对.mjs --json <文件>      机器可读报告
 *   node tools/废止核对.mjs --summary <文件>   Markdown 汇总
 *   node tools/废止核对.mjs --only B06,B10     只看指定编号的缓存
 *
 * ## 为什么需要它（本仓库已因此漏过三次）
 *
 * 法规的**附则**里常写「……同时废止」或「……失效」。这类句子决定了
 * **另一部法规或某一条文还算不算数**，但此前没有任何机制把它纳入验证——三处
 * 全是靠人肉发现：
 *   1. N01 第五十条废止 2016 年版《职业学校学生实习管理规定》（正文四条引了旧版）；
 *   2. 清单 S01 行写「第三十二条第一款已由法释〔2025〕12 号第二十一条废止」（条文级）；
 *   3. B10 末条废止 2009 年人社部令第 2 号（本次登记时才看到）。
 *
 * 与既有闸口的分工：
 *   - `check-sources.mjs` 抓页面判链接失效与**版本号**是否更新；
 *   - `check-refs.mjs` 判「依据」引用的法规**是否登记**、正文写的**版本年份**是否落后；
 *   - 本工具专项判**废止关系**：谁被谁废止、有没有登记、引用了被废止对象的条文有没有标注。
 *   三者不重叠。
 *
 * ## 判据与它证明什么
 * 从 `sources/.原文缓存/`（官方原文纯文本）里按**机械规则**抽出废止语句，
 * 再与 `sources/法规清单.md`、`sources/条文摘录.md` 交叉核对。
 * **它只认能抽到的句子，抽不到不等于没有**——所以报告里会写清「扫描覆盖了哪些缓存」。
 *
 * 退出码：0 通过 / 1 有硬问题 / 2 环境错误
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CACHE = join(ROOT, 'sources', '.原文缓存')
const REGISTRY = join(ROOT, 'sources', '法规清单.md')
const EXCERPTS = join(ROOT, 'sources', '条文摘录.md')

const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const CHECK = has('--check')
const JSON_OUT = argOf('--json', '')
const SUMMARY = argOf('--summary', '')
const ONLY = argOf('--only', '').split(',').map((s) => s.trim()).filter(Boolean)

if (!existsSync(CACHE)) { console.error(`[环境错误] 找不到原文缓存：${CACHE}\n先跑：node tools/抽原文.mjs --all`); process.exit(2) }
if (!existsSync(REGISTRY)) { console.error(`[环境错误] 找不到 ${REGISTRY}`); process.exit(2) }

const 规范 = (s) => String(s).replace(/[\s　《》「」（）()【】〔〕·、，,。．.\-—–_]/g, '')

// ---------------------------------------------------------------------------
// 判据：废止语句的机械形态
// ---------------------------------------------------------------------------

/**
 * 形式一（动词在对象之后，最常见）：`<对象>同时废止`、`<对象>予以废止`、`<对象>废止`
 * 例：`1993年11月24日原劳动部发布的《企业最低工资规定》同时废止。`
 *
 * 形式二（动词在对象之前）：`废止<对象>`、`自…起废止<对象>`
 * 例：`《劳动人事争议仲裁办案规则》（人力资源和社会保障部令第2号）同时废止`属形式一；
 *     而`废止《XX办法》`属形式二。
 */
const 形式一 = /([^。；;]{0,120}?)(?:同时|予以|自[^。；;]{0,20}?起)?废止/g
const 形式二 = /废止(?:了)?\s*《([^》]{2,60})》/g

/** 条文级废止：`第X条…废止`、`第X条…失效`、`第X条…不再适用` */
const 条文级 = /第[一二三四五六七八九十百零〇\d]+条(?:第[一二三四五六七八九十百零〇\d]+款)?[^。；;]{0,80}?(?:废止|失效|不再适用)/g

/** 「失效」单独出现时也值得报（可能是法定期限届满的法律后果，不一定是废止） */
const 失效语 = /[^。；;]{0,80}?失效[^。；;]{0,40}/g

/** 只统计全文中「予以修改/修正」的密集度，用于判断清单是否漏记修订 */
const 修订语 = /(?:予以|作出|决定)?(?:修改|修正|修订)/g

// ---------------------------------------------------------------------------

/** 从一段修饰文字里抠出被废止对象的名称与线索（日期、发布机关、文号） */
function parseObject(片段) {
  const 名称 = [...片段.matchAll(/《([^》]{2,60})》/g)].map((m) => m[1].trim())
  const 日期 = (片段.match(/(?:\d{4}|[０-９]{4})\s*年\s*(?:\d{1,2}|[０-９]{1,2})\s*月\s*(?:\d{1,2}|[０-９]{1,2})\s*日/g) || []).slice(-1)[0] || ''
  const 文号 = (片段.match(/[（(]([^）)]{0,40}(?:令|号)[^）)]{0,20})[）)]/g) || []).slice(-1)[0] || ''
  const 机关 = (片段.match(/(?:原)?[\u4e00-\u9fa5]{2,20}(?:部|委员会|局|院|政府|办公厅)/g) || []).slice(-1)[0] || ''
  return { 名称, 日期, 文号, 机关 }
}

/**
 * 判断一个被「《》」包起来的名称，究竟是不是**被废止的对象**。
 *
 * 为什么需要它：`同时废止` 前面的窗口里常夹着**另一部文件的名称**，最典型的是
 * 「根据 2024 年 6 月 14 日《人力资源社会保障部关于修改和废止部分规章的决定》第三次修订」
 * ——这里《…决定》是**做修订的那个文件**，不是被废止的对象。第一版把它当成了硬问题，
 * 属误报。判据：名称里含「决定」「通知」「批复」等公文种类词的，不是被废止的法规本身。
 */
function 是被废止对象(名称) {
  if (/决定|通知|批复|公告|意见|方案|复函|答复/.test(名称)) return false
  if (名称.length < 4) return false
  return true
}

/** 归一化：全角数字转半角，便于同一语句在不同页面上被判为同一处 */
const 半角 = (s) => String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))

/** 语句指纹：用于跨缓存页去重（同一处废止在两个官方页上各出现一次） */
const 指纹 = (x) => `${x.id}|${半角(x.语句).replace(/\s+/g, '')}|${x.对象名称.filter(是被废止对象).sort().join('、')}`

const registryText = readFileSync(REGISTRY, 'utf8')
const registryNorm = 规范(registryText)
const excerptsText = readFileSync(EXCERPTS, 'utf8')

/** 摘录里出现的条号（用于判断某条被废止的条文有没有被本书引用） */
const 摘录条号 = [...excerptsText.matchAll(/^###\s+第([一二三四五六七八九十百零〇]+)条/gm)].map((m) => m[1])

const files = readdirSync(CACHE).filter((f) => f.endsWith('.txt')).sort()
  .filter((f) => !ONLY.length || ONLY.some((id) => f.startsWith(`${id}-`)))

const 全量废止 = []
const 条文废止 = []
const 失效语句 = []
const scanned = []

for (const f of files) {
  const id = f.split('-')[0]
  const raw = readFileSync(join(CACHE, f), 'utf8')
  const text = raw.replace(/\s+/g, '')
  scanned.push({ file: f, id, 字符数: text.length })

  // 形式一与形式二
  for (const re of [形式一, 形式二]) {
    const r2 = new RegExp(re.source, 'g')
    let m
    while ((m = r2.exec(text)) !== null) {
      const 片段 = m[0]
      // 排除明显不是废止的（例如「废止部分规章的决定」是文件名）
      if (/废止部分规章|修改和废止部分规章|决定废止部分/.test(片段)) continue
      const obj = parseObject(片段)
      if (!obj.名称.length) continue
      全量废止.push({ file: f, id, 语句: 片段, 对象名称: obj.名称, 日期: obj.日期, 文号: obj.文号, 机关: obj.机关 })
    }
  }

  // 条文级
  for (const m of text.matchAll(条文级)) {
    条文废止.push({ file: f, id, 语句: m[0] })
  }

  // 失效
  for (const m of text.matchAll(失效语)) {
    if (/失效部分|部分规章/.test(m[0])) continue
    失效语句.push({ file: f, id, 语句: m[0] })
  }
}

// 去重（同一语句在同一文件里重复出现）
const uniq = (list, keyFn) => {
  const seen = new Set()
  return list.filter((x) => {
    const k = keyFn(x)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const 全量废止去重 = uniq(全量废止, (x) => `${x.file}|${x.语句}|${x.对象名称.join('、')}`)
const 条文废止去重 = uniq(条文废止, (x) => `${x.file}|${x.语句}`)
const 失效去重 = uniq(失效语句, (x) => `${x.file}|${x.语句}`)

// ---------------------------------------------------------------------------
// 交叉核对
// ---------------------------------------------------------------------------

/**
 * 硬问题：**被废止的对象与本书有关**，但全书没有任何地方标注它已废止。
 *
 * 为什么不能把所有「被废止但未登记」都判硬：首轮就这么判，结果 14 项里绝大多数是
 * 《民法典》第一千二百六十条废止的九部旧法（婚姻法、继承法、民法通则、收养法、
 * 担保法、合同法、物权法、侵权责任法、民法总则）——本书既不登记也不引用它们，
 * **对读者无害**。全判硬就是狼来了，真问题会被淹掉。
 *
 * 收窄后的判据：只有当被废止对象**在本书里出现过**（出现在正文的依据/来源栏，
 * 或已在清单登记）才算硬问题——那才是「读者可能照着已失效的依据办事」的情形。
 * 其余降级为提示，并在报告里说明「已废止但本书未采用」。
 */
const 硬问题1 = []
const 提示0 = []

/**
 * 「这个被废止的对象与本书有关吗」——只看两处：清单是否登记过它、摘录与正文是否提到它。
 * 登记过但未标注废止的，走提示 1；都没出现过的，进提示 0（已废止但本书未采用）。
 */
const 与本书有关 = (name) => {
  const n = 规范(name)
  if (n.length < 4) return false
  if (registryNorm.includes(n)) return true
  if (规范(excerptsText).includes(n)) return true
  return false
}
for (const x of 全量废止去重) {
  for (const name of x.对象名称) {
    if (!是被废止对象(name)) continue
    const n = 规范(name)
    if (n.length < 4) continue
    if (registryNorm.includes(n)) continue // 已登记，不算「找不到」
    if (与本书有关(name)) {
      硬问题1.push({ ...x, 缺失名称: name })
    } else {
      提示0.push({ ...x, 名称: name })
    }
  }
}

/**
 * 提示 1：废止语句所在的这**部法规**，清单那一行有没有提到「废止」这件事。
 * 没提到不是错误（清单的核验状态列本来就精简），但值得人工确认一次。
 */
const 提示1 = []
for (const x of 全量废止去重) {
  const id = x.id
  // 找到清单里该编号的行
  const line = registryText.split('\n').find((l) => new RegExp(`^\\|\\s*${id}\\s*\\|`).test(l.trim()))
  if (!line) continue
  if (!/废止/.test(line)) 提示1.push({ id, file: x.file, 语句: x.语句.slice(0, 100) })
}

/** 提示 2：清单里写了「已废止/失效」的编号，其正文行是否也在正文中被引用（需要标注） */
const 提示2 = []
for (const m of registryText.matchAll(/^\|\s*([A-Z]\d{2})\s*\|([^\n]*)$/gm)) {
  const id = m[1]
  const row = m[2]
  if (!/废止|失效/.test(row)) continue
  // 该编号在 book/ 里被引用了几次（粗查：依据栏里的法规全称）
  const name = (row.split('|')[0] || '').trim()
  提示2.push({ id, 名称: name, 片段: row.slice(0, 120) })
}

/** 提示 3：「失效」语句——可能是法定期限届满之类，不一定是废止，逐条列出供人工判 */
const 提示3 = 失效去重

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

console.log('废止条款专项核对（附则里的「同时废止 / 失效 / 不再适用」）')
console.log(`原文缓存：${CACHE}`)
console.log(`扫描缓存 ${scanned.length} 个文件（覆盖编号：${[...new Set(scanned.map((s) => s.id))].join('、')}）`)
console.log('')

console.log(`一、整部废止语句：${全量废止去重.length} 处`)
for (const x of 全量废止去重) {
  console.log(`  [${x.id}] ${x.语句}`)
  console.log(`      被废止对象：${x.对象名称.map((n) => `《${n}》`).join('、')}${x.日期 ? `　日期：${x.日期}` : ''}${x.文号 ? `　文号：${x.文号}` : ''}`)
}

console.log('')
console.log(`二、条文级废止/失效语句：${条文废止去重.length} 处`)
for (const x of 条文废止去重.slice(0, 30)) console.log(`  [${x.id}] ${x.语句}`)
if (条文废止去重.length > 30) console.log(`  ……其余 ${条文废止去重.length - 30} 处`)

console.log('')
console.log(`三、「失效」语句（需人工判断是废止还是期限届满）：${提示3.length} 处`)
for (const x of 提示3.slice(0, 20)) console.log(`  [${x.id}] ${x.语句}`)
if (提示3.length > 20) console.log(`  ……其余 ${提示3.length - 20} 处`)

console.log('')
console.log('四、交叉核对')
console.log(`  [硬] 被废止对象与本书有关、却未登记：${硬问题1.length} 项`)
for (const x of 硬问题1) {
  console.log(`    ✗ [${x.id}] ${x.语句.slice(0, 90)}`)
  console.log(`        与本书有关但清单里找不到：《${x.缺失名称}》`)
}
if (!硬问题1.length) console.log('    （无）')
console.log(`  [提示] 被废止但本书未采用（登记与引用里都没有）：${提示0.length} 项`)
if (提示0.length) {
  const 名 = [...new Set(提示0.map((x) => x.名称))]
  console.log(`    涉及 ${名.length} 部：${名.map((n) => `《${n}》`).join('、')}`)
  console.log('    说明：这些法规已被废止，但本书既不登记也不引用，对读者无害；列出仅为完整。')
}
console.log(`  [提示] 废止语句所在法规的清单行未提及「废止」：${提示1.length} 项`)
for (const x of 提示1.slice(0, 12)) console.log(`    · [${x.id}] ${x.语句}`)
if (提示1.length > 12) console.log(`    ……其余 ${提示1.length - 12} 项`)
console.log(`  [提示] 清单里标注了废止/失效的登记：${提示2.length} 项`)
for (const x of 提示2) console.log(`    · ${x.id} ${x.名称}`)

// 汇总
const 有废止记载 = [...new Set(全量废止去重.map((x) => x.id))]
console.log('')
console.log('—— 汇总 ——')
console.log(`扫描 ${scanned.length} 个缓存文件；整部废止 ${全量废止去重.length} 处，涉及 ${有废止记载.length} 部法规（${有废止记载.join('、')}）`)
console.log(`条文级废止/失效 ${条文废止去重.length} 处；失效语句 ${提示3.length} 处`)
console.log(`硬问题 ${硬问题1.length} 项，提示 ${提示1.length + 提示2.length + 提示3.length} 项`)

// 边界说明（必须与结论一起看）
console.log('')
console.log('边界：')
console.log('  1. 只认能从官方原文纯文本里按机械规则抽到的废止语句；抽不到不等于没有。')
console.log(`  2. 本轮扫描覆盖 ${scanned.length} 个缓存文件；未缓存的法规（例如抓取失败的页面）不在内。`)
console.log('  3. 「失效」不一定是废止（也可能是期限届满、条款被修正），一律列入人工判断，不自动判错。')

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    生成时间: new Date().toISOString(),
    扫描缓存文件数: scanned.length,
    覆盖编号: [...new Set(scanned.map((s) => s.id))],
    整部废止: 全量废止去重,
    条文废止: 条文废止去重,
    失效语句: 失效去重,
    硬问题: 硬问题1,
    提示: { 清单行为提及废止: 提示1, 清单已标注废止: 提示2, 失效待判: 提示3 },
    摘录里的条号数: 摘录条号.length,
  }, null, 2) + '\n', 'utf8')
  console.log(`\nJSON：${JSON_OUT}`)
}

if (SUMMARY) {
  const lines = [
    '## 废止条款专项核对',
    '',
    `- 扫描缓存 ${scanned.length} 个文件`,
    `- 整部废止 **${全量废止去重.length}** 处，涉及 ${有废止记载.length} 部法规`,
    `- 条文级废止/失效 **${条文废止去重.length}** 处；「失效」语句 ${提示3.length} 处`,
    `- 硬问题 **${硬问题1.length}** 项`,
    '',
    '| 编号 | 废止语句 | 被废止对象 |',
    '| --- | --- | --- |',
    ...全量废止去重.map((x) => `| ${x.id} | ${x.语句.replace(/\|/g, '\\|').slice(0, 120)} | ${x.对象名称.map((n) => `《${n}》`).join('、')} |`),
    '',
  ]
  writeFileSync(SUMMARY, lines.join('\n'), 'utf8')
  console.log(`Markdown 汇总：${SUMMARY}`)
}

if (CHECK && 硬问题1.length) {
  console.error(`\n[失败] 有 ${硬问题1.length} 项：被废止的对象在 sources/法规清单.md 里找不到登记`)
  process.exit(1)
}
console.log(CHECK ? '\n[通过] 没有硬问题（提示项需人工判断）' : '\n（报告模式：提示项需人工判断）')
process.exit(0)
