/**
 * 快环 F1–F5（code-guide §5，logic-gates §4）：对话后异步运行，不阻塞回复；开关关闭时零调用、零写入。
 * 顺序：补判积压 → F1 J1 抽取 → F5 证据 / TRADEOFF / 回答入账（先于分类：W3 的决定性裁决以已入账证据为准）
 *       → 逐个候选 F2 召回、F3 J2（成对缓存）、F4 分类入账。每个候选一笔事务（I6），互不拖累。
 * 判定不可用（§12）时只凭 sim 判 DUP，其余记 PENDING_JUDGE（上限 pendingCap，满则最旧者转 EXP），恢复后按时间补判。
 * 单次 J2 调不通（未到降级门槛）同样推迟，不按闸失败兜底 EXP：否则一次网络抖动就会留下永久的重复链头、漏记矛盾。
 * J2 答了但两次不合格仍按闸不通过兜底 EXP。
 */
import { getFlag, setFlag, clearFlag } from '../../kernel.js'
import { localDay } from '../../db.js'
import { canEmbed, embedText } from '../vector.js'
import { isEnabled } from './config.js'
import { append, newId, readEvents, ConflictError } from './ledger.js'
import { loadState, listHeads } from './projection.js'
import { theta } from './fold.js'
import { LAYERS, SIGMA_OPEN, isTerminal, isCoreKind } from './catalog.js'
import { call, cacheGet, cachePut, pairKey, judgeHealth } from './llm.js'
import { J2 } from './templates.js'
import { neighbors } from './sim.js'
import { classify, fieldCheck } from './gates.js'
import { noteAskSpoken } from './inject.js'

export const PENDING_CAP = 50
const DRAIN_MAX = 3 // 每次快环最多补判几条，控制花费
const HEADS_IN_J1 = 12
const TURNS_IN_J1 = 12
const TURN_CHARS = 600
const ROUNDS = 5
const IDLE_MS = 10 * 60 * 1000 // 10 分钟没新对话视为会话结束
const BUF_MAX = 40
const DAY = 86400000

// ---------- 嵌入（命题不可变，按 id 缓存） ----------
const VEC_CACHE = new Map()
export function dropVecCache() { VEC_CACHE.clear() }

function defaultEmbed() {
  if (!canEmbed()) return async () => null
  return (text) => embedText(text, 3000)
}

async function vecOf(embed, id, text) {
  if (id && VEC_CACHE.has(id)) return VEC_CACHE.get(id)
  let v = null
  try { v = await embed(text) } catch { v = null }
  if (!v || !v.length) return null
  const arr = Array.from(v)
  if (id) {
    VEC_CACHE.set(id, arr)
    if (VEC_CACHE.size > 4000) VEC_CACHE.delete(VEC_CACHE.keys().next().value)
  }
  return arr
}

// ---------- 读 ----------
const turnRef = (t, i, at) => 'turn:' + (t.ref || at + ':' + i)
const addDays = (at, d) => new Date(Date.parse(at) + d * DAY).toISOString()

function claimTexts(db, aid) {
  return Object.fromEntries(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text]))
}

function openInquiries(db, aid) {
  const evs = readEvents(db, aid, { types: ['INQUIRY'] })
  const answered = new Set(evs.map((e) => e.payload.answer_of).filter(Boolean))
  return evs.filter((e) => e.payload.question && !answered.has(e.id)).slice(-8).map((e) => ({ id: e.id, question: e.payload.question }))
}

/** 未结的 PENDING_JUDGE：没有任何事件在 refs 里指向它。 */
export function pendingList(db, aid) {
  const pend = readEvents(db, aid, { types: ['PENDING_JUDGE'] })
  if (!pend.length) return []
  const done = new Set()
  // 只扫这条积压之后的引用，不把更早的账本再解析一遍
  for (const r of db.prepare("SELECT refs_json FROM claim_events WHERE agent_id=? AND seq>? AND refs_json IS NOT NULL AND refs_json<>'[]'").all(aid, pend[0].seq)) {
    try { for (const id of JSON.parse(r.refs_json)) done.add(id) } catch { /* 坏行跳过 */ }
  }
  return pend.filter((e) => !done.has(e.id)).map((e) => ({ id: e.id, at: e.at, candidate: e.payload.candidate, verdicts: e.payload.verdicts || [] }))
}

function j1Input(c, turns) {
  const s = loadState(c.db, c.aid)
  const text = claimTexts(c.db, c.aid)
  const heads = {}
  for (const l of LAYERS) heads[l] = listHeads(c.db, c.aid, l).slice(0, HEADS_IN_J1).map((h) => ({ id: h.id, kind: h.kind, text: h.text }))
  const nuText = Object.fromEntries(c.db.prepare('SELECT id, expect FROM claim_predictions WHERE agent_id=?').all(c.aid).map((r) => [r.id, r.expect]))
  return {
    turns: turns.map((t, i) => ({ i, role: t.role, text: t.text })),
    heads,
    predictions: Object.values(s.nus).filter((n) => n.outcome === 'pending').slice(0, HEADS_IN_J1).map((n) => ({ id: n.id, claim_id: n.claim_id, expect: nuText[n.id] })),
    coexist: Object.values(s.kappas).filter((k) => k.sigma === 'coexist').map((k) => ({ id: k.id, layer: k.layer, pos: text[k.pos_id], neg: text[k.neg_id] })),
    inquiries: openInquiries(c.db, c.aid),
  }
}

// ---------- 写 ----------
function tryAppend(c, events, expect, rep) {
  try { return append(c.db, c.aid, events, expect) } catch (e) {
    rep.errors.push({ type: events[0].type, code: e.code || 'ERROR', msg: String(e.message || e) })
    return null
  }
}

/** 防灌输（§8.1）：同一用户对同一命题（含其 ν）本地日内已有 verdict → 不再计入。 */
function verdictToday(c, s, claimId) {
  const nus = Object.values(s.nus).filter((n) => n.claim_id === claimId).map((n) => n.id)
  const ids = [claimId, ...nus]
  const from = new Date(Date.parse(c.at) - 2 * DAY).toISOString()
  const rows = c.db.prepare(`SELECT at FROM claim_evidence WHERE agent_id=? AND kind='verdict' AND derived_from IS NULL AND at>=?
    AND target_id IN (${ids.map(() => '?').join(',')})`).all(c.aid, from, ...ids)
  return rows.some((r) => localDay(new Date(r.at)) === c.day)
}

/** F5 证据：只认用户回合的外部记录（I7）；目标须存在且非终态；同批去重。返回被用户裁决否定的命题 id（W3 用）。 */
function writeEvidence(c, turns, items, rep) {
  const s = loadState(c.db, c.aid)
  const seen = new Set()
  const verdicts = new Set()
  for (const x of items) {
    const t = turns[x.ref_turn]
    const nu = s.nus[x.target_id]
    const claim = nu ? s.claims[nu.claim_id] : s.claims[x.target_id]
    const live = claim && !isTerminal(claim.status) && (!nu || nu.outcome === 'pending')
    const key = [x.target_id, x.ref_turn, x.sign, x.kind].join('|')
    if (!t || t.role !== 'user' || !live || seen.has(key)) { rep.evidence.dropped++; continue }
    if (x.kind === 'verdict' && verdictToday(c, s, claim.id)) { rep.evidence.dropped++; rep.evidence.capped = (rep.evidence.capped || 0) + 1; continue }
    seen.add(key)
    const ev = {
      type: 'EVIDENCE', actor: x.kind === 'verdict' ? 'user' : 'sys', at: c.at,
      payload: { evidence: [{ kind: x.kind, target_type: nu ? 'nu' : 'claim', target_id: x.target_id, sign: x.sign, weight: theta(s, 'w_' + x.kind), ref: turnRef(t, x.ref_turn, c.at) }] },
    }
    if (tryAppend(c, [ev], null, rep)) {
      rep.evidence.written++
      if (!nu && x.kind === 'verdict' && x.sign < 0) verdicts.add(x.target_id)
    }
  }
  return verdicts
}

/**
 * V 层的取舍经 PRESSURE 喂给 L 层（logic-gates 生长序）：起点是这次偏向的那一极，
 * 终点是 L 层的 telos，没有就取 e 最高的活命题；同一对只连一条。
 */
function pressureEdge(s, k, lean, made) {
  if (k.layer !== 'V') return null
  const from = lean === 'neg' || lean === k.neg_id ? k.neg_id : k.pos_id
  const to = Object.values(s.claims).filter((x) => x.layer === 'L' && x.status === 'active')
    .sort((a, b) => Number(isCoreKind('L', b.kind)) - Number(isCoreKind('L', a.kind)) || b.e - a.e)[0]
  if (!to) return null
  const key = from + '>' + to.id
  if (made.has(key) || Object.values(s.edges).some((e) => e.active && e.type === 'PRESSURE' && e.from_id === from && e.to_id === to.id)) return null
  made.add(key)
  return { type: 'PRESSURE', from_id: from, to_id: to.id }
}

function writeTradeoffs(c, turns, items, rep) {
  const s = loadState(c.db, c.aid)
  const seen = new Set()
  const made = new Set()
  for (const x of items) {
    const t = turns[x.ref_turn]
    const k = s.kappas[x.kappa_id]
    const key = x.kappa_id + '|' + x.ref_turn
    if (!t || t.role !== 'user' || !k || k.sigma !== 'coexist' || seen.has(key)) { rep.tradeoffs.dropped++; continue }
    seen.add(key)
    const ev = { type: 'TRADEOFF', layer: k.layer, actor: 'sys', at: c.at, payload: { kappa_id: k.id, lean_pole: x.lean_pole, cost: x.cost, ref: turnRef(t, x.ref_turn, c.at) } }
    const edge = pressureEdge(s, k, x.lean_pole, made)
    const batch = edge ? [ev, { type: 'EDGE_ADD', actor: 'sys', at: c.at, payload: { edges: [edge] } }] : [ev]
    if (tryAppend(c, batch, { kappas: { [k.id]: 'coexist' } }, rep)) {
      rep.tradeoffs.written++
      if (edge) rep.tradeoffs.pressure++
    }
  }
}

function writeAnswers(c, turns, items, open, rep) {
  const ids = new Set(open.map((q) => q.id))
  const seen = new Set()
  for (const x of items) {
    const t = turns[x.ref_turn]
    if (!t || t.role !== 'user' || !ids.has(x.inquiry_id) || seen.has(x.inquiry_id)) { rep.answers.dropped++; continue }
    seen.add(x.inquiry_id)
    const ev = { type: 'INQUIRY', actor: 'user', at: c.at, payload: { answer_of: x.inquiry_id, ref: turnRef(t, x.ref_turn, c.at) } }
    if (tryAppend(c, [ev], null, rep)) rep.answers.written++
  }
}

// 活性机制（L2 / L6 / L9）产出的候选保留来源，同样走 W1–W5（P14）
const LIVE_ORIGINS = ['probe', 'abduce']
const originOf = (x) => (LIVE_ORIGINS.includes(x.origin) ? x.origin : 'extract')

const pickCandidate = (x) => ({
  layer: x.layer, kind: x.kind, text: String(x.text).trim(), boundary: x.boundary || [], q_hint: x.q_hint || null, nu: x.nu || [],
  ...(LIVE_ORIGINS.includes(x.origin) ? { origin: x.origin } : {}),
})

function claimEvents(c, x, type, extra = {}) {
  const at = c.at
  const id = newId('claims', at)
  const claim = { id, layer: x.layer, kind: x.kind, text: x.text, origin: originOf(x), boundary: x.boundary, pred: extra.pred || [] }
  const head = { type, layer: x.layer, actor: 'sys', at, refs: extra.refs || [], gate_report: extra.gate || null, payload: { claims: [claim], q_hint: x.q_hint || null, ...(extra.payload || {}) } }
  const tail = x.nu && x.nu.length
    ? [{ type: 'NU_REGISTER', actor: 'sys', at, payload: { nus: x.nu.map((n) => ({ claim_id: id, expect: n.expect, observe: n.observe, p: n.p, due_at: addDays(at, n.due_days) })) } }]
    : []
  return { id, head, tail }
}

function writePending(c, x, out, verdicts, refs, rep) {
  const pend = pendingList(c.db, c.aid)
  while (pend.length >= c.pendingCap) {
    const old = pend.shift()
    // 溢出转 EXP 也不能跳过 W1：积压里蹲着的若是画像总结，到这里又变成一条「人生观」
    const why = fieldCheck(old.candidate)
    if (why) {
      append(c.db, c.aid, [{
        type: 'REJECT', actor: 'sys', at: c.at, refs: [old.id], gate_report: { w: 'W1', reason: why },
        payload: { text: String(old.candidate && old.candidate.text || '').slice(0, 300), layer: 'L' },
      }])
      rep.pending.overflow++
      continue
    }
    const { head, tail } = claimEvents(c, old.candidate, 'CLAIM_EXP', { refs: [old.id], gate: { w: 'W5', reason: 'PENDING_JUDGE 溢出，转 EXP' } })
    append(c.db, c.aid, [head, ...tail])
    rep.pending.overflow++
  }
  append(c.db, c.aid, [{
    type: 'PENDING_JUDGE', actor: 'sys', at: c.at, refs, gate_report: out.report,
    payload: { candidate: pickCandidate(x), verdicts: [...verdicts] },
  }])
  return {}
}

function writeClass(c, s, x, out, verdicts, refs, rep) {
  const gate = out.report
  switch (out.cls) {
    case 'REJECT':
      append(c.db, c.aid, [{
        type: 'REJECT', actor: 'sys', at: c.at, refs, gate_report: gate,
        payload: { text: String(x && x.text != null ? x.text : '').slice(0, 300), layer: x && x.layer != null ? String(x.layer).slice(0, 8) : null, kind: x && x.kind != null ? String(x.kind).slice(0, 20) : null },
      }])
      return {}
    case 'DUP':
      append(c.db, c.aid, [{ type: 'DUP', layer: x.layer, actor: 'sys', at: c.at, refs, gate_report: gate, payload: { claim_id: out.target, text: x.text } }],
        { claims: { [out.target]: s.claims[out.target].status } })
      return { target: out.target }
    case 'PENDING':
      return writePending(c, x, out, verdicts, refs, rep)
    case 'REV': {
      const { id, head, tail } = claimEvents(c, x, 'REV', { refs, gate, pred: [out.target], payload: { old_id: out.target } })
      const expect = { claims: { [out.target]: 'active' }, kappas: {} }
      const close = []
      for (const k of Object.values(s.kappas)) {
        if (!SIGMA_OPEN.includes(k.sigma) || (k.pos_id !== out.target && k.neg_id !== out.target)) continue
        expect.kappas[k.id] = k.sigma
        close.push({ type: 'KAPPA_OBSOLETE', layer: x.layer, actor: 'sys', at: c.at, payload: { kappa_id: k.id, reason: '一极被 REV 替换' } })
      }
      append(c.db, c.aid, [head, ...close, ...tail], expect)
      return { id, target: out.target }
    }
    default: { // EXP / OPEN
      const { id, head, tail } = claimEvents(c, x, 'CLAIM_EXP', { refs, gate })
      const cand = out.cls === 'OPEN'
        ? out.targets.map((t) => ({ type: 'KAPPA_CANDIDATE', layer: x.layer, actor: 'sys', at: c.at, payload: { a_id: t, b_id: id } }))
        : []
      append(c.db, c.aid, [head, ...cand, ...tail])
      return out.cls === 'OPEN' ? { id, targets: out.targets } : { id }
    }
  }
}

// ---------- F2 / F3 / F4 ----------
async function judgePairs(c, x, N, texts, rep) {
  const key = (id) => pairKey(J2.tag, 'x:' + x.layer + ':' + x.text, id)
  const rel = {}
  const todo = []
  for (const n of N) {
    const hit = cacheGet(c.db, key(n.id))
    if (hit && hit.rel) rel[n.id] = hit.rel
    else todo.push(n)
  }
  if (!todo.length) return { ok: true, rel }
  const r = await call(c, 'J2', { layer: x.layer, text: x.text, neighbors: todo.map((n) => ({ id: n.id, text: texts[n.id] })) })
  if (!r.ok && r.code === 'BUDGET') return { defer: 'budget' }
  rep.calls.J2++
  // 调不通（网络 / 超时）是「判定不可用」，推迟补判；答了但两次不合格才算闸不通过
  if (!r.ok && r.code === 'CALL') return { defer: 'judge_unavailable' }
  if (!r.ok) return { ok: false }
  for (const p of r.out.pairs) {
    rel[p.c_id] = p.rel
    cachePut(c.db, key(p.c_id), J2.tag, { rel: p.rel, reason: p.reason || null }, c.at, c.aid)
  }
  return { ok: true, rel }
}

/** W3 的决定性外部证据：ℓ≠V 认用户裁决或 c 的 ν miss；ℓ=V 只认 ν miss。 */
function decisive(s, c, verdicts, layer) {
  const miss = Object.values(s.nus).some((n) => n.claim_id === c.id && n.outcome === 'miss')
  return layer === 'V' ? miss : miss || verdicts.has(c.id)
}

async function placeCandidate(c, x, verdicts, rep, refs, opt = {}) {
  const s = loadState(c.db, c.aid)
  let N = []
  let rel = null
  let judge = 'ok'
  let simMode = null
  if (!fieldCheck(x)) {
    const heads = listHeads(c.db, c.aid, x.layer)
    const xv = await vecOf(c.embed, null, x.text)
    const hv = []
    for (const h of heads) hv.push({ id: h.id, text: h.text, vec: xv ? await vecOf(c.embed, h.id, h.text) : null })
    const nb = neighbors({ text: x.text, vec: xv }, hv, { theta_rel: theta(s, 'theta_rel'), theta_rel_lex: theta(s, 'theta_rel_lex'), N_nb: theta(s, 'N_nb') })
    simMode = nb.mode
    // 等嵌入期间别处可能写入了新命题：只认读快照时已有的
    N = nb.list.filter((n) => s.claims[n.id]).map((n) => ({ ...n, status: s.claims[n.id].status, kind: s.claims[n.id].kind, layer: x.layer }))
    if (N.length) {
      if (judgeHealth(c.db, c.aid, Date.parse(c.at)).degraded) judge = 'degraded'
      else {
        const j = await judgePairs(c, x, N, Object.fromEntries(heads.map((h) => [h.id, h.text])), rep)
        if (j.defer) judge = j.defer
        else if (!j.ok) judge = 'failed'
        else rel = j.rel
      }
    }
  }
  const out = judge === 'budget' || judge === 'judge_unavailable'
    ? { cls: 'PENDING', report: { w: 'PENDING', judge, sim_mode: simMode, neighbors: N.map((n) => ({ id: n.id, sim: +n.sim.toFixed(4) })), reason: judge } }
    : classify(x, N, rel, { theta_dup: theta(s, 'theta_dup'), theta_dup_lex: theta(s, 'theta_dup_lex'), judge, sim_mode: simMode, decisive: (cc) => decisive(s, cc, verdicts, x.layer) })
  const item = { cls: out.cls, w: out.report.w, judge, ...(out.report.reason ? { reason: out.report.reason } : {}) }
  if (out.cls === 'PENDING' && opt.noPending) return { ...item, skipped: true }
  try {
    return { ...item, ...writeClass(c, s, x, out, verdicts, refs, rep) }
  } catch (e) {
    // 读快照到写入之间投影变了（I5）：重读再分一次
    if (e instanceof ConflictError && e.code === 'EXPECT' && !opt.retried) return placeCandidate(c, x, verdicts, rep, refs, { ...opt, retried: true })
    rep.errors.push({ type: out.cls, code: e.code || 'ERROR', msg: String(e.message || e) })
    return { ...item, cls: 'ERROR' }
  }
}

async function drainPending(c, rep) {
  const pend = pendingList(c.db, c.aid)
  if (!pend.length || judgeHealth(c.db, c.aid, Date.parse(c.at)).degraded) return
  for (const p of pend.slice(0, DRAIN_MAX)) {
    const r = await placeCandidate(c, p.candidate, new Set(p.verdicts), rep, [p.id], { noPending: true })
    if (r.skipped) break
    rep.pending.drained++
  }
}

/** 单个候选走 F2–F4（活性机制用）。ctx = { db, aid, at, chat?, embed? }；refs 指向产出它的事件。 */
export async function placeOne(ctx, x, refs = []) {
  const c = { ...ctx, day: ctx.day || localDay(new Date(ctx.at)), embed: ctx.embed || defaultEmbed(), pendingCap: ctx.pendingCap || PENDING_CAP }
  const rep = { errors: [], calls: { J1: 0, J2: 0 }, pending: { drained: 0, overflow: 0 } }
  const r = await placeCandidate(c, x, new Set(), rep, refs)
  return { ...r, errors: rep.errors }
}

function cleanTurns(turns) {
  return (Array.isArray(turns) ? turns : [])
    .filter((t) => t && String(t.text || '').trim())
    .slice(-TURNS_IN_J1)
    .map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', text: String(t.text).trim().slice(0, TURN_CHARS), ref: t.ref || null }))
}

/**
 * 跑一次快环。ctx = { db, aid, at, day?, chat?, embed?, pendingCap? }；turns = [{ role, text, ref? }]。
 * 返回 { status: off|skipped|deferred|done, items[], evidence, tradeoffs, answers, pending, errors[], calls }。
 */
export async function runFast(ctx, turns) {
  if (!isEnabled(ctx.db, ctx.aid)) return { status: 'off' }
  const c = { ...ctx, day: ctx.day || localDay(new Date(ctx.at)), embed: ctx.embed || defaultEmbed(), pendingCap: ctx.pendingCap || PENDING_CAP }
  const rep = {
    status: 'done', items: [], errors: [], calls: { J1: 0, J2: 0 },
    evidence: { written: 0, dropped: 0 }, tradeoffs: { written: 0, dropped: 0, pressure: 0 }, answers: { written: 0, dropped: 0 }, pending: { drained: 0, overflow: 0 },
  }
  await drainPending(c, rep)
  try {
    const intake = await import('./intake.js')
    intake.intakeNotices(c.db, c.aid)
    intake.intakeActs(c.db, c.aid, c.at)
    for (const x of intake.intakeCandidates(c.db, c.aid)) {
      await placeOne(c, { layer: x.layer, kind: x.kind, text: x.text }, [x.ref])
    }
  } catch (e) {
    rep.errors.push({ type: 'INTAKE', code: 'ERROR', msg: String(e && e.message || e) })
  }
  const list = cleanTurns(turns)
  if (!list.length) return { ...rep, status: 'skipped', reason: 'empty' }
  const input = j1Input(c, list)
  const r1 = await call(c, 'J1', input)
  if (!(!r1.ok && r1.code === 'BUDGET')) rep.calls.J1++
  if (!r1.ok) return { ...rep, status: 'deferred', reason: r1.code }
  const verdicts = writeEvidence(c, list, r1.out.evidence, rep)
  writeTradeoffs(c, list, r1.out.tradeoffs, rep)
  writeAnswers(c, list, r1.out.answers, input.inquiries, rep)
  for (const x of r1.out.candidates) rep.items.push(await placeCandidate(c, x, verdicts, rep, []))
  return rep
}

// ---------- 对话后挂点：缓冲 + 每 5 轮或会话空闲触发 ----------
const bufKey = (aid) => 'sangguan.fast.buf:' + aid
const TIMERS = new Map()

/**
 * 价值进料在后台跑：模块级待办集合，失败吞掉。
 * drainValues() 只给测试/夜巡用——等它们落地再断言，不用 sleep 猜。
 */
const VALUE_PENDING = new Set()
function trackValueIngest(db, aid, at, userText) {
  const p = import('./values_intake.js')
    .then((m) => m.ingestValues(db, aid, at, { user: userText }))
    .catch(() => null)
    .finally(() => { VALUE_PENDING.delete(p) })
  VALUE_PENDING.add(p)
  return p
}
export async function drainValues() {
  while (VALUE_PENDING.size) {
    await Promise.all([...VALUE_PENDING])
  }
}
const RUNNING = new Set()

export function bufferOf(db, aid) {
  try {
    const b = JSON.parse(getFlag(db, bufKey(aid)) || 'null')
    if (b && Array.isArray(b.turns)) return { rounds: 0, ...b }
  } catch { /* 坏缓冲当空 */ }
  return { turns: [], rounds: 0 }
}

/** 系统回合：只描述发生了什么，不带结论。同一 ref 只进一次。不增加轮数，也不新开冷却。 */
export function noteSystem(db, aid, text, ref) {
  if (!isEnabled(db, aid)) return false
  const s = String(text || '').trim()
  if (!s) return false
  const b = bufferOf(db, aid)
  const id = ref || ('sys:' + s.slice(0, 40))
  if (b.turns.some((t) => t.ref === id)) return false
  b.turns.push({ role: 'system', text: s.slice(0, TURN_CHARS), ref: id })
  if (b.turns.length > BUF_MAX) b.turns = b.turns.slice(-BUF_MAX)
  setFlag(db, bufKey(aid), JSON.stringify(b))
  return true
}

function schedule(db, aid, ms, opt) {
  const old = TIMERS.get(aid)
  if (old) clearTimeout(old)
  const t = setTimeout(() => {
    TIMERS.delete(aid)
    flushFast(db, aid, opt).catch(() => { /* 快环失败不影响对话 */ })
  }, ms)
  if (t.unref) t.unref()
  TIMERS.set(aid, t)
}

/**
 * 每轮对话提交后调用（同步、只写一条 flags）。开关关闭返回 false，不写任何东西。
 * turn = { user, assistant, sid, at }；opt.schedule=false 时只入缓冲不排定时器（测试用）。
 */
export function afterTurn(db, aid, turn, opt = {}) {
  if (!isEnabled(db, aid)) return false
  const at = turn.at || new Date().toISOString()
  const b = bufferOf(db, aid)
  for (const [role, text] of [['user', turn.user], ['assistant', turn.assistant]]) {
    const s = String(text || '').trim()
    if (s) b.turns.push({ role, text: s.slice(0, TURN_CHARS), ref: (turn.sid || 's') + ':' + at + ':' + role })
  }
  b.rounds += 1
  if (b.turns.length > BUF_MAX) b.turns = b.turns.slice(-BUF_MAX)
  setFlag(db, bufKey(aid), JSON.stringify(b))
  if (turn.assistant) noteAskSpoken(db, aid, turn.assistant)
  const due = b.rounds >= ROUNDS
  if (opt.schedule !== false) schedule(db, aid, due ? 0 : IDLE_MS, opt)
  return { due, rounds: b.rounds, turns: b.turns.length }
}

function addNum(into, extra) {
  for (const [k, v] of Object.entries(extra || {})) if (typeof v === 'number') into[k] = (into[k] || 0) + v
}

/** 多窗口的结果并成一份：条数、调用、写入都累加。 */
function mergeRep(into, r) {
  if (!into) {
    return { ...r, windows: 1, items: [...(r.items || [])], errors: [...(r.errors || [])], calls: { ...(r.calls || {}) } }
  }
  into.items.push(...(r.items || []))
  into.errors.push(...(r.errors || []))
  addNum(into.calls, r.calls)
  addNum(into.evidence, r.evidence)
  addNum(into.tradeoffs, r.tradeoffs)
  addNum(into.answers, r.answers)
  addNum(into.pending, r.pending)
  into.windows++
  return into
}

/** 只摘掉这一窗已经交给抽取的回合；处理期间新进来的留在缓冲里。 */
function dropConsumed(turns, window) {
  const rest = turns.slice()
  for (const w of window) {
    const i = rest.findIndex((t) => t.ref === w.ref && t.role === w.role && t.text === w.text)
    if (i >= 0) rest.splice(i, 1)
  }
  return rest
}

/**
 * 把缓冲交给快环。从旧到新每次最多 12 条；这一窗抽取成功才从缓冲摘掉，
 * 延后则停手，没处理的回合原样留着。一次调用把排得上的窗口都跑完。
 */
export async function flushFast(db, aid, opt = {}) {
  if (RUNNING.has(aid)) return { status: 'busy' }
  RUNNING.add(aid)
  try {
    const buffered = bufferOf(db, aid)
    if (!buffered.turns.length) return { status: 'skipped', reason: 'empty' }
    const userText = (buffered.turns.filter((t) => t.role === 'user').pop() || {}).text || ''
    const at = opt.at || new Date().toISOString()
    const ctx = { db, aid, at, day: opt.day || localDay(new Date(at)), chat: opt.chat, embed: opt.embed }
    let merged = null
    for (let w = 0; w < 8; w++) {
      const window = bufferOf(db, aid).turns.slice(0, TURNS_IN_J1)
      if (!window.length) break
      const r = await runFast(ctx, window)
      if (r.status === 'deferred' || r.status === 'off') {
        if (!merged) return r
        merged.held = r.reason || r.status
        return merged
      }
      const rest = dropConsumed(bufferOf(db, aid).turns, window)
      if (rest.length) setFlag(db, bufKey(aid), JSON.stringify({ turns: rest, rounds: Math.ceil(rest.length / 2) }))
      else clearFlag(db, bufKey(aid))
      merged = mergeRep(merged, r)
    }
    // 价值进料：反思 / 日记 / 关系 / 缺口 / 用户原话 → 价值命题。
    // 不 await：快环不该被价值线拖慢；测试和夜巡用 drainValues() 等它落地。
    trackValueIngest(db, aid, at, userText)
    return merged
  } finally { RUNNING.delete(aid) }
}
