/** 读账本：行 → 事件对象。ledger 与 projection 共用同一条读取路径，保证增量与重放看到的输入一致。 */

const parse = (s, d) => {
  if (s == null) return d
  try { return JSON.parse(s) } catch { return d }
}

export function rowToEvent(r) {
  return {
    seq: r.seq, id: r.id, agent_id: r.agent_id, at: r.at, type: r.type, layer: r.layer, actor: r.actor,
    refs: parse(r.refs_json, []), payload: parse(r.payload_json, {}), gate_report: parse(r.gate_report_json, null),
    precedent_ids: parse(r.precedent_ids_json, []), expect: parse(r.expect_json, null), job_key: r.job_key,
  }
}

const TYPE_CACHE = new WeakMap()

/** 同一账本序号下，某一类事件只读一次。新事件进来序号变了，自动作废。返回的数组不要改。 */
export function eventsOf(db, aid, type) {
  let byDb = TYPE_CACHE.get(db)
  if (!byDb) { byDb = new Map(); TYPE_CACHE.set(db, byDb) }
  const seq = lastSeq(db, aid)
  const k = aid + '|' + type
  const hit = byDb.get(k)
  if (hit && hit.seq === seq) return hit.rows
  const rows = readEvents(db, aid, { types: [type] })
  byDb.set(k, { seq, rows })
  return rows
}

export function readEvents(db, aid, { afterSeq = 0, upToSeq = null, types = null, limit = null } = {}) {
  const where = ['agent_id=?', 'seq>?']
  const args = [aid, Number(afterSeq) || 0]
  if (upToSeq != null) { where.push('seq<=?'); args.push(Number(upToSeq)) }
  if (Array.isArray(types) && types.length) {
    where.push('type IN (' + types.map(() => '?').join(',') + ')')
    args.push(...types)
  }
  let sql = 'SELECT * FROM claim_events WHERE ' + where.join(' AND ') + ' ORDER BY seq'
  if (limit) { sql += ' LIMIT ?'; args.push(Number(limit)) }
  return db.prepare(sql).all(...args).map(rowToEvent)
}

export function lastSeq(db, aid) {
  const r = db.prepare('SELECT MAX(seq) s FROM claim_events WHERE agent_id=?').get(aid)
  return r && r.s != null ? Number(r.s) : 0
}

/** 账本尖端：序号 + 最后一条的 id。投影缓存用它判断「有没有新事件」。 */
export function lastTip(db, aid) {
  const r = db.prepare('SELECT seq, id FROM claim_events WHERE agent_id=? ORDER BY seq DESC LIMIT 1').get(aid)
  return r ? r.seq + '|' + r.id : '0'
}

export function hasJob(db, aid, key) {
  return !!db.prepare("SELECT 1 o FROM claim_events WHERE agent_id=? AND type='JOB_DONE' AND job_key=?").get(aid, key)
}
