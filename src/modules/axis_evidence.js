/**
 * 性格五轴的「证据累加器」（Whole Trait Theory 的落地点）
 *
 * 以前：只有「被夸」数到 10 次才动一次 T/F，而且关键词一换就永远不动。
 * 现在：每一轮先把发生的事记成一条证据（axis/dir/strength/source），
 *       只有当「最近窗口内、同一方向、够多条、平均强度够」时才推一次轴。
 *
 * 为什么不是「情绪一差就变内向」：人际特质是行为重复出来的，
 * 单次心情属于状态，不该直接写进特质。所以这里只收「事件」，不收「心情」。
 *
 * 写入轴仍然走 traits.setAxisAuto：一次 ≤0.05、6 轮冷却、往中间回要两次，
 * 这些老闸门全部保留；本模块只负责「决定什么时候值得试一次」。
 */
import { now } from '../db.js'
import { nid, getParam } from '../kernel.js'
import { setAxisAuto, AXIS_KEYS, STEP } from './traits.js'

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

/** 记一条证据。dir=+1 往「高」一侧（偏外向 / 偏直觉 / 偏情感 / 偏判断 / 更敏感）。 */
export function addEvidence(db, aid, { axis, dir = 1, strength = 0.5, source = 'chat', refId = null, at = null } = {}) {
  if (!AXIS_KEYS.includes(axis)) return null
  const d = Number(dir) < 0 ? -1 : 1
  const s = clamp01(strength)
  const id = nid('axe_')
  const stamp = at || now()
  try {
    db.prepare(`INSERT INTO axis_evidence(id,agent_id,axis,dir,strength,source,ref_id,at,used)
      VALUES(?,?,?,?,?,?,?,?,0)`)
      .run(id, aid, axis, d, Math.round(s * 1000) / 1000, String(source || 'chat'), refId || null, stamp)
  } catch {
    return null
  }
  return { id, axis, dir: d, strength: s, at: stamp }
}

/** 未参与过漂移的证据（最近的 window 条） */
export function pending(db, aid, axis, window = 20) {
  try {
    return db.prepare(`SELECT id, dir, strength, source, ref_id, at FROM axis_evidence
      WHERE agent_id=? AND axis=? AND used=0 ORDER BY at DESC LIMIT ?`)
      .all(aid, axis, Math.max(1, Math.min(200, Number(window) || 20)))
  } catch {
    return []
  }
}

/** 单轴密度：哪边证据多、平均强度多少 */
export function density(db, aid, axis, window = 20) {
  const rows = pending(db, aid, axis, window)
  const up = rows.filter((r) => Number(r.dir) > 0)
  const down = rows.filter((r) => Number(r.dir) < 0)
  const avg = (arr) => (arr.length ? arr.reduce((s, r) => s + num(r.strength, 0.5), 0) / arr.length : 0)
  const side = up.length >= down.length ? up : down
  return {
    axis, total: rows.length,
    up: up.length, down: down.length,
    dir: side.length ? (Number(side[0].dir) > 0 ? 1 : -1) : 0,
    count: side.length,
    avg: Math.round(avg(side) * 1000) / 1000,
    rows: side,
  }
}

/**
 * 把所有轴过一遍：够密度就试一次漂移。
 * @returns {Array<{axis:string,before:number,after:number,delta:number,why:string}>}
 */
export function flush(db, aid) {
  const window = num(getParam(db, aid, 'persona.evidence.window'), 20)
  const minCount = num(getParam(db, aid, 'persona.evidence.min'), 3)
  const minStrength = num(getParam(db, aid, 'persona.evidence.strength'), 0.25)
  const moved = []
  for (const axis of AXIS_KEYS) {
    let d
    try { d = density(db, aid, axis, window) } catch { continue }
    if (!d.dir || d.count < minCount || d.avg < minStrength) continue
    // 强度 0.25 → 0.0125，1.0 → 0.05；仍受 setAxisAuto 的 0.05 上限约束
    const delta = Math.max(0.005, Math.min(STEP, d.avg * 0.5))
    const why = `证据 ${d.count} 条（${d.dir > 0 ? '+' : '−'}${d.avg}）`
    let res
    try {
      res = setAxisAuto(db, aid, axis, d.dir * delta, why)
    } catch {
      continue
    }
    if (!res || !res.changed) continue
    // 这一侧的旧的证据标记已用，避免同一批反复推
    try {
      const ids = d.rows.map((r) => r.id)
      const st = db.prepare('UPDATE axis_evidence SET used=1 WHERE id=?')
      for (const id of ids) st.run(id)
    } catch { /* 标记失败最多多推一次，不影响正确性 */ }
    moved.push({
      axis,
      before: res.before,
      after: res.after,
      delta: Math.round((res.after - res.before) * 1000) / 1000,
      why,
    })
  }
  return moved
}

/** 清理老证据（默认 60 天前），防止表无限长 */
export function prune(db, aid, days = 60) {
  const cutoff = new Date(Date.now() - Math.max(1, Number(days) || 60) * 86400000).toISOString()
  try {
    return db.prepare('DELETE FROM axis_evidence WHERE agent_id=? AND at<?').run(aid, cutoff).changes
  } catch {
    return 0
  }
}

/** 快照（UI / 调试用）：每条轴现在攒了多少证据 */
export function snapshot(db, aid) {
  const window = num(getParam(db, aid, 'persona.evidence.window'), 20)
  return AXIS_KEYS.map((axis) => {
    const d = density(db, aid, axis, window)
    return { axis, total: d.total, up: d.up, down: d.down, dir: d.dir, count: d.count, avg: d.avg }
  })
}
