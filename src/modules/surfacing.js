/**
 * 浮现观测：这一轮把哪几条塞进了上下文，回复里到底用没用上。
 *
 * 没有这个数，「浮上来」只是感觉：加完配额、加完开环，看着像加了，
 * 却不知道模型有没有把它们说出来、哪条总被无视。有了它才能调权重和配额。
 *
 * 两个口径：
 *   浮现 = 这一轮注入的条数（按 kind 分：anchor / fresh / related）
 *   用上 = 回复正文里出现了这条记忆的 2-gram（覆盖率 ≥ 0.3），十轮内只判一次
 */
import { now } from '../db.js'

const WINDOW_MS = 10 * 60 * 1000

function norm(s) {
  return String(s || '').replace(/[\s\p{P}]/gu, '')
}

function grams(s) {
  const t = norm(s)
  const out = new Set()
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

/** 记下这一轮注入的条目。kind 来自 retrieve 的 via（anchor / fresh / link / vec / related）。 */
export function recordSurfaced(db, aid, items, at = Date.now()) {
  const rows = (items || []).filter((x) => x && x.text)
  if (!rows.length) return 0
  const stamp = new Date(at).toISOString()
  const ins = db.prepare('INSERT INTO surfaced_items(id,agent_id,memory_id,kind,text,at) VALUES(?,?,?,?,?,?)')
  for (const it of rows) {
    ins.run('sf_' + Math.random().toString(16).slice(2, 12), aid, it.id || null,
      String(it.via || 'related'), String(it.text).replace(/\s+/g, ' ').slice(0, 200), stamp)
  }
  return rows.length
}

/** 回复真的用上了哪条：按 2-gram 覆盖率 ≥ 0.3 判。 */
export function markSurfacedUsed(db, aid, reply, at = Date.now()) {
  const R = grams(reply)
  if (!R.size) return 0
  let rows = []
  try {
    rows = db.prepare('SELECT id, text FROM surfaced_items WHERE agent_id=? AND used=0 AND at>=?')
      .all(aid, new Date(at - WINDOW_MS).toISOString())
  } catch { return 0 }
  const up = db.prepare('UPDATE surfaced_items SET used=1, used_at=? WHERE id=?')
  const stamp = new Date(at).toISOString()
  let n = 0
  for (const r of rows) {
    const g = grams(r.text)
    if (g.size < 4) continue
    let hit = 0
    for (const x of g) if (R.has(x)) hit++
    if (hit / g.size >= 0.3) { up.run(stamp, r.id); n++ }
  }
  return n
}

/** 最近 N 天的浮现率：注入多少、被用上多少。 */
export function surfacingStats(db, aid, days = 7) {
  const d = Math.max(1, Math.min(365, Number(days) || 7))
  const since = new Date(Date.now() - d * 86400000).toISOString()
  let rows = []
  try {
    rows = db.prepare('SELECT kind, COUNT(*) n, SUM(used) u FROM surfaced_items WHERE agent_id=? AND at>=? GROUP BY kind').all(aid, since)
  } catch { return { days: d, surfaced: 0, used: 0, rate: null, by_kind: {} } }
  const by = {}
  let total = 0
  let used = 0
  for (const r of rows) {
    const n = Number(r.n) || 0
    const u = Number(r.u) || 0
    by[r.kind] = { surfaced: n, used: u, rate: n ? +(u / n).toFixed(3) : null }
    total += n
    used += u
  }
  return { days: d, surfaced: total, used, rate: total ? +(used / total).toFixed(3) : null, by_kind: by }
}

/** 只留最近 N 天，别让观测表无限长（观测不进任何召回路径）。 */
export function pruneSurfaced(db, days = 60, at = Date.now()) {
  const cut = new Date(at - Math.max(1, Number(days) || 60) * 86400000).toISOString()
  try { return Number(db.prepare('DELETE FROM surfaced_items WHERE at<?').run(cut).changes || 0) } catch { return 0 }
}
