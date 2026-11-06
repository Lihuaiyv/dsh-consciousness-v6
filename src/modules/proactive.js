/**
 * 待发消息队列（proactive 表）：一张表只在这里写。
 *
 * 用途：主动开口、冲突提问都往这里排一句；投递 / 回应 / 忽略 / 作废 / 按事由撤销也走这里。
 * 别的零件只读这张表，不直接 INSERT / UPDATE / DELETE——写权单点，坏了才知道该找谁。
 * 只 import db 的 now 和 core 的 nid，不带业务判断。
 */
import { now } from '../db.js'
import { nid } from '../core.js'

/** 排一条待发的主动消息；返回 id */
export function enqueueProactive(db, aid, { text, reason = null, dim = null, at = now() } = {}) {
  const id = nid('prc_')
  db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, aid, text, reason, dim, 'pending', at, null)
  return id
}

/** 标记「已经推给对方」；delivered_at 留空（主动推的不算 24 小时没回） */
export function markDelivered(db, id) {
  return Number(db.prepare("UPDATE proactive SET state='delivered', delivered_at=NULL WHERE id=? AND state='pending'").run(id).changes || 0)
}

/** 对方真的回话了：标成被回应 */
export function markAnswered(db, id, at = now()) {
  return Number(db.prepare('UPDATE proactive SET answered=1, answered_at=? WHERE id=?').run(at, id).changes || 0)
}

/** 24 小时没回应：记一次忽略 */
export function markIgnored(db, id) {
  return Number(db.prepare('UPDATE proactive SET ignored=1 WHERE id=?').run(id).changes || 0)
}

/** 这条主动消息被划掉了 */
export function dismissProactive(db, id) {
  return Number(db.prepare("UPDATE proactive SET state='dismissed' WHERE id=?").run(id).changes || 0)
}

/** 陈年 pending：超过时限没投递的作废 */
export function expireStaleProactive(db, beforeIso) {
  return Number(db.prepare("UPDATE proactive SET state='expired' WHERE state='pending' AND created_at < ?").run(beforeIso).changes || 0)
}

/** 冲突拍板后，撤掉还没发出去的「到底是哪个」问句 */
export function dropPendingByReason(db, aid, reason) {
  return Number(db.prepare("DELETE FROM proactive WHERE agent_id=? AND state='pending' AND reason=?").run(aid, reason).changes || 0)
}
