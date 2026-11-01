/**
 * P3 冲突升级与可追溯
 *
 * 冲突不是「报个错」就完了。要能回答四个问题：
 *   ① 跟哪一条冲突？② 为什么判成冲突（相似度多少、哪一句）？
 *   ③ 谁处理的、什么时候？④ 一直没人管会怎么样？
 *
 * 前三个靠 `conflictDetail`（冲突行 + 双方原文 + 事件时间线），
 * 第四个靠 `tickEscalation`：悬置 3 天升一级、7 天再升一级并挂告警。
 * 升级只改状态与告警，不替人做决定——冲突的取舍永远留给人。
 */

import { now } from '../db.js'
import { nid, event } from '../kernel.js'

export const ESCALATE_AFTER_DAYS = 3
export const ESCALATE_HARD_DAYS = 7
export const MAX_LEVEL = 2

function days(iso) {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : 0
}

function parse(payload) {
  try { return JSON.parse(payload || '{}') } catch { return {} }
}

/** 这条冲突的所有留痕（升序：先发生先显示）。 */
export function conflictTimeline(db, aid, cid) {
  let rows = []
  try {
    rows = db.prepare("SELECT * FROM events WHERE agent_id=? AND type LIKE 'memory.conflict%' ORDER BY rowid DESC LIMIT 500").all(aid)
  } catch { return [] }
  return rows
    .map((r) => ({ at: r.created_at, type: r.type, payload: parse(r.payload) }))
    .filter((e) => e.payload.conflict_id === cid)
    .reverse()
}

/** 冲突详情：双方原文 + 判定依据 + 时间线。 */
export function conflictDetail(db, aid, cid) {
  const c = db.prepare('SELECT * FROM conflicts WHERE id=? AND agent_id=?').get(cid, aid)
  if (!c) return null
  const one = (id) => {
    try {
      return db.prepare(`SELECT id,text,type,weight,importance,heat,entity_id,invalid_at,status,created_at
        FROM memory_items WHERE id=?`).get(id) || null
    } catch { return null }
  }
  return {
    ...c,
    evidence: parse(c.evidence),
    a: one(c.a_id),
    b: one(c.b_id),
    age_days: Number(days(c.opened_at).toFixed(1)),
    level: Number(c.escalation_level || 0),
    timeline: conflictTimeline(db, aid, cid),
  }
}

/** 升级一级（也可以带理由手动升）。返回升级后的状态。 */
export function escalateConflict(db, aid, cid, body = {}) {
  const c = db.prepare('SELECT * FROM conflicts WHERE id=? AND agent_id=?').get(cid, aid)
  if (!c) return null
  if (c.state !== 'open') return { id: cid, state: c.state, level: Number(c.escalation_level || 0), skipped: '已处理过的冲突不再升级' }
  const level = Math.min(MAX_LEVEL, Number(c.escalation_level || 0) + 1)
  const reason = String(body.reason || (level >= MAX_LEVEL ? '悬置过久，等你拍板' : '悬置未处理')).slice(0, 200)
  db.prepare('UPDATE conflicts SET escalation_level=?, escalated_at=?, reason=? WHERE id=?')
    .run(level, now(), reason, cid)
  try {
    event(db, aid, 'memory.conflict_escalated', {
      conflict_id: cid, level, reason,
      a: c.a_id, b: c.b_id, wait_days: Number(days(c.opened_at).toFixed(1)),
    })
  } catch { /* 留痕失败不影响升级 */ }
  if (level >= MAX_LEVEL) {
    try {
      db.prepare('INSERT INTO alerts VALUES(?,?,?,?,?,?,?)')
        .run(nid('alr_'), aid, 'data', 3, '有冲突悬置超过 7 天，等你拍板：' + reason, 'open', now())
    } catch { /* 告警失败不影响升级 */ }
  }
  return { id: cid, state: 'open', level, reason }
}

/**
 * 定时升级：open + 超过 3 天 → 1 级；超过 7 天 → 2 级（并挂告警）。
 * 只升级不解决；降权（R05）仍在 tickConflicts 里。
 */
export function tickEscalation(db, aid) {
  let rows = []
  try {
    rows = db.prepare("SELECT * FROM conflicts WHERE agent_id=? AND state='open'").all(aid)
  } catch { return [] }
  const out = []
  for (const c of rows) {
    const wait = days(c.opened_at)
    const level = Number(c.escalation_level || 0)
    if (level >= MAX_LEVEL) continue
    if (wait >= ESCALATE_HARD_DAYS) {
      const r = escalateConflict(db, aid, c.id, { reason: '悬置 ' + Math.round(wait) + ' 天未处理' })
      if (r) out.push(r)
    } else if (wait >= ESCALATE_AFTER_DAYS) {
      const r = escalateConflict(db, aid, c.id, { reason: '悬置 ' + Math.round(wait) + ' 天未处理' })
      if (r) out.push(r)
    }
  }
  return out
}

/** 冲突概况：多少条、多严重、悬了多久。 */
export function conflictStats(db, aid) {
  let rows = []
  try { rows = db.prepare('SELECT * FROM conflicts WHERE agent_id=?').all(aid) } catch { return { total: 0, open: 0, by_level: {}, by_severity: {}, oldest_open_days: 0 } }
  const byLevel = {}
  const bySeverity = {}
  let open = 0
  let oldest = 0
  for (const c of rows) {
    const lv = String(Number(c.escalation_level || 0))
    byLevel[lv] = (byLevel[lv] || 0) + 1
    const sv = c.severity || 'unknown'
    bySeverity[sv] = (bySeverity[sv] || 0) + 1
    if (c.state === 'open') {
      open++
      oldest = Math.max(oldest, days(c.opened_at))
    }
  }
  return { total: rows.length, open, by_level: byLevel, by_severity: bySeverity, oldest_open_days: Number(oldest.toFixed(1)) }
}
