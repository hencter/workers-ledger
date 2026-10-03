/* 节内快速过滤：不请求数据，只在已经渲染出来的卡片上做减法。
   数据来自每张卡片的 data-search 属性（服务端渲染时写入）。 */

const normalize = (value) => String(value == null ? '' : value).toLowerCase().replace(/[\s\u3000]+/g, ' ').trim()

export function initLocalFilter() {
  const input = document.querySelector('[data-local-filter]')
  if (!input) return

  const cards = Array.from(document.querySelectorAll('[data-entry-card]'))
  const empty = document.querySelector('[data-local-empty]')
  const count = document.querySelector('[data-local-count]')
  if (!cards.length) return

  let timer = null

  const run = () => {
    const terms = normalize(input.value).split(' ').filter(Boolean)
    let shown = 0
    for (const card of cards) {
      const hay = card.dataset.search || ''
      const hit = !terms.length || terms.every((t) => hay.includes(t))
      card.hidden = !hit
      if (hit) shown += 1
    }
    if (empty) empty.hidden = shown > 0
    if (count) count.textContent = terms.length ? `筛出 ${shown} / ${cards.length} 条` : `共 ${cards.length} 条`
  }

  input.addEventListener('input', () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(run, 120)
  })

  run()
}
