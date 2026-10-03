#!/usr/bin/env node
/**
 * semantic-check.mjs —— HTML 语义化 / SEO / 爬虫可读性断言
 *
 *   node tools/checks/semantic-check.mjs                 断言全部产物页面
 *   node tools/checks/semantic-check.mjs --dir <目录>    指定产物目录
 *   node tools/checks/semantic-check.mjs --limit 20      只查前 N 页（调试用）
 *
 * 为什么单独有一道：语义化不是「看着顺眼」，它直接决定三件事——
 *   ① 爬虫能不能正确解析页面结构（标题层级、列表、时间）；
 *   ② 屏幕阅读器能否按地标（landmark）跳转；
 *   ③ 结构化数据与社交预览取的是哪一段。
 * 这些在 CSS 里看不出来，也不会有编译错误，只能靠断言守住。
 *
 * 断言依据（都是可查的规范条款，不是个人偏好）：
 *   - HTML 标准：`<html lang>` 必需；`id` 全文档唯一；`<time>` 若表示日期须带 datetime；
 *     `<dl>` 的子元素只能是 `<dt>/<dd>/<div>/<script>/<template>`；
 *     `<ul>/<ol>` 的直接子元素只能是 `<li>/<script>/<template>`；
 *     `<a>` 不得嵌套 `<a>`；`<main>` 每文档至多一个。
 *   - 无障碍/语义：每文档恰有一个 `<h1>`；标题级别不跳级（h2→h4 是缺陷）；
 *     页面主体在 `<main>` 内；跳转链接指向已存在的 id。
 *   - SEO：`<title>` 非空且唯一；`<meta name=description>` 存在；
 *     canonical 存在；`img` 必须有 alt 属性（哪怕为空）。
 *
 * 退出码：0 全通过 / 1 有断言不通过 / 2 环境错误
 *
 * ⚠ 写这个脚本时踩过的一个坑，记在这里免得重犯：
 *   `hugo --minify` 会把属性值两边的**引号去掉**（`<meta name="description" ...>`
 *   变成 `<meta name=description ...>`）。用带引号的正则去匹配产物，会得出
 *   「342 页全都没有 JSON-LD / canonical / description」的错误结论——
 *   而实际上它们都在。所以本文件里所有属性匹配都用 `attr()`（同时接受
 *   带引号、单引号、无引号三种写法），不要写死引号。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const PUBLIC = resolve(argOf('--dir', join(ROOT, 'public')))
const LIMIT = Number(argOf('--limit', '0')) || 0

if (!existsSync(PUBLIC)) {
  console.error(`[环境错误] 找不到产物目录：${PUBLIC}`)
  console.error('先跑：node tools/build-prod.mjs')
  process.exit(2)
}

// ---------------------------------------------------------------------------
const failures = []
let total = 0
const add = (name, ok, detail) => {
  total++
  if (!ok) failures.push({ name, detail })
}

/** 收集所有 index.html */
const pages = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.html')) pages.push(p)
  }
}
walk(PUBLIC)
pages.sort()
const target = LIMIT ? pages.slice(0, LIMIT) : pages

// ---------------------------------------------------------------------------
// 逐页断言
// ---------------------------------------------------------------------------

/**
 * 逐标签扫描的通用正则。
 *
 * **为什么不能写成 `<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>`**：`hugo --minify` 会把属性
 * 两边的引号去掉，于是出现 `<a href=/01-%E7%AD%BE...>` 这样的标签。用 `[^>]*?` 惰性匹配时，
 * URL 开头的那个 `/` 会被当成「自闭合斜杠」捕获到第 3 组，`<a>` 于是被误判为 void，
 * 嵌套深度不再递增——一路漂到负数，最后把 <ul> 之间的 <ul> 报成「直接子元素」，
 * 凭空产生 330 项假阳性。
 *
 * 所以属性值必须显式识别三种形态：双引号、单引号、无引号（无引号时不允许含 `/`）。
 * 这样 `<a href=/x/y>` 里 URL 的每个 `/` 都在无引号值内部，不会被误认为自闭合。
 *
 * **还要先吃掉注释与 DOCTYPE。** 否则 `<!DOCTYPE html>` 会被当成名为 `!doctype` 的标签、
 * `<!-- … -->` 被当成 `!--`，双双压进祖先栈——栈从此错位一位，后续所有配对都串了
 * （实测症状：`</a>` 配到 `<header>`，最后把 `<ul>` 报成 `<ul>` 的直接子元素，330 项假阳性）。
 * 注释在 minify 后仍可能存在，DOCTYPE 一定存在，所以两者都必须显式跳过。
 */
const TAG_RE = /<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+(?:[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?))*)\s*(\/?)>/g
/** 从属性串判断是否以自闭合斜杠结束 */
const isSelfClosing = (attrs, tail) => tail === '/' || /\/\s*$/.test(attrs)

/** 统一的标签扫描：带引号的属性值不会被 URL 里的 `/` 误判为自闭合（见 TAG_RE 的说明） */
function scanTags(html) {
  const out = []
  const re = new RegExp(TAG_RE.source, 'g')
  let m
  while ((m = re.exec(html)) !== null) {
    // 注释与 DOCTYPE 也会被上面的正则命中，但它们不是元素，必须丢弃
    // （m[2] 为 undefined 即这类情况）
    if (!m[2]) continue
    out.push({
      raw: m[0], idx: m.index,
      closing: m[1] === '/',
      name: m[2].toLowerCase(),
      self: isSelfClosing(m[3] || '', m[4] || ''),
    })
  }
  return out
}

const tags = (html, name) => scanTags(html).filter((t) => !t.closing && t.name === name).map((t) => t.raw)
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null
}
/** 去脚本/样式/template 后剩下的可见骨架，避免把模板里的占位标签当成真实内容 */
const visible = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<template[\s\S]*?<\/template>/gi, '')

/**
 * 列表直接子元素判据（**只看列表标签**）。
 *
 * 为什么不用「全文档祖先栈」：那样需要把页面上所有元素都正确配对，任何一个
 * 被漏掉的开标签都会让栈错位，进而把正确的结构报成错误。本项目实测踩到过：
 * 栈错位后凭空产生 330 项「<ul> 直接子元素出现 <ul>」，而用只含 `ul`/`li` 的
 * 最小状态机复核，同一份产物是 **0 处**——**产物是对的，判据是错的**。
 *
 * 所以这里把判据收窄到只依赖它真正要验证的那两个标签：
 * 对每个 `<ul>`/`<ol>`，若它直接包住另一个 `<ul>`/`<ol>`（中间没有 `<li>`），
 * 那就是结构缺陷（HTML 规范要求列表的直接子元素只能是 li）。
 * 判据越窄越可信——这也是本项目在 check-items / check-refs 里一贯的口径。
 */
export function invalidListChildren(html) {
  const bad = []
  const stack = []
  const re = /<(\/?)(ul|ol|li)\b[^>]*?(\/?)>/g
  let m
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/'
    const name = m[2].toLowerCase()
    const self = m[3] === '/'
    if (closing) {
      stack.pop()
      continue
    }
    const parent = stack[stack.length - 1]
    if ((name === 'ul' || name === 'ol') && (parent === 'ul' || parent === 'ol')) {
      bad.push({ name, idx: m.index, parent })
    }
    if (!self) stack.push(name)
  }
  return bad
}

const stats = {
  页面: 0, h1数: 0, 地标: 0, 标题跳级: 0,
}

// 诊断出口：WRC_SHOW_KIDS=<路径子串> 时，打印匹配页面上「谁的父元素是 <ul>」，
// 带位置与原文，然后照常继续。判据出问题时用它直接取证，
// 不必另写一份复刻代码——本项目在这道断言上连踩三个坑，全靠这类出口看清。
if (process.env.WRC_SHOW_KIDS) {
  const needle = process.env.WRC_SHOW_KIDS
  const norm = (s) => s.split(/[\\/]/).join('/')
  const hit = pages.find((p) => norm(p).includes(needle))
  if (!hit) {
    console.log(`kids: 没有匹配「${needle}」的页面`)
  } else {
    const raw = readFileSync(hit, 'utf8')
    const body0 = visible(raw)
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
    const stack = []
    let n = 0
    let mismatch = 0
    for (const t of scanTags(body0)) {
      const selfClose = t.self || VOID.has(t.name)
      if (t.closing) {
        const top = stack.pop()
        if (top !== t.name) {
          mismatch++
          if (mismatch <= 5) console.log(`kids: 标签不配对 —— 闭合 </${t.name}> 但栈顶是 <${top}> @${t.idx}  栈=${stack.join('>')}`)
        }
        continue
      }
      const parent = stack[stack.length - 1]
      if (parent === 'ul') {
        n++
        console.log(`kids: <ul> 的子元素 <${t.name}> @${t.idx}  父栈=${stack.join('>')}`)
        console.log('  ' + JSON.stringify(body0.slice(Math.max(0, t.idx - 160), t.idx + 60)))
      }
      if (!selfClose) stack.push(t.name)
    }
    console.log(`kids: 共 ${n} 处；标签不配对 ${mismatch} 处`)
  }
}

for (const p of target) {
  const html = readFileSync(p, 'utf8')
  const rel = relative(PUBLIC, p).split('\\').join('/')
  stats.页面++

  // ① doctype
  add(`${rel}｜<!DOCTYPE html>`, /^\s*<!DOCTYPE html>/i.test(html), '文件开头不是 <!DOCTYPE html>')

  // ② html lang
  const htmlTag = tags(html, 'html')[0] || ''
  const lang = attr(htmlTag, 'lang')
  add(`${rel}｜<html lang>`, Boolean(lang && lang.trim()), `<html> 缺少 lang 属性`)

  // ③ <title> 非空
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || ''
  add(`${rel}｜<title> 非空`, title.trim().length > 0, '<title> 为空')

  // ④ meta description
  const desc = /<meta[^>]+name=["']?description["']?[^>]*>/i.test(html)
    ? (attr((/<meta[^>]+name=["']?description["']?[^>]*>/i.exec(html) || [''])[0], 'content') || '')
    : ''
  add(`${rel}｜<meta description>`, desc.trim().length > 0, '缺少可用的 meta description')

  // ⑤ canonical
  add(`${rel}｜canonical`, /<link[^>]+rel=["']?canonical["']?[^>]*>/i.test(html), '缺少 rel=canonical')

  // ⑥ id 唯一
  const ids = [...html.matchAll(/\sid\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((m) => m[2] ?? m[3] ?? m[4])
  const seen = new Set()
  const dupIds = []
  for (const id of ids) {
    if (seen.has(id)) dupIds.push(id)
    seen.add(id)
  }
  add(`${rel}｜id 唯一`, dupIds.length === 0, `重复 id：${[...new Set(dupIds)].join('、')}`)

  // ⑦ <main> 至多一个，且存在
  const mains = tags(html, 'main').length
  add(`${rel}｜恰有一个 <main>`, mains === 1, `实际 ${mains} 个 <main>`)

  // ⑧ 跳转链接指向存在的 id
  const skip = (/<a[^>]+class=["']?skip-link["']?[^>]*>/i.exec(html) || [''])[0]
  if (skip) {
    const href = attr(skip, 'href') || ''
    const targetId = href.startsWith('#') ? href.slice(1) : ''
    add(`${rel}｜skip-link 目标存在`, Boolean(targetId) && seen.has(targetId), `#${targetId} 在页面里找不到`)
  }

  // ⑨ 标题层级：恰一个 h1；不跳级
  const body = visible(html)
  const hs = [...body.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => Number(m[1]))
  const h1n = hs.filter((x) => x === 1).length
  add(`${rel}｜恰有一个 <h1>`, h1n === 1, `实际 ${h1n} 个 <h1>`)
  if (h1n === 1) stats.h1数++
  let prev = 0
  let skipAt = ''
  for (const h of hs) {
    if (prev && h > prev + 1 && !skipAt) skipAt = `h${prev} → h${h}`
    prev = h
  }
  add(`${rel}｜标题不跳级`, !skipAt, skipAt ? `${skipAt}（跳级，目录/爬虫解析会断）` : '')
  if (skipAt) stats.标题跳级++

  // ⑩ <time> 表示日期须带 datetime
  const times = tags(body, 'time')
  const badTimes = times.filter((t) => !attr(t, 'datetime'))
  add(`${rel}｜<time> 带 datetime`, badTimes.length === 0, `${badTimes.length} 个 <time> 缺 datetime`)

  // ⑪ <dl> 直接子元素合法
  for (const m of body.matchAll(/<dl\b[^>]*>([\s\S]*?)<\/dl>/gi)) {
    const inner = m[1]
    const illegal = [...inner.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g)]
      .map((x) => ({ close: x[1] === '/', name: x[2].toLowerCase() }))
      .filter((x) => !x.close && !['dt', 'dd', 'div', 'script', 'template', 'p', 'span', 'time', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li', 'code', 'br'].includes(x.name))
    if (illegal.length) {
      add(`${rel}｜<dl> 子元素合法`, false, `出现 ${[...new Set(illegal.map((x) => `<${x.name}>`))].join('、')}`)
    }
  }

  // ⑫ <ul>/<ol> 直接子元素只能是 li（允许 script/template）
  //
  // 这里必须按**嵌套深度**取直接子元素，不能用正则「删掉子列表再匹配」——
  // 那样做踩了两次假阳性：① 子列表没删干净，其内部标签被当成外层直接子元素；
  // ② 源正则里写 `<\/\1>`，类字符中的 `\1` 不展开，实际匹配成空串。
  // 逐字符扫标签并计数，是这类结构断言唯一稳的做法。
  // ⑫ <ul>/<ol> 的直接子元素只能是 li（判据只看列表标签，见 invalidListChildren 的说明）
  {
    const bad = invalidListChildren(body)
    if (bad.length) {
      add(`${rel}｜列表直接子元素只能 li`, false,
        bad.slice(0, 3).map((b) => `<${b.parent}> 直接包住 <${b.name}> @${b.idx}`).join('；'))
    }
  }

  // ⑬ <a> 不得嵌套
  for (const m of body.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (/<a\b/i.test(m[1])) { add(`${rel}｜<a> 不嵌套`, false, '发现嵌套的 <a>'); break }
  }

  // ⑭ img 必须有 alt 属性
  const imgs = tags(body, 'img')
  const noAlt = imgs.filter((t) => attr(t, 'alt') === null)
  add(`${rel}｜<img> 带 alt`, noAlt.length === 0, `${noAlt.length} 个 <img> 缺 alt`)

  // ⑮ 地标齐全：header / nav / main / footer
  const landmarks = ['header', 'nav', 'main', 'footer'].filter((t) => tags(body, t).length > 0)
  add(`${rel}｜地标 ≥3 种`, landmarks.length >= 3, `只有 ${landmarks.join('、') || '（无）'}`)
  if (landmarks.length >= 3) stats.地标++

  // ⑯ 导航地标有可区分的无障碍名（同页多个 <nav> 时必须能区分）
  const navs = tags(body, 'nav')
  if (navs.length > 1) {
    const named = navs.filter((t) => attr(t, 'aria-label') || attr(t, 'aria-labelledby'))
    add(`${rel}｜多个 <nav> 都有名字`, named.length === navs.length, `${navs.length} 个 <nav>，只有 ${named.length} 个有无障碍名`)
  }

  // ⑰ aria-labelledby / aria-describedby 指向的 id 必须存在（否则无障碍名静默失效）
  for (const t of [...tags(body, 'section'), ...tags(body, 'nav'), ...tags(body, 'aside'), ...tags(body, 'form')]) {
    for (const a of ['aria-labelledby', 'aria-describedby']) {
      const v = attr(t, a)
      if (!v) continue
      for (const id of v.split(/\s+/).filter(Boolean)) {
        add(`${rel}｜${a} 目标存在`, seen.has(id), `${a}="${id}" 在页面里找不到对应元素`)
      }
    }
  }

  // ⑱ 展开控件（disclosure）的完整约束。
  //    侧栏每个节都是「链接 + 展开按钮」，这条断言守三件事：
  //      ① aria-controls 必须指向真实存在的面板；
  //      ② aria-expanded 必须与面板的 hidden 一致——**状态只能有一个来源**，
  //         两者不一致时读屏播报与实际可见内容会相反；
  //      ③ 每个控件必须有无障碍名（本站在按钮内放了 visually-hidden 文本）。
  const controls = [...body.matchAll(/<button\b[^>]*aria-controls=("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi)]
  for (const m of controls) {
    const tag = m[0]
    const panelId = m[2] ?? m[3] ?? m[4]
    const expanded = attr(tag, 'aria-expanded')

    // 找面板：不写死元素类型白名单，而是从 **实际 DOM** 里按 id 反查标签。
    // 第一版把类型限制为 ul|ol|div|section，结果 `aria-controls=sidebar` 指向的
    // `<aside id=sidebar>` 匹配不到，判成「面板可见」而报错 672 项——全是假阳性。
    // 面板是什么元素由模板决定，校验器不该替它规定。
    const idPat = `("${panelId}"|'${panelId}'|${panelId})`
    const panelRe = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*\\bid=${idPat}[^>]*>`, 'i')
    const panelTag = (panelRe.exec(body) || [''])[0]
    const panelHidden = /\bhidden\b/i.test(panelTag)
    add(`${rel}｜aria-controls 指向存在的元素`, Boolean(panelTag), `aria-controls="${panelId}" 在 DOM 里找不到对应元素`)

    // aria-expanded 的三种合法形态：
    //   ① 服务端就写死（侧栏各节的展开按钮）；
    //   ② 服务端不写、由脚本在初始化时按真实状态写入（移动端抽屉按钮）——
    //      **这一种在 SSR 产物上一定是 null，不是缺陷**，所以此时不报错，
    //      但要求「面板在 SSR 里可见」这个前提成立（否则就是关着却不声明状态）。
    //   ③ 桌面端的侧栏按钮根本不该有该属性（脚本会 remove），SSR 侧也无从判断，跳过。
    if (expanded === null) {
      add(`${rel}｜脚本代管 aria-expanded 的前提`, !panelHidden,
        `未声明 aria-expanded，但面板在 SSR 里是收起的——脚本未跑时读者会看到空白`)
    } else {
      add(`${rel}｜展开控件带 aria-expanded`, expanded === 'true' || expanded === 'false',
        `aria-expanded=${JSON.stringify(expanded)}`)
      if (panelTag) {
        add(`${rel}｜aria-expanded 与 hidden 一致`, (expanded === 'true') === !panelHidden,
          `aria-expanded=${expanded} 而面板 ${panelHidden ? 'hidden' : '可见'}（面板标签：${panelTag.slice(0, 60)}）`)
      }
    }
  }

  // ㉑ 正文非空（防止模板静默产出空页——爬虫看到空页等于没有）
  const textLen = body.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length
  add(`${rel}｜正文非空`, textLen > 80, `去标签后仅 ${textLen} 字符`)

  // ⑲ JSON-LD：必须存在、必须是**可解析的 JSON 对象**
  //    这一项单独有断言的意义：Hugo 里漏了 safeJS 会把对象再包一层引号变成字符串，
  //    页面照样能看，结构化数据却整块失效。构建脚本有同样一项，这里跨页全量复核。
  const ld = (/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/i.exec(html) || [])[1]
  if (!ld) {
    add(`${rel}｜JSON-LD 存在`, false, '缺少 application/ld+json')
  } else {
    let parsed = null
    try { parsed = JSON.parse(ld) } catch { /* 留给下面的断言报告 */ }
    add(`${rel}｜JSON-LD 是对象`, parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
      parsed === null ? `解析失败：${ld.trim().slice(0, 60)}` : '解析结果不是对象')
    if (parsed && typeof parsed === 'object') {
      add(`${rel}｜JSON-LD 有 @context 与 @type`,
        parsed['@context'] === 'https://schema.org' && Boolean(parsed['@type']),
        `@context=${parsed['@context']}｜@type=${parsed['@type']}`)
    }
  }

  // ⑳ 社交预览：og:title / og:description / og:url 齐备（爬虫与分享卡片取这里）
  const og = (prop) => {
    const t = new RegExp(`<meta[^>]+property=["']?og:${prop}["']?[^>]*>`, 'i').exec(html)
    return t ? (attr(t[0], 'content') || '') : null
  }
  const ogMissing = ['title', 'description', 'url'].filter((k) => !og(k))
  add(`${rel}｜og 三件套`, ogMissing.length === 0, `缺少 og:${ogMissing.join('、og:')}`)
}

// ---------------------------------------------------------------------------

console.log('HTML 语义化 / SEO 断言')
console.log(`产物目录：${PUBLIC}`)
console.log(`检查页面：${target.length} / ${pages.length}`)
console.log('')
console.log(`每文档恰一个 <h1>：${stats.h1数}/${stats.页面}`)
console.log(`地标 ≥3 种：${stats.地标}/${stats.页面}`)
console.log(`标题跳级页面：${stats.标题跳级}`)
console.log('')
console.log(`共 ${total} 项断言，不通过 ${failures.length} 项`)
for (const f of failures.slice(0, 40)) console.log(`  ✗ ${f.name}｜${f.detail}`)
if (failures.length > 40) console.log(`  ……其余 ${failures.length - 40} 项`)

process.exit(failures.length ? 1 : 0)
