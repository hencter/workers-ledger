#!/usr/bin/env node
/**
 * 体检.mjs —— 一条命令跑完内容侧的全部校验与构建
 *
 *   node tools/体检.mjs              跑「快」档：结构 + 来源引用 + 脱敏 + 生成 + 哨兵
 *   node tools/体检.mjs --full       再跑生产构建与渲染断言（需要 Hugo，较慢）
 *   node tools/体检.mjs --site       只跑站点侧：生成 + 哨兵 + 生产构建 + 渲染断言
 *   node tools/体检.mjs --content    只跑内容侧：结构 + 来源引用 + 脱敏
 *   node tools/体检.mjs --list       只列出会跑哪些步骤，不执行
 *   node tools/体检.mjs --only 结构,脱敏   只跑指定步骤（用步骤名子串匹配）
 *
 * 为什么需要它：本仓库的门禁散在多个脚本与三个 GitHub workflow 里——
 * check-items、check-refs、check-desensitize、check-sources、build-site、
 * check-site、build-prod、render-check。一次改完正文，跑漏一个就会出现
 * 「本机通过、CI 红」或更糟的「本地看着没问题，站点是旧的」。
 *
 * 与 build-prod.mjs 的既有约定保持一致：**site/public/ 只能有一个写者**。
 * 所以本脚本会先探测有没有 hugo server 在跑，有就跳过生产构建并说明原因，
 * 而不是硬上把产物搞脏（这个坑本仓库撞过一次，见 AGENTS.md）。
 *
 * 只使用 Node 24 内置模块，零依赖。
 *
 * 退出码：0 全绿 / 1 有失败 / 2 环境错误
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const ROOT = resolve(argOf('--root', resolve(HERE, '..')))

const MODE = has('--full') ? 'full' : has('--site') ? 'site' : has('--content') ? 'content' : 'fast'
const LIST_ONLY = has('--list')
const ONLY = argOf('--only', '').split(',').map((s) => s.trim()).filter(Boolean)

/**
 * 步骤定义。skip 返回一个字符串表示「跳过并说明原因」，返回 null 表示该跑。
 * 顺序即依赖顺序：生成必须在哨兵之前，哨兵必须在生产构建之前。
 */
const STEPS = [
  {
    name: '结构校验',
    cmd: ['node', ['tools/check-items.mjs', '--check']],
    why: '字段缺失、枚举非法、编号跳号、核对日期过期——正文的格式门禁',
  },
  {
    name: '来源引用',
    cmd: ['node', ['tools/check-refs.mjs', '--check']],
    why: '正文「依据」引用的法规必须在 sources/法规清单.md 登记，且版本不落后',
    skip: () => (existsSync(join(ROOT, 'tools', 'check-refs.mjs'))
      ? null
      : 'tools/check-refs.mjs 尚不存在（由 refs-checker 交付中）'),
  },
  {
    name: '脱敏扫描',
    cmd: ['node', ['tools/check-desensitize.mjs', '--check']],
    why: '不写真实姓名、身份证号、手机号、邮箱、具体工作单位——违反即不得提交',
  },
  {
    name: '生成站点内容',
    cmd: ['node', ['tools/build-site.mjs']],
    why: 'book/ → site/content/ + site/data/entries.json（唯一真相源的单向生成）',
    site: true,
  },
  {
    name: '生成物对账',
    cmd: ['node', ['tools/check-site.mjs']],
    why: '独立重解析正文，与索引逐字段比对；同时检查提交的生成物与 book/ 是否同步',
    site: true,
  },
  {
    name: '生产构建',
    cmd: ['node', ['tools/build-prod.mjs']],
    why: '写 site/public/ 并在同一条命令里校验产物是生产形态（6 项断言）',
    site: true,
    full: true,
    skip: () => {
      const running = hugoServers()
      return running.length ? `检测到 hugo server 在跑，而 site/public/ 只能有一个写者：\n    ${running.join('\n    ')}` : null
    },
  },
  {
    name: '渲染断言',
    cmd: ['node', ['site/checks/render-check.mjs']],
    why: '渲染断言：模板分档、前端筛选、每条 url 都能落到真实产物（数量以脚本输出为准）',
    site: true,
    full: true,
  },
  {
    name: '语义与 SEO 断言',
    cmd: ['node', ['site/checks/semantic-check.mjs']],
    why: 'HTML 语义化 / 无障碍 / SEO：每页恰一个 h1、标题不跳级、地标齐全、JSON-LD 是对象、展开控件的 aria 与 hidden 一致',
    site: true,
    full: true,
  },
  {
    name: 'GEO 与授权断言',
    cmd: ['node', ['site/checks/geo-check.mjs']],
    why: 'llms.txt 与数字一致、robots 允许检索爬虫并声明 sitemap、head 声明 rel=llms/license、结构化数据带 license、授权声明四处一致（页脚/授权页/LICENSE/LICENSE-CODE）',
    site: true,
    full: true,
  },
]

/** 探测在跑的 hugo server。拿不到进程列表时返回空数组，不阻断。 */
function hugoServers() {
  try {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='hugo.exe'\" | Select-Object -ExpandProperty CommandLine) -join \"`n\"",
    ], { encoding: 'utf8' })
    if (ps.status === 0 && ps.stdout) {
      return ps.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /server/.test(s))
    }
  } catch { /* 探测失败不阻断 */ }
  return []
}

// ---------------------------------------------------------------------------
// 选择要跑的步骤
// ---------------------------------------------------------------------------

function wanted(step, index) {
  if (ONLY.length) return ONLY.some((o) => step.name.includes(o))
  if (MODE === 'site') return Boolean(step.site)
  if (MODE === 'content') return !step.site
  if (MODE === 'full') return true
  // fast：内容侧全部 + 站点侧的生成与对账，不含需要 Hugo 的构建与渲染
  return !step.full
}

const selected = STEPS.map((s, i) => ({ ...s, index: i })).filter(wanted)

if (!selected.length) {
  console.error(`[环境错误] 没有匹配的步骤（--only ${ONLY.join(',')}）`)
  console.error(`可用步骤：${STEPS.map((s) => s.name).join('、')}`)
  process.exit(2)
}

const LABEL = { fast: '快档（内容 + 生成 + 对账）', full: '全量（含生产构建与渲染断言）', site: '仅站点侧', content: '仅内容侧' }

console.log('《劳动者的账本》体检')
console.log(`仓库根：${ROOT}`)
console.log(`档位：${LIST_ONLY ? '仅列出' : LABEL[MODE]}${ONLY.length ? `　--only ${ONLY.join(',')}` : ''}`)
console.log('')
console.log(`将按顺序执行 ${selected.length} 个步骤：`)
for (const s of selected) {
  const skip = s.skip ? s.skip() : null
  console.log(`  ${skip ? '跳过' : '  →'} ${s.name}　${s.cmd[0]} ${s.cmd[1].join(' ')}`)
  console.log(`      ${s.why}`)
  if (skip) console.log(`      跳过原因：${skip}`)
}
if (LIST_ONLY) process.exit(0)

if (!existsSync(join(ROOT, 'book'))) {
  console.error(`\n[环境错误] 找不到正文目录：${join(ROOT, 'book')}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const results = []
for (const s of selected) {
  const skip = s.skip ? s.skip() : null
  console.log('')
  console.log('─'.repeat(72))
  if (skip) {
    console.log(`⏭  跳过　${s.name}`)
    console.log(`   ${skip}`)
    results.push({ name: s.name, status: 'skip', reason: skip })
    continue
  }
  console.log(`▶  ${s.name}　　${s.cmd[0]} ${s.cmd[1].join(' ')}`)
  console.log('─'.repeat(72))
  const started = Date.now()
  const r = spawnSync(s.cmd[0], s.cmd[1], { cwd: ROOT, stdio: 'inherit', encoding: 'utf8' })
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  if (r.error) {
    console.log(`✗  ${s.name}　无法执行：${r.error.message}（${secs}s）`)
    results.push({ name: s.name, status: 'fail', detail: r.error.message })
    break
  }
  if (r.status !== 0) {
    console.log(`✗  ${s.name}　退出码 ${r.status}（${secs}s）`)
    results.push({ name: s.name, status: 'fail', detail: `退出码 ${r.status}` })
    // 一步失败就停：后面的步骤依赖前面的结果，继续跑只会刷屏
    break
  }
  console.log(`✓  ${s.name}（${secs}s）`)
  results.push({ name: s.name, status: 'ok' })
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log('')
console.log('═'.repeat(72))
console.log('体检汇总')
for (const r of results) {
  const mark = r.status === 'ok' ? '✓' : r.status === 'skip' ? '⏭' : '✗'
  console.log(`  ${mark} ${r.name}${r.status === 'skip' ? '（跳过）' : r.status === 'fail' ? `　失败：${r.detail}` : ''}`)
}
const notRun = selected.filter((s) => !results.some((r) => r.name === s.name))
for (const s of notRun) console.log(`  · ${s.name}（未执行：前一步失败）`)

const failed = results.find((r) => r.status === 'fail')
const skipped = results.filter((r) => r.status === 'skip')

if (failed) {
  console.log('')
  console.error(`[失败] 在「${failed.name}」停了：${failed.detail}`)
  console.error('后面的步骤没有执行——它们依赖这一步的结果，跑下去只会给出误导性的结论。')
  process.exit(1)
}

if (skipped.length) {
  console.log('')
  console.log(`[注意] 有 ${skipped.length} 个步骤被跳过，本次体检**不构成全绿结论**：`)
  for (const s of skipped) console.log(`  - ${s.name}：${s.reason.split('\n')[0]}`)
  console.log('站点这一侧的验收顺序是定死的：build-site → check-site → build-prod → render-check，四步全绿才算通过。')
  process.exit(0)
}

console.log('')
console.log(MODE === 'full' || MODE === 'site'
  ? '[通过] 站点侧四步全部通过。'
  : '[通过] 内容侧与生成对账全部通过。要跑生产构建与渲染断言，加 --full。')
process.exit(0)
