#!/usr/bin/env node
// 从 data/entries.json 生成单文件离线检索页。
//
//   node tools/build-offline.mjs
//
// 为什么还要一个 index.html：Hugo 站点解决了「在线检索」，但有一类用法它接不住——
// 发到微信里、拷进手机、断网打开。单文件 HTML 双击就开、全文和检索都在里面，
// 不需要服务器，也不需要联网。这是同一份内容的第二种分发形态，不是重复建设：
// 数据源统一取 data/entries.json（它由 book/ 生成），所以不存在第三份正文。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SRC = join(ROOT, 'data', 'entries.json')
const OUT = join(ROOT, 'index.html')

if (!existsSync(SRC)) {
  console.error(`[环境错误] 找不到条目索引：${SRC}\n先跑 node tools/build-site.mjs`)
  process.exit(2)
}

const entries = JSON.parse(readFileSync(SRC, 'utf8'))
if (!Array.isArray(entries) || !entries.length) {
  console.error('[环境错误] 条目索引为空')
  process.exit(2)
}

// 统计：主张强度与举证难度分布，用于页面顶部的概览
const tally = (key) => entries.reduce((m, e) => {
  const v = (e[key] || '未标注').split(/[——（(]/)[0].trim() || '未标注'
  m[v] = (m[v] || 0) + 1
  return m
}, {})
const 主张 = tally('主张强度')
const 举证 = tally('举证难度')
const 最近核对 = entries.map((e) => e.核对日期 || '').filter(Boolean).sort().pop() || ''

// 内联数据。转义 </script 与行分隔符，避免提前闭合脚本块。
const payload = JSON.stringify(entries)
  .replace(/<\//g, '<\\/')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029')

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>劳动者的账本 · 离线检索</title>
<meta name="description" content="中国大陆劳动权益与合规的循证指南，单文件离线检索版。">
<style>
:root{
  --bg:#fbfaf8; --fg:#1c1a17; --muted:#6b6560; --line:#e3ded6; --card:#fff;
  --claim-strong:#1f7a4d; --claim-mid:#a8700a; --claim-weak:#6b6560;
  --proof-easy:#1f7a4d; --proof-mid:#a8700a; --proof-hard:#b3261e;
  --accent:#8a1c1c; --shadow:0 1px 2px rgba(0,0,0,.05),0 6px 18px rgba(0,0,0,.04);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#16151a; --fg:#e9e6e1; --muted:#a09a94; --line:#33313a; --card:#1e1d23;
    --claim-strong:#5cc98d; --claim-mid:#e0b054; --claim-weak:#a09a94;
    --proof-easy:#5cc98d; --proof-mid:#e0b054; --proof-hard:#ef7a72;
    --accent:#e08a8a; --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 18px rgba(0,0,0,.25);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--fg);
  font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
}
a{color:var(--accent)}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px 64px}
header h1{font-size:1.5rem;margin:0 0 6px;line-height:1.35}
header p{margin:0;color:var(--muted);font-size:.9rem}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:.82rem;box-shadow:var(--shadow)}
.stat b{font-size:1rem;display:block;line-height:1.3}
.controls{position:sticky;top:0;z-index:5;background:var(--bg);padding:12px 0;border-bottom:1px solid var(--line)}
.search{width:100%;padding:12px 14px;font-size:1rem;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);min-height:44px}
.search:focus{outline:2px solid var(--accent);outline-offset:1px}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip{
  border:1px solid var(--line);background:var(--card);color:var(--fg);
  border-radius:999px;padding:7px 13px;font-size:.82rem;cursor:pointer;min-height:36px;
  font-family:inherit;
}
.chip[aria-pressed=true]{background:var(--accent);color:#fff;border-color:var(--accent)}
.chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.fgroup{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px}
.fgroup>span{font-size:.78rem;color:var(--muted);min-width:5.5em}
.meta{color:var(--muted);font-size:.85rem;margin:14px 0}
.card{
  background:var(--card);border:1px solid var(--line);border-radius:12px;
  padding:16px;margin-bottom:12px;box-shadow:var(--shadow);
}
.card h2{font-size:1.06rem;margin:0 0 8px;line-height:1.5}
.card h2 .num{color:var(--muted);font-weight:400;margin-right:6px;font-variant-numeric:tabular-nums}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.badge{font-size:.76rem;border-radius:6px;padding:3px 8px;border:1px solid var(--line);color:var(--muted)}
.badge.claim-strong{color:var(--claim-strong);border-color:currentColor}
.badge.claim-mid{color:var(--claim-mid);border-color:currentColor}
.badge.claim-weak{color:var(--claim-weak);border-color:currentColor}
.badge.proof-easy{color:var(--proof-easy);border-color:currentColor}
.badge.proof-mid{color:var(--proof-mid);border-color:currentColor}
.badge.proof-hard{color:var(--proof-hard);border-color:currentColor;font-weight:600}
.badge.section{background:transparent}
.plain{margin:0 0 10px}
details{border-top:1px solid var(--line);padding-top:10px;margin-top:10px}
summary{cursor:pointer;font-size:.85rem;color:var(--muted);min-height:32px;display:flex;align-items:center}
summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.fields{margin:8px 0 0;display:grid;gap:8px}
.field{display:grid;grid-template-columns:5.5em 1fr;gap:10px;font-size:.88rem}
.field dt{color:var(--muted)}
.field dd{margin:0;overflow-wrap:anywhere}
.note{background:color-mix(in srgb,var(--claim-mid) 12%,transparent);border-left:3px solid var(--claim-mid);padding:8px 10px;border-radius:0 8px 8px 0;font-size:.86rem}
.empty{text-align:center;color:var(--muted);padding:40px 0}
footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.82rem}
@media (max-width:560px){
  .field{grid-template-columns:1fr;gap:2px}
  .wrap{padding:16px 12px 48px}
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>劳动者的账本</h1>
  <p>法律允许什么，是一回事；拿不拿得到，是另一回事。本页为单文件离线版，断网可用，双击即开。</p>
</header>

<div class="stats">
  <div class="stat"><b>${entries.length}</b>条目</div>
  <div class="stat"><b>${主张['可主张'] || 0}</b>可主张</div>
  <div class="stat"><b>${主张['可推定'] || 0}</b>可推定</div>
  <div class="stat"><b>${主张['倡导性'] || 0}</b>倡导性</div>
  <div class="stat"><b>${举证['难'] || 0}</b>举证难</div>
  <div class="stat"><b>${最近核对 || '—'}</b>最近核对</div>
</div>

<div class="controls">
  <input class="search" id="q" type="search" placeholder="搜索：关键词、法条、情形……（如「经济补偿」「工伤」「竞业限制」）" aria-label="搜索条目">
  <div class="filters" id="filters"></div>
  <div id="groups"></div>
  <p class="meta" id="meta"></p>
</div>

<main id="list"></main>

<footer>
  <p>正文以仓库 <code>book/</code> 下的 markdown 为唯一真相源，本页由 <code>tools/build-offline.mjs</code> 生成。条目里的「核对日期」是最后一次人工打开官方原文核对的日子，超过 180 天应视为待复核。</p>
  <p>本指南给通用口径，<b>不构成法律意见，不替代律师</b>。涉及具体案件、正在进行的仲裁或诉讼，请找执业律师或拨打 12333。</p>
</footer>
</div>

<script>
const DATA = ${payload};
const q = document.getElementById('q');
const list = document.getElementById('list');
const meta = document.getElementById('meta');
const filtersEl = document.getElementById('filters');
const groupsEl = document.getElementById('groups');

// 筛选维度：按证据判断的三个关键字段，加成本标签里最常被筛的两项
const DIMS = [
  {key:'主张强度', label:'主张强度'},
  {key:'举证难度', label:'举证难度'},
  {key:'效力位阶', label:'效力位阶'},
];
const COST = [
  {tag:'钱', label:'花费'},
  {tag:'时间', label:'时间'},
  {tag:'毅力', label:'毅力'},
];
const active = new Map(); // 维度 -> Set(取值)
const activeCost = new Map();

const clean = (v) => (v || '').split(/[——（(]/)[0].trim();
const values = (key) => {
  const s = new Set();
  DATA.forEach(e => { const v = clean(e[key]); if (v) s.add(v); });
  return [...s].sort();
};

// 顶部筛选条
DIMS.forEach(d => {
  const vals = values(d.key);
  if (vals.length < 2) return;
  const row = document.createElement('div');
  row.className = 'fgroup';
  row.innerHTML = '<span>' + d.label + '</span>';
  vals.forEach(v => {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.textContent = v;
    b.setAttribute('aria-pressed','false');
    b.onclick = () => {
      const set = active.get(d.key) || new Set();
      if (set.has(v)) set.delete(v); else set.add(v);
      if (set.size) active.set(d.key, set); else active.delete(d.key);
      b.setAttribute('aria-pressed', set.has(v) ? 'true' : 'false');
      render(); syncUrl();
    };
    row.appendChild(b);
  });
  groupsEl.appendChild(row);
});
COST.forEach(c => {
  const vals = [...new Set(DATA.map(e => (e.成本标签||{})[c.tag]).filter(Boolean))].sort();
  if (!vals.length) return;
  const row = document.createElement('div');
  row.className = 'fgroup';
  row.innerHTML = '<span>' + c.label + '</span>';
  vals.forEach(v => {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.textContent = v;
    b.setAttribute('aria-pressed','false');
    b.onclick = () => {
      const set = activeCost.get(c.tag) || new Set();
      if (set.has(v)) set.delete(v); else set.add(v);
      if (set.size) activeCost.set(c.tag, set); else activeCost.delete(c.tag);
      b.setAttribute('aria-pressed', set.has(v) ? 'true' : 'false');
      render(); syncUrl();
    };
    row.appendChild(b);
  });
  groupsEl.appendChild(row);
});

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

function match(e, term) {
  if (!term) return true;
  const hay = [e.标题, e.说人话, e.成本, e.收益, e.依据, e.备注, e.适用, e.时效, e.地域, e.节名].join(' ').toLowerCase();
  return term.toLowerCase().split(/\\s+/).every(t => hay.includes(t));
}

function render() {
  const term = q.value.trim();
  const rows = DATA.filter(e => {
    for (const [k, set] of active) if (!set.has(clean(e[k]))) return false;
    for (const [tag, set] of activeCost) if (!set.has((e.成本标签||{})[tag])) return false;
    return match(e, term);
  });

  list.textContent = '';
  if (!rows.length) {
    const d = el('div','empty','没有匹配的条目。试试减少筛选条件，或换一个关键词。');
    list.appendChild(d);
  }
  rows.forEach(e => list.appendChild(card(e)));
  meta.textContent = '显示 ' + rows.length + ' / ' + DATA.length + ' 条' + (term ? '（关键词：「' + term + '」）' : '');
}

function card(e) {
  const c = el('article','card');
  const h = el('h2');
  h.appendChild(el('span','num', e.节号 + '.' + e.条号));
  h.appendChild(document.createTextNode(e.标题));
  c.appendChild(h);

  const b = el('div','badges');
  b.appendChild(el('span','badge section', '第 ' + e.节号 + ' 节 · ' + e.节名));
  if (e.主张强度) b.appendChild(el('span','badge ' + claimClass(e.主张强度), '主张强度：' + clean(e.主张强度)));
  if (e.举证难度) b.appendChild(el('span','badge ' + proofClass(e.举证难度), '举证难度：' + clean(e.举证难度)));
  if (e.效力位阶) b.appendChild(el('span','badge', e.效力位阶));
  if (e.核对日期) b.appendChild(el('span','badge', '核对 ' + e.核对日期));
  c.appendChild(b);

  if (e.说人话) c.appendChild(el('p','plain', e.说人话));

  const det = el('details');
  det.appendChild(el('summary', null, '展开全部字段（成本 / 收益 / 依据 / 时效 / 来源 / 备注）'));
  const dl = el('dl','fields');
  [['适用',e.适用],['成本',e.成本],['收益',e.收益],['依据',e.依据],['时效',e.时效],['地域',e.地域],['来源',e.来源],['备注',e.备注]]
    .forEach(([k,v]) => {
      if (!v) return;
      const row = el('div','field');
      row.appendChild(el('dt', null, k));
      const dd = el('dd');
      if (k === '备注' || k === '来源') {
        const n = el('div', k === '备注' ? 'note' : '', v);
        dd.appendChild(n);
      } else {
        dd.textContent = v;
      }
      row.appendChild(dd);
      dl.appendChild(row);
    });
  det.appendChild(dl);
  c.appendChild(det);
  return c;
}

function claimClass(v) {
  const s = clean(v);
  return s === '可主张' ? 'claim-strong' : s === '可推定' ? 'claim-mid' : 'claim-weak';
}
function proofClass(v) {
  const s = clean(v);
  return s === '易' ? 'proof-easy' : s === '中' ? 'proof-mid' : 'proof-hard';
}

// 筛选用 URL query 保存，便于分享
function syncUrl() {
  const p = new URLSearchParams();
  if (q.value.trim()) p.set('q', q.value.trim());
  for (const [k,set] of active) if (set.size) p.set(k, [...set].join(','));
  for (const [t,set] of activeCost) if (set.size) p.set('成本' + t, [...set].join(','));
  const s = p.toString();
  history.replaceState(null, '', s ? '?' + s : location.pathname);
}
q.addEventListener('input', () => { render(); syncUrl(); });

// 初始化：从 URL 恢复状态
(function init(){
  const p = new URLSearchParams(location.search);
  if (p.get('q')) q.value = p.get('q');
  for (const [k,v] of p) {
    if (k === 'q') continue;
    if (k.startsWith('成本')) activeCost.set(k.slice(2), new Set(v.split(',')));
    else active.set(k, new Set(v.split(',')));
  }
  // 恢复按钮态
  document.querySelectorAll('.chip').forEach(btn => {
    const label = btn.textContent;
    const row = btn.parentElement;
    const dim = row.firstElementChild.textContent;
    let on = false;
    if (dim === '主张强度' || dim === '举证难度' || dim === '效力位阶') {
      const set = active.get(dim); on = !!(set && set.has(label));
    } else {
      const tag = dim === '花费' ? '钱' : dim;
      const set = activeCost.get(tag); on = !!(set && set.has(label));
    }
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
})();

render();
</script>
</body>
</html>
`

writeFileSync(OUT, html, 'utf8')
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0)
console.log(`已生成 ${OUT}`)
console.log(`  ${entries.length} 条，单文件 ${kb} KB`)
console.log(`  主张强度分布：${Object.entries(主张).map(([k, v]) => `${k} ${v}`).join(' / ')}`)
console.log(`  举证难度分布：${Object.entries(举证).map(([k, v]) => `${k} ${v}`).join(' / ')}`)
console.log(`  最近核对日期：${最近核对}`)
