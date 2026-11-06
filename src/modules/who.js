/**
 * 认人：这条消息是谁说的。
 *
 * 以前这条判断散在几处，而且顺序还不一样——
 *   编排层 / 开口判断：先主人、再通道；
 *   关系入账：先通道、再主人。
 * 同一个 QQ 上绑了别人时，前一种会把 TA 说的话记到主人头上。
 *
 * 这里只留一条规矩：**通道绑了谁，就是谁；没绑才落到主人；都没有就返回 null。**
 * 不写库、不判关系轻重，只回答「谁在说话」；关系怎么变是关系动力的事。
 */
import { ownerPerson, personByChannel } from './relations.js'

/**
 * @param {object} db
 * @param {string} aid
 * @param {{channel?:string, handle?:string}} [opt]
 * @returns {object|null} 人物行（含 source: 'channel' | 'owner'）
 */
export function whoIsSpeaking(db, aid, { channel = 'ui', handle = 'local' } = {}) {
  const byChannel = personByChannel(db, aid, { channel, handle })
  if (byChannel) return { ...byChannel, source: 'channel' }
  const owner = ownerPerson(db, aid)
  if (owner) return { ...owner, source: 'owner' }
  return null
}
