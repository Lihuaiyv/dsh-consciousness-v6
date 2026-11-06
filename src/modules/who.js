/**
 * 认人：这条消息是谁说的。
 *
 * 以前这条判断散在几处，而且顺序还不一样——
 *   编排层 / 开口判断：先主人、再通道；
 *   关系入账：先通道、再主人；
 *   关系动力记账（bumpRelation）：又回到先主人、再通道。
 * 同一个 QQ 上绑了别人时，前一种会把 TA 说的话记到主人头上。
 *
 * 这里只留一条规矩：**通道绑了谁，就是谁；没绑才落到主人；都没有就返回 null。**
 * 不写库、不判关系轻重，只回答「谁在说话」；关系怎么变是关系动力的事。
 *
 * 「按通道找人 / 找主人」这两下也放在这里：它们是这条规矩的原料。
 * 放在别处谁都能调，就又会有人照抄一遍——所以关系动力要问，也只调 whoIsSpeaking。
 */

export function ownerPerson(db, aid) {
  return db.prepare("SELECT * FROM rel_person WHERE agent_id=? AND tier='owner' AND status='active'").get(aid) || null
}

export function personByChannel(db, aid, { channel = 'ui', handle = 'local' } = {}) {
  const row = db.prepare(`SELECT p.* FROM rel_channel c JOIN rel_person p ON p.id=c.person_id
    WHERE c.agent_id=? AND c.channel=? AND c.handle=?`).get(aid, String(channel), String(handle))
  return row || null
}

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
