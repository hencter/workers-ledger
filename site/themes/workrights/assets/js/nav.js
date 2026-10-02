/* 移动端目录抽屉。没有脚本时导航直接平铺显示，按钮不出现（见 layout.css 的 .js 选择器）。 */

export function initNav() {
  const button = document.querySelector('[data-nav-toggle]')
  const sidebar = document.getElementById('sidebar')
  if (!button || !sidebar) return

  const set = (open) => {
    document.body.classList.toggle('nav-open', open)
    button.setAttribute('aria-expanded', String(open))
  }

  button.addEventListener('click', () => {
    set(!document.body.classList.contains('nav-open'))
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') set(false)
  })

  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('a')) set(false)
  })

  window.matchMedia('(min-width: 1080px)').addEventListener('change', (event) => {
    if (event.matches) set(false)
  })

  set(false)
}
