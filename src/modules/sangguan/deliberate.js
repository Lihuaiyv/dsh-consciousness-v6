/**
 * 审议（code-guide S5–S6，logic-gates §6 / §12）：plan 只读，commit 校验 expect 后写入。
 * 没预算整次推迟，不写 DELIBERATE。S6 起可走 SUB（J4/J5 + S 闸）。
 */
import { SIGMA_LOCK, BELT_KINDS } from './catalog.js'
import { KAPPA_CLOSED } from './machine.js'
import { theta } from './fold.js'
import { loadState } from './projection.js'
import { append, eventsOf as cachedEvents, newId } from './ledger.js'
import { call, getTemplate } from './llm.js'
import { canAfford } from './budget.js'
import { isEnabled } from './config.js'
import { jaccard } from './sim.js'
import { settleTrials } from './trial.js'
import { closeAround, vExceptionOf, tryRepair } from './practice.js'
import { precedentIndex, precedentFor } from './precedent.js'
import { elevOpenOf } from './elev.js'
import './templates.js'
import {
  novel, userWinner, actionSet, chooseBranch, prioOf, stakeOf, tierOf, subOK, coexOK, frozen, inhibit, sGates, decisive, probeBlocked,
} from './gates.js'

const DAY = 86400000
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY

function polesOf(s, k) {
  return { pos: s.claims[k.pos_id], neg: s.claims[k.neg_id] }
}

function thetaPack(s, layer, qId) {
  const scope = qId ? 'q:' + qId : '*'
  // 整数型 Θ 允许存小数（L5 慢调），用时一律取整
  return {
    n_min: Math.round(theta(s, 'n_min', layer, scope)),
    delta_pi: theta(s, 'delta_pi', layer, scope),
    lambda: theta(s, 'lambda', layer, scope),
    N_delib: Math.round(theta(s, 'N_delib', layer)),
    tau_age: theta(s, 'tau_age', layer),
    N_inhib: theta(s, 'N_inhib', layer),
    prior_SUSPEND: theta(s, 'prior_SUSPEND', layer),
    'prior_SUB.W': theta(s, 'prior_SUB.W', 'W'),
    'prior_SUB.L': theta(s, 'prior_SUB.L', 'L'),
    'prior_SUB.V': theta(s, 'prior_SUB.V', 'V'),
    'prior_COEX.L': theta(s, 'prior_COEX.L', 'L'),
    'prior_COEX.V': theta(s, 'prior_COEX.V', 'V'),
  }
}

/** 绑定到两极或其 ν 的证据事件（含 actor），供 Novel / n₇ / 用户裁决。 */
export function evidenceFor(db, aid, k, s) {
  const poles = new Set([k.pos_id, k.neg_id])
  const nus = new Set()
  for (const n of Object.values(s.nus)) if (poles.has(n.claim_id)) nus.add(n.id)
  const out = []
  for (const ev of cachedEvents(db, aid, 'EVIDENCE')) {
    for (const x of ev.payload.evidence || []) {
      const hit = (x.target_type === 'nu' && nus.has(x.target_id))
        || (x.target_type !== 'nu' && poles.has(x.target_id))
      if (hit) out.push({ ...x, actor: ev.actor, at: ev.at, seq: ev.seq, target_claim: x.target_type === 'nu' ? s.nus[x.target_id].claim_id : x.target_id })
    }
  }
  return out
}

function verdictPicks(layer, posId, negId, evs) {
  if (layer === 'V') return []
  const seen = new Set()
  const picks = []
  for (const x of evs) {
    if (x.kind !== 'verdict' || x.actor !== 'user') continue
    const day = String(x.at).slice(0, 10)
    const key = x.target_claim + '|' + day
    if (seen.has(key)) continue
    seen.add(key)
    if (x.target_claim === posId || x.target_claim === negId) picks.push({ claim_id: x.target_claim, sign: x.sign, day })
  }
  return picks
}

function lastDelibAt(db, aid, k) {
  if (!k.last_delib_seq) return null
  const evs = cachedEvents(db, aid, 'DELIBERATE')
  const hit = evs.find((e) => e.seq === k.last_delib_seq)
  return hit ? hit.at : null
}

const elevOpen = (db, aid, layer) => elevOpenOf(db, aid, layer)
// L3 惊奇加成：opt.sBoost 全局（测试），opt.sBoostMap 按 κ（夜间由 liveness.surpriseBoost 算好）
const boostOf = (opt, kid) => opt.sBoost || (opt.sBoostMap && opt.sBoostMap[kid]) || 1

function lockedByOther(s, k) {
  for (const o of Object.values(s.kappas)) {
    if (o.id === k.id || !SIGMA_LOCK.includes(o.sigma)) continue
    if (o.pos_id === k.pos_id || o.pos_id === k.neg_id || o.neg_id === k.pos_id || o.neg_id === k.neg_id) return true
  }
  return false
}

/** V 层例外；opt.judgedVx 时只认 [J] 归因过的（生产路径），opt.vxIds = { κ → 今夜 J12 点名的 x_id[] }。 */
function vxOf(db, aid, s, k, now, opt) {
  if (k.layer !== 'V') return { ok: true, ids: [] }
  if (opt.vException && opt.vException.ok !== undefined) return opt.vException
  const extra = (opt.vxIds && opt.vxIds[k.id]) || opt.vExceptionIds || []
  return vExceptionOf(s, k, cachedEvents(db, aid, 'EVIDENCE'), now, extra, { judged: !!opt.judgedVx })
}

function extrasSince(k, evs, opt, prec) {
  const after = k.last_delib_seq || 0
  return {
    evidence: evs.some((x) => x.seq > after),
    proposal: !!(opt && opt.proposal && opt.proposal.afterSeq > after),
    precedent: !!((opt && opt.newPrecedent) || (prec && prec.fresh)),
  }
}

/** R3：opt.P 显式给出时用它（测试）；opt.precedent === false 时冷启动（P ≡ 0）。 */
function precOf(db, aid, s, k, now, opt) {
  if (opt.P) return { P: opt.P, nBadSub: opt.nBadSub || 0, ids: opt.precedentIds || [], fresh: false, D: [] }
  if (opt.precedent === false) return { P: {}, nBadSub: opt.nBadSub || 0, ids: [], fresh: false, D: [] }
  const idx = opt.precIndex && opt.precIndex.now === now ? opt.precIndex : precedentIndex(db, aid, s, now)
  return precedentFor(s, k, idx, { sinceAt: k.last_delib_seq ? lastDelibAt(db, aid, k) : null })
}

/**
 * 只读：算出 A(κ)、b*、优先级、expect。不写账本、不调模型。
 * opt：proposal / j6 / P / nBadSub / sBoost / allowSub / allowCoex / vException
 */
export function plan(db, aid, kappaId, now, opt = {}) {
  const s = loadState(db, aid)
  const k = s.kappas[kappaId]
  if (!k) return { ok: false, reason: 'no_kappa' }
  if (KAPPA_CLOSED.includes(k.sigma)) return { ok: false, reason: 'closed' }
  const { pos, neg } = polesOf(s, k)
  if (!pos || !neg) return { ok: false, reason: 'missing_pole' }
  const th = thetaPack(s, k.layer, k.q_id)
  const evs = evidenceFor(db, aid, k, s)
  const prec = precOf(db, aid, s, k, now, opt)
  const extra = extrasSince(k, evs, opt, prec)
  const isNovel = novel(k, extra)
  const picks = verdictPicks(k.layer, pos.id, neg.id, evs)
  const winnerId = userWinner(k.layer, pos.id, neg.id, picks)
  const fr = frozen(k.layer, opt.elevOpen || elevOpen(db, aid, k.layer), pos, neg)
  const inh = inhibit(prec.nBadSub, th.N_inhib)
  const allowSub = opt.allowSub === true
  const allowCoex = opt.allowCoex === true
  const vx = vxOf(db, aid, s, k, now, opt)
  const sOk = allowSub && subOK(opt.proposal, opt.sGates, k.layer, vx.ok, fr, inh)
  const cOk = allowCoex && coexOK(k.layer, pos, neg, opt.j6)
  const A = actionSet(sOk, cOk)
  const chosen = chooseBranch(k.layer, pos, neg, A, th, { winnerId, P: prec.P })
  let branch = chosen.branch
  if (branch === 'SUB' && !allowSub) branch = 'SUSPEND'
  if (branch === 'COEX' && !allowCoex) branch = 'SUSPEND'
  const since = lastDelibAt(db, aid, k) || k.opened_at
  const age = Math.max(0, daysBetween(since, now))
  const weekAgo = new Date(Date.parse(now) - 7 * DAY).toISOString()
  const n7 = evs.filter((x) => x.at >= weekAgo && x.at <= now).length
  const sBoost = boostOf(opt, k.id)
  const prio = prioOf(pos, neg, n7, age, th.tau_age, sBoost)
  const stake = stakeOf(k.layer, pos, neg, sBoost)
  const expect = {
    kappas: { [k.id]: k.sigma },
    claims: { [pos.id]: pos.status, [neg.id]: neg.status },
  }
  const texts = Object.fromEntries(db.prepare('SELECT id, text, boundary_json FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r]))
  const qrow = k.q_id ? db.prepare('SELECT text FROM claim_questions WHERE id=?').get(k.q_id) : null
  const posText = (texts[pos.id] && texts[pos.id].text) || ''
  const negText = (texts[neg.id] && texts[neg.id].text) || ''
  const parseB = (r) => { try { return JSON.parse((r && r.boundary_json) || '[]') } catch { return [] } }
  const trySub = allowSub && !chosen.forced && !fr && !inh && (k.layer !== 'V' || vx.ok)
  const tryCoex = allowCoex && !chosen.forced && k.layer !== 'W'
  const calls = []
  if (trySub) {
    calls.push({
      id: 'J4', pool: 'mid', tier: 'T2',
      input: { layer: k.layer, q: (qrow && qrow.text) || '', pos: { id: pos.id, text: posText }, neg: { id: neg.id, text: negText } },
    })
  }
  if (tryCoex) {
    calls.push({
      id: 'J6', pool: 'mid', tier: 'T1',
      input: { layer: k.layer, q: (qrow && qrow.text) || '', pos: { id: pos.id, text: posText, pi: pos.pi }, neg: { id: neg.id, text: negText, pi: neg.pi } },
    })
  }
  return {
    ok: true, kappa_id: k.id, layer: k.layer, sigma: k.sigma, q_id: k.q_id, q_text: (qrow && qrow.text) || '',
    pos_id: pos.id, neg_id: neg.id, pos_text: posText, neg_text: negText,
    pos_boundary: parseB(texts[pos.id]), neg_boundary: parseB(texts[neg.id]),
    novel: isNovel, extra, A, branch, forced: chosen.forced, try_sub: trySub, try_coex: tryCoex,
    v_exception: vx,
    winner_id: chosen.winner.id, loser_id: chosen.loser.id,
    decisive: chosen.decisive, scores: chosen.scores,
    prio, stake, tier: tierOf(stake), n7, age, winner_user: winnerId,
    P: prec.P, precedent_ids: prec.ids, inhibit: inh, b_noprec: noPrec(k.layer, pos, neg, A, th, winnerId, chosen),
    expect, calls, at: now,
    report: {
      decisive: chosen.decisive, forced: chosen.forced, A, scores: chosen.scores,
      n_pos: pos.n, n_neg: neg.n, pi_pos: pos.pi, pi_neg: neg.pi,
      user_pick: winnerId, n7, age, prio, stake, novel: isNovel,
      precedent: { D: prec.D, n_bad_sub: prec.nBadSub, inhibit: inh, fresh: !!prec.fresh, sim_mode: prec.sim_mode || null },
    },
  }
}

/** R5：λ=0 时的选择（供 L5 评估先例是否改变了决定）。 */
function noPrec(layer, pos, neg, A, th, winnerId, chosen) {
  if (chosen.forced) return chosen.branch
  return chooseBranch(layer, pos, neg, A, th, { winnerId, P: {} }).branch
}

function eventsOf(plan, now, s) {
  const at = now || plan.at
  const evs = []
  if (plan.sigma === 'suspended' || plan.sigma === 'coexist') {
    evs.push({ type: 'REOPEN', layer: plan.layer, actor: 'sys', at, payload: { kappa_id: plan.kappa_id } })
  }
  evs.push({
    type: 'DELIBERATE', layer: plan.layer, actor: 'sys', at,
    payload: {
      kappa_id: plan.kappa_id, branch: plan.branch, A: plan.A, scores: plan.scores, prio: plan.prio, stake: plan.stake,
      b_noprec: plan.b_noprec || plan.branch, P: plan.P || {}, inhibit: !!plan.inhibit,
    },
    precedent_ids: plan.precedent_ids || [],
    gate_report: plan.report, expect: plan.expect,
  })
  if (plan.forced === 'CORE_CLASH') {
    evs.push({ type: 'CORE_CLASH', layer: plan.layer, actor: 'sys', at, payload: { kappa_id: plan.kappa_id } })
  }
  if (plan.forced === 'RESOLVE_CORE_BLOCKED') {
    evs.push({ type: 'RESOLVE_CORE_BLOCKED', layer: plan.layer, actor: 'sys', at, payload: { kappa_id: plan.kappa_id } })
  }
  if (plan.branch === 'RESOLVE') {
    evs.push({
      type: 'RESOLVE', layer: plan.layer, actor: 'sys', at,
      payload: { kappa_id: plan.kappa_id, winner_id: plan.winner_id, loser_id: plan.loser_id },
    })
    // P21：败方入终态时，同事务关掉仍挂着它的未结 κ
    if (s) {
      const pack = closeAround(s, [plan.loser_id], at, [plan.kappa_id])
      evs.push(...pack.evs)
      plan.expect = { ...plan.expect, kappas: { ...plan.expect.kappas, ...pack.expect } }
    }
  } else if (plan.branch === 'COEX' && plan.j6 && plan.j6.loss) {
    evs.push({
      type: 'COEX', layer: plan.layer, actor: 'sys', at,
      payload: { kappa_id: plan.kappa_id, loss: plan.j6.loss },
    })
  } else if (plan.branch === 'SUB' && plan.proposal) {
    const kind = (BELT_KINDS[plan.layer] || ['belt'])[0]
    const p = plan.proposal
    const cid = p.claim_id || newId('claims', at)
    evs.push({
      type: 'SUB_ACCEPT', layer: plan.layer, actor: 'judge', at,
      payload: {
        kappa_id: plan.kappa_id,
        claims: [{
          id: cid, layer: plan.layer, kind, text: p.text, origin: 'synth',
          pred: [plan.pos_id, plan.neg_id], q_id: plan.q_id, boundary: p.boundary || [],
        }],
        v_exception_ids: plan.layer === 'V' ? ((plan.v_exception && plan.v_exception.ids) || []) : undefined,
      },
      gate_report: { ...(p.s_report || {}), v_exception_ids: plan.layer === 'V' ? ((plan.v_exception && plan.v_exception.ids) || []) : undefined },
    })
    if (p.nu && p.nu.length) {
      evs.push({
        type: 'NU_REGISTER', actor: 'judge', at,
        payload: {
          nus: p.nu.map((n) => ({
            claim_id: cid, expect: n.expect, observe: n.observe, p: n.p,
            due_at: new Date(Date.parse(at) + n.due_days * DAY).toISOString(),
          })),
        },
      })
    }
  } else if (plan.branch === 'SUSPEND') {
    if (plan.rejected) {
      evs.push({
        type: 'SUB_REJECTED', layer: plan.layer, actor: 'sys', at,
        payload: { kappa_id: plan.kappa_id, failed: plan.rejected.failed, reason: plan.rejected.reason },
        gate_report: plan.rejected.report,
      })
    }
    evs.push({
      type: 'SUSPEND', layer: plan.layer, actor: 'sys', at,
      payload: { kappa_id: plan.kappa_id, missing: plan.forced ? plan.forced : (plan.rejected ? 'proposal' : 'evidence') },
    })
  }
  return evs
}

/**
 * 校验 expect 后写入。results 留给后续步骤把模型结果填进提案；S5 不用。
 * 返回 { ok, postponed, reason, ids }。
 */
export function commit(db, aid, plan, results, now) {
  if (!plan || !plan.ok) return { ok: false, reason: plan && plan.reason }
  if (!plan.novel) return { ok: false, reason: 'not_novel' }
  if (!['RESOLVE', 'SUSPEND', 'SUB', 'COEX'].includes(plan.branch)) {
    return { ok: false, reason: 'branch_not_allowed', branch: plan.branch }
  }
  if (plan.branch === 'SUB' && !plan.proposal) return { ok: false, reason: 'no_proposal' }
  if (plan.branch === 'COEX' && !(plan.j6 && plan.j6.loss)) return { ok: false, reason: 'no_loss' }
  if (plan.calls && plan.calls.length && results && results.postponed) {
    return { ok: false, postponed: true, reason: 'budget' }
  }
  const s = loadState(db, aid)
  const evs = eventsOf(plan, now || plan.at, s)
  const wr = append(db, aid, evs, plan.expect)
  return { ok: true, ids: wr.ids, seqs: wr.seqs, branch: plan.branch, kappa_id: plan.kappa_id }
}

async function ask(db, aid, now, ctx, c, plan) {
  return call({ db, aid, day: String(now).slice(0, 10), at: now, chat: ctx.chat }, c.id, c.input, {
    tier: c.tier || plan.tier, pool: c.pool || 'mid', floor: !!c.floor,
  })
}

/** 有模型调用时先 grant；BUDGET 则整次推迟，不写账本。J4/J5 失败则退回 SUSPEND。 */
export async function execute(db, aid, plan, now, ctx = {}) {
  if (!plan || !plan.ok) return { ok: false, reason: plan && plan.reason }
  if (!plan.novel) return { ok: false, reason: 'not_novel' }
  // 整条链先估一遍：放不下就整次推迟、一分不花（否则 J4 花了卡在 J5，次夜重来，紧预算下永远白烧）
  const chain = (plan.calls || []).map((c) => ({ tier: c.tier || plan.tier, pool: c.pool || 'mid', judge: !!(getTemplate(c.id) || {}).judge }))
  if ((plan.calls || []).some((c) => c.id === 'J4')) {
    const judges = plan.stake > 0.8 || plan.layer === 'V' ? 2 : 1
    for (let i = 0; i < judges; i++) chain.push({ tier: 'T1', pool: 'mid', judge: true })
  }
  if (chain.length && !canAfford(db, aid, String(now).slice(0, 10), chain)) return { ok: false, postponed: true, reason: 'budget' }
  const results = { outs: [] }
  let j4 = null
  let j6 = null
  let j4fail = null
  for (const c of plan.calls || []) {
    const r = await ask(db, aid, now, ctx, c, plan)
    if (!r.ok && r.code === 'BUDGET') return { ok: false, postponed: true, reason: 'budget' }
    results.outs.push(r)
    if (c.id === 'J4') {
      if (!r.ok) j4fail = r.code
      else j4 = r.out
    } else if (c.id === 'J6') {
      if (r.ok) j6 = r.out
    } else if (!r.ok) return { ok: false, reason: r.code, call: r }
  }
  if (j4fail && !plan.try_coex) {
    plan.branch = 'SUSPEND'
    plan.A = actionSet(false, false)
    plan.report = { ...plan.report, j4: j4fail }
    return commit(db, aid, plan, results, now)
  }
  if (j4 && plan.try_sub) {
    const j5in = {
      layer: plan.layer, q: plan.q_text, pos: plan.pos_text, neg: plan.neg_text,
      text: j4.text, kept_pos: j4.kept_pos, kept_neg: j4.kept_neg, dropped: j4.dropped, boundary: j4.boundary || [], nu: j4.nu || [],
    }
    const j5s = []
    let j5fail = null
    // §3.1：常规 / 重要档 1 位判官；stake > 0.8 或价值层例外要 2 位一致
    // 第二位对调两极和保留项，减轻「先出现的那边更容易过」的位置偏差
    const judges = plan.stake > 0.8 || plan.layer === 'V' ? 2 : 1
    for (let i = 0; i < judges; i++) {
      const view = i === 0 ? j5in : { ...j5in, pos: j5in.neg, neg: j5in.pos, kept_pos: j5in.kept_neg, kept_neg: j5in.kept_pos, swapped: true }
      const r = await ask(db, aid, now, ctx, { id: 'J5', input: { ...view, judge: i + 1 }, pool: 'mid', tier: 'T1' }, plan)
      if (!r.ok && r.code === 'BUDGET') return { ok: false, postponed: true, reason: 'budget' }
      results.outs.push(r)
      if (!r.ok) { j5fail = r.code; break }
      j5s.push(r.out)
    }
    if (j5fail && !plan.try_coex) {
      plan.branch = 'SUSPEND'
      plan.rejected = { failed: ['J5'], reason: j5fail, report: { J5: j5fail } }
      return commit(db, aid, plan, results, now)
    }
    if (!j5fail) {
      const st0 = loadState(db, aid)
      const gate = sGates(
        { ...j4, q_id: plan.q_id },
        { pos: { text: plan.pos_text, boundary: plan.pos_boundary }, neg: { text: plan.neg_text, boundary: plan.neg_boundary }, q_id: plan.q_id },
        j5s,
        { sim: jaccard, theta_dup: theta(st0, 'theta_dup'), degen: !!ctx.degen },
      )
      if (gate.ok) plan.proposal = { ...j4, s_report: gate.report }
      else plan.rejected = { failed: gate.failed, reason: 'S', report: gate.report }
    }
  }
  if (!plan.forced) {
    const st = loadState(db, aid)
    const pos = st.claims[plan.pos_id]
    const neg = st.claims[plan.neg_id]
    const sOk = !!plan.proposal && (plan.layer !== 'V' || (plan.v_exception && plan.v_exception.ok))
    const cOk = !!(j6 && pos && neg && coexOK(plan.layer, pos, neg, j6))
    plan.A = actionSet(sOk, cOk)
    if (sOk || cOk) {
      const th = thetaPack(st, plan.layer, plan.q_id)
      const chosen = chooseBranch(plan.layer, pos, neg, plan.A, th, { winnerId: plan.winner_user, P: plan.P || {} })
      if (!chosen.forced) {
        plan.branch = chosen.branch
        plan.scores = chosen.scores
        plan.b_noprec = noPrec(plan.layer, pos, neg, plan.A, th, plan.winner_user, chosen)
      }
    }
    if (plan.branch === 'COEX' && cOk) plan.j6 = j6
    else if (plan.branch === 'SUB' && !plan.proposal) {
      plan.branch = 'SUSPEND'
    } else if (plan.branch === 'COEX' && !cOk) {
      plan.branch = 'SUSPEND'
    } else if (plan.branch === 'SUB' && plan.proposal) {
      plan.report = { ...plan.report, s: plan.proposal.s_report, branch: 'SUB' }
    } else if (!plan.proposal && plan.rejected) {
      plan.branch = 'SUSPEND'
    }
  }
  return commit(db, aid, plan, results, now)
}

export function eligible(s, db, aid, now, opt = {}) {
  const out = []
  for (const k of Object.values(s.kappas)) {
    if (KAPPA_CLOSED.includes(k.sigma)) continue
    if (k.sigma === 'sub_trial') continue
    if (k.sigma === 'suspended' || k.sigma === 'coexist') {
      if (lockedByOther(s, k)) continue
    } else if (k.sigma !== 'struggle') continue
    const evs = evidenceFor(db, aid, k, s)
    const prec = k.last_delib_seq && k.sigma === 'suspended' ? precOf(db, aid, s, k, now, opt) : null
    if (!novel(k, extrasSince(k, evs, opt, prec))) continue
    const { pos, neg } = polesOf(s, k)
    if (!pos || !neg) continue
    const th = thetaPack(s, k.layer, k.q_id)
    // §2.2：并存只因 VException 或新的 Decisive 证据重开
    if (k.sigma === 'coexist') {
      const win = userWinner(k.layer, pos.id, neg.id, verdictPicks(k.layer, pos.id, neg.id, evs))
      const dec = !probeBlocked(pos, neg) && decisive(k.layer, pos, neg, th.n_min, th.delta_pi, win)
      if (!dec && !(k.layer === 'V' && vxOf(db, aid, s, k, now, opt).ok)) continue
    }
    const since = lastDelibAt(db, aid, k) || k.opened_at
    const age = Math.max(0, daysBetween(since, now))
    const weekAgo = new Date(Date.parse(now) - 7 * DAY).toISOString()
    const n7 = evs.filter((x) => x.at >= weekAgo && x.at <= now).length
    const prio = prioOf(pos, neg, n7, age, th.tau_age, boostOf(opt, k.id))
    out.push({ id: k.id, layer: k.layer, sigma: k.sigma, prio, opened_at: k.opened_at, n7, age })
  }
  out.sort((a, b) => b.prio - a.prio || a.opened_at.localeCompare(b.opened_at) || a.id.localeCompare(b.id))
  return out
}

/**
 * 夜间出队：有待审时至少 1 次，至多 N_delib。开关关闭直接返回。
 * 返回 { status, did[], postponed[], skipped[] }。
 */
export async function runNight(db, aid, now, opt = {}) {
  if (opt.requireEnabled !== false && !isEnabled(db, aid) && !opt.force) return { status: 'off' }
  const settled = opt.settle === false ? { did: [] } : settleTrials(db, aid, now)
  const s = loadState(db, aid)
  const thN = Math.round(theta(s, 'N_delib'))
  if (opt.precedent !== false && !opt.P) opt = { ...opt, precIndex: precedentIndex(db, aid, s, now) }
  const queue = eligible(s, db, aid, now, opt)
  const cap = Math.max(1, Math.min(thN, queue.length || 1))
  const take = []
  const did = []
  const postponed = []
  const skipped = []
  // 队首因预算推迟时继续往下找不花钱的审议（免得贵的 κ 堵住队首、便宜的永远轮不到）
  for (const item of queue) {
    if (did.length + skipped.length >= cap) break
    const p = plan(db, aid, item.id, now, opt)
    if (postponed.length && (p.calls || []).length) continue
    take.push(item)
    if (!p.ok || !p.novel) { skipped.push({ id: item.id, reason: p.reason || 'not_novel' }); continue }
    const r = await execute(db, aid, p, now, opt)
    if (r.postponed) postponed.push({ id: item.id, reason: r.reason })
    else if (r.ok) {
      did.push({ id: item.id, branch: r.branch, seqs: r.seqs, forced: p.forced || null })
      // §6.2：核心败方被挡下时，同一审议内起草保护带修补；失败记 REPAIR_FAILED
      if (p.forced === 'RESOLVE_CORE_BLOCKED' && opt.repair !== false) {
        const rep = await tryRepair(db, aid, p.loser_id, now, { ...opt, hits: [] })
        did[did.length - 1].repair = rep.ok ? 'ok' : rep.postponed ? 'postponed' : 'failed'
      }
    } else skipped.push({ id: item.id, reason: r.reason })
  }
  return { status: 'done', queue, take: take.map((x) => x.id), did, postponed, skipped, settled: settled.did, N_delib: thN }
}
