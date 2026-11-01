/**
 * 先例助判（logic-gates §11 R3–R5）：先例单位是一条 DELIBERATE 决策 d，结局 o_d 全部从账本现算。
 * 只用 at ≤ now 的事件，所以重放到任意时刻结论一致。先例只在 A 内调整排序；Inhibit 只删 SUB（I10）。
 * 没有嵌入时 sim 走字符二元组 Jaccard（sim_mode=lexical）。
 */
import { theta } from './fold.js'
import { readEvents } from './ledger.js'
import { jaccard } from './sim.js'

const DAY = 86400000
const addDays = (at, d) => new Date(Date.parse(at) + d * DAY).toISOString()
const TYPES = ['DELIBERATE', 'RESOLVE', 'CON', 'SUB_CONFIRM', 'SUB_ROLLBACK', 'SUB_EXPIRE', 'REOPEN', 'TRADEOFF', 'NU_RESOLVE', 'CLAIM_EXP', 'REV', 'SUB_ACCEPT']

function textsOf(db, aid) {
  const claims = new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
  const qs = new Map(db.prepare('SELECT id, text FROM claim_questions WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
  return { claims, qs }
}

/**
 * 每条 DELIBERATE 的结局：{ o ∈ {+1, −1, 0}, matured_at }。o=0 表示尚无结局或按表不入池。
 * RESOLVE：T_mature 内胜方被证伪或败方内容（sim ≥ θ_dup）重新出现 → −1；满 T_mature 无事 → +1。
 * SUB：CONFIRM +1 / ROLLBACK −1 / EXPIRE 0。COEX：T_mature 内重开 −1；未重开且有 TRADEOFF +1。
 * SUSPEND：挂起期间两极的 ν 落空 −1；之后经 RESOLVE / SUB_CONFIRM 收场 +1。
 */
export function outcomes(db, aid, s, now, ctx = {}) {
  const evs = (ctx.events || readEvents(db, aid, { types: TYPES })).filter((e) => e.at <= now)
  const texts = ctx.texts || textsOf(db, aid)
  const T = theta(s, 'T_mature')
  const dup = theta(s, 'theta_dup')
  const byK = new Map()
  const push = (k, e) => { if (!byK.has(k)) byK.set(k, []); byK.get(k).push(e) }
  const falsAt = new Map()
  const born = []
  const nuClaim = new Map(Object.values(s.nus).map((n) => [n.id, n.claim_id]))
  const misses = []
  for (const e of evs) {
    const p = e.payload || {}
    if (p.kappa_id) push(p.kappa_id, e)
    if (e.type === 'CON' && !falsAt.has(p.claim_id)) falsAt.set(p.claim_id, e.at)
    if (e.type === 'RESOLVE' && !falsAt.has(p.loser_id)) falsAt.set(p.loser_id, e.at)
    if (e.type === 'NU_RESOLVE' && p.outcome === 'miss') misses.push({ claim: nuClaim.get(p.nu_id), at: e.at, seq: e.seq })
    if (['CLAIM_EXP', 'REV', 'SUB_ACCEPT'].includes(e.type)) for (const c of p.claims || []) born.push({ id: c.id, layer: c.layer, text: c.text || texts.claims.get(c.id) || '', at: e.at, seq: e.seq })
  }
  const out = []
  for (const [kid, list] of byK) {
    const k = s.kappas[kid]
    if (!k) continue
    const ds = list.filter((e) => e.type === 'DELIBERATE')
    ds.forEach((d, i) => {
      const after = list.filter((e) => e.seq > d.seq)
      const nextD = ds[i + 1]
      const until = addDays(d.at, T)
      let o = 0
      let at = null
      const b = d.payload.branch
      if (b === 'RESOLVE') {
        const r = after.find((e) => e.type === 'RESOLVE')
        if (r) {
          const w = r.payload.winner_id
          const lt = texts.claims.get(r.payload.loser_id) || ''
          const fa = falsAt.get(w)
          const back = born.find((c) => c.seq > r.seq && c.at <= until && c.layer === k.layer && jaccard(c.text, lt) >= dup - 1e-9)
          const bad = [fa && fa <= until ? fa : null, back ? back.at : null].filter(Boolean).sort()[0]
          if (bad) { o = -1; at = bad } else if (now >= until) { o = 1; at = until }
        }
      } else if (b === 'SUB') {
        const end = after.find((e) => ['SUB_CONFIRM', 'SUB_ROLLBACK', 'SUB_EXPIRE'].includes(e.type))
        if (end && end.type === 'SUB_CONFIRM') { o = 1; at = end.at }
        if (end && end.type === 'SUB_ROLLBACK') { o = -1; at = end.at }
      } else if (b === 'COEX') {
        const re = after.find((e) => e.type === 'REOPEN' && e.at <= until)
        if (re) { o = -1; at = re.at } else if (now >= until && after.some((e) => e.type === 'TRADEOFF' && e.at <= until)) { o = 1; at = until }
      } else if (b === 'SUSPEND') {
        const stop = nextD ? nextD.seq : Infinity
        const poles = new Set([k.pos_id, k.neg_id])
        const miss = misses.find((m) => m.seq > d.seq && m.seq < stop && poles.has(m.claim))
        const end = after.find((e) => e.type === 'RESOLVE' || e.type === 'SUB_CONFIRM')
        if (miss) { o = -1; at = miss.at } else if (end) { o = 1; at = end.at }
      }
      out.push({ id: d.id, seq: d.seq, at: d.at, layer: d.layer || k.layer, kappa_id: kid, branch: b, o, matured_at: at })
    })
  }
  return out
}

/** 一次夜间审议共用的索引：结局 + 文本，免得每个 κ 重读账本。 */
export function precedentIndex(db, aid, s, now) {
  const texts = textsOf(db, aid)
  return { now, texts, decisions: outcomes(db, aid, s, now, { texts }) }
}

function kappaView(s, texts, k) {
  const pos = s.claims[k.pos_id]
  const neg = s.claims[k.neg_id]
  return {
    q: texts.qs.get(k.q_id) || '',
    pos: texts.claims.get(k.pos_id) || '',
    neg: texts.claims.get(k.neg_id) || '',
    kinds: new Set([pos && pos.kind, neg && neg.kind].filter(Boolean)),
  }
}

const setJac = (A, B) => {
  const u = new Set([...A, ...B])
  if (!u.size) return 0
  let i = 0
  for (const x of A) if (B.has(x)) i++
  return i / u.size
}

/** sim(κ, d) = w_q·sim(q) + w_p·max 对齐 ½[sim(c⁺) + sim(c⁻)] + w_k·Jaccard(kinds)。 */
export function simKappa(s, a, b, w) {
  const straight = (jaccard(a.pos, b.pos) + jaccard(a.neg, b.neg)) / 2
  const crossed = (jaccard(a.pos, b.neg) + jaccard(a.neg, b.pos)) / 2
  return w.w_q * jaccard(a.q, b.q) + w.w_p * Math.max(straight, crossed) + w.w_k * setJac(a.kinds, b.kinds)
}

/**
 * R3–R4：D_k、P(b)、N_bad(SUB)、Inhibit。sinceAt 给出时，matured_at > sinceAt 的先例记为「新成熟」（Novel）。
 * 冷启动池为空 → P ≡ 0。
 */
export function precedentFor(s, k, idx, opt = {}) {
  const now = idx.now
  const w = { w_q: theta(s, 'w_q'), w_p: theta(s, 'w_p'), w_k: theta(s, 'w_k') }
  const thSim = theta(s, 'theta_sim')
  const K = Math.round(theta(s, 'k'))
  const tau = theta(s, 'tau')
  // Pool：同层、别的 κ、已有结局、早于现在；每个 κ_d 只取最新一条
  const latest = new Map()
  for (const d of idx.decisions) {
    if (d.kappa_id === k.id || d.layer !== k.layer || d.o === 0 || !d.matured_at || d.matured_at > now || d.at >= now) continue
    const cur = latest.get(d.kappa_id)
    if (!cur || d.seq > cur.seq) latest.set(d.kappa_id, d)
  }
  const me = kappaView(s, idx.texts, k)
  const scored = []
  for (const d of latest.values()) {
    const kd = s.kappas[d.kappa_id]
    if (!kd) continue
    const sim = simKappa(s, me, kappaView(s, idx.texts, kd), w)
    if (sim >= thSim - 1e-9) scored.push({ ...d, sim })
  }
  scored.sort((a, b) => b.sim - a.sim || a.seq - b.seq)
  const D = scored.slice(0, K).map((d) => ({ ...d, omega: d.sim * Math.exp(-((Date.parse(now) - Date.parse(d.at)) / DAY) / tau) }))
  const den = D.reduce((a, d) => a + d.omega, 0)
  const P = {}
  if (den > 0) for (const d of D) P[d.branch] = (P[d.branch] || 0) + (d.omega * d.o) / den
  const nBadSub = D.filter((d) => d.branch === 'SUB' && d.o === -1).length
  const fresh = opt.sinceAt ? D.some((d) => d.matured_at > opt.sinceAt) : false
  return {
    P, nBadSub, ids: D.map((d) => d.id), fresh, sim_mode: 'lexical',
    D: D.map((d) => ({ id: d.id, kappa_id: d.kappa_id, branch: d.branch, o: d.o, sim: +d.sim.toFixed(4), omega: +d.omega.toFixed(4) })),
  }
}
