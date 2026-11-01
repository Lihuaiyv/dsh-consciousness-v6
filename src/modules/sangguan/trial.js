/**
 * 合题试用结算（logic-gates §6.4）：到期按 π / n 确认、回滚、延长、休眠、过期。
 * 时间由 now 传入；不调模型。
 */
import { theta } from './fold.js'
import { loadState } from './projection.js'
import { append, readEvents } from './ledger.js'
import { flagsForTerminal, closeAround } from './practice.js'

const DAY = 86400000
const addDays = (at, d) => new Date(Date.parse(at) + d * DAY).toISOString()

function subEvidence(db, aid, k, s) {
  if (!k.sub_id) return []
  const nus = new Set()
  for (const n of Object.values(s.nus)) if (n.claim_id === k.sub_id) nus.add(n.id)
  const out = []
  for (const ev of readEvents(db, aid, { types: ['EVIDENCE'] })) {
    for (const x of ev.payload.evidence || []) {
      const hit = x.target_id === k.sub_id || (x.target_type === 'nu' && nus.has(x.target_id))
      if (hit) out.push({ at: ev.at, seq: ev.seq })
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq)
}

function dueOf(k, evs, s) {
  const nTrial = Math.round(theta(s, 'N_trial', k.layer))
  const nth = evs[nTrial - 1]
  const byTime = k.trial_until
  if (nth && byTime) return nth.at < byTime ? nth.at : byTime
  return byTime || (nth && nth.at) || null
}

function oneSettle(k, sub, evs, s, now) {
  const Tdorm = theta(s, 'T_dormant', k.layer)
  if (k.dormant_since) {
    if (sub.n > 0) return null
    if (now >= addDays(k.dormant_since, Tdorm)) {
      return { type: 'SUB_EXPIRE', layer: k.layer, actor: 'sys', at: now, payload: { kappa_id: k.id } }
    }
    return null
  }
  const due = dueOf(k, evs, s)
  if (!due || now < due) return null
  if (sub.n >= 1 && sub.pi > 0) {
    return { type: 'SUB_CONFIRM', layer: k.layer, actor: 'sys', at: now, payload: { kappa_id: k.id } }
  }
  if (sub.n >= 1 && sub.pi <= 0) {
    return { type: 'SUB_ROLLBACK', layer: k.layer, actor: 'sys', at: now, payload: { kappa_id: k.id, why: 'pi<=0' } }
  }
  if (sub.n === 0 && !k.extended) {
    return { type: 'SUB_EXTEND', layer: k.layer, actor: 'sys', at: now, payload: { kappa_id: k.id } }
  }
  if (sub.n === 0 && k.extended) {
    return { type: 'SUB_DORMANT', layer: k.layer, actor: 'sys', at: now, payload: { kappa_id: k.id } }
  }
  return null
}

/** 结算所有到期试用。返回 { did: [{id, type}] }。 */
export function settleTrials(db, aid, now) {
  const s0 = loadState(db, aid)
  const did = []
  for (const id of Object.keys(s0.kappas)) {
    const s = loadState(db, aid)
    const k = s.kappas[id]
    if (!k || k.sigma !== 'sub_trial' || !k.sub_id) continue
    const sub = s.claims[k.sub_id]
    if (!sub) continue
    const ev = oneSettle(k, sub, subEvidence(db, aid, k, s), s, now)
    if (!ev) continue
    const batch = [ev]
    const expect = { kappas: { [k.id]: 'sub_trial' }, claims: { [sub.id]: 'provisional' } }
    if (ev.type === 'SUB_CONFIRM') {
      // 两极进 sublated：挂着它们的挂起 / 并存 κ 同事务关掉（P21）
      const pack = closeAround(s, [k.pos_id, k.neg_id], now, [k.id])
      batch.push(...pack.evs)
      Object.assign(expect.kappas, pack.expect)
    }
    if (ev.type === 'SUB_ROLLBACK' || ev.type === 'SUB_EXPIRE') batch.push(...flagsForTerminal(s, [sub.id], now))
    try {
      append(db, aid, batch, expect)
      did.push({ id: k.id, type: ev.type })
    } catch { /* expect 不符则下夜再试 */ }
  }
  return { did }
}
