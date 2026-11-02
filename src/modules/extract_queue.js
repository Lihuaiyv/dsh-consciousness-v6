/**
 * 抽取队列（P2）
 *
 * 抽取是后台的事，不能挂在对话的 Promise 链上：进程一重启，正在抽的那批就丢了。
 * 所以先入队（落库），再由 worker 按 next_at 取出来跑；失败按次数退避重试，5 次后标 failed。
 * 同一批 turns 只入队一次（内容指纹去重）。
 */

import crypto from 'node:crypto'
import { now } from '../db.js'

export const MAX_ATTEMPTS = 5
const KEEP_DONE_DAYS = 7

/**
 * 这一轮的身份证。用户那句和助手那句共用一个 turn_id，
 * 记忆存下它才能回到原话。时间戳 + 序号 + 随机尾巴，够唯一。
 */
let turnSeq = 0
export function makeTurnId() {
  turnSeq = (turnSeq + 1) % 1000000
  return 'turn_' + Date.now().toString(36) + '_' + turnSeq.toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 从一批 turns 里取这一批的 turn_id（最后一条带 id 的）。一条都没有就 null。 */
export function pickBatchTurnId(turns) {
  const list = Array.isArray(turns) ? turns : []
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i] && list[i].turnId
    if (t) return String(t)
  }
  return null
}

/** 入队。返回 {id, duplicate}；空输入返回 null。 */
export function enqueueExtraction(db, aid, turns) {
  const list = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && String(t.text || '').trim())
    .map((t) => ({ role: String(t.role || 'user'), text: String(t.text).slice(0, 2000), turnId: t.turnId ? String(t.turnId) : null }))
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
 * 跑一批待办。runner(turns) 由调用方给（通常是 ingest），失败会自动退避。
 * @returns {Promise<Array<{id:string, ok:boolean}>>}
 */
export async function tickExtraction(db, aid, runner, opt = {}) {
  const max = Math.max(1, Math.min(5, Number(opt.max) || 1))
  const at = now()
  let rows = []
  try {
    rows = db.prepare("SELECT * FROM extract_queue WHERE agent_id=? AND state='pending' AND next_at<=? ORDER BY next_at, created_at LIMIT ?")
      .all(aid, at, max)
  } catch { return [] }

  const out = []
  for (const r of rows) {
    try { db.prepare("UPDATE extract_queue SET state='running', updated_at=? WHERE id=?").run(now(), r.id) } catch { /* 抢占失败就跳过 */ }
    try {
      const turns = JSON.parse(r.turns)
      const result = await runner(turns)
      db.prepare("UPDATE extract_queue SET state='done', last_error=NULL, updated_at=? WHERE id=?").run(now(), r.id)
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
