#!/usr/bin/env node
/**
 * check-items.mjs —— 条目结构校验
 *
 * 格式权威：docs/条目规范.md。改格式必须先改规范，再同步本脚本的常量表。
 * 只使用 Node 24 内置模块，无外部依赖。
 *
 * 用法：
 *   node tools/check-items.mjs                     默认报告模式（只报告，发现问题也退出 0）
 *   node tools/check-items.mjs --check             CI 模式（有错误退出 1）
 *   node tools/check-items.mjs --check --strict    严格模式（警告也计入失败）
 *   node tools/check-items.mjs --root <目录>        指定仓库根目录（供自测使用）
 *   node tools/check-items.mjs --summary <文件>     把汇总追加写入指定文件（工作流用）
 *
 * 退出码：
 *   0  通过（默认报告模式只要跑完就是 0）
 *   1  校验发现错误（只在 --check 模式下出现）
 *   2  运行环境错误：条目目录不存在、一个条目都没有、文件读不了
 *
 * 三档口径：
 *   错误 —— 结构性问题、枚举越界、编号跳号重号、核对日期过期，--check 下非零退出；
 *   警告 —— 规范建议但可能随行文变化，--check --strict 才失败；
 *   提示 —— 仅供参考的写作提示，不参与退出码，按文件聚合显示，避免淹没真问题。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 规范常量表（唯一来源：docs/条目规范.md 的「条目格式」与「字段说明」）
// ---------------------------------------------------------------------------

/** 字段顺序不可调换、字段名不可改写；缺一项即不合格 */
const REQUIRED_FIELDS = [
  '适用',
  '成本',
  '收益',
  '说人话',
  '依据',
  '效力位阶',
  '主张强度',
  '举证难度',
  '地域',
  '时效',
  '来源',
  '核对日期',
  '备注',
]

/** 三套独立标注的取值白名单 */
const ENUMS = {
  效力位阶: ['法律', '行政法规', '部门规章', '地方性法规', '司法解释', '规范性文件', '地方口径'],
  主张强度: ['可主张', '可推定', '倡导性'],
  举证难度: ['易', '中', '难'],
}

/** 效力位阶允许多值并列（正文里用「 + 」连接，规范白名单各项全收） */
const MULTI_VALUE_FIELDS = ['效力位阶']

/** 成本标签 HTML 注释的五项取值白名单（规范「成本标签」一节） */
const COST_TAG_ORDER = ['钱', '时间', '毅力', '收益', '口径']
const COST_TAG_ENUMS = {
  钱: ['0', '少', '多'],
  时间: ['少', '中', '多'],
  毅力: ['否', '些', '是'],
  收益: ['大', '中', '小'],
  口径: ['金钱', '时间', '自由', '健康'],
}

/** 核验日期超过这么多天即报「待复核」（规范未给天数，按本脚本约定为 180 天） */
const STALE_DAYS = 180

/**
 * 未定稿标记。仓库根 AGENTS.md「三条不可破的底线」第一条写明：
 * 追不到官方原文的，写「待核实」并说明尝试路径，标「待核实」是正确行为。
 * 所以「待核实」不能按枚举越界判错，但必须单独报出来——这类条目还没定稿，不该对外发布。
 */
const PENDING_MARK = '待核实'

/** 二手转述来源域名黑名单（规范「来源」一节明确禁止） */
const SECONDHAND_DOMAINS = [
  'zhihu.com',
  'mp.weixin.qq.com',
  'weixin.qq.com',
  'sohu.com',
  '163.com',
  'baijiahao.baidu.com',
  'toutiao.com',
  'jianshu.com',
  'douban.com',
  'csdn.net',
  'weibo.com',
  'sina.com.cn',
  'ifeng.com',
  'xueqiu.com',
  '36kr.com',
  'baidu.com',
]

/** 官方一手源特征：政府域名或 DOI 登记处 */
const OFFICIAL_HOST = /(^|\.)gov\.cn$|(^|\.)gov$|(^|\.)gov\.[a-z]{2}$|^(doi\.org|dx\.doi\.org)$/i

// 主张强度标「可推定」时，备注必须写明本地口径查询渠道
const LOCAL_CHANNEL_WORDS = ['12333', '社保经办', '经办机构', '仲裁委', '人社', '当地', '地方口径', '本地口径', '咨询', '查询']
// 举证难度标「难」时，备注必须写清取证时间和动作
const TIMING_WORDS = [
  '离职前', '事前', '提前', '及时', '立即', '当场', '第一时间', '尽快', '留存', '保存', '导出',
  '备份', '拍照', '截图', '录音', '书面', '固化', '在职期间', '在职时',
]

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function todayParts() {
  const d = new Date()
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }
}

/** 把 YYYY-MM-DD 转成「距今天数」，非法日期返回 null */
function daysSince(yyyymmdd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = new Date(Date.UTC(y, mo - 1, d))
  // 反查一次，排除 2026-02-31 这类假日期
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null
  const now = todayParts()
  return Math.round((Date.UTC(now.y, now.m - 1, now.d) - t.getTime()) / 86400000)
}

/** 去掉正文里的行内强调标记，避免「**难**」被判成非法取值 */
function cleanValue(raw) {
  return String(raw)
    .replace(/\*\*|__|`/g, '')
    .replace(/^[*_\s]+|[*_\s]+$/g, '')
    .trim()
}

/** 取枚举字段的主值：允许「中——工资流水…」「可主张（前提…）」「法律 + 司法解释」的写法 */
function enumTokens(raw, multi) {
  const cleaned = cleanValue(raw)
  const head = cleaned.split(/——|—|–|:|：|（|\(|；|;/)[0]
  if (!multi) return [head.trim()]
  return head
    .split(/\s*[+＋、,，/]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function urlsIn(text) {
  const found = text.match(/https?:\/\/[^\s<>"'）)】\]]+/gi) || []
  return found.map((u) => u.replace(/[.,;。，；]+$/, ''))
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 递归列出目录下所有 .md 文件（跳过隐藏目录与隐藏文件） */
function listMarkdown(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full)
    }
  }
  return out.sort()
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s*(.*)$/
const NUMBERED_RE = /^(\d{1,3})\.(\d{1,3})(?:\s+|$)(.*)$/
const FIELD_RE = /^-\s*([^：:]{1,24})[：:]\s*(.*)$/
/** 分隔线、引用块、表格行：条目块里出现不算结构错误 */
const IGNORED_LINE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,}|>|\|)/
/** 只有独立的分隔线才忽略；「- 适用：」不能被它吃掉 */
const SEPARATOR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/

class Issues {
  constructor() {
    this.items = []
  }
  add(level, entry, message, kind) {
    this.items.push({ level, entry, message, kind: kind || message })
  }
  error(entry, message, kind) {
    this.add('错误', entry, message, kind)
  }
  warn(entry, message, kind) {
    this.add('警告', entry, message, kind)
  }
  info(entry, message, kind) {
    this.add('提示', entry, message, kind)
  }
}

/**
 * 解析一个文件里的所有条目块。
 * entry = { file, headingLine, level, section, index, title, fields, extraLines, costTagRaw, costTagLine }
 */
function parseFile(file, text) {
  const lines = text.split(/\r\n|\n|\r/)

  // 条目所在的标题级别：优先三级标题，兼容整本书用二级标题的情况
  let level = 0
  if (lines.some((l) => /^###\s*\d{1,3}\.\d{1,3}(\s|$)/.test(l))) level = 3
  else if (lines.some((l) => /^##\s*\d{1,3}\.\d{1,3}(\s|$)/.test(l))) level = 2

  const entries = []
  let cur = null

  const close = () => {
    if (cur) entries.push(cur)
    cur = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const h = HEADING_RE.exec(line)
    if (h) {
      const hl = h[1].length
      const title = h[2].trim()
      if (level > 0 && hl === level) {
        const n = NUMBERED_RE.exec(title)
        if (n) {
          close()
          cur = {
            headingLine: i + 1,
            level,
            section: Number(n[1]),
            index: Number(n[2]),
            title: n[3].trim(),
            fields: [],
            extraLines: [],
            costTagRaw: null,
            costTagLine: null,
          }
          continue
        }
      }
      if (level > 0 && hl <= level) close()
      // 更深的子标题不进入条目正文，也不报错
      continue
    }
    if (!cur) continue
    if (line.trim() === '') continue
    if (SEPARATOR_RE.test(line)) continue

    const tag = /<!--\s*成本标签\s*[：:]\s*([\s\S]*?)-->/.exec(line)
    if (tag) {
      if (cur.costTagRaw !== null) {
        cur.extraLines.push({ line: i + 1, text: '（本块出现第二条成本标签注释）' })
      } else {
        cur.costTagRaw = tag[1].trim()
        cur.costTagLine = i + 1
      }
      continue
    }
    if (/^\s*<!--[\s\S]*-->\s*$/.test(line)) continue
    if (IGNORED_LINE_RE.test(line)) continue

    const f = FIELD_RE.exec(line)
    if (f) {
      cur.fields.push({ name: f[1].trim(), value: f[2].trim(), line: i + 1 })
    } else {
      cur.extraLines.push({ line: i + 1, text: line.trim().slice(0, 80) })
    }
  }
  close()
  return { entries, levelDetected: level }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function checkEntry(entry, issues, ctx) {
  const where = { file: entry.file, line: entry.headingLine, label: `${entry.section}.${entry.index} ${entry.title || '（无标题）'}` }

  if (!entry.title) issues.error(where, '条目标题为空')

  // 游离行（字段被改写、或者条目里混进了正文段落）
  for (const ex of entry.extraLines) {
    issues.error(where, `第 ${ex.line} 行不是规范字段，也不是成本标签注释：${ex.text}`)
  }

  // 字段名与重复
  const known = []
  const seen = new Set()
  for (const f of entry.fields) {
    if (!REQUIRED_FIELDS.includes(f.name)) {
      issues.error(where, `第 ${f.line} 行字段名不在规范内（疑似改写）：「${f.name}」`)
      continue
    }
    if (seen.has(f.name)) {
      issues.error(where, `第 ${f.line} 行字段重复：「${f.name}」`)
      continue
    }
    seen.add(f.name)
    known.push(f)
  }

  // 缺字段
  const missing = REQUIRED_FIELDS.filter((n) => !seen.has(n))
  if (missing.length) issues.error(where, `缺少字段：${missing.join('、')}`)

  // 空值
  for (const f of known) {
    if (cleanValue(f.value) === '') issues.error(where, `第 ${f.line} 行字段「${f.name}」为空`)
  }

  // 字段顺序（只在字段齐全且无未知字段时比对，避免误报掩盖真问题）
  if (missing.length === 0 && known.length === REQUIRED_FIELDS.length) {
    for (let i = 0; i < REQUIRED_FIELDS.length; i++) {
      if (known[i].name !== REQUIRED_FIELDS[i]) {
        issues.error(
          where,
          `字段顺序不符：第 ${i + 1} 位应为「${REQUIRED_FIELDS[i]}」，实际是「${known[i].name}」（规范要求字段顺序不可调换）`,
        )
        break
      }
    }
  }

  const val = (name) => {
    const f = known.find((x) => x.name === name)
    return f ? f.value : ''
  }

  // 三套标注的枚举
  const 未定稿字段 = []
  for (const name of Object.keys(ENUMS)) {
    const raw = val(name)
    if (!raw) continue
    if (raw.includes(PENDING_MARK)) {
      未定稿字段.push(name)
      issues.warn(
        where,
        `未定稿：${name} 标为「待核实」，说明该条尚未追到官方原文（AGENTS.md 底线一允许这样做，但未定稿条目不应对外发布）`,
        '未定稿',
      )
      continue
    }
    const tokens = enumTokens(raw, MULTI_VALUE_FIELDS.includes(name))
    if (tokens.length === 0) {
      issues.error(where, `「${name}」取值为空`)
      continue
    }
    for (const t of tokens) {
      if (!ENUMS[name].includes(t)) {
        issues.error(where, `「${name}」取值非法：「${t}」（原文：${cleanValue(raw).slice(0, 40)}；允许：${ENUMS[name].join(' / ')}）`)
      }
    }
  }

  const 主张 = enumTokens(val('主张强度'), false)[0] || ''
  const 举证 = enumTokens(val('举证难度'), false)[0] || ''
  const 备注 = val('备注')

  // 主张强度「可推定」必须在备注写明不确定点与本地口径查询渠道
  if (主张 === '可推定') {
    if (!LOCAL_CHANNEL_WORDS.some((w) => 备注.includes(w))) {
      issues.error(where, '主张强度为「可推定」，但备注未写明不确定点与本地口径查询渠道（12333、参保地社保经办机构、当地劳动人事争议仲裁委员会等）')
    }
    if (cleanValue(备注).length < 12) {
      issues.error(where, '主张强度为「可推定」，但备注过短，无法看出不确定在哪')
    }
  }

  // 举证难度「难」必须写清取证时间和动作。规范要求写在「备注」栏；
  // 若写在「举证难度」栏（正文里确有此写法），信息已交代，只作提示，不判错。
  if (举证 === '难') {
    const 举证原文 = val('举证难度')
    if (TIMING_WORDS.some((w) => 备注.includes(w))) {
      // 合规
    } else if (TIMING_WORDS.some((w) => 举证原文.includes(w))) {
      issues.info(
        where,
        '取证时机写在「举证难度」栏而没有写进「备注」栏；规范要求写进备注，请与规范口径对齐',
        '取证时机位置',
      )
    } else {
      issues.error(where, '举证难度为「难」，但备注未写清取证时间和动作（例如「离职前先导出」）')
    }
  }

  // 核对日期
  const 核对日期 = cleanValue(val('核对日期'))
  if (核对日期) {
    const days = daysSince(核对日期)
    if (days === null) {
      issues.error(where, `「核对日期」格式非法：「${核对日期}」（应为 YYYY-MM-DD）`)
    } else if (days < -1) {
      issues.error(where, `「核对日期」晚于今天（${核对日期}），疑似笔误`)
    } else if (days > STALE_DAYS) {
      issues.error(where, `「核对日期」距今 ${days} 天，超过 ${STALE_DAYS} 天，报为「待复核」：${核对日期}`, '待复核')
    }
  }

  // 来源
  const 来源 = val('来源')
  if (来源) {
    const urls = urlsIn(来源)
    if (urls.length === 0) {
      // 全书分工：条文链接统一登记在 sources/法规清单.md，条目里只指向信源表。
      // 这种做法可以接受，但必须交叉核查「依据」所列法规确实在信源表里登记了，
      // 否则「每条依据都能追到官方一手源」这个承诺就断了。
      const 指向信源表 = /法规清单|信源表|sources[\\/]/.test(来源)
      if (来源.includes(PENDING_MARK)) {
        未定稿字段.push('来源')
        issues.warn(where, '未定稿：来源标为「待核实」，没有官方一手链接（AGENTS.md 底线一允许这样做，但未定稿条目不应对外发布）', '未定稿')
      } else if (!指向信源表) {
        issues.error(where, '「来源」栏没有任何链接（规范要求给出官方全文链接）')
      } else if (!ctx.registry.exists) {
        issues.warn(where, `「来源」栏未直接给链接，只指向 ${ctx.registry.rel}，而该信源表当前不存在，无法交叉核查`)
      } else {
        const 法规名 = [...val('依据').matchAll(/《([^》]+)》/g)].map((m) => m[1].replace(/\s/g, ''))
        const 信源表归一 = ctx.registry.text.replace(/\s|[《》]/g, '')
        const 缺登记 = 法规名.filter((n) => !信源表归一.includes(n))
        if (法规名.length === 0) {
          issues.warn(where, `「来源」栏只指向 ${ctx.registry.rel}，但本条目「依据」栏无可识别的法规全称，无法交叉核查`)
        } else if (缺登记.length) {
          issues.error(where, `「来源」栏只指向 ${ctx.registry.rel}，但该表里找不到条目「依据」所列法规：${缺登记.map((n) => `《${n}》`).join('、')}`)
        } else {
          issues.info(where, `「来源」栏未直接给链接，但所列法规已在 ${ctx.registry.rel} 登记`, '来源指向信源表')
        }
      }
    }
    for (const u of urls) {
      const host = hostOf(u)
      if (!host) {
        issues.error(where, `「来源」里的链接无法解析为合法网址：${u}`)
        continue
      }
      if (SECONDHAND_DOMAINS.some((d) => host === d || host.endsWith('.' + d))) {
        issues.error(where, `「来源」命中二手转述域名（规范禁止）：${u}`)
      } else if (!OFFICIAL_HOST.test(host)) {
        issues.warn(where, `「来源」非政府域名，请确认是否一手源：${u}`)
      }
    }
  }

  // 依据：规范要求「法律文件全称 + 条款号 + 版本与施行日期」
  const 依据 = val('依据')
  if (依据 && 依据.includes(PENDING_MARK)) 未定稿字段.push('依据')
  if (依据 && !依据.includes(PENDING_MARK)) {
    if (!/《[^》]+》/.test(依据)) issues.warn(where, '「依据」未出现《》书名号，疑似未写法律文件全称')
    if (!/\d{4}/.test(依据)) {
      issues.info(
        where,
        '「依据」未出现年份，规范要求写入版本与施行日期（若版本统一登记在 sources/法规清单.md，请在 docs/条目规范.md 里同步说明这一分工）',
        '依据未写版本年份',
      )
    }
  }

  // 时效：规范要求写程序时效、起算点、例外三层
  const 时效 = val('时效')
  if (时效 && !['之日起', '起算', '自知道', '无特别时效', '不受'].some((w) => 时效.includes(w))) {
    issues.warn(where, '「时效」未出现起算点或「无特别时效」表述，可能只写了程序时效')
  }

  // 成本标签
  if (entry.costTagRaw === null) {
    issues.error(where, '缺少「成本标签」HTML 注释（<!-- 成本标签: 钱=… 时间=… 毅力=… 收益=… 口径=… -->）')
  } else {
    const pairs = {}
    for (const seg of entry.costTagRaw.split(/\s+/)) {
      if (!seg) continue
      const m = /^([^=＝]+)[=＝](.+)$/.exec(seg)
      if (!m) {
        issues.error(where, `成本标签片段无法解析：「${seg}」`)
        continue
      }
      const k = m[1].trim()
      const v = m[2].trim()
      if (!COST_TAG_ORDER.includes(k)) {
        issues.error(where, `成本标签出现未知项：「${k}」（允许：${COST_TAG_ORDER.join(' ')}）`)
        continue
      }
      if (k in pairs) {
        issues.error(where, `成本标签项重复：「${k}」`)
        continue
      }
      pairs[k] = v
      if (!COST_TAG_ENUMS[k].includes(v)) {
        issues.error(where, `成本标签「${k}」取值非法：「${v}」（允许：${COST_TAG_ENUMS[k].join(' / ')}）`)
      }
    }
    const missTag = COST_TAG_ORDER.filter((k) => !(k in pairs))
    if (missTag.length) issues.error(where, `成本标签缺少项：${missTag.join('、')}`)
  }

  // 标了「待核实」还不够：AGENTS.md 底线一要求同时说明尝试路径
  if (未定稿字段.length) {
    const 说明 = [备注, 依据, 来源, val('收益')].join(' ')
    if (!/尝试|检索|搜过|未找到|未定位|未查到|待补|路径|未能|暂无|后续补/.test(说明)) {
      issues.warn(
        where,
        `${未定稿字段.join('、')}标为「待核实」，但全条目未说明尝试过哪些路径（AGENTS.md 底线一要求写明尝试路径）`,
        '未定稿',
      )
    }
  }
}

function checkNumbering(allEntries, issues) {
  const bySection = new Map()
  for (const e of allEntries) {
    if (!bySection.has(e.section)) bySection.set(e.section, [])
    bySection.get(e.section).push(e)
  }
  for (const [section, list] of [...bySection.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => (a.file === b.file ? a.headingLine - b.headingLine : a.file < b.file ? -1 : 1))
    const seen = new Map()
    let expected = 1
    for (const e of list) {
      const where = { file: e.file, line: e.headingLine, label: `${e.section}.${e.index} ${e.title || '（无标题）'}` }
      if (seen.has(e.index)) {
        const prev = seen.get(e.index)
        issues.error(where, `编号重号：${e.section}.${e.index} 已在 ${prev.file}:${prev.headingLine} 出现`)
        continue
      }
      seen.set(e.index, e)
      if (e.index !== expected) {
        issues.error(where, `编号跳号：第 ${section} 节此处应为 ${section}.${expected}，实际是 ${section}.${e.index}`)
        expected = e.index + 1
      } else {
        expected++
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opt = { check: false, strict: false, root: path.resolve(SCRIPT_DIR, '..'), summary: '', help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') opt.check = true
    else if (a === '--strict') opt.strict = true
    else if (a === '--help' || a === '-h') opt.help = true
    else if (a === '--root') opt.root = path.resolve(argv[++i] ?? '.')
    else if (a === '--summary') opt.summary = argv[++i] ?? ''
    else {
      console.error(`未知参数：${a}（用 --help 查看用法）`)
      process.exit(2)
    }
  }
  return opt
}

const USAGE = `条目结构校验 —— 用法：
  node tools/check-items.mjs                     默认报告模式
  node tools/check-items.mjs --check             CI 模式，有错误退出 1
  node tools/check-items.mjs --check --strict    警告也计入失败
  node tools/check-items.mjs --root <目录>        指定仓库根目录
  node tools/check-items.mjs --summary <文件>     汇总追加写入该文件
退出码：0 通过 / 1 校验有错误 / 2 运行环境错误`

async function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.help) {
    console.log(USAGE)
    process.exit(0)
  }

  const bookDir = path.join(opt.root, 'book')
  const specPath = path.join(opt.root, 'docs', '条目规范.md')

  console.log('条目结构校验 —— 格式权威：docs/条目规范.md')
  console.log(`仓库根目录：${opt.root}`)
  console.log(`模式：${opt.check ? (opt.strict ? 'CI 严格模式' : 'CI 模式') : '报告模式'}`)
  console.log('')

  if (!fs.existsSync(bookDir)) {
    console.error(`[环境错误] 条目目录不存在：${bookDir}`)
    console.error('说明：book/ 缺失时无法校验，按约定报错退出（退出码 2）。')
    process.exit(2)
  }
  if (!fs.existsSync(specPath)) {
    console.error(`[环境错误] 找不到格式权威文件：${specPath}`)
    process.exit(2)
  }

  const files = listMarkdown(bookDir)
  if (files.length === 0) {
    console.error(`[环境错误] book/ 下没有任何 .md 文件：${bookDir}`)
    process.exit(2)
  }

  const issues = new Issues()
  const allEntries = []
  const perFile = []

  // 信源表：条目「来源」栏只指向它时，用来交叉核查法规是否真的登记过
  const registryRel = 'sources/法规清单.md'
  const registryAbs = path.join(opt.root, 'sources', '法规清单.md')
  const ctx = { registry: { rel: registryRel, exists: false, text: '' } }
  try {
    ctx.registry.text = fs.readFileSync(registryAbs, 'utf8')
    ctx.registry.exists = true
  } catch {
    ctx.registry.exists = false
  }

  for (const abs of files) {
    const rel = path.relative(opt.root, abs).split(path.sep).join('/')
    let text
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch (err) {
      issues.error({ file: rel, line: 0, label: rel }, `文件无法读取：${err.message}`)
      continue
    }
    const { entries, levelDetected } = parseFile(rel, text)
    if (entries.length === 0) {
      issues.warn({ file: rel, line: 1, label: rel }, '文件中未发现编号条目（形如 ### 8.3 标题），已跳过')
    }
    if (levelDetected === 2) {
      issues.warn({ file: rel, line: 1, label: rel }, '文件使用二级标题承载条目；规范示例用三级标题，请确认')
    }
    for (const e of entries) {
      e.file = rel
      allEntries.push(e)
    }
    perFile.push({ rel, count: entries.length, size: text.length })
  }

  if (allEntries.length === 0) {
    console.error(`[环境错误] 在 ${files.length} 个文件里没有解析到任何条目（形如 ### 8.3 标题）。`)
    console.error('说明：一个条目都校验不到，等于这道防线没生效，按约定以退出码 2 报错。')
    process.exit(2)
  }

  for (const e of allEntries) checkEntry(e, issues, ctx)
  checkNumbering(allEntries, issues)

  // 输出：错误与警告逐条列；提示按文件聚合，避免淹没真问题
  const rank = { 错误: 0, 警告: 1, 提示: 2 }
  const sorted = [...issues.items].sort((a, b) => {
    if (a.entry.file !== b.entry.file) return a.entry.file < b.entry.file ? -1 : 1
    if (a.entry.line !== b.entry.line) return a.entry.line - b.entry.line
    if (rank[a.level] !== rank[b.level]) return rank[a.level] - rank[b.level]
    return String(a.message).localeCompare(String(b.message), 'zh')
  })

  const notable = sorted.filter((x) => x.level !== '提示')
  const infos = sorted.filter((x) => x.level === '提示')

  let lastFile = null
  for (const it of notable) {
    if (it.entry.file !== lastFile) {
      console.log(`\n${it.entry.file}`)
      lastFile = it.entry.file
    }
    const loc = it.entry.line ? `第 ${it.entry.line} 行` : '—'
    console.log(`  [${it.level}] ${loc} · ${it.entry.label}`)
    console.log(`      · ${it.message}`)
  }

  if (infos.length) {
    const grouped = new Map()
    for (const it of infos) {
      const key = `${it.entry.file}\u0000${it.kind}`
      if (!grouped.has(key)) grouped.set(key, { file: it.entry.file, kind: it.kind, count: 0, first: it.entry })
      const g = grouped.get(key)
      g.count++
    }
    console.log('\n【提示】仅供参考，不参与退出码：')
    for (const g of grouped.values()) {
      console.log(`  [提示] ${g.file}：「${g.kind}」共 ${g.count} 处，首处第 ${g.first.line} 行（${g.first.label}）`)
    }
  }

  const errCount = issues.items.filter((x) => x.level === '错误').length
  const warnCount = issues.items.filter((x) => x.level === '警告').length
  const infoCount = infos.length
  const staleCount = issues.items.filter((x) => x.kind === '待复核').length
  const pendingCount = issues.items.filter((x) => x.kind === '未定稿').length

  console.log('\n—— 汇总 ——')
  console.log(`文件 ${perFile.length} 个，条目 ${allEntries.length} 条`)
  for (const f of perFile) console.log(`  ${f.rel}：${f.count} 条`)
  console.log(`错误 ${errCount} 项（含待复核 ${staleCount} 项），警告 ${warnCount} 项（含未定稿 ${pendingCount} 项），提示 ${infoCount} 项`)

  const summaryLines = [
    '## 条目结构校验',
    '',
    `- 格式权威：\`docs/条目规范.md\``,
    `- 条目 ${allEntries.length} 条，文件 ${perFile.length} 个`,
    `- 错误 ${errCount} 项（含待复核 ${staleCount} 项），警告 ${warnCount} 项（含未定稿 ${pendingCount} 项），提示 ${infoCount} 项`,
    '',
  ]
  if (notable.length) {
    summaryLines.push('| 级别 | 位置 | 条目标题 | 问题 |', '| --- | --- | --- | --- |')
    for (const it of notable.slice(0, 200)) {
      summaryLines.push(
        `| ${it.level} | ${it.entry.file}:${it.entry.line} | ${it.entry.label.replace(/\|/g, '\\|')} | ${it.message.replace(/\|/g, '\\|')} |`,
      )
    }
    summaryLines.push('')
  }
  const summaryText = summaryLines.join('\n')
  if (opt.summary) {
    try {
      fs.appendFileSync(opt.summary, summaryText + '\n', 'utf8')
      console.log(`\n汇总已追加写入：${opt.summary}`)
    } catch (err) {
      console.error(`[环境错误] 汇总写入失败：${err.message}`)
      process.exit(2)
    }
  }

  const failed = errCount > 0 || (opt.strict && warnCount > 0)
  if (opt.check) {
    if (failed) {
      console.error(`\n[失败] 条目结构校验未通过：错误 ${errCount} 项，警告 ${warnCount} 项（退出码 1）`)
      process.exit(1)
    }
    console.log(`\n[通过] 条目结构校验通过：错误 0 项，警告 ${warnCount} 项（退出码 0）`)
    process.exit(0)
  }

  console.log(failed ? '\n（报告模式：发现问题但退出码仍为 0，加 --check 才会非零退出）' : '\n（报告模式：未发现问题）')
  process.exit(0)
}

main().catch((err) => {
  console.error('[环境错误] 脚本异常终止：', err && err.stack ? err.stack : err)
  process.exit(2)
})
