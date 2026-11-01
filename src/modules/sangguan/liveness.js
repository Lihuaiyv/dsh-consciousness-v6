/**
 * 活性机制 L1–L11（logic-gates §13；code-guide N6 / N8 / W1–W3）。三层规范：宪法（闸门与不变式）永不自改；
 * 法规（带 * 的 Θ）只经 L5 慢调：每周每参数 ≤10%、不出范围、样本 < 10 不调；判例（先例池）自由积累。
 * 动静（L11 / P20）：用户近 7 日 < 3 轮对话 → 静：不求证、不 probe、不补跨层边，无输入时不空转。
 * 活性只提案（P14）：probe / abduce 候选一律走 W1–W5；INQUIRY 不迁移任何 status。
 * 情绪隔离（P15）：L3 惊奇只调审议优先级，不进 π、不当证据。
 */
import { CORE_KIND, BELT_KINDS, LAYERS, SIGMA_OPEN, isCoreKind, isTerminal } from './catalog.js'
import { theta, eOf } from './fold.js'
import { THETA, inRange } from './theta.js'
import { loadState, listHeads } from './projection.js'
import { append, readEvents } from './ledger.js'
import { call } from './llm.js'
import { jaccard } from './sim.js'
import { coreTargets, mOf } from './practice.js'
import { placeOne } from './fast.js'
import { askBlocked } from './intake.js'
import './templates.js'

const DAY = 86400000
const ago = (now, d) => new Date(Date.parse(now) - d * DAY).toISOString()
const daysSince = (at, now) => (Date.parse(now) - Date.parse(at)) / DAY
const CREATES = ['CLAIM_EXP', 'REV', 'SUB_ACCEPT', 'CORE_ESTABLISH', 'ELEV_COMMIT']
const STALE_DAYS = 30
const ABD_SIM = 0.5

// ---------- 读 ----------
/** 用户活跃 ⇔ 近 7 日 ≥ 3 轮用户发言。opt.userActive / opt.userTurns7d 可覆盖（模拟与测试）。 */
export function userActive(db, aid, now, opt = {}) {
  if (typeof opt.userActive === 'boolean') return opt.userActive
  if (typeof opt.userTurns7d === 'number') return opt.userTurns7d >= 3
  try {
    const n = db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE agent_id=? AND role='user' AND created_at>? AND created_at<=?").get(aid, ago(now, 7), now).n
    return n >= 3
  } catch { return false }
}

function bornAt(evs) {
  const out = {}
  for (const e of evs) if (CREATES.includes(e.type)) for (const c of e.payload.claims || []) out[c.id] = e.at
  return out
}

const texts = (db, aid) => new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
const stale = (c, born, now) => daysSince(c.last_ev_at || born[c.id] || now, now) >= STALE_DAYS
const pendingNu = (s, id) => Object.values(s.nus).some((n) => n.claim_id === id && n.outcome === 'pending')

/** L8 Hollow(c) ⇔ age > T_hollow ∧ n = 0 ∧ 无 pending ν。 */
export function hollow(s, c, born, now) {
  return !!born[c.id] && daysSince(born[c.id], now) > theta(s, 'T_hollow') && c.n === 0 && !pendingNu(s, c.id)
}

/** L7 / L8：注入权重视图（只改排序，不改 status，不写事件）。 */
export function viewWeights(db, aid, now) {
  const s = loadState(db, aid)
  const born = bornAt(readEvents(db, aid, { types: CREATES }))
  const out = {}
  for (const c of Object.values(s.claims)) {
    if (isTerminal(c.status)) continue
    let w = 1
    if (!isCoreKind(c.layer, c.kind) && c.n_dep === 0 && stale(c, born, now)) {
      w *= 0.5
      // 连续 90 日 stale 再减半
      if (daysSince(c.last_ev_at || born[c.id] || now, now) >= STALE_DAYS + 90) w *= 0.5
    }
    if (hollow(s, c, born, now)) w *= 0.5
    out[c.id] = Math.max(0.1, w)
  }
  return out
}

/** L3：近期惊奇 ν（surprise ≥ θ_surp）落在 CoreTarget 上 → 相关 κ 优先级 ×2（自上次审议以来）。 */
export function surpriseBoost(db, aid, s, now) {
  const thr = theta(s, 'theta_surp')
  const hot = new Map()
  const targets = new Set(LAYERS.flatMap((l) => [...coreTargets(s, l)]))
  for (const e of readEvents(db, aid, { types: ['NU_RESOLVE'] })) {
    if (e.at > now || !(e.payload.surprise >= thr)) continue
    const n = s.nus[e.payload.nu_id]
    if (n && targets.has(n.claim_id)) hot.set(n.claim_id, Math.max(hot.get(n.claim_id) || 0, e.seq))
  }
  const out = {}
  for (const k of Object.values(s.kappas)) {
    if (!SIGMA_OPEN.includes(k.sigma)) continue
    const seq = Math.max(hot.get(k.pos_id) || 0, hot.get(k.neg_id) || 0)
    if (seq && seq > (k.last_delib_seq || 0)) out[k.id] = 2
  }
  return out
}

// ---------- L1 求证 ----------
function voiList(s, born, now, recent) {
  const out = []
  const floor = (e) => Math.max(0.1, e)
  // 在开 κ 的两极由 κ 条目代表，不再单独求证
  const poles = new Set()
  for (const k of Object.values(s.kappas)) if (SIGMA_OPEN.includes(k.sigma)) { poles.add(k.pos_id); poles.add(k.neg_id) }
  for (const k of Object.values(s.kappas)) {
    if (!['suspended', 'sub_trial'].includes(k.sigma) || recent.has(k.id)) continue
    const a = s.claims[k.pos_id]
    const b = s.claims[k.neg_id]
    if (!a || !b) continue
    const v = floor(Math.max(eOf(a), eOf(b))) * (1 - Math.abs(a.pi - b.pi)) * (1 + 0.5 * (stale(a, born, now) || stale(b, born, now) ? 1 : 0))
    out.push({ type: 'kappa', id: k.id, layer: k.layer, voi: v, claim: Math.abs(a.pi) <= Math.abs(b.pi) ? a : b })
  }
  for (const c of Object.values(s.claims)) {
    if (c.status !== 'active' || recent.has(c.id) || poles.has(c.id)) continue
    const v = floor(eOf(c)) * (1 - Math.abs(c.pi)) * (1 + 0.5 * (stale(c, born, now) ? 1 : 0)) * (1 + 0.5 * (hollow(s, c, born, now) ? 1 : 0))
    out.push({ type: 'claim', id: c.id, layer: c.layer, voi: v, claim: c })
  }
  return out.filter((x) => x.voi > 1e-9).sort((a, b) => b.voi - a.voi || (a.id < b.id ? -1 : 1))
}

/** N6 / L1：VOI 前 N_inq 条，J13 选 ν / 检索 / 提问。提问受 Q_ask/日 与同目标冷却 T_ask 限制。 */
export async function inquire(db, aid, now, opt = {}) {
  if (!userActive(db, aid, now, opt)) return { did: [], skipped: 'quiet' }
  const s = loadState(db, aid)
  const evs = readEvents(db, aid, { types: [...CREATES, 'INQUIRY'] })
  const born = bornAt(evs)
  const inq = evs.filter((e) => e.type === 'INQUIRY')
  const recent = new Set(inq.filter((e) => e.at > ago(now, theta(s, 'T_ask'))).map((e) => e.payload.target_id))
  let asked = inq.filter((e) => e.payload.mode === 'ask' && e.at.slice(0, 10) === String(now).slice(0, 10)).length
  const qAsk = Math.round(theta(s, 'Q_ask'))
  const N = opt.boost ? THETA.N_inq[1][1] : Math.round(theta(s, 'N_inq'))
  const tx = texts(db, aid)
  const did = []
  for (const t of voiList(s, born, now, recent).slice(0, N)) {
    const allowAsk = asked < qAsk
    const input = {
      layer: t.layer, allow_ask: allowAsk,
      target: t.type === 'kappa'
        ? { type: 'kappa', pos: tx.get(s.kappas[t.id].pos_id) || '', neg: tx.get(s.kappas[t.id].neg_id) || '' }
        : { type: 'claim', text: tx.get(t.id) || '', pi: t.claim.pi, n: t.claim.n },
    }
    const r = await call({ db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat }, 'J13', input)
    if (!r.ok && r.code === 'BUDGET') break
    if (!r.ok) continue
    const o = r.out
    if (o.mode === 'ask' && askBlocked(db, aid)) { did.push({ id: t.id, skipped: 'cooldown' }); continue }
    const head = { type: 'INQUIRY', layer: t.layer, actor: 'judge', at: now, payload: { target_type: t.type, target_id: t.id, mode: o.mode, voi: +t.voi.toFixed(4), boost: !!opt.boost } }
    if (o.mode === 'ask') { head.payload.question = o.question; asked++ }
    if (o.mode === 'search') head.payload.query = o.query
    const batch = [head]
    if (o.mode === 'nu') {
      head.payload.claim_id = t.claim.id
      batch.push({
        type: 'NU_REGISTER', actor: 'judge', at: now,
        payload: { inquiry_id: t.id, nus: [{ claim_id: t.claim.id, expect: o.nu.expect, observe: o.nu.observe, p: o.nu.p, due_at: new Date(Date.parse(now) + o.nu.due_days * DAY).toISOString() }] },
      })
    }
    try {
      append(db, aid, batch, { claims: { [t.claim.id]: t.claim.status } })
      did.push({ target: t.id, mode: o.mode })
    } catch { /* 目标刚迁移：下夜再说 */ }
  }
  return { did }
}

// ---------- L6 溯因 ----------
/** 近 30 日、绑定命题已终态（无在世链头能解释）的证据，按目标文本聚类；簇 ≥ n_abd → J15 提溯因候选。每夜至多 1 次。 */
export async function abduce(db, aid, now, opt = {}) {
  if (!userActive(db, aid, now, opt)) return { did: [], skipped: 'quiet' }
  const s = loadState(db, aid)
  const tx = texts(db, aid)
  const used = new Set()
  for (const e of readEvents(db, aid, { types: ['CLAIM_EXP', 'DUP', 'REJECT', 'PENDING_JUDGE', 'REV'] })) {
    for (const r of e.refs || []) if (String(r).startsWith('abduce:')) used.add(String(r).slice(7))
  }
  const nuClaim = {}
  for (const n of Object.values(s.nus)) nuClaim[n.id] = n.claim_id
  const orphan = []
  for (const e of readEvents(db, aid, { types: ['EVIDENCE'] })) {
    if (e.at <= ago(now, STALE_DAYS) || e.at > now) continue
    for (const x of e.payload.evidence || []) {
      if (x.derived_from || used.has(x.id)) continue
      const cid = x.target_type === 'nu' ? nuClaim[x.target_id] : x.target_id
      const c = s.claims[cid]
      if (c && isTerminal(c.status)) orphan.push({ id: x.id, layer: c.layer, sign: x.sign, kind: x.kind, about: tx.get(cid) || '' })
    }
  }
  const clusters = []
  for (const x of orphan) {
    const hit = clusters.find((k) => k.layer === x.layer && jaccard(k.lead, x.about) >= ABD_SIM)
    if (hit) hit.items.push(x)
    else clusters.push({ layer: x.layer, lead: x.about, items: [x] })
  }
  const big = clusters.filter((k) => k.items.length >= theta(s, 'n_abd')).sort((a, b) => b.items.length - a.items.length)[0]
  if (!big) return { did: [] }
  const r = await call({ db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat }, 'J15', { layer: big.layer, evidence: big.items.slice(0, 16) })
  if (!r.ok) return { did: [], failed: r.code }
  const x = { layer: big.layer, kind: BELT_KINDS[big.layer][0], text: r.out.text, origin: 'abduce', nu: r.out.nu || [] }
  const placed = await placeOne({ db, aid, at: now, chat: opt.chat, embed: opt.embed }, x, r.out.explains.map((id) => 'abduce:' + id))
  return { did: [{ cls: placed.cls, explains: r.out.explains.length }] }
}

// ---------- §12 反复横跳 ----------
/** 新命题与祖先链（pred 回溯 2–4 步；1 步是正常修订）中某终态命题 sim ≥ θ_dup → FLIP；同一 q 90 日内 ≥ 2 次 → 局部 n_min+2、δ_π+0.1。 */
export function flipCheck(db, aid, now, sinceSeq = 0) {
  const s = loadState(db, aid)
  const tx = texts(db, aid)
  const dup = theta(s, 'theta_dup')
  const flips = readEvents(db, aid, { types: ['FLIP'] })
  const flagged = new Set(flips.map((e) => e.payload.claim_id))
  const qOf = (id) => {
    const c = s.claims[id]
    if (c && c.q_id) return c.q_id
    const k = Object.values(s.kappas).filter((x) => x.pos_id === id || x.neg_id === id).pop()
    return k ? k.q_id : null
  }
  const did = []
  for (const c of Object.values(s.claims)) {
    if (c.born_seq <= sinceSeq || flagged.has(c.id) || isTerminal(c.status)) continue
    let frontier = [...c.pred]
    let hit = null
    for (let depth = 1; depth <= 4 && frontier.length && !hit; depth++) {
      const next = []
      for (const id of frontier) {
        const a = s.claims[id]
        if (!a) continue
        if (depth >= 2 && isTerminal(a.status) && jaccard(tx.get(c.id), tx.get(id)) >= dup - 1e-9) { hit = a; break }
        next.push(...a.pred)
      }
      frontier = next
    }
    if (!hit) continue
    const q = qOf(c.id) || qOf(hit.id)
    append(db, aid, [{ type: 'FLIP', layer: c.layer, actor: 'sys', at: now, payload: { claim_id: c.id, ancestor_id: hit.id, q_id: q } }])
    did.push({ claim_id: c.id, ancestor_id: hit.id, q_id: q })
    if (!q) continue
    const n90 = readEvents(db, aid, { types: ['FLIP'] }).filter((e) => e.payload.q_id === q && e.at > ago(now, 90)).length
    const scope = 'q:' + q
    const st = loadState(db, aid)
    if (n90 < 2 || st.theta['n_min@' + scope]) continue
    const nMin = Math.min(THETA.n_min[1][1], theta(st, 'n_min', c.layer) + 2)
    const dPi = Math.min(THETA.delta_pi[1][1], theta(st, 'delta_pi', c.layer) + 0.1)
    append(db, aid, [
      { type: 'THETA_ADJUST', actor: 'sys', at: now, payload: { key: 'n_min', value: nMin, scope, rule: 'flip', old: theta(st, 'n_min', c.layer), metric: { flips_90d: n90 } } },
      { type: 'THETA_ADJUST', actor: 'sys', at: now, payload: { key: 'delta_pi', value: dPi, scope, rule: 'flip', old: theta(st, 'delta_pi', c.layer), metric: { flips_90d: n90 } } },
    ])
  }
  return { did }
}

// ---------- L5 稳态 ----------
const CHURN_TYPES = ['REV', 'CON', 'SUB_CONFIRM', 'ELEV_COMMIT']

export function churnOf(db, aid, s, layer, now, evs) {
  const heads = listHeads(db, aid, layer).length
  const n = evs.filter((e) => e.layer === layer && CHURN_TYPES.includes(e.type) && e.at > ago(now, 30) && e.at <= now).length
  return { heads, n, churn: heads ? n / heads : null }
}

/** Dogmatic(ℓ) ⇔ 有核心 ∧ 最老核心 ≥ T_dog ∧ T_dog 内无涉及核心的 KAPPA_OPEN ∧ m=0 ∧ 核心无新 ν。 */
export function dogmatic(s, evs, layer, now) {
  const Tdog = theta(s, 'T_dog')
  const cores = Object.values(s.claims).filter((c) => c.layer === layer && isCoreKind(layer, c.kind) && c.status === 'active')
  if (!cores.length) return false
  const born = bornAt(evs)
  const oldest = Math.max(...cores.map((c) => (born[c.id] ? daysSince(born[c.id], now) : 0)))
  if (oldest < Tdog) return false
  const ids = new Set(cores.map((c) => c.id))
  const since = ago(now, Tdog)
  const opened = evs.some((e) => e.type === 'KAPPA_OPEN' && e.at > since && (e.payload.kappas || []).some((k) => ids.has(k.pos_id) || ids.has(k.neg_id)))
  const newNu = evs.some((e) => e.type === 'NU_REGISTER' && e.at > since && (e.payload.nus || []).some((n) => ids.has(n.claim_id)))
  return !opened && !newNu && mOf(s, layer, evs) === 0
}

/** 单参数一步：±10%，夹在可调范围内；变化为 0 不写。 */
function stepTheta(s, key, scope, layer, dir, rule, metric) {
  const old = theta(s, key, layer, scope)
  const [lo, hi] = THETA[key][1]
  const value = +Math.min(hi, Math.max(lo, old * (1 + 0.1 * dir))).toFixed(6)
  if (Math.abs(value - old) < 1e-9 || !inRange(key, value)) return null
  return { type: 'THETA_ADJUST', layer: layer || null, actor: 'sys', at: null, payload: { key, value, scope, old, rule, metric, window: rule === 'rollback' ? '90d' : '30d' } }
}

/** W1 / L5：按 §13.1 表调可调参数。每周每参数至多一步。opt.rJ 给出判定可靠度（G4 用户覆盖）时才用 r_J 规则。 */
export function homeostasis(db, aid, now, opt = {}) {
  const s = loadState(db, aid)
  const evs = readEvents(db, aid)
  const touched = new Set()
  const out = []
  const push = (ev) => {
    if (!ev) return
    const k = ev.payload.key + '@' + ev.payload.scope
    if (touched.has(k)) return
    touched.add(k)
    ev.at = now
    out.push(ev)
  }
  const cLo = theta(s, 'c_lo')
  const cHi = theta(s, 'c_hi')
  const info = {}
  for (const layer of LAYERS) {
    const ch = churnOf(db, aid, s, layer, now, evs)
    const dog = dogmatic(s, evs, layer, now)
    info[layer] = { ...ch, dogmatic: dog }
    if (ch.churn == null || ch.heads < 10) continue
    const metric = { churn: +ch.churn.toFixed(4), heads: ch.heads, n: ch.n }
    if (ch.churn > cHi) {
      push(stepTheta(s, 'n_min', layer, layer, +1, 'churn_high', metric))
      push(stepTheta(s, 'delta_pi', layer, layer, +1, 'churn_high', metric))
      push(stepTheta(s, 'prior_SUB.' + layer, '*', layer, -1, 'churn_high', metric))
    } else if (ch.churn < cLo && dog) {
      push(stepTheta(s, 'N_inq', '*', null, +1, 'churn_low', metric))
      info[layer].allowProbe = true
    }
  }
  // 近 90 日 SUB 回滚率
  for (const layer of LAYERS) {
    const conf = evs.filter((e) => e.layer === layer && e.type === 'SUB_CONFIRM' && e.at > ago(now, 90)).length
    const roll = evs.filter((e) => e.layer === layer && e.type === 'SUB_ROLLBACK' && e.at > ago(now, 90)).length
    if (conf + roll >= 10 && roll / (conf + roll) > 0.5) {
      const metric = { rollback: roll, confirm: conf }
      push(stepTheta(s, 'prior_SUB.' + layer, '*', layer, -1, 'rollback', metric))
      push(stepTheta(s, 'N_trial', '*', null, +1, 'rollback', metric))
    }
  }
  // 先例是否有用：被先例改变选择的决策平均 o 与未改变的比
  if (opt.outcomes) {
    const ds = opt.outcomes.filter((d) => d.o !== 0)
    const byId = new Map(evs.filter((e) => e.type === 'DELIBERATE').map((e) => [e.id, e]))
    const ch = []
    const un = []
    for (const d of ds) {
      const e = byId.get(d.id)
      if (!e || !e.payload.b_noprec) continue
      ;(e.payload.b_noprec !== e.payload.branch ? ch : un).push(d.o)
    }
    if (ch.length + un.length >= 10 && ch.length && un.length) {
      const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length
      const dir = avg(ch) < avg(un) ? -1 : +1
      push(stepTheta(s, 'lambda', '*', null, dir, 'precedent', { changed: ch.length, unchanged: un.length, o_changed: avg(ch), o_unchanged: avg(un) }))
    }
  }
  if (typeof opt.rJ === 'number' && opt.rJ < 0.8) push(stepTheta(s, 'N_delib', '*', null, -1, 'r_J', { r_J: opt.rJ }))
  if (out.length) append(db, aid, out)
  return { adjust: out.map((e) => e.payload), info }
}

// ---------- L2 / L9 自我质疑 ----------
/** 每层每周至多 1 条 probe 候选（Dogmatic 的最老核心，或 Extreme 的命题）；用户不活跃不做（P20）。 */
export async function selfDoubt(db, aid, now, opt = {}) {
  if (!userActive(db, aid, now, opt)) return { did: [], skipped: 'quiet' }
  const s = loadState(db, aid)
  const evs = readEvents(db, aid)
  const born = bornAt(evs)
  const tx = texts(db, aid)
  const Tdog = theta(s, 'T_dog')
  const did = []
  for (const layer of LAYERS) {
    let target = null
    let why = null
    const allow = (opt.allowProbe && opt.allowProbe[layer]) || opt.move
    if (allow && dogmatic(s, evs, layer, now)) {
      const cores = Object.values(s.claims).filter((c) => c.layer === layer && c.kind === CORE_KIND[layer] && c.status === 'active')
      target = cores.sort((a, b) => (born[a.id] || '').localeCompare(born[b.id] || ''))[0]
      why = 'dogmatic'
    }
    if (!target) {
      // L9 物极必反：π ≥ π_ext 且 T_dog 内无反证
      const negAt = {}
      for (const e of evs) if (e.type === 'EVIDENCE' && e.at > ago(now, Tdog)) for (const x of e.payload.evidence || []) if (x.sign < 0) negAt[x.target_id] = true
      target = Object.values(s.claims).filter((c) => c.layer === layer && c.status === 'active' && c.pi >= theta(s, 'pi_ext') - 1e-9 && !negAt[c.id])
        .sort((a, b) => b.pi - a.pi)[0] || null
      why = target ? 'extreme' : null
    }
    if (!target) continue
    const r = await call({ db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat }, 'J14', { layer, claim: { id: target.id, text: tx.get(target.id) || '', pi: target.pi }, why })
    if (!r.ok && r.code === 'BUDGET') break
    if (!r.ok) continue
    const x = { layer, kind: BELT_KINDS[layer][0], text: r.out.text, origin: 'probe', q_hint: r.out.q }
    const placed = await placeOne({ db, aid, at: now, chat: opt.chat, embed: opt.embed }, x, [])
    // probe 按构造就是 target 的反命题：近邻没检到也要记矛盾候选
    if (placed.id && !(placed.targets || []).includes(target.id)) {
      try {
        append(db, aid, [{ type: 'KAPPA_CANDIDATE', layer, actor: 'sys', at: now, payload: { a_id: target.id, b_id: placed.id } }])
      } catch { /* target 刚终态 */ }
    }
    did.push({ layer, why, target: target.id, cls: placed.cls })
  }
  return { did }
}

// ---------- L10 相生相克 ----------
/** 生(ℓ) = 他层指向 ℓ 的 DEPENDS + PRESSURE；克(ℓ) = 他层指向 ℓ 的 CONSTRAINS。任一为 0 且持续 T_bal → J17 补边（每周 1 次）。 */
export function balanceOf(s, layer) {
  let sheng = 0
  let ke = 0
  for (const e of Object.values(s.edges)) {
    if (!e.active) continue
    const to = s.claims[e.to_id]
    const from = s.claims[e.from_id]
    if (!to || !from || to.layer !== layer || from.layer === layer) continue
    if (e.type === 'DEPENDS' || e.type === 'PRESSURE') sheng++
    if (e.type === 'CONSTRAINS') ke++
  }
  return { sheng, ke }
}

export async function balance(db, aid, now, opt = {}) {
  if (!userActive(db, aid, now, opt)) return { did: [], skipped: 'quiet' }
  const s = loadState(db, aid)
  const evs = readEvents(db, aid, { types: [...CREATES, 'EDGE_ADD'] })
  const born = bornAt(evs)
  const Tbal = theta(s, 'T_bal')
  const since = ago(now, Tbal)
  const lacking = []
  for (const layer of LAYERS) {
    const b = balanceOf(s, layer)
    if (b.sheng > 0 && b.ke > 0) continue
    const heads = listHeads(db, aid, layer)
    const old = heads.some((h) => born[h.id] && born[h.id] <= since)
    const recentEdge = evs.some((e) => e.type === 'EDGE_ADD' && e.at > since && (e.payload.edges || []).some((x) => s.claims[x.to_id] && s.claims[x.to_id].layer === layer && s.claims[x.from_id] && s.claims[x.from_id].layer !== layer))
    if (heads.length && old && !recentEdge) lacking.push({ layer, ...b })
  }
  if (!lacking.length) return { did: [] }
  const heads = LAYERS.flatMap((l) => listHeads(db, aid, l).slice(0, 8).map((h) => ({ id: h.id, layer: l, kind: h.kind, text: h.text })))
  if (new Set(heads.map((h) => h.layer)).size < 2) return { did: [] }
  const r = await call({ db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat }, 'J17', { lacking, heads })
  if (!r.ok) return { did: [], failed: r.code }
  const did = []
  for (const e of r.out.edges) {
    const edge = { type: e.type, from_id: e.from_id, to_id: e.to_id }
    try {
      append(db, aid, [
        { type: 'EDGE_PROPOSE', actor: 'judge', at: now, payload: { edge, reason: e.reason || null } },
        { type: 'EDGE_ADD', actor: 'judge', at: now, payload: { edges: [edge] } },
      ])
      did.push(edge)
    } catch (err) {
      // DEPENDS 成环或端点已终态：只留提案记录
      append(db, aid, [{ type: 'EDGE_PROPOSE', actor: 'judge', at: now, payload: { edge, reason: e.reason || null, rejected: String(err.message).slice(0, 80) } }])
    }
  }
  return { did, lacking }
}

// ---------- L11 气 ----------
/** Qi = (flow · open · learn · bal)^¼，各因子先取 max(·, 0.05)。 */
export function qiOf(db, aid, now) {
  const s = loadState(db, aid)
  const evs = readEvents(db, aid)
  const in7 = evs.filter((e) => e.type !== 'JOB_DONE' && e.at > ago(now, 7) && e.at <= now).length
  const in30 = (t) => evs.filter((e) => e.type === t && e.at > ago(now, 30) && e.at <= now).length
  const flow = Math.min(1, in7 / theta(s, 'F0'))
  const open = Math.min(1, (in30('KAPPA_OPEN') + in30('INQUIRY')) / theta(s, 'O0'))
  const resolved = evs.filter((e) => e.type === 'NU_RESOLVE' && ['hit', 'miss'].includes(e.payload.outcome) && e.at > ago(now, 30) && e.at <= now).length
  const due = db.prepare('SELECT COUNT(*) n FROM claim_predictions WHERE agent_id=? AND due_at>? AND due_at<=?').get(aid, ago(now, 30), now).n
  const learn = due ? Math.min(1, resolved / Math.max(1, due)) : 1
  const cLo = theta(s, 'c_lo')
  const cHi = theta(s, 'c_hi')
  const chs = LAYERS.map((l) => churnOf(db, aid, s, l, now, evs).churn).filter((x) => x != null)
  const churn = chs.length ? chs.reduce((a, b) => a + b, 0) / chs.length : cLo
  const dist = churn < cLo ? cLo - churn : churn > cHi ? churn - cHi : 0
  const bal = Math.max(0, Math.min(1, 1 - dist / cHi))
  const f = { flow, open, learn, bal }
  const qi = Math.pow(Object.values(f).reduce((a, v) => a * Math.max(v, 0.05), 1), 0.25)
  return { qi: +qi.toFixed(4), ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, +v.toFixed(4)])) }
}

/** 动：Qi < Qi_lo 连续 7 夜且用户活跃。历史 Qi 取自 sg:night 的 JOB_DONE。 */
export function moveOf(db, aid, now, qiNow, opt = {}) {
  const s = loadState(db, aid)
  const lo = theta(s, 'Qi_lo')
  const hist = readEvents(db, aid, { types: ['JOB_DONE'] }).filter((e) => String(e.job_key).startsWith('sg:night:') && e.at > ago(now, 7))
  const series = [...hist.map((e) => (e.payload.qi || {}).qi), qiNow]
  return series.length >= 7 && series.slice(-7).every((q) => typeof q === 'number' && q < lo) && userActive(db, aid, now, opt)
}
