/* 深浅色切换：默认跟随系统，用户手动选过就记住。
   CSS 侧：@media (prefers-color-scheme: dark) 是默认；
   html[data-theme="light"|"dark"] 是手动覆盖。

   ## 不闪屏靠三件事

   1. **首屏就定好**——`<head>` 里的内联脚本在第一帧之前写入 data-theme，
      所以加载时不会先亮后暗。那一段必须留在 head 内联，不能挪到这里：
      本文件是 defer 加载的模块，跑起来时首帧早就画完了。
   2. **切换时压掉过渡**——见下面 setTheme 里的 .theme-switching。当前 CSS 并没有
      全局颜色过渡，但个别组件有（输入框、箭头的 transition），主题切换瞬间它们会
      各自过渡一下，观感上就是「闪一下」。统一在切换的那一帧压掉，切完立刻恢复。
   3. **让浏览器原生 UI 跟着变**——`color-scheme` 决定滚动条、输入框、下拉框这些
      浏览器自己画的部分用亮色还是暗色。只在 <head> 里写死 `light dark` 时，浏览器
      按**系统**偏好画，于是手动切到深色而系统是浅色时，滚动条会先亮后暗。
      所以每次切换都同步这个 meta。 */

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

/** 让浏览器原生 UI（滚动条、表单控件）与当前主题一致，避免先亮后暗 */
function syncColorScheme(theme) {
  const meta = document.querySelector('meta[name="color-scheme"]')
  if (meta) meta.setAttribute('content', theme === 'dark' ? 'dark' : 'light')
}

/** 切换主题，并保证这一帧内不发生任何过渡 */
function setTheme(theme) {
  const root = document.documentElement
  root.classList.add('theme-switching')
  root.dataset.theme = theme
  syncColorScheme(theme)
  // 强制读一次布局，让「压制过渡」在样式重算前就已生效
  void root.offsetHeight
  root.classList.remove('theme-switching')
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
    // 没手动选过时，界面跟随系统——原生 UI 也要跟着
    if (!read()) syncColorScheme(theme)
  }

  button.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark'
    setTheme(next)
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
