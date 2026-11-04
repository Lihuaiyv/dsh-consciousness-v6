/**
 * 合并：说的是同一取舍方向的几条，归成一条，保留多种说法。
 *
 * 为什么不能 UPDATE：命题表有只增触发器。所以合并 = 新建一条 + 把旧的收回（CLAIM_RETIRE），
 * 旧原文进新条的 meta.variants，账本一行都不删。
 */
import { append, newId } from './ledger.js'
import { loadState } from './projection.js'
import { isCoreKind, isTerminal } from './catalog.js'
import { SangguanError } from './errors.js'
import { pendingNusOf } from './retire.js'

/**
 * @param {string[]} ids 至少两条、都是活跃保护带
 * @param {{text?:string, reason?:string, at?:string}} opt
 * @returns {{id:string, retired:string[], voided:string[], variants:Array}}
 */
export function mergeClaims(db, aid, ids, opt = {}) {
  const list = [...new Set((ids || []).filter(Boolean))]
  if (list.length < 2) throw new SangguanError('INVALID', '合并至少要两条')
  const at = opt.at || new Date().toISOString()
  const s = loadState(db, aid)
  const texts = new Map(db.prepare('SELECT id,text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
  const rows = list.map((id) => {
    const c = s.claims[id]
    if (!c) throw new SangguanError('INVALID', '命题不存在', { id })
    if (isTerminal(c.status)) throw new SangguanError('INVALID', '命题已终态', { id })
    if (isCoreKind(c.layer, c.kind)) throw new SangguanError('INVALID', '核心不能合并', { id })
    if (c.layer !== 'V') throw new SangguanError('INVALID', '目前只合并价值观条目', { id })
    return c
  })
  const newId_ = newId('claims', at)
  const variants = rows.map((c) => ({ text: (texts.get(c.id) || '').slice(0, 100), claim_id: c.id, at }))
  const text = String(opt.text || texts.get(rows[0].id) || '').slice(0, 300)
  if (!text) throw new SangguanError('INVALID', '缺合并后的正文')
  const voided = []
  const batch = []
  for (const c of rows) {
    for (const nu of pendingNusOf(s, c.id)) {
      voided.push(nu)
      batch.push({ type: 'NU_RESOLVE', actor: 'sys', at, payload: { nu_id: nu, outcome: 'void', why: 'claim_merged' } })
    }
  }
  batch.push({
    type: 'CLAIM_EXP', layer: 'V', actor: 'user', at,
    gate_report: { lane: 'V', merged_from: list },
    payload: {
      claims: [{
        id: newId_, layer: 'V', kind: 'norm', text, origin: 'user', boundary: [],
        meta: { variants, lane_phase: 'V-draft' },
      }],
      q_hint: null,
    },
  })
  for (const c of rows) {
    batch.push({ type: 'CLAIM_RETIRE', layer: 'V', actor: 'user', at, payload: { claim_id: c.id, reason: opt.reason || ('合并进 ' + newId_) } })
  }
  append(db, aid, batch)
  return { id: newId_, retired: list, voided, variants }
}

/** 推导边：核心 → 下条。方向固定，查「谁推出了它」走反查。 */
export function linkDerives(db, aid, fromId, toIds, opt = {}) {
  const at = opt.at || new Date().toISOString()
  const ids = [...new Set((toIds || []).filter(Boolean))].filter((id) => id !== fromId)
  if (!fromId || !ids.length) return { added: 0 }
  const s = loadState(db, aid)
  if (!s.claims[fromId]) throw new SangguanError('INVALID', '推出方不存在', { id: fromId })
  const edges = ids.map((to) => ({ type: 'DERIVES', from_id: fromId, to_id: to }))
  append(db, aid, [{ type: 'EDGE_ADD', actor: 'user', at, payload: { edges } }])
  return { added: edges.length }
}

/** 一条核心推出了哪些下条（只算活跃边）。 */
export function derivesOf(db, aid, fromId) {
  const s = loadState(db, aid)
  return Object.values(s.edges).filter((e) => e.active && e.type === 'DERIVES' && e.from_id === fromId).map((e) => e.to_id)
}
