/**
 * 遗忘可见性（只读）：哪些记忆、哪些轮次属于「已经说好要忘的」。
 *
 * 为什么要单独一层：`asof` 取原话有两条路（按 turn_id 直读、按话题在时间窗里搜），
 * 两条都不看可见性——结论 HIDE 了，原话还能被端出来。汇流也会读原话，必须共用同一层，
 * 否则修了这边、那边又漏一遍，同一个洞开两次。
 *
 * 口径：
 *   - 记忆层：memory_timeline 里出现过 HIDE / DELETE 的 memory_id，或 memory_items 已是
 *     soft_deleted / deleted / 有 deleted_at。
 *   - 轮次层：这些记忆在 memory_items.source_turn_id 或 fact_archive.source_turn_id 上
 *     指向的 turn。
 *   - 粒度：**整轮排除**。用户说「忘掉这件事」时，那一轮的原话就是那件事本身；
 *     留半句反而是更糟的泄露（见 bug-asof-遗忘不彻底-2026-11-09.md §4.1）。
 *
 * 边界：只读。不写表、不改状态、不 touch。
 */

/** 已经说好要忘的记忆 id 集合。 */
export function forgottenMemoryIds(db, aid) {
  const out = new Set()
  if (!aid) return out
  try {
    const rows = db.prepare(
      "SELECT memory_id FROM memory_timeline WHERE agent_id=? AND op IN ('HIDE','DELETE')"
    ).all(aid)
    for (const r of rows) if (r.memory_id) out.add(String(r.memory_id))
  } catch { /* 老库没有时效索引 */ }
  try {
    const rows = db.prepare(
      "SELECT id FROM memory_items WHERE agent_id=? AND (status IN ('soft_deleted','deleted') OR deleted_at IS NOT NULL)"
    ).all(aid)
    for (const r of rows) if (r.id) out.add(String(r.id))
  } catch { /* 老库没有 deleted_at */ }
  return out
}

/**
 * 落在某个时间窗里的「已忘」记忆条数。
 * 用途：老账可能没有 source_turn_id（现库 55 条 HIDE 全部如此），精确到轮封不住；
 * 这时 asof 只能保守处理——这一窗里但凡有忘掉的东西，就不按话题去搜原文。
 */
export function forgottenInWindow(db, aid, from, to) {
  const ids = [...forgottenMemoryIds(db, aid)]
  if (!ids.length) return 0
  const hit = new Set()
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)
    const ph = part.map(() => '?').join(',')
    try {
      for (const r of db.prepare(
        `SELECT id FROM memory_items WHERE agent_id=? AND id IN (${ph}) AND created_at>=? AND created_at<?`
      ).all(aid, ...part, from, to)) hit.add(String(r.id))
    } catch { /* ignore */ }
    try {
      for (const r of db.prepare(
        `SELECT memory_id id FROM fact_archive WHERE agent_id=? AND memory_id IN (${ph}) AND created_at>=? AND created_at<?`
      ).all(aid, ...part, from, to)) hit.add(String(r.id))
    } catch { /* ignore */ }
  }
  return hit.size
}

/**
 * 「已忘」的时间窗：老账没有 turn 链，只能按时间划一个保守窗。
 * 中心优先用来源原话的时间（有链时更准），没有就用入库时间。
 * 这样只封那一段，不会因为一条老账把整年的原话都封掉。
 */
export function forgottenWindows(db, aid, { slackHours = 12, from = null, to = null } = {}) {
  const ids = [...forgottenMemoryIds(db, aid)]
  if (!ids.length) return []
  const centers = new Map()
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)
    const ph = part.map(() => '?').join(',')
    try {
      for (const r of db.prepare(
        `SELECT id, created_at, source_turn_id FROM memory_items WHERE agent_id=? AND id IN (${ph})`
      ).all(aid, ...part)) {
        centers.set(String(r.id), { at: r.created_at, turn: r.source_turn_id || null })
      }
    } catch { /* ignore */ }
    try {
      for (const r of db.prepare(
        `SELECT memory_id id, created_at, source_turn_id FROM fact_archive WHERE agent_id=? AND memory_id IN (${ph})`
      ).all(aid, ...part)) {
        const prev = centers.get(String(r.id)) || {}
        centers.set(String(r.id), {
          at: prev.at || r.created_at,
          turn: prev.turn || r.source_turn_id || null,
        })
      }
    } catch { /* ignore */ }
  }
  const slack = Math.max(0, Number(slackHours) || 12) * 3600000
  const out = []
  for (const [id, c] of centers) {
    let center = Date.parse(c.at)
    if (c.turn) {
      try {
        const t = db.prepare('SELECT MIN(created_at) t FROM fragments WHERE agent_id=? AND turn_id=?').get(aid, String(c.turn))
        if (t && t.t) center = Date.parse(t.t)
      } catch { /* ignore */ }
    }
    if (!Number.isFinite(center)) continue
    const a = new Date(center - slack).toISOString()
    const b = new Date(center + slack).toISOString()
    if (from && b < from) continue
    if (to && a > to) continue
    out.push({ memory_id: id, from: a, to: b })
  }
  return out
}

/** 这些记忆指向的原话轮次（整轮算被忘）。 */
export function forgottenTurnIds(db, aid) {
  const ids = [...forgottenMemoryIds(db, aid)]
  const out = new Set()
  if (!ids.length) return out
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)
    const ph = part.map(() => '?').join(',')
    try {
      const rows = db.prepare(
        `SELECT source_turn_id t FROM memory_items
          WHERE agent_id=? AND source_turn_id IS NOT NULL AND source_turn_id<>'' AND id IN (${ph})`
      ).all(aid, ...part)
      for (const r of rows) if (r.t) out.add(String(r.t))
    } catch { /* ignore */ }
    try {
      const rows = db.prepare(
        `SELECT source_turn_id t FROM fact_archive
          WHERE agent_id=? AND source_turn_id IS NOT NULL AND source_turn_id<>'' AND memory_id IN (${ph})`
      ).all(aid, ...part)
      for (const r of rows) if (r.t) out.add(String(r.t))
    } catch { /* ignore */ }
  }
  return out
}

/** 一轮是不是被忘了。给单点调用用；批量别用它（每次都会重算集合）。 */
export function isTurnForgotten(db, aid, turnId, forgotten = null) {
  if (!turnId) return false
  const set = forgotten instanceof Set ? forgotten : forgottenTurnIds(db, aid)
  return set.has(String(turnId))
}

/**
 * 过滤一批带 turn_id 的行。返回 { kept, dropped }。
 * dropped 只计数，不带正文——日志里不该再出现被忘的内容。
 */
export function filterForgotten(db, aid, rows, { key = 'turn_id', forgotten = null } = {}) {
  const set = forgotten instanceof Set ? forgotten : forgottenTurnIds(db, aid)
  const kept = []
  let dropped = 0
  for (const r of rows || []) {
    const t = r && r[key]
    if (t && set.has(String(t))) { dropped++; continue }
    kept.push(r)
  }
  return { kept, dropped }
}
