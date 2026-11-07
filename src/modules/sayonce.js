/**
 * 「一句话一天最多说一次」的小闸。
 *
 * 为什么要它：有些注入行本身没错——「上次你们聊到哪儿」「这两天在往下掉」——
 * 但它们每一轮都贴在眼前，久了就不是提醒，是背景音；说一次是信息，说几百次是噪音。
 *
 * 只记痕，不改别的：每说一次往 events 写一条 say.once（带 key 和日期）。
 *
 * 两种上限，别混：
 *   - 一天一次：不传 maxDays，只看「今天说过没有」——明天照说。
 *   - 说几天就收声：传 maxDays + withinDays（窗口天）。窗口是必须的：
 *     不传窗口时 maxDays 会算成「这辈子一共说过几天」，一次说满就永远闭麦
 *     （bridge 当初传了 maxDays:1，结果只能活一天，这是个 bug）。
 */
import { event } from '../kernel.js'

const dayOf = (at) => new Date(at).toISOString().slice(0, 10)

function rowsOf(db, aid, key, at = Date.now(), withinDays = 0) {
  try {
    if (withinDays > 0) {
      const since = new Date(at - withinDays * 86400000).toISOString()
      return db.prepare("SELECT created_at FROM events WHERE agent_id=? AND type='say.once' AND created_at>=? AND payload LIKE ?")
        .all(aid, since, '%"key":"' + key + '"%')
    }
    return db.prepare("SELECT created_at FROM events WHERE agent_id=? AND type='say.once' AND payload LIKE ?")
      .all(aid, '%"key":"' + key + '"%')
  } catch { return [] }
}

/** 这句说过几天（按天去重）。withinDays>0 时只数窗口内的。 */
export function saidDays(db, aid, key, { at = Date.now(), withinDays = 0 } = {}) {
  return new Set(rowsOf(db, aid, key, at, withinDays).map((r) => String(r.created_at || '').slice(0, 10))).size
}

export function saidToday(db, aid, key, at = Date.now()) {
  const day = dayOf(at)
  return rowsOf(db, aid, key, at).some((r) => String(r.created_at || '').slice(0, 10) === day)
}

/**
 * 今天还能不能说这一句。
 * @param {{at?:number, maxDays?:number, withinDays?:number, meta?:object}} o
 *   maxDays>0 时：窗口 withinDays 天内说满这么多天就不再开口（不传窗口 = 全历史，慎用）。
 *   meta：顺手记下的当时读数（比如方向灯的 delta）。事后对账不必再猜「当时是什么样」。
 * @returns {boolean} true = 说，并且已经记了一笔；false = 今天/这阵子已经说过。
 */
export function canSayOnce(db, aid, key, { at = Date.now(), maxDays = 0, withinDays = 0, meta = null } = {}) {
  if (maxDays > 0 && saidDays(db, aid, key, { at, withinDays }) >= maxDays) return false
  if (saidToday(db, aid, key, at)) return false
  /* 按「决定说这句话的时刻」记，不用 event()——它固定写 now()，
     回放/模拟时几天的话会全挤在今天，闸就废了。 */
  try {
    const id = 'evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8)
    const payload = meta && typeof meta === 'object' ? { ...meta, key, day: dayOf(at) } : { key, day: dayOf(at) }
    db.prepare('INSERT INTO events(id,agent_id,type,payload,created_at) VALUES(?,?,?,?,?)')
      .run(id, aid, 'say.once', JSON.stringify(payload), new Date(at).toISOString())
  } catch { /* 记不上就照常说，别把话吞了 */ }
  return true
}
