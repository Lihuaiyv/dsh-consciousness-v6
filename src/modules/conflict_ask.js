/**
 * 冲突开案之后，真的开口问一句。
 *
 * 之前「报冲突」只落在 conflicts 表 + alerts 表里，是给面板看的；
 * 对话那头的小汐根本不知道有这回事。这个模块把冲突变成一条待发的主动消息：
 *   「你先前说「…冰的」，可后来又说「…热的」——到底哪个才是现在的呀？」
 *
 * 只排一条：同一对说法（同一对 memory id）只问一次，问完由 index.js 的
 * proactive 通道投递、并标记 delivered。想关掉用实例参数 memory.conflict.ask=off。
 */

import { now } from '../db.js'
import { nid, event, getParam } from '../kernel.js'

/** 摘要里的「1. 用户的事实：…」剥成一句人话，别把编号和栏目名一起念出来。 */
export function claimLine(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\s*\d+[.、)]\s*/, '')
    .replace(/^(用户的?|我的)?(事实|偏好与情绪|边界|偏好|情绪|经过|感受)[：:]\s*/, '')
    // 「用户昨天…」→「昨天…」：问句里是「你」，不是第三人称档案
    .replace(/^用户(?=(今天|昨天|前天|刚刚|刚才|最近|现在|之前))/, '')
    .replace(/^[，,、]\s*/, '')
    .slice(0, 70)
}

export function conflictAskText(aText, bText) {
  const A = claimLine(aText)
  const B = claimLine(bText)
  if (!A || !B) return ''
  return '你先前说「' + A + '」，可后来又说「' + B + '」——到底哪个才是现在的呀？'
}

/**
 * 给一条刚开的冲突排一条问句。同一个 id 对、或者同一对说法已经排过，就不再排。
 * @returns {null|{id:string, text:string}}
 */
export function askAboutConflict(db, aid, { cid, aId, bId, aText, bText }) {
  try {
    if (String(getParam(db, aid, 'memory.conflict.ask') || 'on') === 'off') return null
    if (!cid || !aId || !bId) return null
    const pending = db.prepare("SELECT id FROM proactive WHERE agent_id=? AND state='pending' AND reason=?")
      .get(aid, 'conflict:' + cid)
    if (pending) return null
    // gate 和 addMemory 可能各开一条同一对说法的冲突：别问两遍
    const twin = db.prepare("SELECT id FROM conflicts WHERE agent_id=? AND state='open' AND a_id=? AND b_id=? AND id<>?")
      .get(aid, aId, bId, cid)
    if (twin) {
      const asked = db.prepare("SELECT id FROM proactive WHERE agent_id=? AND state='pending' AND reason=?")
        .get(aid, 'conflict:' + twin.id)
      if (asked) return null
    }
    const text = conflictAskText(aText, bText)
    if (!text) return null
    const id = nid('prc_')
    db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, aid, text, 'conflict:' + cid, 'R', 'pending', now(), null)
    try { event(db, aid, 'proactive.queued', { dim: 'R', source: 'conflict', conflict_id: cid }) } catch { /* 记账失败不影响问 */ }
    return { id, text }
  } catch {
    return null
  }
}
