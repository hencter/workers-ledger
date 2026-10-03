# 前端：站点从 `site/` 子目录平铺到仓库根

- 日期：2026-10-04
- 结论：**已迁移并全量验证通过**。仓库根现在就是 Hugo 项目根，`site/` 已不存在。
- 范围：只动**结构**（文件位置、路径常量、配置、CI 与活文档）。**没有改任何正文、条目字段、数值或来源**。
- 未做：EdgeOne Pages 线上重新部署未跑（需在平台侧触发）；GitHub Actions 未在本机执行。

> **同日后续：本记录提到的两个文件已被后续改动删除。** 第一节/第三节里
> `site/archetypes/` → `archetypes/` 的那一步**本身没有错**（archetype 就该在 Hugo 项目根的
> `archetypes/`，`--kind 条目` 实测命中它）；但同日晚些时候判定**这条路不值得留**，
> 于是 `archetypes/` 整个目录与 `tools/新建条目-archetype.mjs` 一并删除；
> 发布配置也由 `site.config.json` 并入 `hugo.toml`。理由与验证见
> `docs/核实记录/前端-发布配置并入hugo.toml-2026-10-04.md`。
> **路径平铺这一步没有回退**——仓库根仍然是 Hugo 项目根。

## 一、动了什么

| 迁移前 | 迁移后 | 说明 |
| --- | --- | --- |
| `site/hugo.toml` | `hugo.toml`（仓库根） | 唯一的站点配置。**旧根 `hugo.toml` 已删除**——它只是给 EdgeOne 检测用的占位文件，内容只有一句 `title` |
| `site/content/` | `content/` | 生成物，由 `tools/build-site.mjs` 掌管 |
| `site/data/` | `data/` | `entries.json`、`site.json` |
| `site/themes/ledger/` | `themes/ledger/` | 主题 |
| `site/static/` | `static/` | `CNAME`、`bingsiteauth.xml` |
| `site/assets/` | `assets/` | `jsconfig.json` |
| `site/archetypes/` | `archetypes/` | 条目模板 |
| `site/checks/` | `tools/checks/` | 站点侧断言脚本。**没有留在根目录**：`AGENTS.md` 已把 `tools/` 定义为校验脚本的家，另开一个与 `tools/` 平行的顶层目录只会让根目录更乱 |
| `site/public/` | `public/`（构建产物） | 已被 `.gitignore` 忽略，不进版本库 |
| `site/.gitignore` | 删除 | 内容并入根 `.gitignore`（`/public/`、`/resources/`、`.hugo_build.lock`、`.tmp-*/`） |

全部用 `git mv` 完成，历史连续（`git log --follow` 仍可追到迁移前的修改）。

## 二、为什么迁移

1. **路径干净。** EdgeOne Pages 判断「这是不是 Hugo 项目」的方式是扫描**项目根目录**下的 `hugo.toml` / `hugo.yaml` / `hugo.json` / `config.toml`。站点在 `site/` 下时根目录没有这些文件，于是根目录被放了一个只写 `title` 的占位 `hugo.toml`，`edgeone.json` 又用 `hugo --source site` 把构建指回子目录——**两处绕行只为绕开目录布局**。平铺之后这两处绕行都不需要了，`edgeone.json` 只剩两行。
2. **少一处版本陷阱。** 占位 `hugo.toml` 与实际配置分居两处，是这个仓库已经在部署平台上踩过坑的地方（见 `部署-EdgeOne版本坑.md`：平台预装 0.147.5，而站点需要 0.158+）。配置只有一个位置时，「改错了文件」这种可能不存在了。

## 三、代码与配置改动

**脚本路径常量（`ROOT` 语义变了，全部重新核对）**

| 文件 | 改动 |
| --- | --- |
| `tools/build-site.mjs` | `CONTENT_DIR`/`DATA_DIR` 直接挂 `ROOT` |
| `tools/check-site.mjs` | 索引与内容目录改读仓库根 |
| `tools/build-prod.mjs` | 构建目录从 `ROOT`（原来是 `site/`）；`cwd` 改为仓库根 |
| `tools/check-hugo-strict.mjs` | **删掉 `--source site`**；产物仍写 `.tmp-strict/`，不争 `public/` |
| `tools/build-offline.mjs` | 数据源改 `data/entries.json` |
| `tools/build-pdf.mjs` | 默认 `--site` 改 `public` |
| `tools/verify-pdf.mjs` | 默认 `--site` 改 `public` |
| `tools/体检.mjs` | 三个断言步骤改指 `tools/checks/*.mjs` |
| `tools/新建条目-archetype.mjs` | `ARCHETYPE_DIR` 改挂 `ROOT`；顺带删掉一条永远为真的 `existsSync(SITE)` 前置检查 |

**断言脚本（`site/checks/` → `tools/checks/`）**：六个脚本原本都用 `SITE = resolve(HERE,'..')`、`ROOT = resolve(SITE,'..')` 定位，多了一级嵌套。现在统一为 `ROOT = resolve(HERE,'..','..')`、产物目录 `ROOT/public`。
改这里时**踩到一个真实缺陷**：`render-check.mjs` 第 205 行还有一处 `path.join(SITE,'themes')`，第一次改名只按小写 `site` 检索，漏掉了大写常量 → 体检在「渲染断言」一步报 `ReferenceError: SITE is not defined`。修掉后重跑才全绿（见第五节）。**教训与 `--minify` 去掉属性引号那次同类：改名后要按标识符检索，不能只按字符串检索。**

**配置与 CI**

- `hugo.toml`（根）：加了一段说明它是仓库根唯一配置、以及占位文件为何消失。
- `edgeone.json`：`buildCommand` 去掉 `--source site`，`outputDirectory` 由 `site/public` 改为 `public`。
- `.gitignore`：`/public/`、`/resources/`、`/themes/*/content/` 改为**锚定到根**；`!content/`、`!data/` 同步。
- `.github/workflows/pages.yml`：删掉 `working-directory: site`（工作目录就是仓库根，`site.config.json` 相对路径可用）；产物路径与断言脚本路径同步。
- `.github/workflows/pdf-release.yml`：路径触发器 `site/hugo.toml`→`hugo.toml`、`site/themes/**`→`themes/**`；删掉 `working-directory: site`。

**活文档**：`README.md`、`AGENTS.md`、`docs/授权与使用.md` 的路径与授权范围表述同步（代码许可范围由 `tools/`、`site/` 改为 `tools/`、`themes/`）。

## 四、刻意没改的

- **历史核实记录不改写。** `docs/核实记录/前端-hugo站点.md`、`前端-PDF导出.md`、`前端-必应站长验证-2026-10-03.md`、`部署-EdgeOne版本坑.md` 等文件里的 `site/...` 是当时的现场记录，改写等于伪造留痕。只在 `部署-EdgeOne版本坑.md` 第四节前加了一句带日期的「后续」指引，指向本记录。
- **`index.html`（离线单文件版）没有重新生成。** 跑 `tools/build-offline.mjs` 会把它从 324 条刷新到 325 条（`book/` 已比它多一条）——**这是迁移前就存在的漂移，与本次迁移无关**，混进结构改动里会让「这次到底改了什么」说不清。验证路径可用后已 `git checkout -- index.html` 还原。**待办：另起一次提交重新生成离线页。**

## 五、验证（全部在本机执行）

按 `AGENTS.md` 的固定顺序，一条命令跑完：

```
node tools/体检.mjs --full
```

结果 **10 个步骤全绿**：

| 步骤 | 结果 |
| --- | --- |
| 结构校验 / 来源引用 / 脱敏扫描 | 通过（脱敏：硬命中 0 处） |
| 生成站点内容 | 通过：15 节 325 条 → `content/` 343 个文件 + `data/entries.json` |
| 生成物对账 | 通过：索引 325 条逐字段一致，提交的生成物与 `book/` 同步 |
| Hugo 严格构建 | 通过：0 WARN，348 页，版本行 `v0.167.0+extended` |
| 生产构建 | 通过：`D:\Projects\workers-ledger\public`，产物形态 6 项全过，canonical = `https://workersledger.cn/` |
| 渲染断言 | 116 项，不通过 0 |
| 语义与 SEO 断言 | 344/344 页，24407 项，不通过 0 |
| GEO 与授权断言 | 50 项，不通过 0 |

旁证三条：

- `hugo config`（仓库根）读到 `contentdir = 'content'`、`themesdir = 'themes'`、`publishdir = 'public'`、`title = '劳动者的账本'`——根 `hugo.toml` 确实被当成站点配置，不是占位文件。
- `node tools/build-pdf.mjs` 默认读到 `D:\Projects\workers-ledger\public`（不再需要 `--site`）：全本 PDF 1295 页、18.44 MB、25.0 秒生成成功，`node tools/verify-pdf.mjs` 对其 29/29 项断言全部通过（含「325 条条目标题一条不缺」）。
- `node tools/build-offline.mjs` 从 `data/entries.json` 正常读到 325 条并产出单文件（产物验证后已还原，见第四节）。

**验收前先停掉了并发写者。** 动手前本机有一个 `hugo server -D`（PID 42460）正写着旧的 `site/public`；按「`public/` 只能有一个写者」的约定先停掉它再迁移，否则旧进程会在 `site/` 已经不存在后重建目录，让根下留下垃圾并污染产物。

## 六、边界与缺口

1. **EdgeOne Pages 线上部署没有重跑。** `edgeone.json` 的两处改动是逻辑推断（`hugo` 在仓库根、`public` 在仓库根），本机用同一条命令形态验证过构建，但**平台侧的 Hugo 版本仍来自控制台环境变量 `HUGO_VERSION`，本次未动**。真实结论以平台构建日志为准。
2. **GitHub Actions 没有在本机执行。** `pages.yml` / `pdf-release.yml` 的改动只做了静态核对；工作流里的 shell 步骤（`working-directory` 移除后 `site.config.json` 变成相对路径）在本机以等价命令验证过读取，但没跑过 runner。
3. **全本 PDF 的 `verify-pdf.mjs` 校验属于旁证，不属于本仓库的固定门禁。** 判据要与输入匹配：全本产物 29/29 通过；拿**单节**产物去跑会大面积不通过（本次实测 18/30，不通过项全部是「全书范围」类断言——那是检测方式不匹配，不是缺陷）。
