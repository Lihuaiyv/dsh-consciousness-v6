/**
 * 第一次夜巡把旧仪表里已经偏离的维度种成命题。文本只用含义句，不引用记忆。
 * 种过的层不再种。空仪表不种，下一夜再看。撤回是 CLAIM_WITHDRAW，账本只增。
 */
import { DIMS as VDIMS } from '../values.js'
import { DIMS as WDIMS, INIT as WINIT } from '../worldview.js'
import { DIMS as LDIMS } from '../lifeview.js'
import { isEnabled } from './config.js'
import { append, hasJob } from './ledger.js'
import { loadState } from './projection.js'
import { isTerminal, SIGMA_OPEN } from './catalog.js'
import { SangguanError } from './errors.js'

const FALLBACK_TELOS = '在相处里慢慢弄清自己为何在'

function rows(db, table, aid) {
  try { return db.prepare(`SELECT key, weight FROM ${table} WHERE agent_id=?`).all(aid) } catch { return [] }
}

function mapOf(list) {
  const m = {}
  for (const r of list) {
    const w = Number(r.weight)
    if (Number.isFinite(w)) m[r.key] = w
  }
  return m
}

function pickValue(db, aid) {
  const m = mapOf(rows(db, 'persona_values', aid))
  const ws = Object.values(m)
  if (ws.length < 2) return null
  const spread = Math.max(...ws) - Math.min(...ws)
  if (spread < 0.03) return null
  let best = null
  for (const [key, , hint] of VDIMS) {
    const w = m[key]
    if (!Number.isFinite(w)) continue
    if (!best || w > best.w) best = { w, text: '我更看重' + hint }
  }
  return best ? { layer: 'V', kind: 'principle', text: best.text } : null
}

function pickWorld(db, aid) {
  const m = mapOf(rows(db, 'persona_worldview', aid))
  let best = null
  for (const [key, , hi, lo] of WDIMS) {
    const w = m[key]
    if (!Number.isFinite(w)) continue
    const d = Math.abs(w - WINIT)
    if (d < 0.08) continue
    if (!best || d > best.d) best = { d, text: '我倾向认为' + (w >= WINIT ? hi : lo) }
  }
  return best ? { layer: 'W', kind: 'belt', text: best.text } : null
}

function pickLife(db, aid) {
  const m = mapOf(rows(db, 'persona_lifeview', aid))
  const keys = ['coherence', 'purpose', 'mattering']
  const present = keys.every((k) => Number.isFinite(m[k]))
  const presence = present ? (m.coherence + m.purpose + m.mattering) / 3 : 0
  let high = false
  let best = null
  for (const [key, , hi, lo] of LDIMS) {
    const w = m[key]
    if (!Number.isFinite(w)) continue
    if (w >= 0.58) high = true
    const d = Math.abs(w - 0.5)
    if (!best || d > best.d) best = { d, text: '我更想' + (w >= 0.5 ? hi : lo) }
  }
  if (!high && !(presence >= 0.6)) return null
  if (!best || best.text.includes(FALLBACK_TELOS)) return null
  return { layer: 'L', kind: 'telos', text: best.text }
}

function liveClaims(db, aid, layer) {
  const s = loadState(db, aid)
  return Object.values(s.claims).filter((c) => c.layer === layer && !isTerminal(c.status))
}

/**
 * 挂在夜巡三观段开头（旧仪表刚刚重算完）。返回各种了哪几层。
 */
export function seedFromMeters(db, aid, at) {
  if (!isEnabled(db, aid)) return { seeded: [], skipped: 'off' }
  const seeded = []
  const skipped = []
  const picks = [pickWorld(db, aid), pickLife(db, aid), pickValue(db, aid)].filter(Boolean)
  for (const layer of ['W', 'L', 'V']) {
    const key = 'seed:' + aid + ':' + layer
    if (hasJob(db, aid, key)) { skipped.push({ layer, reason: 'done' }); continue }
    const pick = picks.find((p) => p.layer === layer)
    if (liveClaims(db, aid, layer).length) {
      append(db, aid, [{ type: 'JOB_DONE', actor: 'sys', at, layer, job_key: key, payload: { reason: 'has_claims' } }])
      skipped.push({ layer, reason: 'has_claims' })
      continue
    }
    if (!pick) { skipped.push({ layer, reason: 'empty' }); continue }
    append(db, aid, [
      { type: 'CLAIM_EXP', layer, actor: 'sys', at, payload: { claims: [{ layer, kind: pick.kind, text: pick.text, origin: 'seed' }] } },
      { type: 'JOB_DONE', actor: 'sys', at, layer, job_key: key, payload: { reason: 'seeded' } },
    ])
    seeded.push(layer)
  }
  return { seeded, skipped }
}

/** 撤回尚未占用的种子。不满足时抛 SangguanError，message 给页面。 */
export function withdrawSeed(db, aid, id, at) {
  const s = loadState(db, aid)
  const c = s.claims[id]
  if (!c) throw new SangguanError('INVALID', '没有这个命题')
  for (const k of Object.values(s.kappas)) {
    if (SIGMA_OPEN.includes(k.sigma) && (k.pos_id === id || k.neg_id === id)) {
      throw new SangguanError('BUSY', '先等这场矛盾结束')
    }
  }
  if (c.origin !== 'seed' || c.status !== 'active') throw new SangguanError('INVALID', '这条不能撤回')
  if (c.pi !== 0 || c.n !== 0) throw new SangguanError('BUSY', '已经长出后续，不能撤回')
  for (const o of Object.values(s.claims)) {
    if (o.id !== id && (o.pred || []).includes(id)) throw new SangguanError('BUSY', '已经长出后续，不能撤回')
  }
  const r = append(db, aid, [{ type: 'CLAIM_WITHDRAW', layer: c.layer, actor: 'user', at, payload: { claim_id: id } }])
  return { ok: true, id: r.ids[0], status: 'withdrawn' }
}
