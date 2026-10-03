# 前端：发布配置并入 `hugo.toml`，删除 `site.config.json` 与 `archetypes/`

- 日期：2026-10-04
- 结论：**`site.config.json`、`data/site.json`、`archetypes/`（含 `条目.md`、`default.md`）、`tools/新建条目-archetype.mjs` 已删除**；发布配置并入 `hugo.toml`；发布地址的读取收拢到 `tools/lib/发布地址.mjs`。全量体检 10 步全绿。
- 范围：配置与脚本结构。**没有改任何正文、条目字段、数值或来源。**

## 一、为什么 `site.config.json` 可以删

它当初存在的理由只有一个，写在原 `build-site.mjs` 的注释里：

> 不写进 hugo.toml：那会出现**第二个真相源**……也不用 `resources.Get`——实测读不到仓库根的文件。生成一份 data 最稳。

也就是说：**模板读不到站点根之外的文件**，所以才有「`site.config.json` → `build-site.mjs` 生成 `data/site.json` → `site-config.html` 读 `hugo.Data.site`」这四道转手。而配置一旦并进 `hugo.toml`，**Hugo 自己就是那个文件**，模板直接 `site.BaseURL` / `site.Params.repo` 就够，转手和它存在的理由一起消失。

同时删掉的还有它带来的一处脏东西：JSON 不能写注释，所以那个文件用 `"//domain"` 这类**注释键**存说明，而 `build-site.mjs` 必须 `if (!k.startsWith('//'))` 把它们过滤掉。并进 TOML 后注释就是注释。

### 映射表

| 原 `site.config.json` | 现在在哪 | 谁用 |
| --- | --- | --- |
| `publishUrl` | `hugo.toml` 的 **`baseURL`**（Hugo 原生字段） | 模板（canonical / OG / sitemap）+ `tools/lib/发布地址.mjs` |
| `repo` | `hugo.toml` 的 **`[params] repo`** | `site-config.html` → 页脚仓库链接、纠错预填 |
| `domain` | **删除** | 全仓无使用者；`static/CNAME` 本身就是域名的事实声明 |
| `hosting` | **删除** | 全仓无使用者（只是个说明字段） |

## 二、读取收拢：新增 `tools/lib/发布地址.mjs`

此前 `publishUrl` 在 **4 个脚本里各写一份**「读 site.config.json」，且兜底值是一个**错的地址**（`https://hencter.github.io/workers-ledger/`——绑了自定义域名后它是另一个站）。README 里记着「改一次漏一处就会让 canonical 指向 404，已经发生过一次」。

现在只有一个入口：

- `publishUrl()` —— 优先级：`WRC_BASE_URL` 环境变量 → `hugo config --format json` 的 `baseurl` → 兜底常量（真实域名，仅当 hugo 不可用）。
- `hugoConfig()` —— 完整配置，供断言脚本读 `params`。
- Node 侧**不自己解析 TOML**，而是让 Hugo 输出 JSON。这是选它的原因：Node 24 **没有内置 TOML/YAML 解析**（实测 `require('node:toml')` / `node:yaml` 均不可用），自己写解析器不值当。

改用它的地方：`build-prod.mjs`、`check-hugo-strict.mjs`、`build-pdf.mjs`、`verify-pdf.mjs`、`tools/checks/geo-check.mjs`。

## 三、CI 改动（两处，同一个决定）

`pages.yml` 与 `pdf-release.yml` 原先都是「优先读 `site.config.json` 的 publishUrl，读不到就按仓库名推导」。改成一律读 `hugo.toml` 的 `baseURL`：

```bash
base=$(hugo config --format json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).baseurl||''))")
```

**为什么拿掉「按仓库名推导」**：绑了自定义域名后，推导出来的 `https://hencter.github.io/workers-ledger/` 与真实域名冲突，canonical 会指向另一个站。推导本来只是「没有配置时的兜底」，现在配置永远存在，兜底就成了隐患。读不到时**直接失败**，不再猜。

## 四、为什么删 `archetypes/`

两条理由叠加：

1. **它指向的那条路已经没人走。** 全仓唯一的使用者是 `tools/新建条目-archetype.mjs`，而它的做法是「建临时 Hugo 项目 → 把 `archetypes/条目.md` 复制进去 → `hugo new content --kind 条目` 渲染 → 再把结果转回条目格式」。这条路实测**可行**，但它为同一份模板维护两套定义（`tools/lib/条目规范.mjs` 的 `renderEntry()` 与 archetype），收益为零。
2. **它从头到尾没被 Hugo 直接用过。** 正文真相源是 `book/`，不在 `contentDir` 里，`hugo new` 只能往 `content/` 写，而那里每次生成都被整体重建。Hugo 出厂的 `default.md` 在本仓库**没有任何调用路径**。

> 顺带说明：上一份记录把 `site/archetypes/` 平铺成了根 `archetypes/`（那一步只是路径搬迁，位置本身符合 Hugo 规范——archetype 就该在项目根的 `archetypes/`，`--kind 条目` 命中的是 `archetypes/条目.md`，本机实测渲染成功）。**位置没错，是这条路不值得留。**

### 归档：这套 archetype 的实测细节（备查）

删掉的只是文件和一条捷径，实测结论留在这里，将来要恢复不必重跑：

- `hugo new content <路径> --kind 条目` 命中 **`archetypes/条目.md`**；不指定 `--kind` 时退回 `archetypes/default.md`，**没有 `default.md` 也能工作**（Hugo 用内置空 front matter 生成 `title`/`date`/`draft`，实测通过）。
- **`hugo new content` 要求 `content/` 目录已存在**，否则报 `no existing content directory configured for this project`（这也是当年 `hugo new -c book` 失败的同一条报错）。
- `hugo new` 渲染 archetype 时可用的字段（Hugo v0.167.0 实测）：`.Name`、`.File.BaseFileName/.ContentBaseName/.TranslationBaseName/.Path/.Dir/.LogicalName/.Ext`、`.Date`、`now`、`.Type`、`.Section`、`.Site.Title`；**不可用**：`.Title`（那是模板函数）、`.Kind`、`.Date.Year`。
- 同一批实验顺带确认了一条与本仓库有关的格式约束：**TOML 的表名与键名都不能用中文裸写**。`[[条目]]` 直接报 `invalid character at start of key: U+00E6`，必须写成 `[["条目"]]`、`"标题" = "…"`。这也是"机器数据继续用 JSON"的一个依据（见 `docs/核实记录/` 之外的口头结论：JSON 的引号是标准写法，TOML 的引号是额外负担）。

## 五、验证

```
node tools/体检.mjs --full
```

**10 个步骤全绿**：

| 步骤 | 结果 |
| --- | --- |
| 结构校验 / 来源引用 / 脱敏扫描 | 通过 |
| 生成站点内容 / 生成物对账 | 通过（`data/entries.json` 重新生成，与 `book/` 一致；`data/site.json` 已不再产出） |
| Hugo 严格构建 | **0 WARN**（若模板仍读 `hugo.Data.site` 或误用 `site.Data`，这一步会红） |
| 生产构建 | `public/`，产物形态 6 项全过，canonical = `https://workersledger.cn/` |
| 渲染断言 | 116 项，不通过 0 |
| 语义与 SEO 断言 | 344/344 页，24407 项，不通过 0 |
| GEO 与授权断言 | 50 项，不通过 0（含「产物页脚含仓库链接」「仓库链接覆盖全部页面」——证明 `params.repo` 这条路真的通） |

另外：

- `node --check` 跑过 `tools/` 下全部 **33 个脚本**，0 语法错误。
- 读取入口单独验过：`publishUrl()` 返回 `https://workersledger.cn/`，`hugoConfig().params.repo` 返回 `hencter/workers-ledger`。
- `node tools/新建条目.mjs --help` 正常（内置模板一路不受影响）。

## 六、边界与未做

1. **CI 没有实跑。** 两个 workflow 的改动只做了静态核对与本机等价命令验证（`hugo config --format json` 的读取方式在本机跑通），没有跑过 runner。
2. **EdgeOne Pages 没有重新部署。** 它的构建不需要 Node，`hugo.toml` 在根、`public/` 在根，形态未变。
3. **`hugo config --format json` 成了多处脚本的隐式依赖**：hugo 不可用时 `publishUrl()` 会退回兜底常量并打印警告。CI 与本机都在安装 Hugo 之后才调用它，顺序没问题；但**新增任何读取发布地址的脚本都应走 `tools/lib/发布地址.mjs`，不要再自己读配置**。
