/**
 * L2 自传摘要（中环 N7，J16）：上一版之后新增实质事件 ≥ SUMMARY_MIN 才跑，安静日为 0 次调用。
 * 摘要是派生说法：SUMMARY_BUILD 携带来源事件区间，fold 不读；失败沿用旧版，不写任何东西。
 */
import { readEvents, append } from './ledger.js'
import { listHeads } from './projection.js'
import { LAYERS, isCoreKind } from './catalog.js'
import { call } from './llm.js'
import './templates.js'

export const SUMMARY_MIN = 10
// 一章至少隔一周：自传按「一程」写，不是日记
export const SUMMARY_GAP_DAYS = 7
const MAX_EVENTS = 40
// 运维与派生事件不算「这一程发生了什么」
const SKIP = new Set(['JOB_DONE', 'SUMMARY_BUILD', 'THETA_ADJUST', 'REVIEW_FLAG', 'EDGE_PROPOSE', 'DEGEN_CHECK'])

function texts(db, aid) {
  const m = new Map()
  for (const r of db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid)) m.set(r.id, r.text)
  for (const r of db.prepare('SELECT id, pos_id, neg_id FROM claim_kappa WHERE agent_id=?').all(aid)) {
    m.set(r.id, (m.get(r.pos_id) || '?') + ' ⟷ ' + (m.get(r.neg_id) || '?'))
  }
  return m
}

/** 一条事件的事实摘要：涉及的命题 / 矛盾原文，不加解读。 */
function what(e, tx) {
  const ids = new Set()
  for (const c of e.payload.claims || []) ids.add(c.id)
  for (const [k, v] of Object.entries(e.payload)) {
    if (typeof v === 'string' && /_id$/.test(k)) ids.add(v)
  }
  for (const x of e.payload.evidence || []) ids.add(x.target_id)
  const parts = [...ids].map((id) => tx.get(id)).filter(Boolean).map((t) => t.slice(0, 60))
  return parts.slice(0, 3).join('；')
}

export function lastSummary(db, aid) {
  const ev = readEvents(db, aid, { types: ['SUMMARY_BUILD'] }).pop()
  if (!ev) return null
  const sm = (ev.payload.summaries || [])[0]
  if (!sm) return null
  let body = {}
  try { body = JSON.parse(sm.text) } catch { /* 旧格式：整段当 at_the_time */ body = { at_the_time: sm.text } }
  return { id: sm.id, event_id: ev.id, at: ev.at, from_seq: sm.from_seq, to_seq: sm.to_seq, ...body }
}

export function listSummaries(db, aid) {
  return readEvents(db, aid, { types: ['SUMMARY_BUILD'] }).map((ev) => {
    const sm = (ev.payload.summaries || [])[0] || {}
    let body = {}
    try { body = JSON.parse(sm.text) } catch { body = { at_the_time: sm.text } }
    return { id: sm.id, event_id: ev.id, at: ev.at, from_seq: sm.from_seq, to_seq: sm.to_seq, ...body }
  }).reverse()
}

export async function buildSummary(db, aid, now, opt = {}) {
  const prev = lastSummary(db, aid)
  if (prev && Date.parse(now) - Date.parse(prev.at) < SUMMARY_GAP_DAYS * 86400000) return { did: [], skipped: 'gap' }
  const from = prev ? prev.to_seq : 0
  const fresh = readEvents(db, aid, { afterSeq: from }).filter((e) => e.at <= now && !SKIP.has(e.type))
  if (fresh.length < SUMMARY_MIN) return { did: [], skipped: 'few', fresh: fresh.length }
  const tx = texts(db, aid)
  const heads = {}
  for (const l of LAYERS) {
    heads[l] = listHeads(db, aid, l).filter((c) => c.status === 'active')
      .sort((a, b) => (isCoreKind(l, b.kind) ? 1 : 0) - (isCoreKind(l, a.kind) ? 1 : 0)).slice(0, 4).map((c) => c.text)
  }
  const events = fresh.slice(-MAX_EVENTS).map((e) => ({ id: e.id, day: e.at.slice(0, 10), type: e.type, layer: e.layer, what: what(e, tx) }))
  const input = { previous: prev ? { chapter: prev.chapter, hindsight: prev.hindsight } : null, heads, events }
  const r = await call({ db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat }, 'J16', input)
  if (!r.ok) return { did: [], failed: r.code }
  const toSeq = fresh[fresh.length - 1].seq
  const body = { ...r.out, events: fresh.length }
  try {
    append(db, aid, [{
      type: 'SUMMARY_BUILD', actor: 'judge', at: now, refs: r.out.turning_points,
      payload: { summaries: [{ layer: null, kind: 'chapter', from_seq: from, to_seq: toSeq, text: JSON.stringify(body) }] },
    }])
  } catch (e) {
    return { did: [], failed: 'APPEND', error: String((e && e.message) || e) }
  }
  return { did: [{ chapter: r.out.chapter, from_seq: from, to_seq: toSeq, events: fresh.length }] }
}
