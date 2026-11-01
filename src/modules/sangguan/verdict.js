/**
 * 用户裁决（S13 verdict）与判定可靠度 r_J（§13.1，G3 遗留）。
 * 裁决 = actor user 的 EVIDENCE（kind verdict，权重 w_verdict）；每目标每日至多 VERDICT_DAILY 次，多出的不计也不写。
 * override_of 指向被用户推翻的判定事件；r_J = 1 − 覆盖数 / 判定数（近 30 日，判定 < 10 次时不给值）。
 */
import { readEvents, append } from './ledger.js'
import { loadState } from './projection.js'
import { theta } from './fold.js'
import { isTerminal } from './catalog.js'
import { isEnabled } from './config.js'
import { localDay } from '../../db.js'

export const VERDICT_DAILY = 1
const RJ_DAYS = 30
const RJ_MIN = 10
// 只算真正做了取舍的判定；记录类事件不算
const JUDGE_SKIP = new Set(['INQUIRY', 'SUMMARY_BUILD', 'JOB_DONE', 'THETA_ADJUST', 'EDGE_PROPOSE', 'REVIEW_FLAG'])

export function rJOf(db, aid, now) {
  const since = new Date(Date.parse(now) - RJ_DAYS * 86400000).toISOString()
  const evs = readEvents(db, aid).filter((e) => e.at > since && e.at <= now)
  const judged = evs.filter((e) => e.actor === 'judge' && !JUDGE_SKIP.has(e.type))
  if (judged.length < RJ_MIN) return null
  const ids = new Set(judged.map((e) => e.id))
  const over = new Set(evs.filter((e) => e.type === 'EVIDENCE' && e.actor === 'user' && ids.has(e.payload.override_of)).map((e) => e.payload.override_of))
  return +(1 - over.size / judged.length).toFixed(4)
}

class VerdictError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

/**
 * 写一次裁决。v = { target_type:'claim'|'nu', target_id, sign:±1, note?, override_of?, inquiry_id? }。
 * 返回 { ok, counted, event_id? }；目标非法抛 VerdictError（code ∈ OFF | INVALID | NOT_FOUND | TERMINAL）。
 */
export function verdict(db, aid, v, now = new Date().toISOString()) {
  if (!isEnabled(db, aid)) throw new VerdictError('OFF', '三观未开启')
  const type = v && v.target_type
  const id = v && v.target_id
  const sign = Number(v && v.sign)
  if ((type !== 'claim' && type !== 'nu') || typeof id !== 'string' || !id || (sign !== 1 && sign !== -1)) {
    throw new VerdictError('INVALID', '裁决需要 target_type（claim / nu）、target_id 与 sign（±1）')
  }
  const s = loadState(db, aid)
  const expect = {}
  if (type === 'claim') {
    const c = s.claims[id]
    if (!c) throw new VerdictError('NOT_FOUND', '没有这个命题')
    if (isTerminal(c.status)) throw new VerdictError('TERMINAL', '命题已结束，不能再裁决')
    expect.claims = { [id]: c.status }
  } else {
    const n = s.nus[id]
    if (!n) throw new VerdictError('NOT_FOUND', '没有这个预见')
    if (n.outcome !== 'pending') throw new VerdictError('TERMINAL', '预见已结算')
    expect.nus = { [id]: n.outcome }
  }
  const day = localDay(new Date(now))
  const today = readEvents(db, aid, { types: ['EVIDENCE'] }).filter((e) => e.actor === 'user'
    && localDay(new Date(e.at)) === day
    && (e.payload.evidence || []).some((x) => x.kind === 'verdict' && x.target_id === id)).length
  if (today >= VERDICT_DAILY) return { ok: true, counted: false, reason: 'daily_cap' }
  const ref = 'user:verdict' + (v.note ? '：' + String(v.note).slice(0, 200) : '')
  const head = {
    type: 'EVIDENCE', actor: 'user', at: now,
    payload: { evidence: [{ kind: 'verdict', target_type: type, target_id: id, sign, weight: theta(s, 'w_verdict'), ref }] },
  }
  if (v.override_of) head.payload.override_of = String(v.override_of)
  const batch = [head]
  if (v.inquiry_id) batch.push({ type: 'INQUIRY', actor: 'user', at: now, payload: { answer_of: String(v.inquiry_id), ref } })
  const r = append(db, aid, batch, expect)
  return { ok: true, counted: true, event_id: r.ids[0] }
}

export { VerdictError }
