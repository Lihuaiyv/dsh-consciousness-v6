/**
 * 把一句待发的主动消息推进指定会话（走宿主 sessionController.prompt）。
 *
 * 单独放一个文件是为了可测：controller / sessionId / prefs 都是注入的，
 * 测试里用假的 controller 就能走完整条路径，不需要真会话。
 *
 * 投递语义（P4）：先原子 claim（pending → delivered + delivered_at），成功才 prompt；
 * prompt 失败则退回 pending，下一轮还能再发。注入侧在 push 开时不抢同一行。
 */
import { now } from './db.js'
import { event } from './core.js'
import { proactivePushText } from './features.js'

/**
 * @param {object} p
 * @param {import('node:sqlite').DatabaseSync} p.db
 * @param {string} p.aid
 * @param {string} p.line        它想说的那句
 * @param {string} p.proactiveId proactive 行 id
 * @param {string|null} p.sessionId 目标会话
 * @param {object|null} p.controller sessionController（有 prompt 方法）
 * @param {{push?:boolean}} p.prefs 主动偏好
 * @returns {Promise<{ok:boolean, reason?:string, session?:string, error?:string}>}
 */
export async function pushProactiveLine({ db, aid, line, proactiveId, sessionId, controller, prefs }) {
  if (!prefs || !prefs.push) return { ok: false, reason: 'off' }
  if (!sessionId) return { ok: false, reason: 'no_session' }
  if (!controller || typeof controller.prompt !== 'function') return { ok: false, reason: 'no_port' }
  if (!line) return { ok: false, reason: 'empty' }

  const at = now()
  // 先 claim：和注入路径互斥，changes=0 说明已被别人拿走
  let claimed = 0
  try {
    claimed = Number(db.prepare(
      "UPDATE proactive SET state='delivered', delivered_at=?, session_id=? WHERE id=? AND state='pending'",
    ).run(at, String(sessionId), proactiveId).changes || 0)
  } catch {
    // 老库没有 session_id 列：仍写 delivered_at
    try {
      claimed = Number(db.prepare(
        "UPDATE proactive SET state='delivered', delivered_at=? WHERE id=? AND state='pending'",
      ).run(at, proactiveId).changes || 0)
    } catch { claimed = 0 }
  }
  if (!claimed) return { ok: false, reason: 'already_claimed' }

  try {
    await controller.prompt({
      requestId: 'preq_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: proactivePushText(line) }],
    })
    try {
      event(db, aid, 'proactive.pushed', { id: proactiveId, session: sessionId, at })
    } catch { /* 记账失败不影响推 */ }
    return { ok: true, session: sessionId }
  } catch (e) {
    // prompt 失败：退回 pending，清掉 delivered_at / session，下一轮还能再投
    try {
      db.prepare("UPDATE proactive SET state='pending', delivered_at=NULL, session_id=NULL WHERE id=? AND state='delivered'")
        .run(proactiveId)
    } catch {
      try { db.prepare("UPDATE proactive SET state='pending', delivered_at=NULL WHERE id=? AND state='delivered'").run(proactiveId) } catch { /* ignore */ }
    }
    return { ok: false, reason: 'prompt_failed', error: String((e && e.message) || e) }
  }
}
