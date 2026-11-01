/**
 * selfmod 域存储原语：供 selfmod / drive 写入收件与变更，避免 drive↔selfmod 环依赖。
 * 表白名单归属 selfmod。
 */
import { now } from '../db.js'
import { nid } from '../kernel.js'

export function createInboxItem(db, aid, { lane, refId, title, detail = '', priority = 3, ttlDays = 1, expiresAt = null }) {
  const iid = nid('inb_')
  const exp = expiresAt || new Date(Date.now() + ttlDays * 86400000).toISOString()
  db.prepare('INSERT INTO inbox_items VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(iid, aid, lane, refId, title, detail, priority, 'pending', exp, now())
  return iid
}

/** 按引用 id 把收件条目置为过期（调用方负责给 id，本模块不碰别域的表） */
/** 清掉 N 天前的过期 todo 条目 */
export function recordSystemChange(db, aid, field, before = null, after = null) {
  const cid = nid('chg_')
  db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(cid, null, aid, field,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      now(), 'system', 'system', 'auto', null, null)
  return cid
}

export function countChangesOnDay(db, aid, dayPrefix) {
  return db.prepare('SELECT COUNT(*) n FROM changes WHERE agent_id=? AND applied_at LIKE ?').get(aid, dayPrefix + '%').n
}

export function hasRecentFieldChange(db, aid, field, sinceIso) {
  return !!db.prepare('SELECT 1 FROM changes WHERE agent_id=? AND field=? AND applied_at>?').get(aid, field, sinceIso)
}
