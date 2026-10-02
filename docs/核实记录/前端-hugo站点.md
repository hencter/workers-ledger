# 前端：Hugo 站点与自定义主题

- 日期：2026-10-03
- 范围：`site/`（`site/content/` 与 `site/data/` 由生成脚本掌管，本次只读）
- 结论：严格构建退出码 0、零警告；页面数与 `hugo list all` 对账一致；抽查的渲染产物里条目字段、证据徽章颜色类名、核对日期都真的渲染出来了；产物零外部资源依赖，可离线打开。
- 本机环境：`hugo v0.167.0-3fff6fb5c267dacb26280c78dbe8c344054249c8+extended windows/amd64 BuildDate=2026-09-28T14:50:38Z`；Node `v24.19.0`

## 1. 站点与主题

| 项 | 路径 |
| --- | --- |
| 站点根 | `site/` |
| 配置 | `site/hugo.toml` |
| 主题 | `site/themes/workrights/`（由 `hugo new theme` 生成骨架后改写） |
| 页面模板 | `site/themes/workrights/layouts/{home,page,section,404}.html` + `home.json.json`（0.146+ 新体系） |
| 局部模板 | `site/themes/workrights/layouts/_partials/**` |
| 样式 | `site/themes/workrights/assets/css/**`（`main.css` 经 `css.Build` 内联 6 个子文件） |
| 脚本 | `site/themes/workrights/assets/js/**`（原生 ES 模块，经 `js.Build` 打包为 iife） |
| 渲染校验脚本 | `site/checks/render-check.mjs`（106 项断言） |
| 发布工作流 | `.github/workflows/pages.yml` |

建站命令用的是 0.158 起的 `hugo new project site`（不是 `hugo new site`），配置用 `locale = 'zh-CN'`（不是 `languageCode`）。配置键名逐项用 `hugo config` 核对过：`locale`、`hasCJKLanguage`、`enableGitInfo`、`disableKinds`、`timeZone`、`outputs.home = ['html', 'json']`、`outputFormats.JSON` 的 `baseName = 'entries'` / `isPlainText` / `noUgly` 均出现在生效配置里。

## 2. 严格构建（验收标准 1）

在 `site/` 下执行：

```
hugo --ignoreCache --panicOnWarning --printPathWarnings --printUnusedTemplates --printI18nWarnings
```

输出（`--panicOnWarning` 下任何一条 WARN 都会让构建失败，实际一条都没有）：

```
Start building sites … 
hugo v0.167.0-3fff6fb5c267dacb26280c78dbe8c344054249c8+extended windows/amd64 BuildDate=2026-09-28T14:50:38Z VendorInfo=gohugoio

                  │ EN  
──────────────────┼─────
 Pages            │ 319 
 Paginator pages  │   0 
 Non-page files   │   0 
 Static files     │   1 
 Processed images │   0 
 Aliases          │   0 
 Cleaned          │   0 

Total in 2194 ms
```

退出码 0，WARN/ERROR 行数 0。

产物抽查用的构建在验收命令基础上加了真实发布地址（本站没有配置远端，地址由 CI 从 GitHub 默认环境变量推导，见第 8 节）：

```
hugo --ignoreCache --panicOnWarning --printPathWarnings --printUnusedTemplates --printI18nWarnings \
     --baseURL "https://hencter.github.io/work-rights-cn/" --destination public
```

同样退出码 0、WARN/ERROR 行数 0，`Total in 1938 ms`。

压缩形态（CI 里 `hugo --minify`）另建一份 `.tmp-min` 单独校验，106 项断言同样全通过。

## 3. 页面数对账（验收标准 2）

| 口径 | 数量 |
| --- | --- |
| `hugo list all` 列出的内容页 | 315 |
| `site/public/**/index.html` | 315 |
| `site/content/**/*.md` | 315 |
| 其中条目页（非 `_index.md`） | 300 |
| 其中节索引页 | 14 |
| 其中首页 | 1 |

三者一致：300 + 14 + 1 = 315。

构建汇总行写的 `Pages 319` 比 315 多 4，多出来的是非内容产物：`404.html`、`robots.txt`、`sitemap.xml`、`entries.json`。这一点在 `public/` 顶层清单里能直接看到。

生成脚本与哨兵（在仓库根目录跑）：

```
node tools/build-site.mjs      # 已生成：site/content/（14 节 300 页）与 site/data/entries.json；退出码 0
node tools/check-site.mjs      # 原文 300 条，索引 300 条，逐字段比对完成；索引与正文逐字段一致；退出码 0
```

## 4. 渲染产物抽查（验收标准 3）

抽查件一律取自 `site/public`，并且在同一条命令里完成构建与取证（原因见第 9 节末尾的监视器说明）。该次构建的 `site/public/index.html` SHA256 为 `3F03194D72F59706CEEA5592ABD59C1EE8FBEBC0A28C0DB423EE75DF7B4A5A2B`，8 秒后复查哈希不变，确认取证窗口内没有第二个写者。

注意：产物**不是逐字节可复现**的——页脚写着构建时间（`本次构建：…`），同一份源码两次构建的 HTML 哈希不同。哈希在这里的用途只是「确认取证期间产物没被并发的监视器覆盖」，不是内容指纹。

### 抽查 1：首页 `site/public/index.html`

- `canonical` = `https://hencter.github.io/work-rights-cn/`（绝对地址）
- `robots` = `index, follow`（production 环境）；用 `--environment development` 再构建一次，该标签变成 `noindex, nofollow`，两个分支都实测过
- 检索索引地址 `data-index-url` = `/work-rights-cn/entries.json`（带部署子路径）
- 样式与脚本 = `/work-rights-cn/css/main.<64 位指纹>.css`、`/work-rights-cn/js/main.<64 位指纹>.js`
- JSON-LD 实际渲染字节（`site/public/index.html` 里 `<script type="application/ld+json">` 之间）：

  ```
  {"@context":"https://schema.org","@type":"WebSite","description":"中国大陆劳动权益与合规的循证指南","inLanguage":"zh-CN","name":"劳动权益与合规指南","url":"https://hencter.github.io/work-rights-cn/"}
  ```

- 证据分布实测（同一份产物里的数字）：

  | 主张强度 | 条数 |  | 举证难度 | 条数 |  | 效力位阶 | 条数 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | 可主张 | 196 |  | 易 | 67 |  | 法律 | 175 |
  | 可推定 | 80 |  | 中 | 219 |  | 行政法规 | 79 |
  | 倡导性 | 24 |  | 难 | 14 |  | 部门规章 | 29 |
  |  |  |  |  |  |  | 司法解释 | 51 |
  |  |  |  |  |  |  | 地方口径 | 3 |
  |  |  |  |  |  |  | 无明文依据 | 24 |

  主张强度三档合计 300、举证难度三档合计 300，与条目总数吻合；效力位阶按「命中」统计，一条依据可能同时命中多个层级（如「法律 + 司法解释」），所以合计大于 300，页面上的说明文字已写明这一点。
- 统计条：条目 300、节 14、最近核对日期 2026-10-03
- 侧栏：共 300 条，分 14 节

### 抽查 2：节页 `site/public/14-仲裁与诉讼实操/index.html`

- 题头：`第 14 节 · 28 条`；卡片 28 张，与索引里该节条数一致
- 卡片主张强度类名：`claim-strong ×17`、`claim-mid ×6`、`claim-weak ×5`
- 卡片举证难度类名：`proof-easy ×9`、`proof-mid ×19`
- 侧栏列出 14 个节，当前节展开为 28 个条目链接
- 节内快速过滤的三个钩子（`data-local-filter` / `data-local-count` / `data-local-empty`）都在

### 抽查 3：条目页 `site/public/14-仲裁与诉讼实操/01-立案前先算三件事时效请求金额管辖/index.html`

- 标题：`立案前先算三件事：时效、请求金额、管辖`
- 13 个字段全部渲染出来，顺序与 `docs/条目规范.md` 一致：

  ```
  适用、成本、收益、依据、效力位阶、主张强度、举证难度、地域、时效、来源、核对日期、备注、成本标签
  ```

- 徽章颜色类名：`badge--claim-strong ×2`、`badge--proof-mid ×2`、`badge--rank ×1`、`badge--date ×2`
- 核对日期 `<time class="badge badge--date" datetime="2026-10-03">`，旁边带隐藏的「待复核」标记位（`data-stale-flag`），由脚本按 180 天阈值决定是否显示
- 来源栏渲染成可点链接（`class="src-link"`，带 `rel="nofollow noopener noreferrer"`），本例指向 `http://www.gd.gov.cn/zwgk/wjk/zcfgk/content/post_2722147.html`
- 同节翻页按条号顺序生成（上一条 = 条号减一，下一条 = 条号加一），首条只有「下一条」、末条只有「上一条」

### 抽查 4：检索索引 `site/public/entries.json`

- `count = 300`、`staleDays = 180`
- 每条含 22 个键：`url`、`节号`、`节名`、`条号`、`标题`、`说人话`、`适用`、`成本`、`收益`、`依据`、`地域`、`时效`、`备注`、`主张强度`、`主张强度原文`、`举证难度`、`举证难度说明`、`效力位阶`、`效力位阶原文`、`效力位阶全部`、`核对日期`、`成本标签`
- `url` 由模板用 Hugo 的 `.RelPermalink` 解析（索引本身不再提供路径字段），并带部署子路径与百分号编码：

  ```
  /work-rights-cn/01-%E7%AD%BE%E5%90%88%E5%90%8C%E4%B9%8B%E5%89%8D/01-%E7%94%A8%E5%B7%A5...
  ```

  300 条 `url` 逐条解码后都能落到 `site/public` 里真实的 `index.html`（脚本断言）。

## 5. 硬约束扫描（验收标准 4）

```
grep -rnE '\{\{<[^/]|\{\{%[^/]' site/content/     → 0 命中
grep -rn 'HAHAHUGOSHORTCODE' site/content/        → 0 命中
```

对整个 `site/public/**/*.html` 与 `*.json` 做同样的扫描，也是 0 命中。这两条已固化进 `site/checks/render-check.mjs` 的断言，构建后会自动再扫一遍。

## 6. 断网可用（验收标准 5）

对 `site/.tmp-final` 全部 316 个 HTML（315 个内容页 + `404.html`）统计：

- 会发起加载的资源标签只有四类，全部指向本机：`rel=canonical`（绝对地址，本站自己的发布地址）、`rel=icon`（`/work-rights-cn/favicon.svg`）、`rel=stylesheet`（`/work-rights-cn/css/main.<指纹>.css`）、`script src`（`/work-rights-cn/js/main.<指纹>.js`）
- 指向外部域名的资源标签：**0**；`<img>`：**0**
- 样式里 `@font-face`、`@import`、`url(http…)`：**0**（6 个 CSS 文件已被 `css.Build` 内联成一个文件，字体只用系统字体栈）
- 脚本里只有一次 `fetch`，取的是同源的检索索引；没有任何外部接口

页面里确实有 408 条指向官方域名的 `<a>` 链接（去重 10 个域名：`www.gov.cn`、`www.npc.gov.cn`、`flk.npc.gov.cn` 等，另有 `114.255.111.180`、`www.samr.gov.cn:9001` 两个机构自有地址）。这些是条目「来源」栏的**内容引用**，点开才联网，不参与页面渲染——断网打开页面，样式、脚本、检索与筛选都照常工作，只是点来源链接会打不开。

校验脚本里对应的断言是「产物中没有任何外来资源标签（离线可用）」，会跳过 `rel=canonical`（它按设计必须是绝对地址）。

体积：样式 25.4 KB、脚本 14.5 KB，各一个请求，均已压缩并带内容指纹（`css.Build`/`js.Build` 自带压缩，`--minify` 只再压 HTML）。

## 7. 移动端与深色模式（验收标准 6）

**验证方式的边界先说清楚：本机没有可用浏览器，也没有截图能力。**所以这两项给的证据是「构建产物里的 HTML 与 CSS 事实 + 脚本纯函数的单元测试」，不是渲染截图，也不是真机实测。哪一部分没有覆盖到，见第 9 节。

### 深色模式（产物侧证据）

- `<meta name="color-scheme" content="light dark">` 在每页 `<head>` 里
- 样式里有 `@media (prefers-color-scheme: dark)` 块（跟随系统）
- 同一份样式里另有 `:root[data-theme="dark"]`（手动切深色）与 `:root:not([data-theme="light"])`（手动切浅色时不被系统深色覆盖）
- 颜色全部走自定义属性：浅色/深色各定义一套同名令牌，组件样式只引用 `var(--…)`。样式里出现的 86 个十六进制色值全部集中在两个调色板块里，另有 3 处 `#fff` 是主按钮上的文字色（两种情况都压在印泥红底上）
- 示例：`--claim-strong` 浅色 `#196f45`、深色 `#6ecf99`；`--proof-hard` 浅色 `#bc3527`、深色 `#f08b78`
- 防闪：`<head>` 里一段内联脚本在样式之前读 `localStorage` 并写 `data-theme`，避免深色用户先看到一屏白
- 手动切换按钮（`data-theme-toggle`）在**没有脚本时隐藏**（`.js` 类控制），所以不会出现「点了没反应」的按钮；有脚本时点击切换并记住选择

### 移动端（产物侧证据）

- `<meta name="viewport" content="width=device-width, initial-scale=1">`
- 断点（实测存在于产出样式里）：`min-width: 720px`、`760px`、`1080px`、`1240px`、`1400px`，以及 `max-width: 1079px`（移动端抽屉）
- 触控目标：`@media (pointer: coarse)` 里把筛选项、已选条件、工具按钮、搜索框抬到 44–48px；样式里 `min-height: 44/46/48px` 共 11 处
- 侧栏在窄屏变抽屉（`data-nav-toggle` + `aria-expanded` + `aria-controls`），无脚本时抽屉逻辑不生效，导航按普通流平铺，只展开当前节，不会把页面撑成一条几百项的长列表
- 触控与可访问性：跳转链接、`aria-current`、`aria-pressed`、筛选结果计数上的 `aria-live="polite"`、`prefers-reduced-motion` 降级都在

### 脚本纯函数的单元测试

`site/checks/render-check.mjs` 直接 `import` 站点真正发布的 `assets/js/stale.js` 与 `assets/js/search.js`（Node 的模块语法探测能直接加载，无需依赖），跑这些断言：

- 待复核阈值：距今 180 天不算超期、181 天算超期、空值与非法值不误报
- 关键词归一化、筛选状态的 URL query 往返
- 筛选命中数逐档与页面上的分布数字对齐（见第 8 节）

## 8. 额外做的对账（超出验收标准的部分）

### 8.1 模板分档与前端筛选的逐档对账

站点把「自由文本字段 → 分档」这件事实现了两遍：Go 模板 partial（`layouts/_partials/logic/`）与前端脚本。两份一旦漂移，页面上的分布数字、徽章颜色和筛选结果会互相矛盾，而 Hugo 不会报错。`render-check.mjs` 的 B 组断言就是这道对账：**首页 HTML 里渲染出的每一个分档数字，必须等于脚本用同一份索引筛出来的条数**，逐档比对（主张强度 3 档、举证难度 3 档、效力位阶 8 档），再加上「三档合计是否等于条目总数」「无明文依据的条目主张强度是否为倡导性」这类跨字段规则。

本轮结果：106 项断言全通过（未压缩产物与 `--minify` 产物各跑一遍）。

### 8.2 子路径部署（GitHub Pages 项目页）

按 `https://example.org/work-rights-cn/` 与 `https://hencter.github.io/work-rights-cn/` 各构建一次，确认 `canonical`、`og:url`、样式、脚本、图标、检索索引地址、索引内每条 `url` 都带上子路径，且 106 项断言同样全通过。`render-check.mjs` 的部署前缀是从页面 `<html data-base>` 里读的，站点换地址不用改脚本。

### 8.3 发布工作流本地等价流程

`.github/workflows/pages.yml` 除「安装 Hugo 的动作」外，其余步骤在 Git Bash 下原样跑了一遍：生成脚本 → 生成哨兵 → 计算站点地址（两种仓库形态都试了：项目页得到 `https://<owner>.github.io/<仓库名>/`，用户页得到 `https://<owner>.github.io/`）→ `hugo --minify --baseURL …` → 校验 canonical → 渲染校验。全部通过。

### 8.4 本轮修掉的四个真问题

1. **索引里的链接会 404**：生成脚本原先给的 `路径` 是按原文件名拼的，而 Hugo 发布时会剔掉标题里的中文标点（`01-加班费三档：平日…` 实际发布成 `01-加班费三档平日…`）。改为在模板里按「节号.条号」索引 Hugo 的 `RegularPages`，用 `.RelPermalink` 取真实地址；生成脚本侧已按此去掉 `路径` 字段。
2. **待复核天数偏差一个时区**：`Date.parse('2026-10-03T00:00:00')` 在 V8 里按 UTC 解释，东八区算出来会多 8 小时，180 天的阈值被提前触发。改成用 `new Date(年, 月-1, 日)` 显式构造本地零点。这是单元测试逼出来的：恰好 180 天的断言一开始是红的。
3. **JSON-LD 被包成字符串**：`{{ $ld | jsonify }}` 放在 `<script>` 里会按 JS 字符串转义，产物形如 `"{\"@type\":\"WebSite\",…}"`，消费方读不到 `@type`。加 `safeJS` 后恢复成裸对象，已在产物字节上复核，并把这条写成断言。
4. **侧栏条目数可能虚高**：原来用 `len site.RegularPages`，任何新增的普通页（比如以后加一篇 about）都会被算进「共 N 条」。改为按节累加 `.Pages`。

## 9. 已知局限

1. **没有浏览器可用**：深色模式与移动端只做到「产物里的事实 + 纯函数单测」，没有截图、没有真机、没有实际点击。断点是否在真机上折行好看、深色配色的实际观感、抽屉动画是否顺滑，这些都没有实测。验收标准 6 要求「截图或 HTML 证据」，这里给的是 HTML/CSS 证据。
2. **发布工作流没有真跑过**：`actions/checkout`、`actions/setup-node`、`peaceiris/actions-hugo`、`actions/upload-pages-artifact`、`actions/deploy-pages` 的版本与入参无法离线核对（本机对外域名全部解析到保留地址，`gohugo.io` 也取不到），Pages 的仓库设置也需要在网页端开启一次。工作流感兴趣的部分（生成、构建、baseURL 推导、canonical 校验、渲染校验）已在本地等价跑通。
3. **`site/hugo.toml` 里的 `baseURL` 是占位值** `https://example.org/`。发布时由 CI 用 `--baseURL` 覆盖成真实地址；若改用自定义域名，需要在工作流里把那一段改成固定地址（工作流里已注明改法）。
4. **并发写 `site/public/` 会污染证据**：验收期间 `hugo server -D` 在跑，开发版产物（`livereload` 脚本、指向 `localhost:1313` 的 canonical、`noindex`）会写进同一个目录，甚至和验收构建混在一起。本次的处理是「构建与取证放在同一条命令里」，并另存一份 `site/.tmp-final` 作为统计样本。**建议把监视器固定成 `hugo server -D --renderToMemory`（或指到别的目录），别和验收构建抢 `public/`。**
5. **站点内容不是独立维护的**：`site/content/` 与 `site/data/` 每次都由 `tools/build-site.mjs` 整体重建，改了会被覆盖。首页文案放在 `hugo.toml` 的 `params` 里而不是 `content/_index.md`，就是为了避开这一点。
6. **字段分档规则依赖正文写法**：`主张强度` 按前缀（可主张/可推定/倡导性）判，`举证难度` 按首字（易/中/难）判，`效力位阶` 按包含判并允许多个层级同时命中。正文若出现全新写法（例如把「难」写成「很难」），分档会落到兜底档。改这两处逻辑要同时改 `layouts/_partials/logic/` 与 `assets/js/search.js`，并跑 `render-check.mjs` 对账。
7. **条目数与节数都没写死**：模板全部从内容树动态取（侧栏用 `site.Home.Sections.ByWeight`，分布与索引遍历数据文件），本轮从 166 条 10 节一路扩容到 300 条 14 节没有改过模板。
8. **效力位阶的合计大于条目总数是设计使然**，不是统计错误；页面说明文字已写明。
9. 打印样式只做了基础处理（去导航与筛选、卡片不跨页断开），没有逐页校对打印效果。
10. **产物不逐字节可复现**：页脚带构建时间。若要可复现构建，把 `site/themes/workrights/layouts/_partials/footer.html` 里那一行删掉即可。

## 10. 复现命令

```bash
# 1. 生成内容与索引
node tools/build-site.mjs
node tools/check-site.mjs

# 2. 严格构建（在 site/ 下）
hugo --ignoreCache --panicOnWarning --printPathWarnings --printUnusedTemplates --printI18nWarnings

# 3. 渲染校验（默认读 site/public，也可 --out 指定别的产物目录）
node site/checks/render-check.mjs
node site/checks/render-check.mjs --out site/.tmp-min

# 4. 硬约束
grep -rnE '\{\{<[^/]|\{\{%[^/]' site/content/
grep -rn 'HAHAHUGOSHORTCODE' site/content/
```
