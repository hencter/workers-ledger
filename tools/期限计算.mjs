#!/usr/bin/env node
/**
 * 期限计算.mjs —— 把期限落成具体日期（含起算规则、节假日顺延、工作日模式）
 *
 *   node tools/期限计算.mjs <起算日> <时长> --unit day|month|year|workday
 *   node tools/期限计算.mjs <起算日> 15 --unit day                     # 自然日
 *   node tools/期限计算.mjs <起算日> 45 --unit workday                 # 工作日
 *   node tools/期限计算.mjs <起算日> 1 --unit year
 *   node tools/期限计算.mjs --list-rules                              # 打印全部期限规则与其适用法条
 *   node tools/期限计算.mjs <起算日> 15 --unit day --rule 仲裁起诉      # 用规则名代入并打印出处
 *   node tools/期限计算.mjs <起算日> <时长> --unit day --no-extend     # 不适用节假日顺延（法条另有规定时）
 *
 * ## 为什么需要它：读者要的是「哪一天之前」，不是「多少日」
 *
 * 本书八处以上的期限（仲裁一年、起诉 15 日、撤销 30 日、工伤认定 60／15 日、鉴定 60＋30 日、
 * 再次鉴定 15 日、执行二年…）此前只以「N 日」形式写出，**从未落成具体日期，也从未算过工作日**。
 * 而在临界点上，起算点差一天、末日遇不遇节假日，结果就差好几天——这正是本仓库「时效」
 * 那一栏存在的意义，却一直没有对应的计算工具。
 *
 * ## 计算规则及其依据（不是我想当然定的）
 *
 * 《民法典》总则编（本仓库 `sources/全文/L11.md` 已收录全文）：
 *   - 第二百条：民法所称的期间按照公历年、月、日、小时计算。
 *   - 第二百零一条：按照年、月、日计算期间的，**开始的当日不计入，自下一日开始计算**。
 *   - 第二百零二条：按照年、月计算期间的，**到期月的对应日**为期间的最后一日；没有对应日的，月末日为最后一日。
 *   - 第二百零三条：期间的最后一日是**法定休假日的，以法定休假日结束的次日**为期间的最后一日；
 *     期间的最后一日的截止时间为二十四时，有业务时间的，停止业务活动的时间为截止时间。
 *   - 第二百零四条：期间的计算方法依照本法的规定，**但是法律另有规定或者当事人另有约定的除外**。
 *
 * 由此得到三条判据，本工具据此实现：
 *   ① **起算日不计入**，从次日起算；
 *   ② 法定期间默认按**自然日**计算——本仓库已机械核对：《民法典》全文「工作日」出现 **0 次**，
 *      《劳动争议调解仲裁法》与《工伤保险条例》亦各 **0 次**。所以「N 日」＝自然日，
 *      **不是工作日**；只有写明「工作日」的才按工作日算（`--unit workday`）；
 *   ③ 末日遇**法定休假日顺延**到休假日结束的次日。注意顺延只看「法定休假日」，
 *      普通周六周日属「休息日」而非法定休假日，法条未明写——本工具对这两种情形
 *      **分别标注**，不合并成一句结论（见输出的「顺延依据」）。
 *
 * 只使用 Node 24 内置模块，零依赖。
 * 退出码：0 成功 / 1 参数错误 / 2 环境错误
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const HOLIDAYS = join(HERE, '法定节假日.json')

const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

// ---------------------------------------------------------------------------
// 期限规则表：把书里出现的期限与其法定依据集中登记，供 --rule 代入
// ---------------------------------------------------------------------------

const RULES = [
  { 名: '仲裁申请时效', 时长: 1, unit: 'year', 依据: '《劳动争议调解仲裁法》第二十七条：一年，自知道或应当知道权利被侵害之日起算；劳动关系存续期间因拖欠劳动报酬发生争议的不受一年限制，劳动关系终止的，自终止之日起一年内提出', 起算点: '知道或应当知道权利被侵害之日' },
  { 名: '仲裁受理通知', 时长: 5, unit: 'day', 依据: '《劳动人事争议仲裁办案规则》第三十条：收到仲裁申请之日起 5 日内出具受理通知书', 起算点: '收到仲裁申请之日' },
  { 名: '答辩期', 时长: 10, unit: 'day', 依据: '《劳动人事争议仲裁办案规则》第三十三条：被申请人收到申请书副本后 10 日内提交答辩书', 起算点: '收到仲裁申请书副本之日' },
  { 名: '仲裁审理期限', 时长: 45, unit: 'day', 依据: '《劳动争议调解仲裁法》第四十三条、《办案规则》第四十五条：受理之日起 45 日内结束', 起算点: '受理之日' },
  { 名: '仲裁审理延期上限', 时长: 15, unit: 'day', 依据: '《劳动争议调解仲裁法》第四十三条、《办案规则》第四十五条：经书面批准可延期，不超过 15 日', 起算点: '受理之日起 45 日届满之日' },
  { 名: '仲裁起诉期限', 时长: 15, unit: 'day', 依据: '《劳动争议调解仲裁法》第五十条：对裁决不服的，自收到裁决书之日起 15 日内向人民法院提起诉讼', 起算点: '收到裁决书之日' },
  { 名: '用人单位申请撤销终局裁决', 时长: 30, unit: 'day', 依据: '《劳动争议调解仲裁法》第四十九条：自收到裁决书之日起 30 日内向劳动争议仲裁委员会所在地的中级人民法院申请撤销', 起算点: '用人单位收到裁决书之日' },
  { 名: '工伤认定申请（单位）', 时长: 30, unit: 'day', 依据: '《工伤保险条例》第十七条：所在单位应当自事故伤害发生之日或者被诊断、鉴定为职业病之日起 30 日内提出', 起算点: '事故伤害发生之日或被诊断、鉴定为职业病之日' },
  { 名: '工伤认定申请（劳动者一方）', 时长: 1, unit: 'year', 依据: '《工伤保险条例》第十七条：用人单位未按前款规定提出申请的，工伤职工或者其近亲属、工会组织在事故伤害发生之日或者被诊断、鉴定为职业病之日起 1 年内可以直接提出', 起算点: '事故伤害发生之日或被诊断、鉴定为职业病之日' },
  { 名: '工伤认定决定期限', 时长: 60, unit: 'day', 依据: '《工伤保险条例》第二十条：社会保险行政部门应当自受理工伤认定申请之日起 60 日内作出决定', 起算点: '受理工伤认定申请之日' },
  { 名: '工伤认定决定期限（事实清楚）', 时长: 15, unit: 'day', 依据: '《工伤保险条例》第二十条：对受理的事实清楚、权利义务明确的工伤认定申请，应当在 15 日内作出决定', 起算点: '受理工伤认定申请之日' },
  { 名: '劳动能力鉴定结论', 时长: 60, unit: 'day', 依据: '《工伤保险条例》第二十五条：设区的市级劳动能力鉴定委员会应当自收到劳动能力鉴定申请之日起 60 日内作出结论，必要时可以延长 30 日', 起算点: '收到劳动能力鉴定申请之日' },
  { 名: '再次鉴定申请', 时长: 15, unit: 'day', 依据: '《工伤保险条例》第二十六条：申请鉴定的单位或者个人对设区的市级劳动能力鉴定委员会作出的鉴定结论不服的，可以在收到该鉴定结论之日起 15 日内向省级劳动能力鉴定委员会提出再次鉴定申请', 起算点: '收到鉴定结论之日' },
  { 名: '行政复议（对行政行为不服）', 时长: 60, unit: 'day', 依据: '《行政复议法》：自知道或者应当知道行政行为之日起 60 日内提出（详见该法）', 起算点: '知道或应当知道行政行为之日' },
  { 名: '行政诉讼', 时长: 6, unit: 'month', 依据: '《行政诉讼法》第四十六条：自知道或者应当知道作出行政行为之日起六个月内提出', 起算点: '知道或应当知道作出行政行为之日' },
  { 名: '申请强制执行', 时长: 2, unit: 'year', 依据: '《民事诉讼法》：申请执行的期间为二年（详见该法）', 起算点: '法律文书规定履行期间的最后一日起算' },
]

// ---------------------------------------------------------------------------
// 节假日
// ---------------------------------------------------------------------------

if (!existsSync(HOLIDAYS)) {
  console.error(`[环境错误] 找不到节假日数据：${HOLIDAYS}`)
  console.error('说明：没有节假日数据时无法判断顺延与工作日，工具不猜。')
  process.exit(2)
}
const HOL = JSON.parse(readFileSync(HOLIDAYS, 'utf8'))

/** 日期工具：一律用 UTC 的「年月日」三元组，避免时区把日期挪一天 */
const parseDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return { y, m: mo, d }
}
const fmt = ({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const addDays = ({ y, m, d }, n) => {
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + n)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}
const weekday = ({ y, m, d }) => new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=日
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 该日是否是法定节假日（在收录的假期区间内） */
function holidayOf(date) {
  const s = fmt(date)
  const year = String(date.y)
  const pack = HOL.年份[year]
  if (!pack) return { 未知年份: true }
  for (const h of pack.节假日) if (s >= h.起 && s <= h.止) return { 是: true, 名称: h.名称 }
  return { 是: false }
}

/** 该日是否是调休上班日（周末但上班） */
function isMakeupWorkday(date) {
  const year = String(date.y)
  const pack = HOL.年份[year]
  if (!pack) return false
  return pack.调休上班日.some((x) => x.日期 === fmt(date))
}

/** 是否是工作日：非周末且非法定节假日；或周末但属调休上班日 */
function isWorkday(date) {
  if (isMakeupWorkday(date)) return true
  const w = weekday(date)
  if (w === 0 || w === 6) return false
  return !holidayOf(date).是
}

/** 年份是否已收录节假日；未收录时工具会明确声明结论不完整 */
function yearKnown(date) {
  return Boolean(HOL.年份[String(date.y)])
}

// ---------------------------------------------------------------------------
// 计算
// ---------------------------------------------------------------------------

function compute({ 起算日, 时长, unit, 顺延 }) {
  const start = parseDate(起算日)
  if (!start) return { error: `起算日格式非法：${起算日}（应为 YYYY-MM-DD）` }
  if (!Number.isFinite(时长) || 时长 <= 0) return { error: `时长非法：${时长}` }

  const 注释 = []
  let end
  let 起算说明

  if (unit === 'day' || unit === 'workday') {
    // 第二百零一条：开始的当日不计入，自下一日起算
    起算说明 = '自次日起算（民法典第二百零一条：开始的当日不计入）'
    if (unit === 'day') {
      end = addDays(start, 时长)
    } else {
      // 工作日：从次日起数 N 个工作日
      let cur = start
      let 数 = 0
      let 未知 = 0
      while (数 < 时长) {
        cur = addDays(cur, 1)
        if (!yearKnown(cur)) 未知++
        if (isWorkday(cur)) 数++
      }
      end = cur
      if (未知) 注释.push(`⚠ 数到 ${未知} 天落在未收录节假日的年份，工作日判定可能不准`)
    }
  } else if (unit === 'month' || unit === 'year') {
    // 第二百零二条：到期月的**对应日**为最后一日；没有对应日的，月末日为最后一日。
    //
    // 「对应」的基准是**起算日的次日**（第二百零一条：开始的当日不计入，自下一日开始计算）。
    // 这个基准不能搞错：以 2026-01-31 起 1 个月为例——若拿起算日 1-31 去对，2 月无 31 日，
    // 会取 2 月末（2-28）；但次日起算的答案是 2-01，2 月有 1 日，对应日就是 **2-01**。
    // 本仓库第一版就写错了这一处，据此改正。
    起算说明 = '自次日起算，按「次日的对应日」取月/年（民法典第二百零一、二百零二条）'
    const months = unit === 'year' ? 时长 * 12 : 时长
    const base = addDays(start, 1) // 次日起算
    const total = (base.y * 12 + (base.m - 1)) + months
    const ty = Math.floor(total / 12)
    const tm = (total % 12) + 1
    const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
    let td = base.d
    if (td > lastDay) { td = lastDay; 注释.push(`到期月（${ty}-${String(tm).padStart(2, '0')}）没有对应日 ${base.d} 日，按月末日 ${lastDay} 日（民法典第二百零二条）`) }
    end = { y: ty, m: tm, d: td }
  } else {
    return { error: `未知的 unit：${unit}（可用 day / workday / month / year）` }
  }

  // 第二百零三条：最后一日是法定休假日的，以休假日结束的次日为最后一日
  const 原始末日 = end
  let 顺延依据 = '未顺延'
  if (顺延) {
    const h = holidayOf(end)
    if (h.是) {
      let cur = end
      while (holidayOf(cur).是) cur = addDays(cur, 1)
      end = cur
      顺延依据 = `末日 ${fmt(原始末日)} 是法定休假日（${h.名称}），顺延至 ${fmt(end)}（民法典第二百零三条）`
    } else {
      const w = weekday(end)
      if (w === 0 || w === 6) {
        顺延依据 = `末日 ${fmt(end)} 是${WD[w]}（休息日）。**民法典第二百零三条只写「法定休假日」顺延，未把普通双休日列入**；实务中常参照顺延，但这是解释问题，本工具不替你定，请向受案机关确认`
      } else {
        顺延依据 = `末日 ${fmt(end)} 是${WD[w]}，非法定休假日，不顺延`
      }
    }
  } else {
    顺延依据 = '按 --no-extend 未适用顺延'
  }

  return { start, end, 原始末日, 起算说明, 顺延依据, 注释, unit, 时长 }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

if (has('--help') || argv.length === 0 || has('--list-rules')) {
  if (has('--list-rules')) {
    console.log(`期限规则表（${RULES.length} 条，依据均为本仓库已登记的法规条文）\n`)
    for (const r of RULES) {
      console.log(`【${r.名}】${r.时长} ${r.unit}`)
      console.log(`  起算点：${r.起算点}`)
      console.log(`  依据：${r.依据}`)
      console.log('')
    }
    console.log('用法：node tools/期限计算.mjs <起算日> <时长> --unit day|workday|month|year')
    console.log('      加 --rule <名称> 可把该规则的出处一并打印出来')
    process.exit(0)
  }
  console.log(`期限计算 —— 用法：
  node tools/期限计算.mjs <起算日> <时长> --unit day        自然日（默认；法定期间就是这个）
  node tools/期限计算.mjs <起算日> <时长> --unit workday    工作日
  node tools/期限计算.mjs <起算日> <时长> --unit month      按月（取对应日）
  node tools/期限计算.mjs <起算日> <时长> --unit year       按年
  node tools/期限计算.mjs <起算日> <时长> --unit day --rule 仲裁起诉期限
  node tools/期限计算.mjs --list-rules                      打印全部期限规则与依据
  node tools/期限计算.mjs <起算日> <时长> --unit day --no-extend   不适用节假日顺延

判据（民法典总则编，本仓库 sources/全文/L11.md 已收录全文）：
  第二百零一条  开始的当日不计入，自下一日开始计算
  第二百零二条  按月/年计算的，到期月的对应日为最后一日；没有对应日的，月末日为最后一日
  第二百零三条  最后一日是法定休假日的，以法定休假日结束的次日为最后一日
  第二百零四条  法律另有规定或当事人另有约定的除外

**「N 日」是自然日，不是工作日**：本仓库已机械核对，《民法典》全文「工作日」0 次，
《劳动争议调解仲裁法》与《工伤保险条例》各 0 次。只有写明「工作日」的才按工作日算。

节假日数据：tools/法定节假日.json（来源为国务院办公厅年度通知，逐年更新）。
年份未收录时工具会明确提示，不会假装算准。`)
  process.exit(argv.length === 0 ? 1 : 0)
}

const pos = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { if (['--unit', '--rule'].includes(argv[i])) i++; continue }
  pos.push(argv[i])
}
if (pos.length < 2) {
  console.error('[失败] 参数不足。用法见 node tools/期限计算.mjs --help')
  process.exit(1)
}
const 起算日 = pos[0]
const 时长 = Number(pos[1])
const unit = argOf('--unit', 'day')
const 顺延 = !has('--no-extend')
const ruleName = argOf('--rule', '')

const r = compute({ 起算日, 时长, unit, 顺延 })
if (r.error) { console.error(`[失败] ${r.error}`); process.exit(1) }

const unitLabel = { day: '自然日', workday: '工作日', month: '个月', year: '年' }[r.unit] || r.unit

console.log('期限计算')
console.log(`起算日：${fmt(r.start)}（${WD[weekday(r.start)]}）${holidayOf(r.start).是 ? `　⚠ 起算日本身是法定休假日（${holidayOf(r.start).名称}）` : ''}`)
console.log(`时长：${r.时长} ${unitLabel}`)
console.log(`起算规则：${r.起算说明}`)
console.log('')
console.log(`→ 最后一日：${fmt(r.end)}（${WD[weekday(r.end)]}）`)
if (fmt(r.原始末日) !== fmt(r.end)) console.log(`  （未顺延前为 ${fmt(r.原始末日)}）`)
console.log(`→ 顺延判定：${r.顺延依据}`)
for (const c of r.注释) console.log(`  ${c}`)

// 未收录年份的诚实提示
const 涉及年份 = [...new Set([r.start.y, r.end.y])]
const 缺失 = 涉及年份.filter((y) => !HOL.年份[String(y)])
if (缺失.length) {
  console.log('')
  console.log(`⚠ **${缺失.join('、')} 年的法定节假日未收录**，本结果只按周末计算，`)
  console.log('  节假日顺延与工作日判定都不完整。请在国务院办公厅当年通知发布后更新 tools/法定节假日.json。')
}

if (ruleName) {
  const rule = RULES.find((x) => x.名 === ruleName || x.名.includes(ruleName))
  if (!rule) {
    console.log('')
    console.error(`[失败] 规则表里没有「${ruleName}」。用 --list-rules 看全部可用规则。`)
    process.exit(1)
  }
  console.log('')
  console.log(`规则出处：【${rule.名}】`)
  console.log(`  法定起算点：${rule.起算点}`)
  console.log(`  依据：${rule.依据}`)
  if (rule.时长 !== r.时长 || rule.unit !== r.unit) {
    console.log(`  ⚠ 你传入的是 ${r.时长} ${r.unit}，规则表登记的是 ${rule.时长} ${rule.unit}——请确认用哪个`)
  }
}

console.log('')
console.log('提示：本工具算的是「期限的最后一日」。**送达日、签收日以送达回证上的签收日期为准**')
console.log('（《劳动人事争议仲裁办案规则》第二十条），不要把「我听说的日期」当起算日。')
