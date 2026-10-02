# 前端：PDF 电子书导出（无头浏览器打印）

- 日期：2026-10-03
- 范围：`tools/build-pdf.mjs`、`tools/verify-pdf.mjs`（新增）；产物 `dist/`（已忽略，不进版本库）
- 结论：**整本 PDF 与单节 PDF 都能一条命令产出，内容经独立解析逐项核实通过**（整本 28/28 项、单节 21/21 项）。中文以正确的 Unicode 存在、字体是嵌入的中文子集，截图肉眼确认不是豆腐块；站点打印样式确实生效（首页 DOM 里带着顶栏、侧栏、检索面板，PDF 里一个都没有）。
- 本机环境：Node `v24.19.0`；`HeadlessChrome/154.0.0.0`（PDF 生成引擎 `Skia/PDF m154`）；Windows 11
- **未验证边界：以上全部是本地验证。脚本已做到命令与浏览器可配置、支持容器关沙箱，但从未在 CI（Ubuntu）上实际跑过**，见第 12 节。

## 1. 为什么用浏览器打印，而不是别的工具

本机 PDF 工具链盘点结果：pandoc、typst、LaTeX、wkhtmltopdf、weasyprint、LibreOffice **全部没有**；Hugo 自身不产出 PDF；mdbook 虽已安装，但它要自己的 `src/SUMMARY.md` 目录结构，等于引入第三份正文（本仓库规矩是 `book/*.md` 为唯一真相源），而且 mdbook 自己也不出 PDF，仍要接 Chromium 或事后打印，绕一圈回到同一个办法。

站点已经把 `book/` 渲染成带样式的页面（中文字体栈、证据徽章、行宽都调过），所以直接让无头 Chrome 走 `Page.printToPDF`：保住排版、零新依赖、零新增真相源。

## 2. 交付物与命令

| 交付物 | 说明 |
| --- | --- |
| `tools/build-pdf.mjs` | 导出脚本，零第三方依赖（只用 Node 内置 http / WebSocket / child_process / fs / zlib） |
| `tools/verify-pdf.mjs` | 独立核实脚本，自己解 PDF 字节，不复用导出脚本的任何函数 |
| `dist/劳动者的账本.pdf` | 整本电子书 |
| `dist/劳动者的账本-第02节-在职工资与工时.pdf` | 单节导出示例 |

```bash
# 一、从 book/ 生成站点内容与检索索引（15 节 324 页）
node tools/build-site.mjs

# 二、子路径生产构建，输出到独立目录（不动 site/public）
cd site
hugo --minify --baseURL /workers-ledger/ --ignoreCache -d ../dist/.site-public

# 三、导出整本
node tools/build-pdf.mjs --site dist/.site-public --keep-html dist/.print-source.html

# 四、导出单节（第 2 节）
node tools/build-pdf.mjs --site dist/.site-public --only 2

# 五、独立核实
node tools/verify-pdf.mjs "dist/劳动者的账本.pdf" --site dist/.site-public \
  --print-html dist/.print-source.html --shots dist/.shots --shot-pages 1,4,200
node tools/verify-pdf.mjs "dist/劳动者的账本-第02节-在职工资与工时.pdf" \
  --site dist/.site-public --section 2 --min-pages 10 \
  --expect-title "劳动者的账本 · 第 02 节 在职工资与工时"
```

`node tools/build-pdf.mjs --help` 有完整开关：`--out`、`--only`、`--site`、`--browser`、`--no-sandbox`、`--link-base`、`--keep-html`、`--no-page-numbers`。

## 3. 实现里踩到的三个坑

脚本骨架复用 `site/checks/measure-layout.mjs`，它记过的两个坑这里同样存在，第三条是本次导出时才撞上的。

1. **不能连 `/json/version` 给的地址**。那是浏览器级端点，发 `Runtime.enable` 会报 `'Runtime.enable' wasn't found`；必须连 `/json/list` 里的**页面** target。
2. **必须走 http，不能走 `file://`**。站点按子路径部署，资源地址是 `/workers-ledger/css/main.<指纹>.css` 这类根绝对路径；`file://` 下浏览器去文件系统根找，样式表加载不到，量到/打印到的是裸 HTML。脚本起一个只读静态服务托管产物目录，并把不存在的前缀段丢掉，因此带前缀与不带前缀的产物都能落到同一份文件。
3. **产物目录会被并发改写**（本次实测两次）。`site/public/index.html` 在本次作业期间先被写成生产压缩版（`03:17`，属性不带引号、样式表带指纹与 SRI），又被写回开发版（`livereload` 脚本、`localhost:1313` 的 canonical）；这台机器上还跑着用户的 `hugo server -D --disableFastRender`，按规矩不能杀。应对不是加锁，而是**不写、不依赖共享目录**：构建输出到 `dist/.site-public`，导出时读这一份；样式表在读取时按产物的 `integrity` 做 SRI 校验后**整段内联**进打印源，打印期间不再碰磁盘。这样即使有人在跑构建，这次导出的输入也是自洽的。

**站点产物的形态差异也被兼容**：开发版属性带引号（`class="entry"`），生产压缩版不带引号（`class=entry`），解析用同一套容错取值。

## 4. 产物规模与页数

| 产物 | 字节 | 大小 | 页数 | 范围 |
| --- | --- | --- | --- | --- |
| `dist/劳动者的账本.pdf` | 12,775,567 | 12.18 MB | **709** | 封面 + 首页 + 目录 + 15 节 + 324 条 |
| `dist/劳动者的账本-第02节-在职工资与工时.pdf` | 727,321 | 0.69 MB | **23** | 第 2 节标题页 + 11 条 |

构建耗时约 17 秒（整本）、4 秒（单节）。构建时刻 `2026-10-03 03:23`。

**口径说明**：本任务书写的是「14 节 300 条」，本次构建时仓库已是 **15 节 324 条**——队友在此期间新增了第 15 节「应届生与第一份工作」（24 条）。脚本不写死数字，节数与条数一律取产物里的 `entries.json`，所以正文增长后重新跑即可，无需改代码。

## 5. 核实方法：为什么必须自己解 PDF

本机没有 `pdftotext`、`mutool` 之类的工具，而「文件生成了」不等于「内容对了」。PDF 里的中文是 **Identity-H（CID）编码**：内容流里存的是字形编号，不是 Unicode。所以文字是否正常，只有顺着字体的 `ToUnicode` CMap 还原才能判断。

`tools/verify-pdf.mjs` 的做法（零依赖）：

1. 线性扫出全部 PDF 对象（本次整本 45,054 个），按 `/Length` 精确截取流，用 `node:zlib` 解 Flate。
2. 从最后一个 trailer 取 `/Info`、`/Root`；按 `/Root → /Pages → /Kids` 走页面树，得到真实页序。
3. 逐页取 `/Resources /Font` 的资源名 → 字体对象 → `ToUnicode`，解析 `beginbfchar` / `beginbfrange`，把内容流里的 `Tj`/`TJ` 字符串解回 Unicode。
4. 用还原出来的文本做断言：字数、逐条命中、禁止出现的元素、页脚、空白页等。
5. 另用浏览器打开产物 PDF 截图（`--shots`），肉眼确认字形、分页与版面。

`.verify-full.txt` 是本机跑完的完整输出（存于 `dist/`，未进版本库）。整本 28 项断言全部通过。

## 6. 整本核实结果（28/28）

| 断言 | 实测 |
| --- | --- |
| 文件大小不是空壳 | 12.18 MB |
| 页数与规模相称 | 709 页 |
| 提取到大量汉字 | 231,847 个 |
| 没有大量无法还原的字符 | 未映射 0 个 / 共 408,260 字符 |
| `/Title` 为中文书名 | 「劳动者的账本」 |
| `/Author` 为指定署名 | 「亦幸和幸知」 |
| `/Lang` 声明 | `zh-CN` |
| 含 PDF 书签（大纲） | 347 个节点 |
| 含可点外部链接注解 | 801 个 `/URI` |
| 没有链接指向本地服务（死链） | 0 个 |
| 目录做成 PDF 内部跳转链接 | 346 个内部目标 |
| 外部引文链接指向真实网址 | 801 个全部是 `http(s)://` |
| 抽查三处条目正文 | 三处全部命中（见第 7 节） |
| 全部条目标题都在 PDF 里 | 324 条，一条不缺 |
| 全部条目「说人话」正文片段都在 PDF 里 | 324 条，一条不缺 |
| 没有条目标题孤零零留在页底 | 0 页 |
| PDF 里没有顶栏副标题 / 左侧栏标题 / 跳转正文链接 | 三个都没有 |
| 打印源 HTML 里确实带着这些元素 | 三个都在（否则「PDF 里没有」不成证据） |
| 封面/目录含署名 | 「亦幸和幸知」出现 2 次 |
| 目录页覆盖全部节 | 30 个节标题（目录 15 + 各节页眉 15） |
| 有独立目录页 | 目录说明段在 PDF 里 |
| 页脚含页码 | 「第 1 页 / 共 709 页」 |
| 没有大量空白页 | 0/709 页正文少于 20 字 |
| 浏览器渲染 PDF 页面截图 | 第 1、4、200 页（见第 8 节） |

**「全部条目正文都在」这一项是刻意设计的强检查**：标题在目录页也有一份，所以标题命中不能证明正文进了 PDF；这一项取每条 `entries.json` 的「说人话」字段首 12 字（该文本只出现在条目正文页，目录和分节列表里都没有），324 条逐一比对，一条不缺。

## 7. 三处条目抽查（任务指定）

| 抽查对象 | 取自条目 | PDF 里查到的原文 |
| --- | --- | --- |
| 第 2 节·加班费 | 2.1 加班费三档 | 「加班费分三档：平时加班一点五倍工资」 |
| 第 12 节·竞业限制 | 12.1 先分清两种竞业限制 | 「竞业限制有两种写法，规则不一样」 |
| 第 13 节·工亡三笔钱 | 13.15 工亡三笔钱的算法与全国统一口径 | 「因工死亡有三笔」 |

三处都是比对**条目正文（说人话块）**的句子，不是标题；比对时先去掉空白再匹配，因此不受换行与字距拆分影响。

## 8. 中文渲染与打印样式生效的直接证据

**中文不是豆腐块**：两条独立证据。

1. 文本层面：从 PDF 里还原出 231,847 个汉字、未映射字符 0 个。
2. 视觉层面：用无头 Chrome 打开这份 PDF 并截图（`dist/.shots/第001页.png` 封面、`第004页.png` 目录、`第200页.png` 正文），字形、徽章、页脚「第 1 页 / 共 709 页」都是正常中文。字体是嵌入子集（`/BaseFont /AAAAAA+MicrosoftYaHei`、`/Encoding /Identity-H`），不依赖读者机器上装没装中文字体。

**打印样式确实生效**，证据结构与结论分离：

| 元素 | 打印源 DOM | PDF 文本 |
| --- | --- | --- |
| 顶栏副标题「中国大陆 · 循证指南」 | 有 | **没有** |
| 左侧栏标题「全书目录」 | 有 | **没有** |
| 跳转正文链接「跳到正文」 | 有 | **没有** |
| 检索筛选面板（`section.app`）、顶栏、侧栏、页脚 | `display: none` | 无内容 |

导出脚本在打印前还有一道自检（不通过就直接退出码 3，不产出文件）：强制打印媒体后读计算样式，确认 `header.topbar`、`aside.sidebar`、`section.app`、`footer.footer` 四个都是 `display: none`，并确认加载到打印规则、DOM 里的条目数与 `entries.json` 一致。本次输出：

```
样式表 2 张 · 打印规则 6 条 · 条目 324 个 · 目录 324 条 · 分节 15 个
header.topbar 打印时 display = none
aside.sidebar 打印时 display = none
section.app 打印时 display = none
footer.footer 打印时 display = none
```

## 9. 元数据与链接

| 项 | 结果 | 做法 |
| --- | --- | --- |
| `/Title` | 劳动者的账本（中文） | `Page.printToPDF` 取文档标题，打印源里写 `<title>` |
| `/Author` | 亦幸和幸知（中文） | 浏览器接口**没有**元数据参数，生成后用 PDF 标准的**增量更新**追加一个新 `/Info` 对象与一张 `xref` 表，`/Prev` 指回原来的 `startxref`。原字节一个都没动，读不了增量部分的阅读器仍能完整读到原文档 |
| `/Lang` | `zh-CN` | 打印源的 `<html lang="zh-CN">`，Chrome 自带写入 |
| `/Creator` | `HeadlessChrome/154.0.0.0`、`Skia/PDF m154` | 浏览器固定写入，未改 |
| 书签/大纲 | 347 个节点 | `Page.printToPDF` 的 `generateDocumentOutline`，书签来自标题层级；这是浏览器能给的，没有手工排版目录树 |
| 链接 | 801 个外部引文链接 + 346 个内部跳转 | 外部链接指向真实法规网址；目录条目做成 `#锚点` 内部跳转 |

链接为什么可用：站点是子路径部署，站点自身产物的站内链接是 `/workers-ledger/…`。如果只让浏览器按本地服务解析，PDF 里的站内链接会指向 `http://127.0.0.1:<端口>/…` 这种死链。所以打印源声明 `<base href="https://hencter.github.io/workers-ledger/">`（可用 `--link-base` 改，`--link-base none` 关闭），站内链接指向公开发布地址；核实脚本确认 PDF 里 0 个链接指向本地服务。**PDF 里的链接能否点开，取决于这个发布地址是否就是该书的实际发布地址。**

一点须知：站点 `print.css` 有一条规则会在外部链接后面补印网址原文（`a[href^="http"]::after`），所以正文里的法规来源会显示成「网址（说明文字）」。这是站点既有的打印样式，本次没有改动主题，保持原样。

## 10. 分页处理

条目标题和「说人话」块不允许被页边切开，这是本次专门注入的打印规则（不改主题，只加在打印源里）：

```css
@page { size: A4; margin: 16mm 15mm; }
h1, h2, h3, h4 { break-after: avoid-page; }        /* 标题后不留白页底 */
.entry > h1, .entry__eyebrow, .badges,
.lead-block, .field, .note { break-inside: avoid; } /* 能整块放下就不切开 */
.entry + .entry { border-top: 1px solid #ccc; }     /* 条目之间一道分隔线 */
.book-front, .book-part { break-before: page; }     /* 目录与每节另起一页 */
```

核实方式：解析出的每页文字里，**条目正文页的最后一行不应正好是某个条目标题**（目录页以标题结尾是正常的，已排除）。709 页里 0 页命中。这条是启发式检查，不是几何测量，局限见第 11 节。

条目之间不强制另起一页：324 条各占一页会让体积和纸张翻倍，连续排下来更省，靠分隔线和「标题不与正文分离」两条规则保证可读性。整本 709 页、每页都有正文（0 页空白）。

## 11. 已知限制（如实列出）

1. **目录没有页码**。浏览器打印是一次性渲染，无法把实际页码回填到文档里，也没有第二遍排版的入口。替代方案是目录条目做成 PDF 内部跳转链接（346 个），点击直达；这条已在目录页写明。
2. **书签来自标题层级**，只有浏览器能提取的层级，没有手工编的细粒度目录树。
3. **「条目标题不落页底」是启发式检查**：判据是「正文页最后一行是否为某条目标题」，不是几何测量。真正保证分页的是第 10 节的 `break-*` 规则；抽查三页截图也没有发现标题落底。
4. **页眉页脚只做了页脚页码**，没有做页眉书名。页脚模板指定了「微软雅黑」字体，本机截图正常；换到没有中文字体的机器上打印，页脚中文可能变成方框（正文不受影响，正文用的是嵌入字体子集）。
5. **排版对浏览器版本敏感**。PDF 由 Chrome 154 生成，换浏览器或大版本升级，分页位置与页数都可能变化（内容不变）。
6. **单节导出没有封面、全书目录与署名页**，只有该节标题页与条目；`/Author` 元数据仍是「亦幸和幸知」。
7. **体积偏大**：整本 12.18 MB / 709 页，手机端阅读器可能吃力；文字之外的证据徽章是按图形绘制的，PDF 里没有做成可选文本层。
8. **页码检查依赖文本还原**：核实脚本对页脚文本的判据是「还原出的文字里出现『第 N 页』」，它证明文字存在，豆腐块与否靠截图肉眼确认（已做）。
9. **`/Author` 是增量更新写入的**：标准做法，常见阅读器都认；但如果某个阅读器只读第一份 trailer 而不跟 `/Prev`，它看到的 `/Author` 会是空。`/Title`、`/Lang` 不受影响。
10. **`--base` 只在本机模拟的「已部署站点」上验证过**（见第 12 节），没有对真实发布地址验证过；`--link-base` 也是声明式的，PDF 里的链接是否真的能打开，取决于那个网址上真的有这本书。

## 12. CI 边界（重要）

脚本已经为 CI 准备好，但**从未在 CI 上跑过**，以下是本机验证过的部分与未验证的部分：

| 项 | 状态 |
| --- | --- |
| 浏览器可执行文件可配置 | 已验证：`--browser <路径\|命令>`，或环境变量 `WRC_PDF_BROWSER` / `CHROME_PATH`；给命令名（如 `google-chrome`）时按 PATH 查找 |
| 自动探测候选路径 | 已验证 Windows 路径命中；Linux/macOS 候选（`/usr/bin/google-chrome`、`/usr/bin/chromium-browser`、`/snap/bin/chromium`、macOS 应用路径）只写进候选表，**本机无法验证** |
| 容器关沙箱 | 已实现 `--no-sandbox`（可同时用 `WRC_PDF_NO_SANDBOX=1`），加上 `--disable-dev-shm-usage`；**本机不需要也没开启，未验证** |
| `--base` 远程来源通道 | 已验证（用本机静态服务把 `dist/.site-public` 当「已部署站点」跑了一遍）：产物与本地来源完全同规模（12,775,567 字节 / 709 页）。**未对真实 GitHub Pages 验证** |
| 在 Ubuntu runner 上实际出 PDF | **未验证** |
| 前置条件 | CI 必须先构建站点产物（`node tools/build-site.mjs` + Hugo 生产构建）。脚本默认 `--site site/public`，CI 里如果构建到别的目录要用 `--site` 指过去 |
| 字体 | 本机中文来自 Windows 的微软雅黑；Ubuntu runner 上若没有中文字体，正文会缺字形。工作流需要先装中文字体（例如 `fonts-noto-cjk`）或把候选字体写进站点字体栈 |

CI 里期望的命令形态：

```bash
node tools/build-pdf.mjs --site site/public --browser google-chrome --no-sandbox --out dist/劳动者的账本.pdf
```

**这一行没有在真实 CI 上执行过，是照接口写的，不当作已验证结论。**

## 13. 本次构建的输入快照（便于复现与追责）

| 项 | 值 |
| --- | --- |
| 站点内容 | `node tools/build-site.mjs` → 15 节 324 页，`entries.json` 生成时刻 `2026-10-03 03:21:34` |
| 产物目录 | `dist/.site-public/`（`hugo --minify --baseURL /workers-ledger/ --ignoreCache -d ../dist/.site-public`） |
| 站点 baseURL 口径 | **路径前缀 `/workers-ledger/`**（子路径部署），站内链接形如 `/workers-ledger/01-…/` |
| 样式表 | `/workers-ledger/css/main.589e9d0f2f3813bb419f0edeb0bb580a94e5732b8871c3bb679167f790835b2d.css`，26,411 字节，SRI `sha256-WJ6dDy84E7tBnw7esLtYCpTlcyuIccO7Z5Fn95CDWy0=` 校验通过 |
| 打印源 | `dist/.print-source.html`（2.16 MB，本脚本合成；含首页全文 DOM，用于证明打印样式生效） |
| PDF 里的链接发布地址 | `https://hencter.github.io/workers-ledger/` |
| 并发写者 | 本机存在 `hugo server -D --disableFastRender`（未杀、未动）；作业期间观察到 `site/public/` 被改写两次，故全程使用独立产物目录 |

## 14. 复现检查清单

1. `node tools/build-site.mjs` 退出码 0，输出「15 节 324 页」。
2. `hugo --minify --baseURL /workers-ledger/ -d ../dist/.site-public` 退出码 0。
3. `node tools/build-pdf.mjs --site dist/.site-public` 退出码 0，输出 `dist/劳动者的账本.pdf`，页数 709。
4. 自检段打印四个 `display = none`，条目数 324。
5. `node tools/verify-pdf.mjs …` 退出码 0，整本 28/28 通过（`dist/.verify-full.txt` 可比对）。
6. 打开 `dist/.shots/` 里的截图，确认封面署名、目录、正文中文与页脚正常。
