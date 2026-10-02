#!/usr/bin/env node
// 生产构建站点，并在构建后校验产物是「生产形态」而不是「开发服务器形态」。
//
//   node tools/build-prod.mjs
//
// 为什么需要这个脚本：`hugo server -D` 会把开发版产物写进同一个 public/ ——
// 带 livereload 脚本、localhost 的 canonical、noindex 标记、未指纹化的样式。
// 本仓库在做验收时就撞到过一次：验收构建刚跑完，一个仍在后台的 server 把它
// 覆盖成了开发版，红的是 render-check 的三项断言（样式不是本站指纹文件、
// 脚本不是本站指纹文件、robots 不是 index,follow），看起来像代码缺陷，
// 实际是并发写者。本脚本把「构建」与「构建方式校验」绑在一条命令里，
// 并在构建前拒绝在有 server 在跑的情况下动手。所有工具里只有这一个写入
// site/public/，其余一律写临时目录。

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SITE = join(ROOT, 'site')
const PUBLIC = join(SITE, 'public')

/** 发布地址从仓库根的 site.config.json 读，不再在各脚本里各写一份。
 * 换域名只改那一个文件（或用 WRC_BASE_URL 临时覆盖）——此前域名散落在
 * build-prod / build-pdf / verify-pdf 三个脚本里，改名时漏掉一处就会让
 * canonical 指向 404，已经发生过一次。 */
function publishUrl() {
  if (process.env.WRC_BASE_URL) return process.env.WRC_BASE_URL
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'))
    if (cfg.publishUrl) return cfg.publishUrl
  } catch (e) {
    console.error(`[警告] 读不到 site.config.json（${e.message}），退回默认发布地址`)
  }
  return 'https://hencter.github.io/workers-ledger/'
}
const BASE = publishUrl()

const fail = (msg) => { console.error(`[失败] ${msg}`); process.exit(1) }

if (!existsSync(join(SITE, 'hugo.toml'))) fail(`找不到站点配置：${SITE}`)

// 一、先看有没有并发的开发服务器。它才是 public/ 被污染的根源。
let running = []
try {
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='hugo.exe'\" | Select-Object -ExpandProperty CommandLine) -join \"`n\"",
  ], { encoding: 'utf8' })
  if (ps.status === 0 && ps.stdout) {
    running = ps.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /server/.test(s))
  }
} catch { /* 拿不到进程列表时不阻断，继续走产物校验那道防线 */ }

if (running.length) {
  console.error('检测到正在运行的 hugo server，它会与本次构建抢同一个 public/：')
  for (const r of running) console.error(`  ${r}`)
  fail('请先停掉服务器，或改用 `hugo server -D --renderToMemory`（不写 public/）')
}

// 二、干净构建。清掉可能残留的开发版产物，避免旧文件混进校验。
if (existsSync(PUBLIC)) rmSync(PUBLIC, { recursive: true, force: true })

const args = ['--minify', '--baseURL', BASE]
const r = spawnSync('hugo', args, {
  cwd: SITE,
  encoding: 'utf8',
  stdio: 'inherit',
  env: { ...process.env, HUGO_ENVIRONMENT: 'production', HUGO_ENV: 'production' },
})
if (r.error) fail(`无法执行 hugo：${r.error.message}`)
if (r.status !== 0) fail(`hugo 构建失败，退出码 ${r.status}`)

// 三、修正 robots.txt 里的 sitemap 地址。
//
// 静态文件里没法知道部署域名，`site/static/robots.txt` 只能写占位符 `__SITEMAP__`；
// 而 robots.txt **不支持相对路径**，必须给绝对地址——不替换的话爬虫看到的是一行无效声明，
// 等于没声明站点地图。sitemap 由 Hugo 生成在 public/sitemap.xml，所以这一步必须
// 在生产构建**之后**做（这也是它放在本脚本而不是 build-site.mjs 的原因：public/ 每次重建）。
{
  const robotsPath = join(PUBLIC, 'robots.txt')
  const sitemapPath = join(PUBLIC, 'sitemap.xml')
  if (!existsSync(robotsPath)) {
    fail('构建后找不到 public/robots.txt（site/static/robots.txt 应在构建时被复制过来）')
  }
  const robots = readFileSync(robotsPath, 'utf8')
  if (robots.includes('__SITEMAP__')) {
    if (!existsSync(sitemapPath)) fail('robots.txt 需要 sitemap 地址，但构建后没有 public/sitemap.xml')
    const sitemapUrl = `${BASE.replace(/\/$/, '')}/sitemap.xml`
    writeFileSync(robotsPath, robots.replaceAll('__SITEMAP__', sitemapUrl), 'utf8')
    console.log(`robots.txt：sitemap 地址已补为 ${sitemapUrl}`)
  } else if (!/^Sitemap:\s*https?:\/\//m.test(robots)) {
    fail('robots.txt 里既没有 __SITEMAP__ 占位符，也没有绝对地址的 Sitemap 行')
  } else {
    console.log('robots.txt：sitemap 地址已是绝对地址')
  }
}

// 四、校验产物形态。这三项正是被开发服务器覆盖时会最先红掉的。
const home = join(PUBLIC, 'index.html')
if (!existsSync(home)) fail(`构建后找不到 ${home}`)
const html = readFileSync(home, 'utf8')

const checks = [
  ['产物不含 livereload（开发服务器注入）', !/livereload/.test(html)],
  ['样式引用本站指纹文件', /<link[^>]*stylesheet[^>]*href=[^>]*\/css\/main\.[0-9a-f]{8,}\.css/.test(html)],
  ['脚本引用本站指纹文件', /<script[^>]*src=[^>]*\/js\/main\.[0-9a-f]{8,}\.js/.test(html)],
  ['robots 为 index, follow（生产环境）', /<meta name=robots content="index, follow"/.test(html)],
  ['canonical 用给定的绝对地址', html.includes(`<link rel=canonical href=${BASE}`)],
  ['JSON-LD 是 JSON 对象而非字符串', /<script type=application\/ld\+json>\s*\{/.test(html)],
]

let bad = 0
for (const [name, ok] of checks) {
  if (!ok) bad++
  console.log(`  ${ok ? '通过' : '不通过'}｜${name}`)
}

if (bad) fail(`产物形态校验不通过 ${bad} 项——public/ 很可能被开发服务器覆盖过`)

console.log(`\n生产构建完成：${PUBLIC}`)
console.log(`  baseURL：${BASE}`)
console.log('  产物形态 6 项全部通过')
console.log('  下一步：cd site && node checks/render-check.mjs（渲染断言）')
