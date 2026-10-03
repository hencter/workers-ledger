#!/usr/bin/env node
/**
 * check-desensitize.mjs —— 脱敏扫描
 *
 * 依据：docs/条目规范.md「脱敏硬规则」。
 *
 * 判定口径分两档（口径由 team lead 核定，改动需同步本条注释与本文件的自测记录）：
 *
 *   一、硬命中（严重，--check 下非零退出）
 *       个人信息类：手机号、身份证号、邮箱、微信号、银行卡号。
 *       这几样在本书正文里没有正当用途，零容忍，命中即掩码报出文件、行号、列号。
 *
 *   二、需语境档（告警，人工判断；--strict 才失败）
 *       判据不是词本身，而是它出现在个人自述语境里：
 *         · 自述处境词：我司、我公司、我们公司、我单位、我部门、本人所在单位、笔者的自指用法等；
 *         · 「本人」后紧跟具体时间、地点、职务、金额或自述动作；
 *         · 具体地名 + 具体行业 + 具体职级出现在同一句；
 *         · 真实公司全称（「有限公司／股份有限公司」+ 非示例词）——只报不判定。
 *
 *   必须不命中的正常用法（防误报，误报会让这个扫描没人看）：
 *       · 法律术语「本单位」「用人单位」「劳动者」「本法第 X 条」；
 *       · 法条原文引用里的「本人」（经职工本人同意、劳动者本人故意、告知本人等）；
 *       · 本书刻意的第二人称口语风格里的「你」。
 *       · 引用块（以 > 开头的行）与代码块内的内容整段跳过——法条原文多在这些位置。
 *         （该跳过会留下盲区，故把跳过行数统计出来；用 --include-quoted 可连引用一起扫。）
 *
 * 命中的敏感串一律掩码后再输出——扫描报告本身也不该泄露它扫到的东西。
 * 单行出现「脱敏扫描豁免」即跳过该行，豁免行数会统计出来，避免豁免被滥用而无人察觉。
 *
 * 只使用 Node 24 内置模块，无外部依赖。
 *
 * 用法：
 *   node tools/check-desensitize.mjs                    报告模式
 *   node tools/check-desensitize.mjs --check            CI 模式，硬命中退出 1
 *   node tools/check-desensitize.mjs --check --strict   需语境档也计入失败
 *   node tools/check-desensitize.mjs --root <目录>       指定仓库根目录
 *   node tools/check-desensitize.mjs --dir <目录>        追加扫描目录（可重复，默认 book docs sources）
 *   node tools/check-desensitize.mjs --include-quoted   连引用块与代码块一起扫
 *   node tools/check-desensitize.mjs --summary <文件>    汇总追加写入该文件
 *
 * 退出码：0 通过 / 1 有硬命中（或 --strict 下含需语境档）/ 2 运行环境错误
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 默认扫描范围与文本类扩展名。
 *
 *  `.agents/skills` 是 2026-10-04 补进来的：skill 文本会直接进入 AI 回答、影响读者，
 *  理应受同一条「不写个人信息」的底线约束；但它原先在 `skills/` 下**就一直不在**
 *  扫描范围内（默认范围只有 book/docs/sources）——属既有缺口，不是这次移动造成的。
 *  补进来之前先单独试扫过：2 个文件 237 行，硬命中 0、告警 0、提示 0。 */
const DEFAULT_DIRS = ['book', 'docs', 'sources', '.agents/skills']
const TEXT_EXTS = ['.md', '.markdown', '.txt', '.html', '.htm', '.csv', '.json', '.yml', '.yaml']

// ---------------------------------------------------------------------------
// 一、硬命中：个人信息类
// ---------------------------------------------------------------------------

const HARD_PATTERNS = [
  {
    id: '身份证号',
    priority: 30,
    re: /(?<![\dXx])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dXx])/g,
    mask: (s) => s.slice(0, 6) + '*'.repeat(Math.max(0, s.length - 8)) + s.slice(-2),
  },
  {
    id: '银行卡号',
    priority: 25,
    // 只认现实里的卡号前缀：银联 62、Visa 4、MasterCard 51-55、运通 34/37、JCB 35
    re: /(?<![\d])(?:62\d{14,17}|4\d{15,18}|5[1-5]\d{14,16}|3[47]\d{13,15}|35\d{14,16})(?![\d])/g,
    mask: (s) => s.slice(0, 4) + '*'.repeat(Math.max(0, s.length - 8)) + s.slice(-4),
  },
  {
    id: '手机号',
    priority: 20,
    re: /(?<![\d])(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?![\d])/g,
    mask: (s) => s.slice(0, 3) + '****' + s.slice(-4),
  },
  {
    id: '邮箱',
    priority: 15,
    re: /(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{2,63})+(?![\w-])/g,
    mask: (s) => s.slice(0, 1) + '***' + s.slice(s.lastIndexOf('@')),
  },
  {
    id: '微信号',
    priority: 10,
    re: /(?:微信号|微信ID|微信|weixin|wechat|wx|vx|V信)\s*(?:号|ID|id)?\s*[:：=]\s*([A-Za-z][-_A-Za-z0-9]{5,19})/g,
    mask: (s) => {
      const tail = /([A-Za-z][-_A-Za-z0-9]{5,19})\s*$/.exec(s)
      return '微信号：' + (tail ? tail[1].slice(0, 2) + '***' : '***')
    },
  },
]

/** 微信号捕获组不能是这些通用词（避免把「微信公众号」误判成个人号） */
const WECHAT_NOT_A_HANDLE = ['gongzhonghao', 'officialaccount', 'publicaccount', 'miniprogram', 'pay', 'kefu', 'service']

// ---------------------------------------------------------------------------
// 二、需语境档
// ---------------------------------------------------------------------------

/** 自述处境词：这些词不会出现在法律条文里，出现即需人工看 */
const SELF_NARRATIVE_WORDS = [
  '我司', '我公司', '我们公司', '我单位', '我们单位', '我团队', '我部门',
  '我所在', '我这边', '笔者所在城市', '笔者', '本人所在单位',
]

/** 「本人」后紧跟这些具体信息才算自述（口径：时间、地点、职务、金额四类）。
 *  不认动作动词——法条与通用行文里「非因本人意愿」「本人户籍所在地」「经职工本人同意」
 *  「劳动者本人故意」到处都是，认动作会大面积误报。 */
const BENREN_TIME = /\d{4}\s*年|\d{1,2}\s*月|\d{1,2}\s*日|今年|去年|前年|当年|本月|上月/
const BENREN_MONEY = /\d+(?:\.\d+)?\s*(?:元|万元|万)/
/** 表格、文书里的固定用语，不算自述 */
/** 表格、文书里的固定用语，不算自述。
 *  注意不能把「本人 2024 年」这类「本人 + 空格 + 具体信息」当文书用语吞掉，
 *  所以分隔符里不含空格。 */
const BENREN_FORMAL =
  /^本人(?:签字|签名|签署|确认|办理|提交|申请|承诺|声明|委托|身份|信息|资料|简历|授权|到场|出席|提供|填写|所在)|^本人[，。；、：]|^本人$/

const PLACE_WORDS = [
  '北京', '上海', '天津', '重庆', '广东', '江苏', '浙江', '山东', '河南', '河北', '四川', '湖北', '湖南',
  '福建', '安徽', '江西', '陕西', '山西', '辽宁', '吉林', '黑龙江', '云南', '贵州', '广西', '甘肃', '青海',
  '宁夏', '新疆', '西藏', '内蒙古', '海南', '香港', '澳门', '台湾',
  '广州', '深圳', '东莞', '佛山', '珠海', '杭州', '宁波', '温州', '苏州', '南京', '无锡', '常州', '徐州',
  '济南', '青岛', '烟台', '郑州', '武汉', '长沙', '成都', '绵阳', '西安', '合肥', '福州', '厦门', '南昌',
  '沈阳', '大连', '长春', '哈尔滨', '昆明', '贵阳', '南宁', '兰州', '太原', '石家庄', '乌鲁木齐', '呼和浩特',
]
const INDUSTRY_WORDS = [
  '互联网', '金融', '银行', '证券', '保险', '地产', '房地产', '教育培训', '医疗', '医院', '医药',
  '制造', '机械', '化工', '建筑', '施工', '物流', '快递', '餐饮', '酒店', '零售', '外贸', '电商', '软件',
  '通信', '能源', '电力', '矿业', '纺织', '服装', '食品', '汽车', '钢铁', '传媒', '广告',
]
const RANK_WORDS = [
  '初级', '中级', '高级', '资深', '主管', '经理', '总监', '专员', '工程师', '程序员', '销售', '运营',
  '出纳', '法务', '顾问', '助理', '技工', '普工', '店长', '课长', '组长',
  '科员', '主任', '处长', '科长', 'P5', 'P6', 'P7', 'P8', 'T5', 'T6', 'T7',
]

/** 真实公司全称：只报不判定 */
const COMPANY_RE = /[\u4e00-\u9fa5A-Za-z0-9（）()]{2,30}(?:股份有限公司|有限公司|有限责任公司|集团有限公司)/g
/** 明显虚构的示例词，命中则跳过 */
const FAKE_COMPANY_WORDS = ['某', '×', 'X', 'x', '示例', '样例', '假', '测试', '公司名', 'ABC', 'abc', 'foo', 'bar', 'test', 'Test', '×××']
/** 光秃秃的组织形式词本身不是公司名（「股份有限公司」会被拆成「股份」+「有限公司」而误报） */
const BARE_COMPANY_FORMS = ['股份有限公司', '有限公司', '有限责任公司', '集团有限公司']
/** 组织形式词前面若只是这些通用词，也不算公司名 */
const GENERIC_COMPANY_PREFIX = /^(?:股份|有限|责任|集团|公司|名称|单位|形式|字样|非|的|如|或|与|及)$/

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function listTextFiles(dir) {
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
      else if (e.isFile() && TEXT_EXTS.some((x) => e.name.toLowerCase().endsWith(x))) out.push(full)
    }
  }
  return out.sort()
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd
}

/** 上下文摘要：命中处前后各取一段，便于人工判断是否真自述 */
function snippet(line, start, end) {
  const from = Math.max(0, start - 22)
  const to = Math.min(line.length, end + 22)
  return (from > 0 ? '…' : '') + line.slice(from, to).trim() + (to < line.length ? '…' : '')
}

/** 按句切分，供「同一句内三项齐备」判断 */
function sentences(line) {
  return line.split(/[。；;！!？?]/).filter((s) => s.trim() !== '')
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

function scanFile(absFile, relFile, issues, opt) {
  let text
  try {
    text = fs.readFileSync(absFile, 'utf8')
  } catch (err) {
    issues.push({ file: relFile, line: 0, col: 0, level: '提示', id: '读取失败', hit: err.message })
    return { lines: 0, waived: 0, skippedQuoted: 0 }
  }
  const lines = text.split(/\r\n|\n|\r/)
  const relNorm = relFile.replace(/\\/g, '/')
  // docs/ 是规范与核实记录，要引用违规样例当反例，需语境档一律降为「提示」
  const isDocScope = relNorm.startsWith('docs/')
  const ctxLevel = isDocScope ? '提示' : '告警'

  let waived = 0
  let skippedQuoted = 0
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 围栏代码块
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      skippedQuoted++
      continue
    }
    if (inFence) {
      skippedQuoted++
      continue
    }
    if (!opt.includeQuoted) {
      // 引用块与缩进代码块
      if (/^\s*>/.test(line) || /^(?: {4,}|\t)/.test(line)) {
        skippedQuoted++
        continue
      }
    }
    if (line.includes('脱敏扫描豁免')) {
      waived++
      continue
    }

    const spans = []

    // —— 硬命中 ——
    for (const p of HARD_PATTERNS) {
      p.re.lastIndex = 0
      let m
      while ((m = p.re.exec(line)) !== null) {
        if (m[0].length === 0) {
          p.re.lastIndex++
          continue
        }
        const start = m.index
        const end = m.index + m[0].length
        if (p.id === '微信号') {
          const cap = (m[1] || '').toLowerCase()
          if (WECHAT_NOT_A_HANDLE.includes(cap)) continue
        }
        // 与更高优先级命中重叠（例如身份证号里含手机号样式）则让位
        if (spans.some((s) => overlaps(start, end, s.start, s.end))) continue
        spans.push({ start, end, id: p.id, priority: p.priority })
        issues.push({ file: relFile, line: i + 1, col: start + 1, level: '严重', id: p.id, hit: p.mask(m[0]) })
      }
    }

    // —— 需语境档：自述处境词 ——
    // 长词优先，短词被长词包住就不再单独报（例如「笔者所在城市」里的「笔者」）
    const 处境跨度 = []
    for (const w of [...SELF_NARRATIVE_WORDS].sort((a, b) => b.length - a.length)) {
      let idx = line.indexOf(w)
      while (idx !== -1) {
        const end = idx + w.length
        if (!处境跨度.some((s) => overlaps(idx, end, s.start, s.end))) {
          处境跨度.push({ start: idx, end })
          issues.push({
            file: relFile,
            line: i + 1,
            col: idx + 1,
            level: ctxLevel,
            id: '自述处境词',
            hit: `${w}｜上下文：${snippet(line, idx, end)}`,
          })
        }
        idx = line.indexOf(w, idx + w.length)
      }
    }

    // —— 需语境档：本人 + 具体信息 ——
    let bi = line.indexOf('本人')
    while (bi !== -1) {
      const after = line.slice(bi)
      const 已被处境词覆盖 = 处境跨度.some((s) => overlaps(bi, bi + 2, s.start, s.end))
      if (!已被处境词覆盖 && !BENREN_FORMAL.test(after)) {
        const window = line.slice(bi + 2, bi + 14)
        let why = ''
        if (BENREN_TIME.test(window)) why = '时间'
        else if (BENREN_MONEY.test(window)) why = '金额'
        else {
          const hitPlace = PLACE_WORDS.find((p) => window.includes(p))
          const hitRank = RANK_WORDS.find((r) => window.includes(r))
          if (hitPlace) why = '地点'
          else if (hitRank) why = '职务'
        }
        if (why) {
          issues.push({
            file: relFile,
            line: i + 1,
            col: bi + 1,
            level: ctxLevel,
            id: '本人+具体信息',
            hit: `本人+${why}｜上下文：${snippet(line, bi, bi + 2)}`,
          })
        }
      }
      bi = line.indexOf('本人', bi + 2)
    }

    // —— 需语境档：地名 + 行业 + 职级同句 ——
    for (const s of sentences(line)) {
      const places = PLACE_WORDS.filter((w) => s.includes(w))
      const industries = INDUSTRY_WORDS.filter((w) => s.includes(w))
      const ranks = RANK_WORDS.filter((w) => s.includes(w))
      if (places.length && industries.length && ranks.length) {
        issues.push({
          file: relFile,
          line: i + 1,
          col: line.indexOf(s) + 1,
          level: ctxLevel,
          id: '地名+行业+职级',
          hit: `地名[${places.slice(0, 3).join('/')}] 行业[${industries.slice(0, 3).join('/')}] 职级[${ranks.slice(0, 3).join('/')}]｜上下文：${s.trim().slice(0, 80)}`,
        })
      }
    }

    // —— 需语境档：真实公司全称（只报不判定） ——
    COMPANY_RE.lastIndex = 0
    let cm
    while ((cm = COMPANY_RE.exec(line)) !== null) {
      const name = cm[0]
      if (BARE_COMPANY_FORMS.includes(name)) continue
      const prefix = name.replace(/(?:股份有限公司|有限公司|有限责任公司|集团有限公司)$/, '')
      if (GENERIC_COMPANY_PREFIX.test(prefix)) continue
      if (FAKE_COMPANY_WORDS.some((w) => name.includes(w))) continue
      issues.push({
        file: relFile,
        line: i + 1,
        col: cm.index + 1,
        level: ctxLevel,
        id: '公司全称（需人工判）',
        hit: name,
      })
    }
  }

  return { lines: lines.length, waived, skippedQuoted }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opt = {
    check: false,
    strict: false,
    root: path.resolve(SCRIPT_DIR, '..'),
    dirs: [],
    includeQuoted: false,
    summary: '',
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') opt.check = true
    else if (a === '--strict') opt.strict = true
    else if (a === '--include-quoted') opt.includeQuoted = true
    else if (a === '--include-fixtures') opt.includeFixtures = true
    else if (a === '--help' || a === '-h') opt.help = true
    else if (a === '--root') opt.root = path.resolve(argv[++i] ?? '.')
    else if (a === '--dir') opt.dirs.push(argv[++i] ?? '')
    else if (a === '--summary') opt.summary = argv[++i] ?? ''
    else {
      console.error(`未知参数：${a}（用 --help 查看用法）`)
      process.exit(2)
    }
  }
  return opt
}

const USAGE = `脱敏扫描 —— 用法：
  node tools/check-desensitize.mjs                    报告模式
  node tools/check-desensitize.mjs --check            CI 模式，硬命中退出 1
  node tools/check-desensitize.mjs --check --strict   需语境档也计入失败
  node tools/check-desensitize.mjs --root <目录>       指定仓库根目录
  node tools/check-desensitize.mjs --dir <目录>        追加扫描目录（可重复，默认 book docs sources）
  node tools/check-desensitize.mjs --include-quoted   连引用块与代码块一起扫
  node tools/check-desensitize.mjs --include-fixtures 连自测夹具一起扫（夹具里是故意造的虚构泄露特征）
  node tools/check-desensitize.mjs --summary <文件>    汇总追加写入该文件
退出码：0 通过 / 1 有硬命中（或 --strict 下含需语境档）/ 2 运行环境错误`

const LEVEL_ORDER = { 严重: 0, 告警: 1, 提示: 2 }

async function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.help) {
    console.log(USAGE)
    process.exit(0)
  }

  const dirs = opt.dirs.length ? opt.dirs : DEFAULT_DIRS
  const issues = []
  const scanned = []
  const missing = []
  const skippedFixtures = []

  console.log('脱敏扫描 —— 依据：docs/条目规范.md「脱敏硬规则」')
  console.log(`仓库根目录：${opt.root}`)
  console.log(`扫描范围：${dirs.join('、')}`)
  console.log(`引用块与代码块：${opt.includeQuoted ? '一并扫描' : '跳过（--include-quoted 可一并扫）'}`)
  console.log('')

  let totalWaived = 0
  let totalSkipped = 0
  for (const d of dirs) {
    const abs = path.isAbsolute(d) ? d : path.join(opt.root, d)
    if (!fs.existsSync(abs)) {
      missing.push(d)
      continue
    }
    let files
    try {
      files = fs.statSync(abs).isFile() ? [abs] : listTextFiles(abs)
    } catch {
      missing.push(d)
      continue
    }
    // 自测夹具里放的就是故意造出来的泄露特征（虚构号码），用来验证本扫描器会命中。
    // 把它们当泄露报出来只会制造噪声，还会掩盖真实命中——而噪声最终会让人不再看这份报告。
    // 默认跳过；要看夹具本身是否仍能触发规则，用 --include-fixtures。
    if (!opt.includeFixtures) {
      const kept = []
      for (const f of files) {
        if (/[\\/]selftest-fixtures[\\/]/.test(f)) skippedFixtures.push(f)
        else kept.push(f)
      }
      files = kept
    }
    for (const f of files) {
      const rel = path.relative(opt.root, f).split(path.sep).join('/')
      const r = scanFile(f, rel, issues, opt)
      totalWaived += r.waived
      totalSkipped += r.skippedQuoted
      scanned.push({ rel, lines: r.lines })
    }
  }

  if (missing.length) console.log(`[提示] 以下扫描目录不存在，已跳过：${missing.join('、')}`)

  if (scanned.length === 0) {
    console.error('[环境错误] 一个可扫描的文本文件都没有，脱敏扫描没有意义，按约定以退出码 2 报错。')
    console.error(`扫描范围：${dirs.map((d) => path.join(opt.root, d)).join('、')}`)
    process.exit(2)
  }

  issues.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
      a.col - b.col,
  )

  let lastFile = null
  for (const it of issues) {
    if (it.file !== lastFile) {
      console.log(`\n${it.file}`)
      lastFile = it.file
    }
    console.log(`  第 ${it.line} 行 第 ${it.col} 列  [${it.level}] ${it.id}：${it.hit}`)
  }

  const errCount = issues.filter((x) => x.level === '严重').length
  const warnCount = issues.filter((x) => x.level === '告警').length
  const infoCount = issues.filter((x) => x.level === '提示').length

  console.log('\n—— 汇总 ——')
  console.log(`文件 ${scanned.length} 个，共 ${scanned.reduce((s, x) => s + x.lines, 0)} 行`)
  console.log(`硬命中 ${errCount} 处，需语境档 ${warnCount} 处，提示 ${infoCount} 处`)
  console.log(`豁免行 ${totalWaived} 行；因引用块／代码块跳过 ${totalSkipped} 行`)
  if (skippedFixtures.length) {
    console.log(`自测夹具跳过 ${skippedFixtures.length} 个文件（内含故意造的虚构泄露特征；--include-fixtures 可一并扫）`)
  }

  const summaryLines = [
    '## 脱敏扫描',
    '',
    `- 扫描范围：${dirs.join('、')}；文件 ${scanned.length} 个`,
    `- 硬命中 ${errCount} 处，需语境档 ${warnCount} 处，提示 ${infoCount} 处`,
    `- 豁免行 ${totalWaived} 行；因引用块／代码块跳过 ${totalSkipped} 行`,
    ...(skippedFixtures.length ? [`- 自测夹具跳过 ${skippedFixtures.length} 个文件`] : []),
    '',
  ]
  if (issues.length) {
    summaryLines.push('| 级别 | 位置 | 类型 | 命中（已掩码） |', '| --- | --- | --- | --- |')
    for (const it of issues.slice(0, 200)) {
      summaryLines.push(`| ${it.level} | ${it.file}:${it.line}:${it.col} | ${it.id} | ${String(it.hit).replace(/\|/g, '\\|')} |`)
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
      console.error(`\n[失败] 脱敏扫描未通过：硬命中 ${errCount} 处，需语境档 ${warnCount} 处（退出码 1）`)
      process.exit(1)
    }
    console.log(`\n[通过] 无硬命中：硬命中 0 处，需语境档 ${warnCount} 处待人工判断（退出码 0）`)
    process.exit(0)
  }

  console.log(failed ? '\n（报告模式：有命中但退出码仍为 0，加 --check 才会非零退出）' : '\n（报告模式：未发现命中）')
  process.exit(0)
}

main().catch((err) => {
  console.error('[环境错误] 脚本异常终止：', err && err.stack ? err.stack : err)
  process.exit(2)
})
