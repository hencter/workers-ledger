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
// public/，其余一律写临时目录。

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishUrl } from './lib/发布地址.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
// 仓库根就是 Hugo 项目根：站点配置、主题、static 都在仓库根。
const PUBLIC = join(ROOT, 'public')

// 发布地址的唯一读取入口在 tools/lib/发布地址.mjs（读 hugo.toml 的 baseURL）。
// 2026-10-04 起 site.config.json 已并入 hugo.toml；此前四个脚本各写一份读法，
// 换域名漏一处就让 canonical 指向 404——已经发生过一次。
const BASE = publishUrl()

const fail = (msg) => { console.error(`[失败] ${msg}`); process.exit(1) }

if (!existsSync(join(ROOT, 'hugo.toml'))) fail(`找不到站点配置：${join(ROOT, 'hugo.toml')}`)

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
  cwd: ROOT,
  encoding: 'utf8',
  stdio: 'inherit',
  env: { ...process.env, HUGO_ENVIRONMENT: 'production', HUGO_ENV: 'production' },
})
if (r.error) fail(`无法执行 hugo：${r.error.message}`)
if (r.status !== 0) fail(`hugo 构建失败，退出码 ${r.status}`)

// 三、兜底修正 robots.txt 里的 sitemap 地址。
//
// **正常情况下这一步什么都不做。** robots.txt 现在是 Hugo 模板
// （themes/ledger/layouts/robots.txt），末尾用 `{{ "sitemap.xml" | absURL }}`
// 在构建时就渲染成绝对地址——换 baseURL 跟着变，且**不依赖 Node**。
// 这一点对 EdgeOne 是决定性的：它的构建环境只保证有 Hugo（见 .gitignore 的说明），
// 而旧的「占位符 + 构建后替换」方案要求有 Node，于是线上长期留着未替换的 `__SITEMAP__`，
// 等于没有声明站点地图。
//
// 保留下面这段替换，只为兼容「模板里又出现占位符」的情况：robots.txt **不支持相对路径**，
// 一旦留下占位符，爬虫看到的就是一行无效声明。sitemap 由 Hugo 生成在 public/sitemap.xml，
// 所以这项检查必须在生产构建**之后**做（这也是它在 build-prod 而非 build-site 的原因：
// public/ 每次重建）。
{
  const robotsPath = join(PUBLIC, 'robots.txt')
  const sitemapPath = join(PUBLIC, 'sitemap.xml')
  if (!existsSync(robotsPath)) {
    fail('构建后找不到 public/robots.txt（static/robots.txt 应在构建时被复制过来）')
  }
  const robots = readFileSync(robotsPath, 'utf8')
  // 只认「整行就是 `Sitemap:` + 占位符」这一种形态，不用 includes()/replaceAll()。
  // 为什么：注释里一旦提到那个占位符的名字，字符串替换会把它一起改写。
  // 2026-10-03 实际发生过——robots.txt 的新注释里写了那个名字，
  // 于是产物里那句注释被换成了一行带域名的乱码，而校验全绿（谁都测不到注释）。
  const PLACEHOLDER = /^Sitemap:\s*__SITEMAP__[ \t]*$/m
  if (PLACEHOLDER.test(robots)) {
    if (!existsSync(sitemapPath)) fail('robots.txt 需要 sitemap 地址，但构建后没有 public/sitemap.xml')
    const sitemapUrl = `${BASE.replace(/\/$/, '')}/sitemap.xml`
    writeFileSync(robotsPath, robots.replace(PLACEHOLDER, `Sitemap: ${sitemapUrl}`), 'utf8')
    console.log(`robots.txt：sitemap 地址已补为 ${sitemapUrl}`)
  } else if (!/^Sitemap:\s*https?:\/\//m.test(robots)) {
    fail('robots.txt 里既没有 Sitemap 占位符行，也没有绝对地址的 Sitemap 行')
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
console.log('  下一步：node tools/checks/render-check.mjs（渲染断言）')
