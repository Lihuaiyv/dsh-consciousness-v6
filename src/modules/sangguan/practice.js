/**
 * 实践回流（logic-gates §8 / §9.1）：ν 到期检验、π 已在 fold、CON、m(ℓ)、Rev/Bad/Degen、J8 修补。
 * 时间一律由 now 传入；模型走 llm.js。
 */
import { LAYERS, isCoreKind, isTerminal, SIGMA_OPEN, BELT_KINDS } from './catalog.js'
import { theta } from './fold.js'
import { settleMiss } from './pledge.js'
import { loadState } from './projection.js'
import { append, newId, readEvents } from './ledger.js'
import { call } from './llm.js'
import { isEnabled } from './config.js'
import './templates.js'

const DAY = 86400000
const addDays = (at, d) => new Date(Date.parse(at) + d * DAY).toISOString()

function textsOf(db, aid) {
  return Object.fromEntries(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text]))
}

function evList(db, aid, types) {
  return readEvents(db, aid, types ? { types } : undefined)
}

/** 1 跳 DEPENDS 指向即将终态的命题 → REVIEW_FLAG（不递归）。 */
export function flagsForTerminal(s, ids, at) {
  const dead = new Set(ids)
  const out = []
  const seen = new Set()
  for (const e of Object.values(s.edges)) {
    if (!e.active || e.type !== 'DEPENDS' || !dead.has(e.to_id) || seen.has(e.from_id)) continue
    if (isTerminal(s.claims[e.from_id] && s.claims[e.from_id].status)) continue
    seen.add(e.from_id)
    out.push({ type: 'REVIEW_FLAG', actor: 'sys', at, payload: { claim_id: e.from_id } })
  }
  return out
}

/**
 * 一批命题即将进终态：对仍挂着它们的未结 κ 写 KAPPA_OBSOLETE（P21），并给 1 跳 DEPENDS 写 REVIEW_FLAG。
 * skip 为本次正在迁移的 κ（它自己的迁移已经处理两极）。返回 { evs, expect }，expect 只含 κ。
 */
export function closeAround(s, ids, at, skip = []) {
  const dead = new Set(ids)
  const evs = []
  const expect = {}
  for (const k of Object.values(s.kappas)) {
    if (skip.includes(k.id) || !SIGMA_OPEN.includes(k.sigma)) continue
    if (!dead.has(k.pos_id) && !dead.has(k.neg_id)) continue
    expect[k.id] = k.sigma
    evs.push({ type: 'KAPPA_OBSOLETE', layer: k.layer, actor: 'sys', at, payload: { kappa_id: k.id } })
  }
  evs.push(...flagsForTerminal(s, ids, at))
  return { evs, expect }
}

export function coreTargets(s, layer) {
  const cores = new Set()
  for (const c of Object.values(s.claims)) {
    if (c.layer === layer && isCoreKind(layer, c.kind) && !isTerminal(c.status)) cores.add(c.id)
  }
  const targets = new Set(cores)
  for (const e of Object.values(s.edges)) {
    if (e.active && e.type === 'DEPENDS' && cores.has(e.to_id)) targets.add(e.from_id)
  }
  return targets
}

function t0Of(s, layer, evs) {
  let t0 = ''
  const targets = coreTargets(s, layer)
  const nuClaim = {}
  for (const n of Object.values(s.nus)) nuClaim[n.id] = n.claim_id
  for (const ev of evs) {
    if (ev.type === 'ELEV_COMMIT' && ev.layer === layer) t0 = ev.at
    if (ev.type !== 'EVIDENCE') continue
    for (const x of ev.payload.evidence || []) {
      if (x.sign <= 0) continue
      const cid = x.target_type === 'nu' ? nuClaim[x.target_id] : x.target_id
      if (targets.has(cid) && ev.at > t0) t0 = ev.at
    }
  }
  return t0
}

/** Eq.12：本纪元核心目标上、t0 之后的负证据条数。 */
export function mOf(s, layer, evs) {
  const targets = coreTargets(s, layer)
  const t0 = t0Of(s, layer, evs)
  const nuClaim = {}
  for (const n of Object.values(s.nus)) nuClaim[n.id] = n.claim_id
  let n = 0
  for (const ev of evs) {
    if (ev.type !== 'EVIDENCE' || ev.at <= t0) continue
    for (const x of ev.payload.evidence || []) {
      if (x.sign >= 0) continue
      const cid = x.target_type === 'nu' ? nuClaim[x.target_id] : x.target_id
      if (targets.has(cid)) n++
    }
  }
  return n
}

// 同事务登记的 ν：同一时刻、紧随修订之后、为同一命题；求证（L1）补登的 ν 带 inquiry_id，不算修订自带
function nusOfRev(evs, r) {
  const ids = new Set()
  if (r.claim_id) {
    for (const ev of evs) {
      if (ev.type !== 'NU_REGISTER' || ev.seq <= r.seq || ev.at !== r.at || ev.payload.inquiry_id) continue
      for (const n of ev.payload.nus || []) if (n.claim_id === r.claim_id) ids.add(n.id)
    }
  }
  return ids
}

/** 本纪元修订序列（§9.1）。 */
export function revOf(s, evs, layer) {
  const epochStart = evs.filter((e) => e.type === 'ELEV_COMMIT' && e.layer === layer).pop()
  const after = epochStart ? epochStart.seq : 0
  const coreIds = new Set(Object.values(s.claims).filter((c) => c.layer === layer && isCoreKind(layer, c.kind)).map((c) => c.id))
  // 同一时刻的 DEPENDS→核心 边：from_id → [{ seq, at }]
  const depAt = {}
  for (const e of evs) {
    if (e.type !== 'EDGE_ADD') continue
    for (const x of e.payload.edges || []) {
      if (x.type === 'DEPENDS' && coreIds.has(x.to_id)) (depAt[x.from_id] ||= []).push(e)
    }
  }
  const out = []
  for (const ev of evs) {
    if (ev.seq <= after || ev.layer !== layer) continue
    if (ev.type === 'REV') {
      const cid = ev.payload.claims && ev.payload.claims[0] && ev.payload.claims[0].id
      out.push({ type: 'REV', seq: ev.seq, at: ev.at, claim_id: cid, ev })
    } else if (ev.type === 'SUB_ACCEPT') {
      const cid = ev.payload.claims && ev.payload.claims[0] && ev.payload.claims[0].id
      out.push({ type: 'SUB_ACCEPT', seq: ev.seq, at: ev.at, claim_id: cid, ev })
    } else if (ev.type === 'REPAIR_FAILED') {
      out.push({ type: 'REPAIR_FAILED', seq: ev.seq, at: ev.at, claim_id: null, ev })
    } else if (ev.type === 'CLAIM_EXP') {
      const cid = ev.payload.claims && ev.payload.claims[0] && ev.payload.claims[0].id
      const dep = (depAt[cid] || []).some((e) => e.seq > ev.seq && e.at === ev.at)
      if (dep) out.push({ type: 'EXP_DEP', seq: ev.seq, at: ev.at, claim_id: cid, ev })
    }
  }
  return out
}

export function badOf(r, s, evs) {
  if (r.type === 'REPAIR_FAILED') return true
  const ids = nusOfRev(evs, r)
  if (!ids.size) return true
  const rows = [...ids].map((id) => s.nus[id]).filter(Boolean)
  if (rows.some((n) => n.outcome === 'pending')) return false
  return !rows.some((n) => n.outcome === 'hit')
}

export function degenOf(s, evs, layer) {
  const revs = revOf(s, evs, layer)
  const K = theta(s, 'K', layer)
  if (revs.length < K) return { degenerate: false, rev: revs, bad: [], K }
  const last = revs.slice(-K)
  const bad = last.filter((r) => badOf(r, s, evs))
  return { degenerate: bad.length === K, rev: revs, bad, K }
}

export function e1Ready(s, evs, layer, now) {
  const Wdeg = theta(s, 'W_deg', layer)
  const Mcore = theta(s, 'M_core', layer)
  const Tclash = theta(s, 'T_clash', layer)
  const m = mOf(s, layer, evs)
  // 只数本纪元的检查点：换代前的退化不能让新核立刻又被换掉
  const epoch = evs.filter((e) => e.type === 'ELEV_COMMIT' && e.layer === layer).pop()
  const from = epoch ? epoch.seq : 0
  const checks = evs.filter((e) => e.type === 'DEGEN_CHECK' && e.layer === layer && e.seq > from).slice(-Wdeg)
  const byDegen = checks.length >= Wdeg && checks.every((e) => e.payload && e.payload.degenerate) && m >= Mcore
  const hit = evs.find((e) => {
    if (e.type !== 'CORE_CLASH' || e.layer !== layer || e.seq <= from) return false
    const k = s.kappas[e.payload && e.payload.kappa_id]
    if (!k || k.sigma === 'resolved' || k.sigma === 'sublated') return false
    return Date.parse(now) - Date.parse(e.at) >= Tclash * DAY - 1e-6
  })
  const clash = !!hit
  return { ready: byDegen || clash, m, byDegen, clash, clashKappa: hit ? hit.payload.kappa_id : null }
}

/** N2：π 跌破 π_fals 且样本够的非核心 active 命题 → CON。 */
export function conCheck(db, aid, now) {
  const s = loadState(db, aid)
  const did = []
  for (const c of Object.values(s.claims)) {
    if (c.status !== 'active' || isCoreKind(c.layer, c.kind)) continue
    const nMin = Math.round(theta(s, 'n_min', c.layer))
    const pf = theta(s, 'pi_fals', c.layer)
    if (!(c.n >= nMin && c.pi <= pf + 1e-9)) continue
    const live = loadState(db, aid)
    if (!live.claims[c.id] || live.claims[c.id].status !== 'active') continue
    const pack = closeAround(live, [c.id], now)
    try {
      append(db, aid, [{ type: 'CON', layer: c.layer, actor: 'sys', at: now, payload: { claim_id: c.id } }, ...pack.evs],
        { claims: { [c.id]: 'active' }, kappas: pack.expect })
      did.push({ id: c.id, type: 'CON' })
    } catch { /* expect 不符则下夜 */ }
  }
  return { did, scanned: Object.keys(s.claims).length }
}

function dueNus(s, now) {
  return Object.values(s.nus).filter((n) => n.outcome === 'pending' && now >= n.due_at)
}

function recordsFor(db, aid, n) {
  try {
    return db.prepare(
      'SELECT id, kind, target_id, sign, ref, at FROM claim_evidence WHERE agent_id=? AND at>? AND at<=? ORDER BY at',
    ).all(aid, n.reg_at, n.due_at)
  } catch { return [] }
}

const REC_CAP = 12

/** 相关记录（指向这条命题或其预见）排前面，其余按时间补足，一共最多 12 条。 */
function pickRecords(recs, claimId, nuIds) {
  const rel = new Set([claimId, ...(nuIds || [])])
  const related = []
  const rest = []
  for (const r of recs) (rel.has(r.target_id) ? related : rest).push(r)
  const byTime = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)
  related.sort(byTime)
  rest.sort(byTime)
  return [...related, ...rest].slice(0, REC_CAP)
}

/** 校准：已结算（hit/miss）预见的 Brier 分，越小越准。void 不算。 */
export function brierOf(s) {
  const rows = Object.values((s && s.nus) || {}).filter((n) => n.outcome === 'hit' || n.outcome === 'miss')
  if (!rows.length) return { brier: null, n: 0 }
  let sum = 0
  for (const n of rows) {
    const p = Math.min(1, Math.max(0, Number(n.p) || 0))
    sum += (p - (n.outcome === 'hit' ? 1 : 0)) ** 2
  }
  return { brier: +(sum / rows.length).toFixed(4), n: rows.length }
}

/** N1：到期 ν 每批 ≤8 条走 J7；void 不改 π。J7 失败保持 pending。 */
export async function checkDue(db, aid, now, opt = {}) {
  if (opt.requireEnabled !== false && !isEnabled(db, aid) && !opt.force) return { status: 'off', did: [] }
  const s = loadState(db, aid)
  const due = dueNus(s, now)
  const did = []
  const skipped = []
  const texts = textsOf(db, aid)
  const nuRow = Object.fromEntries(db.prepare('SELECT id, expect, observe FROM claim_predictions WHERE agent_id=?').all(aid).map((r) => [r.id, r]))
  // §8.1：(t_reg, t_due] 内找不到外部记录 → void，[D] 判定，不花 J7
  const withRec = []
  for (const n of due) {
    // 自己许的承诺：只看「这一条 ν 上有没有正面证据」，不看旁证——做到了才算数，否则算没做到
    if (/^我答应/.test(String(texts[n.claim_id] || ''))) {
      const hit = readEvents(db, aid, { types: ['EVIDENCE'] })
        .some((e) => (e.payload.evidence || []).some((x) => x.target_type === 'nu' && x.target_id === n.id && x.sign > 0))
      try {
        if (hit) {
          append(db, aid, [{ type: 'NU_RESOLVE', actor: 'sys', at: now, payload: { nu_id: n.id, outcome: 'hit', why: 'pledge_done' } }], { nus: { [n.id]: 'pending' } })
          did.push({ id: n.id, outcome: 'hit' })
        } else {
          settleMiss(db, aid, n, now)
          did.push({ id: n.id, outcome: 'miss' })
        }
      } catch (e) { skipped.push({ id: n.id, reason: e.code || 'ERR' }) }
      continue
    }
    const recs = recordsFor(db, aid, n)
    const nuIds = Object.values(s.nus).filter((x) => x.claim_id === n.claim_id).map((x) => x.id)
    const picked = pickRecords(recs, n.claim_id, nuIds)
    if (picked.length) { withRec.push({ n, recs: picked }); continue }
    try {
      append(db, aid, [{ type: 'NU_RESOLVE', actor: 'sys', at: now, payload: { nu_id: n.id, outcome: 'void', why: 'no_records' } }], { nus: { [n.id]: 'pending' } })
      did.push({ id: n.id, outcome: 'void' })
    } catch (e) { skipped.push({ id: n.id, reason: e.code || 'ERR' }) }
  }
  for (let i = 0; i < withRec.length; i += 8) {
    const batch = withRec.slice(i, i + 8).map((x) => x.n)
    const input = {
      items: withRec.slice(i, i + 8).map(({ n, recs }) => ({
        nu_id: n.id, expect: (nuRow[n.id] || {}).expect || '', observe: (nuRow[n.id] || {}).observe || '', p: n.p,
        claim_id: n.claim_id, claim_text: texts[n.claim_id] || '',
        reg_at: n.reg_at, due_at: n.due_at,
        records: recs.map((r) => ({ id: r.id || r.ref, kind: r.kind, sign: r.sign, ref: r.ref, at: r.at })),
      })),
    }
    const r = await call({ db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat }, 'J7', input, { tier: 'T1', pool: 'mid' })
    if (!r.ok && r.code === 'BUDGET') return { status: 'budget', did, skipped, postponed: true }
    if (!r.ok) {
      for (const n of batch) skipped.push({ id: n.id, reason: r.code })
      continue
    }
    const byId = Object.fromEntries((r.out.items || []).map((x) => [x.nu_id, x]))
    for (const n of batch) {
      const item = byId[n.id]
      let outcome = item && ['hit', 'miss', 'void'].includes(item.outcome) ? item.outcome : 'void'
      // ref 只认输入给出的外部记录；编造的 id 丢掉
      const known = new Set(((input.items.find((x) => x.nu_id === n.id) || {}).records || []).map((x) => x.id))
      const refs = ((item && item.refs) || []).filter((x) => known.has(x))
      if ((outcome === 'hit' || outcome === 'miss') && !refs.length) outcome = 'void'
      if ((outcome === 'hit' || outcome === 'miss') && !(Date.parse(now) > Date.parse(n.reg_at))) {
        skipped.push({ id: n.id, reason: 'P5' })
        continue
      }
      const evs = []
      if (outcome === 'hit' || outcome === 'miss') {
        evs.push({
          type: 'EVIDENCE', actor: 'sys', at: now,
          payload: {
            evidence: [{
              kind: 'check', target_type: 'nu', target_id: n.id,
              sign: outcome === 'hit' ? 1 : -1, weight: theta(s, 'w_check'),
              ref: String(refs[0] || ('j7:' + n.id)),
            }],
          },
        })
      }
      const sur = surpriseOf(n.p, outcome)
      evs.push({ type: 'NU_RESOLVE', actor: 'sys', at: now, payload: { nu_id: n.id, outcome, ...(sur ? { surprise: +sur.toFixed(4) } : {}) } })
      try {
        append(db, aid, evs, { nus: { [n.id]: 'pending' } })
        did.push({ id: n.id, outcome })
      } catch (e) {
        skipped.push({ id: n.id, reason: e.code || 'ERR' })
      }
    }
  }
  return { status: 'done', due: due.length, did, skipped }
}

/**
 * N1b：卡死的 κ。开了超过 T_stale 天、一次都没被审议过的 struggle，自动挂起：
 * 两极回 active（那句重新能被听见），κ 留着以后还能 REOPEN。
 * 没有这一步，三次违背会把一句话永久下架——没有模型就永远回不来。
 */
export function suspendStaleKappas(db, aid, now, opt = {}) {
  if (opt.requireEnabled !== false && !isEnabled(db, aid) && !opt.force) return { did: [], off: true }
  const s = loadState(db, aid)
  const days = Number(opt.days) > 0 ? Number(opt.days) : (theta(s, 'T_stale') || 21)
  const since = Date.parse(now) - days * 86400000
  const deliberated = new Set(readEvents(db, aid, { types: ['DELIBERATE'] }).map((e) => e.payload && e.payload.kappa_id))
  const did = []
  for (const k of Object.values(s.kappas)) {
    if (k.sigma !== 'struggle') continue
    if (deliberated.has(k.id)) continue
    if (!(Date.parse(k.opened_at) <= since)) continue
    try {
      append(db, aid, [{ type: 'SUSPEND', layer: k.layer, actor: 'sys', at: now, payload: { kappa_id: k.id, why: 'stale:' + days + 'd' } }], { kappas: { [k.id]: 'struggle' } })
      did.push({ id: k.id, layer: k.layer })
    } catch { /* 已被别处改过 */ }
  }
  return { did }
}

/** L3 惊奇（Eq.16）：hit 为 −ln p，miss 为 −ln(1−p)；void 无惊奇。 */
export const surpriseOf = (p, outcome) => (outcome === 'hit' ? -Math.log(p) : outcome === 'miss' ? -Math.log(1 - p) : 0)

/** 上次修补尝试（成功的 CLAIM_EXP 带 repair_of，失败的 REPAIR_FAILED）之后又受挫的核心，附新的负证据。 */
function hurtCores(s, evs) {
  const lastTry = {}
  for (const ev of evs) {
    const id = ev.type === 'REPAIR_FAILED' ? ev.payload.core_id : ev.type === 'CLAIM_EXP' ? ev.payload.repair_of : null
    if (id) lastTry[id] = ev.seq
  }
  const nuClaim = {}
  for (const n of Object.values(s.nus)) nuClaim[n.id] = n.claim_id
  const out = []
  for (const c of Object.values(s.claims)) {
    if (!isCoreKind(c.layer, c.kind) || c.status !== 'active') continue
    const targets = new Set([c.id])
    for (const e of Object.values(s.edges)) {
      if (e.active && e.type === 'DEPENDS' && e.to_id === c.id) targets.add(e.from_id)
    }
    const hits = []
    for (const ev of evs) {
      if (ev.type !== 'EVIDENCE' || ev.seq <= (lastTry[c.id] || 0)) continue
      for (const x of ev.payload.evidence || []) {
        if (x.sign >= 0) continue
        const cid = x.target_type === 'nu' ? nuClaim[x.target_id] : x.target_id
        if (targets.has(cid)) hits.push({ x_id: x.id, target_id: cid, kind: x.kind })
      }
    }
    if (hits.length) out.push({ core: c, hits: hits.slice(-8) })
  }
  return out
}

/** 核心受挫 → J8 改保护带；失败写 REPAIR_FAILED（计入 Rev 且 Bad）。 */
export async function tryRepair(db, aid, coreId, now, opt = {}) {
  const s = loadState(db, aid)
  const core = s.claims[coreId]
  if (!core || !isCoreKind(core.layer, core.kind) || core.status !== 'active') return { ok: false, reason: 'no_core' }
  const texts = textsOf(db, aid)
  const hits = (opt.hits || []).map((h) => ({ ...h, text: texts[h.target_id] || '' }))
  const brier = opt.brier == null ? brierOf(s).brier : opt.brier
  const r = await call(
    { db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat },
    'J8',
    { layer: core.layer, core: { id: core.id, text: texts[core.id] || '', kind: core.kind }, hits, brier },
    { tier: 'T2', pool: 'mid' },
  )
  if (!r.ok && r.code === 'BUDGET') return { ok: false, postponed: true, reason: 'budget' }
  if (!r.ok || !r.out || r.out.depends_core_id !== core.id) {
    append(db, aid, [{ type: 'REPAIR_FAILED', layer: core.layer, actor: 'sys', at: now, payload: { core_id: core.id, reason: (r && r.code) || 'J8' } }])
    return { ok: false, failed: true, reason: (r && r.code) || 'J8', core_id: core.id }
  }
  const kind = (BELT_KINDS[core.layer] || ['belt'])[0]
  const cid = newId('claims', now)
  const evs = [{
    type: 'CLAIM_EXP', layer: core.layer, actor: 'judge', at: now,
    payload: { claims: [{ id: cid, layer: core.layer, kind, text: r.out.text, origin: 'synth' }], repair_of: core.id },
  }, {
    type: 'EDGE_ADD', actor: 'sys', at: now,
    payload: { edges: [{ type: 'DEPENDS', from_id: cid, to_id: core.id }] },
  }]
  if (r.out.nu && r.out.nu.length) {
    evs.push({
      type: 'NU_REGISTER', actor: 'judge', at: now,
      payload: {
        nus: r.out.nu.map((n) => ({
          claim_id: cid, expect: n.expect, observe: n.observe, p: n.p,
          due_at: addDays(now, Math.min(n.due_days, theta(s, 'T_nu'))),
        })),
      },
    })
  }
  try {
    append(db, aid, evs)
    return { ok: true, claim_id: cid, core_id: core.id }
  } catch (e) {
    append(db, aid, [{ type: 'REPAIR_FAILED', layer: core.layer, actor: 'sys', at: now, payload: { core_id: core.id, reason: e.code || 'ERR' } }])
    return { ok: false, failed: true, reason: e.code || 'ERR', core_id: core.id }
  }
}

export async function repairHurt(db, aid, now, opt = {}) {
  const s = loadState(db, aid)
  const evs = evList(db, aid)
  const did = []
  for (const { core, hits } of hurtCores(s, evs)) {
    const r = await tryRepair(db, aid, core.id, now, { ...opt, hits })
    did.push({ id: core.id, ...r })
    if (r.postponed) break
  }
  return { did }
}

/** N3：每层写 DEGEN_CHECK，并计算 m / E1 是否就绪（升维本身是 S10）。 */
export function degenCheck(db, aid, now) {
  const s = loadState(db, aid)
  const evs = evList(db, aid)
  const did = []
  for (const layer of LAYERS) {
    // 没有在世核心的层不可能升维，不写检查点（免得空闲时账本每夜白涨）
    if (!Object.values(s.claims).some((c) => c.layer === layer && isCoreKind(layer, c.kind) && !isTerminal(c.status))) continue
    const d = degenOf(s, evs, layer)
    const m = mOf(s, layer, evs)
    const e1 = e1Ready(s, evs, layer, now)
    const payload = { degenerate: d.degenerate, m, rev: d.rev.length, e1: e1.ready }
    // 未退化且与上一检查点相同：E1 只看最近 W_deg 个是否全退化，末尾已是未退化，省掉不影响判定
    const prev = evs.filter((e) => e.type === 'DEGEN_CHECK' && e.layer === layer).pop()
    if (!d.degenerate && prev && !e1.ready && JSON.stringify(prev.payload) === JSON.stringify(payload)) continue
    append(db, aid, [{ type: 'DEGEN_CHECK', layer, actor: 'sys', at: now, payload }])
    did.push({ layer, degenerate: d.degenerate, m, rev: d.rev.length, e1: e1.ready })
  }
  return { did }
}

/**
 * 跨层派生证据：CONSTRAINS(a→c′) 且不同层，给 a 写一条同号、半权、derived_from=x 的证据。
 * 只传 1 跳；已派生过的 x 不再写。opt.attributed 为 J12 确认的 {x_id → a_id[]}，缺省按边结构全传。
 */
export function deriveCross(db, aid, now, opt = {}) {
  const s = loadState(db, aid)
  const evs = evList(db, aid, ['EVIDENCE'])
  const derived = new Set()
  for (const ev of evs) {
    for (const x of ev.payload.evidence || []) if (x.derived_from) derived.add(x.derived_from)
  }
  const store = db.prepare('SELECT id, kind, target_type, target_id, sign, weight, derived_from, at FROM claim_evidence WHERE agent_id=?').all(aid)
  const byId = Object.fromEntries(store.map((r) => [r.id, r]))
  const nuClaim = {}
  for (const n of Object.values(s.nus)) nuClaim[n.id] = n.claim_id
  const did = []
  for (const row of store) {
    if (row.derived_from || derived.has(row.id)) continue
    const cid = row.target_type === 'nu' ? nuClaim[row.target_id] : row.target_id
    const c = s.claims[cid]
    if (!c) continue
    for (const e of Object.values(s.edges)) {
      if (!e.active || e.type !== 'CONSTRAINS' || e.to_id !== cid) continue
      const a = s.claims[e.from_id]
      if (!a || a.layer === c.layer || isTerminal(a.status)) continue
      if (opt.attributed && !(opt.attributed[row.id] || []).includes(a.id)) continue
      const w0 = theta(s, 'w_' + row.kind)
      const ev = {
        type: 'EVIDENCE', actor: 'sys', at: now,
        payload: {
          evidence: [{
            kind: row.kind, target_type: 'claim', target_id: a.id, sign: row.sign,
            weight: 0.5 * w0, ref: 'cross:' + row.id, derived_from: row.id,
          }],
        },
      }
      try {
        append(db, aid, [ev])
        derived.add(row.id)
        did.push({ from: row.id, to: a.id })
      } catch { /* 权重或终态 */ }
    }
  }
  return { did }
}

export async function attributeCross(db, aid, now, opt = {}) {
  const s = loadState(db, aid)
  const cons = Object.values(s.edges).filter((e) => e.active && e.type === 'CONSTRAINS')
  if (!cons.length) return { attributed: {}, v_exception: [] }
  // 只送「落在被约束命题上、本身不是派生、也还没派生过」的证据；没有就不调
  const nuClaim = {}
  for (const n of Object.values(s.nus)) nuClaim[n.id] = n.claim_id
  const targets = new Set(cons.map((e) => e.to_id))
  const done = new Set(db.prepare('SELECT derived_from d FROM claim_evidence WHERE agent_id=? AND derived_from IS NOT NULL').all(aid).map((r) => r.d))
  const recent = db.prepare('SELECT id, kind, target_id, target_type, sign FROM claim_evidence WHERE agent_id=? AND derived_from IS NULL ORDER BY at DESC LIMIT 200').all(aid)
    .filter((x) => !done.has(x.id) && targets.has(x.target_type === 'nu' ? nuClaim[x.target_id] : x.target_id))
    .slice(0, 24)
  if (!recent.length) return { attributed: {}, v_exception: [] }
  const r = await call(
    { db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat },
    'J12',
    {
      evidence: recent,
      constraints: cons.map((e) => ({ id: e.id, from_id: e.from_id, to_id: e.to_id })),
      kappas: Object.values(s.kappas).filter((k) => k.layer === 'V' && (k.sigma === 'struggle' || k.sigma === 'coexist' || k.sigma === 'suspended'))
        .map((k) => ({ id: k.id, pos_id: k.pos_id, neg_id: k.neg_id })),
    },
    { tier: 'T1', pool: 'mid' },
  )
  if (!r.ok) return { attributed: {}, v_exception: [], reason: r.code, failed: true }
  const attributed = {}
  for (const x of r.out.cross || []) {
    (attributed[x.x_id] ||= []).push(x.a_id)
  }
  return { attributed, v_exception: r.out.v_exception || [] }
}

/**
 * VException：T_v 内 ≥ D_v 条负证据落在被该 κ 某一极 CONSTRAINS 的 L/W 命题上。
 * judged=true（生产路径）时只数 [J] 已归因到该极的那些：J12 归因后会给该极派生一条 derived_from=x 的证据，
 * 或在今夜的 J12 v_exception 里点名（extraIds）。
 */
export function vExceptionOf(s, k, evs, now, extraIds = [], opt = {}) {
  if (!k || k.layer !== 'V') return { ok: false, ids: [] }
  const Tv = theta(s, 'T_v')
  const Dv = theta(s, 'D_v')
  const since = new Date(Date.parse(now) - Tv * DAY).toISOString()
  const poles = new Set([k.pos_id, k.neg_id])
  const constrained = new Set()
  for (const e of Object.values(s.edges)) {
    if (!e.active || e.type !== 'CONSTRAINS' || !poles.has(e.from_id)) continue
    const to = s.claims[e.to_id]
    if (to && to.layer !== 'V') constrained.add(e.to_id)
  }
  const judged = new Set(extraIds)
  if (opt.judged) {
    for (const ev of evs) {
      if (ev.type !== 'EVIDENCE') continue
      for (const x of ev.payload.evidence || []) if (x.derived_from && poles.has(x.target_id)) judged.add(x.derived_from)
    }
  }
  const ids = []
  const nuClaim = {}
  for (const n of Object.values(s.nus)) nuClaim[n.id] = n.claim_id
  for (const ev of evs) {
    if (ev.type !== 'EVIDENCE' || ev.at < since) continue
    for (const x of ev.payload.evidence || []) {
      if (x.sign >= 0) continue
      const cid = x.target_type === 'nu' ? nuClaim[x.target_id] : x.target_id
      if (!constrained.has(cid)) continue
      if (opt.judged && !judged.has(x.id)) continue
      ids.push(x.id || ev.id)
    }
  }
  if (!opt.judged) for (const id of extraIds) if (!ids.includes(id)) ids.push(id)
  return { ok: ids.length >= Math.round(Dv), ids }
}
