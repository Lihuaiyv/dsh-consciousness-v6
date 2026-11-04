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
/** 两条自发浮现之间至少隔多久：两小时一条，一天最多十二条（旧版是五分钟一条，一天一百四十四个）。 */
export const SURFACE_INTERVAL_MS = 2 * 60 * 60 * 1000

/**
 * 一条记忆属于哪一格。抽签只从 inner 里抽——
 * 只有「她自己的话 / 她经历过的事」才有资格冒充心里的念头。
 *   inner   她自己说过的话、自己经历过的事 → 会自己浮上来
 *   echo    他说过的原话 → 不自己浮，交给引语那条线
 *   profile 记得主人的事（总结 / 事实 / 抽取的事件）→ 问到才翻
 *   ledger  流水账（谁问了什么、判了什么情绪）→ 不进提示词
 */
export function poolOf(m = {}) {
  const type = String(m.type || '')
  const src = String(m.source || '')
  const text = String(m.text || '')
  if (type === 'appraisal') return 'ledger'
  if (type === 'episode' && src === 'manual') return 'echo'
  const bySource = type === 'episode'
    ? (src === 'self' || src === 'life')
    : (type === 'reflection' && (src === 'manual' || src === 'reflect' || src === 'consolidate'))
  if (!bySource) return 'profile'
  // source 会骗人：同一批 reflection/manual 里混着「1. 用户要求…2. 用户偏好…」这种报告体。
  // 心里的念头不会管自己叫「用户」或「助手」——一句话就试出来了。
  if (text.includes('用户') || text.includes('助手')) return 'profile'
  return 'inner'
}

/** 各池子有多少条 active——验收时用它看分层有没有真分对。 */
export function poolCounts(db, aid) {
  const out = { inner: 0, echo: 0, profile: 0, ledger: 0 }
  try {
    const rows = db.prepare("SELECT type, source, text FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").all(aid)
    for (const r of rows) out[poolOf(r)] += 1
  } catch { /* 老库没有这些列就当空 */ }
  return out
}

function flagOn(db, aid, key, dflt = 'on') {
  try { return String(getParam(db, aid, key) ?? dflt) !== 'off' } catch { return true }
}

/**
 * 挑候选入队。
 * 只从 inner 池挑；一次最多等一条；两条之间至少隔 intervalMs（默认一小时）。
 * @returns {number} 入队条数
 */
export function queueSurface(db, aid, { at = Date.now(), limit = 1, cooldownDays = SURFACE_COOLDOWN_DAYS, intervalMs = SURFACE_INTERVAL_MS } = {}) {
  if (!flagOn(db, aid, 'memory.float.enable')) return 0
  const n = Math.max(1, Math.min(3, Number(limit) || 1))
  const cd = Math.max(0, Math.min(90, Number(cooldownDays) || SURFACE_COOLDOWN_DAYS))
  const gap = Math.max(0, Number(intervalMs) || 0)
  // 队列里已经有一条在等（还没被某轮注入取走）就不再排，免得堆一大堆一次只用一条。
  // 两条之间也要拉开：不是每五分钟塞一条进来。
  try {
    const stamp = new Date(at).toISOString()
    const pend = db.prepare("SELECT COUNT(*) n FROM surface_queue WHERE agent_id=? AND state='pending' AND (expires_at IS NULL OR expires_at>?)").get(aid, stamp)
    if (Number(pend && pend.n)) return 0
    if (gap > 0) {
      const last = db.prepare('SELECT MAX(created_at) m FROM surface_queue WHERE agent_id=?').get(aid)
      const lastAt = Date.parse((last && last.m) || '')
      if (Number.isFinite(lastAt) && at - lastAt < gap) return 0
    }
  } catch { /* 查不到就按老规矩排 */ }
  const since = new Date(at - cd * DAY_MS).toISOString()
  let rows = []
  try {
    rows = db.prepare(`SELECT m.id, m.text FROM memory_items m
      WHERE m.agent_id=? AND m.status='active' AND m.invalid_at IS NULL
        AND (
          (m.type='episode' AND m.source IN ('self','life'))
          OR (m.type='reflection' AND m.source IN ('manual','reflect','consolidate'))
        )
        AND m.text NOT LIKE '%用户%' AND m.text NOT LIKE '%助手%'
        AND LENGTH(m.text) >= 6
        AND NOT EXISTS (SELECT 1 FROM surfaced_items s
          WHERE s.agent_id=m.agent_id AND s.memory_id=m.id AND s.at>=?)
        AND NOT EXISTS (SELECT 1 FROM surface_queue q
          WHERE q.agent_id=m.agent_id AND q.memory_id=m.id AND q.state='pending')
      ORDER BY COALESCE((SELECT MAX(s2.at) FROM surfaced_items s2
          WHERE s2.agent_id=m.agent_id AND s2.memory_id=m.id), '') ASC,
        COALESCE(m.heat,0) DESC, COALESCE(m.weight,0.5) DESC, m.created_at DESC
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

/** 最早一条还没过期的候选（只读，不消费）。带 type/source，好让注入时按来源给不同的引子。 */
export function pendingSurface(db, aid, at = Date.now()) {
  try {
    return db.prepare(`SELECT q.id, q.memory_id, m.text, m.type, m.source FROM surface_queue q
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
  return consumeSurface(db, aid, row, at) ? row : null
}

/**
 * 候选真的进了注入文本之后再消费：标 delivered + 记浮现。
 * 同一行重复调用只算一次；被预算丢掉时不该调这个。
 */
export function consumeSurface(db, aid, row, at = Date.now()) {
  if (!row || !row.id) return false
  let changed = 0
  try {
    changed = Number(db.prepare("UPDATE surface_queue SET state='delivered' WHERE id=? AND state='pending'").run(row.id).changes || 0)
  } catch { return false }
  if (!changed) return false
  try {
    recordSurfaced(db, aid, [{ id: row.memory_id, text: row.text, via: 'spontaneous' }], at)
  } catch { /* 观测失败不影响浮现 */ }
  return true
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
export function surfaceQueueTick(db, aid, { at = Date.now(), limit = 1, intervalMs = SURFACE_INTERVAL_MS } = {}) {
  const expired = pruneSurface(db, { at })
  const queued = queueSurface(db, aid, { at, limit, intervalMs })
  return { queued, expired }
}

/** 队列概览（技术视图用）。 */
