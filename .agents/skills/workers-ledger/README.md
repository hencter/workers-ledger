# 用 AI 照这本书回答

这本书是《劳动者的账本》。

装了这个 skill，AI 助手回答劳动权益问题时会**先查这本书的条目，再作答**，并注明出自第几节第几条。查不到就说查不到，不凭记忆编法条号、金额和期限。

> 下文用 `hencter` 代指托管账号，用 `workers-ledger` 代指仓库名。**发布前请把这两处替换成实际值**，否则克隆命令会失败。

## 它和普通对话有什么不同

普通对话里问「被裁了能拿多少」，AI 会给你一段听起来合理的话。装上这个 skill 之后，它会：

1. 先定位到相关节（例如第 5 节「离职与补偿」、第 14 节「仲裁与诉讼实操」）；
2. 把条目捞出来**整条读完**，包括「备注」栏里的例外和地方口径差异；
3. 回答时把每条自带的 **主张强度**（可主张／可推定／倡导性）、**举证难度**（易／中／难）、**时效与起算点** 原样带出来；
4. 书里没写的，明确告诉你书里没写。

第三点是关键。同样一句「法律支持你」，背后可能是「有条文、有强制通道、证据好取」，也可能是「有条文、但各地口径不一、证据在离职后就取不出来了」。这个 skill 的作用就是把这两种情形区分开。

## 安装

### 支持项目级 skill 目录的 agent（DSH 等）

克隆仓库即可，**不用安装**：DSH 会把 `<项目根>/.agents/skills/` 当作项目级 skill 目录
自动发现，在仓库里开会话就能直接触发。这也是本 skill 放在 `.agents/skills/` 而不是
`skills/` 的原因——后者不在任何 agent 的默认发现路径上。

### Claude Code

```bash
# 克隆到一个固定位置
git clone https://github.com/hencter/workers-ledger.git ~/.claude/skills/workers-ledger
```

或者只把这个 skill 目录取出来：

```bash
mkdir -p ~/.claude/skills
git clone --depth 1 --filter=blob:none --sparse https://github.com/hencter/workers-ledger.git /tmp/wrcn
cd /tmp/wrcn && git sparse-checkout set .agents/skills/workers-ledger
cp -r .agents/skills/workers-ledger ~/.claude/skills/
```

**Windows** 对应路径是 `%USERPROFILE%\.claude\skills\`。

装好后重启会话，问一句「被裁了能拿多少」验证是否生效。如果 AI 的回答里出现了「第 X 节第 Y 条」这样的出处，就装对了。

### Codex

把 `SKILL.md` 放到 Codex 读取技能的位置（各版本目录约定不同），或直接把这段加进你的项目说明文件：

```
回答劳动权益问题时，先读 .agents/skills/workers-ledger/SKILL.md 并按其步骤执行：
先查 book/ 下的条目，整条读完再答，每条注明出自第几节第几条；
主张强度、举证难度、时效起算点照抄条目；查不到就说查不到。
```

## 它在哪取正文

**默认走云端**，不要求本地有仓库、也不要求 GitHub 可达：

| 步骤 | 请求 | 体积 |
| --- | --- | --- |
| 1. 读站点说明，拿到各节**已编码的 URL** | `https://workersledger.cn/llms.txt` | 约 6 KB |
| 2. 抓目标节的条目索引（13 个字段 + 条目页 URL） | `https://workersledger.cn/NN-节名/entries.json` | 24–84 KB |
| 3. 需要原始页面时 | 用条目自带的 `url` 字段 | — |

**别抓这三样**（本机实测字节数）：整站 `/entries.json` 866 KB、节页 HTML 252 KB、
单个条目页 HTML 167 KB —— 前两个会把上下文撑爆，第三个读一条却要付整站的代价。

**不依赖 GitHub**：`raw.githubusercontent.com` 在部分网络下 TLS 握手会失败，浅克隆还需要
git 与可达的 GitHub。云端站点是唯一必须可用的路径。

**本地模式更快**：工作区里就有 `book/` 时直接读本地文件，省一次网络往返（SKILL.md 第 1 步
给了两种模式的判据）。

## 边界

- 本书给**通用口径**，不构成法律意见，不替代执业律师。涉及具体案件、正在进行的仲裁或诉讼，请找律师或拨打 12333。
- 条目里的「核对日期」是最后一次人工打开官方原文核对的日子。政策、金额、地方标准可能已变，**以官方最新发布为准**。
- 正文目前覆盖中国大陆的劳动权益与合规，**地方经办口径（社保缴费基数上下限、最低工资、公积金比例、失业金标准）需要向参保地经办机构或 12333 确认**，书里的通用口径替代不了本地口径。

## 贡献

发现 AI 援引的条文有误、或者它答错了，问题多半在正文条目上。请到仓库提 issue，附上「哪一节哪一条 + 应该是什么 + 官方依据」。格式与要求见仓库根的 [CONTRIBUTING.md](../../CONTRIBUTING.md)。
