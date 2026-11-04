/**
 * 防「祥林嫂」：同一件自己 的事不要在注入里反复念。
 *
 * 做法很轻：每次一条自己的记忆真的进了注入块，就记一笔事件
 * （memory.self.shown，payload 是一批 id，一轮只落一条）。
 * 下一轮检索前，把最近 N 小时里已经露过 max 次的那几条挡掉；
 * 如果一条都不剩，就挑露得最少的那条兜底——宁可重复一次，也不能一条都不给。
 *
 * 为什么不存一张表：events 本来就在、有 agent/时间索引，几十条/天的量
 * 用 JSON 数组塞 payload 足够，不值得为它加一张要跟着 purge 的表。
 */
import { now } from '../db.js'
import { event } from '../kernel.js'

const HOUR_MS = 3600000

/** 最近还会被注入的那些自己的事的 id（self / life、活着、没作废）。 */
export function recentSelfIds(db, aid, limit = 40) {
  const n = Math.max(1, Math.min(200, Number(limit) || 40))
  try {
    return db.prepare(`SELECT id FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND source IN ('self','life')
      ORDER BY created_at DESC LIMIT ?`).all(aid, n).map((r) => String(r.id))
  } catch { return [] }
}

/**
 * 每个 id 在最近 hours 小时里被注入过几次。
 * 只数传进来的 id（其它条目的历史不占内存）；读不到就返回空表，当作没露过。
 */
export function shownCounts(db, aid, ids, hours) {
  const h = Math.max(0.1, Math.min(720, Number(hours) || 24))
  const since = new Date(Date.now() - h * HOUR_MS).toISOString()
  const want = new Set((ids || []).map(String))
  const out = new Map()
  if (!want.size) return out
  try {
    const rows = db.prepare(`SELECT payload FROM events
      WHERE agent_id=? AND type='memory.self.shown' AND created_at>?
      ORDER BY created_at DESC LIMIT 2000`).all(aid, since)
    for (const r of rows) {
      let p = null
      try { p = JSON.parse(r.payload || '{}') } catch { continue }
      for (const id of (Array.isArray(p && p.ids) ? p.ids : [])) {
        const k = String(id)
        if (want.has(k)) out.set(k, (out.get(k) || 0) + 1)
      }
    }
  } catch { /* 老库没有 events 表就当作没露过 */ }
  return out
}

/** 记一笔「这一轮这几条真的进了注入块」。一轮只写一条事件。 */
export function markShown(db, aid, ids) {
  const list = (ids || []).map(String).filter(Boolean)
  if (!list.length) return 0
  try {
    event(db, aid, 'memory.self.shown', { ids: list, ts: Date.now() })
    return 1
  } catch { return 0 }
}

export { now }
