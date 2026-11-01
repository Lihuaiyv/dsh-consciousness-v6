/**
 * 三观账本：唯一写入口。只发 INSERT（I1）；一批事件同一事务（I6）。
 * 这里只做形状校验与落库；状态迁移是否合法由 fold 判定（见 projection.commitBatch）。
 */
import { savepoint } from '../../kernel.js'
import {
  EVENTS, ACTORS, LAYERS, ORIGINS, ENTITY_SLOTS, ID_PREFIX, EVIDENCE_KINDS, EDGE_TYPES, kindOk,
} from './catalog.js'
import { ulid } from './ulid.js'
import { SangguanError, ConflictError } from './errors.js'
import { hasJob } from './events.js'
import { commitBatch } from './projection.js'

export { SangguanError, ConflictError }
export { readEvents, lastSeq, hasJob, rowToEvent, eventsOf } from './events.js'

const PAYLOAD_MAX = 64 * 1024
const TEXT_MAX = 1000

function invalid(message, details) { throw new SangguanError('INVALID', message, details) }

function isoOf(v, what) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) invalid(what + ' 必须是 ISO 时间', { value: v })
  const ms = Date.parse(v)
  if (!Number.isFinite(ms)) invalid(what + ' 不是合法时间', { value: v })
  return new Date(ms).toISOString()
}

function text(v, what, max = TEXT_MAX) {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) invalid(what + ' 不能为空')
  if (s.length > max) invalid(what + ' 过长', { max })
  return s
}

const str = (v, what) => text(v, what, 200)
const optStr = (v, what) => (v == null || v === '' ? null : str(v, what))

// ---------- 实体形状 ----------
const ENTITY = {
  claims(c, ev) {
    if (c.layer !== ev.layer) invalid('命题层必须与事件层一致（I9）', { claim: c.layer, event: ev.layer })
    if (!kindOk(c.layer, c.kind)) invalid('种类不属于该层', { layer: c.layer, kind: c.kind })
    if (!ORIGINS.includes(c.origin)) invalid('非法 origin', { origin: c.origin })
    const pred = c.pred == null ? [] : c.pred
    if (!Array.isArray(pred) || pred.length > 2) invalid('pred 至多两个前驱')
    const boundary = c.boundary == null ? [] : c.boundary
    if (!Array.isArray(boundary) || boundary.length > 12) invalid('边界至多 12 条')
    return {
      layer: c.layer, kind: c.kind, text: text(c.text, '命题 text'), origin: c.origin,
      pred: pred.map((p) => str(p, 'pred')),
      boundary: boundary.map((b) => ({ text: text(b && b.text, '边界 text', 300), testable: !!(b && b.testable) })),
      q_id: optStr(c.q_id, 'q_id'),
    }
  },
  questions(q, ev) {
    if (q.layer !== ev.layer) invalid('问题层必须与事件层一致')
    return { layer: q.layer, text: text(q.text, '问题 text') }
  },
  kappas(k, ev) {
    if (k.layer !== ev.layer) invalid('κ 层必须与事件层一致')
    return {
      layer: k.layer, q_id: str(k.q_id, 'q_id'), pos_id: str(k.pos_id, 'pos_id'), neg_id: str(k.neg_id, 'neg_id'),
      dep: text(k.dep, '依存句 dep'), excl: text(k.excl, '排斥句 excl'),
    }
  },
  nus(n) {
    const p = Number(n.p)
    if (!(p >= 0.05 && p <= 0.95)) invalid('ν 的 p 必须在 [0.05, 0.95]', { p: n.p })
    return {
      claim_id: str(n.claim_id, 'claim_id'), expect: text(n.expect, 'ν expect'), observe: text(n.observe, 'ν observe'),
      p, due_at: isoOf(n.due_at, 'ν due_at'),
    }
  },
  evidence(x) {
    if (!EVIDENCE_KINDS.includes(x.kind)) invalid('证据 kind 只收 act / verdict / check（I7）', { kind: x.kind })
    if (x.target_type !== 'claim' && x.target_type !== 'nu') invalid('证据 target_type 只能是 claim / nu')
    if (x.sign !== 1 && x.sign !== -1) invalid('证据 sign 只能是 ±1')
    const w = Number(x.weight)
    if (!(w > 0 && w <= 1)) invalid('证据权重必须在 (0, 1]', { weight: x.weight })
    return {
      kind: x.kind, target_type: x.target_type, target_id: str(x.target_id, 'target_id'),
      sign: x.sign, weight: w, ref: text(x.ref, '证据 ref（外部记录）', 300), derived_from: optStr(x.derived_from, 'derived_from'),
    }
  },
  edges(e) {
    if (!EDGE_TYPES.includes(e.type)) invalid('非法边类型', { type: e.type })
    const from = str(e.from_id, 'from_id')
    const to = str(e.to_id, 'to_id')
    if (from === to) invalid('边不能自环')
    return { type: e.type, from_id: from, to_id: to }
  },
  summaries(s) {
    const layer = s.layer == null ? null : s.layer
    if (layer !== null && !LAYERS.includes(layer)) invalid('摘要层非法', { layer })
    const from = Number(s.from_seq)
    const to = Number(s.to_seq)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) invalid('摘要区间非法', { from_seq: s.from_seq, to_seq: s.to_seq })
    return { layer, kind: str(s.kind || 'chapter', '摘要 kind'), from_seq: from, to_seq: to, text: text(s.text, '摘要 text', 4000) }
  },
}

function slotRange(spec) {
  if (spec === '+') return [1, Infinity]
  if (Array.isArray(spec)) return spec
  return [spec, spec]
}

function normalizeEvent(ev, i) {
  if (!ev || typeof ev !== 'object') invalid('事件必须是对象', { i })
  const spec = EVENTS[ev.type]
  if (!spec) invalid('未知事件类型', { type: ev.type, i })
  if (!ACTORS.includes(ev.actor)) invalid('非法 actor', { actor: ev.actor, i })
  const at = isoOf(ev.at, '事件时间 at')
  let layer = ev.layer == null ? null : ev.layer
  if (layer !== null && !LAYERS.includes(layer)) invalid('非法层', { layer, i })
  if (spec.layer && !layer) invalid(ev.type + ' 必须带层', { i })
  const job = ev.job_key == null || ev.job_key === '' ? null : str(ev.job_key, 'job_key')
  if (spec.job && !job) invalid('JOB_DONE 必须带幂等键', { i })
  if (!spec.job && job) invalid('只有 JOB_DONE 可以带幂等键', { i })
  const raw = ev.payload == null ? {} : ev.payload
  if (typeof raw !== 'object' || Array.isArray(raw)) invalid('payload 必须是对象', { i })
  const payload = { ...raw }
  for (const f of spec.need || []) {
    if (payload[f] == null || payload[f] === '') invalid(ev.type + ' 缺字段 ' + f, { i })
  }
  const slots = spec.slots || {}
  const ms = Date.parse(at)
  const created = {}
  for (const slot of ENTITY_SLOTS) {
    const has = payload[slot] !== undefined
    if (!slots[slot]) {
      if (has) invalid(ev.type + ' 不能携带 ' + slot, { i })
      continue
    }
    const list = has ? payload[slot] : []
    if (!Array.isArray(list)) invalid(slot + ' 必须是数组', { i })
    const [lo, hi] = slotRange(slots[slot])
    if (list.length < lo || list.length > hi) invalid(ev.type + ' 的 ' + slot + ' 条数不对', { i, n: list.length })
    payload[slot] = list.map((o) => {
      if (!o || typeof o !== 'object') invalid(slot + ' 条目必须是对象', { i })
      const id = o.id == null ? ID_PREFIX[slot] + ulid(ms) : str(o.id, slot + '.id')
      return { id, ...ENTITY[slot](o, { layer }) }
    })
    created[slot] = payload[slot].map((o) => o.id)
  }
  const refs = ev.refs == null ? [] : ev.refs
  if (!Array.isArray(refs)) invalid('refs 必须是数组', { i })
  const precedent = ev.precedent_ids == null ? [] : ev.precedent_ids
  if (!Array.isArray(precedent)) invalid('precedent_ids 必须是数组', { i })
  const out = {
    id: ulid(ms), at, type: ev.type, layer, actor: ev.actor, job_key: job,
    refs: refs.map((r) => str(r, 'ref')), payload,
    gate_report: ev.gate_report == null ? null : ev.gate_report,
    precedent_ids: precedent.map((r) => str(r, 'precedent_id')),
    expect: ev.expect == null ? null : ev.expect,
    created,
  }
  if (JSON.stringify(out.payload).length > PAYLOAD_MAX) invalid('payload 过大', { i })
  return out
}

const ENTITY_TABLE = {
  claims: 'persona_claims', questions: 'claim_questions', kappas: 'claim_kappa',
  nus: 'claim_predictions', evidence: 'claim_evidence', edges: 'claim_edges', summaries: 'claim_summaries',
}

function insertEntity(db, aid, slot, o, at) {
  switch (slot) {
    case 'claims':
      db.prepare('INSERT INTO persona_claims(id,agent_id,layer,kind,text,boundary_json,pred_json,origin,q_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(o.id, aid, o.layer, o.kind, o.text, JSON.stringify(o.boundary), JSON.stringify(o.pred), o.origin, o.q_id, at)
      break
    case 'questions':
      db.prepare('INSERT INTO claim_questions(id,agent_id,layer,text,created_at) VALUES(?,?,?,?,?)')
        .run(o.id, aid, o.layer, o.text, at)
      break
    case 'kappas':
      db.prepare('INSERT INTO claim_kappa(id,agent_id,layer,q_id,pos_id,neg_id,dep,excl,opened_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(o.id, aid, o.layer, o.q_id, o.pos_id, o.neg_id, o.dep, o.excl, at)
      break
    case 'nus':
      db.prepare('INSERT INTO claim_predictions(id,agent_id,claim_id,expect,observe,p,reg_at,due_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(o.id, aid, o.claim_id, o.expect, o.observe, o.p, at, o.due_at)
      break
    case 'evidence':
      db.prepare('INSERT INTO claim_evidence(id,agent_id,kind,target_type,target_id,sign,weight,ref,derived_from,at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(o.id, aid, o.kind, o.target_type, o.target_id, o.sign, o.weight, o.ref, o.derived_from, at)
      break
    case 'edges':
      db.prepare('INSERT INTO claim_edges(id,agent_id,type,from_id,to_id,created_at) VALUES(?,?,?,?,?,?)')
        .run(o.id, aid, o.type, o.from_id, o.to_id, at)
      break
    case 'summaries':
      db.prepare('INSERT INTO claim_summaries(id,agent_id,layer,kind,from_seq,to_seq,text,built_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(o.id, aid, o.layer, o.kind, o.from_seq, o.to_seq, o.text, at)
      break
  }
}

const js = (v) => (v == null ? null : JSON.stringify(v))

/** 预先生成实体 id（调用方需要在同一批里互相引用时用）。 */
export function newId(slot, at) {
  if (!ID_PREFIX[slot]) invalid('未知实体槽', { slot })
  return ID_PREFIX[slot] + ulid(Date.parse(isoOf(at, 'at')))
}

/**
 * 追加一批事件。expect = { claims:{id:status}, kappas:{id:sigma}, nus:{id:outcome} }（I5）。
 * 返回 { ids, seqs, entities }；任何校验失败整批回滚并抛 SangguanError / ConflictError。
 */
export function append(db, aid, events, expect = null) {
  if (typeof aid !== 'string' || !aid) invalid('缺 agent_id')
  if (!Array.isArray(events) || !events.length) invalid('事件批次不能为空')
  const evs = events.map(normalizeEvent)
  const seen = new Set()
  for (const ev of evs) {
    for (const ids of Object.values(ev.created)) {
      for (const id of ids) {
        if (seen.has(id)) invalid('同批实体 id 重复', { id })
        seen.add(id)
      }
    }
  }
  const jobs = evs.filter((ev) => ev.job_key).map((ev) => ev.job_key)
  if (new Set(jobs).size !== jobs.length) throw new ConflictError('DUP_JOB', '同批幂等键重复（I16）', { jobs })
  const expects = [expect, ...evs.map((ev) => ev.expect)].filter(Boolean)
  return savepoint(db, () => commitBatch(db, aid, expects, () => {
    for (const ev of evs) {
      if (ev.job_key && hasJob(db, aid, ev.job_key)) {
        throw new ConflictError('DUP_JOB', '同一幂等键已完成（I16）', { job_key: ev.job_key })
      }
      for (const [slot, ids] of Object.entries(ev.created)) {
        const t = ENTITY_TABLE[slot]
        for (const id of ids) {
          if (db.prepare(`SELECT 1 o FROM ${t} WHERE id=?`).get(id)) invalid('实体 id 已存在', { slot, id })
        }
      }
    }
    const ids = []
    const seqs = []
    const entities = {}
    for (const ev of evs) {
      const r = db.prepare(`INSERT INTO claim_events(id,agent_id,at,type,layer,actor,refs_json,payload_json,gate_report_json,precedent_ids_json,expect_json,job_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        ev.id, aid, ev.at, ev.type, ev.layer, ev.actor, js(ev.refs), js(ev.payload), js(ev.gate_report),
        js(ev.precedent_ids), js(ev.expect), ev.job_key,
      )
      ids.push(ev.id)
      seqs.push(Number(r.lastInsertRowid))
      for (const slot of Object.keys(ev.created)) {
        for (const o of ev.payload[slot]) insertEntity(db, aid, slot, o, ev.at)
        entities[slot] = [...(entities[slot] || []), ...ev.created[slot]]
      }
    }
    for (const slot of ENTITY_SLOTS) if (!entities[slot]) entities[slot] = []
    return { ids, seqs, entities }
  }))
}
