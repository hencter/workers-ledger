/* 「待复核」标记：核对日期超过阈值就弱化并提示。
   阈值取自 <html data-stale-days>，默认 180 天（仓库约定值，见 docs/条目规范.md）。
   纯函数 isStale 与 DOM 部分分开，便于在无浏览器环境下单测。 */

export const DEFAULT_STALE_DAYS = 180

/** 判断一个核对日期是否已经超过复核周期 */
export function isStale(isoDate, staleDays = DEFAULT_STALE_DAYS, now = new Date()) {
  if (!isoDate) return false
  const t = Date.parse(String(isoDate).length <= 10 ? `${isoDate}T00:00:00` : isoDate)
  if (Number.isNaN(t)) return false
  const days = (now.getTime() - t) / 86400000
  return days > staleDays
}

/** 距今多少天（整数，未来为负数） */
export function daysSince(isoDate, now = new Date()) {
  const t = Date.parse(String(isoDate).length <= 10 ? `${isoDate}T00:00:00` : isoDate)
  if (Number.isNaN(t)) return null
  return Math.floor((now.getTime() - t) / 86400000)
}

export function applyStale(root = document) {
  const host = root.documentElement || document.documentElement
  const staleDays = Number(host.dataset.staleDays || DEFAULT_STALE_DAYS)
  for (const node of root.querySelectorAll('time[data-checked]')) {
    const iso = node.getAttribute('datetime') || node.dataset.checked
    if (!iso) continue
    const stale = isStale(iso, staleDays)
    node.classList.toggle('is-stale', stale)
    const flag = node.querySelector('[data-stale-flag]')
    if (flag) flag.hidden = !stale
    const age = daysSince(iso)
    if (age != null) {
      node.title = stale
        ? `核对于 ${iso}，距今 ${age} 天，已超过 ${staleDays} 天复核周期`
        : `核对于 ${iso}，距今 ${age} 天`
    }
  }
  return staleDays
}
