/**
 * 检索工具（memory_search）：模型主动「再查一次」用的多路召回。
 *
 * 和每轮注入的区别：注入要「少而精」——名额有限，挑最值得占的那几条；
 * 工具要「这一层到底有没有」——用户的提问常常字面不对但意思到了，
 * 工具得换几种说法、几个通道一起捞，由模型自己判断要不要用。
 *
 * 五层（默认只查记忆 + 原文，其余按需）：
 *   memory  T1 抽屉   事实/自省；实体 + 字面 + 向量 + 卡片 + 图扩散
 *   episode T2 纪要   某次会话/某天的压缩
 *   diary   T3 日记   第一人称，回答「那阵子我怎么样」
 *   raw     T4 原文   一句话一句，可带前后文
 *   fact    T4 存根   当初第一次被记下来时的原样
 *
 * 融合：每种说法各自排一次名次，按 RRF 合并——只混名次不混原始分，
 * 免得 bm25 词价和余弦相似度直接打架。同一层内先跨说法融合，再跨层各自截断，
 * 这样一层命中再多也压不掉另一层（注入那套 MMR 按总名额挑，工具不能用）。
 */

import {
  searchFacts, searchByEntity, searchByVector, expandByLinks,
  searchEpisodes, searchDiaries, evidenceOf, TYPE_WEIGHT,
} from './retrieve.js'
import { searchRaw, searchFactArchive } from './archive.js'
import { canEmbed, embedText } from './vector.js'

export const LAYERS = ['memory', 'episode', 'diary', 'raw', 'fact']
export const LAYER_LABEL = { memory: '记忆', episode: '纪要', diary: '日记', raw: '原文', fact: '存根' }
export const DEFAULT_LAYERS = ['memory', 'raw']

const RRF_K = 60
const MAX_PHRASINGS = 4
/** 第 2、3、4 种说法打点折：主查询仍是主角，只是允许别的说法补漏。 */
const PHRASE_W = [1, 0.75, 0.6, 0.5]
const FLOOR = 0.12          // 低于这个证据分当噪声丢掉（工具不设高门，只挡明显无关）
const FULL_MAX = 1200       // detail=full 时单条最多多少字
const BRIEF_MAX = 120
const TOTAL_MAX = 9000      // 一次返回的正文上限，超了截断并明说

// ---------------------------------------------------------------- 参数

function asList(v, max = 8) {
  const arr = Array.isArray(v) ? v : (v == null ? [] : [v])
  const out = []
  for (const x of arr) {
    const s = String(x || '').trim()
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}

/** 把工具参数整理成一份确定的查询计划（非法值一律退到默认，不抛错）。 */
export function planRecall(args = {}) {
  const main = String(args.query || '').trim().slice(0, 300)
  const queries = []
  if (main) queries.push(main)
  for (const a of asList(args.also, MAX_PHRASINGS - 1)) {
    if (queries.length >= MAX_PHRASINGS) break
    if (!queries.includes(a)) queries.push(a.slice(0, 300))
  }
  const want = asList(args.layers, LAYERS.length)
  const layers = want.length ? want.filter((l) => LAYERS.includes(l)) : DEFAULT_LAYERS.slice()
  const detail = String(args.detail || 'brief') === 'full' ? 'full' : 'brief'
  const k = Math.max(1, Math.min(detail === 'full' ? 5 : 12, Number(args.k) || 6))
  const days = Math.max(0, Math.min(3650, Number(args.days) || 0))
  const context = Math.max(0, Math.min(3, Number(args.context) || 0))
  const include = asList(args.include, 4)
  return {
    query: main || queries[0] || '',
    queries,
    layers: layers.length ? layers : DEFAULT_LAYERS.slice(),
    detail,
    k,
    days,
    context,
    includeCold: true,                                  // 工具是「我要查」，冷层也算数，只是标注
    includeSuperseded: include.includes('superseded'),   // 旧说法默认不带：它会冒充现状
  }
}

// ---------------------------------------------------------------- 各层收集

function timeOf(x) {
  return String(x.created_at || x.at || x.day || '')
}

function norm(x) {
  return String(x == null ? '' : x).replace(/\s+/g, ' ').trim()
}

/** 统一成检索工具内部的一条：证据分当场算好，后面只按名次融合。 */
function toItem(x, layer, q, state) {
  const st = String(state || x.temp_state || '')
  return {
    layer,
    id: String(x.id || ''),
    type: String(x.type || x.role || ''),
    at: timeOf(x),
    text: norm(x.text),
    cold: st === 'cold' || st === 'archived',
    stale: !!x.invalid_at,
    via: String(x.via || (x.fts ? 'lex' : '')),
    e: Math.round(evidenceOf({ ...x, text: String(x.text || '') }, q) * 1e4) / 1e4,
  }
}

/**
 * 冷热状态不在 searchFacts 的选取列里（那是注入路径的 SQL，工具不该去动它），
 * 候选定下来后按 id 批量补一次——几百条以内，一条 SQL 就够。
 */
function coldStates(db, ids) {
  const out = new Map()
  if (!ids || !ids.length) return out
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400)
    try {
      const rows = db.prepare(`SELECT id,temp_state FROM memory_items WHERE id IN (${part.map(() => '?').join(',')})`)
        .all(...part)
      for (const r of rows) if (r.temp_state) out.set(String(r.id), String(r.temp_state))
    } catch { /* 老库没有温度列，全当有热 */ }
  }
  return out
}

/**
 * T1 的四个通道各排各的名次，**不合成一个分**。
 *
 * 为什么不是「算一个 e 再按 e 排序」：e 是门槛分（max(字面, 向量, 实体)），
 * 用来回答「够不够格进来」；拿它当排名，一条只是语义沾边的向量命中
 * 就能压过唯一字面逐字命中的那条——实测里「补卡片」「查询等级」两条
 * 就是这么掉出前六的。名次才该混：同一个 id 被字面和向量同时排前面，
 * 说明两条路都指向它，RRF 自然把它顶上去。
 */
function memoryChannels(db, aid, q, opt) {
  const o = { includeCold: opt.includeCold, includeSuperseded: opt.includeSuperseded }
  const lists = []
  let seeds = []

  // 实体路：查询点名的实体名下的事，字面不重合也算
  try {
    const arr = searchByEntity(db, aid, q, o)
      .map((x) => toItem(x, 'memory', q))
      .sort((a, b) => b.e - a.e)
    if (arr.length) { lists.push(arr); seeds.push(...arr.slice(0, 4)) }
  } catch { /* 实体表缺失时只是少一路 */ }

  // 字面路：沿用 v2 的排法（bm25 × 类型权重）——这条在实测里最不容易被语义带偏
  try {
    const arr = searchFacts(db, aid, q, o)
      .map((x) => ({ ...toItem(x, 'memory', q, x.temp_state), _fts: Number(x.fts || 0), _type: String(x.type || '') }))
    if (arr.length) {
      arr.sort((a, b) => (b._fts * (TYPE_WEIGHT[b._type] || 1)) - (a._fts * (TYPE_WEIGHT[a._type] || 1)))
      lists.push(arr)
      seeds.push(...arr.slice(0, 4))
    }
  } catch { /* 同上 */ }

  // 向量路：语义相近，说法完全不同也接得上
  if (opt.queryVec) {
    try {
      const arr = searchByVector(db, aid, opt.queryVec, { limit: 20 })
        .map((x) => toItem(x, 'memory', q, x.temp_state))
        .sort((a, b) => b.e - a.e)
      if (arr.length) { lists.push(arr); seeds.push(...arr.slice(0, 3)) }
    } catch { /* 向量缺失时只走词法 */ }
  }

  // 图扩散：拿已召回的几条当种子，把同一实体下的邻居带上（一跳为主）
  try {
    const uniq = [...new Map(seeds.map((x) => [x.id, x])).values()].slice(0, 8)
    if (uniq.length) {
      // expandByLinks 只认 T1 的 id，这里补上分区标记再喂给它
      const arr = expandByLinks(db, aid, uniq.map((x) => ({ id: x.id, partition: 'T1' })), {
        includeCold: opt.includeCold, hops: opt.hops, decay: 0.65, strength: 0.45, limit: 12,
      }).map((x) => toItem(x, 'memory', q)).sort((a, b) => b.e - a.e)
      if (arr.length) lists.push(arr)
    }
  } catch { /* 图扩散失败就当没有邻居 */ }

  const states = coldStates(db, lists.flat().map((x) => x.id))
  for (const arr of lists) for (const it of arr) it.cold = ['cold', 'archived'].includes(states.get(it.id) || '') || it.cold
  return lists
}

/**
 * 多关键词：原文层和存根层的检索只吃一个查询串——trigram 切不出三个字就退化成
 * 整串 LIKE，于是「气泡 水波纹」这种空格分开的问法一条都查不到，可库里两条各有。
 * 最便宜的做法是按空格/顿号/斜杠拆开，各查一遍再按 id 合并（留证据分高的那条）。
 */
function segmentsOf(q) {
  const parts = String(q || '').split(/[\s,，、;；/|+]+/).map((s) => s.trim()).filter((s) => s.length >= 2)
  return parts.length > 1 ? parts.slice(0, 4) : []
}

function unionById(lists, mk) {
  const byId = new Map()
  for (const rows of lists) {
    for (const x of rows) {
      const it = mk(x)
      if (!it.id) continue
      const old = byId.get(it.id)
      if (!old || it.e > old.e) byId.set(it.id, it)
    }
  }
  return [...byId.values()].sort((a, b) => b.e - a.e)
}

function episodeLayer(db, aid, q) {
  try {
    return [(searchEpisodes(db, aid, q) || []).map((x) => toItem({ ...x, created_at: x.day }, 'episode', q))]
  } catch { return [] }
}

function diaryLayer(db, aid, q, days) {
  try {
    return [(searchDiaries(db, aid, q, days > 0 ? days : 3650) || []).map((x) => toItem({ ...x, created_at: x.day }, 'diary', q))]
  } catch { return [] }
}

function rawLayer(db, aid, q, opt) {
  try {
    const since = opt.since ? { since: opt.since } : {}
    const limit = Math.min(50, opt.k * 4)
    const mk = (x) => toItem({ ...x, type: x.role || 'raw' }, 'raw', q)
    const segs = segmentsOf(q)
    if (!segs.length) return [(searchRaw(db, aid, q, limit, since) || []).map(mk)]
    const merged = unionById(segs.map((s) => { try { return searchRaw(db, aid, s, limit, since) || [] } catch { return [] } }), mk)
    return merged.length ? [merged] : []
  } catch { return [] }
}

function factLayer(db, aid, q) {
  try {
    const mk = (x) => toItem(x, 'fact', q)
    const segs = segmentsOf(q)
    if (!segs.length) return [(searchFactArchive(db, aid, q, 16) || []).map(mk)]
    const merged = unionById(segs.map((s) => { try { return searchFactArchive(db, aid, s, 16) || [] } catch { return [] } }), mk)
    return merged.length ? [merged] : []
  } catch { return [] }
}

/** 一层可能有多条「投票通道」，每条都按自己的名次投票。 */
function collectLayer(db, aid, layer, q, opt) {
  if (layer === 'memory') return memoryChannels(db, aid, q, opt)
  if (layer === 'episode') return episodeLayer(db, aid, q)
  if (layer === 'diary') return diaryLayer(db, aid, q, opt.days)
  if (layer === 'raw') return rawLayer(db, aid, q, opt)
  if (layer === 'fact') return factLayer(db, aid, q)
  return []
}

// ---------------------------------------------------------------- 融合

/** 跨说法按名次融合：score = Σ w / (60 + rank)。同一 id 只留一条，e 取最高。 */
export function fusePhrasings(perPhrase) {
  const acc = new Map()
  for (const { w, items } of perPhrase) {
    (items || []).forEach((it, i) => {
      const rec = acc.get(it.id) || { it, rrf: 0, e: 0 }
      rec.rrf += w / (RRF_K + i + 1)
      rec.e = Math.max(rec.e, Number(it.e) || 0)
      acc.set(it.id, rec)
    })
  }
  return [...acc.values()]
    .sort((a, b) => b.rrf - a.rrf || b.e - a.e)
    .map((r) => ({ ...r.it, e: r.e, rrf: Math.round(r.rrf * 1e6) / 1e6 }))
}

/** 原文命中时带上前后的几句，别只给一句孤零零的话。 */
function withContext(db, aid, items, n) {
  if (!n || !items.length) return items
  const stmt = db.prepare(`SELECT role,seq,text,created_at FROM raw_turns
    WHERE agent_id=? AND session_id=? AND seq BETWEEN ? AND ? ORDER BY seq`)
  for (const it of items) {
    try {
      const row = db.prepare('SELECT session_id,seq FROM raw_turns WHERE id=?').get(it.id)
      if (!row) continue
      const seq = Number(row.seq) || 0
      const rows = stmt.all(aid, row.session_id, seq - n, seq + n)
      it.near = rows.filter((r) => Number(r.seq) !== seq).map((r) => ({
        rel: Number(r.seq) < seq ? 'prev' : 'next',
        role: r.role === 'user' ? 'user' : 'assistant',
        text: norm(r.text).slice(0, 160),
        at: String(r.created_at || ''),
      }))
    } catch { /* 上下文失败不影响命中本身 */ }
  }
  return items
}

// ---------------------------------------------------------------- 主入口

/**
 * 跑一次工具检索。
 * @returns {{query,queries,layers,counts,more,items,truncated,ms}}
 */
export async function recallTool(db, aid, args = {}) {
  const t0 = Date.now()
  const plan = planRecall(args)
  const out = {
    query: plan.query, queries: plan.queries, layers: plan.layers,
    counts: {}, more: {}, items: [], truncated: false, ms: 0,
  }
  if (!plan.query || !plan.layers.length) { out.ms = Date.now() - t0; return out }

  const since = plan.days > 0 ? new Date(Date.now() - plan.days * 86400000).toISOString() : null

  // 查询向量：一条查询一份，并行算；没有 embedding 能力就整条通道静默关掉。
  let vecs = []
  if (canEmbed()) {
    try { vecs = await Promise.all(plan.queries.map((q) => embedText(q, 1800))) } catch { vecs = [] }
  }

  const opt = {
    includeCold: true, includeSuperseded: plan.includeSuperseded,
    days: plan.days, k: plan.k, since, hops: 2,
  }

  for (const layer of plan.layers) {
    // 每条「说法 × 通道」各排各的名次，一起投票；层内再多通道也不会互相挤。
    const voters = []
    plan.queries.forEach((q, i) => {
      let lists = []
      try { lists = collectLayer(db, aid, layer, q, { ...opt, queryVec: vecs[i] || null }) } catch { lists = [] }
      const w = PHRASE_W[i] || 0.4
      for (const list of lists) {
        // 时间窗和噪声底线在同一处过，各层行为一致；过完再按原名次投票
        const kept = (list || []).filter((x) => (x.e >= FLOOR) && (!since || !x.at || x.at >= since))
        if (kept.length) voters.push({ w, items: kept })
      }
    })
    const fused = fusePhrasings(voters)
    out.more[layer] = Math.max(0, fused.length - plan.k)
    let picked = fused.slice(0, plan.k).map((x) => {
      // 内部字段（_fts / _type）不外泄
      const clean = {}
      for (const [k, v] of Object.entries(x)) if (!k.startsWith('_')) clean[k] = v
      return clean
    })
    if (layer === 'raw' && plan.context > 0) picked = withContext(db, aid, picked, plan.context)
    if (picked.length) out.counts[layer] = picked.length
    out.items.push(...picked)
  }

  // 正文预算：full 模式一次可能很长，超了就从尾巴截，并标记出来
  if (plan.detail === 'full') {
    let used = 0
    const keep = []
    for (const it of out.items) {
      const len = Math.min(FULL_MAX, it.text.length)
      if (used + len > TOTAL_MAX) { out.truncated = true; break }
      used += len
      keep.push(it)
    }
    out.items = keep
  }
  for (const it of out.items) {
    it.text = plan.detail === 'full' ? it.text.slice(0, FULL_MAX) : it.text.slice(0, BRIEF_MAX)
    if (!it.near) delete it.near
  }
  out.ms = Date.now() - t0
  return out
}

// ---------------------------------------------------------------- 渲染

function shortTime(at) {
  const s = String(at || '')
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/)
  if (m) return m[2] + '-' + m[3] + ' ' + m[4]
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return d ? d[2] + '-' + d[3] : ''
}

const WHO = { user: '你', assistant: '我' }

/** 结果转成给模型看的文本：一层一段，冷层/旧说法在行尾标出来。 */
export function renderRecall(v) {
  if (!v || !v.query) return '没有给查询词'
  const counts = Object.entries(v.counts || {}).map(([l, n]) => LAYER_LABEL[l] + ' ' + n)
  const lines = ['查「' + v.query + '」：' + (counts.length ? counts.join(' / ') : '没有命中')]
  if (!(v.items || []).length) {
    lines.push('这一层没有字面或语义对得上的。换几种说法（also）、放宽 days、或者换一层（layers）再试。')
    return lines.join('\n')
  }
  for (const it of v.items) {
    const tag = '[' + LAYER_LABEL[it.layer] + (it.type ? '/' + it.type : '') + ']'
    const mark = it.cold ? '（冷层）' : (it.stale ? '（旧说法）' : '')
    lines.push('- ' + tag + ' ' + shortTime(it.at) + ' ' + it.text + mark)
    for (const n of it.near || []) {
      lines.push('    ' + (n.rel === 'prev' ? '↑' : '↓') + ' ' + (WHO[n.role] || n.role) + '：' + n.text)
    }
  }
  const more = Object.entries(v.more || {}).filter(([, n]) => n > 0)
  if (more.length) {
    lines.push('（还有没显示出来的：' + more.map(([l, n]) => LAYER_LABEL[l] + ' ' + n + ' 条').join('、') + '，把 k 调大能看）')
  }
  if (v.truncated) lines.push('（正文超过一次能给的量，被截断了；缩小 k 或分几次查）')
  return lines.join('\n')
}
