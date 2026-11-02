/**
 * 升维（纲领换代，logic-gates §9.2；code-guide W4）：E1 触发 → 辩证会（J20 正反 + J10 合者 + J11×2 判官，慢环池）
 * → E2 / E3 → E4。require_user：W 否、L / V 是（宪法，不可调）。
 * 审批走三观自己的账本：ELEV_PROPOSE 挂起 → 用户 approveElev（ELEV_COMMIT actor=user）或 rejectElev（ELEV_REJECTED）。
 * 不复用 selfmod 的 proposals：那里批准会扣令牌、占每日改动额度并写 rule_versions，与三观账本是两套事实来源。
 * 挂起期间 Frozen(ℓ)；超过 T_approve 视为拒绝；被拒后冷却 T_cool·2^(r−1)，上限 90 日（r = 本纪元被拒次数）。
 */
import { CORE_KIND, isCoreKind } from './catalog.js'
import { theta } from './fold.js'
import { loadState } from './projection.js'
import { append, newId, readEvents } from './ledger.js'
import { call } from './llm.js'
import { budgetSnapshot, UNITS } from './budget.js'
import { jaccard } from './sim.js'
import { eGates } from './gates.js'
import { closeAround, coreTargets, e1Ready, mOf, revOf } from './practice.js'
import { revisionBudget } from './revision.js'
import './templates.js'

const DAY = 86400000
export const REQUIRE_USER = Object.freeze({ W: false, L: true, V: true })
const COOL_MAX = 90
const ELEV_TYPES = ['ELEV_PROPOSE', 'ELEV_COMMIT', 'ELEV_REJECTED', 'ELEV_FAILED']

function elevEvents(db, aid) {
  return readEvents(db, aid, { types: ELEV_TYPES })
}

/** 每层现算：未结提案、本纪元被拒次数、冷却截止、最近一次失败。 */
export function elevStatus(s, evs, layer, now) {
  let open = null
  let epochSeq = 0
  let rejects = []
  let lastFail = null
  for (const e of evs) {
    if (e.layer !== layer) continue
    if (e.type === 'ELEV_PROPOSE') open = e
    else if (e.type === 'ELEV_COMMIT') { open = null; epochSeq = e.seq; rejects = []; lastFail = null }
    else if (e.type === 'ELEV_REJECTED') { if (open && e.payload.proposal_id === open.id) open = null; rejects.push(e) }
    else if (e.type === 'ELEV_FAILED') lastFail = e
  }
  const r = rejects.length
  const last = rejects[r - 1]
  if (!s) return { open, rejects: r, lastFail, epochSeq }
  const coolDays = r ? Math.min(COOL_MAX, theta(s, 'T_cool') * 2 ** (r - 1)) : 0
  const coolUntil = last ? new Date(Date.parse(last.at) + coolDays * DAY).toISOString() : null
  const due = open ? new Date(Date.parse(open.at) + theta(s, 'T_approve') * DAY).toISOString() : null
  return { open, rejects: r, coolUntil, cooling: !!(coolUntil && now < coolUntil), due, lastFail, epochSeq }
}

/** Frozen(ℓ) 的前一半：ℓ 有未结的 ELEV_PROPOSE。 */
export function elevOpenOf(db, aid, layer) {
  const evs = elevEvents(db, aid)
  return !!elevStatus(null, evs, layer, '').open
}

/** 挂起超过 T_approve：视为拒绝（零模型，夜间跑）。 */
export function elevTimeouts(db, aid, now) {
  const s = loadState(db, aid)
  const evs = elevEvents(db, aid)
  const did = []
  for (const layer of ['W', 'L', 'V']) {
    const st = elevStatus(s, evs, layer, now)
    if (!st.open || now < st.due) continue
    append(db, aid, [{ type: 'ELEV_REJECTED', layer, actor: 'sys', at: now, refs: [st.open.id], payload: { proposal_id: st.open.id, why: 'timeout' } }])
    did.push({ layer, proposal_id: st.open.id })
  }
  return { did }
}

function coreHeads(s, layer) {
  return Object.values(s.claims).filter((c) => c.layer === layer && isCoreKind(layer, c.kind) && c.status !== 'demoted' && !['superseded', 'falsified', 'sublated', 'withdrawn'].includes(c.status))
}

/** 选被对象化的旧核：两核相撞取 π 较低者，否则取本层 π 最低（同分取最老）的核心。 */
function pickOldCore(s, layer, e1) {
  const cores = coreHeads(s, layer)
  if (!cores.length) return null
  let pool = cores
  if (e1.clash && e1.clashKappa) {
    const k = s.kappas[e1.clashKappa]
    const both = cores.filter((c) => k && (c.id === k.pos_id || c.id === k.neg_id))
    if (both.length) pool = both
  }
  return [...pool].sort((a, b) => a.pi - b.pi || a.born_seq - b.born_seq)[0]
}

function epochHits(s, evs, layer, coreId, epochSeq) {
  const ids = []
  for (const e of evs) {
    if (e.type !== 'NU_RESOLVE' || e.seq <= epochSeq || e.payload.outcome !== 'hit') continue
    const n = s.nus[e.payload.nu_id]
    if (n && n.claim_id === coreId) ids.push(n.id)
  }
  return ids
}

function epochMisses(s, evs, layer, epochSeq) {
  const targets = coreTargets(s, layer)
  const nuClaim = {}
  for (const n of Object.values(s.nus)) nuClaim[n.id] = n.claim_id
  const out = []
  for (const e of evs) {
    if (e.type !== 'EVIDENCE' || e.seq <= epochSeq) continue
    for (const x of e.payload.evidence || []) {
      const cid = x.target_type === 'nu' ? nuClaim[x.target_id] : x.target_id
      if (x.sign < 0 && targets.has(cid)) out.push({ id: x.id, target_id: cid, kind: x.kind })
    }
  }
  return out.slice(-12)
}

/** ELEV_COMMIT 一笔：旧核 demoted（带 scope）、新核 active、新 ν、挂着旧核的未结 κ 关闭、1 跳 DEPENDS 写 REVIEW_FLAG。 */
function commitBatch(s, layer, prop, at, actor) {
  const p = prop.payload
  const cid = newId('claims', at)
  const evs = [{
    type: 'ELEV_COMMIT', layer, actor, at, refs: prop.id ? [prop.id] : [],
    payload: {
      proposal_id: prop.id, old_core_id: p.old_core_id, scope: p.scope, meta: p.meta,
      claims: [{ id: cid, layer, kind: CORE_KIND[layer], text: p.new_core, origin: 'elev', pred: [p.old_core_id] }],
    },
  }]
  if ((p.nu || []).length) {
    evs.push({
      type: 'NU_REGISTER', actor: 'judge', at,
      payload: { nus: p.nu.map((n) => ({ claim_id: cid, expect: n.expect, observe: n.observe, p: n.p, due_at: new Date(Date.parse(at) + n.due_days * DAY).toISOString() })) },
    })
  }
  const pack = closeAround(s, [p.old_core_id], at)
  evs.push(...pack.evs)
  return { evs, expect: { claims: { [p.old_core_id]: 'active' }, kappas: pack.expect }, new_core_id: cid }
}

function proposalOf(db, aid, id) {
  return elevEvents(db, aid).find((e) => e.id === id && e.type === 'ELEV_PROPOSE') || null
}

/** 用户批准（E4）：提案仍未结、旧核仍是 active 链头才提交；旧核正在交锋则返回 locked，可稍后再批。 */
export function approveElev(db, aid, proposalId, now) {
  const prop = proposalOf(db, aid, proposalId)
  if (!prop) return { ok: false, reason: 'no_proposal' }
  const s = loadState(db, aid)
  const st = elevStatus(s, elevEvents(db, aid), prop.layer, now)
  if (!st.open || st.open.id !== proposalId) return { ok: false, reason: 'closed' }
  const old = s.claims[prop.payload.old_core_id]
  if (!old || old.status !== 'active') return { ok: false, reason: old && old.status === 'contested' ? 'locked' : 'stale' }
  // 换核心的额度：30 天一次，改了就别再改
  if (!revisionBudget(db, aid, prop.layer, now).core_ok) return { ok: false, reason: 'budget' }
  const b = commitBatch(s, prop.layer, prop, now, 'user')
  const wr = append(db, aid, b.evs, b.expect)
  return { ok: true, new_core_id: b.new_core_id, seqs: wr.seqs }
}

export function rejectElev(db, aid, proposalId, now, reason = '') {
  const prop = proposalOf(db, aid, proposalId)
  if (!prop) return { ok: false, reason: 'no_proposal' }
  const st = elevStatus(loadState(db, aid), elevEvents(db, aid), prop.layer, now)
  if (!st.open || st.open.id !== proposalId) return { ok: false, reason: 'closed' }
  append(db, aid, [{ type: 'ELEV_REJECTED', layer: prop.layer, actor: 'user', at: now, refs: [proposalId], payload: { proposal_id: proposalId, why: 'user', reason: String(reason).slice(0, 300) } }])
  return { ok: true }
}

/** 未结提案列表（给接口 / 三观页用）。 */
export function pendingElev(db, aid, now) {
  const s = loadState(db, aid)
  const evs = elevEvents(db, aid)
  return ['W', 'L', 'V'].map((l) => elevStatus(s, evs, l, now)).filter((x) => x.open)
    .map((x) => ({ id: x.open.id, layer: x.open.layer, at: x.open.at, due: x.due, ...x.open.payload }))
}

function fail(db, aid, layer, now, why, mark, report) {
  append(db, aid, [{ type: 'ELEV_FAILED', layer, actor: 'sys', at: now, gate_report: report || {}, payload: { why, ...mark } }])
  return { layer, failed: why }
}

/**
 * W4：逐层判 E1，开辩证会。没预算 → 推迟（不写任何事件、不花部分额度）。
 * opt：{ chat, layers?, degraded? }；降级模式暂停 E。
 */
export async function runElev(db, aid, now, opt = {}) {
  const did = []
  const skipped = []
  if (opt.degraded) return { did, skipped: [{ reason: 'degraded' }] }
  for (const layer of opt.layers || ['W', 'L', 'V']) {
    const s = loadState(db, aid)
    const all = readEvents(db, aid)
    const st = elevStatus(s, all.filter((e) => ELEV_TYPES.includes(e.type)), layer, now)
    if (st.open) { skipped.push({ layer, reason: 'pending' }); continue }
    if (st.cooling) { skipped.push({ layer, reason: 'cooling', until: st.coolUntil }); continue }
    const e1 = e1Ready(s, all, layer, now)
    if (!e1.ready) { skipped.push({ layer, reason: 'not_ready' }); continue }
    const revs = revOf(s, all, layer).length
    const m = mOf(s, layer, all)
    const mark = { m, revs, clash: !!e1.clash }
    // E2/E3 失败后保持退化：只有 m 或修订数增加（有新输入）才重开辩证会
    if (st.lastFail && m <= (st.lastFail.payload.m || 0) && revs <= (st.lastFail.payload.revs || 0) && !(e1.clash && !st.lastFail.payload.clash)) {
      skipped.push({ layer, reason: 'no_novel' }); continue
    }
    const old = pickOldCore(s, layer, e1)
    if (!old) { skipped.push({ layer, reason: 'no_core' }); continue }
    if (old.status !== 'active') { skipped.push({ layer, reason: 'locked' }); continue }
    const snap = budgetSnapshot(db, aid, String(now).slice(0, 10))
    if (snap.pools.slow.left < UNITS.DIAL) { skipped.push({ layer, reason: 'budget', postponed: true }); continue }
    const texts = new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
    const cores = coreHeads(s, layer).map((c) => ({ id: c.id, text: texts.get(c.id) || '', pi: c.pi }))
    const hits = epochHits(s, all, layer, old.id, st.epochSeq)
    const misses = epochMisses(s, all, layer, st.epochSeq)
    const ctx = { db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat }
    const base = { layer, old_core: { id: old.id, text: texts.get(old.id) || '' }, hits: hits.map((id) => ({ id })), misses, m, trigger: e1.clash ? 'core_clash' : 'degenerate' }
    // 正反两方；任一方调不通就不带辩论直接起草（退回重要档）
    const debate = {}
    let postponed = false
    for (const side of ['keep', 'change']) {
      const r = await call(ctx, 'J20', { ...base, side }, { pool: 'slow' })
      if (!r.ok && r.code === 'BUDGET') { postponed = true; break }
      if (r.ok) debate[side] = r.out
    }
    if (postponed) { skipped.push({ layer, reason: 'budget', postponed: true }); continue }
    const d = await call(ctx, 'J10', { ...base, cores, debate }, { pool: 'slow' })
    if (!d.ok && d.code === 'BUDGET') { skipped.push({ layer, reason: 'budget', postponed: true }); continue }
    if (!d.ok) { did.push(fail(db, aid, layer, now, 'J10:' + d.code, mark)); continue }
    const draft = d.out
    const j11s = []
    let jfail = null
    for (let i = 0; i < 2; i++) {
      // 第二位把命中预见倒序，避免总是先看到第一条就下判
      const hits = i === 0 ? base.hits : [...base.hits].reverse()
      const r = await call(ctx, 'J11', { layer, old_core: base.old_core, hits, draft, judge: i + 1, ...(i === 1 ? { reversed: true } : {}) }, { pool: 'slow' })
      if (!r.ok) { jfail = r.code; break }
      j11s.push(r.out)
    }
    if (jfail === 'BUDGET') { skipped.push({ layer, reason: 'budget', postponed: true }); continue }
    const gate = eGates(draft, { cores, hits, sim: jaccard, theta_dup: theta(s, 'theta_dup') }, jfail ? [] : j11s)
    if (jfail) gate.report.J11 = jfail
    if (!gate.ok || jfail) { did.push(fail(db, aid, layer, now, 'E:' + (jfail ? 'J11' : gate.failed.join(',')), mark, gate.report)); continue }
    const at = now
    const propose = {
      type: 'ELEV_PROPOSE', layer, actor: 'judge', at, gate_report: { ...gate.report, E1: e1, require_user: REQUIRE_USER[layer] },
      payload: { old_core_id: draft.old_core_id, scope: draft.scope, meta: draft.meta, new_core: draft.new_core, mapping: draft.mapping, nu: draft.nu, debate, trigger: base.trigger, ...mark },
    }
    if (REQUIRE_USER[layer]) {
      const wr = append(db, aid, [propose], { claims: { [old.id]: 'active' } })
      did.push({ layer, proposed: wr.ids[0] })
      continue
    }
    // W 层不需用户：E4 直接原子写 ELEV_COMMIT，闸门报告随提交留档
    const b = commitBatch(s, layer, { id: null, payload: propose.payload }, at, 'judge')
    b.evs[0].gate_report = propose.gate_report
    append(db, aid, b.evs, b.expect)
    did.push({ layer, committed: b.new_core_id })
  }
  return { did, skipped }
}
