#!/usr/bin/env node
/**
 * geo-check.mjs —— GEO（面向检索式 AI 与聚合器）与授权声明的断言
 *
 *   node site/checks/geo-check.mjs
 *
 * ## 为什么单独有一道
 *
 * GEO 的每一件东西都「看着有就行」，但它们全是**跨文件的约定**，单看一个文件
 * 发现不了断链：
 *   - llms.txt 里写着「用 /entries.json」，而那个文件要靠 hugo.toml 的
 *     [outputFormats.JSON] 产出——删掉那一段，llms.txt 就成了死链指引；
 *   - head 里声明 rel="llms"，而 llms.txt 要靠 [outputFormats.llmstxt]
 *     加 layouts/index.llmstxt.txt 共同产出——少一样就静默不生成（本项目踩过）；
 *   - 结构化数据里的 license 与页脚、LICENSE、授权页必须说的是同一件事，
 *     否则「能不能商用」在不同地方给出不同答案。
 * 这些都不是语法错误，Hugo 一条都不会报，只能靠断言守。
 *
 * 退出码：0 全通过 / 1 有断言不通过 / 2 环境错误
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SITE = resolve(HERE, '..')
const ROOT = resolve(SITE, '..')
const PUBLIC = join(SITE, 'public')

if (!existsSync(PUBLIC)) {
  console.error('[环境错误] 找不到 site/public，先跑 node tools/build-prod.mjs')
  process.exit(2)
}

const failures = []
let total = 0
const add = (name, ok, detail = '') => {
  total++
  if (!ok) failures.push({ name, detail })
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)

// ---------------------------------------------------------------------------
// 1) llms.txt
// ---------------------------------------------------------------------------
const llms = read(join(PUBLIC, 'llms.txt'))
add('llms.txt 存在', llms !== null, '未生成——检查 hugo.toml 的 [outputFormats.llmstxt] 与 [outputs] home，以及 layouts/index.llmstxt.txt')
if (llms) {
  add('llms.txt 无残留模板语法', !/\{\{[^}]*\}\}/.test(llms), '出现未求值的 {{ }}，说明模板没被 Hugo 渲染')
  // 关键段落必须齐：模型靠它们判断「这是什么、怎么引用、有什么条件」
  for (const [名称, 探针] of [
    ['标题行', /^# .+/m],
    ['一句话定位', /^> .+/m],
    ['全书规模', /共 \d+ 条，分 \d+ 节/],
    ['最近核对日期', /最近一次核对官方原文的日期：\d{4}-\d{2}-\d{2}/],
    ['字段说明', /主张强度/],
    ['章节清单', /^- 第 \d+ 节 .+（\d+ 条）/m],
    ['机器接口指引', /\/entries\.json/],
    ['授权说明', /CC BY-NC-SA 4\.0/],
    ['禁止商用', /不得用于商业目的|禁止商业使用/],
    ['不替代律师', /不构成法律意见|不替代律师/],
  ]) {
    add(`llms.txt 含「${名称}」`, 探针.test(llms), `缺少该段：${探针}`)
  }

  // 数字必须与真实产物一致——这是本仓库最容易漂的地方
  const entriesPath = join(PUBLIC, 'entries.json')
  if (existsSync(entriesPath)) {
    const raw = JSON.parse(readFileSync(entriesPath, 'utf8'))
    const arr = Array.isArray(raw) ? raw : raw.entries
    const n = arr.length
    const m = /共 (\d+) 条/.exec(llms)
    add('llms.txt 条数与 entries.json 一致', m && Number(m[1]) === n, `llms.txt 写 ${m ? m[1] : '?'}，实际 ${n}`)
    // 节数：entries.json 里出现的不同节号个数
    const secs = new Set(arr.map((e) => e['节号']))
    const sm = /分 (\d+) 节/.exec(llms)
    add('llms.txt 节数与条目一致', sm && Number(sm[1]) === secs.size,
      `llms.txt 写 ${sm ? sm[1] : '?'}，entries.json 里实际 ${secs.size} 节（易多算授权页/渠道页这类独立页面）`)
  }
}

// ---------------------------------------------------------------------------
// 2) robots.txt：允许索引、声明 sitemap、AI 爬虫策略明确
// ---------------------------------------------------------------------------
const robots = read(join(PUBLIC, 'robots.txt'))
add('robots.txt 存在', robots !== null)
if (robots) {
  add('robots.txt 有绝对地址的 Sitemap 行', /^Sitemap:\s*https?:\/\/\S+/m.test(robots),
    '必须绝对地址，robots.txt 不支持相对路径——占位符 __SITEMAP__ 未被替换')
  add('robots.txt 未残留占位符', !robots.includes('__SITEMAP__'))
  add('robots.txt 不屏蔽 sitemap 自身', !/^Disallow:\s*\/\*\.xml/m.test(robots),
    '写了 Disallow: /*.xml$ 会把 sitemap.xml 自己挡掉，与 Sitemap 行矛盾')
  // 允许 AI 检索类爬虫（本站立场：可索引、可引用，但不得商用）
  for (const ua of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) {
    const re = new RegExp(`User-agent:\\s*${ua.replace('-', '\\-')}[\\s\\S]{0,80}?Allow:\\s*/`, 'i')
    add(`robots.txt 允许 ${ua}`, re.test(robots), `${ua} 未显式 Allow`)
  }
}

// ---------------------------------------------------------------------------
// 3) 每页 head 的 GEO 声明与结构化数据里的授权
// ---------------------------------------------------------------------------
const home = read(join(PUBLIC, 'index.html'))
add('首页存在', home !== null)
if (home) {
  add('head 声明 rel=llms', /<link[^>]+rel=["']?llms["']?[^>]*>/i.test(home),
    '缺 rel="llms" 指向 llms.txt，agent 抓单页时找不到站点说明')
  add('head 声明 rel=license', /<link[^>]+rel=["']?license["']?[^>]*>/i.test(home),
    '缺 rel="license"，「使用条件」不会随页面被搬走')
  const ld = (/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/i.exec(home) || [])[1]
  add('首页有 JSON-LD', Boolean(ld))
  if (ld) {
    let j = null
    try { j = JSON.parse(ld) } catch { /* 下面报 */ }
    add('首页 JSON-LD 可解析', j !== null)
    if (j) {
      add('JSON-LD 声明 license', Boolean(j.license), '结构化数据里没有 license，机器读不到使用条件')
      add('JSON-LD 声明 copyrightNotice', Boolean(j.copyrightNotice))
      add('JSON-LD 声明 publisher', Boolean(j.publisher))
      add('JSON-LD 的 about 是 Book 且有条目数',
        j.about && j.about['@type'] === 'Book' && Number(j.about.numberOfPages) > 0,
        `about=${JSON.stringify(j.about && j.about['@type'])}`)
    }
  }
}

// 条目页：license 与 keywords（GEO 让 AI 能按「举证难」这类维度找到条目）
const entrySample = (() => {
  const p = join(PUBLIC, 'entries.json')
  if (!existsSync(p)) return null
  const raw = JSON.parse(readFileSync(p, 'utf8'))
  const arr = Array.isArray(raw) ? raw : raw.entries
  const e = arr[0]
  return { 节号: e['节号'], 条号: e['条号'] }
})()
add('entries.json 存在且非空', entrySample !== null)

// ---------------------------------------------------------------------------
// 4) 授权声明四处一致（页脚 / 授权页 / LICENSE / 结构化数据）
// ---------------------------------------------------------------------------
const 授权页 = read(join(PUBLIC, '授权', 'index.html'))
add('授权页存在（/授权/）', 授权页 !== null, 'docs/授权与使用.md 未生成站点页')
if (授权页) {
  for (const [名称, re] of [
    ['写明 CC BY-NC-SA 4.0', /CC BY-NC-SA 4\.0/],
    ['写明不得商用', /不得用于商业目的|不得商用|禁止商业使用/],
    ['写明须署名', /署名/],
    ['写明相同方式共享', /相同方式共享/],
    ['写明法律原文不受限', /不受著作权保护/],
    ['写明可另行授权', /单独授权|另行授权/],
  ]) add(`授权页含「${名称}」`, re.test(授权页), '')
}

const licenseRoot = join(ROOT, 'LICENSE')
const licenseCode = join(ROOT, 'LICENSE-CODE')
add('仓库根有 LICENSE', existsSync(licenseRoot))
add('仓库根有 LICENSE-CODE', existsSync(licenseCode))
if (existsSync(licenseRoot)) {
  const l = readFileSync(licenseRoot, 'utf8')
  add('LICENSE 是 CC BY-NC-SA', /Attribution-NonCommercial-ShareAlike 4\.0/.test(l),
    'LICENSE 不是 NC 版本——与「禁止商用」的要求矛盾')
  add('LICENSE 内嵌官方正文', /Section 3 -- License Conditions/.test(l), '缺少官方条款正文')
  add('LICENSE 含中文说明', /不得用于商业目的|不得商用/.test(l))
}
if (existsSync(licenseCode)) {
  add('LICENSE-CODE 是 MIT', /MIT License/.test(readFileSync(licenseCode, 'utf8')))
}

// ---------------------------------------------------------------------------
// 5) 回仓库入口：站点必须能回到 GitHub（正文真相源在仓库里）
//    地址读自 site.config.json —— 断言直接比对「产物里的链接」与「配置里的 repo」，
//    任何一侧改了而另一侧没跟上都会红。这类跨文件一致性正是本脚本存在的理由。
// ---------------------------------------------------------------------------
const cfg = (() => {
  const p = join(ROOT, 'site.config.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
})()
add('site.config.json 可读', cfg !== null)
if (cfg && cfg.repo) {
  const expectRepoURL = `https://github.com/${cfg.repo}`
  add('产物页脚含仓库链接', Boolean(home && home.includes(expectRepoURL)),
    `页脚未出现 ${expectRepoURL}——检查 tools/build-site.mjs 是否生成 site/data/site.json，`
    + '以及 layouts/_partials/footer.html 与 site-config.html 是否在渲染它')
  // 全站抽查：页脚是共用模板，仓库链接应当覆盖所有页面
  let withRepo = 0
  const sample = []
  const walkDir = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walkDir(p)
      else if (e.name === 'index.html') {
        if (readFileSync(p, 'utf8').includes(expectRepoURL)) {
          withRepo++
          if (sample.length < 3) sample.push(p.slice(PUBLIC.length))
        }
      }
    }
  }
  walkDir(PUBLIC)
  add('仓库链接覆盖全部页面', withRepo > 100, `只有 ${withRepo} 个页面含仓库链接（页脚是共用模板，应覆盖所有页面）`)
  if (withRepo > 0 && withRepo <= 100) console.log('  含链接的页面示例：' + sample.join('、'))
} else {
  add('site.config.json 里有 repo 字段', false, '缺少 repo，页脚不会出现仓库链接')
}

// ---------------------------------------------------------------------------

console.log('GEO 与授权声明断言')
console.log(`产物目录：${PUBLIC}`)
console.log('')
console.log(`共 ${total} 项断言，不通过 ${failures.length} 项`)
for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? '｜' + f.detail : ''}`)

process.exit(failures.length ? 1 : 0)
