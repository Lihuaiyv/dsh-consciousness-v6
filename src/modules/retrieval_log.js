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
import { timelineDrift } from './timeline.js'

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

/**
 * U8：记忆健康快照——召回空手率 + 冲突开案 + 习惯条数 + 最近巩固蒸馏。
 * 给面板 / 抽检用，不进热路径。
 */
export function memoryHealth(db, aid, days = 7) {
  const d = Math.max(1, Math.min(90, Number(days) || 7))
  const since = new Date(Date.now() - d * 86400000).toISOString()
  const retrieve = retrievalStats(db, aid, d)

  let conflicts = { total: 0, open: 0 }
  try {
    const row = db.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN state='open' THEN 1 ELSE 0 END) open
      FROM conflicts WHERE agent_id=?`).get(aid)
    conflicts = { total: Number(row?.total || 0), open: Number(row?.open || 0) }
  } catch { /* 老库 */ }

  let updates = 0
  try {
    updates = Number(db.prepare(`SELECT COUNT(*) n FROM fact_archive
      WHERE agent_id=? AND source='update_history' AND created_at>=?`).get(aid, since)?.n || 0)
  } catch { updates = 0 }

  let habits = { active: 0, cold: 0 }
  try {
    const rows = db.prepare(`SELECT temp_state, COUNT(*) n FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL
        AND (fact_key LIKE 'habit.%' OR text LIKE '%每周%' OR text LIKE '%每天%' OR text LIKE '%习惯%')
      GROUP BY temp_state`).all(aid)
    for (const r of rows) {
      const n = Number(r.n || 0)
      if (r.temp_state === 'cold' || r.temp_state === 'archived') habits.cold += n
      else habits.active += n
    }
  } catch { /* ignore */ }

  let distill = null
  try {
    const last = db.prepare('SELECT day,steps,ok,at FROM consolidation_log WHERE agent_id=? ORDER BY day DESC LIMIT 1').get(aid)
    if (last) {
      let steps = []
      try { steps = JSON.parse(last.steps || '[]') } catch { steps = [] }
      const ep = (steps || []).find((s) => s && s.step === 'episode_distill') || null
      distill = { day: last.day, ok: !!last.ok, at: last.at, episode_distill: ep }
    }
  } catch { distill = null }

  let sources = {}
  try {
    const rows = db.prepare(`SELECT COALESCE(source,'unknown') source, COUNT(*) n FROM memory_items
      WHERE agent_id=? AND status='active' GROUP BY source`).all(aid)
    sources = Object.fromEntries(rows.map((r) => [r.source, Number(r.n || 0)]))
  } catch { sources = {} }

  let tl = null
  try { tl = timelineDrift(db, aid) } catch { tl = null }

  return {
    days: d,
    retrieve: {
      total: retrieve.total,
      empty_rate: retrieve.empty_rate,
      s1_empty_rate: (retrieve.scenes.find((s) => s.scene === 'S1') || {}).empty_rate ?? null,
    },
    conflicts,
    updates_recent: updates,
    habits,
    sources,
    distill,
    timeline_drift: tl,
    ok: retrieve.empty_rate < 0.5 && (conflicts.open == null || conflicts.open < 50),
  }
}
