/**
 * 投影缓存：claim_proj_* 只是 fold(账本) 的落盘结果，可随时清空重建（I2）。
 * 增量（commitBatch）与重建（rebuild）走同一个 fold 和同一条事件读取路径，P1 由此保证。
 */
import { savepoint } from '../../kernel.js'
import { emptyState, run, fold, checkInvariants } from './fold.js'
import { readEvents, lastSeq, lastTip } from './events.js'
import { SangguanError, ConflictError } from './errors.js'
import { isTerminal, LAYERS } from './catalog.js'
import { PROJ_TABLES } from './schema.js'

// ---------- 行格式（snapshot 与落盘共用，字段顺序固定） ----------
const claimRow = (aid, c) => ({
  id: c.id, agent_id: aid, layer: c.layer, kind: c.kind, status: c.status, pi: c.pi, n: c.n, mentions: c.mentions,
  e: c.e, n_dep: c.n_dep, epoch: c.epoch, review: c.review, born_seq: c.born_seq, last_ev_at: c.last_ev_at, last_seq: c.last_seq,
})
const kappaRow = (aid, k) => ({
  id: k.id, agent_id: aid, layer: k.layer, sigma: k.sigma, sub_id: k.sub_id, last_delib_seq: k.last_delib_seq,
  trial_until: k.trial_until, dormant_since: k.dormant_since, accepted_at: k.accepted_at, extended: k.extended || 0,
  opened_at: k.opened_at, closed_at: k.closed_at, last_seq: k.last_seq,
})
const nuRow = (aid, n) => ({ id: n.id, agent_id: aid, claim_id: n.claim_id, outcome: n.outcome, resolved_at: n.resolved_at, last_seq: n.last_seq })
const edgeRow = (aid, e) => ({ id: e.id, agent_id: aid, active: e.active, retired_at: e.retired_at, last_seq: e.last_seq })
const thetaRow = (aid, k, t) => {
  const at = k.indexOf('@')
  return { agent_id: aid, key: k.slice(0, at), scope: k.slice(at + 1), value: t.value, last_seq: t.last_seq }
}

const TABLES = {
  claims: ['claim_proj_claim', claimRow],
  kappas: ['claim_proj_kappa', kappaRow],
  nus: ['claim_proj_nu', nuRow],
  edges: ['claim_proj_edge', edgeRow],
}
const COLS = {
  claim_proj_claim: Object.keys(claimRow('', { })),
  claim_proj_kappa: Object.keys(kappaRow('', { })),
  claim_proj_nu: Object.keys(nuRow('', { })),
  claim_proj_edge: Object.keys(edgeRow('', { })),
  claim_proj_theta: ['agent_id', 'key', 'scope', 'value', 'last_seq'],
}

function upsert(db, table, row) {
  const cols = COLS[table]
  db.prepare(`INSERT OR REPLACE INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => (row[c] === undefined ? null : row[c])))
}

function save(db, aid, s, dirty) {
  for (const [slot, [table, toRow]] of Object.entries(TABLES)) {
    for (const id of dirty[slot]) upsert(db, table, toRow(aid, s[slot][id]))
  }
  for (const k of dirty.theta) upsert(db, 'claim_proj_theta', thetaRow(aid, k, s.theta[k]))
  db.prepare('INSERT OR REPLACE INTO claim_proj_meta(agent_id,last_seq) VALUES(?,?)').run(aid, s.last_seq)
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 纯内存状态 → 与 snapshot(db) 同格式，用于逐字段比较（P1）。 */
export function stateToSnapshot(s, aid) {
  const rows = (slot, f) => Object.values(s[slot]).map((o) => f(aid, o)).sort(byId)
  return {
    last_seq: s.last_seq,
    claims: rows('claims', claimRow),
    kappas: rows('kappas', kappaRow),
    nus: rows('nus', nuRow),
    edges: rows('edges', edgeRow),
    theta: Object.entries(s.theta).map(([k, t]) => thetaRow(aid, k, t))
      .sort((a, b) => (a.key + '@' + a.scope < b.key + '@' + b.scope ? -1 : 1)),
  }
}

/** 投影表现状（按 id 排序），与 stateToSnapshot 同格式。 */
export function snapshot(db, aid) {
  const all = (table) => db.prepare(`SELECT ${COLS[table].join(',')} FROM ${table} WHERE agent_id=? ORDER BY id`).all(aid).map((r) => ({ ...r }))
  const meta = db.prepare('SELECT last_seq FROM claim_proj_meta WHERE agent_id=?').get(aid)
  return {
    last_seq: meta ? meta.last_seq : 0,
    claims: all('claim_proj_claim'),
    kappas: all('claim_proj_kappa'),
    nus: all('claim_proj_nu'),
    edges: all('claim_proj_edge'),
    theta: db.prepare('SELECT agent_id,key,scope,value,last_seq FROM claim_proj_theta WHERE agent_id=? ORDER BY key || \'@\' || scope')
      .all(aid).map((r) => ({ ...r })),
  }
}

// ---------- 读回内存状态 ----------
function readState(db, aid) {
  const s = emptyState()
  const meta = db.prepare('SELECT last_seq FROM claim_proj_meta WHERE agent_id=?').get(aid)
  s.last_seq = meta ? meta.last_seq : 0
  for (const r of db.prepare(`SELECT p.*, c.origin, c.pred_json, c.q_id, c.meta_json FROM claim_proj_claim p
    JOIN persona_claims c ON c.id=p.id WHERE p.agent_id=?`).all(aid)) {
    let meta = null
    try { meta = r.meta_json ? JSON.parse(r.meta_json) : null } catch { meta = null }
    s.claims[r.id] = {
      id: r.id, layer: r.layer, kind: r.kind, origin: r.origin, pred: JSON.parse(r.pred_json || '[]'), q_id: r.q_id,
      status: r.status, pi: r.pi, n: r.n, mentions: r.mentions, e: r.e, n_dep: r.n_dep, epoch: r.epoch, review: r.review,
      born_seq: r.born_seq, last_ev_at: r.last_ev_at, last_seq: r.last_seq, meta,
    }
  }
  for (const r of db.prepare('SELECT id, layer FROM claim_questions WHERE agent_id=?').all(aid)) s.questions[r.id] = { id: r.id, layer: r.layer }
  for (const r of db.prepare(`SELECT p.*, k.q_id, k.pos_id, k.neg_id FROM claim_proj_kappa p
    JOIN claim_kappa k ON k.id=p.id WHERE p.agent_id=?`).all(aid)) {
    s.kappas[r.id] = {
      id: r.id, layer: r.layer, q_id: r.q_id, pos_id: r.pos_id, neg_id: r.neg_id, sigma: r.sigma, sub_id: r.sub_id,
      last_delib_seq: r.last_delib_seq, trial_until: r.trial_until, dormant_since: r.dormant_since,
      accepted_at: r.accepted_at, extended: r.extended || 0,
      opened_at: r.opened_at, closed_at: r.closed_at, last_seq: r.last_seq,
    }
  }
  for (const r of db.prepare(`SELECT p.*, n.p, n.reg_at, n.due_at FROM claim_proj_nu p
    JOIN claim_predictions n ON n.id=p.id WHERE p.agent_id=?`).all(aid)) {
    s.nus[r.id] = { id: r.id, claim_id: r.claim_id, p: r.p, reg_at: r.reg_at, due_at: r.due_at, outcome: r.outcome, resolved_at: r.resolved_at, last_seq: r.last_seq }
  }
  for (const r of db.prepare(`SELECT p.*, e.type, e.from_id, e.to_id FROM claim_proj_edge p
    JOIN claim_edges e ON e.id=p.id WHERE p.agent_id=?`).all(aid)) {
    s.edges[r.id] = { id: r.id, type: r.type, from_id: r.from_id, to_id: r.to_id, active: r.active, retired_at: r.retired_at, last_seq: r.last_seq }
  }
  for (const r of db.prepare('SELECT key, scope, value, last_seq FROM claim_proj_theta WHERE agent_id=?').all(aid)) {
    s.theta[r.key + '@' + r.scope] = { value: r.value, last_seq: r.last_seq }
  }
  // I3：纪元不存计数器，按 ELEV_COMMIT 事件现数
  for (const r of db.prepare("SELECT layer, COUNT(*) n FROM claim_events WHERE agent_id=? AND type='ELEV_COMMIT' AND seq<=? GROUP BY layer").all(aid, s.last_seq)) {
    if (LAYERS.includes(r.layer)) s.epoch[r.layer] = r.n
  }
  return s
}

const countOf = (db, sql, aid) => db.prepare(sql).get(aid).n

/** 投影是否与账本对齐：断点一致，且实体与投影行数一致。 */
function fresh(db, aid) {
  const meta = db.prepare('SELECT last_seq FROM claim_proj_meta WHERE agent_id=?').get(aid)
  if ((meta ? meta.last_seq : 0) !== lastSeq(db, aid)) return false
  const pairs = [['persona_claims', 'claim_proj_claim'], ['claim_kappa', 'claim_proj_kappa'], ['claim_predictions', 'claim_proj_nu'], ['claim_edges', 'claim_proj_edge']]
  return pairs.every(([a, b]) => countOf(db, `SELECT COUNT(*) n FROM ${a} WHERE agent_id=?`, aid) === countOf(db, `SELECT COUNT(*) n FROM ${b} WHERE agent_id=?`, aid))
}

const STATE_CACHE = new WeakMap()

function stateBucket(db) {
  let m = STATE_CACHE.get(db)
  if (!m) { m = new Map(); STATE_CACHE.set(db, m) }
  return m
}

/** 当前投影状态；同一账本尖端只读一次库，返回副本，调用方改不到缓存。不齐时先重建。 */
export function loadState(db, aid) {
  const tip = lastTip(db, aid)
  const seq = tip === '0' ? 0 : Number(tip.slice(0, tip.indexOf('|')))
  const bucket = stateBucket(db)
  const hit = bucket.get(aid)
  // 投影表被清掉时 meta 没了，不能拿内存里的旧副本充数
  const meta = db.prepare('SELECT last_seq FROM claim_proj_meta WHERE agent_id=?').get(aid)
  if (hit && hit.tip === tip && meta && meta.last_seq === seq) return structuredClone(hit.state)
  if (!fresh(db, aid)) rebuild(db, aid)
  const s = readState(db, aid)
  bucket.set(aid, { tip: lastTip(db, aid), state: s })
  return structuredClone(s)
}

/** 清空本 agent 的投影，从账本全量重放（P1）。 */
export function rebuild(db, aid) {
  return savepoint(db, () => {
    for (const t of PROJ_TABLES) db.prepare(`DELETE FROM ${t} WHERE agent_id=?`).run(aid)
    const events = readEvents(db, aid)
    const { state } = run(emptyState(), events)
    const bad = checkInvariants(state)
    if (bad.length) throw new SangguanError('INVARIANT', '重放后不变式不成立：账本可能被外部改动', { violations: bad.slice(0, 5) })
    const all = {
      claims: Object.keys(state.claims), kappas: Object.keys(state.kappas), nus: Object.keys(state.nus),
      edges: Object.keys(state.edges), theta: Object.keys(state.theta),
    }
    save(db, aid, state, all)
    return { events: events.length, claims: all.claims.length, kappas: all.kappas.length, nus: all.nus.length, edges: all.edges.length, last_seq: state.last_seq }
  })
}

function checkExpect(s, expects) {
  const miss = []
  for (const x of expects) {
    if (!x || typeof x !== 'object') continue
    for (const [id, want] of Object.entries(x.claims || {})) {
      const got = s.claims[id] ? s.claims[id].status : null
      if (got !== want) miss.push({ kind: 'claim', id, want, got })
    }
    for (const [id, want] of Object.entries(x.kappas || {})) {
      const got = s.kappas[id] ? s.kappas[id].sigma : null
      if (got !== want) miss.push({ kind: 'kappa', id, want, got })
    }
    for (const [id, want] of Object.entries(x.nus || {})) {
      const got = s.nus[id] ? s.nus[id].outcome : null
      if (got !== want) miss.push({ kind: 'nu', id, want, got })
    }
  }
  if (miss.length) throw new ConflictError('EXPECT', '投影已变，与 expect 不符（I5）', { mismatches: miss })
}

/**
 * ledger.append 在事务内调用：对写入前的投影校验 expect → write() 落事件 → 折叠新事件 → 不变式 → 增量落盘。
 * 任何一步抛错，外层 savepoint 整批回滚。
 */
export function commitBatch(db, aid, expects, write) {
  const before = loadState(db, aid)
  checkExpect(before, expects)
  const out = write()
  const { state, dirty } = run(before, readEvents(db, aid, { afterSeq: before.last_seq }))
  const bad = checkInvariants(state)
  if (bad.length) throw new SangguanError('INVARIANT', bad[0].msg, { violations: bad.slice(0, 5) })
  save(db, aid, state, dirty)
  return out
}

/** 任意时刻的状态 = fold(事件 ≤ seq)（I2），纯内存，不落盘。 */
export function stateAt(db, aid, seq) {
  return fold(emptyState(), readEvents(db, aid, { upToSeq: seq }))
}

/** 链头：无非终态后继的非终态命题；按 e 降序、id 升序。 */
export function listHeads(db, aid, layer) {
  const s = loadState(db, aid)
  const succ = {}
  for (const c of Object.values(s.claims)) {
    if (isTerminal(c.status)) continue
    for (const p of c.pred) succ[p] = true
  }
  const texts = Object.fromEntries(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=? AND layer=?').all(aid, layer).map((r) => [r.id, r.text]))
  return Object.values(s.claims)
    .filter((c) => c.layer === layer && !isTerminal(c.status) && !succ[c.id])
    .sort((a, b) => b.e - a.e || byId(a, b))
    .map((c) => ({ id: c.id, layer: c.layer, kind: c.kind, text: texts[c.id], status: c.status, origin: c.origin, pi: c.pi, n: c.n, e: c.e, epoch: c.epoch }))
}

/** I3：g_turn / g_prog / epoch 只从事件现数，不存计数器。 */
export function derivedCounts(db, aid) {
  const out = { g_turn: { W: 0, L: 0, V: 0 }, g_prog: { W: 0, L: 0, V: 0 }, epoch: { W: 0, L: 0, V: 0 } }
  for (const r of db.prepare("SELECT type, layer, COUNT(*) n FROM claim_events WHERE agent_id=? AND type IN ('SUB_CONFIRM','ELEV_COMMIT') GROUP BY type, layer").all(aid)) {
    if (!LAYERS.includes(r.layer)) continue
    if (r.type === 'SUB_CONFIRM') out.g_turn[r.layer] = r.n
    else { out.g_prog[r.layer] = r.n; out.epoch[r.layer] = r.n }
  }
  return out
}
