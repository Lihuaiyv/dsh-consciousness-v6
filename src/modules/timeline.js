/**
 * G1 时效索引：每条记忆「何时出生 / 改写 / 作废 / 复活 / 有争议 / 被隐藏」的只追加流水。
 *
 *   - 不存正文：正文永远从冷库取（fact_archive 版本原句、raw_turns 原话）。
 *   - 写失败静默：写入主链路不能被日志卡死；漏记由夜巡对账补 SYNC。
 *   - 对 memory_items 的「生效 / 正文 / 可见性」改动统一走这里（check-timeline 守门），
 *     UPDATE 语句与改造前逐字一致，列的含义不变，历史另存。
 *
 * 投影 projectTimeline 是纯函数：事件 → 有效区间 / 争议区间 / 版本切点。
 */
import { now } from '../db.js'
import { getParam } from '../kernel.js'

export const OPS = Object.freeze(['ADD', 'REVISE', 'INVALIDATE', 'REACTIVATE', 'DISPUTE_OPEN', 'DISPUTE_CLOSE',
  'HIDE', 'UNHIDE', 'DELETE', 'SYNC'])
const OPSET = new Set(OPS)

function iso(v) {
  if (v == null || v === '') return null
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const minIso = (a, b) => (a <= b ? a : b)
const maxIso = (a, b) => (a >= b ? a : b)

export function asofEnabled(db, aid) {
  try { return String(getParam(db, aid, 'memory.asof') || 'on') !== 'off' } catch { return true }
}

export function asofAxis(db, aid) {
  try { return String(getParam(db, aid, 'memory.asof.axis') || 'said') === 'recorded' ? 'recorded' : 'said' } catch { return 'said' }
}

/** 记一条事件；失败返回 null，不抛。 */
export function logEvent(db, aid, memId, op, o = {}) {
  if (!aid || !memId || !OPSET.has(op)) return null
  try {
    const at = iso(o.at) || now()
    const vf = iso(o.validFrom)
    const r = db.prepare(`INSERT INTO memory_timeline(agent_id,memory_id,op,at,valid_from,reason,cause_id,text_ref,actor,approx)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(aid, memId, op, at, vf ? minIso(vf, at) : null,
      o.reason ? String(o.reason).slice(0, 40) : null, o.causeId || null, o.textRef || null,
      o.actor ? String(o.actor).slice(0, 24) : null, o.approx ? 1 : 0)
    return Number(r.lastInsertRowid)
  } catch { return null }
}

/**
 * 说话时间（§5.1）：显式 valid_at → 来源原话 → 来源纪要起点 → 入库时间；永远不晚于入库时间。
 */
export function saidAt(db, aid, o = {}) {
  const at = iso(o.at) || now()
  let t = iso(o.validAt)
  const turn = o.sourceTurnId ? String(o.sourceTurnId) : ''
  if (!t && turn) {
    try {
      const r = db.prepare('SELECT MIN(created_at) t FROM raw_turns WHERE agent_id=? AND turn_id=?').get(aid, turn)
      t = iso(r && r.t)
    } catch { /* 老库 */ }
  }
  const ep = o.episodeId || (turn && !t ? turn : '')
  if (!t && ep) {
    try {
      const r = db.prepare('SELECT start_at FROM episodes WHERE agent_id=? AND id=?').get(aid, String(ep))
      t = iso(r && r.start_at)
    } catch { /* 老库 */ }
  }
  return t ? minIso(t, at) : at
}

/** 作废：与改造前相同的 UPDATE（可选 superseded_by / version / valid_at 清空 / 保留更早失效点）。 */
export function invalidateMemory(db, aid, id, o = {}) {
  const at = iso(o.at) || now()
  const sets = [o.keepEarlier ? 'invalid_at=COALESCE(invalid_at,?)' : 'invalid_at=?']
  const args = [at]
  if (o.clearValidAt) sets.push('valid_at=NULL')
  if (o.supersededBy !== undefined) { sets.push('superseded_by=?'); args.push(o.supersededBy) }
  if (o.bumpVersion) sets.push('version=version+1')
  const where = o.agentScoped ? 'id=? AND agent_id=?' : 'id=?'
  args.push(id)
  if (o.agentScoped) args.push(aid)
  const r = db.prepare(`UPDATE memory_items SET ${sets.join(', ')} WHERE ${where}`).run(...args)
  if (Number(r.changes)) {
    logEvent(db, aid, id, 'INVALIDATE', { at, reason: o.reason || 'unknown', causeId: o.causeId || o.supersededBy || null, actor: o.actor })
  }
  return r
}

/** 复活：invalid_at 清空（resolveConflict 原语义）。 */
export function reactivateMemory(db, aid, id, o = {}) {
  const at = iso(o.at) || now()
  const was = db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(id)
  const r = db.prepare('UPDATE memory_items SET invalid_at=NULL WHERE id=?').run(id)
  if (Number(r.changes) && was && was.invalid_at != null) {
    logEvent(db, aid, id, 'REACTIVATE', { at, reason: o.reason || 'resolve', causeId: o.causeId, actor: o.actor })
  }
  return r
}

/** 原地改写正文（门控 UPDATE）：调用方必须先把旧句存进 fact_archive 并传 textRef。 */
export function reviseMemory(db, aid, id, text, o = {}) {
  const at = iso(o.at) || now()
  const r = db.prepare('UPDATE memory_items SET text=?, version=version+1, hits=hits+1, last_hit_at=? WHERE id=?').run(text, at, id)
  if (Number(r.changes)) logEvent(db, aid, id, 'REVISE', { at, reason: o.reason || 'gate', textRef: o.textRef, actor: o.actor || 'gate' })
  return r
}

/** 软删（用户 / 整理丢弃）。 */
export function hideMemory(db, aid, id, o = {}) {
  const at = iso(o.at) || now()
  const r = db.prepare("UPDATE memory_items SET status='soft_deleted', deleted_at=? WHERE id=?").run(at, id)
  if (Number(r.changes)) logEvent(db, aid, id, 'HIDE', { at, reason: o.reason || 'user', actor: o.actor || 'user' })
  return r
}

export function unhideMemory(db, aid, id, o = {}) {
  const at = iso(o.at) || now()
  const r = db.prepare("UPDATE memory_items SET status='active', deleted_at=NULL WHERE id=?").run(id)
  if (Number(r.changes)) logEvent(db, aid, id, 'UNHIDE', { at, reason: o.reason || 'user', actor: o.actor || 'user' })
  return r
}

/** 门控删除：status='deleted'（老库缺列时退回只作废）。 */
export function deleteMemoryByGate(db, aid, id, o = {}) {
  const at = iso(o.at) || now()
  try {
    const r = db.prepare("UPDATE memory_items SET status='deleted', deleted_at=?, invalid_at=COALESCE(invalid_at,?), version=version+1 WHERE id=?")
      .run(at, at, id)
    if (Number(r.changes)) logEvent(db, aid, id, 'DELETE', { at, reason: o.reason || 'gate', actor: 'gate' })
    return r
  } catch {
    return invalidateMemory(db, aid, id, { at, reason: 'gate_delete' })
  }
}

export function disputeOpen(db, aid, ids, cid, o = {}) {
  for (const id of ids || []) if (id) logEvent(db, aid, id, 'DISPUTE_OPEN', { at: o.at, reason: o.reason || 'conflict', causeId: cid, actor: o.actor })
}

export function disputeClose(db, aid, ids, cid, o = {}) {
  for (const id of ids || []) if (id) logEvent(db, aid, id, 'DISPUTE_CLOSE', { at: o.at, reason: o.reason || 'resolve', causeId: cid, actor: o.actor })
}

/** 出生事件：addMemory 在事务里调用。 */
export function logAdd(db, aid, id, o = {}) {
  const at = iso(o.at) || now()
  const vf = saidAt(db, aid, { at, validAt: o.validAt, sourceTurnId: o.sourceTurnId, episodeId: o.episodeId })
  return logEvent(db, aid, id, 'ADD', { at, validFrom: vf, reason: o.reason, textRef: o.textRef, actor: o.actor, approx: o.approx })
}

// ---------------- 投影（纯函数） ----------------

/**
 * @param {Array<{seq:number,op:string,at:string,valid_from?:string|null,reason?:string|null,cause_id?:string|null,text_ref?:string|null,approx?:number}>} events
 * @param {{axis?:'said'|'recorded', causeSaid?:Record<string,string>|Map<string,string>}} [opt]
 * @returns {{born:string|null, active:Array<[string,string|null]>, disputes:Array<[string,string|null]>,
 *   revisions:Array<{eff:string,text_ref:string|null,at:string}>, hidden:boolean, deleted:boolean,
 *   approx:boolean, nowActive:boolean, events:Array<object>}}
 */
export function projectTimeline(events, opt = {}) {
  const axis = opt.axis === 'recorded' ? 'recorded' : 'said'
  const cs = opt.causeSaid
  const causeOf = (id) => (!id ? null : cs instanceof Map ? cs.get(id) : cs ? cs[id] : null) || null
  const list = [...(events || [])].sort((a, b) => Number(a.seq) - Number(b.seq))
  const out = { born: null, active: [], disputes: [], revisions: [], hidden: false, deleted: false, approx: false, nowActive: false, events: [] }
  let prev = null
  let isActive = false
  let start = null
  let dOpen = null
  for (const e0 of list) {
    const at = iso(e0.at)
    if (!at) continue
    const op = e0.op === 'SYNC' ? String(e0.reason || '').toUpperCase() : e0.op
    if (!OPSET.has(op) || op === 'SYNC') continue
    if (e0.approx) out.approx = true
    let cand = at
    if (axis === 'said') {
      if (op === 'ADD') cand = iso(e0.valid_from) || at
      else if (op === 'INVALIDATE' && e0.cause_id) cand = iso(causeOf(e0.cause_id)) || at
    }
    const eff = prev == null ? minIso(at, cand) : minIso(at, maxIso(prev, cand))
    // 不晚于入库时间的前提下也不早于上一个事件：区间永不倒挂
    const effMono = prev != null && eff < prev ? prev : eff
    prev = effMono
    out.events.push({ ...e0, op_eff: op, eff: effMono })
    if (!out.born) {
      out.born = effMono
      if (op !== 'ADD') out.approx = true
      isActive = true
      start = effMono
      if (op === 'ADD') continue
    }
    switch (op) {
      case 'ADD':
      case 'REACTIVATE':
        if (!isActive) { isActive = true; start = effMono }
        break
      case 'INVALIDATE':
        if (isActive) { out.active.push([start, effMono]); isActive = false; start = null }
        break
      case 'DISPUTE_OPEN':
        if (dOpen == null) dOpen = effMono
        break
      case 'DISPUTE_CLOSE':
        if (dOpen != null) { out.disputes.push([dOpen, effMono]); dOpen = null }
        break
      case 'HIDE': out.hidden = true; break
      case 'DELETE':
        // 门控删除同时写了 invalid_at（COALESCE），投影也要跟着失效
        out.deleted = true
        if (isActive) { out.active.push([start, effMono]); isActive = false; start = null }
        break
      case 'UNHIDE': out.hidden = false; out.deleted = false; break
      case 'REVISE': out.revisions.push({ eff: effMono, text_ref: e0.text_ref || null, at }); break
      default: break
    }
  }
  if (isActive && start != null) out.active.push([start, null])
  if (dOpen != null) out.disputes.push([dOpen, null])
  out.nowActive = isActive
  return out
}

/** 半开区间 [s,e) 是否与 [from,to) 重叠；零宽 [s,s] 视为在 s 点「说过」。 */
export function overlaps(iv, from, to) {
  const [s, e] = iv
  if (e != null && e === s) return s >= from && s < to
  return s < to && (e == null || e > from)
}

/** 给定时刻 t，哪个 REVISE 之前的正文算数：返回 text_ref（null = 用现行正文）。 */
export function versionRefAt(revisions, t) {
  for (const r of revisions || []) if (r.eff > t) return { text_ref: r.text_ref, revised: true }
  return { text_ref: null, revised: false }
}

// ---------------- 读库 ----------------

export function eventsOf(db, aid, memId) {
  try {
    return db.prepare('SELECT * FROM memory_timeline WHERE agent_id=? AND memory_id=? ORDER BY seq').all(aid, memId)
  } catch { return [] }
}

/** 取一批记忆的事件 + 取代者说话时间，投影好返回 Map<id, projection>。 */
export function projectMany(db, aid, ids, opt = {}) {
  const res = new Map()
  const list = [...new Set((ids || []).filter(Boolean))]
  if (!list.length) return res
  const byId = new Map(list.map((id) => [id, []]))
  const causes = new Set()
  try {
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200)
      const rows = db.prepare(`SELECT * FROM memory_timeline WHERE agent_id=? AND memory_id IN (${chunk.map(() => '?').join(',')}) ORDER BY seq`)
        .all(aid, ...chunk)
      for (const r of rows) {
        byId.get(r.memory_id).push(r)
        if (r.op === 'INVALIDATE' && r.cause_id) causes.add(r.cause_id)
      }
    }
  } catch { return res }
  const causeSaid = new Map()
  const cl = [...causes]
  for (let i = 0; i < cl.length; i += 200) {
    const chunk = cl.slice(i, i + 200)
    try {
      const rows = db.prepare(`SELECT memory_id, COALESCE(valid_from, at) vf FROM memory_timeline
        WHERE agent_id=? AND op='ADD' AND memory_id IN (${chunk.map(() => '?').join(',')}) ORDER BY seq`).all(aid, ...chunk)
      for (const r of rows) if (!causeSaid.has(r.memory_id)) causeSaid.set(r.memory_id, r.vf)
    } catch { /* ignore */ }
  }
  for (const [id, evs] of byId) res.set(id, projectTimeline(evs, { axis: opt.axis, causeSaid }))
  return res
}

// ---------------- 补录 / 对账 ----------------

const BOOT_KEY = 'timeline.bootstrapped.v1'
const BOOT_ORDER = { ADD: 0, REVISE: 1, INVALIDATE: 2, DISPUTE_OPEN: 3, REACTIVATE: 4, DISPUTE_CLOSE: 5, HIDE: 6, DELETE: 6 }

function parseJson(s) { try { return s ? JSON.parse(s) : null } catch { return null } }

/**
 * 从主表现状推一份近似历史（approx=1），只给「一条事件都没有」的记忆补：
 * 出生 @created_at → 改写旧句 @payload.at → 争议 @opened/resolved → 作废 @invalid_at → 隐藏/删除 @deleted_at。
 */
export function backfillMemory(db, aid, row, opt = {}) {
  const born = iso(row.created_at) || now()
  const clamp = (t) => maxIso(iso(t) || born, born)
  const birth = db.prepare('SELECT id,payload FROM fact_archive WHERE agent_id=? AND memory_id=?').get(aid, row.id)
  const bp = parseJson(birth && birth.payload)
  const evs = [{
    op: 'ADD', at: born, textRef: birth ? birth.id : null,
    validFrom: saidAt(db, aid, { at: born, sourceTurnId: row.source_turn_id, episodeId: bp && bp.episode_id }),
  }]
  const pre = row.id + ':hist:'
  try {
    for (const h of db.prepare('SELECT id,payload,created_at FROM fact_archive WHERE agent_id=? AND substr(memory_id,1,?)=?').all(aid, pre.length, pre)) {
      const p = parseJson(h.payload)
      evs.push({ op: 'REVISE', at: clamp((p && p.at) || h.created_at), textRef: h.id, reason: 'gate' })
    }
  } catch { /* 老库 */ }
  try {
    const list = db.prepare('SELECT * FROM conflicts WHERE agent_id=? AND (a_id=? OR b_id=?)').all(aid, row.id, row.id)
    for (const c of list) {
      // 低风险冲突当场结案、两条都留，从来没作废过谁，不算「有争议」
      if (c.severity === 'low' || !c.opened_at) continue
      evs.push({ op: 'DISPUTE_OPEN', at: clamp(c.opened_at), causeId: c.id, reason: 'conflict' })
      // 开案那一刻旧条（a）就被作废了；老库的 invalid_at 可能在结案时被改写，这里按开案时刻还原
      if (c.a_id === row.id) {
        evs.push({ op: 'INVALIDATE', at: clamp(c.opened_at), causeId: c.b_id, reason: 'conflict' })
        if (c.state !== 'open' && c.resolved_at && (c.resolution === 'a' || c.resolution === 'both')) {
          evs.push({ op: 'REACTIVATE', at: clamp(c.resolved_at), causeId: c.id, reason: 'resolve' })
        }
      }
      if (c.state !== 'open' && c.resolved_at) evs.push({ op: 'DISPUTE_CLOSE', at: clamp(c.resolved_at), causeId: c.id, reason: 'resolve' })
    }
  } catch { /* 老库 */ }
  if (row.invalid_at) {
    evs.push({ op: 'INVALIDATE', at: clamp(row.invalid_at), causeId: row.superseded_by || null, reason: row.superseded_by ? 'supersede' : 'unknown' })
  }
  if (row.status === 'soft_deleted') evs.push({ op: 'HIDE', at: clamp(row.deleted_at), reason: 'user' })
  if (row.status === 'deleted') evs.push({ op: 'DELETE', at: clamp(row.deleted_at), reason: 'gate' })
  evs.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : BOOT_ORDER[a.op] - BOOT_ORDER[b.op]))
  let n = 0
  for (const e of evs) if (logEvent(db, aid, row.id, e.op, { ...e, actor: opt.actor || 'backfill', approx: true })) n++
  return n
}

/** 给一个意识体里所有「没有事件」的记忆补录；返回补了几条记忆。 */
export function backfillAgent(db, aid, opt = {}) {
  let rows = []
  try {
    rows = db.prepare(`SELECT * FROM memory_items m WHERE m.agent_id=?
      AND NOT EXISTS(SELECT 1 FROM memory_timeline t WHERE t.agent_id=m.agent_id AND t.memory_id=m.id)
      ORDER BY m.created_at LIMIT ?`).all(aid, Math.max(1, Number(opt.limit) || 100000))
  } catch { return 0 }
  let n = 0
  for (const r of rows) if (backfillMemory(db, aid, r, opt) > 0) n++
  return n
}

/** 启动时一次性补录（写 flags）；失败下次启动再来。 */
export function ensureTimelineBootstrapped(db) {
  try {
    if (db.prepare('SELECT value FROM flags WHERE key=?').get(BOOT_KEY)) return 0
    const agents = db.prepare("SELECT id FROM agents WHERE status!='soft_deleted'").all()
    let n = 0
    for (const a of agents) n += backfillAgent(db, a.id)
    db.prepare('INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(BOOT_KEY, now())
    return n
  } catch { return 0 }
}

/**
 * 夜巡对账：投影现状 vs 主表现状，不一致补一条 SYNC（approx=1）；没事件的走补录。
 * 每晚最多修 limit 条，防一次性写爆。
 */
export function auditTimeline(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(2000, Number(opt.limit) || 200))
  let rows = []
  try { rows = db.prepare('SELECT * FROM memory_items WHERE agent_id=?').all(aid) } catch { return { ok: false, checked: 0, fixed: 0, missing: 0 } }
  const pm = projectMany(db, aid, rows.map((r) => r.id))
  let fixed = 0
  let missing = 0
  for (const r of rows) {
    if (fixed + missing >= limit) break
    const d = driftOf(r, pm.get(r.id))
    if (!d) continue
    if (d === 'missing') {
      if (backfillMemory(db, aid, r, { actor: 'audit' })) missing++
      continue
    }
    const when = d === 'INVALIDATE' ? r.invalid_at : (d === 'HIDE' || d === 'DELETE') ? r.deleted_at : null
    if (logEvent(db, aid, r.id, 'SYNC', { at: iso(when) || now(), reason: d, actor: 'audit', approx: true })) fixed++
  }
  return { ok: true, checked: rows.length, fixed, missing }
}

/** 漂移计数（体检用，只读）。 */
export function timelineDrift(db, aid) {
  let rows = []
  try { rows = db.prepare('SELECT * FROM memory_items WHERE agent_id=?').all(aid) } catch { return { total: 0, drift: 0, missing: 0 } }
  const pm = projectMany(db, aid, rows.map((r) => r.id))
  let drift = 0
  let missing = 0
  for (const r of rows) {
    const d = driftOf(r, pm.get(r.id))
    if (d === 'missing') missing++
    else if (d) drift++
  }
  return { total: rows.length, drift, missing }
}

/** 主表现状 → 与投影可比的三元组。 */
export function rowState(row) {
  return {
    active: row.invalid_at == null,
    hidden: row.status === 'soft_deleted',
    deleted: row.status === 'deleted',
  }
}

/** 投影现状是否与主表现状一致（对账 / 漂移统计用）。 */
export function driftOf(row, proj) {
  if (!proj || !proj.born) return 'missing'
  const s = rowState(row)
  if (s.active !== proj.nowActive) return s.active ? 'REACTIVATE' : 'INVALIDATE'
  if (s.hidden && !proj.hidden) return 'HIDE'
  if (s.deleted && !proj.deleted) return 'DELETE'
  if (!s.hidden && !s.deleted && (proj.hidden || proj.deleted)) return 'UNHIDE'
  return null
}
