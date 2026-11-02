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
