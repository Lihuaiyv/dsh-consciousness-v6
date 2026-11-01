/**
 * 空闲心跳（P1）：只做一件事——给「自己浮上来」造候选。
 *
 * 以前回忆只有一个人口：用户这一轮说的话（retrieve 用这句话当查询）。
 * 她不说话，就没有东西能被想起来。心跳补的就是这个：
 * 每 10 分钟挑一条「热、但最近没提过」的记忆放进 surface_queue，
 * 下一轮注入时最多取一条（见 index.js 的「心里忽然浮上来」）。
 *
 * 三条纪律：
 *   1) 零模型调用（心跳很便宜，才能一直跑）；
 *   2) 不在这里改情绪：情绪衰减本来就按墙钟算，下次评价时自动补，重复衰减会算两遍；
 *   3) 只产候选，不说话——开口的唯一出口仍是 features.decideSpeak 的五道门。
 */

import { now } from '../db.js'
import { nid, getParam } from '../kernel.js'
import { recordSurfaced } from './surfacing.js'

const DAY_MS = 86400000

/** 冷却：同一条记忆多少天内不再自己浮上来。 */
export const SURFACE_COOLDOWN_DAYS = 3
/** 候选在队列里最多等多久，过期作废（别拿一周前的「忽然想起」）。 */
export const SURFACE_TTL_MS = 24 * 3600000

function flagOn(db, aid, key, dflt = 'on') {
  try { return String(getParam(db, aid, key) ?? dflt) !== 'off' } catch { return true }
}

/**
 * 挑候选入队。
 * @returns {number} 入队条数
 */
export function queueSurface(db, aid, { at = Date.now(), limit = 1, cooldownDays = SURFACE_COOLDOWN_DAYS } = {}) {
  if (!flagOn(db, aid, 'memory.float.enable')) return 0
  const n = Math.max(1, Math.min(3, Number(limit) || 1))
  const cd = Math.max(0, Math.min(90, Number(cooldownDays) || SURFACE_COOLDOWN_DAYS))
  const since = new Date(at - cd * DAY_MS).toISOString()
  let rows = []
  try {
    rows = db.prepare(`SELECT m.id, m.text FROM memory_items m
      WHERE m.agent_id=? AND m.status='active' AND m.invalid_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM surfaced_items s
          WHERE s.agent_id=m.agent_id AND s.memory_id=m.id AND s.at>=?)
        AND NOT EXISTS (SELECT 1 FROM surface_queue q
          WHERE q.agent_id=m.agent_id AND q.memory_id=m.id AND q.state='pending')
      ORDER BY COALESCE(m.heat,0) DESC, COALESCE(m.weight,0.5) DESC, m.created_at DESC
      LIMIT ?`).all(aid, since, n)
  } catch { return 0 }
  if (!rows.length) return 0
  const stamp = new Date(at).toISOString()
  const exp = new Date(at + SURFACE_TTL_MS).toISOString()
  const ins = db.prepare('INSERT INTO surface_queue(id,agent_id,memory_id,reason,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
  let inserted = 0
  for (const r of rows) {
    try { ins.run(nid('sq_'), aid, r.id, 'pulse', 'pending', stamp, exp); inserted++ } catch { /* 单条失败不拖累 */ }
  }
  return inserted
}

/** 最早一条还没过期的候选（只读，不消费）。 */
export function pendingSurface(db, aid, at = Date.now()) {
  try {
    return db.prepare(`SELECT q.id, q.memory_id, m.text FROM surface_queue q
      JOIN memory_items m ON m.id=q.memory_id
      WHERE q.agent_id=? AND q.state='pending' AND (q.expires_at IS NULL OR q.expires_at>?)
      ORDER BY q.created_at ASC LIMIT 1`).get(aid, new Date(at).toISOString()) || null
  } catch { return null }
}

/**
 * 取走一条候选：标 delivered 并记一次浮现（kind=spontaneous）。
 * 回复里没真用上也没关系——surfaced_items.used 本来就用来量「注入后有没有被说出来」。
 */
export function takeSurface(db, aid, at = Date.now()) {
  const row = pendingSurface(db, aid, at)
  if (!row) return null
  try {
    db.prepare("UPDATE surface_queue SET state='delivered' WHERE id=?").run(row.id)
  } catch { return null }
  try {
    recordSurfaced(db, aid, [{ id: row.memory_id, text: row.text, via: 'spontaneous' }], at)
  } catch { /* 观测失败不影响浮现 */ }
  return row
}

/** 过期清理：pending 过 TTL 作废；delivered 留 60 天。 */
export function pruneSurface(db, { at = Date.now() } = {}) {
  const stamp = new Date(at).toISOString()
  const old = new Date(at - 60 * DAY_MS).toISOString()
  let expired = 0
  try {
    expired = Number(db.prepare("UPDATE surface_queue SET state='expired' WHERE state='pending' AND expires_at IS NOT NULL AND expires_at<=?").run(stamp).changes || 0)
    db.prepare('DELETE FROM surface_queue WHERE state!=\'pending\' AND created_at<?').run(old)
  } catch { /* 清理失败不影响心跳 */ }
  return expired
}

/** 一次心跳：清过期 + 补候选。 */
export function surfaceQueueTick(db, aid, { at = Date.now(), limit = 1 } = {}) {
  const expired = pruneSurface(db, { at })
  const queued = queueSurface(db, aid, { at, limit })
  return { queued, expired }
}

/** 队列概览（技术视图用）。 */
