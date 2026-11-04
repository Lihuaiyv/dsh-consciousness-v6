/**
 * 旧价值观残根清退（P0）。只做两件事：
 *   1. V 层 origin=seed 的空心命题（旧十维表折出来的那几句）走 CLAIM_WITHDRAW——账本只增，不删
 *   2. 清空 persona_values 的行；表本身留不留由调用方决定
 *
 * 幂等：没有残根时返回全 0；重复跑不会多记账。
 */
import { loadState } from './projection.js'
import { withdrawSeed } from './seed.js'
import { isCoreKind, isTerminal } from './catalog.js'
import { append } from './ledger.js'
import { SangguanError } from './errors.js'

export function retireOldValues(db, at) {
  const out = { withdrawn: 0, purged: 0, v_seed_before: 0, v_seed_after: 0, detail: [] }
  let agents = []
  try { agents = db.prepare('SELECT id,name FROM agents').all() } catch { return out }

  for (const a of agents) {
    let s = null
    try { s = loadState(db, a.id) } catch { continue }
    let rows = []
    try { rows = db.prepare("SELECT id,text FROM persona_claims WHERE agent_id=? AND layer='V' AND origin='seed'").all(a.id) } catch { continue }
    for (const r of rows) {
      const c = s.claims[r.id]
      if (!c || isCoreKind('V', c.kind) || isTerminal(c.status)) continue
      if (c.status !== 'active') continue
      out.v_seed_before++
      try {
        // 还没被占用：按撤回种子处理；已经长出证据：按保护带收回处理（同样的终态，账本只增）
        if (c.pi === 0 && c.n === 0 && (c.pred || []).length === 0) withdrawSeed(db, a.id, r.id, at)
        else append(db, a.id, [{ type: 'CLAIM_RETIRE', layer: 'V', actor: 'user', at, payload: { claim_id: r.id, reason: '从已下线的旧十维表种进来' } }])
        out.withdrawn++
        out.detail.push({ agent: a.name || a.id, id: r.id, text: r.text, grown: c.n > 0 })
      } catch { /* 已被别的路径处理 */ }
    }
  }

  try { out.purged = db.prepare('DELETE FROM persona_values').run().changes } catch { out.purged = 0 }

  for (const a of agents) {
    try {
      const st = loadState(db, a.id)
      out.v_seed_after += Object.values(st.claims).filter((c) => c.layer === 'V' && c.origin === 'seed' && !['superseded', 'falsified', 'sublated', 'demoted', 'withdrawn'].includes(c.status)).length
    } catch { /* 空库 */ }
  }
  return out
}

/** 指向这条命题、还没到期的预见。收回命题前必须一起作废，否则「预见与回流」会指向一条退休的命题。 */
export function pendingNusOf(state, claimId) {
  return Object.values((state && state.nus) || {})
    .filter((n) => n.claim_id === claimId && n.outcome === 'pending')
    .map((n) => n.id)
}

/**
 * 收回一条保护带命题，并把悬空的预见一并作废（同一批次，任何一步失败整批回滚）。
 * 已终态的直接跳过，重复执行安全。核心不能收回，只能走升维。
 * @returns {{ retired: string|null, voided: string[], skipped?: string }}
 */
export function retireClaim(db, aid, claimId, opt = {}) {
  const at = opt.at || new Date().toISOString()
  const actor = opt.actor || 'user'
  const reason = String(opt.reason || '按三列判据不合格').slice(0, 200)
  const s = loadState(db, aid)
  const c = s.claims[claimId]
  if (!c) throw new SangguanError('INVALID', '命题不存在', { claim_id: claimId })
  if (isTerminal(c.status)) return { retired: null, voided: [], skipped: 'terminal' }
  if (isCoreKind(c.layer, c.kind)) throw new SangguanError('INVALID', '核心不能收回，换核心只能走升维', { claim_id: claimId })
  const nus = pendingNusOf(s, claimId)
  const batch = [
    ...nus.map((id) => ({ type: 'NU_RESOLVE', actor: 'sys', at, payload: { nu_id: id, outcome: 'void', why: 'claim_retired' } })),
    { type: 'CLAIM_RETIRE', layer: c.layer, actor, at, payload: { claim_id: claimId, reason } },
  ]
  append(db, aid, batch)
  return { retired: claimId, voided: nus }
}
