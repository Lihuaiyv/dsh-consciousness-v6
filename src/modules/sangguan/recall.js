/**
 * 三观按情境召回：这一句进来时，该把哪几条看法端到它面前。
 *
 * 为什么不是全塞：全塞进提示词，模型会把三观平均成一句谁也不像的场面话；
 * 而且每轮都带几十条，等于没带。这里只捞 0–2 条，核心三条常驻。
 *
 * 召回不调模型（纯字面），先保证零成本、可复现；模型那一拍（J34 只回编号）留在下一步接。
 */
import { loadState } from './projection.js'
import { metaOf } from './meta.js'
import { isCoreKind, isTerminal } from './catalog.js'

const MAX_CORE = 3

/** 只保留汉字/字母/数字，去掉标点与空白，避免句读影响相似度。 */
const norm = (t) => String(t || '').replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').toLowerCase()

/** 字的二元组集合：中文短句没有词边界，二元组比整句余弦更稳。 */
export function grams(text, n = 2) {
  const t = norm(text)
  const out = new Set()
  if (t.length < n) { if (t) out.add(t); return out }
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n))
  return out
}

export function similarity(a, b) {
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit += 1
  return hit / Math.max(A.size, B.size)
}

/** 每层挑一条核心：有核心用核心，没有就用 e 最高的活跃条目。 */
export function coreIds(s, max = MAX_CORE) {
  const out = []
  for (const layer of ['W', 'L', 'V']) {
    const list = Object.values(s.claims).filter((c) => c.layer === layer && c.status === 'active' && !isTerminal(c.status))
    if (!list.length) continue
    const cores = list.filter((c) => isCoreKind(layer, c.kind)).sort((a, b) => b.e - a.e)
    const pick = cores[0] || list.slice().sort((a, b) => b.e - a.e || b.pi - a.pi)[0]
    if (pick) out.push(pick.id)
  }
  return out.slice(0, max)
}

export function claimTexts(db, aid) {
  try {
    return new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
  } catch { return new Map() }
}

/**
 * 召回：{ core:[{id,text}], picked:[{id,text,score}], candidates:[…], reason? }
 * opt.top 先取前几条；opt.limit 最终最多给几条；opt.min 低于此分不要。
 */
export function recall(db, aid, query, opt = {}) {
  const s = loadState(db, aid)
  const texts = claimTexts(db, aid)
  const core = coreIds(s).map((id) => ({ id, layer: s.claims[id] && s.claims[id].layer, text: texts.get(id) || '' })).filter((x) => x.text)
  const q = String(query || '').trim()
  if (!q) return { core, picked: [], candidates: [], reason: 'no_query' }
  const candidates = []
  for (const c of Object.values(s.claims)) {
    if (c.status !== 'active' || isTerminal(c.status)) continue
    if (core.some((x) => x.id === c.id)) continue
    const text = texts.get(c.id) || ''
    if (!text) continue
    const scene = metaOf(c).scene || []
    const score = 0.75 * similarity(q, text) + 0.25 * Math.max(0, ...scene.map((x) => similarity(q, x)), 0)
    if (score > 0) candidates.push({ id: c.id, text, score: +score.toFixed(4), layer: c.layer })
  }
  candidates.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
  const top = candidates.slice(0, opt.top || 5)
  const min = opt.min == null ? 0.02 : opt.min
  const picked = top.filter((c) => c.score >= min).slice(0, opt.limit || 2)
  return { core, picked, candidates: top }
}

/** 把召回结果压成注入行（零术语）。 */
const LEAD = { W: '你看世界的方式：', L: '你的人生观：', V: '你更看重：' }
export function recallLines(result) {
  const out = []
  for (const c of result.core || []) {
    const lead = LEAD[c.layer]
    if (lead) out.push(lead + String(c.text).slice(0, 80))
  }
  for (const c of result.picked || []) {
    const lead = LEAD[c.layer] || ''
    out.push((lead ? lead.slice(0, -1) + '，' : '') + '这一会儿：' + String(c.text).slice(0, 80))
  }
  return out
}
