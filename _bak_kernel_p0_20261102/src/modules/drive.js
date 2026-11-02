import { now } from '../db.js'
import { err, nid, agent, active, event, getParam, getFlag, setFlag } from '../kernel.js'
import { runBound } from '../algo/index.js'
import { learnSetpoint, SP_FLOOR, SP_CEIL } from '../algo/deficit.js'
import { affectNeedDeltas, capDayDeltas, E2N_DAY_CAP, moodTilt } from '../algo/affect_need.js'
import { createInboxItem, recordSystemChange, countChangesOnDay } from './selfmod_store.js'
import { computeNeedProxies } from './proxies.js'

const DORMANT_DAYS = 14
const EVENT_CAP = 0.08
const TURN_CAP = 0.15
// 0.04 → 0.12：满足感的自然回落从「25 天才掉光」改成「八天掉光」。
// 回落太慢，日子一好缺口就被抹平，看起来永远不饿——那不是一个活的需求，是一个常数。
const LAMBDA_PER_DAY = 0.12
const MAX_IDLE_DAYS = 30
const UNLOCK_K = { D3: 5, D2: 5, D1: 3, D0: 1 }
const UNLOCK_CLASS = { D3: 'c1', D2: 'c2', D1: 'c3', D0: 'c4' }
const DEFAULT_UNLOCKED = { c1: false, c2: false, c3: false, c4: true }
const DIMS = ['R', 'E', 'C', 'A', 'S']

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}

function clampNum(v, lo, hi, d) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d
}

/**
 * 「平时想待在什么水平」不再是手填的旋钮，而是 drive_state.setpoint 里
 * 它自己长出来的基线（R/E/C/A/S 五个数 + _habit 习惯 + _learn_at）。
 * 老库里没有这几个键时按 0.6 起步，升级后第一次评估会从当下开始学。
 */
function setpointOf(db, aid, row) {
  const fromRow = parseJson(row.setpoint, null)
  const out = {}
  for (const k of DIMS) out[k] = clampNum(fromRow && fromRow[k], SP_FLOOR, SP_CEIL, 0.6)
  out._habit = fromRow && fromRow._habit && typeof fromRow._habit === 'object' ? fromRow._habit : null
  out._learn_at = fromRow && fromRow._learn_at ? String(fromRow._learn_at) : null
  out._moved = fromRow && fromRow._moved && typeof fromRow._moved === 'object' ? fromRow._moved : null
  out._aligned = !!(fromRow && fromRow._aligned === true)
  return out
}

function setpointDims(sp) {
  const out = {}
  for (const k of DIMS) out[k] = sp[k]
  return out
}

/** 性格五轴（数值），给 v1d 的设定点用；老库没有 persona 时返回空对象。 */
function personaNumbers(db, aid) {
  const out = {}
  try {
    const rows = db.prepare("SELECT path,value FROM persona WHERE agent_id=? AND path LIKE 'axis.%'").all(aid)
    for (const r of rows) {
      const v = Number(r.value)
      if (Number.isFinite(v)) out[r.path.slice(5)] = v
    }
  } catch { /* 老库没有 persona */ }
  return out
}

/** 价值观十维（权重），给 v3 的重要度用；老库没有 persona_values 时返回空对象（按 0.1 均匀算）。 */
function valueNumbers(db, aid) {
  const out = {}
  try {
    const rows = db.prepare('SELECT key,weight FROM persona_values WHERE agent_id=?').all(aid)
    for (const r of rows) {
      const v = Number(r.weight)
      if (Number.isFinite(v)) out[r.key] = v
    }
  } catch { /* 老库没有价值观表 */ }
  return out
}

/**
 * 让基线自己长：习惯 = 最近过得怎么样（τ=21 天），基线 = 习惯 + 一点胃口，
 * 再被性格轻轻推一下；每天最多挪 0.02。写回 drive_state.setpoint。
 * INV5：只从真实满足度学，自修改碰不到这里。
 */
/**
 * 胃口的四路外部状态（都不写需求本身，只调「想要多少」）。
 * 每一项都很轻，加起来由 learnSetpoint 统一封顶 ±0.08。
 */
export function appetiteMods(db, aid) {
  const out = { R: 0, E: 0, C: 0, A: 0, S: 0 }
  // ① 关系：越亲近，越把「跟这个人待着」当成需要维护的事；信任再加一点「想被认可」
  try {
    const p = db.prepare("SELECT closeness,trust FROM rel_person WHERE agent_id=? AND tier='owner' AND status='active'").get(aid)
      || db.prepare("SELECT closeness,trust FROM relations WHERE agent_id=? AND kind='owner' ORDER BY closeness DESC LIMIT 1").get(aid)
    const c = Number(p && p.closeness)
    const t = Number(p && p.trust)
    if (Number.isFinite(c)) out.R += 0.06 * (c - 0.5)
    if (Number.isFinite(t)) out.R += 0.03 * (t - 0.5)
  } catch { /* 老库没有关系表 */ }
  // ② 底色：慢情绪的地板。长期偏低 → 安全与关系更想吃；长期偏高 → 探索与自主更想吃
  try {
    const b = Number((db.prepare('SELECT baseline FROM affect_v3 WHERE agent_id=?').get(aid) || {}).baseline)
    if (Number.isFinite(b) && b !== 0) {
      if (b < 0) { out.S += 0.08 * -b; out.R += 0.05 * -b }
      else { out.E += 0.08 * b; out.A += 0.05 * b }
    }
  } catch { /* 老库没有 affect_v3 */ }
  // ③ 工况：过载时所有胃口一起下调（累的时候别要那么多）
  try {
    const cond = db.prepare('SELECT load,state FROM condition_state WHERE agent_id=?').get(aid)
    if (cond && (cond.state === 'overload' || Number(cond.load) > 0.8)) {
      for (const k of DIMS) out[k] -= 0.03
    }
  } catch { /* 老库没有工况表 */ }
  // ④ 浏览：看过的新领域越多，探索的胃口越被撑开（browse_items 还没建时这一项是 0）
  try {
    const n = Number(db.prepare(
      "SELECT COUNT(DISTINCT substr(url,1,40)) n FROM browse_items WHERE agent_id=? AND at > ?",
    ).get(aid, new Date(Date.now() - 3 * 86400000).toISOString()).n)
    if (Number.isFinite(n) && n > 0) out.E += 0.02 * Math.min(1, n / 10)
  } catch { /* P3 之前没有这张表 */ }
  // ⑤ 情绪：不是「此刻高不高兴」，是「最近一直是什么情绪」。
  //   心情不能直接改满足度——每次评估代理都会把满足度往代理值拉（PULL 0.3），
  //   一次 ±0.02 的小步幅活不过下一次评估，等于白改。
  //   胃口是慢变量（按天学），写进去才留得住：长期烦躁不是「自主已经满足了」，
  //   是「对自主的胃口被撑大了」，于是同样的满足度算出来的缺口更大。
  //   取 affect_state 而不是翻事件表：跟提示词、页面上写的是同一个数，不会自相矛盾。
  try {
    const st = db.prepare('SELECT primary_label, intensity FROM affect_state WHERE agent_id=?').get(aid)
    const t = moodTilt(st && st.primary_label, st && st.intensity)
    for (const [dim, v] of Object.entries(t.deltas)) {
      if (DIMS.includes(dim)) out[dim] += v
    }
  } catch { /* 老库没有 affect_state */ }
  for (const k of DIMS) out[k] = Math.max(-0.08, Math.min(0.08, Math.round(out[k] * 1e4) / 1e4))
  return out
}

export function learnDriveSetpoints(db, aid, row, dims) {
  const sp = setpointOf(db, aid, row)
  const last = Date.parse(sp._learn_at || row.last_eval_at || '')
  const dt = Number.isFinite(last) ? clampNum((Date.now() - last) / 86400000, 0, MAX_IDLE_DAYS, 0) : 0
  if (!(dt > 0)) {
    return { learned: false, setpoint: setpointDims(sp), habit: sp._habit || dims, moved: {}, dt_days: 0 }
  }
  const mods = appetiteMods(db, aid)
  const kApp = clampNum(getParam(db, aid, 'drive.setpoint.appetite'), 0.2, 3, 2)
  const out = learnSetpoint({
    dims,
    setpoint: setpointDims(sp),
    habit: sp._habit || undefined,
    persona: personaNumbers(db, aid),
    values: valueNumbers(db, aid),
    mods,
    appetite_k: kApp,
    dt_days: dt,
    align_first: sp._aligned !== true,
  })
  const stored = {
    ...out.setpoint, _habit: out.habit, _moved: out.moved, _mods: out.mods,
    // 胃口拆项按原样存下来（每维 habit/appetite/trait/value/mod）。
    // 页面以前是自己拿 0.08·(1−h/2) 反推的，把倍率 k 忘了 —— 五项加起来 0.700，
    // 而胃口明明写着 0.821，账对不上。账本只该有一个来源：这里。
    _detail: out.detail, _k: kApp,
    _learn_at: now(), _aligned: true,
  }
  db.prepare('UPDATE drive_state SET setpoint=? WHERE agent_id=?').run(JSON.stringify(stored), aid)
  // 基线是按天挪的，一秒内的评估动不到三位小数；只在真的挪动时留事件，别把 events 灌满
  const movedEnough = Object.values(out.moved).some((v) => Math.abs(Number(v)) >= 0.001)
  if (movedEnough) {
    event(db, aid, 'drive.setpoint.learned', {
      setpoint: out.setpoint, habit: out.habit, moved: out.moved, mods: out.mods,
      detail: out.detail, dt_days: out.dt_days,
    })
  }
  return { learned: true, ...out }
}

/** 缺口+分档走 deficit 注册表；调用方不感知版本 */
function runDeficit(db, aid, row) {
  return runBound('deficit', aid, { db, aid }, {
    r: row.r, e: row.e, c: row.c, a: row.a, s: row.s,
    setpoint: setpointDims(setpointOf(db, aid, row)),
    persona: personaNumbers(db, aid),
    values: valueNumbers(db, aid),
    weights_on: String(getParam(db, aid, 'drive.need.weights') ?? 'on') !== 'off',
    smooth_prev: parseJson(row.smooth, null),
    prev_band: row.band || 'D0',
    alpha: 0.35,
  }, String(getParam(db, aid, 'drive.deficit.formula') || 'v3'))
}

function mergeUnlock(prev, band, streak) {
  const next = { ...DEFAULT_UNLOCKED, ...prev }
  const need = UNLOCK_K[band]
  const cls = UNLOCK_CLASS[band]
  if (need != null && cls && Number(streak) >= need) next[cls] = true
  return next
}

export function seedDrive(db, aid) {
  const dims = { R: 0.55, E: 0.55, C: 0.55, A: 0.55, S: 0.6 }
  const setpoint = {
    R: 0.6, E: 0.6, C: 0.6, A: 0.6, S: 0.6,
    _habit: { ...dims }, _moved: { R: 0, E: 0, C: 0, A: 0, S: 0 }, _learn_at: now(),
  }
  db.prepare('INSERT OR REPLACE INTO drive_state(agent_id,r,e,c,a,s,setpoint,band,streak,tokens,tokens_refill_at,last_eval_at,dormant_since,smooth,unlocked) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(aid, dims.R, dims.E, dims.C, dims.A, dims.S, JSON.stringify(setpoint),
      'D0', 0, JSON.stringify({ c1: 0, c2: 0, c3: 0, c4: 4 }), now(), now(), null,
      null, JSON.stringify(DEFAULT_UNLOCKED))
  for (const p of ['send_message', 'browse', 'research', 'remind']) {
    db.prepare('INSERT OR REPLACE INTO action_ports VALUES(?,?,?,?)').run(aid, p, 0, now())
  }
}

/** query：令牌袋（供七闸 G3） */
export function getTokens(db, aid) {
  const d = db.prepare('SELECT tokens FROM drive_state WHERE agent_id=?').get(aid)
  return JSON.parse(d?.tokens || '{}')
}

/** query：冷却是否生效 */
export function hasCooldown(db, aid, scope, key) {
  return !!db.prepare('SELECT 1 FROM cooldowns WHERE agent_id=? AND scope=? AND key=? AND until>?')
    .get(aid, scope, key, now())
}

function idleDays(db, aid) {
  const r = db.prepare('SELECT last_interaction_at FROM agents WHERE id=?').get(aid)
  const v = r && r.last_interaction_at ? Date.parse(r.last_interaction_at) : NaN
  return Number.isFinite(v) ? (Date.now() - v) / 86400000 : 0
}

export function getUnlocked(db, aid) {
  const row = db.prepare('SELECT unlocked FROM drive_state WHERE agent_id=?').get(aid)
  return { ...DEFAULT_UNLOCKED, ...parseJson(row?.unlocked, {}) }
}

/**
 * 满足度结算：真实事件抬升 − 自然回落。
 * deltas: { R?: number, ... }，单次 ≤0.08，本轮合计 ≤0.15；自修改不得传入（INV5）。
 */
export function applySatisfaction(db, aid, deltas = {}, opts = {}) {
  active(db, aid)
  const row = db.prepare('SELECT * FROM drive_state WHERE agent_id=?').get(aid)
  if (!row) err(404, 'NOT_FOUND', '还没有驱力数据')
  const dims = { R: row.r, E: row.e, C: row.c, A: row.a, S: row.s }
  let turnSum = 0
  const applied = {}
  for (const k of ['R', 'E', 'C', 'A', 'S']) {
    let u = Number(deltas[k] || 0)
    if (!Number.isFinite(u) || u === 0) continue
    u = Math.max(-EVENT_CAP, Math.min(EVENT_CAP, u))
    if (turnSum + Math.max(0, u) > TURN_CAP) u = Math.max(0, TURN_CAP - turnSum)
    if (u === 0) continue
    dims[k] = Math.max(0, Math.min(1, Number(dims[k]) + u))
    turnSum += Math.max(0, u)
    applied[k] = u
  }
  // 惰性回落：距上次评估的天数，上限 30
  const lastEval = Date.parse(row.last_eval_at || '')
  let dt = Number.isFinite(lastEval) ? (Date.now() - lastEval) / 86400000 : 0
  if (opts.skipDecay) dt = 0
  dt = Math.max(0, Math.min(MAX_IDLE_DAYS, dt))
  const lambda = Number(opts.lambda ?? clampNum(getParam(db, aid, 'drive.decay.lambda'), 0, 1, LAMBDA_PER_DAY))
  if (dt > 0 && lambda > 0) {
    for (const k of Object.keys(dims)) dims[k] = Math.max(0, Math.min(1, dims[k] - lambda * dt))
  }
  db.prepare('UPDATE drive_state SET r=?, e=?, c=?, a=?, s=? WHERE agent_id=?')
    .run(dims.R, dims.E, dims.C, dims.A, dims.S, aid)
  if (Object.keys(applied).length) event(db, aid, 'drive.satisfaction', { applied, dims, dt })
  return { dims, applied, dt }
}

/** F7：连续三次修复后，安全维回基线（驱动归 drive 域，关系域只调用） */
export function hasDriveState(db, aid) {
  return !!db.prepare('SELECT 1 FROM drive_state WHERE agent_id=?').get(aid)
}

export function getDrive(db, aid) {
  agent(db, aid)
  const row = db.prepare('SELECT * FROM drive_state WHERE agent_id=?').get(aid)
  if (!row) err(404, 'NOT_FOUND', '还没有驱力数据')
  const out = runDeficit(db, aid, row)
  const dims = out.dims
  const ds = out.deficits
  const d = out.D
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +Number(v).toFixed(3)]))
  const last = db.prepare('SELECT last_interaction_at FROM agents WHERE id=?').get(aid)?.last_interaction_at
  const dormant = last ? Date.now() - Date.parse(last) > DORMANT_DAYS * 86400000 : false
  const unlocked = { ...DEFAULT_UNLOCKED, ...parseJson(row.unlocked, {}) }
  const sp = setpointOf(db, aid, row)
  return {
    dims: round(dims), deficits: round(ds), raw: out.raw ? round(out.raw) : undefined,
    D: +d.toFixed(3), band: out.band, stored_band: row.band,
    weights: out.weights ? round(out.weights) : null,
    weight_parts: out.weight_parts || null,
    D_sum: out.D_sum,
    streak: row.streak, tokens: JSON.parse(row.tokens || '{}'), setpoint: setpointDims(sp),
    learn: {
      habit: sp._habit ? round(sp._habit) : null,
      moved: sp._moved ? round(sp._moved) : null,
      mods: sp._mods ? round(sp._mods) : null,
      // 胃口拆项（服务端算的原始值），页面直接照着念，不再自己反推
      detail: sp._detail || null,
      appetite_k: sp._k == null ? null : Number(sp._k),
      at: sp._learn_at,
    },
    smooth: out.smooth ? round(out.smooth) : undefined, unlocked,
    dormant,
    idle_days: last ? +((Date.now() - Date.parse(last)) / 86400000).toFixed(1) : 0,
    algo: out.algo, cooldowns: db.prepare('SELECT * FROM cooldowns WHERE agent_id=? AND until>?').all(aid, now()),
  }
}

/**
 * 情绪 → 驱力（E→N）。只吃「过闸」的情绪事件（doc 7：一条消息不算一条事件），
 * 一天每维封顶 0.06，单次每维 0.02，全部经 applySatisfaction 记账（INV5）。
 *
 * 为什么不用「情绪好坏」直接推五维：效价太粗。同样是「不好」，挫败指向胜任、
 * 烦躁指向自主、困惑指向探索；按效价一刀切，五维会同时抖，等于没有信息。
 */
export function coupleAffectToDrive(db, aid) {
  if (String(getParam(db, aid, 'drive.affect.coupling') ?? 'on') === 'off') {
    return { applied: {}, events: 0, why: '已经关掉' }
  }
  const key = 'e2n.since:' + aid
  const since = String(getFlag(db, key) || '') || new Date(Date.now() - 86400000).toISOString()
  let rows = []
  try {
    rows = db.prepare(
      "SELECT id,at,label,rel,sig,episode_id FROM affect_events WHERE agent_id=? AND gate=1 AND at>? ORDER BY at ASC LIMIT 20",
    ).all(aid, since)
  } catch { rows = [] } // 老库还没有 affect_events
  if (!rows.length) return { applied: {}, events: 0 }

  // 强度用显著性 sig：它本来就是「这一下有多算事」，比单看情绪标签靠谱
  const per = rows.map((r) => affectNeedDeltas({ label: r.label, intensity: r.sig, rel: r.rel }))
  const capped = capDayDeltas(per, E2N_DAY_CAP)
  const lastAt = rows[rows.length - 1].at
  setFlag(db, key, lastAt)
  if (!Object.keys(capped).length) return { applied: {}, events: rows.length, why: '强度不够，不结算' }

  const res = applySatisfaction(db, aid, capped, { skipDecay: true })
  try {
    event(db, aid, 'drive.affect.coupled', {
      applied: res.applied, events: rows.length,
      labels: rows.map((r) => r.label), cap: E2N_DAY_CAP,
    })
  } catch { /* ignore */ }
  return { applied: res.applied, events: rows.length }
}

export function evaluateDrive(db, aid) {
  active(db, aid)
  let row = db.prepare('SELECT * FROM drive_state WHERE agent_id=?').get(aid)
  if (!row) err(404, 'NOT_FOUND', '还没有驱力数据')

  // ① 代理观测 → 满足度增量（INV5：非自修改）；② 惰性回落
  let proxyPack = { proxies: null, detail: null, deltas: {}, v3: null }
  try { proxyPack = computeNeedProxies(db, aid) } catch { /* 代理失败不阻断评估 */ }
  // P2：新传感器先并行（shadow 只写事件，不接管满足度）；on 才真的替换。
  const sensorMode = String(getParam(db, aid, 'drive.sensor.v3') || 'shadow')
  const useV3 = sensorMode === 'on' && !!proxyPack.v3
  applySatisfaction(db, aid, (useV3 ? proxyPack.v3.deltas : proxyPack.deltas) || {}, { skipDecay: false })
  if (proxyPack.v3 && sensorMode !== 'off') {
    try {
      event(db, aid, 'drive.sensor.v3', {
        mode: sensorMode, proxies: proxyPack.v3.proxies, detail: proxyPack.v3.detail,
        v2: proxyPack.proxies,
      })
    } catch { /* 留痕失败不影响评估 */ }
  }
  // ①b 情绪 → 驱力：只吃过了闸的事件，一天每维封顶 0.06
  let affectPack = { applied: {}, events: 0 }
  try { affectPack = coupleAffectToDrive(db, aid) } catch { /* 情绪耦合失败不阻断评估 */ }
  row = db.prepare('SELECT * FROM drive_state WHERE agent_id=?').get(aid)

  const last = db.prepare('SELECT last_interaction_at FROM agents WHERE id=?').get(aid)?.last_interaction_at
  const dormant = last ? Date.now() - Date.parse(last) > 14 * 86400000 : false
  if (dormant) db.prepare('UPDATE drive_state SET dormant_since=COALESCE(dormant_since,?) WHERE agent_id=?').run(now(), aid)
  else db.prepare('UPDATE drive_state SET dormant_since=NULL WHERE agent_id=?').run(aid)

  // ③ 基线从经历里长一点（INV5：非自修改，只读真实满足度）
  const learn = learnDriveSetpoints(db, aid, row, {
    R: row.r, E: row.e, C: row.c, A: row.a, S: row.s,
  })
  row = db.prepare('SELECT * FROM drive_state WHERE agent_id=?').get(aid)

  const out = runDeficit(db, aid, row)
  const dims = out.dims
  const ds = out.deficits
  const d = out.D
  const band = out.band
  // 休眠中不推进解锁累进；醒后照常
  const streak = dormant ? Number(row.streak || 0)
    : (band === row.band ? Number(row.streak) + 1 : 1)
  const prevU = parseJson(row.unlocked, {})
  let resumeLeft = Number(prevU._resume || 0)
  if (dormant) resumeLeft = 3
  else if (resumeLeft > 0) resumeLeft -= 1
  // 休眠醒来后要连续 3 次评估才解锁（地基 §2.3）
  const unlocked = (dormant || resumeLeft > 0)
    ? { ...DEFAULT_UNLOCKED, ...prevU, _resume: resumeLeft }
    : { ...mergeUnlock(prevU, band, streak), _resume: 0 }
  db.prepare('UPDATE drive_state SET band=?, streak=?, last_eval_at=?, smooth=?, unlocked=? WHERE agent_id=?')
    .run(band, streak, now(), JSON.stringify(out.smooth || ds), JSON.stringify(unlocked), aid)
  event(db, aid, 'drive.evaluated', {
    D: d, band, streak, dormant, unlocked, algo: out.algo,
    proxies: proxyPack.proxies, proxy_detail: proxyPack.detail,
    sensor: sensorMode,
    v3: proxyPack.v3 ? { proxies: proxyPack.v3.proxies, detail: proxyPack.v3.detail } : null,
    weights: out.weights, D_sum: out.D_sum, affect: affectPack,
  })
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +Number(v).toFixed(3)]))
  return {
    D: +d.toFixed(3), band, streak, dormant, deficits: round(ds), dims: round(dims), unlocked,
    setpoint: learn.setpoint, learned: learn.learned, moved: learn.moved || {},
    proxies: proxyPack.proxies ? round(proxyPack.proxies) : null,
    proxy_deltas: proxyPack.deltas || {},
    sensor: sensorMode,
    v3: proxyPack.v3 ? { proxies: round(proxyPack.v3.proxies), detail: proxyPack.v3.detail } : null,
    weights: out.weights ? round(out.weights) : null,
    D_sum: out.D_sum,
    affect: affectPack,
    algo: out.algo,
  }
}

/** 只扣令牌，不写变更、不查日限（批准提案时用） */
export function debitToken(db, aid, cls) {
  const key = String(cls || '').toLowerCase()
  if (!CAP[key]) err(400, 'INVALID_ARGUMENT', '令牌类别必须是 c1–c4')
  const tokens = refillTokens(db, aid)
  if (Number(tokens[key] || 0) < 1) err(409, 'BUDGET', '令牌不足', { tokens, class: key })
  tokens[key] = +(Number(tokens[key]) - 1).toFixed(3)
  db.prepare('UPDATE drive_state SET tokens=? WHERE agent_id=?').run(JSON.stringify(tokens), aid)
  event(db, aid, 'token.consumed', { class: key, left: tokens[key], via: 'debit' })
  return { class: key, left: tokens[key], tokens }
}

// ---------------- tokens / ports ----------------
const CAP = { c1: 1, c2: 1, c3: 2, c4: 4 }
// 令牌补充率对齐地基 §3.4：C3 容量 2、每 30 天补 1（不是 15 天）
const RATE = { c1: 1 / 180, c2: 1 / 90, c3: 1 / 30, c4: 4 / 7 }

/** C3 容量由只读参数 guard.budget.c3 定（默认 2）；其余挡位仍用常量。 */
function capOf(db, aid) {
  const cap = { ...CAP }
  try {
    const v = Number(getParam(db, aid, 'guard.budget.c3'))
    if (Number.isFinite(v) && v >= 0) cap.c3 = v
  } catch { /* 老库没有参数表 */ }
  return cap
}

export function refillTokens(db, aid) {
  const row = db.prepare('SELECT * FROM drive_state WHERE agent_id=?').get(aid)
  if (!row) err(404, 'NOT_FOUND', '还没有驱力数据')
  const tokens = JSON.parse(row.tokens || '{}')
  // 休眠规则：连续 14 天无互动，不攒令牌（回来也不能一次大改）
  if (idleDays(db, aid) >= DORMANT_DAYS) return tokens
  const last = Date.parse(row.tokens_refill_at || '')
  const days = Number.isFinite(last) ? Math.max(0, (Date.now() - last) / 86400000) : 0
  const caps = capOf(db, aid)
  for (const k of Object.keys(caps)) tokens[k] = +Math.min(caps[k], Number(tokens[k] || 0) + RATE[k] * days).toFixed(3)
  db.prepare('UPDATE drive_state SET tokens=?, tokens_refill_at=? WHERE agent_id=?').run(JSON.stringify(tokens), now(), aid)
  return tokens
}

export function consumeToken(db, aid, cls) {
  active(db, aid)
  if (!CAP[cls]) err(400, 'INVALID_ARGUMENT', '令牌类别必须是 c1–c4')
  const tokens = refillTokens(db, aid)
  const today = now().slice(0, 10)
  if (countChangesOnDay(db, aid, today) >= 1) err(409, 'COOLDOWN', '今天已经有一次变更，全局每天上限 1')
  if (Number(tokens[cls] || 0) < 1) err(409, 'BUDGET', '令牌不足', { tokens, class: cls })
  tokens[cls] = +(Number(tokens[cls]) - 1).toFixed(3)
  db.prepare('UPDATE drive_state SET tokens=? WHERE agent_id=?').run(JSON.stringify(tokens), aid)
  recordSystemChange(db, aid, 'token.' + cls)
  event(db, aid, 'token.consumed', { class: cls, left: tokens[cls] })
  return { class: cls, left: tokens[cls], tokens }
}

const PORT_NAMES = ['send_message', 'browse', 'research', 'remind']

export function listPorts(db, aid) {
  agent(db, aid)
  const rows = db.prepare('SELECT * FROM action_ports WHERE agent_id=?').all(aid)
  const seen = new Map(rows.map((r) => [r.name, !!r.enabled]))
  // 老实例没有 research 这一行：补一条默认关闭的，界面才不会少一行
  return PORT_NAMES.map((name) => ({ name, enabled: seen.get(name) === true }))
}

export function setPort(db, aid, name, body, role) {
  if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以开关行动接口')
  active(db, aid)
  if (!PORT_NAMES.includes(name)) err(404, 'NOT_FOUND', '行动接口不存在')
  const enabled = body.enabled ? 1 : 0
  db.prepare('INSERT OR REPLACE INTO action_ports VALUES(?,?,?,?)').run(aid, name, enabled, now())
  return { name, enabled: !!enabled }
}

// ---------------- 冷却 / 预算 / 行动（从 features 收回本域） ----------------

export function setCooldown(db, aid, scope, key, days, reason = '') {
  const until = new Date(Date.now() + days * 86400000).toISOString()
  db.prepare('INSERT OR REPLACE INTO cooldowns VALUES(?,?,?,?,?)').run(aid, scope, key, until, reason)
  return { scope, key, until }
}

export function listCooldowns(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM cooldowns WHERE agent_id=? AND until>? ORDER BY until').all(aid, now())
}

export function cooldownActive(db, aid, scope, key) {
  const r = db.prepare('SELECT * FROM cooldowns WHERE agent_id=? AND scope=? AND key=?').get(aid, scope, key)
  return r && r.until > now() ? r : null
}

export function budgetGet(db, aid) {
  agent(db, aid)
  const month = now().slice(0, 7)
  let r = db.prepare('SELECT * FROM budgets WHERE agent_id=?').get(aid)
  if (!r || r.month !== month) {
    db.prepare('INSERT OR REPLACE INTO budgets VALUES(?,?,?,?,?,?,?,?,?)')
      .run(aid, month, 0, 0, 0, 0, 3, 0, now())
    r = db.prepare('SELECT * FROM budgets WHERE agent_id=?').get(aid)
  }
  return r
}

export function budgetSet(db, aid, body) {
  active(db, aid)
  const b = budgetGet(db, aid)
  db.prepare('UPDATE budgets SET money_limit=?, token_limit=?, disturb_limit=?, updated_at=? WHERE agent_id=?')
    .run(Number(body.money_limit ?? b.money_limit), Number(body.token_limit ?? b.token_limit),
      Number(body.disturb_limit ?? b.disturb_limit), now(), aid)
  return budgetGet(db, aid)
}

export function budgetConsume(db, aid, kind, amount = 1) {
  const b = budgetGet(db, aid)
  if (kind === 'disturb' && b.disturb_used + amount > b.disturb_limit) err(409, 'BUDGET', '今日打扰预算已用完')
  if (kind === 'token' && b.token_limit && b.token_used + amount > b.token_limit) err(409, 'BUDGET', 'token 预算已用完')
  if (kind === 'disturb') db.prepare('UPDATE budgets SET disturb_used=disturb_used+?, updated_at=? WHERE agent_id=?').run(amount, now(), aid)
  if (kind === 'token') db.prepare('UPDATE budgets SET token_used=token_used+?, updated_at=? WHERE agent_id=?').run(amount, now(), aid)
  return budgetGet(db, aid)
}

async function postWebhook(url, payload, timeout = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    const text = await r.text()
    return { ok: r.ok, status: r.status, body: text.slice(0, 2000) }
  } finally { clearTimeout(timer) }
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function executeAction(db, aid, body) {
  active(db, aid)
  const port = body.port
  const p = db.prepare('SELECT * FROM action_ports WHERE agent_id=? AND name=?').get(aid, port)
  if (!p || !p.enabled) err(409, 'PERMISSION_REQUIRED', '行动接口未开启', { port })
  const payload = body.payload || {}
  let status = 'failed'
  let result = null
  let note = ''

  if (port === 'send_message') {
    const url = process.env.DSHC_SEND_WEBHOOK
    if (!url) err(409, 'ACTION_UNCONFIGURED', '未配置 DSHC_SEND_WEBHOOK，不能真实发消息')
    result = await postWebhook(url, { agent_id: aid, text: payload.text || '', to: payload.to || null })
    status = result.ok ? 'sent' : 'failed'
    note = result.ok ? 'webhook 已接收' : 'webhook 返回 ' + result.status
  } else if (port === 'browse') {
    const target = String(payload.url || '')
    let u
    try { u = new URL(target) } catch { err(400, 'INVALID_ARGUMENT', 'url 不合法') }
    if (!['http:', 'https:'].includes(u.protocol)) err(400, 'INVALID_ARGUMENT', '只允许 http/https')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const r = await fetch(u, { signal: ctrl.signal, redirect: 'follow' })
      const html = await r.text()
      result = { ok: r.ok, status: r.status, url: u.toString(), title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '', text: stripHtml(html).slice(0, 4000) }
      status = r.ok ? 'fetched' : 'failed'
      note = r.ok ? '已抓取' : 'HTTP ' + r.status
    } finally { clearTimeout(timer) }
  } else if (port === 'remind') {
    const url = process.env.DSHC_REMIND_WEBHOOK
    if (url) {
      result = await postWebhook(url, { agent_id: aid, text: payload.text || '', at: payload.at || null })
      status = result.ok ? 'sent' : 'failed'
      note = result.ok ? '提醒 webhook 已接收' : '提醒 webhook 返回 ' + result.status
    } else {
      const iid = createInboxItem(db, aid, {
        lane: 'todo', refId: null,
        title: payload.text || '它想提醒你一件事', detail: 'remind', priority: 2, ttlDays: 1,
        expiresAt: payload.at || null,
      })
      result = { inbox_id: iid, at: payload.at || null }
      status = 'queued'
      note = '已进收件箱；未配 DSHC_REMIND_WEBHOOK，不会弹系统通知'
    }
  } else {
    err(404, 'NOT_FOUND', '行动接口不存在')
  }

  budgetConsume(db, aid, 'disturb', 1)
  const id = nid('act_')
  db.prepare('INSERT INTO action_log VALUES(?,?,?,?,?,?)')
    .run(id, aid, port, JSON.stringify({ request: payload, result }), status, now())
  event(db, aid, 'action.executed', { action_id: id, port, status })
  return { id, port, status, result, note }
}

export function listActions(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM action_log WHERE agent_id=? ORDER BY created_at DESC LIMIT 50').all(aid)
}

/**
 * 事件驱动的缺口脉冲（6 号 §3 的 E4 与安全维）：
 * - 孤独（久没互动）→ 压低 R 满足度，缺口扩大；每 20 小时最多一次
 * - 新的冲突 / 告警事件 → 压低 S 满足度；每 20 分钟最多一次
 * 只在心跳里调，不参与 evaluateDrive 的常规结算。
 */
export function pulseDriveFromSignals(db, aid) {
  const out = []
  const nowMs = Date.now()
  try {
    const idle = idleDays(db, aid)
    if (idle >= 0.5) {
      const key = 'pulse:lonely:' + aid
      const last = Number(getFlag(db, key) || 0)
      if (nowMs - last > 20 * 3600000) {
        // C5（9 号 §6）：越亲近，久不见越孤独；没有亲近的人，孤独是常态但没那么刺
        let close = 0.5
        try {
          const p = db.prepare("SELECT closeness FROM rel_person WHERE agent_id=? AND tier='owner' AND status='active'").get(aid)
            || db.prepare("SELECT closeness FROM relations WHERE agent_id=? AND kind='owner' ORDER BY closeness DESC LIMIT 1").get(aid)
          if (p && Number.isFinite(Number(p.closeness))) close = Number(p.closeness)
        } catch { /* 老库没有关系表 */ }
        const delta = +((0.004 + 0.016 * Math.min(1, idle / 7)) * (0.5 + close)).toFixed(3)
        const r = nudgeDeficit(db, aid, 'r', -delta)
        if (r) {
          setFlag(db, key, String(nowMs))
          out.push({ kind: 'lonely', dim: 'R', delta: -delta })
          try { event(db, aid, 'drive.pulse', { kind: 'lonely', dim: 'R', delta: -delta, idle_days: +idle.toFixed(2) }) } catch { /* ignore */ }
        }
      }
    }
  } catch { /* 单条失败跳过 */ }
  try {
    const key = 'pulse:safety:' + aid
    const last = Number(getFlag(db, key) || 0)
    const since = new Date(last || 0).toISOString()
    const n = Number(db.prepare(
      "SELECT COUNT(*) n FROM events WHERE agent_id=? AND type IN ('memory.conflict','alert.opened','condition.overload') AND created_at>?",
    ).get(aid, since).n || 0)
    if (n > 0 && nowMs - last > 20 * 60000) {
      const delta = +Math.min(0.02, 0.01 * n).toFixed(3)
      const s = nudgeDeficit(db, aid, 's', -delta)
      if (s) {
        setFlag(db, key, String(nowMs))
        out.push({ kind: 'safety', dim: 'S', delta: -delta, events: n })
        try { event(db, aid, 'drive.pulse', { kind: 'safety', dim: 'S', delta: -delta, events: n }) } catch { /* ignore */ }
      }
    }
  } catch { /* 单条失败跳过 */ }
  return out
}

/** 外部事件推一下某个维度（0..1）。delta>0 抬高满足度（缺口变小）；delta<0 压低满足度（缺口扩大）。 */
export function nudgeDeficit(db, aid, dim, delta) {
  const key = String(dim || 'e').toLowerCase()
  if (!['r', 'e', 'c', 'a', 's'].includes(key)) return null
  const row = db.prepare('SELECT * FROM drive_state WHERE agent_id=?').get(aid)
  if (!row) return null
  const cur = Number(row[key] || 0)
  const next = Math.max(0, Math.min(1, Math.round((cur + Number(delta || 0)) * 1000) / 1000))
  db.prepare('UPDATE drive_state SET ' + key + '=? WHERE agent_id=?').run(next, aid)
  return { dim: key, from: cur, to: next }
}
