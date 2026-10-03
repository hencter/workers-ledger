#!/usr/bin/env node
/**
 * check-hugo-strict.mjs —— 严格构建：把任何 WARN 当作失败
 *
 *   node tools/check-hugo-strict.mjs
 *
 * 为什么需要它：Hugo 对「死模板」「重复目标路径」「缺翻译键」这些只打招呼、不失败，
 * 而它们恰好是重构之后最容易留下的垃圾——模板删了引用、节改名后旧布局没删、
 * 主题换版留下没人用的 partial。默认构建全绿，这些东西就永远没人发现。
 *
 * ## 为什么不用 Hugo 自带的 --panicOnWarning（实测，2026-10-03）
 *
 * 1. 它本身有效：在一个被引用的 partial 里放 `{{ warnf "…" }}`，
 *    加 `--panicOnWarning` 后退出码 1（`error calling warnf: …`），不加则退出码 0。
 * 2. **但它与 `--printUnusedTemplates` 互斥**：两者同时使用时，「有死模板」这件事
 *    发生在构建收尾的 printUnusedTemplatesOnce 里，WARN 被 panicOnWarning 的处理函数
 *    升级成 Go 崩溃——退出码 2，输出是一大段 goroutine 栈，既不可读，
 *    也看不出是哪个模板有问题。
 * 3. 所以这里自己判定：跑一次普通构建，把 `WARN ` 行收上来当失败。
 *    语义与 panicOnWarning 相同，但能逐条列出问题、且不会崩。
 *
 * ## 边界
 *
 * 只写 `.tmp-strict/`，**从不写 public/**。因此即使有 hugo server 在跑
 * （那种情况下 build-prod.mjs 会拒绝构建），这一步照样能跑——它是最早能发现问题的一步。
 *
 * 退出码：0 全绿 / 1 有 WARN 或构建失败 / 2 环境错误
 */

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishUrl } from './lib/发布地址.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(ROOT, '.tmp-strict')

// 发布地址的唯一读取入口在 tools/lib/发布地址.mjs（读 hugo.toml 的 baseURL）。
const BASE = publishUrl()

const fail = (msg, code = 1) => {
  console.error(`\n[失败] ${msg}`)
  process.exit(code)
}

if (!existsSync(join(ROOT, 'hugo.toml'))) fail(`找不到站点配置：${join(ROOT, 'hugo.toml')}`, 2)

rmSync(OUT, { recursive: true, force: true })

const args = [
  '--minify',
  '--baseURL', BASE,
  '--destination', OUT,
  '--ignoreCache',           // 冷构建：不借上一次的缓存，避免「只在有缓存时通过」
  '--printPathWarnings',     // 两个页面写到同一个目标路径
  '--printUnusedTemplates',  // 没有任何页面用到的模板
  '--printI18nWarnings',     // 缺翻译键
]

let r
try {
  r = spawnSync('hugo', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HUGO_ENVIRONMENT: 'production', HUGO_ENV: 'production' },
    maxBuffer: 128 * 1024 * 1024,
  })
} finally {
  // 产物只是证据，不留着；站点产物由 build-prod.mjs 负责写到 public/
  // （这里先不删，下面读取统计后再删）
}

if (r.error) fail(`无法执行 hugo：${r.error.message}`, 2)

const output = `${r.stdout || ''}${r.stderr || ''}`
const lines = output.split(/\r?\n/)

/** 版本行单独拎出来：本仓库踩过「只看模板报错、误判成模板写错了」的坑（见
 *  docs/核实记录/部署-EdgeOne版本坑.md 第一节「先看版本行」）。 */
const versionLine = lines.find((l) => /^hugo v\d/.test(l.trim())) || '(未识别到版本行)'
const pagesLine = lines.find((l) => /Pages\s*│/.test(l)) || '(未识别到页数)'
const warns = lines.filter((l) => /(^|\s)WARN(\s|$)/.test(l))
const errors = lines.filter((l) => /(^|\s)ERROR(\s|$)/.test(l))

const built = existsSync(join(OUT, 'index.html'))
rmSync(OUT, { recursive: true, force: true })

console.log('Hugo 严格构建 —— 把任何 WARN 当失败')
console.log(`仓库根：${ROOT}`)
console.log(`发布地址：${BASE}`)
console.log(`版本：${versionLine.trim()}`)
console.log(`${pagesLine.trim()}`)
console.log('')

if (r.status !== 0) {
  console.error(`hugo 退出码 ${r.status}。错误行：`)
  for (const l of (errors.length ? errors : lines).slice(0, 15)) console.error(`  ${l.trim()}`)
  if (!built) console.error('  产物不含 index.html —— 构建没有产出可用站点。')
  fail('严格构建失败（构建本身出错，先修上面这些）。')
}

if (!built) {
  fail('hugo 退出码 0，但产物里没有 index.html —— 构建结果不可信，按失败处理。')
}

if (warns.length) {
  console.error(`发现 ${warns.length} 条 WARN（严格模式下每一条都算失败）：`)
  for (const w of warns) console.error(`  ${w.trim()}`)
  const unused = warns
    .map((w) => /WARN\s+Template\s+(\S+)\s+is unused/.exec(w))
    .filter(Boolean)
    .map((m) => m[1])
  if (unused.length) {
    console.error('')
    console.error(`其中 ${unused.length} 个模板没有任何引用（删掉它们，或补上引用）：`)
    for (const t of unused) console.error(`  ${t}`)
  }
  fail(`严格构建不通过：${warns.length} 条 WARN。`)
}

console.log('[通过] 严格构建无任何 WARN：没有死模板、没有目标路径冲突、没有缺翻译键。')
process.exit(0)
