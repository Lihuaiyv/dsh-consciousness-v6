/**
 * 中环 N4 立案（logic-gates §5、§12 排队；code-guide J3）：KAPPA_CANDIDATE → J3 起草 q / dep / excl → U1–U4 → KAPPA_OPEN。
 * 候选去重与过期全部现算、不写事件：同一无序对只看一次；任一方已终态、已有同对 κ、或超过 30 日未立案 → 丢弃。
 * 只有 J3 的结论才落账：U 闸不通过记 REJECT（refs 指向候选）；通过但违反 I4 或层容量满记 KAPPA_QUEUED（带 J3 结果，日后零调用开立）。
 * 问题去重：起草的 q 与同层已有问题 sim ≥ θ_dup 时复用旧 q。J3 调不通（CALL）不落账，下夜重试；没预算整次推迟。
 */
import { isTerminal } from './catalog.js'
import { theta, eOf } from './fold.js'
import { loadState } from './projection.js'
import { append, newId, readEvents } from './ledger.js'
import { call } from './llm.js'
import { jaccard } from './sim.js'
import './templates.js'

const DAY = 86400000
const CAND_TTL = 30
const OPEN_MAX = 4 // 每夜至多几次 J3，控制花费

const pairKey = (a, b) => [a, b].sort().join('|')

/** 现算待立案：{ queued[], fresh[] }，各按时间 / 优先级排好。 */
export function pendingOpen(db, aid, s, now) {
  const evs = readEvents(db, aid, { types: ['KAPPA_CANDIDATE', 'KAPPA_QUEUED', 'KAPPA_OPEN', 'REJECT'] })
  const used = new Set()
  for (const e of evs) for (const r of e.refs || []) used.add(r)
  const pairs = new Set(Object.values(s.kappas).map((k) => pairKey(k.pos_id, k.neg_id)))
  const live = (id) => s.claims[id] && !isTerminal(s.claims[id].status)
  const queued = []
  const fresh = []
  const seen = new Set()
  for (const e of evs) {
    if (e.type === 'KAPPA_QUEUED' && !used.has(e.id)) {
      const p = e.payload
      const key = pairKey(p.a_id, p.b_id)
      if (seen.has(key) || pairs.has(key) || !live(p.a_id) || !live(p.b_id)) continue
      seen.add(key)
      queued.push({ ev: e, key, a_id: p.a_id, b_id: p.b_id })
    }
  }
  const cut = new Date(Date.parse(now) - CAND_TTL * DAY).toISOString()
  for (const e of evs) {
    if (e.type !== 'KAPPA_CANDIDATE' || used.has(e.id) || e.at < cut) continue
    const { a_id, b_id } = e.payload
    const key = pairKey(a_id, b_id)
    if (seen.has(key) || pairs.has(key) || !live(a_id) || !live(b_id)) continue
    seen.add(key)
    const prio = 0.2 + Math.max(eOf(s.claims[a_id]), eOf(s.claims[b_id]))
    fresh.push({ ev: e, key, a_id, b_id, prio })
  }
  fresh.sort((x, y) => y.prio - x.prio || x.ev.seq - y.ev.seq)
  return { queued, fresh }
}

function questionFor(db, aid, layer, text, thetaDup) {
  let best = null
  for (const q of db.prepare('SELECT id, text FROM claim_questions WHERE agent_id=? AND layer=?').all(aid, layer)) {
    const v = jaccard(text, q.text)
    if (v >= thetaDup - 1e-9 && (!best || v > best.sim)) best = { id: q.id, sim: v }
  }
  return best
}

/** U1–U4：[D] 部分在这里，[J] 部分读 J3 的 pass。 */
export function uGates(layer, a, b, j3) {
  const report = {
    U1: { pass: !!(j3.q && j3.u1 && j3.u1.pass), reason: j3.u1 && j3.u1.reason },
    U2: { pass: !!(String(j3.dep || '').trim() && j3.u2 && j3.u2.pass), reason: j3.u2 && j3.u2.reason },
    U3: { pass: !!(String(j3.excl || '').trim() && j3.u3 && j3.u3.pass), reason: j3.u3 && j3.u3.reason },
    U4: { pass: a.layer === layer && b.layer === layer },
  }
  const failed = Object.keys(report).filter((k) => !report[k].pass)
  return { ok: !failed.length, failed, report }
}

function blocked(s, layer, a, b) {
  if (a.status !== 'active' || b.status !== 'active') return 'I4'
  const struggling = Object.values(s.kappas).filter((k) => k.layer === layer && k.sigma === 'struggle').length
  if (struggling >= theta(s, 'K_open', layer)) return 'K_open'
  return null
}

function openEvents(db, aid, s, item, j3, now, refId) {
  const a = s.claims[item.a_id]
  const b = s.claims[item.b_id]
  const [pos, neg] = a.born_seq < b.born_seq ? [a, b] : [b, a]
  const layer = pos.layer
  const reuse = questionFor(db, aid, layer, j3.q, theta(s, 'theta_dup'))
  const qid = reuse ? reuse.id : newId('questions', now)
  return {
    type: 'KAPPA_OPEN', layer, actor: 'judge', at: now, refs: [refId],
    gate_report: { ...(j3.report || {}), q_reused: !!reuse, sim_mode: 'lexical' },
    payload: {
      questions: reuse ? [] : [{ id: qid, layer, text: j3.q }],
      kappas: [{ layer, q_id: qid, pos_id: pos.id, neg_id: neg.id, dep: j3.dep, excl: j3.excl }],
    },
  }
}

function tryOpen(db, aid, item, j3, now, refId, did, skipped) {
  const s = loadState(db, aid)
  const a = s.claims[item.a_id]
  const b = s.claims[item.b_id]
  if (!a || !b || isTerminal(a.status) || isTerminal(b.status)) return 'dead'
  const why = blocked(s, a.layer, a, b)
  if (why) return why
  try {
    append(db, aid, [openEvents(db, aid, s, item, j3, now, refId)], { claims: { [a.id]: 'active', [b.id]: 'active' } })
    did.push({ open: item.key, from: refId })
    return null
  } catch (e) {
    skipped.push({ key: item.key, reason: e.code || 'ERR', msg: String(e.message || e).slice(0, 80) })
    return 'ERR'
  }
}

export async function openCandidates(db, aid, now, opt = {}) {
  const did = []
  const skipped = []
  const queuedNow = []
  let s = loadState(db, aid)
  const { queued, fresh } = pendingOpen(db, aid, s, now)
  // 先开排队的（按时间），零模型
  for (const q of queued) {
    const why = tryOpen(db, aid, q, { ...q.ev.payload, report: q.ev.gate_report }, now, q.ev.id, did, skipped)
    if (why) skipped.push({ key: q.key, reason: why })
  }
  let calls = 0
  for (const item of fresh) {
    if (calls >= OPEN_MAX) break
    s = loadState(db, aid)
    const a = s.claims[item.a_id]
    const b = s.claims[item.b_id]
    if (!a || !b || a.layer !== b.layer || isTerminal(a.status) || isTerminal(b.status)) continue
    const texts = Object.fromEntries(db.prepare('SELECT id, text FROM persona_claims WHERE id IN (?,?)').all(a.id, b.id).map((r) => [r.id, r.text]))
    const input = { layer: a.layer, a: { id: a.id, text: texts[a.id] || '' }, b: { id: b.id, text: texts[b.id] || '' } }
    const r = await call({ db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat }, 'J3', input, { tier: 'T1', pool: 'mid' })
    if (!r.cached) calls++
    if (!r.ok && r.code === 'BUDGET') return { did, skipped, queued: queuedNow, postponed: true }
    if (!r.ok && r.code === 'CALL') { skipped.push({ key: item.key, reason: 'CALL' }); continue }
    const j3 = r.ok ? r.out : null
    const u = j3 ? uGates(a.layer, a, b, j3) : { ok: false, failed: ['J3'], report: { J3: r.code } }
    if (!u.ok) {
      append(db, aid, [{
        type: 'REJECT', actor: 'sys', at: now, refs: [item.ev.id], gate_report: u.report,
        payload: { what: 'kappa', layer: a.layer, a_id: a.id, b_id: b.id, failed: u.failed },
      }])
      skipped.push({ key: item.key, reason: 'U:' + u.failed.join(',') })
      continue
    }
    const pack = { q: j3.q, dep: j3.dep, excl: j3.excl, report: u.report }
    const why = tryOpen(db, aid, item, pack, now, item.ev.id, did, skipped)
    if (why === 'I4' || why === 'K_open') {
      append(db, aid, [{
        type: 'KAPPA_QUEUED', layer: a.layer, actor: 'sys', at: now, refs: [item.ev.id], gate_report: u.report,
        payload: { a_id: a.id, b_id: b.id, q: j3.q, dep: j3.dep, excl: j3.excl, why },
      }])
      queuedNow.push({ key: item.key, why })
    }
  }
  return { did, skipped, queued: queuedNow }
}
