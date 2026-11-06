/**
 * 把一句待发的主动消息推进指定会话（走宿主 sessionController.prompt）。
 *
 * 单独放一个文件是为了可测：controller / sessionId / prefs 都是注入的，
 * 测试里用假的 controller 就能走完整条路径，不需要真会话。
 * 失败时不动 proactive 行——下一轮对话照旧会被带出来，功能不会因此挂掉。
 */
import { now } from './db.js'
import { event } from './core.js'
import { markDelivered } from './modules/proactive.js'
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
  try {
    // 宿主 sessionController.prompt(request, signal)：第二个参数是必传的 AbortSignal。
    // 不传的话宿主内部 signal.throwIfAborted() 会炸（11-03 那条 prompt_failed 就是这么来的）。
    const signal = typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(15000)
      : new AbortController().signal
    await controller.prompt({
      requestId: 'preq_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: proactivePushText(line) }],
    }, signal)
    // delivered_at 留空：主动推的不算「24 小时没回就被忽略」，等对方真回话再记 answered
    const changed = markDelivered(db, proactiveId)
    try {
      event(db, aid, 'proactive.pushed', { id: proactiveId, session: sessionId, changed, at: now() })
    } catch { /* 记账失败不影响推 */ }
    return { ok: true, session: sessionId }
  } catch (e) {
    return { ok: false, reason: 'prompt_failed', error: String((e && e.message) || e) }
  }
}
