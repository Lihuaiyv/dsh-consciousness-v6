/**
 * 三观接口（S13）：/v1/agents/:id/sangguan/*。宿主 api.js 只做转发；权限：viewer 只读（宿主已拦写），配置只有 user 能改。
 * 开关关闭时数据类 GET 只回 { enabled:false }，不读投影、不进三观代码路径；status / config 照常可用（用来打开它）。
 * 所有 GET 只读；写入口只有 verdict、种核心（冷启动）、升维批准 / 拒绝与配置。
 */
import { err } from '../../kernel.js'
import { isEnabled, sangguanConfig, setSangguanConfig } from './config.js'
import { loadState, listHeads } from './projection.js'
import { append, readEvents, lastSeq, ConflictError, SangguanError } from './ledger.js'
import { LAYERS, SIGMA_OPEN, CORE_KIND, isCoreKind, isTerminal } from './catalog.js'
import { budgetSnapshot } from './budget.js'
import { judgeHealth } from './llm.js'
import { qiOf, viewWeights, userActive, dogmatic, churnOf } from './liveness.js'
import { injectView, injectLog, liveReady } from './inject.js'
import { listSummaries } from './summary.js'
import { explain } from './explain.js'
import { verdict, rJOf, VerdictError } from './verdict.js'
import { shadowOf, replaceReady } from './bridge.js'
import { pendingElev, approveElev, rejectElev } from './elev.js'
import { outcomes } from './precedent.js'
import { pendingList } from './fast.js'
import { withdrawSeed } from './seed.js'
import { theta } from './fold.js'
import { brierOf } from './practice.js'

const nowIso = () => new Date().toISOString()
const day = (now) => now.slice(0, 10)
const EVENT_PAGE = 50

function texts(db, aid) {
  const claims = new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text]))
  const qs = new Map(db.prepare('SELECT id, text FROM claim_questions WHERE agent_id=?').all(aid).map((r) => [r.id, r.text]))
  return { claims, qs }
}

/** 配置对外视图：端点 key 不出库，只给 has_key。 */
function publicConfig(cfg) {
  const ep = (e) => (e ? { url: e.url, model: e.model || null, has_key: !!e.key } : null)
  return { enabled: cfg.enabled, inject: cfg.inject, budget: cfg.budget, replace: cfg.replace, model: { light: ep(cfg.model.light), heavy: ep(cfg.model.heavy) } }
}

function claimView(c, tx, w) {
  return {
    id: c.id, layer: c.layer, kind: c.kind, status: c.status, origin: c.origin, text: tx.claims.get(c.id) || '',
    pi: +c.pi.toFixed(4), n: c.n, e: +c.e.toFixed(4), n_dep: c.n_dep, epoch: c.epoch, review: c.review,
    pred: c.pred, q_id: c.q_id, last_ev_at: c.last_ev_at, weight: w && w[c.id] != null ? w[c.id] : 1,
  }
}

function kappaView(k, s, tx) {
  return {
    id: k.id, layer: k.layer, sigma: k.sigma, q: tx.qs.get(k.q_id) || '',
    pos: { id: k.pos_id, text: tx.claims.get(k.pos_id) || '', status: (s.claims[k.pos_id] || {}).status, pi: +((s.claims[k.pos_id] || {}).pi || 0).toFixed(4) },
    neg: { id: k.neg_id, text: tx.claims.get(k.neg_id) || '', status: (s.claims[k.neg_id] || {}).status, pi: +((s.claims[k.neg_id] || {}).pi || 0).toFixed(4) },
    sub_id: k.sub_id, sub: k.sub_id ? tx.claims.get(k.sub_id) || '' : null, trial_until: k.trial_until, dormant_since: k.dormant_since,
    opened_at: k.opened_at, closed_at: k.closed_at, open: SIGMA_OPEN.includes(k.sigma),
  }
}

// ---------- 事件的人话（时间线用；技术名放 type 字段） ----------
const WORD = {
  CLAIM_EXP: '有了新看法', REV: '改了说法', DUP: '又说到了旧看法', CON: '被事实推翻', REJECT: '没收下一条候选',
  CORE_ESTABLISH: '立为核心', FLIP: '想法来回摆', KAPPA_OPEN: '发现两种看法冲突', REOPEN: '旧冲突又起', KAPPA_OBSOLETE: '冲突不再成立',
  DELIBERATE: '认真想了一回', RESOLVE: '分出了高下', COEX: '决定两样都要', TRADEOFF: '定下平时偏向哪边', SUSPEND: '先放着不定',
  SUB_ACCEPT: '试一个合起来的说法', SUB_CONFIRM: '合起来的说法站住了', SUB_ROLLBACK: '合起来的说法撤回了', SUB_EXPIRE: '试用到期没结论',
  SUB_EXTEND: '试用延长', SUB_DORMANT: '试用期没动静', NU_REGISTER: '做了一个预料', EVIDENCE: '有事为证', NU_RESOLVE: '预料揭晓',
  ELEV_PROPOSE: '提议换核心', ELEV_COMMIT: '换了核心', ELEV_REJECTED: '换核心被否', ELEV_FAILED: '想换核心没成',
  EDGE_ADD: '把不同层的看法连起来', EDGE_RETIRE: '一条联系不再成立', INQUIRY: '想弄清一件事', THETA_ADJUST: '调整了自己的节奏',
  SUMMARY_BUILD: '写了一段自传', DEGEN_CHECK: '检查核心是否还管用', REVIEW_FLAG: '一条看法需要重看', JOB_DONE: '一夜过去',
  CLAIM_WITHDRAW: '撤回了一句还没立住的看法',
}

function idsOf(e) {
  const p = e.payload || {}
  const out = new Set()
  for (const c of p.claims || []) out.add(c.id)
  for (const x of p.evidence || []) out.add(x.target_id)
  for (const n of p.nus || []) out.add(n.claim_id)
  for (const k of p.kappas || []) { out.add(k.id); out.add(k.pos_id); out.add(k.neg_id) }
  for (const [k, v] of Object.entries(p)) if (typeof v === 'string' && /_id$/.test(k)) out.add(v)
  return out
}

function narrate(e, tx, s) {
  const p = e.payload || {}
  let word = WORD[e.type] || e.type
  if (e.type === 'NU_RESOLVE') word = p.outcome === 'hit' ? '预料对了' : p.outcome === 'miss' ? '预料错了' : '预料作废'
  if (e.type === 'INQUIRY' && p.answer_of) word = '得到了回答'
  if (e.type === 'EVIDENCE') word = (p.evidence || []).every((x) => x.sign > 0) ? '有事支持' : (p.evidence || []).every((x) => x.sign < 0) ? '有事相反' : '有事为证'
  const about = []
  for (const id of idsOf(e)) {
    if (tx.claims.has(id)) about.push(tx.claims.get(id))
    else if (s.kappas[id]) about.push((tx.claims.get(s.kappas[id].pos_id) || '?') + ' ⟷ ' + (tx.claims.get(s.kappas[id].neg_id) || '?'))
    else if (s.nus[id] && tx.claims.has(s.nus[id].claim_id)) about.push(tx.claims.get(s.nus[id].claim_id))
  }
  if (p.question) about.push(p.question)
  return { word, about: [...new Set(about)].slice(0, 3).map((t) => t.slice(0, 60)) }
}

function eventView(e, tx, s) {
  const n = narrate(e, tx, s)
  return { seq: e.seq, id: e.id, at: e.at, type: e.type, layer: e.layer, actor: e.actor, word: n.word, about: n.about, refs: e.refs, precedent_ids: e.precedent_ids, payload: e.payload }
}

// ---------- 读 ----------
function status(db, aid, now) {
  const cfg = sangguanConfig(db, aid)
  if (!cfg.enabled) return { enabled: false, config: publicConfig(cfg) }
  const s = loadState(db, aid)
  const claims = {}
  for (const l of LAYERS) claims[l] = {}
  for (const c of Object.values(s.claims)) claims[c.layer][c.status] = (claims[c.layer][c.status] || 0) + 1
  const kappas = {}
  for (const k of Object.values(s.kappas)) kappas[k.sigma] = (kappas[k.sigma] || 0) + 1
  const nus = { pending: 0, hit: 0, miss: 0, void: 0 }
  for (const n of Object.values(s.nus)) nus[n.outcome] = (nus[n.outcome] || 0) + 1
  const night = readEvents(db, aid, { types: ['JOB_DONE'] }).filter((e) => String(e.job_key).startsWith('sg:night:')).pop()
  return {
    enabled: true, config: publicConfig(cfg), seq: lastSeq(db, aid), epoch: s.epoch,
    counts: { claims, kappas, nus },
    inject: { mode: cfg.inject, ...liveReady(db, aid) },
    replace_ready: Object.fromEntries(LAYERS.map((l) => [l, replaceReady(db, aid, l, now)])),
    budget: budgetSnapshot(db, aid, day(now)),
    judge: { ...judgeHealth(db, aid, Date.parse(now)), r_J: rJOf(db, aid, now) },
    qi: qiOf(db, aid, now),
    calibration: brierOf(s),
    pending: { candidates: pendingList(db, aid).length, elev: pendingElev(db, aid, now).length },
    last_night: night ? { at: night.at, day: night.payload.day, degraded: !!night.payload.degraded } : null,
  }
}

function heads(db, aid, now, query) {
  const s = loadState(db, aid)
  const tx = texts(db, aid)
  const w = viewWeights(db, aid, now)
  const layers = query.get('layer') ? [query.get('layer')] : LAYERS
  const out = {}
  for (const l of layers) {
    if (!LAYERS.includes(l)) err(400, 'INVALID_ARGUMENT', '层只能是 W / L / V')
    out[l] = query.get('all') === '1'
      ? Object.values(s.claims).filter((c) => c.layer === l).map((c) => claimView(c, tx, w))
      : listHeads(db, aid, l).map((h) => claimView(s.claims[h.id], tx, w))
  }
  return { layers: out }
}

function chain(db, aid, id) {
  const s = loadState(db, aid)
  const c = s.claims[id]
  if (!c) err(404, 'NOT_FOUND', '没有这个命题')
  const tx = texts(db, aid)
  const up = []
  const seen = new Set([id])
  let frontier = [...c.pred]
  while (frontier.length && up.length < 50) {
    const next = []
    for (const p of frontier) {
      if (seen.has(p) || !s.claims[p]) continue
      seen.add(p)
      up.push(claimView(s.claims[p], tx))
      next.push(...s.claims[p].pred)
    }
    frontier = next
  }
  const down = []
  frontier = [id]
  while (frontier.length && down.length < 50) {
    const next = []
    for (const x of Object.values(s.claims)) {
      if (seen.has(x.id) || !x.pred.some((p) => frontier.includes(p))) continue
      seen.add(x.id)
      down.push(claimView(x, tx))
      next.push(x.id)
    }
    frontier = next
  }
  const nus = new Set(Object.values(s.nus).filter((n) => n.claim_id === id).map((n) => n.id))
  const evs = readEvents(db, aid).filter((e) => { const ids = idsOf(e); return ids.has(id) || [...nus].some((n) => ids.has(n)) })
  const kappas = Object.values(s.kappas).filter((k) => k.pos_id === id || k.neg_id === id).map((k) => kappaView(k, s, tx))
  return { claim: claimView(c, tx), ancestors: up, successors: down, kappas, events: evs.map((e) => eventView(e, tx, s)) }
}

function kappaList(db, aid, now, query) {
  const s = loadState(db, aid)
  const tx = texts(db, aid)
  const decisions = outcomes(db, aid, s, now)
  const delib = readEvents(db, aid, { types: ['DELIBERATE', 'COEX', 'TRADEOFF'] })
  const list = Object.values(s.kappas)
    .filter((k) => query.get('open') !== '1' || SIGMA_OPEN.includes(k.sigma))
    .map((k) => {
      const ds = delib.filter((e) => e.payload.kappa_id === k.id)
      const last = ds.filter((e) => e.type === 'DELIBERATE').pop()
      const coex = ds.filter((e) => e.type === 'COEX').pop()
      return {
        ...kappaView(k, s, tx),
        deliberations: ds.filter((e) => e.type === 'DELIBERATE').length,
        last_branch: last ? last.payload.branch : null, last_at: last ? last.at : null,
        precedent_ids: last ? last.precedent_ids : [],
        loss: coex ? coex.payload.loss : null,
        outcomes: decisions.filter((d) => d.kappa_id === k.id).map((d) => ({ id: d.id, branch: d.branch, o: d.o, matured_at: d.matured_at })),
      }
    })
    .sort((a, b) => Number(b.open) - Number(a.open) || String(b.last_at || b.opened_at).localeCompare(String(a.last_at || a.opened_at)))
  return { kappas: list }
}

function precedents(db, aid, now) {
  const s = loadState(db, aid)
  const tx = texts(db, aid)
  return {
    precedents: outcomes(db, aid, s, now).map((d) => {
      const k = s.kappas[d.kappa_id]
      return { ...d, q: k ? tx.qs.get(k.q_id) || '' : '', pos: k ? tx.claims.get(k.pos_id) || '' : '', neg: k ? tx.claims.get(k.neg_id) || '' : '' }
    }).reverse(),
  }
}

function predictions(db, aid, now) {
  const s = loadState(db, aid)
  const tx = texts(db, aid)
  const rows = db.prepare('SELECT id, claim_id, expect, observe, p, reg_at, due_at FROM claim_predictions WHERE agent_id=? ORDER BY reg_at DESC').all(aid)
  return {
    predictions: rows.map((r) => {
      const n = s.nus[r.id] || {}
      return { ...r, claim: tx.claims.get(r.claim_id) || '', outcome: n.outcome || 'pending', resolved_at: n.resolved_at || null, overdue: (n.outcome || 'pending') === 'pending' && r.due_at < now }
    }),
  }
}

function events(db, aid, query) {
  const s = loadState(db, aid)
  const tx = texts(db, aid)
  const limit = Math.max(1, Math.min(200, Number(query.get('limit')) || EVENT_PAGE))
  const before = Number(query.get('before')) || null
  const types = (query.get('type') || '').split(',').filter(Boolean)
  const layer = query.get('layer')
  const where = ['agent_id=?']
  const args = [aid]
  if (before) { where.push('seq<?'); args.push(before) }
  if (types.length) { where.push('type IN (' + types.map(() => '?').join(',') + ')'); args.push(...types) }
  if (layer) { where.push('layer=?'); args.push(layer) }
  const rows = db.prepare('SELECT seq FROM claim_events WHERE ' + where.join(' AND ') + ' ORDER BY seq DESC LIMIT ?').all(...args, limit + 1)
  const more = rows.length > limit
  const seqs = rows.slice(0, limit).map((r) => r.seq)
  if (!seqs.length) return { events: [], next_before: null }
  const lo = seqs[seqs.length - 1]
  const hi = seqs[0]
  const want = new Set(seqs)
  const list = readEvents(db, aid, { afterSeq: lo - 1, upToSeq: hi }).filter((e) => want.has(e.seq)).reverse()
  return { events: list.map((e) => eventView(e, tx, s)), next_before: more ? lo : null }
}

function timeline(db, aid, query) {
  const days = Math.max(1, Math.min(3650, Number(query.get('days')) || 90))
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const s = loadState(db, aid)
  const tx = texts(db, aid)
  const quiet = new Set(['JOB_DONE', 'DEGEN_CHECK', 'THETA_ADJUST', 'REVIEW_FLAG', 'EDGE_PROPOSE', 'KAPPA_CANDIDATE', 'KAPPA_QUEUED', 'PENDING_JUDGE', 'DUP', 'REJECT'])
  const evs = readEvents(db, aid).filter((e) => e.at >= since && (query.get('all') === '1' || !quiet.has(e.type)))
  const byDay = new Map()
  for (const e of evs) {
    const d = e.at.slice(0, 10)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d).push(eventView(e, tx, s))
  }
  return { days: [...byDay.entries()].reverse().map(([d, list]) => ({ day: d, events: list.reverse() })) }
}

function epochs(db, aid) {
  const s = loadState(db, aid)
  const tx = texts(db, aid)
  const cuts = readEvents(db, aid, { types: ['CORE_ESTABLISH', 'ELEV_COMMIT'] }).map((e) => ({
    seq: e.seq, at: e.at, layer: e.layer, type: e.type, core: tx.claims.get(((e.payload.claims || [])[0] || {}).id) || '',
    old: e.payload.old_core_id ? tx.claims.get(e.payload.old_core_id) || '' : null, scope: e.payload.scope || null,
  }))
  return { epoch: s.epoch, cuts, summaries: listSummaries(db, aid) }
}

function liveness(db, aid, now) {
  const s = loadState(db, aid)
  const evs = readEvents(db, aid)
  const w = viewWeights(db, aid, now)
  const low = Object.entries(w).filter(([, v]) => v < 1).length
  const layers = {}
  for (const l of LAYERS) {
    layers[l] = { churn: churnOf(db, aid, s, l, now, evs), dogmatic: !!dogmatic(s, evs, l, now) }
  }
  const tunable = readEvents(db, aid, { types: ['THETA_ADJUST'] }).slice(-20).reverse().map((e) => ({ at: e.at, key: e.payload.key, value: e.payload.value, why: e.payload.why || e.payload.rule || null }))
  return {
    qi: qiOf(db, aid, now), user_active: userActive(db, aid, now), layers, low_weight: low, theta_changes: tunable,
    hollow_days: theta(s, 'T_hollow'), r_J: rJOf(db, aid, now),
    calibration: brierOf(s),
  }
}

// ---------- 写 ----------
function putConfig(db, aid, body, role) {
  if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以改三观设置')
  const patch = {}
  if (body.enabled !== undefined) patch.enabled = body.enabled === true
  if (body.budget !== undefined) patch.budget = body.budget
  if (body.model !== undefined) patch.model = body.model
  if (body.replace !== undefined) {
    const want = body.replace || {}
    const turning = ['W', 'L', 'V'].filter((k) => want[k] === 'engine' && sangguanConfig(db, aid).replace[k] !== 'engine')
    if (turning.length && !body.force) {
      const blocked = turning.map((k) => ({ layer: k, ...replaceReady(db, aid, k) })).filter((x) => !x.ok)
      if (blocked.length) err(409, 'NOT_READY', '这一层还没到能切的时候', { layers: blocked })
    }
    patch.replace = want
  }
  if (body.inject !== undefined) {
    if (!['shadow', 'live'].includes(body.inject)) err(400, 'INVALID_ARGUMENT', 'inject 只能是 shadow / live')
    if (body.inject === 'live' && sangguanConfig(db, aid).inject !== 'live' && !body.force) {
      const r = liveReady(db, aid)
      if (!r.ready) err(409, 'SHADOW_NOT_READY', '影子期还没满 ' + r.need + ' 天（已 ' + r.shadow_days + ' 天）；确定要切请带 force', r)
    }
    patch.inject = body.inject
  }
  return { config: publicConfig(setSangguanConfig(db, aid, patch)) }
}

function postVerdict(db, aid, body, now) {
  try {
    return verdict(db, aid, body, now)
  } catch (e) {
    if (e instanceof VerdictError) {
      const st = { OFF: 409, INVALID: 400, NOT_FOUND: 404, TERMINAL: 409 }[e.code] || 400
      err(st, e.code === 'INVALID' ? 'INVALID_ARGUMENT' : e.code, e.message)
    }
    if (e instanceof ConflictError) err(409, 'CONFLICT', '目标刚刚变了，请刷新再试')
    if (e instanceof SangguanError) err(400, 'INVALID_ARGUMENT', e.message, e.details)
    throw e
  }
}

/** 冷启动：用户给还没有核心的层种一句核心（origin=seed）；已有核心的层换核心只能走升维。 */
function postWithdraw(db, aid, id, role, now) {
  if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以撤回种子')
  try {
    return withdrawSeed(db, aid, id, now)
  } catch (e) {
    if (e instanceof SangguanError) err(e.code === 'INVALID' && e.message === '没有这个命题' ? 404 : 409, e.code === 'INVALID' ? 'INVALID_ARGUMENT' : 'CONFLICT', e.message)
    throw e
  }
}

function postSeed(db, aid, body, role, now) {
  if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以种核心')
  const layer = String(body.layer || '')
  if (!LAYERS.includes(layer)) err(400, 'INVALID_ARGUMENT', '层只能是 W / L / V')
  const text = String(body.text || '').trim()
  if (text.length < 4 || text.length > 200) err(400, 'INVALID_ARGUMENT', '核心一句话，4–200 字')
  const s = loadState(db, aid)
  if (Object.values(s.claims).some((c) => c.layer === layer && isCoreKind(layer, c.kind) && !isTerminal(c.status))) {
    err(409, 'HAS_CORE', '这一层已经有核心了；换核心要走升维')
  }
  try {
    const r = append(db, aid, [{ type: 'CLAIM_EXP', layer, actor: 'user', at: now, payload: { claims: [{ layer, kind: CORE_KIND[layer], text, origin: 'seed' }] } }])
    return { ok: true, claim_id: r.entities.claims[0] }
  } catch (e) {
    if (e instanceof SangguanError) err(400, 'INVALID_ARGUMENT', e.message, e.details)
    throw e
  }
}

const OFF = Object.freeze({ enabled: false })

/** sub = '/status' 之类；query = URLSearchParams。 */
export async function route(db, aid, method, sub, query, body = {}, role = 'user') {
  const parts = sub.split('/').filter(Boolean).map(decodeURIComponent)
  const [a, b, c] = parts
  const now = nowIso()
  if (method === 'GET' && (!a || a === 'status')) return status(db, aid, now)
  if (a === 'config') {
    if (method === 'GET') return { config: publicConfig(sangguanConfig(db, aid)) }
    if (method === 'PUT') return putConfig(db, aid, body, role)
    err(405, 'METHOD_NOT_ALLOWED', '只支持 GET / PUT')
  }
  if (!isEnabled(db, aid)) {
    if (method === 'GET') return OFF
    err(409, 'OFF', '三观未开启')
  }
  if (method === 'GET') {
    switch (a) {
      case 'heads': return heads(db, aid, now, query)
      case 'claims':
        if (b && c === 'chain') return chain(db, aid, b)
        if (b && c === 'explain') {
          const r = await explain(db, aid, b, { now, polish: query.get('polish') !== '0' })
          return r || err(404, 'NOT_FOUND', '没有这个命题')
        }
        break
      case 'kappa': return kappaList(db, aid, now, query)
      case 'deliberations': if (b === 'active') return { kappas: kappaList(db, aid, now, new URLSearchParams('open=1')).kappas.filter((k) => k.sigma === 'struggle' || k.sigma === 'sub_trial') }; break
      case 'precedents': return precedents(db, aid, now)
      case 'predictions': return predictions(db, aid, now)
      case 'events': return events(db, aid, query)
      case 'timeline': return timeline(db, aid, query)
      case 'epochs': return epochs(db, aid)
      case 'summaries': return { summaries: listSummaries(db, aid) }
      case 'liveness': case 'vitals': return liveness(db, aid, now)
      case 'inject': if (b === 'preview') return { view: injectView(db, aid, { now, cache: false }), log: injectLog(db, aid), ready: liveReady(db, aid) }; break
      case 'elev': return { proposals: pendingElev(db, aid, now) }
      case 'candidates': return { candidates: pendingList(db, aid) }
      default: break
    }
    err(404, 'NOT_FOUND', '没有这个三观接口')
  }
  if (method === 'POST') {
    if (a === 'verdict') return postVerdict(db, aid, body, now)
    if (a === 'seed') return postSeed(db, aid, body, role, now)
    if (a === 'claims' && b && c === 'withdraw') return postWithdraw(db, aid, b, role, now)
    if (a === 'elev' && b && (c === 'approve' || c === 'reject')) {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以批准或拒绝换核心')
      const r = c === 'approve' ? approveElev(db, aid, b, now) : rejectElev(db, aid, b, now, body.reason || '')
      if (!r.ok) err(r.reason === 'no_proposal' ? 404 : 409, String(r.reason).toUpperCase(), { no_proposal: '没有这个提案', closed: '提案已结束', locked: '旧核心正在交锋，稍后再批', stale: '旧核心已经变了' }[r.reason] || r.reason)
      return r
    }
  }
  err(404, 'NOT_FOUND', '没有这个三观接口')
}