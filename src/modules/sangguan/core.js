/**
 * 核心确立 CORE_ESTABLISH（logic-gates §4.1，code-guide J9）：核心数未满时，保护带可以「长出」核心。
 * [D] kind∈Belt ∧ active ∧ π≥π_core ∧ n≥n_min ∧ n_dep≥2 ∧ 不在未结 κ 中；[J] J9 基本立场且不与现有核心矛盾。
 * 效果：新建核心（pred=[b]），b → superseded；指向 b 的 DEPENDS 同事务退役后改指新核（边只增）。
 * 每层每夜至多确立 1 条；J9 结果按（候选, 现有核心）永久缓存，不会每夜重复花钱。
 */
import { LAYERS, CORE_KIND, BELT_KINDS, SIGMA_OPEN, isCoreKind, isTerminal } from './catalog.js'
import { theta, isHollowSeed } from './fold.js'
import { loadState } from './projection.js'
import { append, newId } from './ledger.js'
import { call } from './llm.js'
import './templates.js'

function headsOfCore(s, layer) {
  return Object.values(s.claims).filter((c) => c.layer === layer && isCoreKind(layer, c.kind) && !isTerminal(c.status) && !isHollowSeed(c))
}

/**
 * 世界观能不能立核心（B1 修正）。
 *
 * 旧规则「V 一条活的都没有时，W 不许新增」会死锁：V 要真实取舍才长，工程对话里没有取舍，
 * 于是 V 永远空、W 永远不进。改成只拦「立核心」，不拦保护带；并且给第二条出路——
 * 它的预料被现实打脸过（≥2 次结算且至少 1 次 miss），也算有据可依。
 */
export function wCoreAllowed(s) {
  const hasV = Object.values(s.claims).some((c) => c.layer === 'V' && !isTerminal(c.status))
  if (hasV) return true
  const wIds = new Set(Object.values(s.claims).filter((c) => c.layer === 'W').map((c) => c.id))
  const settled = Object.values(s.nus).filter((n) => wIds.has(n.claim_id) && (n.outcome === 'hit' || n.outcome === 'miss'))
  return settled.length >= 2 && settled.some((n) => n.outcome === 'miss')
}

/** 某层现在能不能立核心。返回 null 表示可以，否则是跳过原因。 */
export function coreLaneGate(layer, s) {
  if (layer !== 'W') return null
  if (Number(theta(s, 'growth_order') || 0) < 1) return null
  return wCoreAllowed(s) ? null : 'growth_order'
}

export function coreCandidates(s, layer) {  const busy = new Set()
  for (const k of Object.values(s.kappas)) if (SIGMA_OPEN.includes(k.sigma)) { busy.add(k.pos_id); busy.add(k.neg_id) }
  const nMin = Math.round(theta(s, 'n_min', layer))
  const piCore = theta(s, 'pi_core', layer)
  return Object.values(s.claims)
    .filter((c) => c.layer === layer && BELT_KINDS[layer].includes(c.kind) && c.status === 'active'
      && c.pi >= piCore - 1e-9 && c.n >= nMin && c.n_dep >= 2 && !busy.has(c.id))
    .sort((a, b) => b.e - a.e || (a.id < b.id ? -1 : 1))
}

export async function establishCores(db, aid, now, opt = {}) {
  const did = []
  const skipped = []
  for (const layer of LAYERS) {
    const s = loadState(db, aid)
    const cores = headsOfCore(s, layer)
    if (cores.length >= theta(s, 'C_max', layer)) continue
    const laneGate = coreLaneGate(layer, s)
    if (laneGate) { skipped.push({ layer, reason: laneGate }); continue }
    const texts = Object.fromEntries(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=? AND layer=?').all(aid, layer).map((r) => [r.id, r.text]))
    for (const b of coreCandidates(s, layer)) {
      const input = { layer, candidate: { id: b.id, text: texts[b.id] || '' }, cores: cores.map((c) => ({ id: c.id, text: texts[c.id] || '' })) }
      const r = await call({ db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat }, 'J9', input, { tier: 'T1', pool: 'mid' })
      if (!r.ok && r.code === 'BUDGET') return { did, skipped, postponed: true }
      if (!r.ok || !r.out.basic.pass || r.out.conflicts_with.length) {
        skipped.push({ id: b.id, reason: r.ok ? (r.out.conflicts_with.length ? 'conflict' : 'not_basic') : r.code })
        continue
      }
      const cid = newId('claims', now)
      const deps = Object.values(s.edges).filter((e) => e.active && e.type === 'DEPENDS' && e.to_id === b.id)
      const evs = [
        {
          type: 'CORE_ESTABLISH', layer, actor: 'judge', at: now, gate_report: { J9: r.out, pi: b.pi, n: b.n, n_dep: b.n_dep },
          payload: { from_id: b.id, claims: [{ id: cid, layer, kind: CORE_KIND[layer], text: r.out.text || texts[b.id], origin: b.origin, pred: [b.id] }] },
        },
        ...deps.map((e) => ({ type: 'EDGE_RETIRE', actor: 'sys', at: now, payload: { edge_id: e.id, reason: 'core_establish' } })),
      ]
      if (deps.length) evs.push({ type: 'EDGE_ADD', actor: 'sys', at: now, payload: { edges: deps.map((e) => ({ type: 'DEPENDS', from_id: e.from_id, to_id: cid })) } })
      try {
        append(db, aid, evs, { claims: { [b.id]: 'active' } })
        did.push({ layer, from: b.id, core: cid })
      } catch (e) { skipped.push({ id: b.id, reason: e.code || 'ERR' }) }
      break
    }
  }
  return { did, skipped }
}
