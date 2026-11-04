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
 * 记忆体检：召回健康度 + 时效索引漂移 + 待处理冲突。
 * 面板 / 夜巡 / 脚本都能调；只读，不改任何东西。
 */
export function memoryHealth(db, aid) {
  let timeline_drift = { total: 0, drift: 0, missing: 0 }
  try { timeline_drift = timelineDrift(db, aid) } catch { /* 老库没有时效索引 */ }
  let mem = { active: 0, soft_deleted: 0 }
  try {
    const r = db.prepare(`SELECT SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active,
        SUM(CASE WHEN status='soft_deleted' THEN 1 ELSE 0 END) soft
      FROM memory_items WHERE agent_id=?`).get(aid)
    mem = { active: Number(r && r.active || 0), soft_deleted: Number(r && r.soft || 0) }
  } catch { /* 忽略 */ }
  let conflicts_open = 0
  try { conflicts_open = Number(db.prepare("SELECT COUNT(*) n FROM conflicts WHERE agent_id=? AND state='open'").get(aid).n || 0) } catch { /* 忽略 */ }
  let retrieval = null
  try { retrieval = retrievalStats(db, aid, 7) } catch { /* 忽略 */ }
  // S7：护照/过时观测——回链覆盖、被取代数、近期三类事件
  let passport = { derived: 0 }
  try {
    passport.derived = Number(db.prepare(`SELECT COUNT(*) n FROM memory_items m
      JOIN fact_archive f ON f.agent_id=m.agent_id AND f.memory_id=m.id
      WHERE m.agent_id=? AND m.status='active' AND m.invalid_at IS NULL
        AND f.payload LIKE '%episode_id%'`).get(aid).n || 0)
  } catch { /* 老库没有存根 */ }
  let stale = { superseded: 0, pair_seen_7d: 0, reflect_merged_7d: 0, ejected: 0, statement_eligible: 0 }
  try {
    stale.superseded = Number(db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND invalid_at IS NOT NULL').get(aid).n || 0)
    const since = new Date(Date.now() - 7 * 86400000).toISOString()
    stale.pair_seen_7d = Number(db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.stale_pair_seen' AND created_at>=?").get(aid, since).n || 0)
    stale.reflect_merged_7d = Number(db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.reflect_merged' AND created_at>=?").get(aid, since).n || 0)
    // 阶段 E：让「挤出了多少、有多少条会带时间」在面板上看得见。
    // ejected：已作废、S1 不会再召回的（与 isStale 的 invalid 分支同义）。
    stale.ejected = Number(db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NOT NULL").get(aid).n || 0)
    // statement_eligible：非槽位 + 超过三天 → 注入时会带「这是哪天的判断」。
    const cutoff = new Date(Date.now() - 3 * 86400000).toISOString()
    stale.statement_eligible = Number(db.prepare(`SELECT COUNT(*) n FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL
        AND type NOT IN ('fact','appraisal') AND created_at < ?`).get(aid, cutoff).n || 0)
  } catch { /* 忽略 */ }
  // 阶段 A：key 分身份——哪些 key 只是检索用，哪些能参与「值变了」的时态判定。
  // 只看 type：reflection / episode 上的 key 是摘要句编号，不承载槽位语义。
  const keys = { by_type: {}, total: 0, with_key: 0, slot: 0 }
  try {
    const rows = db.prepare(`SELECT type, COUNT(*) n,
        SUM(CASE WHEN fact_key IS NOT NULL AND fact_key<>'' THEN 1 ELSE 0 END) k
      FROM memory_items WHERE agent_id=? AND status='active' GROUP BY type`).all(aid)
    for (const r of rows) {
      const t = String(r.type || '(null)')
      const n = Number(r.n || 0)
      const k = Number(r.k || 0)
      keys.by_type[t] = { total: n, key: k }
      keys.total += n
      keys.with_key += k
      if (t === 'fact' || t === 'appraisal') keys.slot += k
    }
  } catch { /* 老库没有 fact_key */ }
  return { memory: mem, conflicts_open, timeline_drift, retrieval, passport: { ...passport, slot: keys.slot }, stale, keys }
}
