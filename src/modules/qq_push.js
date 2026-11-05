/**
 * 主动消息走 QQ。
 *
 * 为什么单开一条路：宿主 sessionController.prompt 那条推不进去（实测报
 * `Cannot read properties of undefined (reading 'throwIfAborted')`），
 * 而 dsh-qq-onebot-bridge 暴露了 `ctx.qqBridge.sendText(chatKey, text)`——
 * 走桥自己的出站限流 / 注入抑制 / 分段，比宿主那条稳，也真的是「发到 QQ 上」。
 *
 * 纪律：
 *   1) 不在这里读参数：开关和目标由调用方算好传进来（INV10）。
 *   2) 发不出去就不标 delivered——留在 pending，下一轮还有机会。
 *   3) 核对式的话（「你先前说 A，可后来又说 B」）不发：那是找茬，不是想他。
 */
import { now } from '../db.js'
import { event } from '../kernel.js'

/** 私聊 chatKey：桥的格式是 `u:<QQ号>`。 */
export function ownerChatKey(qq) {
  const s = String(qq || '').replace(/\D/g, '')
  return s ? 'u:' + s : ''
}

/** 私聊在聊天账本里的 conversation_id：跟 qq_bridge 的 conversationIdOf 同口径。 */
export function conversationIdOfChatKey(chatKey) {
  const m = /^u:(\d+)$/.exec(String(chatKey || ''))
  return m ? 'qq:p:' + m[1] : ''
}

/**
 * 该不该把这句话当「主动搭话」发出去。
 * 太长（推过去像小作文）、核对式、结构化 JSON、纯编号清单，都不发。
 */
export function pushableLine(line) {
  const t = String(line || '').trim()
  if (!t || t.length < 2 || t.length > 200) return false
  if (/(你先前说|可后来又说|前后不一|你说过.{0,20}又说|自相矛盾)/.test(t)) return false
  if (/^\{|^\[|^\d+[.、]\s/.test(t)) return false
  return true
}

/**
 * 把一句待发的主动消息推到 QQ。
 * @returns {Promise<{ok:boolean, reason?:string, error?:string}>}
 */
export async function pushProactiveToQQ({ db, aid, api, chatKey, line, proactiveId }) {
  if (!api || typeof api.sendText !== 'function') return { ok: false, reason: 'no_bridge' }
  if (!chatKey) return { ok: false, reason: 'no_target' }
  const text = String(line || '').trim()
  if (!pushableLine(text)) return { ok: false, reason: 'not_pushable' }
  try {
    const row = db.prepare('SELECT state FROM proactive WHERE id=?').get(proactiveId)
    if (row && row.state !== 'pending') return { ok: false, reason: 'already' }
  } catch { /* 读不到就当还能发 */ }
  try {
    await api.sendText(chatKey, text)
  } catch (e) {
    return { ok: false, reason: 'send_failed', error: String((e && e.message) || e) }
  }
  try {
    db.prepare("UPDATE proactive SET state='delivered', delivered_at=NULL WHERE id=? AND state='pending'").run(proactiveId)
  } catch { /* 标不上下一次还会发；宁可不标，也不能因为记账失败把话弄丢 */ }
  try { event(db, aid, 'proactive.qq_pushed', { id: proactiveId, chatKey, at: now() }) } catch { /* 记账失败不影响 */ }
  // 发出去的话也要在本地账本里留一条：不然只能在手机上看，回看时不知道自己说过。
  try {
    const cid = conversationIdOfChatKey(chatKey)
    if (cid) {
      db.prepare(`INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id)
        VALUES(?,?,?,?,?,?,?,?)`).run(
        'cht_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10),
        aid, 'agent', text, '[]', null, now(), cid,
      )
    }
  } catch { /* 写不进账本不影响消息已经发出去 */ }
  return { ok: true }
}
