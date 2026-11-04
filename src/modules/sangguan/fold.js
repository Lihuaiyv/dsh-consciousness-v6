/**
 * 投影折叠（I15 纯函数）：不调模型、不读时钟、无随机；时间只来自事件的 at。
 * apply(state, ev) / fold(state, events) 不改输入，返回新状态；非法迁移抛 TRANSITION。
 * 守住的结构性规则：I4 单一交锋、I9 层内改写、I11 终态不离、P12 核心保护、P9 DEPENDS 无环、P13 Θ 范围。
 * 语义闸门（Decisive、SubOK 等）不在这里，由 gates 在写入前判定。
 */
import { isCoreKind, isTerminal, SIGMA_OPEN, SIGMA_LOCK, NU_OUTCOMES, BRANCHES } from './catalog.js'
import { isTunable, inRange, thetaOf } from './theta.js'
import { SangguanError } from './errors.js'
import { CREATE_STATUS, CLAIM_MOVES, KAPPA_MOVES, KAPPA_CLOSED, KAPPA_REFS } from './machine.js'

const DAY = 86400000

export function emptyState() {
  return { last_seq: 0, epoch: { W: 0, L: 0, V: 0 }, claims: {}, questions: {}, kappas: {}, nus: {}, edges: {}, theta: {} }
}

/** 固着度 e（§12）：只用于排序与注入，不作闸门输入。 */
export function eOf(c) {
  return 0.5 * (isCoreKind(c.layer, c.kind) ? 1 : 0) + 0.2 * Math.tanh(c.n_dep / 3) + 0.3 * Math.max(0, c.pi)
}

export const theta = (s, key, layer = null, scope = '*') => thetaOf(s.theta, key, scope, layer)

function bad(ev, message, details = {}) {
  throw new SangguanError('TRANSITION', message, { seq: ev.seq, type: ev.type, ...details })
}

const addDays = (at, d) => new Date(Date.parse(at) + d * DAY).toISOString()

/** 仪表种下、还没有任何证据、也不是从别的命题长出来的核心。不占 C_max。 */
export function isHollowSeed(c) {
  return !!c && c.origin === 'seed' && c.pi === 0 && c.n === 0 && (!c.pred || c.pred.length === 0) && !isTerminal(c.status)
}

function coreCount(s, layer) {
  let n = 0
  for (const c of Object.values(s.claims)) if (c.layer === layer && isCoreKind(layer, c.kind) && !isTerminal(c.status)) n++
  return n
}

function retireHollowCores(ctx, layer, exceptId) {
  for (const c of Object.values(ctx.s.claims)) {
    if (c.id === exceptId || c.layer !== layer || !isHollowSeed(c) || !isCoreKind(layer, c.kind)) continue
    c.status = 'superseded'
    touch(ctx, 'claims', c)
  }
}

/** 沿 active DEPENDS 边从 start 能否走到 target。 */
function reaches(s, start, target) {
  const adj = {}
  for (const e of Object.values(s.edges)) {
    if (e.type === 'DEPENDS' && e.active) (adj[e.from_id] ||= []).push(e.to_id)
  }
  const seen = new Set([start])
  const stack = [start]
  while (stack.length) {
    const x = stack.pop()
    if (x === target) return true
    for (const y of adj[x] || []) if (!seen.has(y)) { seen.add(y); stack.push(y) }
  }
  return false
}

function claimOf(ctx, id, what = '命题') {
  const c = ctx.s.claims[id]
  if (!c) bad(ctx.ev, what + '不存在', { id })
  return c
}

function kappaOf(ctx) {
  const id = ctx.p.kappa_id || (ctx.p.kappas && ctx.p.kappas[0] && ctx.p.kappas[0].id)
  const k = ctx.s.kappas[id]
  if (!k) bad(ctx.ev, 'κ 不存在', { id })
  if (k.layer !== ctx.ev.layer) bad(ctx.ev, 'κ 与事件不同层（I9）', { id })
  return k
}

const created = (ctx) => ctx.s.claims[ctx.p.claims[0].id]

function touch(ctx, kind, obj) {
  obj.last_seq = ctx.ev.seq
  ctx.dirty[kind].add(obj.id)
}

// ---------- 新实体 ----------
function applyEvidence(ctx, x) {
  const { s, ev } = ctx
  let cid = x.target_id
  if (x.target_type === 'nu') {
    const n = s.nus[x.target_id]
    if (!n) bad(ev, '证据指向的 ν 不存在', { id: x.target_id })
    if (!(Date.parse(ev.at) > Date.parse(n.reg_at))) bad(ev, 'P5：证据须晚于 ν 登记', { id: x.target_id })
    cid = n.claim_id
  }
  const c = claimOf(ctx, cid, '证据指向的命题')
  const w0 = theta(s, 'w_' + x.kind)
  const want = x.derived_from ? 0.5 * w0 : w0
  if (Math.abs(x.weight - want) > 1e-9) bad(ev, '证据权重须按种类（跨层派生为一半）', { kind: x.kind, weight: x.weight, want })
  c.pi = x.sign > 0
    ? c.pi + theta(s, 'alpha') * x.weight * (1 - c.pi)
    : c.pi - theta(s, 'beta') * x.weight * (1 + c.pi)
  c.n += 1
  c.last_ev_at = ev.at
  c.e = eOf(c)
  touch(ctx, 'claims', c)
  // 试用休眠：绑定 c*（或其 ν）的证据一到，清空 dormant_since
  for (const k of Object.values(s.kappas)) {
    if (k.sub_id === c.id && k.dormant_since) {
      k.dormant_since = null
      touch(ctx, 'kappas', k)
    }
  }
}

function addEdge(ctx, e) {
  const { s, ev } = ctx
  if (s.edges[e.id]) bad(ev, '边 id 已存在', { id: e.id })
  if (e.type !== 'PRESSURE') claimOf(ctx, e.from_id, '边起点')
  const to = claimOf(ctx, e.to_id, '边终点')
  if (e.type === 'DEPENDS') {
    const dupe = Object.values(s.edges).some((x) => x.active && x.type === 'DEPENDS' && x.from_id === e.from_id && x.to_id === e.to_id)
    if (dupe) bad(ev, 'DEPENDS 边重复', { from: e.from_id, to: e.to_id })
    if (reaches(s, e.to_id, e.from_id)) bad(ev, 'DEPENDS 成环（P9）', { from: e.from_id, to: e.to_id })
  }
  const edge = { id: e.id, type: e.type, from_id: e.from_id, to_id: e.to_id, active: 1, retired_at: null, last_seq: ev.seq }
  s.edges[e.id] = edge
  ctx.dirty.edges.add(e.id)
  if (e.type === 'DEPENDS') {
    to.n_dep += 1
    to.e = eOf(to)
    touch(ctx, 'claims', to)
  }
}

function createEntities(ctx) {
  const { s, ev, p } = ctx
  for (const q of p.questions || []) {
    if (s.questions[q.id]) bad(ev, '问题 id 已存在', { id: q.id })
    s.questions[q.id] = { id: q.id, layer: q.layer }
  }
  for (const c of p.claims || []) {
    const status = CREATE_STATUS[ev.type]
    if (!status) bad(ev, '该事件不能新建命题')
    if (s.claims[c.id]) bad(ev, '命题 id 已存在', { id: c.id })
    for (const pid of c.pred || []) claimOf(ctx, pid, '前驱')
    const nc = {
      id: c.id, layer: c.layer, kind: c.kind, origin: c.origin, pred: [...(c.pred || [])], q_id: c.q_id || null,
      status, pi: 0, n: 0, mentions: 0, e: 0, n_dep: 0, epoch: s.epoch[c.layer], review: 0,
      born_seq: ev.seq, last_ev_at: null, last_seq: ev.seq, meta: c.meta || null,
    }
    nc.e = eOf(nc)
    s.claims[c.id] = nc
    ctx.dirty.claims.add(c.id)
  }
  for (const k of p.kappas || []) {
    if (s.kappas[k.id]) bad(ev, 'κ id 已存在', { id: k.id })
    s.kappas[k.id] = {
      id: k.id, layer: k.layer, q_id: k.q_id, pos_id: k.pos_id, neg_id: k.neg_id, sigma: 'struggle', sub_id: null,
      last_delib_seq: null, trial_until: null, dormant_since: null, accepted_at: null, extended: 0,
      opened_at: ev.at, closed_at: null, last_seq: ev.seq,
    }
    ctx.dirty.kappas.add(k.id)
  }
  for (const n of p.nus || []) {
    if (s.nus[n.id]) bad(ev, 'ν id 已存在', { id: n.id })
    const c = claimOf(ctx, n.claim_id, 'ν 所属命题')
    if (isTerminal(c.status)) bad(ev, '终态命题不能再登记 ν', { id: c.id })
    const span = Date.parse(n.due_at) - Date.parse(ev.at)
    if (!(span > 0)) bad(ev, 'ν 到期须晚于登记')
    if (span > theta(s, 'T_nu') * DAY + 1e-6) bad(ev, 'ν 期限超过 T_ν', { days: span / DAY })
    s.nus[n.id] = { id: n.id, claim_id: n.claim_id, p: n.p, reg_at: ev.at, due_at: n.due_at, outcome: 'pending', resolved_at: null, last_seq: ev.seq }
    ctx.dirty.nus.add(n.id)
  }
  for (const x of p.evidence || []) applyEvidence(ctx, x)
  for (const e of p.edges || []) addEdge(ctx, e)
}

// ---------- 类型专属的结构检查与副作用 ----------
const SPECIAL = {
  CLAIM_EXP(ctx) {
    const c = created(ctx)
    if (isCoreKind(c.layer, c.kind)) {
      if (c.origin !== 'seed') bad(ctx.ev, '核心只能由 seed 直建，其余走 CORE_ESTABLISH / ELEV（§4.1）')
      if (coreCount(ctx.s, c.layer) > theta(ctx.s, 'C_max')) bad(ctx.ev, '核心已满 C_max')
    }
  },
  CLAIM_WITHDRAW(ctx) {
    const c = claimOf(ctx, ctx.p.claim_id, '撤回目标')
    if (c.origin !== 'seed') bad(ctx.ev, '只有种子可以撤回')
    if (c.pi !== 0 || c.n !== 0) bad(ctx.ev, '已经长出后续，不能撤回')
    for (const k of Object.values(ctx.s.kappas)) {
      if (SIGMA_OPEN.includes(k.sigma) && (k.pos_id === c.id || k.neg_id === c.id)) bad(ctx.ev, '先等这场矛盾结束')
    }
    for (const o of Object.values(ctx.s.claims)) {
      if (o.id !== c.id && (o.pred || []).includes(c.id)) bad(ctx.ev, '已经长出后续，不能撤回')
    }
  },
  // 违背：说了没做到。π 往下走，但不归零——还给它改的机会
  VIOLATE(ctx) {
    const c = claimOf(ctx, ctx.p.claim_id, '违背目标')
    if (c.layer !== 'V') bad(ctx.ev, '违背只作用在价值层')
    const b = theta(ctx.s, 'beta')
    c.pi = Math.max(-1, c.pi - 0.5 * b * (1 + c.pi))
    c.e = eOf(c)
    touch(ctx, 'claims', c)
  },
  // 已验证过（或已长进证据）的保护带：人可以直接收回，终态 withdrawn，账本只增
  CLAIM_RETIRE(ctx) {
    const c = claimOf(ctx, ctx.p.claim_id, '收回目标')
    if (isCoreKind(c.layer, c.kind)) bad(ctx.ev, '核心不能收回，换核心只能走升维')
    for (const k of Object.values(ctx.s.kappas)) {
      if (SIGMA_OPEN.includes(k.sigma) && (k.pos_id === c.id || k.neg_id === c.id)) bad(ctx.ev, '先等这场矛盾结束')
    }
  },
  REV(ctx) {
    const c = created(ctx)
    if (!c.pred.includes(ctx.p.old_id)) bad(ctx.ev, 'REV 新命题的 pred 须含被替换者')
    if (isCoreKind(c.layer, c.kind)) bad(ctx.ev, 'REV 不能产出核心')
  },
  CORE_ESTABLISH(ctx) {
    const c = created(ctx)
    if (!isCoreKind(c.layer, c.kind)) bad(ctx.ev, 'CORE_ESTABLISH 须产出核心种类')
    if (c.pred.length !== 1 || c.pred[0] !== ctx.p.from_id) bad(ctx.ev, '新核 pred 须恰为 [from_id]')
    retireHollowCores(ctx, c.layer, c.id)
    if (coreCount(ctx.s, c.layer) > theta(ctx.s, 'C_max')) bad(ctx.ev, '核心已满 C_max，只能走 ELEV（§4.1）')
  },
  ELEV_COMMIT(ctx) {
    if (!isCoreKind(created(ctx).layer, created(ctx).kind)) bad(ctx.ev, 'ELEV_COMMIT 须产出新核')
  },
  KAPPA_OPEN(ctx) {
    const { s, ev } = ctx
    const k = kappaOf(ctx)
    const q = s.questions[k.q_id]
    if (!q || q.layer !== ev.layer) bad(ev, 'U1/U4：问题不存在或不同层', { q: k.q_id })
    if (k.pos_id === k.neg_id) bad(ev, 'κ 两极不能相同')
    const pos = claimOf(ctx, k.pos_id, '正极')
    const neg = claimOf(ctx, k.neg_id, '反极')
    if (!(pos.born_seq < neg.born_seq)) bad(ev, '两极定向：c⁺ 须为较早创建者')
  },
  RESOLVE(ctx) {
    const k = kappaOf(ctx)
    const pair = [ctx.p.winner_id, ctx.p.loser_id].sort().join('|')
    if (ctx.p.winner_id === ctx.p.loser_id || pair !== [k.pos_id, k.neg_id].sort().join('|')) bad(ctx.ev, 'RESOLVE 的胜败须恰为 κ 两极')
  },
  SUB_ACCEPT(ctx) {
    const k = kappaOf(ctx)
    const c = created(ctx)
    if (!c.pred.includes(k.pos_id) || !c.pred.includes(k.neg_id)) bad(ctx.ev, '合题 pred 须指回两极')
    if (c.q_id !== k.q_id) bad(ctx.ev, 'S4：合题须回答同一问题')
    k.sub_id = c.id
    k.accepted_at = ctx.ev.at
    k.extended = 0
    k.trial_until = addDays(ctx.ev.at, theta(ctx.s, 'T_trial'))
    k.dormant_since = null
  },
  SUB_EXTEND(ctx) {
    if (ctx.ev.actor !== 'sys') bad(ctx.ev, 'SUB_EXTEND 只能由 sys 写')
    const k = kappaOf(ctx)
    if (k.sigma !== 'sub_trial') bad(ctx.ev, 'SUB_EXTEND 只在试用中')
    if (k.extended) bad(ctx.ev, '每个 κ 试用期只能延长一次')
    const sub = k.sub_id && ctx.s.claims[k.sub_id]
    if (sub && sub.n > 0) bad(ctx.ev, '已有证据的试用不能延长，应结算')
    k.extended = 1
    k.trial_until = addDays(k.trial_until || ctx.ev.at, theta(ctx.s, 'T_trial'))
    touch(ctx, 'kappas', k)
  },
  SUB_DORMANT(ctx) {
    if (ctx.ev.actor !== 'sys') bad(ctx.ev, 'SUB_DORMANT 只能由 sys 写')
    const k = kappaOf(ctx)
    if (k.sigma !== 'sub_trial') bad(ctx.ev, 'SUB_DORMANT 只在试用中')
    k.dormant_since = ctx.ev.at
    touch(ctx, 'kappas', k)
  },
  SUB_EXPIRE(ctx) {
    const k = kappaOf(ctx)
    if (!k.dormant_since) bad(ctx.ev, 'SUB_EXPIRE 须已休眠（dormant_since 非空）')
  },
  KAPPA_OBSOLETE(ctx) {
    const k = kappaOf(ctx)
    const dead = [k.pos_id, k.neg_id].some((id) => isTerminal(claimOf(ctx, id).status))
    if (!dead) bad(ctx.ev, 'KAPPA_OBSOLETE 须有一极已终态')
  },
  DELIBERATE(ctx) {
    const k = kappaOf(ctx)
    if (!BRANCHES.includes(ctx.p.branch)) bad(ctx.ev, '非法分支', { branch: ctx.p.branch })
    if (KAPPA_CLOSED.includes(k.sigma)) bad(ctx.ev, '已结 κ 不再审议')
    k.last_delib_seq = ctx.ev.seq
    touch(ctx, 'kappas', k)
  },
  TRADEOFF(ctx) {
    const k = kappaOf(ctx)
    if (k.sigma !== 'coexist') bad(ctx.ev, 'TRADEOFF 只绑定并存中的 κ')
    if (!['pos', 'neg', k.pos_id, k.neg_id].includes(ctx.p.lean_pole)) bad(ctx.ev, 'lean_pole 须指向一极')
  },
  CORE_CLASH(ctx) {
    const k = kappaOf(ctx)
    const both = [k.pos_id, k.neg_id].every((id) => isCoreKind(k.layer, claimOf(ctx, id).kind))
    if (!both) bad(ctx.ev, 'CORE_CLASH 须两极都是核心')
  },
  KAPPA_CANDIDATE(ctx) {
    const a = claimOf(ctx, ctx.p.a_id)
    const b = claimOf(ctx, ctx.p.b_id)
    if (a.id === b.id || a.layer !== ctx.ev.layer || b.layer !== ctx.ev.layer) bad(ctx.ev, '矛盾候选须是同层两个不同命题')
  },
  DUP(ctx) {
    const c = claimOf(ctx, ctx.p.claim_id)
    if (c.layer !== ctx.ev.layer) bad(ctx.ev, 'DUP 须同层')
    c.mentions += 1
    touch(ctx, 'claims', c)
  },
  FLIP(ctx) { claimOf(ctx, ctx.p.claim_id) },
  REVIEW_FLAG(ctx) {
    const c = claimOf(ctx, ctx.p.claim_id)
    c.review += 1
    touch(ctx, 'claims', c)
  },
  NU_RESOLVE(ctx) {
    const n = ctx.s.nus[ctx.p.nu_id]
    if (!n) bad(ctx.ev, 'ν 不存在', { id: ctx.p.nu_id })
    if (n.outcome !== 'pending') bad(ctx.ev, 'ν 已解决，不再迁移（I11）', { id: n.id, outcome: n.outcome })
    if (!NU_OUTCOMES.includes(ctx.p.outcome)) bad(ctx.ev, '非法 ν 结局', { outcome: ctx.p.outcome })
    n.outcome = ctx.p.outcome
    n.resolved_at = ctx.ev.at
    touch(ctx, 'nus', n)
  },
  EDGE_RETIRE(ctx) {
    const e = ctx.s.edges[ctx.p.edge_id]
    if (!e || !e.active) bad(ctx.ev, '边不存在或已退役', { id: ctx.p.edge_id })
    e.active = 0
    e.retired_at = ctx.ev.at
    touch(ctx, 'edges', e)
    if (e.type === 'DEPENDS') {
      const to = ctx.s.claims[e.to_id]
      to.n_dep -= 1
      to.e = eOf(to)
      touch(ctx, 'claims', to)
    }
  },
  THETA_ADJUST(ctx) {
    const { key, value } = ctx.p
    const scope = ctx.p.scope == null ? '*' : String(ctx.p.scope)
    if (!isTunable(key)) bad(ctx.ev, 'Θ 只能调带 * 的参数（I13）', { key })
    if (!inRange(key, value)) bad(ctx.ev, 'Θ 新值超出可调范围（P13）', { key, value })
    const k = key + '@' + scope
    ctx.s.theta[k] = { value, last_seq: ctx.ev.seq }
    ctx.dirty.theta.add(k)
  },
}
for (const t of KAPPA_REFS) if (!SPECIAL[t]) SPECIAL[t] = (ctx) => { kappaOf(ctx) }

// ---------- 状态机 ----------
function roleIds(ctx, role, k) {
  if (role === 'poles') return [k.pos_id, k.neg_id]
  // 只有本 κ 原先占着两极（struggle）才放回；挂起 / 并存的 κ 两极若 contested，是被别的 κ 占着
  if (role === 'live_poles') {
    if (!SIGMA_LOCK.includes(ctx.kFrom)) return []
    return [k.pos_id, k.neg_id].filter((id) => ctx.s.claims[id] && ctx.s.claims[id].status === 'contested')
  }
  if (role === 'sub') {
    if (!k.sub_id) bad(ctx.ev, 'κ 没有在试用的合题')
    return [k.sub_id]
  }
  return [ctx.p[role]]
}

function moveKappa(ctx) {
  const spec = KAPPA_MOVES[ctx.ev.type]
  if (!spec) return
  const k = kappaOf(ctx)
  if (!spec.from.includes(k.sigma)) bad(ctx.ev, 'σ 迁移非法', { id: k.id, from: k.sigma, to: spec.to })
  ctx.kFrom = k.sigma
  k.sigma = spec.to
  if (KAPPA_CLOSED.includes(spec.to)) k.closed_at = ctx.ev.at
  touch(ctx, 'kappas', k)
}

function moveClaims(ctx) {
  const rules = CLAIM_MOVES[ctx.ev.type]
  if (!rules) return
  const needsK = rules.some((r) => ['poles', 'live_poles', 'sub'].includes(r.role))
  const k = needsK ? kappaOf(ctx) : null
  for (const r of rules) {
    for (const id of roleIds(ctx, r.role, k)) {
      const c = claimOf(ctx, id)
      if (c.layer !== ctx.ev.layer) bad(ctx.ev, '跨层不能改命题状态（I9）', { id })
      if (!r.from.includes(c.status)) bad(ctx.ev, 'status 迁移非法', { id, from: c.status, to: r.to })
      const core = isCoreKind(c.layer, c.kind)
      if (r.guard === 'belt' && core) bad(ctx.ev, '核心不能被直接证伪或改写（P12）', { id })
      if (r.guard === 'core' && !core) bad(ctx.ev, '只能作用于核心', { id })
      c.status = r.to
      touch(ctx, 'claims', c)
    }
  }
}

function step(s, ev, dirty) {
  if (!Number.isInteger(ev.seq) || ev.seq <= s.last_seq) bad(ev, '事件 seq 必须严格递增', { last: s.last_seq })
  const ctx = { s, ev, p: ev.payload || {}, dirty }
  // 新核属于新纪元：先加纪元再建命题
  if (ev.type === 'ELEV_COMMIT') s.epoch[ev.layer] += 1
  createEntities(ctx)
  if (SPECIAL[ev.type]) SPECIAL[ev.type](ctx)
  moveKappa(ctx)
  moveClaims(ctx)
  s.last_seq = ev.seq
}

/** 折叠一串事件；dirty 记下被触及的对象，供增量落盘。 */
export function run(state, events) {
  const s = structuredClone(state)
  const dirty = { claims: new Set(), kappas: new Set(), nus: new Set(), edges: new Set(), theta: new Set() }
  for (const ev of events) step(s, ev, dirty)
  return { state: s, dirty }
}

export const fold = (state, events) => run(state, events).state
export const apply = (state, ev) => run(state, [ev]).state

/** 全局不变式（I4、P21、试用一致性、P9）；返回违规列表，空 = 成立。 */
export function checkInvariants(s) {
  const out = []
  const lock = {}
  const trialSubs = new Set()
  for (const k of Object.values(s.kappas)) {
    if (SIGMA_OPEN.includes(k.sigma)) {
      for (const id of [k.pos_id, k.neg_id]) {
        if (!s.claims[id] || isTerminal(s.claims[id].status)) out.push({ code: 'P21', id: k.id, msg: '未结 κ 有一极已终态', pole: id })
      }
    }
    if (SIGMA_LOCK.includes(k.sigma)) for (const id of [k.pos_id, k.neg_id]) lock[id] = (lock[id] || 0) + 1
    if (k.sigma === 'sub_trial') {
      trialSubs.add(k.sub_id)
      if (!s.claims[k.sub_id] || s.claims[k.sub_id].status !== 'provisional') out.push({ code: 'TRIAL', id: k.id, msg: '试用中的 κ 其合题不在 provisional' })
    }
  }
  for (const c of Object.values(s.claims)) {
    const n = lock[c.id] || 0
    if (n > 1) out.push({ code: 'I4', id: c.id, msg: '同一命题处于多个交锋中', n })
    if ((c.status === 'contested') !== (n === 1)) out.push({ code: 'I4', id: c.id, msg: 'contested 与交锋占用不一致', status: c.status, n })
    if (c.status === 'provisional' && !trialSubs.has(c.id)) out.push({ code: 'TRIAL', id: c.id, msg: 'provisional 命题没有对应的试用 κ' })
  }
  // P9：DEPENDS 子图可拓扑排序
  const indeg = {}
  const adj = {}
  for (const e of Object.values(s.edges)) {
    if (e.type !== 'DEPENDS' || !e.active) continue
    ;(adj[e.from_id] ||= []).push(e.to_id)
    indeg[e.to_id] = (indeg[e.to_id] || 0) + 1
    indeg[e.from_id] ||= 0
  }
  const queue = Object.keys(indeg).filter((x) => indeg[x] === 0)
  let seen = 0
  while (queue.length) {
    const x = queue.pop()
    seen++
    for (const y of adj[x] || []) if (--indeg[y] === 0) queue.push(y)
  }
  if (seen !== Object.keys(indeg).length) out.push({ code: 'P9', msg: 'DEPENDS 子图有环' })
  return out
}
