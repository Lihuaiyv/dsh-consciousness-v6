/**
 * 检索回放日志
 *
 * 每次召回落一行：场景、候选数、过门数、注入了多少 token、耗时。
 * 调阈值（0.35 该升还是该降、S3 是不是太爱触发）全靠它，不靠感觉。
 *
 * 只写不读热路径；默认留 30 天，写入时 2% 概率顺手清一次旧行。
 */

import { now } from '../db.js'
import { nid } from '../kernel.js'

export const KEEP_DAYS = 30

function json(v, fallback) {
  if (v == null) return fallback
  try { return JSON.parse(v) } catch { return fallback }
}

/** 记一次召回。失败不影响对话（日志永远不能成为单点）。 */
export function logRetrieval(db, aid, rec = {}) {
  try {
    const at = String(rec.at || now())
    db.prepare(`INSERT INTO retrieval_log(id,agent_id,at,scene,query,why,counts,kept,dropped,items,tokens,ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      nid('rlg_'), aid, at, String(rec.scene || 'S1'), String(rec.query || '').slice(0, 200),
      rec.why == null ? null : JSON.stringify(rec.why).slice(0, 800),
      rec.counts == null ? null : JSON.stringify(rec.counts).slice(0, 800),
      rec.kept == null ? null : JSON.stringify(rec.kept).slice(0, 800),
      rec.dropped == null ? null : JSON.stringify(rec.dropped).slice(0, 800),
      Number(rec.items || 0), Number(rec.tokens || 0),
      rec.ms == null ? null : Math.round(Number(rec.ms) || 0),
    )
    if (Math.random() < 0.02) pruneRetrievalLog(db, aid)
    return true
  } catch { return false }
}

/** 清掉太老的日志（默认 30 天）。 */
export function pruneRetrievalLog(db, aid = null, keepDays = KEEP_DAYS) {
  const cutoff = new Date(Date.now() - Math.max(1, Number(keepDays) || KEEP_DAYS) * 86400000).toISOString()
  try {
    const sql = aid ? 'DELETE FROM retrieval_log WHERE agent_id=? AND at<?' : 'DELETE FROM retrieval_log WHERE at<?'
    const args = aid ? [aid, cutoff] : [cutoff]
    return Number(db.prepare(sql).run(...args).changes || 0)
  } catch { return 0 }
}

/** 最近几次召回，新的在前。 */
export function listRetrievalLog(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(200, Number(opt.limit) || 30))
  const days = Math.max(1, Math.min(90, Number(opt.days) || 7))
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const where = ['agent_id=?', 'at>=?']
  const args = [aid, since]
  if (opt.scene) { where.push('scene=?'); args.push(String(opt.scene)) }
  args.push(limit)
  return db.prepare(`SELECT * FROM retrieval_log WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`)
    .all(...args)
    .map((r) => ({
      ...r,
      why: json(r.why, []),
      counts: json(r.counts, {}),
      kept: json(r.kept, {}),
      dropped: json(r.dropped, []),
      items: Number(r.items || 0),
      tokens: Number(r.tokens || 0),
      ms: r.ms == null ? null : Number(r.ms),
    }))
}

/**
 * 分场景汇总：调用量、平均召回条数 / token / 耗时、空手率（回来 0 条的比例）。
 * 「空手率」是判断门槛太紧还是查询太偏的第一指标。
 */
export function retrievalStats(db, aid, days = 7) {
  const d = Math.max(1, Math.min(90, Number(days) || 7))
  const since = new Date(Date.now() - d * 86400000).toISOString()
  let rows = []
  try {
    rows = db.prepare(`SELECT scene, COUNT(*) n, AVG(items) items, AVG(tokens) tokens, AVG(ms) ms,
        SUM(CASE WHEN items=0 THEN 1 ELSE 0 END) empty
      FROM retrieval_log WHERE agent_id=? AND at>=? GROUP BY scene ORDER BY n DESC`).all(aid, since)
  } catch { rows = [] }
  const scenes = rows.map((r) => ({
    scene: r.scene,
    calls: Number(r.n || 0),
    empty: Number(r.empty || 0),
    items: Number((Number(r.items) || 0).toFixed(2)),
    tokens: Math.round(Number(r.tokens) || 0),
    ms: Math.round(Number(r.ms) || 0),
    empty_rate: Number(r.n ? Number(r.empty) / Number(r.n) : 0),
  }))
  const total = scenes.reduce((s, x) => s + x.calls, 0)
  const empty = scenes.reduce((s, x) => s + x.empty, 0)
  return {
    days: d,
    total,
    empty,
    empty_rate: total ? Number(empty / total) : 0,
    tokens: total ? Math.round(scenes.reduce((s, x) => s + x.tokens * x.calls, 0) / total) : 0,
    scenes,
  }
}
