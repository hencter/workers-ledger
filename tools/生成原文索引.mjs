// 从 sources/法规清单.md 机械抽出每部法规的官方 URL，生成 tools/原文索引.json。
// 手抄 URL 会引入与「凭记忆写法条号」同类的错误，所以这里一律机械抽取。
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync('sources/法规清单.md', 'utf8')
const lines = src.split('\n')

const records = []
for (const line of lines) {
  const m = /^\|\s*([A-Z]\d{2})\s*\|(.*)\|\s*$/.exec(line.trim())
  if (!m) continue
  const id = m[1]
  // 排除不是「依据」的两类编号——它们的表格也在清单里，行首同样形如 `| X01 |`，
  // 所以会被这个正则捞到，但**它们不该进原文索引**：
  //   P 开头 = 实践断言来源（清单二之三），例如统计报道；
  //   C 开头 = 求助与反馈渠道（清单二之四），例如热线与政务入口。
  // 捞进来的后果不是报错而是**做无用功且污染缓存**：`抽原文 --all` 会去抓
  // 12348、人社部门户这些页面，把它们当成法规原文存进缓存。
  // 判据与 tools/check-refs.mjs 检查项 2 的例外保持一致。
  if (/^[PC]\d{2}$/.test(id)) continue
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  // 列：编号 | 文件全称 | 制定机关 | 文号 | 现行版本 | 效力位阶 | 官方全文 URL | 核验状态
  const name = cells[1]
  const urlCell = cells.find((c) => /https?:\/\//.test(c)) || ''
  // 从这个登记的整行里抓 URL（URL 列可能不是第 7 列，因各节列数不同，故整行扫）
  const urls = [...new Set(
    (line.match(/https?:\/\/[^\s<>|)】，；]+/g) || [])
      .map((u) => u.replace(/[*_`"'.,;。，；、]+$/, '')),
  )]
  if (!urls.length) continue
  records.push({
    id,
    name,
    urls,
    来源行: line.trim().slice(0, 80),
    备注: urlCell ? '' : '（URL 不在独立列，已从整行抽取）',
  })
}

// 去重（同一编号只应出现一次）
const seen = new Set()
const unique = []
for (const r of records) {
  if (seen.has(r.id)) { console.error(`[警告] 编号重复：${r.id}`); continue }
  seen.add(r.id)
  unique.push(r)
}

writeFileSync('tools/原文索引.json', JSON.stringify({
  说明: '本文件由 tools/生成原文索引.mjs 从 sources/法规清单.md 机械生成，不要手改。清单换源后重新生成。',
  生成时间: new Date().toISOString(),
  记录: unique,
}, null, 2) + '\n', 'utf8')

console.log(`已生成 tools/原文索引.json：${unique.length} 条登记`)
let total = 0
for (const r of unique) { total += r.urls.length }
console.log(`URL 合计：${total} 个`)
console.log('')
for (const r of unique) {
  console.log(`${r.id}  ${r.name}`)
  for (const u of r.urls) console.log(`    ${u}`)
}
