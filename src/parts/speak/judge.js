/**
 * 主动开口 · 判断（零件内）
 *
 * 回答「现在该不该开口」：12 道门 + 缺口/真事/时机算分，benefit > cost 才说。
 * 只读状态，不改库；输出 will / reason / gates / intent / score / input。
 *
 * 共享件只 import 不搬：情绪、驱力、人格轴、关系主动性、预算服务、参数、flags。
 * 事由由 ./trigger.js 给；额度记账在 ./budget.js；偏好见 ./prefs.js。
 */
import { now } from '../../db.js'
import { getParam, getAffect, getDrive } from '../../core.js'
import { readAxes, driveAmp } from '../../modules/traits.js'
import { budgetGet } from '../../modules/drive.js'
import { ownerPerson, personByChannel } from '../../modules/relations.js'
import { toneOf } from '../../algo/reldyn.js'
import { getProactivePrefs } from './prefs.js'
import { proactiveSpend } from './budget.js'

export const DIM_LINE = {
  R: '有点想你了，最近还好吗？',
  E: '我最近琢磨着一点事，想跟你说说。',
  C: '有件事我可以帮你看看，需要的话叫我。',
  A: '想问问你，最近有什么想让我少管一点的吗？',
  S: '我记得你之前说过一些事，想确认一下你还好吗。',
}

export const DIM_NAME = { R: '关系', E: '探索', C: '贡献', A: '自主', S: '安全' }
const DIM_KIND = { R: 'greet', E: 'explore', C: 'offer_help', A: 'ask_choice', S: 'check_safety' }
const DIM_TITLE = {
  R: '它想问问你最近怎么样',
  E: '它想聊聊新东西',
  C: '它想帮你做点什么',
  A: '它想让你做个选择',
  S: '它想确认一件事是否安全',
}
/** 这几维开口得有真材料，不能凭空说「我看到个东西」 */
export const DIM_NEEDS_EVIDENCE = { E: true, C: true, S: true }

/**
 * 「她自己想说的那句」才能占额度、算重复、算打扰成本。
 * 冲突确认（reason=conflict:*）是系统让她问的，混进去会把当天的 1 句额度吃光，
 * 还把近 7 天的打扰频率顶到上限，结果她永远开不了口。
 */
const SELF_SENT_SQL = " AND (reason IS NULL OR reason NOT LIKE 'conflict:%')"

/** 打分用的常量，全部集中在这里，方便对账 */
const PROACTIVE = {
  MIN_DEFICIT: 0.3,
  W_DEFICIT: 0.5, W_EVIDENCE: 0.3, W_TIMING: 0.2,
  COST_BASE: 0.2, COST_PER_SENT7: 0.05, COST_SENT7_CAP: 0.3, COST_IGNORE: 0.35,
  EVIDENCE_DAYS: 3, EVIDENCE_FULL: 3,
  TIMING_FROM_H: 12, TIMING_FULL_H: 72,
  IDLE_HARD_MAX: 96,
}

const BAND_MIN_DEFICIT = { D0: 0.99, D1: 0.22, D2: 0.15, D3: 0.10 }

/** 五道门 + 前置检查。id 固定，界面按这个顺序渲染，别在业务里另起名字。 */
export const GATE_LABEL = {
  state: '它醒着',
  switch: '你允许它主动开口',
  dormant: '它没有休眠',
  temper: '它不在气头上',
  deficit: '有一个够大的缺口',
  evidence: '手头有能引用的真事',
  frequency: '今天还没说、这个方向没在冷却',
  idle: '沉默够久',
  quiet: '不在安静时段',
  disturb: '月度打扰预算还没用完',
  value: '想说的劲头压得过打扰成本',
  content: '这句话本身能说',
}

export function gateRow(id, ok, detail) {
  return { id, label: GATE_LABEL[id] || id, ok: ok === null ? null : !!ok, detail: detail || '' }
}

function getFlag(db, key) {
  try {
    const r = db.prepare('SELECT value FROM flags WHERE key=?').get(key)
    return r ? r.value : null
  } catch { return null }
}

function setFlag(db, key, v) {
  db.prepare('INSERT OR REPLACE INTO flags(key,value) VALUES(?,?)').run(key, String(v))
}

export function minDeficitFor(band, override = 0) {
  const o = Number(override)
  if (Number.isFinite(o) && o > 0) return o
  return BAND_MIN_DEFICIT[String(band || 'D0')] ?? PROACTIVE.MIN_DEFICIT
}

/** 带参数覆盖的版本（业务里用这个） */
function minDeficit(db, aid, band) {
  let override = 0
  try { override = Number(getParam(db, aid, 'proactive.min_deficit')) || 0 } catch { override = 0 }
  return minDeficitFor(band, override)
}

/** 所有「够格的缺口」，按大小排队；现算，不落议程表。 */
export function rankIntents(db, aid) {
  let drive = null
  try { drive = getDrive(db, aid) } catch { return [] }
  const ds = (drive && drive.deficits) || {}
  const axes = readAxes(db, aid)
  const factor = (dim) => {
    const d = (k) => (Number(axes[k]) || 0.5) - 0.5
    switch (dim) {
      case 'R': return 1 - 0.30 * d('ei')
      case 'E': return 1 - 0.30 * d('sn')
      case 'C': return 1 + 0.20 * d('tf')
      case 'A': return 1 + 0.20 * d('jp')
      case 'S': return 1 - 0.30 * d('sensitivity')
      default: return 1
    }
  }
  const band = String((drive && drive.band) || 'D0')
  const base = minDeficit(db, aid, band)
  return Object.entries(ds)
    .map(([dim, n]) => ({ dim, deficit: Number(n) || 0, min: base * factor(dim) }))
    .filter((x) => x.deficit >= x.min)
    .sort((a, b) => b.deficit - a.deficit)
    .map((x) => ({
      dim: x.dim,
      deficit: +x.deficit.toFixed(3),
      min: +x.min.toFixed(3),
      band,
      kind: DIM_KIND[x.dim] || 'greet',
      title: DIM_TITLE[x.dim] || '有点想跟你说话',
      reason: '缺口 ' + x.deficit.toFixed(2) + '（' + band + ' 门槛 ' + x.min.toFixed(2) + '）',
      utility: x.deficit,
    }))
}

/** 证据：手头有多少可引用的真事；近几天有没有新的。 */
export function proactiveEvidence(db, aid) {
  const days = PROACTIVE.EVIDENCE_DAYS
  const since = new Date(Date.now() - days * 86400000).toISOString()
  let items = 0
  let recent = 0
  try {
    const r = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid)
    items = Number(r?.n || 0)
  } catch { items = 0 }
  try {
    const r = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND created_at>=?").get(aid, since)
    recent = Number(r?.n || 0)
  } catch { recent = 0 }
  return { items, recent, days, score: Math.min(1, recent / PROACTIVE.EVIDENCE_FULL) }
}

/** 打扰成本：基础代价 + 最近发得太勤 + 上次开口没被接住的比例。 */
export function proactiveCost(db, aid) {
  const day7 = new Date(Date.now() - 7 * 86400000).toISOString()
  const day30 = new Date(Date.now() - 30 * 86400000).toISOString()
  let sent7 = 0
  let sent = 0
  let answered = 0
  let ignored = 0
  try {
    sent7 = Number(db.prepare('SELECT COUNT(*) n FROM proactive WHERE agent_id=? AND created_at>=?' + SELF_SENT_SQL).get(aid, day7).n || 0)
    sent = Number(db.prepare('SELECT COUNT(*) n FROM proactive WHERE agent_id=? AND created_at>=?' + SELF_SENT_SQL).get(aid, day30).n || 0)
    const r = db.prepare('SELECT COALESCE(SUM(answered),0) a, COALESCE(SUM(ignored),0) i FROM proactive WHERE agent_id=? AND created_at>=?' + SELF_SENT_SQL).get(aid, day30)
    answered = Number(r?.a || 0)
    ignored = Number(r?.i || 0)
  } catch { /* 旧库没有这些列 */ }
  const ignoreRate = sent ? Math.min(1, ignored / sent) : 0
  const base = PROACTIVE.COST_BASE
  const frequency = +Math.min(PROACTIVE.COST_SENT7_CAP, sent7 * PROACTIVE.COST_PER_SENT7).toFixed(3)
  const ignore = +(ignoreRate * PROACTIVE.COST_IGNORE).toFixed(3)
  const cost = +(base + frequency + ignore).toFixed(3)
  return {
    cost, parts: { base, frequency, ignore },
    sent7, sent, answered, ignored,
    ignore_rate: +ignoreRate.toFixed(3),
  }
}

/** 时机：刚聊完 0 分，越久越接近 1（12 小时起算，72 小时满）。 */
export function proactiveTiming(hoursSince) {
  const h = Number(hoursSince)
  if (!Number.isFinite(h) || h <= PROACTIVE.TIMING_FROM_H) return 0
  return +Math.min(1, (h - PROACTIVE.TIMING_FROM_H) / (PROACTIVE.TIMING_FULL_H - PROACTIVE.TIMING_FROM_H)).toFixed(3)
}

/** 今天已经让模型试着开口几次（SILENT 也算一次，防心跳每 10 分钟反复烧 token） */
export function proactiveAttemptsToday(db, aid) {
  const day = now().slice(0, 10)
  try {
    const j = JSON.parse(getFlag(db, 'proactive_attempt:' + aid) || 'null')
    if (j && j.day === day) return Number(j.n) || 0
  } catch { /* 坏值当 0 */ }
  return 0
}

export function noteProactiveAttempt(db, aid) {
  const day = now().slice(0, 10)
  try {
    setFlag(db, 'proactive_attempt:' + aid, JSON.stringify({ day, n: proactiveAttemptsToday(db, aid) + 1 }))
  } catch { /* 计数失败不影响开口 */ }
}

function minutesOf(s, d) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return d
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 23 || mm > 59) return d
  return h * 60 + mm
}

/** 半夜是安静的：这段时间只回话，不主动开口。 */
export function inQuietHours(prefs, date = new Date()) {
  if (!prefs || !prefs.quiet) return false
  const from = minutesOf(prefs.quiet_from, 23 * 60 + 30)
  const to = minutesOf(prefs.quiet_to, 7 * 60 + 30)
  const m = date.getHours() * 60 + date.getMinutes()
  return from <= to ? (m >= from && m < to) : (m >= from || m < to)
}

/** C6：当前对话对象的开口意愿（0..1）；读不到关系就给中性值 */
function initiativeOf(db, aid) {
  try {
    const p = ownerPerson(db, aid) || personByChannel(db, aid)
    let mood = 0.5
    try { mood = Number(getAffect(db, aid).mood) || 0.5 } catch { /* 老库没有情绪表 */ }
    const axes = readAxes(db, aid)
    return toneOf({
      closeness: p ? p.closeness : 0.5,
      trust: p ? p.trust : 0.5,
      kind: p ? p.tier : 'acquaintance',
      mood,
      extraversion: axes.ei,
    }).initiative
  } catch { return 0.3 }
}

/** 这个维度现在能不能提（冷却中就不提） */
export function proactiveGate(db, aid, dim) {
  try {
    const s = db.prepare('SELECT * FROM proactive_stats WHERE agent_id=? AND dim=?').get(aid, dim)
    if (s && s.cooldown_until && Date.parse(s.cooldown_until) > Date.now()) {
      return { ok: false, reason: 'cooldown', until: s.cooldown_until, stats: s }
    }
    return { ok: true, stats: s || null }
  } catch { return { ok: true, stats: null } }
}

/**
 * 现在该不该开口（v2）：缺口层 + 反模式混合。
 * - 保留「缺口 → 想说话」：五维缺口 + 候选打分，现算、不落审批表；
 * - 五道门逐条给结论（依据/空闲/频率/打扰/内容），内容门等生成后再补；
 * - 显式算收益和成本（拆到每一项），benefit > cost 才开口；
 * - 只读，不改库。manual=true 只跳过「安静时段 / 沉默时长 / 打扰预算 / 打分」。
 */
export function decideSpeak(db, aid, { manual = false, at = Date.now(), trigger = null } = {}) {
  const gates = []
  const G = (id, ok, detail) => { const g = gateRow(id, ok, detail); gates.push(g); return g }
  const out = {
    version: 2, will: false, reason: 'ok', manual: !!manual, at: now(),
    hours_since: null, idle_need_hours: null,
    quiet: null, intent: null, candidates: [], score: null,
    benefit: null, benefit_parts: null, cost: null, cost_parts: null, evidence: null,
    gates, gate: gates, explain: '',
  }
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(aid)
  const alive = !!a && a.status === 'active'
  G('state', alive, alive ? '' : (a ? '它在休眠（' + (a.status === 'paused' ? '你让它暂停了' : a.status) + '），不会主动开口' : '找不到这个意识体'))
  if (!alive) return { ...out, reason: 'inactive', explain: '它在休眠，不会主动开口。', input: { stage: 'inactive' } }

  const prefs = getProactivePrefs(db, aid)
  out.prefs = prefs
  const on = !!prefs.enabled && Number(prefs.per_day) > 0
  G('switch', on, on ? ('每天最多 ' + prefs.per_day + ' 句') : '主动开口是关的')
  if (!on) return { ...out, reason: 'proactive_off', explain: '主动开口是关的。', input: { stage: 'switch' } }

  let dm = null
  try { dm = getDrive(db, aid) } catch { dm = null }
  const awake = !(dm && dm.dormant)
  G('dormant', awake, awake ? '' : '太久没互动，它已经休眠了')
  if (!awake) return { ...out, reason: 'dormant', explain: '太久没互动，它已经休眠了。', input: { stage: 'dormant' } }

  // R03（戈夫曼）：正在气头上，不主动开口（回复长度由语气档另管）
  // 阈值 0.68（2026-11-05 定：中间偏晚；原 0.7，先试 0.65 再往晚挪一点）
  let af0 = null
  try { af0 = getAffect(db, aid) } catch { af0 = null }
  const hot = !!af0 && ['irritated', 'frustrated'].includes(String(af0.primary_label)) && Number(af0.intensity) > 0.68
  G('temper', !hot, hot ? ('火气 ' + Number(af0.intensity).toFixed(2) + '，不想先开口') : '情绪平稳')
  if (hot) {
    return {
      ...out, reason: 'temper', explain: '正在气头上，它不会主动开口（R03）。',
      affect: { label: af0.primary_label, intensity: Number(af0.intensity) },
      input: { stage: 'temper', label: af0.primary_label, intensity: Number(af0.intensity) },
    }
  }

  // ---- 数字全部现算，只读 ----
  const today = now().slice(0, 10)
  let saidToday = 0
  try { saidToday = Number(db.prepare("SELECT COUNT(*) n FROM proactive WHERE agent_id=? AND created_at LIKE ?" + SELF_SENT_SQL).get(aid, today + '%').n || 0) } catch { saidToday = 0 }
  const lastAt = a.last_interaction_at ? Date.parse(a.last_interaction_at) : 0
  const hoursSince = lastAt ? +((at - lastAt) / 3600000).toFixed(2) : 999
  const cx = proactiveCost(db, aid)
  const ev = proactiveEvidence(db, aid)
  const timing = proactiveTiming(hoursSince)
  const quietOn = inQuietHours(prefs)
  // 有「该说的事」时，允许不看额度说一次——但一天只给这一次，而且不越过夜间静默和火气
  const owed = trigger ? { ...trigger } : null
  // 欠账（答应过 / 提醒）不该被「今天已经主动说过一句」挤掉——那句多半是别的分享。
  const owedOnce = !!owed && (owed.owed === true || saidToday < 1)
  out.trigger = owed
  const axes = readAxes(db, aid)
  // 8 idle：外向的人等得短一点
  const idleNeed = Math.min(PROACTIVE.IDLE_HARD_MAX, Math.max(0, Number(prefs.idle_hours) || 0)
    * (1 + cx.ignore_rate) * (1 - 0.30 * ((Number(axes.ei) || 0.5) - 0.5)))
  out.hours_since = hoursSince
  out.idle_need_hours = +idleNeed.toFixed(1)
  out.quiet = { on: !!prefs.quiet, from: prefs.quiet_from || '23:30', to: prefs.quiet_to || '07:30', in_window: quietOn }
  out.evidence = ev
  out.cost = cx.cost
  out.cost_parts = cx.parts

  const intents = rankIntents(db, aid)
  out.candidates = intents.map((x) => ({ dim: x.dim, deficit: x.deficit, min: x.min, kind: x.kind, title: x.title }))
  const needTh = intents.length ? intents[0].min : minDeficit(db, aid, (dm && dm.band) || 'D0')
  out.min_deficit = +needTh.toFixed(3)
  const deficitOk = intents.length > 0 || owedOnce
  G('deficit', deficitOk, intents.length
    ? intents.map((x) => (DIM_NAME[x.dim] || x.dim) + ' ' + x.deficit.toFixed(2)).join(' / ')
    : owedOnce
      ? ('有事由：' + owed.text)
      : '五个方向都在门槛 ' + needTh.toFixed(2) + ' 以下（当前 ' + ((dm && dm.band) || 'D0') + '）')
  if (!deficitOk) return { ...out, reason: 'no_intent', explain: '它现在哪儿都不缺，不勉强找话说。' }

  // 硬拦：冷却中的、今天说过的、没材料的，逐个跳过，换下一个缺口
  let pick = null
  for (const it of intents) {
    const c = out.candidates.find((x) => x.dim === it.dim)
    const gate = proactiveGate(db, aid, it.dim)
    if (!gate.ok) { c.blocked = 'cooldown'; c.why = '冷却到 ' + String(gate.until || '').slice(0, 16).replace('T', ' '); continue }
    let dup = null
    try { dup = db.prepare("SELECT 1 FROM proactive WHERE agent_id=? AND dim=? AND created_at LIKE ?" + SELF_SENT_SQL).get(aid, it.dim, today + '%') } catch { dup = null }
    if (dup) { c.blocked = 'already_today'; c.why = '这个方向今天说过了'; continue }
    if (DIM_NEEDS_EVIDENCE[it.dim] && ev.items === 0) {
      c.blocked = 'no_evidence'; c.why = '这一维要真事，手头 0 条'; continue
    }
    pick = it
    break
  }
  // 有事由但没有缺口时，也要有一个「方向」好往下算：这件事本身就是方向
  const top = pick || intents[0] || { dim: (owed && owed.dim) || 'R', deficit: 0, kind: 'loop', title: (owed && owed.text) || '' }
  const evOk = owedOnce || !(DIM_NEEDS_EVIDENCE[top.dim] && ev.items === 0)
  G('evidence', evOk, evOk
    ? (owedOnce ? '有事由，不用再凑材料' : ('手头 ' + ev.items + ' 条真事，近 ' + ev.days + ' 天新增 ' + ev.recent + ' 条'))
    : ('「' + (DIM_NAME[top.dim] || top.dim) + '」这一维要真事，手头一条都没有'))

  const biasMul = driveAmp(axes, top.dim)
  const eiMul = 1 + 0.15 * ((Number(axes.ei) || 0.5) - 0.5)
  // C6（9 号 §6）：关系越近、心情越好，越愿意开口；疏离时把它压回去
  const initiative = initiativeOf(db, aid)
  const initiativeMul = 0.6 + 0.8 * initiative
  // P2（情绪进判据）：总情绪高一点更想开口，低谷时更怕打扰。
  // 只用乘子、不新增拆项，保证「收益三块加起来 = benefit / 成本三块 = cost」的核对口径不变。
  const moodTotal = af0 && af0.v3 ? Math.max(-1, Math.min(1, Number(af0.v3.total) || 0)) : 0
  const moodBenefitMul = +(0.9 + 0.2 * Math.max(0, Math.min(1, 0.5 + 0.5 * moodTotal))).toFixed(3)
  const moodCostMul = moodTotal <= -0.2 ? 1.1 : 1
  const personMul = eiMul * (1 + biasMul) * initiativeMul * moodBenefitMul
  const benefit = +((top.deficit * PROACTIVE.W_DEFICIT + ev.score * PROACTIVE.W_EVIDENCE + timing * PROACTIVE.W_TIMING)
    * personMul).toFixed(3)
  // 敏感度抬高打扰成本：拆项按同一系数放大，三块加起来仍然等于 cost（不然「成本拆开算」对不上）
  const costMul = (1 + 0.25 * ((Number(axes.sensitivity) || 0.5) - 0.5)) * moodCostMul
  const cost = +(cx.cost * costMul).toFixed(3)
  out.benefit = benefit
  out.benefit_parts = {
    deficit: +(top.deficit * PROACTIVE.W_DEFICIT * personMul).toFixed(3),
    evidence: +(ev.score * PROACTIVE.W_EVIDENCE * personMul).toFixed(3),
    timing: +(timing * PROACTIVE.W_TIMING * personMul).toFixed(3),
    raw: { deficit: top.deficit, evidence: ev.score, timing },
    weights: { deficit: PROACTIVE.W_DEFICIT, evidence: PROACTIVE.W_EVIDENCE, timing: PROACTIVE.W_TIMING },
    persona: { ei: +eiMul.toFixed(3), axis: +biasMul.toFixed(3), initiative: +initiative.toFixed(3), initiative_mul: +initiativeMul.toFixed(3), mood: moodBenefitMul, mood_total: +moodTotal.toFixed(3), dimAxis: { R: 'tf', E: 'sn', C: 'tf', A: 'jp', S: 'sensitivity' }[top.dim] || null },
  }
  out.cost = cost
  out.cost_parts = {
    base: +(cx.parts.base * costMul).toFixed(3),
    frequency: +(cx.parts.frequency * costMul).toFixed(3),
    ignore: +(cx.parts.ignore * costMul).toFixed(3),
    persona: +costMul.toFixed(3),
    persona_mood: moodCostMul,
    mood_total: +moodTotal.toFixed(3),
  }
  out.score = {
    benefit, cost, deficit: top.deficit,
    evidence: ev.score, evidence_items: ev.items, evidence_recent: ev.recent,
    timing, sent7: cx.sent7, ignore_rate: cx.ignore_rate,
    benefit_parts: out.benefit_parts, cost_parts: out.cost_parts,
  }
  // 输入快照：将来回放「它那天为什么这样决定」的第一手粮。只读状态，不改判定。
  out.input = {
    stage: 'full',
    at: now(),
    agent: { status: a.status },
    prefs: {
      enabled: !!prefs.enabled, per_day: Number(prefs.per_day),
      idle_hours: Number(prefs.idle_hours), quiet: !!prefs.quiet,
      quiet_from: prefs.quiet_from || null, quiet_to: prefs.quiet_to || null,
    },
    said_today: saidToday,
    hours_since: hoursSince,
    idle_need_hours: +idleNeed.toFixed(1),
    quiet: { on: !!prefs.quiet, in_window: quietOn },
    temper: { label: af0 ? af0.primary_label : null, intensity: af0 ? Number(af0.intensity) : null, hot },
    trigger: owed,
    deficit: {
      band: (dm && dm.band) || null,
      min: +needTh.toFixed(3),
      top: top ? { dim: top.dim, deficit: top.deficit, kind: top.kind || null } : null,
    },
    evidence: { items: ev.items, recent: ev.recent, score: +Number(ev.score || 0).toFixed(3) },
    cost: { cost },
    axes: { ei: axes.ei, jp: axes.jp, sensitivity: axes.sensitivity },
    initiative: +Number(initiative || 0).toFixed(3),
  }
  out.intent = pick
    ? { dim: pick.dim, kind: pick.kind, title: pick.title, deficit: pick.deficit, reason: '缺口 ' + pick.deficit.toFixed(2) }
    : null
  // 有该说的事：方向就是这件事，不当成「缺口」
  if (owedOnce) {
    const ok = (owed && owed.kind) || 'loop'
    out.intent = {
      dim: owed.dim || 'R', kind: ok, title: owed.text,
      summary: owed.summary || '', deficit: top ? top.deficit : 0,
      reason: ok === 'share' ? '我自己生活里看到的事：' + (owed.text || '') : '开环到期：' + owed.text,
    }
  }

  // ---- 五道门 + 判据，全部给结论（不短路，方便解释） ----
  const firstBlocked = out.candidates.find((c) => c.blocked)
  const tries = proactiveAttemptsToday(db, aid)
  out.tries_today = tries
  const perDay = Number(prefs.per_day)
  const cap = Math.max(1, Math.ceil(perDay * (1 + 0.40 * ((Number(axes.jp) || 0.5) - 0.5))))
  out.attempt_cap = cap
  const freqOk = owedOnce || (saidToday < perDay && tries < cap && !!pick)
  G('frequency', freqOk, owedOnce
    ? ('有件没说完的事（' + owed.text + '），今天还没说，可以越过额度说一次')
    : saidToday >= perDay
      ? '今天已经说了 ' + saidToday + ' 句（上限 ' + perDay + '）'
      : tries >= cap ? '今天已经试着开口 ' + tries + ' 次（上限 ' + cap + '），不再反复问模型'
        : !pick ? '没有能说的方向：' + ((firstBlocked && firstBlocked.why) || '都不合适')
          : '今天还没说；还能试 ' + (cap - tries) + ' 次')

  const idleOk = owedOnce || hoursSince >= idleNeed
  G('idle', idleOk, '距上次对话 ' + (hoursSince >= 999 ? '还没有过' : hoursSince.toFixed(1) + ' 小时') + '，要求至少 ' + idleNeed.toFixed(1) + ' 小时'
    + (owedOnce ? '（有该说的事，不卡这一条）' : ''))

  G('quiet', !quietOn, quietOn
    ? ('现在是 ' + (prefs.quiet_from || '23:30') + '–' + (prefs.quiet_to || '07:30') + '，不打扰')
    : '不在安静时段')

  // 预算：按天（学界验证的区间是每次 1–3 个；我们按天 2 个），月度 30 次只当防滥发兜底。
  // 判据只有这一处；budgetConsume 只记账、不再自己拦（否则两处判据会漂）。
  // 一句有真事的开口算 1，纯凑数算 2——「问得好」也该便宜一点。
  let budget = { disturb_used: 0, disturb_limit: 30 }
  try { budget = budgetGet(db, aid) } catch { /* 老库没有预算表 */ }
  const monthUsed = Number(budget.disturb_used || 0)
  const dayLimit = Math.max(1, Math.min(20, Number(getParam(db, aid, 'proactive.daily_disturb_limit')) || 2))
  const monthLimit = Math.max(dayLimit, Number(getParam(db, aid, 'proactive.monthly_disturb_limit')) || 30)
  const spend = proactiveSpend(db, aid)
  const daySpend = Math.max(saidToday, spend.day === now().slice(0, 10) ? spend.n : 0)
  const budgetExempt = owedOnce || manual
  const budgetOk = budgetExempt || (daySpend < dayLimit && monthUsed < monthLimit)
  G('disturb', budgetOk, '今天额度 ' + dayLimit + ' 句，已用 ' + daySpend + '（月 ' + monthUsed + ' / ' + monthLimit + ' 兜底）'
    + (owedOnce ? '；有该说的事，不占预算' : manual ? '；你让它说的，不占预算' : ''))

  const valueOk = manual || owedOnce || benefit > cost
  G('value', valueOk, '劲头 ' + benefit.toFixed(2) + (benefit > cost ? ' > ' : ' ≤ ') + '打扰成本 ' + cost.toFixed(2)
    + '（E/I ×' + eiMul.toFixed(2) + '，轴 ×' + (1 + biasMul).toFixed(2) + (manual ? '；你让它说的，跳过比较' : owedOnce ? '；有该说的事，跳过比较' : '') + '）')

  // 内容门要等句子生成出来，先挂一个「待判」
  G('content', null, '等生成出来再判（一句话、不追问、不用提醒腔）')

  // 理由的先后：和旧版一致，先看硬条件，再看要不要开口
  let reason = 'ok'
  if (saidToday >= perDay && !owedOnce) reason = 'per_day'
  else if (!manual && !owedOnce && tries >= cap) reason = 'attempt_cap'
  else if (!manual && quietOn) reason = 'quiet'
  else if (!manual && !owedOnce && hoursSince < idleNeed) reason = 'idle'
  else if (!manual && !owedOnce && (daySpend >= dayLimit || monthUsed >= monthLimit)) reason = 'budget'
  else if (!owedOnce && !pick) reason = (firstBlocked && firstBlocked.blocked) || 'no_intent'
  else if (!manual && !owedOnce && benefit <= cost) reason = 'low_benefit'

  out.reason = reason
  out.will = reason === 'ok'
  const im = DIM_NAME[top.dim] || top.dim
  if (out.will) {
    out.explain = '想说「' + im + '」：缺口 ' + top.deficit.toFixed(2) + ' + ' + ev.items + ' 条真事（近 ' + ev.days + ' 天 +' + ev.recent + '）'
      + ' + 隔了 ' + (hoursSince >= 999 ? '很久' : hoursSince.toFixed(0) + ' 小时') + ' = 劲头 ' + benefit.toFixed(2)
      + '，压过打扰成本 ' + cost.toFixed(2) + '（今天额度 ' + daySpend + '/' + dayLimit + '，月兜底 ' + monthUsed + '/' + monthLimit + '）。'
      + (owedOnce ? '事由：' + owed.text + '（开环到期，今天第一次说）' : '')
  } else {
    out.explain = explainSilent(reason, { top, firstBlocked, hoursSince, idleNeed, benefit, cost, used: daySpend, limit: dayLimit, monthUsed, monthLimit, prefs })
  }
  return out
}

/** 兼容旧名：v2 的判据就是它 */
export const proactiveDecision = decideSpeak

function explainSilent(reason, { top, firstBlocked, hoursSince, idleNeed, benefit, cost, used, limit, monthUsed, monthLimit, prefs }) {
  const im = top ? (DIM_NAME[top.dim] || top.dim) : ''
  switch (reason) {
    case 'per_day': return '今天已经主动说了（上限 ' + (prefs && prefs.per_day) + ' 句），剩下的明天再说。'
    case 'attempt_cap': return '今天已经试过怎么开口了，还没找到合适的说法，等明天。'
    case 'quiet': return '现在是安静时段，它不吵你。'
    case 'idle': return '你 ' + (hoursSince >= 999 ? '还没' : hoursSince.toFixed(1) + ' 小时前才') + '聊过，它要等满 ' + idleNeed.toFixed(1) + ' 小时才开口。'
    case 'budget': return '今天的打扰预算用完了（' + used + '/' + limit + ' 句）'
      + (monthUsed >= monthLimit ? '，这个月的兜底也到了（' + monthUsed + '/' + monthLimit + ' 次）' : '') + '，今天先不主动开口了。'
    case 'cooldown': return '「' + im + '」这个方向上次没被接住，' + ((firstBlocked && firstBlocked.why) || '在冷却') + '。'
    case 'already_today': return '「' + im + '」今天已经说过了。'
    case 'no_evidence': return '「' + im + '」要真事才说，它手头一条都没有，不编。'
    case 'low_benefit': return '劲头 ' + benefit.toFixed(2) + ' 没压过打扰成本 ' + cost.toFixed(2) + '（最近发得多 / 上回没被接住），先不说。'
    case 'no_intent': return '五个缺口都在阈值以下，没必要硬找话。'
    default: return '它现在没有想说的话。'
  }
}

/** 手动叫她、她拒绝时：按 reason 给「大概要安静多久」的钟头数（只出文案，不写冷却）。 */
export function nextTryInHours(d) {
  const reason = d && d.reason
  const prefs = (d && d.prefs) || {}
  const nowMs = Date.now()
  if (reason === 'quiet') {
    const to = String(prefs.quiet_to || '07:30')
    const [h, m] = to.split(':').map(Number)
    const end = new Date(nowMs)
    end.setHours(Number.isFinite(h) ? h : 7, Number.isFinite(m) ? m : 30, 0, 0)
    if (end.getTime() <= nowMs) end.setDate(end.getDate() + 1)
    return Math.max(1, Math.round((end.getTime() - nowMs) / 3600000))
  }
  if (reason === 'temper') return 1
  if (reason === 'low_benefit') return 3
  if (reason === 'budget') {
    const nowD = new Date(nowMs)
    const next = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 1)
    return Math.max(1, Math.round((next - nowMs) / 3600000))
  }
  if (reason === 'per_day' || reason === 'attempt_cap') {
    const end = new Date(nowMs)
    end.setHours(24, 0, 0, 0)
    return Math.max(1, Math.round((end - nowMs) / 3600000))
  }
  if (reason === 'idle') {
    const gap = Number(d.hours_since) || 0
    const need = Number(d.idle_need_hours) || 0
    return Math.max(1, Math.ceil(need - gap))
  }
  return 6
}
