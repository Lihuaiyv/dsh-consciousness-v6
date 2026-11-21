/**
 * 记忆一张表（只读体检，2026-11-15）
 *
 * 目的：P5 观测收口——把散在几个脚本里的关键数字，用一条命令看一眼。
 * 只读真库；不写、不改、不调模型。
 *
 *   node scripts/health-memory.mjs
 */
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DB = process.argv[2] || path.resolve('..', 'runtime', 'consciousness', 'app.db')
const db = new DatabaseSync(DB, { readOnly: true })
const AID = 'agt_3977d80f17'
const now = Date.now()

const median = (xs) => {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2)
}

const out = { at: new Date(now).toISOString(), db: DB }
try {
  out.events = {
    cold: db.prepare('SELECT COUNT(*) n FROM cold_events WHERE agent_id=?').get(AID).n,
    hot: db.prepare('SELECT COUNT(*) n FROM hot_events WHERE agent_id=? AND active=1').get(AID).n,
    last: db.prepare('SELECT MAX(created_at) t FROM cold_events WHERE agent_id=?').get(AID).t,
  }
  out.quality = db.prepare("SELECT quality, COUNT(*) n FROM hot_events WHERE agent_id=? AND active=1 GROUP BY quality ORDER BY n DESC").all(AID)
  out.memory = db.prepare("SELECT type, COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' GROUP BY type ORDER BY n DESC LIMIT 6").all(AID)
  out.inject = {
    tokensMedian: median(db.prepare("SELECT value FROM metric_samples WHERE key='sys.inject_tokens' ORDER BY sampled_at DESC LIMIT 300").all().map((r) => Number(r.value)).filter(Number.isFinite)),
    eventInject7d: db.prepare("SELECT COUNT(*) n FROM events WHERE type='event.inject' AND created_at>=?").get(new Date(now - 7 * 86400000).toISOString()).n,
  }
  out.queues = {
    surfacePending: db.prepare("SELECT COUNT(*) n FROM surface_queue WHERE agent_id=? AND state='pending'").get(AID).n,
    loopsDue: db.prepare("SELECT COUNT(*) n FROM open_loops WHERE agent_id=? AND state IN ('open','half_said') AND due_at IS NOT NULL AND due_at<=? AND COALESCE(fire_count,0)<5").get(AID, new Date(now).toISOString()).n,
  }
  out.selfRecallMix = (() => {
    try {
      const rows = db.prepare("SELECT type, COUNT(*) n FROM events WHERE type IN ('event.inject') AND created_at>=? GROUP BY type").all(new Date(now - 7 * 86400000).toISOString())
      return { eventInject7d: rows.reduce((s, r) => s + r.n, 0) }
    } catch { return null }
  })()
} catch (e) {
  out.error = String(e && e.message || e).slice(0, 200)
}
console.log(JSON.stringify(out, null, 2))
db.close()
