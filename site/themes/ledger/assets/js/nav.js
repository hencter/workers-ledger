/* 目录交互两件事，彼此独立：
     1. 移动端目录抽屉（页面级）；
     2. 侧栏里每个节的就地展开/收起（条目级）。

   无脚本时：抽屉按钮不出现（见 layout.css 的 .js 选择器），
   且 nav-entries 上不加 hidden，全部条目平铺可见——导航依然可用。 */

export function initNav() {
  initDrawer()
  initSectionToggles()
}

/**
 * 移动端目录抽屉。
 *
 * ## 状态只有一个来源：面板的 hidden 属性
 *
 * 第一版用 `body.nav-open` 类切 CSS 显隐，按钮上另写 aria-expanded——
 * 于是就有了两个状态来源。两者一旦不一致（例如脚本出错、或只看 DOM 的
 * 读屏/爬虫），播报的会是「已收起」而内容其实在大纲里。
 * 现在改为切 `hidden`，`aria-expanded` 由同一处同步。
 *
 * 同时用 `inert` 把「关闭状态下不该被读到」的部分移出无障碍树与 Tab 顺序：
 *   - 抽屉关闭（移动端）→ 主区 inert，焦点不会跑到被遮住的正文里；
 *   - 抽屉打开 → 侧栏移除 inert，主区加上 inert。
 * 服务端渲染时**不加 hidden/inert**，所以无脚本场景下两块内容都完整可用。
 *
 * `body.nav-open` 保留，但它现在只管一件事：滚动锁定（overflow: hidden 是视觉行为，不是语义状态）。
 */
function initDrawer() {
  const button = document.querySelector('[data-nav-toggle]')
  const panel = document.querySelector('[data-drawer-panel]')
  if (!button || !panel) return
  const inertTargets = [...document.querySelectorAll('[data-drawer-inert]')]

  // 断点必须与 layout.css 的 @media (min-width: 1080px) 保持一致。
  const mq = window.matchMedia('(min-width: 1080px)')

  const set = (open) => {
    // **桌面端没有抽屉这回事，任何一次「收起」都必须在这里短路。**
    //
    // 为什么这不是多余的防御：`hidden` 会把侧栏整个移出布局，而 .shell 在
    // ≥1080px 是 `var(--sidebar-w) minmax(0,1fr)` 的两列网格。侧栏一旦 hidden，
    // 网格里就只剩 <main> 一个子项，它会被放进**第一列**——也就是侧栏那一列，
    // 正文被挤成 320px 宽的窄条。
    //
    // 这不是推演，是实测：无头浏览器里点击侧栏链接的**同一帧**，
    // 侧栏 hidden=false→true、主区 width 1060→320、left 408→44，与读者截图一致。
    // 触发它的是下面两个「点链接就收起抽屉」的处理器，它们在桌面端同样会跑；
    // 按 Escape 那条还会把桌面侧栏**永久**藏掉，直到窗口尺寸变化才复位。
    if (mq.matches) return
    panel.hidden = !open
    panel.inert = !open
    // 主区只在抽屉**打开**时 inert：无脚本或抽屉未启用时，主区必须可读可聚焦，
    // 否则我们等于把正文从无障碍树里摘掉了。
    for (const t of inertTargets) t.inert = open
    document.body.classList.toggle('nav-open', open)
    button.setAttribute('aria-expanded', String(open))
  }

  button.addEventListener('click', () => set(panel.hidden))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') set(false)
  })
  panel.addEventListener('click', (event) => {
    // 点走链接后收起抽屉，让读者直接看到正文
    if (event.target.closest('a')) set(false)
  })

  // 视口变化时把状态复位：桌面端侧栏是常驻栏位，不该被 hidden/inert；
  // 移动端回到「关闭」。这一段同时承担首屏初始化，所以下面不再单独调 set(false)。
  const syncToViewport = () => {
    if (mq.matches) {
      // 桌面端：侧栏是常驻栏位，hidden / inert / aria-expanded 一律清掉——
      // 此时根本不存在「抽屉」这回事，留着这些状态只会误导读屏。
      panel.hidden = false
      panel.inert = false
      for (const t of inertTargets) t.inert = false
      document.body.classList.remove('nav-open')
      button.removeAttribute('aria-expanded')
    } else {
      set(false)
    }
  }
  mq.addEventListener('change', syncToViewport)
  syncToViewport()
}

/**
 * 侧栏各节的展开/收起（W3C ARIA 的 disclosure 模式）。
 *
 * 为什么用 hidden 属性而不是切 CSS 类：hidden 是**语义**——读屏与爬虫据此认定
 * 「这块内容当前不存在」；`display:none` 的类只是视觉隐藏，两者对无障碍与抓取的含义不同。
 * 展开状态集中在一处：按钮的 aria-expanded 与面板的 hidden 永远同步。
 *
 * 为什么不用 <details>/<summary>：那会让「进入本节」的链接失去位置——
 * 详情折叠组只允许一个 summary 作为交互入口，而这里的主路径是「点节名进该节」。
 *
 * 键盘：按 WAI-ARIA 的树状导航惯例，方向键在节之间移动焦点，
 * ←/→ 收起/展开当前节。只接管焦点落在节控件上时的方向键，
 * 其余情况一律不拦截（避免影响输入框与页面滚动）。
 */
function initSectionToggles() {
  const toggles = [...document.querySelectorAll('[data-nav-toggle-sec]')]
  if (!toggles.length) return

  const setState = (btn, open) => {
    const panel = document.getElementById(btn.getAttribute('aria-controls'))
    if (!panel) return
    btn.setAttribute('aria-expanded', String(open))
    panel.hidden = !open
    btn.title = `${open ? '收起' : '展开'}本节条目`
  }

  for (const btn of toggles) {
    // 以服务端渲染的状态为准（当前节默认展开），先对齐一次，避免首屏状态与 DOM 不一致
    const panel = document.getElementById(btn.getAttribute('aria-controls'))
    if (!panel) continue
    setState(btn, !panel.hidden)
    btn.addEventListener('click', () => {
      setState(btn, btn.getAttribute('aria-expanded') !== 'true')
    })
  }

  document.addEventListener('keydown', (event) => {
    const active = document.activeElement
    if (!active) return

    // 焦点在节名链接上时，把方向键操作转给同一行的展开按钮
    const row = active.closest('.nav-sec__row')
    if (!row) return
    const btn = row.querySelector('[data-nav-toggle-sec]')
    if (!btn) return

    const isLink = active.classList.contains('nav-sec__link')
    const isToggle = active === btn
    if (!isLink && !isToggle) return

    const idx = toggles.indexOf(btn)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = toggles[(idx + step + toggles.length) % toggles.length]
      if (next) next.focus()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      setState(btn, event.key === 'ArrowRight')
    } else if ((event.key === 'Home' || event.key === 'End') && isToggle) {
      event.preventDefault()
      const target = event.key === 'Home' ? toggles[0] : toggles[toggles.length - 1]
      if (target) target.focus()
    }
  })
}
