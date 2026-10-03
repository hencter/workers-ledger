// 发布地址的唯一读取入口：取 hugo.toml 的 baseURL。
//
// ## 为什么要有这个模块
//
// 此前 `publishUrl` 在 build-prod / check-hugo-strict / build-pdf / verify-pdf 四个脚本里
// 各写一份「读 site.config.json」。换域名时漏掉一处，canonical 就会指向 404——本仓库
// 已经真的发生过一次。2026-10-04 起 site.config.json 已删除、配置并进 hugo.toml，
// 读取也收拢到这一个文件：**改域名只改 hugo.toml 的 baseURL 一行**。
//
// ## 取值顺序
//
//   1. 环境变量 WRC_BASE_URL —— 临时覆盖（本地预览、CI 想换地址时用）
//   2. `hugo config --format json` 的 baseurl —— Node 不必自己解析 TOML，
//      也不会与 Hugo 的解析规则漂移
//   3. 兜底常量 —— 仅当 hugo 不可用时。值是**真实域名**，
//      不是按仓库名推导出来的错误地址（那正是要避免的东西）
//
// 只使用 Node 24 内置模块，零依赖。

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根。本文件在 tools/lib/ 下，所以是上两级。 */
export const ROOT = resolve(HERE, '..', '..')

/** 兜底发布地址。只在 hugo 不可用时用到——换域名时**必须**同时改 hugo.toml 与这里的关系：
 *  这里只是「hugo 跑不起来时别把 canonical 写成错地址」的保险，不作为真相源。 */
const FALLBACK = 'https://workersledger.cn/'

/** 读 hugo.toml 的完整配置；读不到返回 null（不抛异常，调用方自己决定怎么退）。 */
export function hugoConfig() {
  const r = spawnSync('hugo', ['config', '--format', 'json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error || r.status !== 0 || !r.stdout) return null
  try { return JSON.parse(r.stdout) } catch { return null }
}

/** 发布地址（baseURL）。任何脚本要拼接绝对地址都应调它，不要再自己读配置文件。 */
export function publishUrl() {
  if (process.env.WRC_BASE_URL) return process.env.WRC_BASE_URL
  const cfg = hugoConfig()
  const base = cfg && (cfg.baseurl || cfg.baseURL)
  if (base) return base
  console.error(`[警告] 读不到 hugo.toml 的 baseURL（hugo config 失败），退回兜底地址 ${FALLBACK}`)
  return FALLBACK
}
