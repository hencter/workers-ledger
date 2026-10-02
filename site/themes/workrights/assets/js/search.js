/* 首页检索与多维筛选。
   数据源：首页的 JSON 输出格式（默认路径 /entries.json），字段已由模板归一化。
   纯前端实现，无后端、无外部依赖；筛选状态写在 URL query 里，便于分享与回退。 */

import { applyStale } from './stale.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

/** 文本归一化：小写、全角空格与连续空白压平 */
export function normalize(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
}

/** 成本标签取值的人话解释，取自 docs/条目规范.md 的取值说明 */
const COST_LABELS = {
  钱: { 0: '不花钱', 少: '几十到几百元', 多: '上千元或长期支出' },
  时间: { 少: '一次几分钟', 中: '数小时 / 每周小时级', 多: '每天持续占用' },
  毅力: { 否: '做一次就完', 些: '改一个习惯', 是: '长期对抗惯性' },
  收益: { 大: '收益大', 中: '收益中', 小: '收益小' },
  口径: { 金钱: '换回钱', 时间: '换回时间', 自由: '换回自由', 健康: '换回健康' },
}

const COST_ORDER = {
  钱: ['0', '少', '多'],
  时间: ['少', '中', '多'],
  毅力: ['否', '些', '是'],
  收益: ['大', '中', '小'],
  口径: ['金钱', '时间', '自由', '健康'],
}

const CLAIM_ORDER = ['可主张', '可推定', '倡导性']
const PROOF_ORDER = ['易', '中', '难']
const RANK_ORDER = ['法律', '行政法规', '部门规章', '地方性法规', '司法解释', '规范性文件', '地方口径', '无明文依据']

const claimClass = (v) => ({ 可主张: 'claim-strong', 可推定: 'claim-mid', 倡导性: 'claim-weak' }[v] || 'claim-weak')
const proofClass = (v) => ({ 易: 'proof-easy', 中: 'proof-mid', 难: 'proof-hard' }[v] || 'proof-mid')
const proofLevel = (v) => ({ 易: 1, 中: 2, 难: 3 }[v] || 0)

const tag = (entry, key) => {
  const t = entry['成本标签'] || {}
  return t[key] == null ? '' : String(t[key])
}

/** 筛选维度定义。get 返回该条目在这个维度上的全部取值（数组）。 */
export const FACETS = [
  {
    key: 'sec',
    label: '节',
    hint: '按章节收窄',
    get: (e) => [String(e['节号'])],
    labelOf: (e) => `${e['节号']}. ${e['节名']}`,
    order: null,
  },
  {
    key: 'claim',
    label: '主张强度',
    hint: '能不能真拿到手',
    get: (e) => [String(e['主张强度'] || '')].filter(Boolean),
    swatch: (v) => claimClass(v),
    order: CLAIM_ORDER,
  },
  {
    key: 'proof',
    label: '举证难度',
    hint: '证据好不好取',
    get: (e) => [String(e['举证难度'] || '')].filter(Boolean),
    swatch: (v) => proofClass(v),
    order: PROOF_ORDER,
  },
  {
    key: 'rank',
    label: '效力位阶',
    hint: '依据在裁审面前的地位',
    get: (e) => (e['效力位阶全部'] || []).map(String),
    order: RANK_ORDER,
  },
  { key: 'money', label: '成本·钱', get: (e) => [tag(e, '钱')].filter(Boolean), order: COST_ORDER['钱'] },
  { key: 'time', label: '成本·时间', get: (e) => [tag(e, '时间')].filter(Boolean), order: COST_ORDER['时间'] },
  { key: 'grit', label: '成本·毅力', get: (e) => [tag(e, '毅力')].filter(Boolean), order: COST_ORDER['毅力'] },
  { key: 'gain', label: '成本·收益', get: (e) => [tag(e, '收益')].filter(Boolean), order: COST_ORDER['收益'] },
  { key: 'scope', label: '成本·口径', get: (e) => [tag(e, '口径')].filter(Boolean), order: COST_ORDER['口径'] },
]

/** 解析 URL query 成筛选取值 */
export function parseState(search) {
  const params = new URLSearchParams(search || '')
  const facets = {}
  for (const facet of FACETS) {
    facets[facet.key] = params.getAll(facet.key).map(normalize).filter(Boolean)
  }
  return { q: params.get('q') || '', facets }
}

/** 把筛选状态写回查询串 */
export function toQuery(state) {
  const params = new URLSearchParams()
  if (state.q) params.set('q', state.q)
  for (const facet of FACETS) {
    for (const v of state.facets[facet.key] || []) params.append(facet.key, v)
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

/** 该条目是否满足全部筛选条件：关键词与各维度之间是「且」，维度内多选是「或」 */
export function matches(entry, state) {
  if (state.q) {
    const terms = normalize(state.q).split(' ').filter(Boolean)
    if (terms.length) {
      if (!entry.__hay) {
        entry.__hay = normalize([
          entry['节名'], entry['标题'], entry['说人话'], entry['适用'], entry['成本'],
          entry['收益'], entry['依据'], entry['备注'], entry['主张强度原文'],
          entry['效力位阶原文'], entry['举证难度说明'], entry['地域'], entry['时效'],
        ].join(' '))
      }
      if (!terms.every((t) => entry.__hay.includes(t))) return false
    }
  }
  for (const facet of FACETS) {
    const selected = state.facets[facet.key] || []
    if (!selected.length) continue
    const values = facet.get(entry).map(normalize)
    if (!selected.some((s) => values.includes(s))) return false
  }
  return true
}

function el(tagName, props = {}, children = []) {
  const node = document.createElement(tagName)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (k === 'hidden') node.hidden = Boolean(v)
    else node.setAttribute(k, v)
  }
  for (const c of [].concat(children)) if (c) node.append(c)
  return node
}

/** 把命中的关键词包进 <mark>，返回文档片段（全程走文本节点，不拼 HTML） */
function highlight(text, query) {
  const frag = document.createDocumentFragment()
  const source = String(text || '')
  const terms = normalize(query).split(' ').filter((t) => t.length > 0)
  if (!terms.length) {
    frag.append(source)
    return frag
  }
  const lower = source.toLowerCase()
  let i = 0
  while (i < source.length) {
    let hit = -1
    let hitLen = 0
    for (const t of terms) {
      const at = lower.indexOf(t, i)
      if (at >= 0 && (hit < 0 || at < hit || (at === hit && t.length > hitLen))) {
        hit = at
        hitLen = t.length
      }
    }
    if (hit < 0) {
      frag.append(source.slice(i))
      break
    }
    if (hit > i) frag.append(source.slice(i, hit))
    const mark = document.createElement('mark')
    mark.textContent = source.slice(hit, hit + hitLen)
    frag.append(mark)
    i = hit + hitLen
  }
  return frag
}

function optionLabel(facet, value, sample) {
  if (facet.key === 'sec' && sample) return `${value}. ${sample['节名']}`
  if (COST_LABELS[facet.key] && COST_LABELS[facet.key][value]) return COST_LABELS[facet.key][value]
  return value
}

function sortOptions(facet, options) {
  if (!facet.order) return options.sort((a, b) => Number(a.value) - Number(b.value))
  const idx = (v) => {
    const i = facet.order.indexOf(v)
    return i < 0 ? facet.order.length : i
  }
  return options.sort((a, b) => idx(a.value) - idx(b.value))
}

/** 计算各选项当前命中的条数：统计时排除本维度自身的选择 */
function countOptions(entries, state, facet, options) {
  const base = { q: state.q, facets: { ...state.facets, [facet.key]: [] } }
  const pool = entries.filter((e) => matches(e, base))
  const out = {}
  for (const opt of options) {
    out[opt.value] = pool.filter((e) => facet.get(e).map(normalize).includes(normalize(opt.value))).length
  }
  return out
}

export function initSearch() {
  const root = $('[data-search-app]')
  if (!root) return null

  const indexURL = root.dataset.indexUrl
  const pageSize = Number(root.dataset.pageSize || 40)
  const facetsRoot = $('[data-facets]', root)
  const appliedRoot = $('[data-applied]', root)
  const resultsRoot = $('[data-results]', root)
  const countRoot = $('[data-count]', root)
  const moreBtn = $('[data-more]', root)
  const input = $('[data-query]', root)
  const clearBtn = $('[data-clear]', root)
  const tpl = document.getElementById('entry-card-tpl')

  let entries = []
  let state = parseState(window.location.search.slice(1))
  let limit = pageSize
  let facetOptions = {}

  function buildFacets() {
    facetsRoot.textContent = ''
    for (const facet of FACETS) {
      const seen = new Map()
      for (const e of entries) {
        for (const v of facet.get(e)) {
          const value = String(v)
          if (!value) continue
          if (!seen.has(value)) seen.set(value, e)
        }
      }
      let opts = Array.from(seen, ([value, sample]) => ({ value, sample }))
      if (!opts.length) continue
      opts = sortOptions(facet, opts)
      opts = opts.map((o) => ({ ...o, label: optionLabel(facet, o.value, o.sample) }))
      facetOptions[facet.key] = opts

      const group = el('fieldset', { class: 'facet' })
      const legend = el('legend', { class: 'facet__legend' }, [
        el('b', { text: facet.label }),
        facet.hint ? el('span', { text: facet.hint }) : null,
      ])
      const optsBox = el('div', { class: 'facet__opts', dataset: { facet: facet.key } })
      for (const opt of opts) {
        const label = el('label', { class: 'facet__opt', dataset: { value: opt.value } })
        const cb = el('input', { type: 'checkbox', value: opt.value })
        cb.dataset.facet = facet.key
        label.append(cb)
        if (facet.swatch) label.append(el('span', { class: `dot dot--${facet.swatch(opt.value)}` }))
        label.append(el('span', { class: 'facet__t', text: opt.label }))
        label.append(el('span', { class: 'facet__n', text: '' }))
        optsBox.append(label)
      }
      group.append(legend, optsBox)
      facetsRoot.append(group)
    }
  }

  function syncInputsFromState() {
    for (const cb of $$('input[type="checkbox"]', facetsRoot)) {
      cb.checked = (state.facets[cb.dataset.facet] || []).includes(normalize(cb.value))
      cb.closest('.facet__opt').classList.toggle('is-on', cb.checked)
    }
    if (input) input.value = state.q
    if (clearBtn) clearBtn.hidden = !(state.q || FACETS.some((f) => (state.facets[f.key] || []).length))
  }

  function readStateFromInputs() {
    const facets = {}
    for (const facet of FACETS) facets[facet.key] = []
    for (const cb of $$('input[type="checkbox"]', facetsRoot)) {
      if (cb.checked) facets[cb.dataset.facet].push(normalize(cb.value))
    }
    state = { q: input ? input.value.trim() : '', facets }
  }

  function updateFacetCounts() {
    for (const facet of FACETS) {
      const opts = facetOptions[facet.key]
      if (!opts) continue
      const counts = countOptions(entries, state, facet, opts)
      const box = $(`[data-facet="${facet.key}"]`, facetsRoot)
      if (!box) continue
      for (const label of $$('.facet__opt', box)) {
        const n = counts[label.dataset.value] || 0
        label.dataset.count = String(n)
        const nEl = $('.facet__n', label)
        if (nEl) nEl.textContent = n ? String(n) : ''
      }
    }
  }

  function renderApplied() {
    appliedRoot.textContent = ''
    const chips = []
    if (state.q) {
      chips.push({ label: `关键词：${state.q}`, facet: null, value: null })
    }
    for (const facet of FACETS) {
      for (const value of state.facets[facet.key] || []) {
        let text = value
        const opts = facetOptions[facet.key] || []
        const found = opts.find((o) => normalize(o.value) === value)
        if (found) text = found.label
        chips.push({ label: `${facet.label}：${text}`, facet: facet.key, value })
      }
    }
    appliedRoot.append(el('span', { class: 'applied__k', text: '已选条件' }))
    if (!chips.length) {
      appliedRoot.append(el('span', { class: 'applied__none', text: '无（当前显示全部条目）' }))
      return
    }
    for (const chip of chips) {
      const btn = el('button', { class: 'applied__chip', type: 'button' }, [
        el('span', { text: chip.label }),
        el('i', { text: '×' }),
      ])
      btn.addEventListener('click', () => {
        if (chip.facet === null) {
          state.q = ''
          if (input) input.value = ''
          render()
          return
        }
        state.facets[chip.facet] = (state.facets[chip.facet] || []).filter((v) => v !== chip.value)
        syncInputsFromState()
        render()
      })
      appliedRoot.append(btn)
    }
    const clearAll = el('button', { class: 'applied__chip', type: 'button' }, [el('span', { text: '清空全部' })])
    clearAll.addEventListener('click', () => {
      state = { q: '', facets: Object.fromEntries(FACETS.map((f) => [f.key, []])) }
      if (input) input.value = ''
      syncInputsFromState()
      render()
    })
    appliedRoot.append(clearAll)
  }

  function renderCard(entry) {
    const node = tpl.content.firstElementChild.cloneNode(true)
    node.classList.add(`card--${claimClass(entry['主张强度'])}`)
    node.dataset.entry = `${entry['节号']}.${entry['条号']}`

    $('.card__num', node).textContent = `${entry['节号']}.${entry['条号']}`
    $('.card__sec', node).textContent = entry['节名']

    const link = $('.card__link', node)
    link.href = entry['url'] || '#'
    link.textContent = ''
    link.append(highlight(entry['标题'], state.q))

    const lead = $('.card__lead', node)
    lead.textContent = ''
    lead.append(highlight(entry['说人话'], state.q))

    const claim = $('.badge--claim', node)
    claim.classList.add(`badge--${claimClass(entry['主张强度'])}`)
    $('.badge__v', claim).textContent = entry['主张强度'] || '未标注'

    const proof = $('.badge--proof', node)
    proof.classList.add(`badge--${proofClass(entry['举证难度'])}`)
    $('.badge__v', proof).textContent = entry['举证难度'] || '未标注'
    $('.meter', proof).classList.add(`meter--${proofLevel(entry['举证难度'])}`)

    $('.badge--rank .badge__v', node).textContent = entry['效力位阶'] || '未标注'

    const time = $('time[data-checked]', node)
    const date = entry['核对日期'] || ''
    time.setAttribute('datetime', date)
    time.dataset.checked = date
    $('.badge__v', time).textContent = date || '未标注'

    $('.card__basis', node).textContent = entry['依据'] || ''
    const chips = $('.card__chips', node)
    for (const key of ['钱', '时间', '毅力', '收益']) {
      const value = tag(entry, key)
      if (!value) continue
      chips.append(el('li', { class: 'chip' }, [
        el('b', { text: key }),
        el('span', { text: COST_LABELS[key] && COST_LABELS[key][value] ? COST_LABELS[key][value] : value }),
      ]))
    }
    const scope = tag(entry, '口径')
    if (scope) {
      chips.append(el('li', { class: 'chip chip--scope' }, [
        el('b', { text: '口径' }),
        el('span', { text: COST_LABELS['口径'][scope] || scope }),
      ]))
    }
    return node
  }

  function render(resetLimit = true) {
    if (resetLimit) limit = pageSize
    updateFacetCounts()
    renderApplied()
    const matched = entries.filter((e) => matches(e, state))
    countRoot.textContent = ''
    countRoot.append(
      el('span', { text: '命中 ' }),
      el('b', { text: String(matched.length) }),
      el('span', { text: ` 条 / 共 ${entries.length} 条` })
    )
    resultsRoot.textContent = ''
    if (!matched.length) {
      resultsRoot.append(
        el('div', { class: 'empty', id: 'empty' }, [
          el('p', { text: '没有符合条件的条目。' }),
          el('p', { text: '关键词是「且」关系：多个词之间要同时命中；筛选项之间也是「且」，维度内多选是「或」。' }),
        ])
      )
      if (moreBtn) moreBtn.hidden = true
      syncURL()
      return
    }
    for (const entry of matched.slice(0, limit)) resultsRoot.append(renderCard(entry))
    if (moreBtn) moreBtn.hidden = matched.length <= limit
    // 结果卡片是脚本新建的，动态插进来之后要重新标一次「待复核」
    applyStale(root)
    syncURL()
  }

  function syncURL() {
    const query = toQuery(state)
    const url = `${window.location.pathname}${query}`
    window.history.replaceState(null, '', url)
  }

  function schedule() {
    window.clearTimeout(schedule.timer)
    schedule.timer = window.setTimeout(() => render(), 120)
  }

  input.addEventListener('input', () => {
    state.q = input.value.trim()
    schedule()
  })
  clearBtn.addEventListener('click', () => {
    state = { q: '', facets: Object.fromEntries(FACETS.map((f) => [f.key, []])) }
    input.value = ''
    syncInputsFromState()
    render()
  })
  facetsRoot.addEventListener('change', () => {
    readStateFromInputs()
    for (const cb of $$('input[type="checkbox"]', facetsRoot)) {
      cb.closest('.facet__opt').classList.toggle('is-on', cb.checked)
    }
    render()
  })
  moreBtn.addEventListener('click', () => {
    limit += pageSize
    render(false)
  })
  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
    if (event.key === '/' && !typing) {
      event.preventDefault()
      input.focus()
    }
  })
  window.addEventListener('popstate', () => {
    state = parseState(window.location.search.slice(1))
    syncInputsFromState()
    render()
  })

  fetch(indexURL, { credentials: 'same-origin' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
    .then((data) => {
      entries = (data && data.entries) || []
      buildFacets()
      syncInputsFromState()
      render()
    })
    .catch((err) => {
      resultsRoot.textContent = ''
      resultsRoot.append(
        el('div', { class: 'empty', id: 'empty' }, [
          el('p', { text: '检索索引没能加载。' }),
          el('p', { text: `${indexURL}（${err.message}）；你仍可以从上方目录逐节浏览。` }),
        ])
      )
    })

  // 结果卡片渲染后再更新一次「待复核」标记
  return { getEntries: () => entries, getState: () => state }
}
