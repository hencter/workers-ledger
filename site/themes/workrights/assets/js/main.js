/* 脚本入口。由 js.Build（esbuild）打包成一个文件，全部本地模块，无外部依赖。 */

import { initTheme } from './theme.js'
import { initNav } from './nav.js'
import { applyStale } from './stale.js'
import { initLocalFilter } from './local-filter.js'
import { initSearch } from './search.js'

function boot() {
  initTheme()
  initNav()
  initLocalFilter()
  applyStale()
  initSearch()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
