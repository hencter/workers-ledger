/* 深浅色切换：默认跟随系统，用户手动选过就记住。
   CSS 侧：@media (prefers-color-scheme: dark) 是默认；
   html[data-theme="light"|"dark"] 是手动覆盖。 */

const KEY = 'ledger-theme'

function read() {
  try {
    const v = window.localStorage.getItem(KEY)
    return v === 'dark' || v === 'light' ? v : null
  } catch (err) {
    return null
  }
}

function write(value) {
  try {
    window.localStorage.setItem(KEY, value)
  } catch (err) {
    /* 隐私模式下写不进去也无妨，本次会话仍然生效 */
  }
}

export function initTheme() {
  const button = document.querySelector('[data-theme-toggle]')
  const saved = read()
  if (saved) document.documentElement.dataset.theme = saved
  if (!button) return

  const label = button.querySelector('[data-theme-label]')
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

  const current = () => document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light')

  const sync = () => {
    const theme = current()
    button.setAttribute('aria-pressed', String(theme === 'dark'))
    button.setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式')
    if (label) label.textContent = theme === 'dark' ? '浅色' : '深色'
  }

  button.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    write(next)
    sync()
  })

  if (typeof systemDark.addEventListener === 'function') {
    systemDark.addEventListener('change', () => {
      if (!read()) sync()
    })
  }
  sync()
}
