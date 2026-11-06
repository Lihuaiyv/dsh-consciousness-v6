/**
 * 「一句话一天最多说一次」的小闸。
 *
 * 为什么要它：有些注入行本身没错——「上次你们聊到哪儿」「这两天在往下掉」——
 * 但它们每一轮都贴在眼前，久了就不是提醒，是背景音；说一次是信息，说几百次是噪音。
 *
 * 只记痕，不改别的：每说一次往 events 写一条 say.once（带 key 和日期）。
 * maxDays 是「同一句最多说几天」：trend 这类方向灯说三天就够，再多我也知道了。
 */
import { event } from '../kernel.js'

const dayOf = (at) => new Date(at).toISOString().slice(0, 10)

function rowsOf(db, aid, key) {
  try {
    return db.prepare("SELECT created_at FROM events WHERE agent_id=? AND type='say.once' AND payload LIKE ?")
      .all(aid, '%"key":"' + key + '"%')
  } catch { return [] }
}

/** 这句已经说过几天（按天去重）。 */
export function saidDays(db, aid, key) {
  return new Set(rowsOf(db, aid, key).map((r) => String(r.created_at || '').slice(0, 10))).size
}

export function saidToday(db, aid, key, at = Date.now()) {
  const day = dayOf(at)
  return rowsOf(db, aid, key).some((r) => String(r.created_at || '').slice(0, 10) === day)
}

/**
 * 今天还能不能说这一句。
 * @param {{at?:number, maxDays?:number}} o maxDays>0 时，累计说过这么多天就不再开口。
 * @returns {boolean} true = 说，并且已经记了一笔；false = 今天/这阵子已经说过。
 */
export function canSayOnce(db, aid, key, { at = Date.now(), maxDays = 0 } = {}) {
  if (maxDays > 0 && saidDays(db, aid, key) >= maxDays) return false
  if (saidToday(db, aid, key, at)) return false
  try { event(db, aid, 'say.once', { key, day: dayOf(at) }) } catch { /* 记不上就照常说，别把话吞了 */ }
  return true
}
