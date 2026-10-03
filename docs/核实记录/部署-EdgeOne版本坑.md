# 部署平台：EdgeOne Pages 的 Hugo 版本坑

- 日期：2026-10-03
- 结论：**部署成功**。根因是平台预装 Hugo 版本过低，通过环境变量指定版本解决。
- 平台：腾讯 EdgeOne Pages（工作目录 `/dev/shm/repo/<repo>-<hash>/`，
  构建器日志前缀 `[StaticAssetsBuilder]`，输出中文日志）

## 一、现象

站点在本机（Hugo 0.167.0）构建正常，推到 EdgeOne Pages 后连续失败，
构建日志第一行**始终**是：

```
hugo v0.147.5-7766fc62416ff95ed7768c19947ac0fcd96444cc+extended linux/amd64
```

错误随尝试逐步变化，但都是「在 0.147.5 上访问 0.158+ 才有的 API」：

| 报错 | 缺的东西 | 引入版本 |
| --- | --- | --- |
| `can't evaluate field Locale in type *langs.Language` | `.Locale` 字段 | 0.158 |
| `can't evaluate field Build in type interface {}` | `css.Build` | 0.158 |

**关键判据**：日志第一行的 Hugo 版本才是根因。只看下面的模板报错会误判成
「模板写错了」，从而去改本来在 0.167 上完全正确的模板。**先看版本行。**

## 二、为什么指定版本的三次尝试都失败

官方文档（`https://pages.edgeone.ai/zh/document/hugo`）给出三级优先级：

| 优先级 | 方式 |
| --- | --- |
| 1（最高） | `edgeone.json` 的 `hugoVersion` 字段 |
| 2 | `HUGO_VERSION` 环境变量 |
| 3（最低） | 预装版本 v0.147.5 |

**第一级是无效的。** 实测把 `hugoVersion: "0.167.0"` 放进 `edgeone.json`
（位置、格式、git 跟踪都确认无误），连续三次部署日志仍显示 0.147.5。

原因在另一页文档里：`https://pages.edgeone.ai/zh/document/edgeone-json`
列出 `edgeone.json` 的**官方字段只有**
`buildCommand` / `installCommand` / `outputDirectory` / `nodeVersion` /
`redirects` / `rewrites` / `headers`——**没有 `hugoVersion`**。
它是该平台**文档不一致**：Hugo 页写了一个 `edgeone.json` 页不承认的字段，
而构建器按后者的 schema 解析，未知字段被丢弃。

**所以文档写「推荐使用」的字段反而是不生效的那个。** 这条要记住：
平台上「文档说了」和「实际生效」是两件事，必须用日志验证。

## 三、最终的解法

在 **Makers 控制台 → 项目设置 → 环境变量** 添加：

```
HUGO_VERSION = 0.167.0
```

部署成功。

**为什么锁 0.167.0 而不是最新版**：本地开发、`.github/workflows/pages.yml`、
`.github/workflows/pdf-release.yml`、`tools/build-pdf.mjs` 四处都锁在 0.167.0。
四处一致才能保证「本地过了、线上一样」。填最新版会引入新的版本漂移——
而本项目已经因为版本不一致连续踩了 `.Locale`、`css.Build` 两次。

> **后续（2026-10-04）：本节与第五节的做法已废除，保留为当时的现场记录。**
> 站点已从 `site/` 子目录平铺到仓库根，根目录现在**就是** Hugo 项目根：占位根 `hugo.toml` 已删除
> （真正的站点配置就落在根），`edgeone.json` 不再需要 `hugo --source site`，`outputDirectory`
> 也由 `site/public` 改为 `public`。迁移经过与验证见 `docs/核实记录/前端-site迁移到仓库根.md`。
> **本文件第一至三节、第十节的结论不受影响**（平台预装 0.147.5、`hugoVersion` 字段无效、
> 用控制台 `HUGO_VERSION` 锁 0.167.0、真实下限 0.158.0、extended 非必需——这些都仍然成立）。

## 四、另一件必须做的事：项目根要有 hugo.toml

EdgeOne 判断项目是否 Hugo 站点的方式是**扫描项目根目录**下的
`hugo.toml` / `hugo.yaml` / `hugo.json` / `config.toml`（Hugo 页「项目要求」一节）。
本站点在 `site/` 子目录里，根目录没有这些文件，**它可能压根没被识别为 Hugo 项目**。

因此仓库根新增了一个 `hugo.toml`，**内容只有一句 `title`**，并在文件里写明
它只用于平台检测、真正的站点配置唯一在 `site/hugo.toml`。
`edgeone.json` 的 `buildCommand` 用 `hugo --source site` 显式指向站点目录，
不依赖 `cd`（`cd` 依赖工作目录恰好在仓库根，`--source` 是 Hugo 自己的参数）。

已验证：根目录存在该文件时，`hugo --source site` 构建出的是真实站点
（344 页、标题「劳动者的账本」、canonical 与 CNAME 正确），未被占位文件影响。

## 五、`edgeone.json` 最终内容

```json
{
  "buildCommand": "hugo --source site --minify --baseURL https://workersledger.cn/",
  "outputDirectory": "site/public"
}
```

删掉了无效的 `hugoVersion`——无效字段留在配置里会误导后来人。

## 六、走错又退回的一条路（留痕）

曾尝试让模板**同时兼容 0.147 与 0.167**，在 `css.html` 里加资源拼接降级路径。
连踩三个坑，已全部 `git checkout` 回退：

1. 用来探测的 `isset $css "Build"` **无效**——在 0.167 上也返回 false，
   于是两条路径产物完全相同，等于把主路径也换成了降级实现
2. 降级产物文件名成了 `main.min.<指纹>.css`（`minify` 不指定 `targetPath`
   时会插入 `.min`），与 `build-prod.mjs`、`render-check.mjs` 要求的
   `main.<指纹>.css` 不匹配，构建校验报红
3. 期间遇到两次构建挂起。用最小复现证明**不是** `isset` 造成的

**教训**：能用环境变量把版本对齐时，跨版本兼容层就是不必要的复杂度。
回退比继续堆叠更接近正确——不该在没把握的地方持续加代码。

## 七、保留下来的唯一兼容改动：语言标识

`_partials/locale.html` 不再读 `site.Language.Locale`，改读 `params.locale`。

原因不只是「0.158 才有」：在 0.147.5 上访问该字段**连 `with` 都拦不住**——
报错是 `locale.html:10:9: can't evaluate field Locale`，即模板求值抛错，
而不是返回空值。第一版兼容写法就是栽在这里，结果把原本只坏一个渲染点的故障
（`baseof.html:2`）**扩大**到了 partial 内部。

`baseof.html` 的 `dir` 同时改为直接写 `"ltr"`，不再读
`site.Language.Direction`（本书只有简体中文，方向恒定；该字段在 0.158 前后
也在弃用搬迁中，用一个静态字面量换掉它少一处版本风险）。

## 八、同类问题会不会再出现

会。同一个站点的部署路径有四条，各自的 Hugo 版本必须一致：

| 路径 | 版本来源 | 当前值 |
| --- | --- | --- |
| 本地开发 | PATH 上的 hugo | 0.167.0 |
| GitHub Pages | `pages.yml` 的 `hugo-version` | 0.167.0 |
| GitHub Release PDF | `pdf-release.yml` 的 `hugo-version` | 0.167.0 |
| EdgeOne Pages | 控制台环境变量 `HUGO_VERSION` | 0.167.0 |

**新增任何部署目标时，第一件事是把 Hugo 版本对齐并写进该目标的配置。**
判断是否对齐的方法只有一个：看构建日志的版本行。

## 九、验证边界（哪些做了、哪些没做）

- **做了**：本机以 0.167.0 构建通过（344 页）；`edgeone.json` 的 buildCommand
  在仓库根实测通过；根 `hugo.toml` 不干扰真实构建（`hugo config --source site`
  读到的 title 仍是「劳动者的账本」）；十项校验 exit 0。
- **没做**：0.147.5 上的构建行为**无法在本机复现**（本机只有 0.167.0，
  且为 Windows，平台是 Linux）。因此「改完之后在 0.147.5 上也能构建」
  这一条**没有验证过**，只是通过避免使用 0.158+ 的 API 来规避。
  最终结论以用户那侧部署成功为准——那是唯一一次真实的环境验证。
  （**此缺口已于 2026-10-03 补测**，见第十节。）

## 十、版本下限与 extended 已实测（2026-10-03 补）

第九节记的那个缺口补上了一部分：**下载官方二进制在本机逐个真实构建**，不是查文档推断。

| Hugo 版本 | 结果 |
| --- | --- |
| 0.157.0 +extended | **失败**：`_partials/head/css.html: can't evaluate field Build in type interface {}` |
| 0.158.0 +extended | 通过，343 页 |
| 0.167.0 **非 extended** | 通过，343 页 |

三条结论：

1. **真实下限是 0.158.0。** 主题的 `[module.hugoVersion]` 原先写 `min = '0.146.0'`，**是错的**——0.157.0 就已经构建失败。已改为 `0.158.0`。
2. **`extended = false` 是对的。** 非 extended 的 0.167.0 构建出 343 页：本站样式走 `css.Build`（esbuild），标准版里就有，只有 SCSS 那类才需要 extended。`site/hugo.toml` 里「本机 Hugo v0.167.0 extended」的描述也一并改准了。
3. **`min` 只产生警告，不是门禁——不要把两者混淆。** 实测 0.157.0 上 Hugo 先打印
   `WARN  Module "ledger" is not compatible with this Hugo version: Min 0.158.0`，
   **然后照样往下构建**，再在 `css.Build` 处抛模板错。它的价值是把版本问题顶到输出最前面（正是第一节「先看版本行」那条教训），但要变成硬失败必须配合 `--panicOnWarning`；**该参数目前尚未纳入 `tools/体检.mjs`**，所以版本漂移在本地仍不会被自动拦住。

另记一个与版本无关的现象：其中一次 0.157.0 构建**挂起**（5 分钟无输出，已终止）。同一版本前后两次都能在 1 秒内退出，故属偶发，与第六节记的两次挂起同类。

**仍然没做的**：0.147.5 本身未在本机跑过——结论由「0.157.0 已失败」上推，且平台是 Linux。另外 `.Locale` 那一半成因已被消除：`_partials/locale.html` 现在完全不读语言对象，所以今天再用 0.147.5，唯一阻塞点会是 `css.Build`。
