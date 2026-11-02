/**
 * 十维折算（只算数字，不碰页面/提示词）。
 *
 * 为什么单独一层：`sangguan/bridge.js` 会把 `worldview/lifeview → persona.js → drive.js`
 * 绕成一圈，而 `drive.js` 恰恰要读十维权重。把「命题 → 十维」这段抽成叶子模块，
 * drive 只依赖这里，就不会成环。
 */
import { loadState } from './projection.js'
import { assignDims, foldDims } from './tags.js'
import { isTerminal } from './catalog.js'

/** 账本里 V 层还活着的命题（带文本，给 assignDims 打分用） */
export function liveValueClaims(db, aid) {
  try {
    const s = loadState(db, aid)
    const tx = new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
    return Object.values(s.claims)
      // commit（承诺）不是价值取向：不进十维，免得把待办当成人格
      .filter((c) => c.layer === 'V' && !isTerminal(c.status) && c.kind !== 'commit')
      .map((c) => ({ id: c.id, text: tx.get(c.id) || '', pi: c.pi, n: c.n }))
  } catch {
    return []
  }
}

/**
 * 命题 → 十维权重。没有命题时返回 null（调用方自己决定退回均匀还是旧值）。
 * @returns {null | { weights: Record<string, number>, max: number, claims: number }}
 */
export function foldValueWeights(db, aid) {
  const claims = liveValueClaims(db, aid)
  if (!claims.length) return null
  const assigned = []
  for (const c of claims) {
    const one = assignDims([c])
    if (one && one.length && one[0].score > 0) assigned.push(one[0])
  }
  if (!assigned.length) return null
  const folded = foldDims(assigned)
  return { weights: folded.weights, max: folded.max, claims: assigned.length }
}
