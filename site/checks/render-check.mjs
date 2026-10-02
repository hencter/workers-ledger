/* 站点渲染校验：把「Hugo 模板渲染出的 HTML」「发布给前端的检索索引」
   「前端脚本的筛选逻辑」三者拉到一起对账，并覆盖两条会让整个构建失败的硬约束。

   为什么需要它：条目字段里的「主张强度」「举证难度」「效力位阶」是自由文本
   （例如「可主张（以行政责令程序为前提）」「法律 + 司法解释」），
   站点把折算成分档的逻辑写了两份——Go 模板 partial 和前端脚本。
   两份逻辑一旦漂移，页面上的分布、徽章颜色和筛选结果就会互相矛盾，
   而 Hugo 自己不会报错。这个脚本就是那道对账。

   用法（先有产物，再跑校验）：
     node tools/build-site.mjs
     cd site && hugo --minify
     node site/checks/render-check.mjs                 # 默认读 site/public
     node site/checks/render-check.mjs --out .tmp-build  # 指定别的产物目录

   校验项：
     A 纯函数（待复核日期算术、关键词归一化、URL query 往返）
     B 归一化一致性（模板分档数字 vs 脚本筛选条数，逐档比对）
     C 索引与产物（每条 url 都能落到真实 index.html、枚举取值完整）
     D 渲染钩子（脚本查询的选择器在模板里都存在、13 个字段都渲染出来）
     E 硬约束（无 HAHAHUGOSHORTCODE、无未转义短代码分隔符）

   退出码：0 全通过；1 有断言不通过。
*/

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const SITE = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const outArg = args.indexOf('--out')
// 默认读站点自己的 public/；--out 传相对路径时按当前工作目录解析
const OUT = outArg >= 0 && args[outArg + 1]
  ? path.resolve(process.cwd(), args[outArg + 1])
  : path.join(SITE, 'public')
const JS_BASE = url.pathToFileURL(path.join(SITE, 'themes/ledger/assets/js/')).href
const STALE_DAYS = 180

let total = 0
let failed = 0
const check = (name, actual, expected) => {
  total += 1
  const ok = String(actual) === String(expected)
  if (!ok) {
    failed += 1
    console.log(`不通过｜${name}｜实际=${actual}｜期望=${expected}`)
  }
}
const checkTrue = (name, value) => check(name, Boolean(value), true)

if (!fs.existsSync(path.join(OUT, 'index.html'))) {
  console.error(`[环境错误] 找不到 ${path.join(OUT, 'index.html')}，先跑 hugo 生成产物（可用 --out 指定目录）`)
  process.exit(2)
}

const { isStale, daysSince } = await import(`${JS_BASE}stale.js`)
const search = await import(`${JS_BASE}search.js`)

const index = JSON.parse(fs.readFileSync(path.join(OUT, 'entries.json'), 'utf8'))
const entries = index.entries
const homeHtml = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8')

/* 属性取值：hugo --minify 会把可省的引号去掉（class="a b" 保留、id=x 变成 id=x），
   所以这里统一用「带引号 / 不带引号都认」的方式取属性，正则不写死引号。 */
function attr(html, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`)
  const m = re.exec(html)
  return m ? m[1] ?? m[2] ?? m[3] : null
}

/* 索引里的 url 带部署前缀（GitHub Pages 项目页形如 /workers-ledger/），
   而产物目录是前缀之后的相对路径，所以先按站点自己的前缀削一刀。
   前缀从首页 <html data-base> 取，站点换 baseURL 也不用改脚本。 */
const basePath = attr(homeHtml, 'data-base') || '/'
const stripBase = (u) => (u.startsWith(basePath) ? `/${u.slice(basePath.length)}` : u)
const outPathOf = (u) => path.join(OUT, decodeURIComponent(stripBase(u)).replace(/^\//, ''))

// —— A. 纯函数 ——
check('核对日期距今 241 天', daysSince('2026-10-03', new Date(2027, 5, 1)), 241)
check('恰好 180 天不算超期', isStale('2026-10-03', STALE_DAYS, new Date(2027, 3, 1)), false)
check('181 天算超期', isStale('2026-10-03', STALE_DAYS, new Date(2027, 3, 2)), true)
check('空日期不报超期', isStale('', STALE_DAYS, new Date(2030, 0, 1)), false)
check('非法日期不报超期', isStale('不是日期', STALE_DAYS, new Date(2030, 0, 1)), false)
check('关键词归一化压平全角空格', search.normalize('加班　费'), '加班 费')

const state = { q: '加班费', facets: Object.fromEntries(search.FACETS.map((f) => [f.key, []])) }
state.facets.claim = ['可主张']
state.facets.proof = ['难']
const roundTrip = search.parseState(search.toQuery(state))
check('query 往返·关键词', roundTrip.q, '加班费')
check('query 往返·主张强度', roundTrip.facets.claim.join(','), '可主张')
check('query 往返·举证难度', roundTrip.facets.proof.join(','), '难')

// 检索面板不提供「按节筛选」—— 按节收窄由左侧目录负责，两处入口是重复。
// 这条断言防止它被无意中加回来。
// 注意：不要把这条写成对 homeHtml 的静态匹配。facets 是脚本运行时生成的，
// 静态 HTML 里从来没有 data-facet 属性，那样的断言永远不会失败，只是虚假的安心。
check('筛选维度不含「节」', search.FACETS.some((f) => f.key === 'sec'), false)

// —— B. 归一化一致性 ——
const empty = { q: '', facets: Object.fromEntries(search.FACETS.map((f) => [f.key, []])) }
const jsCount = (patch) =>
  entries.filter((e) =>
    search.matches(e, { ...empty, ...patch, facets: { ...empty.facets, ...(patch.facets || {}) } })
  ).length

const gaugeRe = /<p class=(?:"gauge gauge--([a-z-]+)"|'gauge gauge--([a-z-]+)'|gauge gauge--([a-z-]+))[^>]*>([\s\S]*?)<\/p>/g
const gauges = [...homeHtml.matchAll(gaugeRe)].map((m) => {
  const body = m[4]
  return {
    cls: m[1] ?? m[2] ?? m[3],
    label: (/gauge__label[^>]*>([^<]*)</.exec(body) || [, ''])[1],
    n: Number((/gauge__val[^>]*>(\d+)</.exec(body) || [, 'NaN'])[1]),
  }
})
const byClass = (cls) => gauges.filter((g) => g.cls === cls)

check('首页证据分布渲染行数（主张 3 + 举证 3 + 位阶 8）', gauges.length, 14)

const CLAIM = [
  ['可主张', 'claim-strong'],
  ['可推定', 'claim-mid'],
  ['倡导性', 'claim-weak'],
]
for (const [bucket, cls] of CLAIM) {
  const row = byClass(cls)
  check(`主张强度「${bucket}」模板数字 = 脚本筛选条数`, row.length === 1 ? row[0].n : `行数${row.length}`, jsCount({ facets: { claim: [bucket] } }))
  check(`主张强度「${bucket}」标签文字`, row.length === 1 ? row[0].label : '缺行', bucket)
}

const PROOF = [
  ['易', 'proof-easy'],
  ['中', 'proof-mid'],
  ['难', 'proof-hard'],
]
for (const [bucket, cls] of PROOF) {
  const row = byClass(cls)
  check(`举证难度「${bucket}」模板数字 = 脚本筛选条数`, row.length === 1 ? row[0].n : `行数${row.length}`, jsCount({ facets: { proof: [bucket] } }))
  check(`举证难度「${bucket}」标签文字`, row.length === 1 ? row[0].label : '缺行', bucket)
}

const RANKS = ['法律', '行政法规', '部门规章', '司法解释', '地方性法规', '规范性文件', '地方口径', '无明文依据']
const rankRows = byClass('neutral')
check('效力位阶渲染 8 行', rankRows.length, 8)
for (const rank of RANKS) {
  const row = rankRows.find((r) => r.label === rank)
  check(`效力位阶「${rank}」模板数字 = 脚本筛选条数`, row ? row.n : '缺行', jsCount({ facets: { rank: [rank] } }))
}

check('主张强度三档覆盖全部条目', CLAIM.reduce((acc, [b]) => acc + jsCount({ facets: { claim: [b] } }), 0), entries.length)
check('举证难度三档覆盖全部条目', PROOF.reduce((acc, [b]) => acc + jsCount({ facets: { proof: [b] } }), 0), entries.length)
checkTrue('主张强度取值都在枚举内', entries.every((e) => ['可主张', '可推定', '倡导性'].includes(e['主张强度'])))
checkTrue('举证难度取值都在枚举内', entries.every((e) => ['易', '中', '难'].includes(e['举证难度'])))
checkTrue('效力位阶都能归到至少一档', entries.every((e) => Array.isArray(e['效力位阶全部']) && e['效力位阶全部'].length > 0))
checkTrue('「无明文依据」的条目主张强度只能是倡导性', entries.filter((e) => e['效力位阶全部'].includes('无明文依据')).every((e) => e['主张强度'] === '倡导性'))

// —— C. 索引与产物 ——
check('索引条数 = 数组长度', index.count, entries.length)
check(`索引 staleDays = ${STALE_DAYS}`, index.staleDays, STALE_DAYS)
checkTrue('每条 url 以 / 开头', entries.every((e) => typeof e.url === 'string' && e.url.startsWith('/')))
checkTrue('每条核对日期形如 YYYY-MM-DD', entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e['核对日期'])))
checkTrue('每条都有成本标签五项', entries.every((e) => e['成本标签'] && ['钱', '时间', '毅力', '收益', '口径'].every((k) => e['成本标签'][k])))

const missingPages = entries.filter((e) => !fs.existsSync(path.join(outPathOf(e.url), 'index.html')))
check('每条 url 都能落到真实产物', missingPages.length, 0)
if (missingPages.length) console.log('  缺失样例：', missingPages.slice(0, 3).map((e) => e.url))

check('url 无重复', new Set(entries.map((e) => e.url)).size, entries.length)
const outDirs = fs.readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d/.test(d.name)).map((d) => d.name)
check('索引里的节数与产物目录数一致', new Set(entries.map((e) => e['节号'])).size, outDirs.length)

// —— D. 渲染钩子 ——
const tpl = /<template[^>]*id=(?:"entry-card-tpl"|entry-card-tpl)[^>]*>([\s\S]*?)<\/template>/.exec(homeHtml)
checkTrue('首页含检索结果卡片模板', Boolean(tpl))
const tplHtml = tpl ? tpl[1] : ''
for (const hook of ['card__num', 'card__sec', 'card__link', 'card__lead', 'badge--claim', 'badge--proof', 'badge--rank', 'badge--date', 'badge__v', 'meter', 'data-stale-flag', 'card__basis', 'card__chips']) {
  checkTrue(`卡片模板含脚本查询的钩子 ${hook}`, tplHtml.includes(hook))
}
for (const hook of ['data-search-app', 'data-index-url', 'data-facets', 'data-applied', 'data-results', 'data-count', 'data-more', 'data-query', 'data-clear']) {
  checkTrue(`首页含检索应用钩子 ${hook}`, homeHtml.includes(hook))
}
check(`首页带待复核阈值 data-stale-days`, attr(homeHtml, 'data-stale-days'), STALE_DAYS)
const cssTag = /<link[^>]*stylesheet[^>]*>/.exec(homeHtml)?.[0] || ''
const jsTag = /<script[^>]*src=[^>]*><\/script>/.exec(homeHtml)?.[0] || ''
checkTrue('首页样式来自本站指纹文件', /css\/main\.[0-9a-f]+\.css/.test(cssTag))
checkTrue('首页脚本来自本站指纹文件', /js\/main\.[0-9a-f]+\.js/.test(jsTag))
const robotsTag = /<meta[^>]*name=(?:"robots"|robots)[^>]*>/.exec(homeHtml)?.[0] || ''
checkTrue('production 环境输出 index, follow', robotsTag.includes('index, follow'))

// —— 语言标识与 Hugo 版本兼容 ——
// 真实事故：本项目在 Hugo 0.167 上开发（`.Locale` 可用，返回 "zh-CN"），
// 但撞到一个 Hugo 0.147.5 的构建环境，报
//   can't evaluate field Locale in type *langs.Language
// 因为 `.Locale` 是 0.158 才引入的（见参考：0.158 起 languageCode → locale，
// 语言对象的 Lang/LanguageCode/LanguageDirection/LanguageName 被弃用）。
// 模板改用 partial "locale.html"：优先 .Locale、旧版退回 .Lang。
// 实测 0.167 下 .Locale="zh-CN" 而 .Lang="en"，两者不等价，所以不能直接换成 .Lang。
// 下面三条既盯输出值，也盯住「别再裸用 .Locale」。
const langAttr = /<html[^>]*\blang=(?:"([^"]*)"|([^ >]+))/.exec(homeHtml)
check('html lang 为 zh-CN（不是 en）', (langAttr?.[1] || langAttr?.[2] || '').trim(), 'zh-CN')
const ogLocaleTag = /<meta[^>]*property="og:locale"[^>]*>/.exec(homeHtml)?.[0] || ''
checkTrue('og:locale 为 zh_CN', ogLocaleTag.includes('zh_CN'))
const themeDir = path.join(SITE, 'themes')
let rawLocaleUses = []
const walkHtml = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkHtml(p)
    else if (e.name.endsWith('.html')) {
      const body = fs.readFileSync(p, 'utf8')
      // locale.html 自身就是做兼容探测的，跳过它
      if (p.endsWith('locale.html')) continue
      body.split(/\r?\n/).forEach((line, i) => {
        if (/site\.Language\.Locale/.test(line)) rawLocaleUses.push(`${p}:${i + 1}`)
      })
    }
  }
}
walkHtml(themeDir)
check('模板里没有裸用 site.Language.Locale（Hugo <0.158 会构建失败）', rawLocaleUses.length, 0)

// —— 版面宽度 ——
// 背景与实测数据见 site/checks/measure-layout.mjs（用无头浏览器量真实盒子）。
// 前两轮是靠「可用宽度 − 上限」估算的，漏掉了 .entry 上还有第二层上限，
// 于是得出「已经修好」的结论而用户看到的留白仍然很大。所以这里不再猜规则，
// 改成断言「主区没有宽度上限」+「正文块有合理行宽上限」，再用独立脚本量几何。
//
// 注：原来还有一条「首页 main 带 main--home 修饰类」。主区统一不限宽之后
// 首页不再需要这个修饰类，`.main--home` 规则也一并删除——那条断言随之作废，
// 留着一个恒为假的条件比没有更糟。baseof.html 里的类名保留着（无害，
// 将来若又要区分首页与正文页的宽度，直接加规则即可）。
const cssHref = /href=(?:"([^"]*\/css\/[^"]+\.css)"|([^ >]*\/css\/[^ >]+\.css))/.exec(cssTag)
const cssRel = cssHref ? (cssHref[1] || cssHref[2]) : ''
const cssBody = cssRel
  ? fs.readFileSync(path.join(OUT, decodeURIComponent(stripBase(cssRel)).replace(/^\//, '')), 'utf8')
  : ''
// 注意：不要写 /\.main\{[^}]*max-width/ 这类跨块的负向匹配。源文件里 .main 有多条规则
// （通用、宽屏、窄屏），压缩后首尾相接，负向匹配会跨到相邻规则上去，导致断言恒为假——
// 我第一次就是这么写的，反向测试时才发现它一直红着。
// 改成检查宽屏那条规则的正面特征：它应只有 padding，带上限时会是 padding:…;max-width:…
checkTrue(
  '宽屏 .main 规则不含 max-width 上限',
  /\.main\{padding:var\(--sp-7\) 0 var\(--sp-8\)\}/.test(cssBody) &&
    !/\.main\{padding:var\(--sp-7\) 0 var\(--sp-8\);max-width/.test(cssBody),
)
checkTrue('产物 CSS 含 .entry{max-width:none}（条目页不再被二次限宽）', /\.entry\{max-width:none\}/.test(cssBody))
checkTrue('连续正文块有行宽上限（说人话 / 备注）', /\.lead-block\{[^}]*max-width:66rem/.test(cssBody))
const sidebarM = /--sidebar-w:\s*(\d+)px/.exec(cssBody)
checkTrue('产物 CSS 能读到 --sidebar-w', Boolean(sidebarM))
checkTrue(
  `侧栏宽度不低于 304px（当前 ${sidebarM ? sidebarM[1] : '?'}px）`,
  Boolean(sidebarM) && Number(sidebarM[1]) >= 304,
)
checkTrue(
  '产物 CSS 的结果两列断点不高于 1120px（否则宽屏仍是单列）',
  /@media\(min-width:(\d+)px\)\{\.results__list\{grid-template-columns:repeat\(2/.test(cssBody) &&
    Number(/@media\(min-width:(\d+)px\)\{\.results__list\{grid-template-columns:repeat\(2/.exec(cssBody)[1]) <= 1120,
)

const outDirsSorted = outDirs.slice().sort()
const sectionHtml = fs.readFileSync(path.join(OUT, outDirsSorted[1], 'index.html'), 'utf8')
for (const hook of ['data-local-filter', 'data-local-count', 'data-local-empty', 'data-entry-card', 'data-search=']) {
  checkTrue(`节页含节内过滤钩子 ${hook}`, sectionHtml.includes(hook))
}
checkTrue('节页每张卡片都带 data-entry-card', (sectionHtml.match(/data-entry-card/g) || []).length >= 2)

const sectionPrefix = `/${outDirsSorted[1]}/`
const firstEntry = entries.find((e) => stripBase(decodeURIComponent(e.url)).startsWith(sectionPrefix))
checkTrue('节页里能找到对应的条目索引项', Boolean(firstEntry))
const entryHtml = firstEntry ? fs.readFileSync(path.join(outPathOf(firstEntry.url), 'index.html'), 'utf8') : ''
for (const field of ['适用', '成本', '收益', '依据', '效力位阶', '主张强度', '举证难度', '地域', '时效', '来源', '核对日期', '备注', '成本标签']) {
  checkTrue(`条目页渲染字段「${field}」`, entryHtml.includes(`<dt>${field}</dt>`))
}
checkTrue('条目页有「说人话」块', entryHtml.includes('lead-block__label'))
const dateTag = (entryHtml.match(/<time\b[^>]*>/g) || []).find((t) => t.includes('badge--date')) || ''
checkTrue('条目页有机器可读的核对日期 time', /datetime=(?:"|')?\d{4}-\d{2}-\d{2}/.test(dateTag))
checkTrue('条目页有可点的来源链接', entryHtml.includes('src-link'))
checkTrue('条目页有主张强度颜色类名', /badge--claim-(strong|mid|weak)/.test(entryHtml))
checkTrue('条目页有举证难度颜色类名', /badge--proof-(easy|mid|hard)/.test(entryHtml))

/* 结构化数据必须是裸 JSON 对象。
   Hugo 在 <script> 上下文里按 JS 字符串转义，只写 jsonify 会得到
   "{\"@type\":...}" 这种带引号的字符串，消费方读不到 @type，这块数据等于无效；
   模板里对应的写法是 {{ $ld | jsonify | safeJS }}。 */
const ldOf = (html) => {
  const m = /<script[^>]*type=(?:"application\/ld\+json"|application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/.exec(html)
  return m ? m[1].trim() : ''
}
const homeLd = ldOf(homeHtml)
checkTrue('首页有 JSON-LD', Boolean(homeLd))
checkTrue('首页 JSON-LD 是裸对象（不是被转义的字符串）', homeLd.startsWith('{'))
let homeLdType = '解析失败'
try { homeLdType = JSON.parse(homeLd)['@type'] } catch (err) { homeLdType = `解析失败：${err.message}` }
check('首页 JSON-LD 可解析且 @type', homeLdType, 'WebSite')

const entryLd = ldOf(entryHtml)
checkTrue('条目页 JSON-LD 是裸对象', entryLd.startsWith('{'))
let entryLdType = '解析失败'
let entryLdOk = false
try {
  const parsed = JSON.parse(entryLd)
  entryLdType = parsed['@type']
  entryLdOk = typeof parsed.headline === 'string' && parsed.isPartOf && parsed.isPartOf['@type'] === 'Book' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.datePublished)
} catch (err) { entryLdType = `解析失败：${err.message}` }
check('条目页 JSON-LD @type', entryLdType, 'Article')
checkTrue('条目页 JSON-LD 含 headline / isPartOf / datePublished', entryLdOk)

/* 侧栏条目数必须等于索引条数：不要用 site.RegularPages，
   那会把作者以后新增的普通页（如 about.md）也算成条目。 */
check('侧栏「共 N 条」与索引条数一致', Number((/共\s*(\d+)\s*条/.exec(homeHtml) || [, 'NaN'])[1]), entries.length)

// —— E. 硬约束与离线可用 ——
const hardRuleHits = []
const externalResourceTags = []
for (const file of walk(OUT)) {
  const rel = path.relative(OUT, file)
  if (file.endsWith('.html') || file.endsWith('.json')) {
    const text = fs.readFileSync(file, 'utf8')
    if (text.includes('HAHAHUGOSHORTCODE')) hardRuleHits.push(`HAHAHUGOSHORTCODE: ${rel}`)
    if (/\{\{<[^/]|\{\{%[^/]/.test(text)) hardRuleHits.push(`未转义短代码分隔符: ${rel}`)
  }
  if (file.endsWith('.html')) {
    const text = fs.readFileSync(file, 'utf8')
    // canonical 本来就是绝对地址（站点自己的 baseURL），不算外来资源；只查会发起加载的标签
    for (const tag of text.match(/<(?:script|link)\b[^>]*>/g) || []) {
      if (/rel\s*=\s*(?:"|')?canonical/.test(tag)) continue
      if (/(?:src|href)\s*=\s*(?:"|')?https?:\/\//.test(tag)) externalResourceTags.push(`${rel}: ${tag.trim().slice(0, 100)}`)
    }
    for (const tag of text.match(/<img\b[^>]*>/g) || []) {
      if (/(?:src|srcset)\s*=\s*(?:"|')?https?:\/\//.test(tag)) externalResourceTags.push(`${rel}: ${tag.trim().slice(0, 100)}`)
    }
  }
  if (file.endsWith('.css')) {
    const text = fs.readFileSync(file, 'utf8')
    if (/url\(\s*(?:"|')?https?:/.test(text)) externalResourceTags.push(`${rel}: CSS url() 外部引用`)
    if (/@import/.test(text)) externalResourceTags.push(`${rel}: CSS @import 未内联`)
    if (/@font-face/.test(text)) externalResourceTags.push(`${rel}: 外部字体声明`)
  }
}
check('产物中没有短代码占位符与未转义分隔符', hardRuleHits.length, 0)
for (const hit of hardRuleHits.slice(0, 5)) console.log('  ', hit)
check('产物中没有任何外来资源标签（离线可用）', externalResourceTags.length, 0)
for (const hit of externalResourceTags.slice(0, 5)) console.log('  ', hit)

function* walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) yield* walk(full)
    else yield full
  }
}

console.log(`校验目录：${OUT}`)
console.log(`共 ${total} 项断言，不通过 ${failed} 项`)
process.exit(failed ? 1 : 0)
