/**
 * 抽取队列（P2）
 *
 * 抽取是后台的事，不能挂在对话的 Promise 链上：进程一重启，正在抽的那批就丢了。
 * 所以先入队（落库），再由 worker 按 next_at 取出来跑；失败按次数退避重试，5 次后标 failed。
 * 同一批 turns 只入队一次（内容指纹去重）。
 */

import crypto from 'node:crypto'
import { now, localDay } from '../db.js'
import { shouldDeferExtract, llmBudgetAllow, llmBudgetBump, deferExtractForDay } from './llm_budget.js'

export const MAX_ATTEMPTS = 5
const KEEP_DONE_DAYS = 7
/** running 超过这个时间视为卡死（进程崩溃 / worker 挂起），下一轮 reclaim 回 pending。 */
export const STUCK_RUNNING_MS = 10 * 60 * 1000

/** 入队。返回 {id, duplicate}；空输入返回 null。 */
export function enqueueExtraction(db, aid, turns) {
  const list = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && String(t.text || '').trim())
    .map((t) => ({ role: String(t.role || 'user'), text: String(t.text).slice(0, 2000) }))
  if (!list.length) return null
  const fingerprint = aid + '\u0001' + JSON.stringify(list.map((t) => [t.role, t.text.slice(0, 200)]))
  const id = 'exq_' + crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 16)
  try {
    const old = db.prepare('SELECT id,state FROM extract_queue WHERE id=?').get(id)
    if (old) return { id, duplicate: true, state: old.state }
    const at = now()
    db.prepare(`INSERT INTO extract_queue(id,agent_id,turns,state,attempts,next_at,created_at,updated_at)
      VALUES(?,?,?,'pending',0,?,?,?)`).run(id, aid, JSON.stringify(list), at, at, at)
    return { id, duplicate: false }
  } catch { return null }
}

export function queueStats(db, aid) {
  const rows = db.prepare('SELECT state, COUNT(*) n FROM extract_queue WHERE agent_id=? GROUP BY state').all(aid)
  const out = { pending: 0, running: 0, done: 0, failed: 0 }
  for (const r of rows) out[r.state] = Number(r.n)
  let oldest = null
  try {
    oldest = db.prepare("SELECT id,created_at,attempts FROM extract_queue WHERE agent_id=? AND state='pending' ORDER BY next_at LIMIT 1").get(aid) || null
  } catch { oldest = null }
  return { ...out, oldest }
}

/**
 * 把卡在 running 的任务捞回 pending（崩溃 / 重叠 tick 留下的僵尸）。
 * @returns {number} 回收条数
 */
export function reclaimStuck(db, aid, olderThanMs = STUCK_RUNNING_MS) {
  const ms = Math.max(60_000, Number(olderThanMs) || STUCK_RUNNING_MS)
  const cutoff = new Date(Date.now() - ms).toISOString()
  const at = now()
  try {
    return Number(db.prepare(`UPDATE extract_queue SET state='pending', next_at=?, updated_at=?
      WHERE agent_id=? AND state='running' AND updated_at<?`).run(at, at, aid, cutoff).changes || 0)
  } catch { return 0 }
}

/**
 * 跑一批待办。runner(turns) 由调用方给（通常是 ingest），失败会自动退避。
 * @returns {Promise<Array<{id:string, ok:boolean}>>}
 */
export async function tickExtraction(db, aid, runner, opt = {}) {
  const max = Math.max(1, Math.min(5, Number(opt.max) || 1))
  try { reclaimStuck(db, aid, opt.stuckMs) } catch { /* 回收失败不影响本轮 */ }

  // U0：蒸馏已满或日模型硬顶见底 → 同日 pending 延后，避免与夜巡双烧
  const day = localDay()
  let deferred = 0
  try {
    const def = shouldDeferExtract(db, aid, day)
    if (def.defer) deferred = deferExtractForDay(db, aid, day, def.reason || 'budget')
  } catch { deferred = 0 }

  const at = now()
  let rows = []
  try {
    rows = db.prepare("SELECT * FROM extract_queue WHERE agent_id=? AND state='pending' AND next_at<=? ORDER BY next_at, created_at LIMIT ?")
      .all(aid, at, max)
  } catch { return [] }

  const out = []
  if (deferred) out.push({ id: null, ok: true, deferred, reason: 'budget_defer' })
  for (const r of rows) {
    if (!llmBudgetAllow(db, aid, day, 1).ok) {
      try { deferExtractForDay(db, aid, day, 'daily_cap') } catch { /* ignore */ }
      out.push({ id: r.id, ok: false, skipped: true, reason: 'llm_budget' })
      break
    }
    // 原子领取：只有仍是 pending 才变成 running，避免 commit 与 30s timer 双跑
    let claimed = 0
    try {
      claimed = Number(db.prepare("UPDATE extract_queue SET state='running', updated_at=? WHERE id=? AND state='pending'")
        .run(now(), r.id).changes || 0)
    } catch { claimed = 0 }
    if (!claimed) continue
    try {
      const turns = JSON.parse(r.turns)
      const result = await runner(turns)
      db.prepare("UPDATE extract_queue SET state='done', last_error=NULL, updated_at=? WHERE id=?").run(now(), r.id)
      try { llmBudgetBump(db, aid, 'extract', day, 1) } catch { /* ignore */ }
      out.push({ id: r.id, ok: true, result })
    } catch (e) {
      const attempts = Number(r.attempts || 0) + 1
      const failed = attempts >= MAX_ATTEMPTS
      const backoffMs = Math.min(3600, 30 * Math.pow(2, attempts)) * 1000
      try {
        db.prepare('UPDATE extract_queue SET state=?, attempts=?, next_at=?, last_error=?, updated_at=? WHERE id=?')
          .run(failed ? 'failed' : 'pending', attempts, new Date(Date.now() + backoffMs).toISOString(),
            String((e && e.message) || e).slice(0, 300), now(), r.id)
      } catch { /* 记账失败也不抛 */ }
      out.push({ id: r.id, ok: false, attempts, error: String((e && e.message) || e) })
    }
  }
  if (Math.random() < 0.05) pruneQueue(db, aid)
  return out
}

/** 清掉跑完 / 失败超过 7 天的记录。 */
export function pruneQueue(db, aid = null, keepDays = KEEP_DONE_DAYS) {
  const cutoff = new Date(Date.now() - Math.max(1, Number(keepDays) || KEEP_DONE_DAYS) * 86400000).toISOString()
  try {
    const sql = `DELETE FROM extract_queue WHERE updated_at<? AND state IN ('done','failed')` + (aid ? ' AND agent_id=?' : '')
    const args = aid ? [cutoff, aid] : [cutoff]
    return Number(db.prepare(sql).run(...args).changes || 0)
  } catch { return 0 }
}

/** 手动重试失败的（面板按钮用）。 */
export function retryFailed(db, aid) {
  try {
    return Number(db.prepare("UPDATE extract_queue SET state='pending', attempts=0, next_at=? WHERE agent_id=? AND state='failed'")
      .run(now(), aid).changes || 0)
  } catch { return 0 }
}
