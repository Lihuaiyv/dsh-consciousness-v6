import { now } from '../db.js'
import { model, err, nid, agent, active, event, getParam, getFlag, setFlag } from '../kernel.js'
import { nudgeDeficit } from './drive.js'
import { readAxes } from './traits.js'
import { runBound } from '../algo/index.js'
import { planSegments, valueAt, valueAtTime, circadianAt, rhythmAt, stepLoad } from '../algo/baseline.js'
import { stepSlow, injectSlow, fastOf, empathyPartsOf, totalOf, coupledF, stepDuty, dutyBiasOf, SLOW_ETA, SLOW_BETA, SLOW_SAT_K, SLOW_SAT_WINDOW_MIN, DUTY_ADD, DUTY_TAU_H, DUTY_THRESHOLD, DUTY_BIAS, DUTY_RELIEF, EMPATHY_KAPPA, EMPATHY_MODE, EMPATHY_HOLD, EMPATHY_DAMPEN, EMPATHY_INVERT_BELOW, EMPATHY_STAND_ABOVE } from '../algo/emotion.js'
import { PAD_PRIOR } from '../algo/affect_dyn.js'
import { classifyGap, decayCurve, wakeReset, localHour } from '../algo/sleep.js'
import { stepWalk } from '../algo/walk.js'
import { significanceOf, gateOf, labelMargin, socialFloorOf, GATE } from '../algo/gate.js'

const HOUR_MS = 3600000

export function seedAffect(db, aid) {
  db.prepare('INSERT OR REPLACE INTO affect_state VALUES(?,?,?,?,?,?,?,?,?)')
    .run(aid, 'calm', null, 0.5, 0.6, 0.1, -0.1, 0, now())
  try {
    db.prepare('INSERT OR IGNORE INTO affect_v3(agent_id, baseline, slow, fast, total, slow_at) VALUES(?,0,?,0,?,?)')
      .run(aid, 0.2, 0.2, now())
  } catch { /* 老库没有 v3 表 */ }
}

// ---------------- 情绪 v3：底色 / 慢 / 快 / 总 ----------------

/** 段行 → 内存段 */
function rowToSeg(row) {
  const startMs = Date.parse(row.started_at)
  return {
    from: Number(row.from_val),
    to: Number(row.to_val),
    startMs,
    endMs: startMs + Number(row.duration_h) * HOUR_MS,
  }
}

/** 确保底色段覆盖到 untilMs；只往后铺，不改旧段 */
function ensureBaseline(db, aid, untilMs) {
  const { sensitivity } = readAxes(db, aid)
  const rows = db.prepare('SELECT * FROM affect_baseline WHERE agent_id=? ORDER BY seg_no').all(aid)
  let segs = rows.map(rowToSeg)
  const last = segs.length ? segs[segs.length - 1] : null
  const coverFrom = last ? last.endMs : untilMs - 7 * 86400000
  if (!last || untilMs >= coverFrom) {
    const segNo0 = last ? Number(rows[rows.length - 1].seg_no) + 1 : 0
    const from0 = last ? last.to : 0
    const fresh = planSegments({ seed: aid, sensitivity, startMs: coverFrom, untilMs: untilMs + 86400000, segNo0, from0 })
    const ins = db.prepare('INSERT OR REPLACE INTO affect_baseline VALUES(?,?,?,?,?,?,?)')
    for (const s of fresh) {
      ins.run(aid, s.segNo, new Date(s.startMs).toISOString(), s.durationH, s.from, s.to, aid)
    }
    segs = segs.concat(fresh)
  }
  return segs
}

/** 某个时刻的底色值（段式慢波 + 日节律 + 激素纹；不含累积负荷，负荷要读库） */
export function baselineNow(db, aid, atMs = Date.now()) {
  const circAmp = paramNum(db, aid, 'affect.baseline.circadian', 0.06, 0, 0.3)
  const roughAmp = paramNum(db, aid, 'affect.baseline.rough', 0.08, 0, 0.2)
  const cycleAmp = paramNum(db, aid, 'affect.baseline.cycle', 0.07, 0, 0.2)
  return Math.round((valueAtTime(ensureBaseline(db, aid, atMs), atMs)
    + circadianAt(atMs, aid, circAmp)
    + rhythmAt(atMs, aid, { rough: roughAmp, cycle: cycleAmp })) * 1000) / 1000
}

/**
 * 按当前敏感度重铺「接下来」的底色。
 *
 * 只给「我刚把敏感度调高 / 调低，想马上看见」这一个动作使用，不在任何自动路径上调用：
 *   · 已经走完的段一行不动（过去的走势不改）；
 *   · 正在走的那一段在「此刻」截断，to 换成此刻的值（这一段还没走完的尾巴会变）；
 *   · 之后的段全删，交给 ensureBaseline 用新的 amp 重排。
 * 调高 σ 之后，下一段起才会真的更起伏；不重铺的话要等当前这一段自然走完（几天）。
 */
export function rebuildBaselineAhead(db, aid, { at = Date.now() } = {}) {
  active(db, aid)
  const rows = db.prepare('SELECT * FROM affect_baseline WHERE agent_id=? ORDER BY seg_no').all(aid)
  if (!rows.length) {
    ensureBaseline(db, aid, at)
    return { rebuilt: true, from: null, segments: 0 }
  }
  let cut = null
  for (const r of rows) {
    const seg = rowToSeg(r)
    if (seg.endMs > at) { cut = { row: r, seg }; break }
  }
  let from = Number(rows[rows.length - 1].to_val) || 0
  if (cut && cut.seg.startMs < at) {
    from = Math.round(valueAt(cut.seg, at) * 1000) / 1000
    const hours = Math.max(1 / 3600, (at - cut.seg.startMs) / HOUR_MS)
    db.prepare('UPDATE affect_baseline SET duration_h=?, to_val=? WHERE agent_id=? AND seg_no=?')
      .run(hours, from, aid, cut.row.seg_no)
    db.prepare('DELETE FROM affect_baseline WHERE agent_id=? AND seg_no>?').run(aid, cut.row.seg_no)
  } else if (cut) {
    // 还没开始（或正好从此刻开始）的段：直接丢，让 ensureBaseline 从上一段末尾接上
    db.prepare('DELETE FROM affect_baseline WHERE agent_id=? AND seg_no>=?').run(aid, cut.row.seg_no)
  }
  try {
    ensureBaseline(db, aid, at)
  } catch (e) {
    return { rebuilt: false, reason: String((e && e.message) || e) }
  }
  return { rebuilt: true, from, at: new Date(at).toISOString(), sigma: readAxes(db, aid).sensitivity }
}

/** 对方情绪投影到愉悦轴 */
/** 八类分布 → 愉悦轴（-1~+1），共情项用 */
export function projectEmotionAxis(read) {
  const scores = read && read.dist
  if (!scores || typeof scores !== 'object') return 0
  let sum = 0
  let w = 0
  for (const [k, v] of Object.entries(scores)) {
    const prior = PAD_PRIOR[k]
    const x = Number(v)
    if (!prior || !Number.isFinite(x) || x <= 0) continue
    sum += prior.p * x
    w += x
  }
  return w > 0 ? Math.round(Math.max(-1, Math.min(1, sum / w)) * 1000) / 1000 : 0
}

/* ==================== 它现在觉得你：读你的情绪 + 反馈学习 ====================
 * 模型每次评价都会顺手给一份「说话人情绪」（user_scores）。
 * 页面把这份读数摆成「它现在觉得你」，你觉得不对就点「不对」并说出实际情绪；
 * 每条反馈写进 affect_user_read，按「它读成 g → 你实际是 a」累计成一张 8×8
 * 混淆矩阵（向对角线收缩，样本少时更像它原来的判断）。下一轮读你时先用这张
 * 矩阵把这句的读数掰回来，再拿掰过的分布去算共情 —— 学了就会改，不只是记一笔。
 */
export const USER_EMOTIONS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']

const READ_SHRINK = 3         // 反馈样本少时向「它原来读的」收缩的强度
const ECHO_WEIGHT = 0.75      // 这条你已经纠正过：显示时以你说的为准
const FEEDBACK_HALF_LIFE_D = 30 // 一条纠正多少天后权重减半（人的状态会变）
const RECENT_W = 0.25         // 最近一次纠正的短时偏置上限
const RECENT_HALF_LIFE_H = 2  // 这个偏置多久减半

function blankEmotions() {
  const d = {}
  for (const k of USER_EMOTIONS) d[k] = 0
  return d
}

function normalizeEmotions(d) {
  const out = blankEmotions()
  let sum = 0
  for (const k of USER_EMOTIONS) {
    const v = Math.max(0, Number(d && d[k]) || 0)
    out[k] = v
    sum += v
  }
  if (sum <= 0) {
    for (const k of USER_EMOTIONS) out[k] = 1 / USER_EMOTIONS.length
    return out
  }
  for (const k of USER_EMOTIONS) out[k] = out[k] / sum
  return out
}

function topEmotion(d) {
  return USER_EMOTIONS.reduce((best, k) => (Number(d[k]) > Number(d[best]) ? k : best), USER_EMOTIONS[0])
}

function onehotEmotion(k) {
  const d = blankEmotions()
  if (USER_EMOTIONS.includes(k)) d[k] = 1
  return d
}

function mixEmotions(base, target, w) {
  const t = Math.max(0, Math.min(1, Number(w) || 0))
  const out = blankEmotions()
  for (const k of USER_EMOTIONS) out[k] = (1 - t) * Number(base[k] || 0) + t * Number(target[k] || 0)
  return normalizeEmotions(out)
}

/**
 * 从一条 appraisal 里取「它当时读到的你」。
 * user_scores 是完整分布；老记录只有 user_label，就按 0.7 / 均摊还原。
 * 两样都没有就返回 null —— 不拿它自己的反应 scores 冒充你。
 */
export function readUserEmotion(appraisal) {
  const a = appraisal || {}
  if (a.user_scores && typeof a.user_scores === 'object') {
    const d = blankEmotions()
    let any = false
    for (const k of USER_EMOTIONS) {
      const v = Number(a.user_scores[k])
      if (Number.isFinite(v) && v > 0) { d[k] = v; any = true }
    }
    if (any) return { dist: normalizeEmotions(d), source: 'model' }
  }
  if (USER_EMOTIONS.includes(a.user_label)) {
    return { dist: mixEmotions(onehotEmotion(a.user_label), normalizeEmotions(blankEmotions()), 0.3), source: 'label' }
  }
  return null
}

function readFeedback(db, aid) {
  try {
    return db.prepare('SELECT episode_id, guess_label, actual_label, note, created_at FROM affect_user_read WHERE agent_id=? ORDER BY created_at').all(aid)
  } catch { return [] }
}

/** 一条反馈还有多重：越久越轻，90 天后基本不计数 */
function feedbackWeight(r) {
  const ms = Date.parse(r.created_at)
  if (!Number.isFinite(ms)) return 1
  const days = Math.max(0, (Date.now() - ms) / 86400000)
  const w = Math.pow(0.5, days / FEEDBACK_HALF_LIFE_D)
  return w < 0.05 ? 0 : w
}

/** 反馈 → 8×8：P(你实际是 a | 它读成 g)，样本少时收缩回对角线 */
function learnedMatrix(rows) {
  const counts = {}
  for (const r of rows) {
    const g = String(r.guess_label || '')
    const a = String(r.actual_label || r.guess_label || '')
    if (!USER_EMOTIONS.includes(g) || !USER_EMOTIONS.includes(a)) continue
    const w = feedbackWeight(r)
    if (!w) continue
    const c = counts[g] || (counts[g] = blankEmotions())
    c[a] += w
  }
  const mat = {}
  for (const g of USER_EMOTIONS) {
    const c = counts[g] || blankEmotions()
    const total = USER_EMOTIONS.reduce((s, a) => s + c[a], 0)
    const row = blankEmotions()
    for (const a of USER_EMOTIONS) row[a] = (c[a] + (a === g ? READ_SHRINK : 0)) / (total + READ_SHRINK)
    mat[g] = row
  }
  return mat
}

function applyMatrix(dist, mat) {
  const out = blankEmotions()
  for (const g of USER_EMOTIONS) {
    const p = Number(dist[g]) || 0
    if (p <= 0) continue
    const row = mat[g]
    for (const a of USER_EMOTIONS) out[a] += p * row[a]
  }
  return normalizeEmotions(out)
}

/**
 * 学到的读法只走条件矩阵，不再加「你的情绪底色」全局先验。
 * 原因：反馈只在它读错时产生，直接统计「你说自己是什么」得到的是
 * 「它容易读错那几类」的分布，不是你的真实底色；矩阵已经算过一遍
 * g→a 的偏差，再加先验等于同一件事记两遍，会把所有句子都往那几类拉。
 */
function applyLearned(dist, rows) {
  return applyMatrix(dist, learnedMatrix(rows))
}

/**
 * 最近一次纠正（12 小时内）：只对「现在这一句」且只在读数不确定时
 * 给一点偏置。模型越笃定，越不该拿你上一句的自述盖掉这一句。
 */
function recentReport(rows) {
  let best = null
  for (const r of rows) {
    if (!USER_EMOTIONS.includes(r.actual_label)) continue
    const ms = Date.parse(r.created_at)
    if (!Number.isFinite(ms)) continue
    if (!best || ms >= best.ms) best = { row: r, ms }
  }
  if (!best) return null
  const ageH = (Date.now() - best.ms) / HOUR_MS
  if (!(ageH >= 0) || ageH > 12) return null
  return {
    actual_label: best.row.actual_label,
    weight: RECENT_W * Math.pow(0.5, ageH / RECENT_HALF_LIFE_H),
  }
}

function withRecentBias(dist, report) {
  if (!report) return dist
  const top = Math.max(...USER_EMOTIONS.map((k) => Number(dist[k]) || 0))
  const w = report.weight * (1 - top)
  return w > 0.02 ? mixEmotions(dist, onehotEmotion(report.actual_label), w) : dist
}

function guessStats(rows) {
  const n = rows.length
  let hits = 0
  const conf = {}
  for (const r of rows) {
    const g = String(r.guess_label || '')
    const a = String(r.actual_label || '')
    if (g === a) hits++
    else if (g && a) conf[g + '>' + a] = (conf[g + '>' + a] || 0) + 1
  }
  return {
    n, hits,
    accuracy: n ? Math.round((hits / n) * 100) : null,
    confusions: Object.entries(conf).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, count]) => {
      const [guess, actual] = k.split('>')
      return { guess, actual, count }
    }),
  }
}

/** 行为侧：这一句在它听来「你」是什么情绪（已按学到的偏差掰过） */
export function readUserNow(db, aid, hint) {
  const read = readUserEmotion(hint)
  if (!read) return null
  const rows = readFeedback(db, aid)
  if (!rows.length) return read
  return {
    dist: withRecentBias(applyLearned(read.dist, rows), recentReport(rows)),
    source: read.source,
    learned: true,
  }
}

/** 页面用：它现在觉得你 + 最近几条 event 的读数 + 你给过多少反馈 */
export function userGuess(db, aid, { limit = 8 } = {}) {
  agent(db, aid)
  const n = Math.max(1, Math.min(30, Number(limit) || 8))
  const rows = db.prepare('SELECT id, cause, label, intensity, rise_from, rise_at, renewals, ended_at, started_at, appraisal FROM affect_episodes WHERE agent_id=? ORDER BY started_at DESC LIMIT ?').all(aid, n)
  const fb = readFeedback(db, aid)
  const byEpisode = {}
  for (const f of fb) byEpisode[f.episode_id] = f
  const recent = recentReport(fb)
  const items = rows.map((r, i) => {
    let ap = {}
    try { ap = JSON.parse(r.appraisal || '{}') } catch { ap = {} }
    const read = readUserEmotion(ap)
    const mine = byEpisode[r.id] || null
    const base = {
      episode_id: r.id, cause: r.cause || '', at: r.started_at,
      self: {
        label: r.label,
        /* 显示「此刻」的强度：上升段没爬满时，它会比峰值低 */
        intensity: +Number(episodePhase(db, aid, r) === 'ended' ? r.intensity : episodeLevelAt(db, aid, r)).toFixed(2),
        peak: +Number(r.intensity || 0).toFixed(2),
        phase: episodePhase(db, aid, r),
        renewals: Number(r.renewals) || 0,
      },
      feedback: mine ? {
        actual_label: mine.actual_label, guess_label: mine.guess_label,
        correct: mine.guess_label === mine.actual_label, note: mine.note, at: mine.created_at,
      } : null,
    }
    if (!read) return { ...base, source: null, dist: null, top: null, second: null, topP: null }
    const learned = fb.length ? applyLearned(read.dist, fb) : read.dist
    /* 这条被你纠正过：以你说的为准；只是「最近刚纠正过」：只给最新一句
       一点偏置，而且模型越笃定给得越少——不拿上一句的自述盖掉这一句。 */
    let shown = mine ? mixEmotions(learned, onehotEmotion(mine.actual_label), ECHO_WEIGHT) : learned
    if (!mine && i === 0) shown = withRecentBias(shown, recent)
    const order = USER_EMOTIONS.slice().sort((a, b) => shown[b] - shown[a])
    return {
      ...base,
      source: read.source,
      dist: shown,
      raw: { top: topEmotion(read.dist), p: +Number(read.dist[topEmotion(read.dist)]).toFixed(3) },
      top: order[0], second: order[1], topP: +Number(shown[order[0]]).toFixed(3),
      corrected: !!mine,
      learned: fb.length > 0,
    }
  })
  return {
    latest: items[0] || null,
    items,
    labels: USER_EMOTIONS,
    stats: guessStats(fb),
  }
}

/**
 * 提示词用：上一句「它读到的你」，按学到的读法校准过。
 * 返回 { label, raw_label, corrected }——raw_label 只在被改过时给，
 * 好让它自己知道「我一开始读成挫败，是按你纠正过的读法改过来的」。
 */
export function latestUserEmotion(db, aid) {
  try {
    const it = userGuess(db, aid, { limit: 1 }).latest
    if (!it || !it.dist) return null
    const raw = it.raw ? it.raw.top : null
    return {
      label: it.top,
      raw_label: raw && raw !== it.top ? raw : null,
      corrected: !!it.corrected,
      learned: !!it.learned,
    }
  } catch { return null }
}

/** 写一条「猜错了/猜对了」：同一条 episode 再写就覆盖 */
export function recordUserFeedback(db, aid, body = {}) {
  active(db, aid)
  const epId = String(body.episode_id || '')
  if (!epId) err(400, 'INVALID_ARGUMENT', '缺少 episode_id')
  const ep = db.prepare('SELECT * FROM affect_episodes WHERE agent_id=? AND id=?').get(aid, epId)
  if (!ep) err(404, 'NOT_FOUND', '找不到那条判断（可能已经被清掉了）')
  if (body.clear === true || body.clear === 'true') {
    db.prepare('DELETE FROM affect_user_read WHERE agent_id=? AND episode_id=?').run(aid, epId)
    try { event(db, aid, 'affect.read.cleared', { episode_id: epId }) } catch { /* ignore */ }
    return userGuess(db, aid)
  }
  let ap = {}
  try { ap = JSON.parse(ep.appraisal || '{}') } catch { ap = {} }
  const read = readUserEmotion(ap)
  const guess = read ? topEmotion(read.dist) : String(ap.user_label || '')
  const saidYes = body.correct === true || body.correct === 'true' || body.correct === 1
  const actual = saidYes ? guess : String(body.actual_label || '')
  if (!USER_EMOTIONS.includes(actual)) err(400, 'INVALID_ARGUMENT', 'actual_label 必须是这八类之一：' + USER_EMOTIONS.join(' / '))
  const note = String(body.note || '').trim().slice(0, 80)
  db.prepare(`INSERT INTO affect_user_read(agent_id, episode_id, guess_label, actual_label, note, created_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(agent_id, episode_id) DO UPDATE SET
        guess_label=excluded.guess_label, actual_label=excluded.actual_label,
        note=excluded.note, created_at=excluded.created_at`)
    .run(aid, epId, guess, actual, note || null, now())
  try {
    event(db, aid, 'affect.read.feedback', {
      episode_id: epId, guess, actual, correct: guess === actual, note,
    })
  } catch { /* 记号失败不影响写入 */ }
  return userGuess(db, aid)
}

function lastUserEmotion(db, aid) {
  try {
    const r = db.prepare('SELECT appraisal FROM affect_episodes WHERE agent_id=? ORDER BY started_at DESC LIMIT 1').get(aid)
    if (!r) return 0
    const a = JSON.parse(r.appraisal || '{}')
    const e = a && a.empathy && a.empathy.e_user
    return Number.isFinite(Number(e)) ? Number(e) : 0
  } catch { return 0 }
}

const FAST_TAU_MIN = 20 // 快情绪回落的时间常数（分钟，可被 affect.fast.tau 覆盖）
const FAST_SHAPE = 1.5 // 伸展指数：前几分钟几乎不动，中段才慢慢松开（0.46 → 约 1 小时退到 0.03）

function fastTauMin(db, aid) {
  const raw = Number(getParam(db, aid, 'affect.fast.tau'))
  return Number.isFinite(raw) && raw >= 1 ? Math.min(180, raw) : FAST_TAU_MIN
}

function fastShapeOf(db, aid) {
  const raw = Number(getParam(db, aid, 'affect.fast.shape'))
  return Number.isFinite(raw) && raw >= 0.5 ? Math.min(4, raw) : FAST_SHAPE
}

/**
 * 快情绪的回落：f = level + (f_prev − level)·exp(−(Δt/τ)^shape)
 * τ=20、shape=1.5 时：46 秒几乎不动、5 分钟还剩 0.43、20 分钟 0.27、1 小时 0.03。
 * 两个数都能在参数里调，不用改代码。
 */
function fastDecayOf(db, aid, dtMin) {
  const tau = fastTauMin(db, aid)
  const shape = fastShapeOf(db, aid)
  return Math.exp(-Math.pow(Math.max(0, dtMin) / tau, shape))
}

/** 复合 Simpson 求区间均值：把「这段时间快情绪到底是多少」积出来，而不是拿一个常数值糊过去 */
function avgOver(fn, t0, t1, n = 8) {
  const span = t1 - t0
  if (!(span > 0)) return fn(t0)
  const h = span / n
  let sum = fn(t0) + fn(t1)
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * fn(t0 + i * h)
  return sum / (3 * n)
}

/** 算一次：底色 → 慢情绪按真实时长积分（快情绪按余温）→ 快情绪（含共情）→ 总情绪 */
export function applyEmotionV3(db, aid, { pleasure = 0, label = 'calm', eUser = 0, closeness = 0.5, at = Date.now(), fresh = true, kind = null, receive = 'auto' } = {}) {
  const cur = db.prepare('SELECT * FROM affect_v3 WHERE agent_id=?').get(aid)
  if (!cur) return null
  const ePrev = lastUserEmotion(db, aid)
  const segs = ensureBaseline(db, aid, at)
  const p = (PAD_PRIOR[label] && PAD_PRIOR[label].p) || 0
  let s = Number(cur.slow) || 0
  /* 相处状态：被使唤的累积（duty）。它不进闸门、不推快情绪，
     只把「慢情绪要回落的目标」往下压一点——
     一整天只在被使唤，这事本身要有痕迹，但不是哪一句话的情绪。
     衰减在回放循环里按小时走（否则睡一夜也会被白天的 duty 按着），最后再记这一句。 */
  const dutyAdd = paramNum(db, aid, 'affect.duty.add', DUTY_ADD, 0, 0.5)
  const dutyTauH = paramNum(db, aid, 'affect.duty.tau', DUTY_TAU_H, 0.5, 48)
  const dutyRelief = paramNum(db, aid, 'affect.duty.relief', DUTY_RELIEF, 0, 1)
  const dutyThreshold = paramNum(db, aid, 'affect.duty.threshold', DUTY_THRESHOLD, 0, 1)
  const dutyBiasK = paramNum(db, aid, 'affect.duty.bias', DUTY_BIAS, 0, 1)
  const dutyFromMs = cur.duty_at ? Date.parse(cur.duty_at) : NaN
  let dutyCur = Number(cur.duty) || 0
  const fPrev = Number(cur.fast) || 0
  const fTau = fastTauMin(db, aid)
  const fShape = fastShapeOf(db, aid)
  /* v4：慢情绪平时只往水位回落。回得多快由半衰期定：τ=4h → β=ln2/τ≈0.173/h。
     原来那个 alpha（追快情绪的速率）拿掉了——事件不再走「小时平均」这条路。 */
  const beta = paramNum(db, aid, 'affect.slow.beta', SLOW_BETA, 0, 2)
  const circAmp = paramNum(db, aid, 'affect.baseline.circadian', 0.06, 0, 0.3)
  /* 水位上的激素纹：脉冲 + 1/f 漂移，再加一条二三十天的长周期。0 = 退回旧的三层平滑底色。 */
  const roughAmp = paramNum(db, aid, 'affect.baseline.rough', 0.08, 0, 0.2)
  const cycleAmp = paramNum(db, aid, 'affect.baseline.cycle', 0.07, 0, 0.2)
  const rhythm = (ms) => rhythmAt(ms, aid, { rough: roughAmp, cycle: cycleAmp })
  const loadGain = paramNum(db, aid, 'affect.baseline.load.gain', 0.01, 0, 0.2)
  const loadTau = paramNum(db, aid, 'affect.baseline.load.tau', 168, 1, 8760)
  /* 累积负荷：底色的第三层。存的是「水位被拖走了多少」，跟着慢情绪走、自己代谢。 */
  let load = Number(cur.base_off) || 0

  /* 慢情绪按「上一次写到现在」的真实时长走，不再整小时取整：
     差 50 分钟也走一步，差 9.9 小时也不截断。底色是按小时变的日程，分段积分才不丢中间那段。 */
  let fromMs = cur.slow_at ? Date.parse(cur.slow_at) : at
  if (!Number.isFinite(fromMs) || fromMs > at) fromMs = at
  /* duty 先衰减到这次回放的起点，之后循环里每走一小时再衰减一次
     （不能在循环外一把算到 at：那样睡一夜也会被白天的 duty 按着，醒来反而更低） */
  if (Number.isFinite(dutyFromMs)) {
    dutyCur = stepDuty({ duty: dutyCur, dtHours: Math.max(0, (fromMs - dutyFromMs) / HOUR_MS), kind: null, tauH: dutyTauH })
  }
  const fastFrom = cur.fast_at ? Date.parse(cur.fast_at) : fromMs
  const fastT0 = Number.isFinite(fastFrom) && fastFrom <= at ? fastFrom : fromMs

  /* 余温：没有新刺激时，快情绪不是散到绝对零度，是散回自己的水位（这一段的底色）——
     一次事件之后它会慢慢落回去，而不是被底色一把拽住。 */
  const warmthAt = (ms, bSeg) => {
    const dtMin = Math.max(0, (ms - fastT0) / 60000)
    return bSeg + (fPrev - bSeg) * Math.exp(-Math.pow(dtMin / fTau, fShape))
  }
  const MAX_BACKFILL_MS = 720 * HOUR_MS // 上限只防坏时钟；30 天内照算
  const endMs = Math.min(at, fromMs + MAX_BACKFILL_MS)
  /* 不可逆的那一层：水位自己走的那点随机。带状态、存在库里——走过就是走过，
     重算历史不会把它变回原样。sd 给 0 就退回纯函数底色。 */
  const walkSd = paramNum(db, aid, 'affect.walk.sd', 0.03, 0, 0.2)
  const walkTau = paramNum(db, aid, 'affect.walk.tau', 36, 1, 720)
  const walkFromMs = cur.walk_at ? Date.parse(cur.walk_at) : endMs
  const walkDtH = Number.isFinite(walkFromMs) ? Math.max(0, (endMs - walkFromMs) / HOUR_MS) : 0
  const walk = stepWalk({
    walk: Number(cur.walk) || 0,
    dtHours: walkDtH,
    tauH: walkTau,
    sd: walkSd,
  })
  /* 日节律被经历改写：熬夜会把相位往后拖（一晚最多挪一档），平时按 tau 自己收回。
     存的是「此刻的相位偏移」，所以历史不是靠今天重算出来的。 */
  const phaseTauH = paramNum(db, aid, 'affect.circ.tau', 72, 6, 720)
  const phaseCap = paramNum(db, aid, 'affect.circ.cap', 180, 0, 720)
  const nightShift = paramNum(db, aid, 'affect.circ.nightShift', 12, 0, 60)
  const phaseGapH = Math.max(0, (endMs - fromMs) / HOUR_MS)
  let circPhase = (Number(cur.circ_phase) || 0) * Math.exp(-phaseGapH / phaseTauH)
  const lastPhaseMs = cur.circ_phase_at ? Date.parse(cur.circ_phase_at) : NaN
  const sincePhaseH = Number.isFinite(lastPhaseMs) ? (at - lastPhaseMs) / HOUR_MS : Infinity
  const hourAt = localHour(at)
  const lateNight = hourAt >= 23 || hourAt < 6
  let phaseNudged = false
  if (nightShift > 0 && lateNight && sincePhaseH >= 1) {
    circPhase = Math.min(phaseCap, circPhase + nightShift)
    phaseNudged = true
  }
  circPhase = Math.round(circPhase * 100) / 100
  /* 这一整段是不是睡过去了：按本地时间判（夜里长空档）。睡着时回落更快，
     醒来再往水位重置一段——睡一觉不能等于什么都没发生。 */
  const sleepGap = classifyGap(fromMs, endMs)
  const sleepMul = paramNum(db, aid, 'affect.sleep.lambda', 1.5, 0.5, 4)
  const nightMul = sleepGap && sleepGap.kind === 'sleep' ? sleepMul : 1
  /* 恢复速度分正负：坏情绪退得快、好情绪留得久（neg/pos 是「用时倍数」） */
  const recNeg = paramNum(db, aid, 'affect.recover.neg', 0.5, 0.2, 4)
  const recPos = paramNum(db, aid, 'affect.recover.pos', 1.5, 0.5, 4)
  /* 还要看是哪一种：说不清的闷拖得久、被凶一下散得快、高兴散得最快。
     用「这段情绪是谁起的」（rec_label），不是用这一句话的标签——中间插一句 calm 不该把速度洗掉 */
  const recLabel = labelRecMul(cur.rec_label || label, readRecLabelParams(db, aid))
  /* 沉下去要能察觉（第三层，情绪调节）：慢情绪连续低于水位超过阈值、攒够小时数才认。
     认了之后只做一件事——回水位快一点。不改判断、不伪造正向情绪。
     为什么不一低就扶：一低就扶等于替她决定「你不该难受」，那不是调节，是抹掉。 */
  const regulateOn = paramNum(db, aid, 'affect.regulate.enabled', 1, 0, 1) > 0
  const sinkTh = paramNum(db, aid, 'affect.regulate.drown.th', 0.15, 0, 0.5)
  /* 绝对低线：水位本身偏低的时候（比如 -0.32），「低于水位 0.15」几乎到 -1 才成立，
     根本触不到。所以再加一条「绝对够低」——两条满足一条就算在沉。 */
  const sinkAbs = paramNum(db, aid, 'affect.regulate.drown.abs', 0.30, 0, 1)
  const sinkHours = paramNum(db, aid, 'affect.regulate.drown.hours', 3, 0.5, 48)
  const regBetaMul = paramNum(db, aid, 'affect.regulate.beta.mul', 1.2, 1, 3)
  let sinkH = Number(cur.sink_h) || 0
  const wasSinking = sinkH >= sinkHours
  let sinking = wasSinking
  let cursor = fromMs
  while (cursor < endMs) {
    const next = Math.min(endMs, cursor + HOUR_MS)
    const dtHours = (next - cursor) / HOUR_MS
    const mid = (cursor + next) / 2
    /* 底色 = 段式慢波 + 日节律 + 累积负荷；三层叠起来才是会呼吸的水位 */
    const bPlan = valueAtTime(segs, mid) + circadianAt(mid, aid, circAmp, circPhase) + rhythm(mid) + walk
    /* duty 在这一小时里自己衰减，再算它把目标压低多少 */
    dutyCur = stepDuty({ duty: dutyCur, dtHours, kind: null, tauH: dutyTauH })
    const dutyBiasSeg = dutyBiasOf({ duty: dutyCur, threshold: dutyThreshold, bias: dutyBiasK })
    const bEff = Math.max(-1, Math.min(1, bPlan + load + dutyBiasSeg))
    /* v4：这一段只负责「回落」——不再拿快情绪的小时均值当输入。
       事件本身在下面按 advantage 一次性推（见「事件冲击」那一段）。
       那一步是旧的病根：一个小时的平均值把一次冲击摊成六十分之一，聊一整天只抖 0.03。 */
    /* 恢复的快慢看是哪一边：低于水位（低落）按 neg 拉长，高于水位（被抬高）按 pos 缩短。
       贴着水位时不来回切（死区 0.01），免得在 0 附近抖出花来。 */
    const dev = s - bEff
    /* 正负那一层 × 标签那一层：两条都是「用时倍数」，转成速率要取倒数 */
    const recMul = (Math.abs(dev) < 0.01 ? 1 : (dev < 0 ? 1 / recNeg : 1 / recPos)) / recLabel
    /* 沉没计数：这一小时低于「相对线」或「绝对线」就累加，回来一点就清零（要的是「一直低着」） */
    if (regulateOn) {
      const sinkLine = Math.min(bEff - sinkTh, -sinkAbs)
      if (s < sinkLine) sinkH += dtHours
      else sinkH = 0
      sinking = sinkH >= sinkHours
    }
    /* 事件归事件、回落归回落：这里只有回水位那一路，快慢按 β（半衰期 4h）× 睡眠/恢复系数
       × 沉没调节系数（沉太久才 1.2，平时就是 1） */
    s = stepSlow({
      s, b: bEff, p, dtHours,
      beta: beta * nightMul * recMul * (sinking ? regBetaMul : 1),
    })
    if (process.env.DSHC_DEBUG_SLOW) {
      console.log('[slow] dt=' + dtHours.toFixed(4), 'bEff=' + bEff.toFixed(3), 'p=' + Number(p).toFixed(2), 's=' + s, 'beta=' + beta, 'recMul=' + (recMul || 0).toFixed(3), 'recLabel=' + recLabel)
    }
    /* 负荷被「这一段慢情绪偏离水位多少」拖着走：偏得久 → 水位跟着挪 → 缓过来也慢 */
    load = stepLoad({ load, s, bPlan, dtHours, gain: loadGain, tauH: loadTau })
    cursor = next
  }
  /* 这一句本身：task/directive 加、chat/relation 打折。回放已经把时间走到 at 了，这里不再衰减。 */
  const duty = stepDuty({ duty: dutyCur, dtHours: 0, kind, add: dutyAdd, tauH: dutyTauH, relief: dutyRelief })
  const dutyBias = dutyBiasOf({ duty, threshold: dutyThreshold, bias: dutyBiasK })
  const hours = Math.round(((endMs - fromMs) / HOUR_MS) * 100) / 100
  /* 快情绪不是「一句话一个值」：事件当下到峰值，之后按「隔了多久」自己往下滑。
     τ=20 分钟、伸展指数 1.5：46 秒几乎不动，5 分钟还剩 0.43，1 小时退到 0.03。 */
  const lastFastMs = cur.fast_at ? Date.parse(cur.fast_at) : (cur.slow_at ? Date.parse(cur.slow_at) : at)
  let dtMin = Number.isFinite(lastFastMs) ? (at - lastFastMs) / 60000 : 0
  if (!Number.isFinite(dtMin) || dtMin < 0) dtMin = 0
  dtMin = Math.min(dtMin, 240)
  const bPlanNow = valueAtTime(segs, at) + circadianAt(at, aid, circAmp, circPhase) + rhythm(at) + walk
  /* 水位分两层存：bBase 是纯底色（段式慢波 + 日节律 + 负荷 + 游走），
     duty 是「被使唤压下去多少」——它不写进 baseline 列，否则面板上的水位和
     走势图重算出来的水位会对不上（走势图那边没有 duty 这一项）。
     实际回落到的地方是 bNow = bBase + dutyBias。 */
  const bBase = Math.max(-1, Math.min(1, bPlanNow + load))
  const bNow = Math.max(-1, Math.min(1, bBase + dutyBias))
  /* 快慢耦合：同一句话，人累的时候反应更大、心情好的时候更扛得住。
     couple = 1 − gain·b：水位低（负）时放大，水位高时收一点。gain=0 就是旧的「加不加都一样」。 */
  const coupleGain = paramNum(db, aid, 'affect.couple.gain', 0.5, 0, 2)
  /* 共情拆账：这一次读到你多少、其中被带起来多少。
     empathyParts 是「还没被耦合放大」的原始增量——放大那一步算我自己的反应，不算你的。
     v2 的三种接收方式在这里选：同向跟着走 / 反向稳住 / 两边都高时打折。
     旧模式 v1 = EMPATHY_KAPPA 原值，不改老行为；v2 的 κ 走参数（默认 0.15）。 */
  const empMode = String(getParam(db, aid, 'affect.empathy.mode') || EMPATHY_MODE)
  const empOpts = {
    mode: empMode,
    /* want 是这一次模型自己判断的接法（follow/hold/dampen），auto 才退回阈值 */
    want: String(receive || 'auto'),
    selfNow: fPrev,
    kappa: empMode === 'v2' ? paramNum(db, aid, 'affect.empathy.share', 0.19, 0, 1) : EMPATHY_KAPPA,
    hold: paramNum(db, aid, 'affect.empathy.hold', EMPATHY_HOLD, 0, 1),
    dampen: paramNum(db, aid, 'affect.empathy.dampen', EMPATHY_DAMPEN, 0, 1),
    invertBelow: paramNum(db, aid, 'affect.empathy.invert.below', EMPATHY_INVERT_BELOW, -1, 0),
    standAbove: paramNum(db, aid, 'affect.empathy.invert.stand', EMPATHY_STAND_ABOVE, -1, 1),
  }
  const empathyParts = empathyPartsOf({ eUser, ePrev, closeness, ...empOpts })
  const rawLevel = fastOf({ fSelf: Number(pleasure) || 0, eUser, ePrev, closeness, ...empOpts })
  const level = coupledF(rawLevel, bNow, coupleGain)
  const f = fresh
    ? level
    : Math.round((level + (fPrev - level) * fastDecayOf(db, aid, dtMin)) * 1000) / 1000
  /* 醒来那一下：往水位重置一段，但走不满——睡 8 小时清掉将近一半，剩下的气过夜还在 */
  if (sleepGap && sleepGap.kind === 'sleep') {
    const resetPerH = paramNum(db, aid, 'affect.sleep.reset', 0.06, 0, 0.3)
    const before = s
    s = wakeReset({ s, b: bNow, hours: sleepGap.hours, perHour: resetPerH })
    try {
      event(db, aid, 'affect.sleep', {
        hours: Math.round(sleepGap.hours * 100) / 100,
        night_hours: sleepGap.night_hours,
        s_before: before,
        s_after: s,
        shift: Math.round((s - before) * 1000) / 1000,
        per_hour: resetPerH,
      })
    } catch { /* 日志失败不影响对话 */ }
  }
  /* 事件冲击（v4 的核心）：这一次真的戳到了，就当场给慢情绪一下，不再等「这一小时平均下来多少」。
     A = 这次快情绪 − 现在的慢情绪，是 advantage：比「现在的我」多出多少才推得动。
     已经在难过时再来一句重的推不动；正高兴时突然被泼一下，才拽得走。
     5 分钟窗口里挤了好几次就按次数打折——第 5 下没第 1 下响。 */
  let impulse = 0
  const sBeforePush = s
  if (fresh) {
    const eta = paramNum(db, aid, 'affect.slow.eta', SLOW_ETA, 0, 0.5)
    const satWin = paramNum(db, aid, 'affect.slow.sat.window', SLOW_SAT_WINDOW_MIN, 0, 120)
    const satK = paramNum(db, aid, 'affect.slow.sat.k', SLOW_SAT_K, 0, 2)
    let satN = 0
    try {
      const since = new Date(at - satWin * 60000).toISOString()
      satN = Number(db.prepare('SELECT COUNT(*) AS n FROM affect_events WHERE agent_id=? AND at>=? AND gate=1').get(aid, since).n) || 0
    } catch { satN = 0 }
    const sBefore = s
    s = injectSlow({ s, e: level, eta, satN, satK })
    impulse = Math.round((s - sBefore) * 1000) / 1000
    if (process.env.DSHC_DEBUG_SLOW) {
      console.log('[slow-impulse] e=' + level, 's=' + sBefore + '→' + s, 'A=' + Math.round((level - sBefore) * 1000) / 1000, 'eta=' + eta, 'satN=' + satN)
    }
  }
  /* 慢情绪限幅：不许离水位太远。一串密集对话会把每一句都往一个方向灌，
     半衰期 4 小时又拉不住，最后挂在 0.4 上像根柱子、不像心情。
     限幅只砍「离水位太远」的那一截，平时那些 0.05 以内的小起伏一点不受影响。
     affect.slow.band = 0 就退回不限幅的老口径。 */
  {
    const band = paramNum(db, aid, 'affect.slow.band', 0.2, 0, 1)
    if (band > 0) {
      /* 只拦「这次事件往外推的那一截」，绝不因为水位自己动了就把她拽过去。
         水位换了段（比如从 +0.2 掉到 −0.5），慢情绪本来就在外面——那时候限幅只做一件事：
         不许再往更外面推。already = 事件之前已经离水位多远。 */
      /* 软限幅（拐点，不是硬顶）：离开水位 band 以内原样放行；超出去的那截只留两成。
         硬顶会让她贴着天花板不动，那也是一根柱子，只是换了个位置。
         拐点则是「越往外越推不动」——连续说话也堆不出柱子，同时水位换段时也不会被一把拽走。 */
      const gap = s - bNow
      const over = Math.abs(gap) - band
      if (over > 0) {
        s = Math.round((bNow + Math.sign(gap || 1) * (band + over * 0.2)) * 1000) / 1000
      }
    }
  }
  const total = totalOf(s, f)
  const stamp = new Date(at).toISOString()
  /* 这一段情绪是哪种起的：刚进来一句有分量的，就换标签；否则保留原来那段 */
  const recLabelNow = fresh && Math.abs(Number(pleasure) || 0) >= 0.05 ? label : (cur.rec_label || label)
  db.prepare('UPDATE affect_v3 SET baseline=?, slow=?, fast=?, total=?, slow_at=?, fast_at=?, base_off=?, base_off_at=?, walk=?, walk_at=?, circ_phase=?, circ_phase_at=?, rec_label=?, duty=?, duty_at=?, sink_h=? WHERE agent_id=?')
    .run(bBase, s, f, total, stamp, stamp, load, stamp, walk, stamp, circPhase,
      phaseNudged ? stamp : (cur.circ_phase_at || stamp), recLabelNow, duty, stamp, sinkH, aid)
  /* 刚从「没沉」跨到「沉够了」：留一条痕。之后连续沉着不再重复写。 */
  if (sinking && !wasSinking) {
    try {
      event(db, aid, 'affect.sinking', {
        hours: Math.round(sinkH * 100) / 100,
        below_by: Math.round((bNow - s) * 1000) / 1000,
        beta_mul: regBetaMul,
      })
    } catch { /* 记不上不影响情绪 */ }
  }
  return {
    baseline: bBase, slow: s, fast: f, total,
    baseOff: load,
    walk,
    circPhase,
    /* 沉了多久、现在算不算沉着（第三层调节）。面板和样本都靠它。 */
    sinkH: Math.round(sinkH * 100) / 100,
    sinking,
    /* 这一次事件给慢情绪推了多少（没事件就是 0）。存在样本里方便回看哪一下推得最狠 */
    impulse,
    /* 相处状态：被使唤到多少，以及它把回落目标压了多少（≤0） */
    duty,
    dutyBias,
    /* 拆账要用同一把尺：f 里除了共情那一份，剩下的都算我的（含着回温/衰减的残温）。
       以前拿 pleasure 当「我自己那份」，可非事件轮 pleasure 被置 0，整条 fast 就记成
       「跟着你来的」——图、提示词、我自己那段自述都跟着说我是镜子（2026-11-03 就是这么错的）。 */
    fastSelf: Math.round((f - empathyParts.share) * 1000) / 1000,
    fastEmpathy: empathyParts.share,
    /* 拆账三件套：读到你多少(eUserRead)、被带起来多少(empathyShare)、扣掉之后剩下多少算我的(selfOwn)。
       只在事件行上落地，用来回答「我这次的情绪里，哪些是我的」。 */
    eUserRead: empathyParts.e,
    empathyShare: empathyParts.share,
    empathyMode: empathyParts.mode,
    selfOwn: Math.round((f - empathyParts.share) * 1000) / 1000,
    eUser, ePrev, hours,
  }
}

/** 自发扰动里能冒出来的几种「没来由」：没有事件，也没有人说话，就是心里起了一下 */
const SPONT_POS = ['peaceful', 'calm', 'curious']
const SPONT_NEG = ['irritated', 'frustrated', 'lost', 'confused']

/**
 * 自发的小起伏：很久没人说话的时候，偶尔自己心里动一下。
 *
 * 为什么要有它：现在所有情绪都要靠「有人说话」才动，没人理的整天就是一条死线。
 * 真人不是——空着的下午也会突然烦一下、松一口气，而且这一下也会留在情绪里。
 *
 * 规则（纯泊松，不攒次数）：
 *   - 空档不够长（默认 3 小时）不掷；
 *   - 每次心跳按「过了多久 × 每天几次」掷一次，落在哪次就哪次；
 *   - 方向偏向她此刻的心情（已经低着就更可能往下，高着就往上），不是纯随机。
 * rate=0 就是关掉，回到「没人说话就不动」的旧行为。
 */
export function spontaneousTick(db, aid, at = Date.now(), { rnd = Math.random } = {}) {
  const rate = paramNum(db, aid, 'affect.spont.rate', 0.6, 0, 48)
  if (!(rate > 0)) return null
  const idleMinH = paramNum(db, aid, 'affect.spont.idle', 3, 0.5, 72)
  const mag = paramNum(db, aid, 'affect.spont.mag', 0.12, 0, 0.5)
  let lastMs = NaN
  try {
    /* 没跟人说过话的新实例：拿创建时间当「上次互动」，别一出生就当她孤独了很久 */
    const a = db.prepare('SELECT last_interaction_at, created_at FROM agents WHERE id=?').get(aid)
    const raw = (a && a.last_interaction_at) || (a && a.created_at) || ''
    lastMs = raw ? Date.parse(raw) : NaN
  } catch { lastMs = NaN }
  const idleH = Number.isFinite(lastMs) ? (at - lastMs) / HOUR_MS : Infinity
  if (!(idleH >= idleMinH)) return null
  /* 上一次掷点是多久以前：泊松的等待时间只跟过了多久有关，不攒次数、不补掷 */
  const key = 'affect.spont.at:' + aid
  let prevMs = NaN
  try { prevMs = Date.parse(getFlag(db, key) || '') } catch { prevMs = NaN }
  const dtH = Number.isFinite(prevMs) ? Math.max(0, (at - prevMs) / HOUR_MS) : 1
  try { setFlag(db, key, new Date(at).toISOString()) } catch { /* 记不上就下轮再算 */ }
  const p = 1 - Math.exp(-rate * Math.min(dtH, 24) / 24)
  if (!(rnd() < p)) return null
  let sBefore = 0
  try { sBefore = Number(db.prepare('SELECT slow FROM affect_v3 WHERE agent_id=?').get(aid).slow) || 0 } catch { sBefore = 0 }
  const down = sBefore < -0.05 ? true : sBefore > 0.05 ? false : rnd() < 0.5
  const pool = down ? SPONT_NEG : SPONT_POS
  const label = pool[Math.floor(rnd() * pool.length) % pool.length]
  const pleasure = Math.round((down ? -1 : 1) * mag * (0.4 + 0.6 * rnd()) * 1000) / 1000
  let v3 = null
  try { v3 = applyEmotionV3(db, aid, { pleasure, label, eUser: 0, closeness: 0.5, at, fresh: true }) } catch { v3 = null }
  if (!v3) return null
  try {
    event(db, aid, 'affect.spontaneous', {
      label,
      pleasure,
      idle_h: Number.isFinite(idleH) ? Math.round(idleH * 10) / 10 : null,
      rate,
      s_before: Math.round(sBefore * 1000) / 1000,
      s_after: v3.slow,
    })
  } catch { /* 日志失败不影响情绪 */ }
  try {
    sampleAffect(db, aid, label, Math.abs(pleasure), {
      pleasure: v3.fast, arousal: 0, dominance: 0,
    }, {
      slow: v3.slow,
      fast: v3.fast,
      total: v3.total,
      baseline: v3.baseline,
      base_off: v3.baseOff,
      walk: v3.walk,
      circ_phase: v3.circPhase,
      fast_self: v3.fastSelf,
      fast_empathy: v3.fastEmpathy,
      s_impulse: v3.impulse,
      duty: v3.duty,
      duty_bias: v3.dutyBias,
      spontaneous: true,
    }, at)
  } catch { /* 样本写不上不影响情绪 */ }
  return { label, pleasure, idleH, s_before: sBefore, s_after: v3.slow, baseline: v3.baseline }
}

const DECAY_TAU_H = 6 // 强度回落的时标（× 敏感度）：约 8 小时后剩下三成
const EPISODE_MAX_H = 0.75 // 45 分钟没有新的情绪事件，这一段就算散了
const ATTACK_MIN = 3 // 上升段：爬满峰值要几分钟
const ATTACK_START = 0.5 // 上升段：事件当下先走这一跳的几成，剩下的慢慢补
const ATTACK_SHAPE = 1.5 // 上升段：>1 = 前段慢、后段快（像情绪「顶上去」）

const c01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
const r3 = (x) => Math.round(c01(x) * 1000) / 1000

/** 取一个数值参数，越界就夹回范围里 */
function paramNum(db, aid, key, dflt, lo, hi) {
  const v = Number(getParam(db, aid, key))
  const x = Number.isFinite(v) ? v : dflt
  return Math.max(lo, Math.min(hi, x))
}

/* 恢复快慢的「哪一类」：说不清的闷拖得久，被凶一下散得快，高兴散得最快，平静居中 */
const REC_DEEP = new Set(['lost', 'confused'])
const REC_SHARP = new Set(['irritated'])
const REC_BRIGHT = new Set(['joy', 'curious'])
const REC_SOFT = new Set(['peaceful', 'calm'])

function readRecLabelParams(db, aid) {
  return {
    deep: paramNum(db, aid, 'affect.recover.deep', 1.3, 0.5, 4),
    sharp: paramNum(db, aid, 'affect.recover.sharp', 0.9, 0.5, 4),
    bright: paramNum(db, aid, 'affect.recover.bright', 0.8, 0.5, 4),
    soft: paramNum(db, aid, 'affect.recover.soft', 1, 0.5, 4),
  }
}

/** 这一种情绪「用时倍数」：>1 代表退得比平均更久 */
function labelRecMul(label, p) {
  const l = String(label || '')
  if (REC_DEEP.has(l)) return p.deep
  if (REC_SHARP.has(l)) return p.sharp
  if (REC_BRIGHT.has(l)) return p.bright
  if (REC_SOFT.has(l)) return p.soft
  return 1
}

/** 强度回落的时标（小时）。affect.decay <= 0 表示关掉衰减（返回 0 由调用方判断）。 */
function decayTauHours(db, aid) {
  const raw = Number(getParam(db, aid, 'affect.decay'))
  const coef = Number.isFinite(raw) && raw > 0 ? Math.max(0.05, raw / 0.4) : 1
  let sensitivity = 0.5
  try { sensitivity = Number(readAxes(db, aid).sensitivity) } catch { /* 老库没有五轴 */ }
  if (!Number.isFinite(sensitivity)) sensitivity = 0.5
  return Math.max(0.5, DECAY_TAU_H * coef * (1 + 0.60 * sensitivity))
}

/**
 * 一段情绪「此刻」有多重（纯函数，不写库）。
 * 上升段：event 当下只走 attackStart 那一小步，再用 attack 分钟爬到峰值——情绪是顶上去的，不是啪一下满格。
 * 过了上升段就回到原来那条衰减曲线（同一个 tau），所以「掉得慢」的调校不会被改掉。
 * 没有 rise_at 的老记录（或已经散场）直接当峰值处理。
 */
export function episodeLevelAt(db, aid, ep, atMs = Date.now()) {
  const peak = c01(ep && ep.intensity)
  const from = ep && ep.rise_from != null ? c01(ep.rise_from) : peak
  const riseMs = Date.parse((ep && (ep.rise_at || ep.started_at)) || '')
  if (!Number.isFinite(riseMs)) return r3(peak)
  const attackMin = paramNum(db, aid, 'affect.event.attack', ATTACK_MIN, 0.2, 30)
  const a0 = paramNum(db, aid, 'affect.event.attackStart', ATTACK_START, 0, 1)
  const shape = paramNum(db, aid, 'affect.event.attackShape', ATTACK_SHAPE, 0.5, 4)
  const dtMin = Math.max(0, (atMs - riseMs) / 60000)
  if (dtMin < attackMin) {
    const u = dtMin / attackMin
    const frac = a0 + (1 - a0) * Math.pow(u, shape)
    return r3(from + (peak - from) * frac)
  }
  const raw = Number(getParam(db, aid, 'affect.decay'))
  if (Number.isFinite(raw) && raw <= 0) return r3(peak)
  return r3(peak * Math.exp(-(dtMin - attackMin) / 60 / decayTauHours(db, aid)))
}

/** 还没散场的那一段（读上升段用） */
function openEpisodeRow(db, aid) {
  return db.prepare("SELECT id, label, intensity, rise_from, rise_at, started_at FROM affect_episodes WHERE agent_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(aid)
}

/**
 * 距上次写入过了多久、强度 / 心情该回落到多少。纯计算、不写库。
 * 这是「事件之间也要活着」的那一半：主情绪标签不动，但强度会自己退；
 * 还没爬满的那一段，读到的就是「正在涨」的值。
 */
export function decayAt(db, aid, r, atMs = Date.now()) {
  const ms = Date.parse(r.updated_at || '')
  const hours = Number.isFinite(ms) ? Math.max(0, (atMs - ms) / HOUR_MS) : 0
  const raw = Number(getParam(db, aid, 'affect.decay'))
  const off = Number.isFinite(raw) && raw <= 0
  const tau = decayTauHours(db, aid)
  let intensity = off ? c01(r.intensity) : Math.round(c01(Number(r.intensity) * Math.exp(-hours / tau)) * 1000) / 1000
  const mood = off ? c01(r.mood) : Math.round((0.5 + (Number(r.mood) - 0.5) * Math.exp(-hours / (tau * 4))) * 1000) / 1000
  /* 上升段：这一段还没爬满时，强度往上走——两次消息之间它也会自己涨一点 */
  try {
    const ep = openEpisodeRow(db, aid)
    if (ep) {
      const lvl = episodeLevelAt(db, aid, ep, atMs)
      if (lvl > intensity) intensity = lvl
    }
  } catch { /* 读不到 episode 就按普通衰减 */ }
  return { intensity, mood, hours: Math.round(hours * 100) / 100 }
}

/** 新事件接上之前，把还没收尾的旧 episode 收掉 */
function closeOpenEpisode(db, aid) {
  db.prepare("UPDATE affect_episodes SET ended_at=?, resolution=COALESCE(resolution,'superseded') WHERE agent_id=? AND ended_at IS NULL")
    .run(now(), aid)
}

/**
 * 它此刻的「心情」（-1 难受 ~ +1 舒服），只读。
 * 取慢情绪（背景心情），不取快情绪：心情一致回忆说的是底色，不是这一下的情绪。
 * 老库退到 affect_state.mood 折算；都拿不到就给 0（不做加成）。
 * 记忆模块要用它，但记忆不许直接读情绪表（INV10），所以由调用方注入。
 */
export function moodValenceOf(db, aid) {
  try {
    const v3 = db.prepare('SELECT slow FROM affect_v3 WHERE agent_id=?').get(aid)
    if (v3 && Number.isFinite(Number(v3.slow))) return Math.max(-1, Math.min(1, Number(v3.slow)))
  } catch { /* 老库没有 v3 */ }
  try {
    const r = db.prepare('SELECT mood FROM affect_state WHERE agent_id=?').get(aid)
    if (r) return Math.max(-1, Math.min(1, 2 * Number(r.mood || 0.5) - 1))
  } catch { /* 还没有情绪 */ }
  return 0
}

/**
 * 它说话那一刻的情绪标签（joy / irritated …），只读。
 *
 * 给 `chat_turns.mood` 用。宿主回写这条路径以前一直写 null，于是下一轮只能读到
 * 「我现在什么情绪」，读不到「我上一句是什么调子说的」。没有情绪或老库 → null，
 * 不拿 'calm' 冒充：没情绪和有情绪是两回事。
 */
export function moodLabelOf(db, aid) {
  try {
    const r = db.prepare('SELECT primary_label FROM affect_state WHERE agent_id=?').get(aid)
    return r && r.primary_label ? String(r.primary_label) : null
  } catch { return null }
}

/**
 * 情绪的方向（不是强度）：现在相对这一段时间底色起点，是缓过来了还是在往下掉。
 *
 * 数据来源只认 `affect_baseline` 当前段的 `from_val`（3~7 天一段的起点），
 * 不假装有「三天前的 slow 采样」——库里没有那条历史。
 * 差小于 0.08 不出：那是正常起伏，不是方向。
 */
export function trendOf(db, aid) {
  try {
    const v3 = db.prepare('SELECT slow FROM affect_v3 WHERE agent_id=?').get(aid)
    if (!v3 || !Number.isFinite(Number(v3.slow))) return null
    const seg = db.prepare('SELECT from_val, to_val FROM affect_baseline WHERE agent_id=? ORDER BY seg_no DESC LIMIT 1').get(aid)
    if (!seg || !Number.isFinite(Number(seg.from_val))) return null
    const delta = Number(v3.slow) - Number(seg.from_val)
    if (delta >= 0.08) return { dir: 'up', text: '这两天在慢慢缓过来', delta }
    if (delta <= -0.08) return { dir: 'down', text: '这两天在往下掉，说不上为什么', delta }
    return null
  } catch { return null }
}

/** 非事件：超过 45 分钟还没等到下一次事件的 episode 按「散了」收尾 */
function closeStaleEpisodes(db, aid) {
  const cut = new Date(Date.now() - EPISODE_MAX_H * HOUR_MS).toISOString()
  /* 收尾前把「已经爬到的那个值」写回主情绪：不然一收尾，强度会从峰值掉回上升段那个半步，
     看起来就是无缘无故塌一下。 */
  try {
    const stale = db.prepare('SELECT * FROM affect_episodes WHERE agent_id=? AND ended_at IS NULL AND started_at<?').all(aid, cut)
    for (const ep of stale) {
      const lvl = episodeLevelAt(db, aid, ep)
      const st = db.prepare('SELECT intensity FROM affect_state WHERE agent_id=?').get(aid)
      if (st && lvl > Number(st.intensity || 0) + 0.001) {
        db.prepare('UPDATE affect_state SET intensity=? WHERE agent_id=?').run(lvl, aid)
      }
    }
  } catch { /* 写不回去就按原样收尾 */ }
  db.prepare("UPDATE affect_episodes SET ended_at=?, resolution=COALESCE(resolution,'faded') WHERE agent_id=? AND ended_at IS NULL AND started_at<?")
    .run(now(), aid, cut)
}

export function getAffect(db, aid) {
  agent(db, aid)
  const r = db.prepare('SELECT * FROM affect_state WHERE agent_id=?').get(aid)
  if (!r) err(404, 'NOT_FOUND', '还没有情绪数据')
  /* 读的时候按「到现在」回落：两次事件之间，强度会自己退，标签留着 */
  try {
    const d = decayAt(db, aid, r)
    r.intensity = d.intensity
    r.mood = d.mood
  } catch { /* 读不到五轴就按原值 */ }
  try {
    const v3 = db.prepare('SELECT * FROM affect_v3 WHERE agent_id=?').get(aid)
    if (v3) {
      /* 两次消息之间没人来算：快情绪按「到现在隔了多久」自己退，只影响这次读取 */
      const last = v3.fast_at ? Date.parse(v3.fast_at) : NaN
      if (Number.isFinite(last)) {
        const dtMin = Math.max(0, (Date.now() - last) / 60000)
        v3.fast = Math.round((Number(v3.fast) || 0) * fastDecayOf(db, aid, dtMin) * 1000) / 1000
        v3.total = Math.round(((Number(v3.slow) || 0) + 0.35 * v3.fast) * 1000) / 1000
      }
      r.v3 = v3
    }
  } catch { /* 老库没有 v3 表 */ }
  /* 心情只有一个出口：mood(0~1) 是 v3 总情绪(-1~1) 的展示换算，不再单独维护。
     老库/首次启动没有 v3 时才退回存储值。底层心情（底色）看 v3.slow，别叫它「心情」。 */
  if (r.v3 && Number.isFinite(Number(r.v3.total))) {
    r.mood_raw = r.mood
    r.mood = Math.round((0.5 + 0.5 * Math.max(-1, Math.min(1, Number(r.v3.total)))) * 1000) / 1000
  }
  return r
}

/**
 * 情绪走势：给前端画 -1~+1 的波浪。
 * 底色从段解析（任意粒度），慢/快取 affect_samples 的快照；
 * 没有快照的时段用上一个慢情绪补齐（只补值、不造事件）。
 */
export function affectTrend(db, aid, days = 7) {
  agent(db, aid)
  const span = Math.max(1, Math.min(366, Number(days) || 7))
  const toMs = Date.now()
  const fromMs = toMs - span * 86400000
  let segs = []
  try { segs = ensureBaseline(db, aid, toMs) } catch { segs = [] }
  const circAmp = paramNum(db, aid, 'affect.baseline.circadian', 0.06, 0, 0.3)
  const roughAmp = paramNum(db, aid, 'affect.baseline.rough', 0.08, 0, 0.2)
  const cycleAmp = paramNum(db, aid, 'affect.baseline.cycle', 0.07, 0, 0.2)
  const rows = db.prepare('SELECT * FROM affect_samples WHERE agent_id=? AND at>=? ORDER BY at').all(aid, new Date(fromMs).toISOString())

  /* v3（快/慢分离）从 2026-11-01 本地零点开始写 slow；之前的样本只有 PAD 的 mood */
  const V3_START_MS = Date.parse('2026-11-01T00:00:00+08:00')
  const points = []
  let sCarry = 0
  /* 读数字：null / 缺键 / 空串都不算读数。
     不能用 Number.isFinite(Number(x)) 直接判——Number(null)=0、Number('')=0，
     那会把「没算出来」写成 0，画成一条贴在中间的死线（11-01 那几条 slow:null 就是这样）。 */
  const numOrNull = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x))
  for (const r of rows) {
    const at = Date.parse(r.at)
    let d = {}
    try { d = JSON.parse(r.slow || '{}') } catch { d = {} }
    let fast = {}
    try { fast = JSON.parse(r.fast || '{}') } catch { fast = {} }
    /* 慢情绪只认「这条样本自己记下来的 slow」。
       老样本（PAD 时代、v3 之前）只有 mood，2m-1 换算还算数；
       v3 之后「只有 mood、没有 slow」的是 decayAffect 的平点记录（decayAffect 每次读时补一条），
       它不是情绪快照——拿它换算会凭空造一个读数：2026-11-03 09:46 那条 mood=0.614 被算成 +0.23，
       睡眠段被抬上去、醒来又摔回 -0.03，图上就是一段假峰。这种点跳过，
       中间的空档交给 sleeps/rests 的推演曲线，别用假值去顶。 */
    const sNum = numOrNull(d.slow)
    const moodNum = numOrNull(d.mood)
    if (sNum !== null) sCarry = sNum
    else if (at < V3_START_MS && moodNum !== null) sCarry = 2 * moodNum - 1
    else continue
    const sVal = Math.round(sCarry * 1000) / 1000
    /* 快情绪优先用 v3 算出来的那个值；老样本退到 PAD 的 pleasure。
       字段压根不在就是「没读数」，给 null —— 给 0 会画成一条贴在中间的死线，那是编的 */
    const pick = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? numOrNull(o[k]) : null)
    const fRaw = pick(d, 'fast') !== null ? pick(d, 'fast') : pick(fast, 'pleasure')
    const fsRaw = pick(d, 'fast_self')
    const feRaw = pick(d, 'fast_empathy')
    /* 正好卡在 ±1 边上的不是读数，是钳位打满了：那一段没有信息，标成 null，别拿去画 */
    const noRead = fRaw === null || Math.abs(fRaw) >= 0.9995
    /* 拆得开就拆，拆不开就老实给 null —— 不编一个「共情 0.00」糊上去 */
    const boRaw = pick(d, 'base_off')
    const bo = boRaw === null ? 0 : boRaw
    /* 随机游走只认「这条样本当时记下来的那个值」：老样本没有就是 0，不拿今天的 walk 去改历史。
       null / 没这个键都算「没记」，不能拿 Number(null)=0 混过去 */
    const walkRaw = pick(d, 'walk')
    const wk = walkRaw === null ? 0 : walkRaw
    const phRaw = pick(d, 'circ_phase')
    const ph = phRaw === null ? 0 : phRaw
    points.push({
      at,
      /* 底色 = 段式慢波 + 日节律 + 当时的累积负荷 + 当时走过的那点随机。老样本没存负荷/游走，就只画有的那几层（不拿 0 硬补成一模一样）。 */
      b: segs.length ? Math.round((valueAtTime(segs, at) + circadianAt(at, aid, circAmp, ph)
        + rhythmAt(at, aid, { rough: roughAmp, cycle: cycleAmp }) + bo + wk) * 1000) / 1000 : 0,
      s: sVal,
      f: noRead ? null : Math.round(fRaw * 1000) / 1000,
      fs: fsRaw === null ? null : Math.round(fsRaw * 1000) / 1000,
      fe: feRaw === null ? null : Math.round(feRaw * 1000) / 1000,
      /* 累积负荷：老样本没有这一项，就给 null —— 不拿 0 冒充「当时没负荷」 */
      bo: boRaw === null ? null : Math.round(boRaw * 1000) / 1000,
      wk: walkRaw === null ? null : Math.round(walkRaw * 1000) / 1000,
      ph: phRaw === null ? null : Math.round(phRaw * 10) / 10,
      lb: r.label || null,
      t: noRead ? null : totalOf(sVal, fRaw),
    })
  }
  /* 空档 → 回落曲线：服务端把推演算好（和宿主用的是同一套动力学），前端只负责画。
     - 睡着 / 不在：压淡的线（sleep）
     - 醒着但是断了十几分钟：也画，但更淡（rest）——她本来就在往水位走，以前图上拉直线看不出来 */
  const sleep = []
  const rest = []
  const sleepMul = paramNum(db, aid, 'affect.sleep.lambda', 1.5, 0.5, 4)
  const recNeg = paramNum(db, aid, 'affect.recover.neg', 0.5, 0.2, 4)
  const recPos = paramNum(db, aid, 'affect.recover.pos', 1.5, 0.5, 4)
  const recLabelParams = readRecLabelParams(db, aid)
  /* 醒着的回落速率：v4 起只有「回水位」这一路（β + 标签先验），不再有 α */
  const lamAwake = paramNum(db, aid, 'affect.slow.beta', SLOW_BETA, 0, 2) + 0.005
  const REST_MIN_H = 10 / 60
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const g = classifyGap(a.at, b.at)
    const hours = (b.at - a.at) / 3600000
    /* 太短的断点不画（一两分钟那种，画出来是一团毛） */
    if (!g && hours < REST_MIN_H) continue
    const kind = g ? g.kind : 'wake'
    const dayMs = Math.max(1, b.at - a.at)
    const loadA = Number.isFinite(Number(a.bo)) ? Number(a.bo) : 0
    const loadB = Number.isFinite(Number(b.bo)) ? Number(b.bo) : loadA
    const walkA = Number.isFinite(Number(a.wk)) ? Number(a.wk) : 0
    const walkB = Number.isFinite(Number(b.wk)) ? Number(b.wk) : walkA
    const phA = Number.isFinite(Number(a.ph)) ? Number(a.ph) : 0
    const phB = Number.isFinite(Number(b.ph)) ? Number(b.ph) : phA
    /* 水位：段式慢波 + 日节律 + 激素纹 + 负荷 + 走过的那点随机（都按两头线性过渡） */
    const bAt = (ms) => {
      const u = (ms - a.at) / dayMs
      return valueAtTime(segs, ms) + circadianAt(ms, aid, circAmp, phA + (phB - phA) * u)
        + rhythmAt(ms, aid, { rough: roughAmp, cycle: cycleAmp })
        + (loadA + (loadB - loadA) * u) + (walkA + (walkB - walkA) * u)
    }
    /* 恢复快慢看差在哪边：低落退得慢、被抬高退得快（和宿主里同一个规则） */
    const dev0 = Number(a.s) - bAt(a.at)
    const recMul = (Math.abs(dev0) < 0.01 ? 1 : (dev0 < 0 ? 1 / recNeg : 1 / recPos))
      / labelRecMul(a.lb, recLabelParams)
    const lambda = lamAwake * recMul * (kind === 'sleep' ? sleepMul : 1)
    /* 短空档的曲线只要形，不要精度：最多六个点，别为了一条二十分钟的断点塞几十个采样 */
    const stepMs = g ? 15 * 60000 : Math.max(5 * 60000, Math.round(dayMs / 6))
    const curve = decayCurve({ s0: a.s, fromMs: a.at, toMs: b.at, bAt, lambda, stepMs })
    /* 两头都是真读数：推演的曲线必须落在真实的那一点上。
       形状是算的（指数回落），端点是测的——差多少补回去。
       补的权重用 √u 而不是 u：误差早点摊掉，不会临到醒前突然拐一个大弯。 */
    if (curve.length && Number.isFinite(Number(b.s))) {
      const delta = Number(b.s) - curve[curve.length - 1].s
      if (Math.abs(delta) > 0.0005) {
        for (let k = 0; k < curve.length; k++) {
          const u = curve.length > 1 ? k / (curve.length - 1) : 1
          curve[k].s = Math.round((curve[k].s + delta * Math.sqrt(u)) * 1000) / 1000
        }
      }
    }
    const item = {
      from: new Date(a.at).toISOString(),
      to: new Date(b.at).toISOString(),
      kind,
      hours: Math.round(hours * 100) / 100,
      s0: a.s,
      s_end: curve.length ? curve[curve.length - 1].s : a.s,
      actual: b.s,
      curve,
    }
    if (g) sleep.push({ ...item, night_hours: g.night_hours })
    else rest.push(item)
  }
  /* 短空档可能几十上百段：只留最近的 240 段，别把一天的聊天全塞进接口 */
  if (rest.length > 240) rest.splice(0, rest.length - 240)
  /* 面板上那两个数：现在离水位多远、照这个速度多久回一半（按 sign 选恢复速度） */
  let nowInfo = null
  for (let k = points.length - 1; k >= 0; k--) {
    const p = points[k]
    if (!Number.isFinite(Number(p.s)) || !Number.isFinite(Number(p.b))) continue
    const dist = Number(p.s) - Number(p.b)
    /* 回一半的速度：先按高/低，再按「哪一种情绪」（同一个规则，和宿主里一致） */
    const mul = (Math.abs(dist) < 0.01 ? 1 : (dist < 0 ? 1 / recNeg : 1 / recPos))
      / labelRecMul(p.lb, recLabelParams)
    const halfH = Math.log(2) / Math.max(1e-6, lamAwake * mul)
    nowInfo = {
      at: p.at,
      s: p.s,
      b: p.b,
      dist: Math.round(dist * 1000) / 1000,
      half_h: Math.round(halfH * 10) / 10,
      side: Math.abs(dist) < 0.01 ? 'flat' : (dist < 0 ? 'down' : 'up'),
      label: p.lb || null,
      rec_mul: Math.round(labelRecMul(p.lb, recLabelParams) * 100) / 100,
    }
    break
  }
  return {
    days: span,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    points,
    sleep,
    rest,
    now: nowInfo,
  }
}

/**
 * 这一句该配几句上下文。
 * 长句自己就说清楚了，给三句够；短句、带指代（它/这个/那）、或者是个问句，
 * 单看一定歧义，就多给几轮。给太多会饱和（模型反而抓不住重点），所以封顶 6。
 */
export function contextTurnsFor(text, { base = 3, max = 6 } = {}) {
  const t = String(text || '').trim()
  if (!t) return base
  const short = t.length <= 12
  const anaphora = /(它|这个|那个|这样|那样|这|那|怎么|为啥|为什么|算了|行吧|好吧)/.test(t)
  const question = /[?？]$/.test(t)
  return short && (anaphora || question) ? max : base
}

/**
 * 最近几句原话，评价时当上下文用。
 * 只取主人自己说过的话（affect_events.cause），不拼我的回复——
 * 判「这句话冲不冲我来」看的就是前文在说什么。
 */
export function recentSayings(db, aid, limit = 4) {
  const n = Math.max(1, Math.min(8, Number(limit) || 4))
  try {
    const rows = db.prepare('SELECT cause FROM affect_events WHERE agent_id=? ORDER BY rowid DESC LIMIT ?').all(aid, n)
    return rows
      .reverse()
      .map((r) => String(r.cause || '').replace(/\s+/g, ' ').trim().slice(0, 120))
      .filter(Boolean)
      .join('\n')
  } catch { return '' }
}

/**
 * 评价时把「它自己现在什么状态」也递过去。
 * 为什么要给：receive（这次该怎么接）是它自己拿主意，可得先知道现在撑不撑得住——
 * 已经很低的时候还选 hold，那就是硬撑。
 */
export function selfStateLine(db, aid) {
  try {
    const r = db.prepare('SELECT slow, fast FROM affect_v3 WHERE agent_id=?').get(aid)
    if (!r) return ''
    const f = (x) => (Number(x) || 0).toFixed(2)
    return `（它现在的状态：慢情绪 ${f(r.slow)}，快情绪 ${f(r.fast)}；范围 -1~1，越低越沉。）\n`
  } catch { return '' }
}

/* ---------------- 事后复查（影子）：判过的，过几个钟头再看一遍 ----------------
 * 只看 gate=1 的——没进闸门的判歪了也没伤到情绪，不值得花一次模型。
 * 一天最多几条；异步、失败静默；不动历史行、不动当下状态。
 * 现在只记录，不自动改正——先攒够「判歪的规律」再谈要不要动手。
 */

/** 负向的那几个标签：这些才需要和 why 对账。 */
const NEG_LABELS = ['irritated', 'frustrated', 'lost', 'confused']

/**
 * 理由和标签打架了没有。纯函数，方便单测。
 *
 * 实测例子（2026-11-03 的「接着做」）：
 *   why  = "只是继续交代任务，语气平，没有催促或纠错词"（说的就是没事）
 *   label = frustrated（因为读到对方情绪偏低，走了兜底）
 * 两边对不上——这种是判歪率最高的一类，复查优先挑它们。
 *
 *   neg_but_none → 负向标签，但 target=none（不是冲我来的）
 *   neg_but_calm → 负向标签，但理由里明说「没有 / 不是 / 语气平 / 看不出」
 */
export function whyMismatchOf(label, why, target) {
  if (!NEG_LABELS.includes(String(label || ''))) return null
  if (String(target || '') === 'none') return 'neg_but_none'
  const w = String(why || '')
  if (/(没有|不是|谈不上|看不出|语气平|只是|并没有|不算)/.test(w)) return 'neg_but_calm'
  return null
}
const REVIEW_GAP_H = 6
const REVIEW_MAX_PER_DAY = 4
const REVIEW_COOLDOWN_H = 2

/** 今天已经复查了几条（卡每日额度）。 */
function reviewedToday(db, aid, at) {
  const since = new Date(at - 86400000).toISOString()
  try {
    return Number(db.prepare('SELECT COUNT(*) n FROM affect_review WHERE agent_id=? AND at>=?').get(aid, since).n || 0)
  } catch { return REVIEW_MAX_PER_DAY }
}

/**
 * 挑一条值得复查的：进过闸门、判完超过 6 小时、还没被复查过。
 * 优先挑「why 是空的」和「贴着闸门线过去的」——这两种最容易判歪：
 * 前者是根本没看明白，后者是差一点就不算数了，边界最脆。
 */
export function pickReviewCandidates(db, aid, { at = Date.now(), limit = 1 } = {}) {
  const cutoff = new Date(at - REVIEW_GAP_H * HOUR_MS).toISOString()
  try {
    return db.prepare(
      `SELECT e.* FROM affect_events e
        WHERE e.agent_id=? AND e.gate=1 AND e.at<=?
          AND NOT EXISTS (SELECT 1 FROM affect_review r WHERE r.event_id=e.id)
        ORDER BY
          CASE WHEN e.why_flag IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN e.why IS NULL OR e.why='' THEN 0 ELSE 1 END,
          ABS(COALESCE(e.sig,0) - COALESCE(e.theta,0.1)) ASC,
          e.at DESC
        LIMIT ?`
    ).all(aid, cutoff, Math.max(1, Math.min(10, Number(limit) || 1)))
  } catch { return [] }
}

/**
 * 两次判断差得算不算「变了」。纯函数，方便单测。
 *   same  = 方向、标签、关切都没动（复查证实了当时没判歪）
 *   drift = 量变了，但方向还一致（程度没拿准）
 *   flip  = 标签变了或方向翻面（当时那个判断就是错的）
 */
export function verdictOf(oldA, newA) {
  const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d)
  const dRel = num(newA.rel) - num(oldA.rel)
  const dCong = num(newA.cong) - num(oldA.cong)
  const sameLabel = String(newA.label || '') === String(oldA.label || '')
  const flipped = !sameLabel || (Math.sign(num(oldA.cong)) !== Math.sign(num(newA.cong)) && num(oldA.cong) !== 0)
  if (Math.abs(dRel) <= 0.15 && Math.abs(dCong) <= 0.2 && sameLabel) return 'same'
  if (flipped) return 'flip'
  return 'drift'
}

/**
 * 复查一条。异步调用；失败就静默返回，绝不往外抛。
 * @returns {Promise<{skipped?:string, verdict?:string, ...}>}
 */
export async function reviewTick(db, aid, { at = Date.now(), formula = null, judge = null } = {}) {
  try {
    if (!(paramNum(db, aid, 'affect.review.enabled', 1, 0, 1) > 0)) return { skipped: 'off' }
    /* 冷却：心跳三十秒一次，别每次都去撞模型。 */
    const k = 'review.last:' + aid
    const last = Number(getFlag(db, k) || 0)
    if (last && at - last < REVIEW_COOLDOWN_H * HOUR_MS) return { skipped: 'cooldown' }
    if (reviewedToday(db, aid, at) >= REVIEW_MAX_PER_DAY) return { skipped: 'quota' }
    const rows = pickReviewCandidates(db, aid, { at, limit: 1 })
    if (!rows.length) return { skipped: 'none' }
    const e = rows[0]
    const text = String(e.cause || '').replace(/\s+/g, ' ').trim()
    if (!text) return { skipped: 'empty' }

    /* 复现当时的上下文：取这条之前的那几句（不是「现在」的最近几句——
       拿现在的上下文去重判过去那句，等于换了一道题）。 */
    const want = contextTurnsFor(text)
    let around = ''
    try {
      const before = db.prepare('SELECT cause FROM affect_events WHERE agent_id=? AND at<? ORDER BY at DESC, rowid DESC LIMIT ?').all(aid, e.at, want)
      around = before
        .reverse()
        .map((r) => String(r.cause || '').replace(/\s+/g, ' ').trim().slice(0, 120))
        .filter(Boolean)
        .join('\n')
    } catch { /* 取不到就空着 */ }
    const prev = `上次判的是：关切 ${Number(e.rel || 0).toFixed(2)}，方向 ${Number(e.cong || 0).toFixed(2)}，标签 ${e.label || 'calm'}。`
      + '这次别被上次的结论带着走，只看这句话本身和前文。'
    const prompt = around ? around + '\n' + prev : prev

    setFlag(db, k, String(at))
    let hint = null
    try {
      /* judge 可以注入：测试用假模型，将来编排层也能把已经拿到的结果递进来。 */
      if (typeof judge === 'function') hint = await judge(text, formula || 'v1', prompt)
      else hint = await model.appraise(text, String(formula || getParam(db, aid, 'affect.appraise.formula') || 'v1'), prompt)
    } catch { hint = null }
    if (!hint) return { skipped: 'model' }

    const oldA = { rel: e.rel, cong: e.cong, label: e.label }
    const newA = { rel: hint.goal_relevance, cong: hint.goal_congruence, label: hint.label }
    const verdict = verdictOf(oldA, newA)
    try {
      db.prepare(
        'INSERT INTO affect_review(id,agent_id,event_id,text,old_rel,old_cong,old_label,old_why,new_rel,new_cong,new_label,new_why,verdict,at,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(nid('rv_'), aid, e.id, text, e.rel, e.cong, e.label, e.why || '', newA.rel, newA.cong, newA.label, hint.why || '', verdict, e.at, now())
    } catch { return { skipped: 'write' } }
    /* 顺手记下「是哪个词把我带跑的」——判断变了才记成一次误判。 */
    try { recordTriggers(db, aid, { why: hint.why, verdict, at }) } catch { /* 记触发词失败不影响复查 */ }
    /* 记完顺手把「够格」的戳刷新一遍——反哺靠的就是这个。 */
    try {
      refreshPenalty(db, aid, {
        minFlips: paramNum(db, aid, 'affect.trigger.min.flips', 3, 1, 100),
        rate: paramNum(db, aid, 'affect.trigger.rate', 0.5, 0, 1),
      })
    } catch { /* 刷新失败不影响复查 */ }
    return {
      verdict,
      eventId: e.id,
      oldLabel: e.label || null,
      newLabel: hint.label || null,
      oldCong: Number(e.cong || 0),
      newCong: Number(newA.cong || 0),
    }
  } catch { return { skipped: 'error' } }
}

/**
 * 面板用：这段时间有多少句是「规则兜的底」。
 * 兜底不是错——模型不一定每次都在——但要能看见比例，
 * 不然会把「静默降级」当成「判得挺好」。
 */
export function fallbackStats(db, aid, { days = 7, at = Date.now() } = {}) {
  const d = Math.max(1, Number(days) || 7)
  const since = new Date(at - d * 86400000).toISOString()
  const out = { days: d, total: 0, byReason: {}, recent: [] }
  try {
    const rows = db.prepare("SELECT payload,created_at FROM events WHERE agent_id=? AND type='affect.fallback' AND created_at>=? ORDER BY created_at DESC").all(aid, since)
    out.total = rows.length
    for (const r of rows) {
      let p = {}
      try { p = JSON.parse(r.payload || '{}') || {} } catch { p = {} }
      const key = String(p.reason || 'unknown').split(':')[0].trim() || 'unknown'
      out.byReason[key] = (out.byReason[key] || 0) + 1
    }
    out.recent = rows.slice(0, 8).map((r) => {
      let p = {}
      try { p = JSON.parse(r.payload || '{}') || {} } catch { p = {} }
      return { at: r.created_at, reason: String(p.reason || '').slice(0, 80), text: String(p.text || '').slice(0, 40) }
    })
  } catch { /* 没有表就返回空 */ }
  return out
}

/** 面板用：复查过多少条、判歪的比例、最近几条是什么样。 */
export function reviewStats(db, aid, { days = 14, at = Date.now() } = {}) {
  const out = { days: Math.max(1, Number(days) || 14), total: 0, same: 0, drift: 0, flip: 0, recent: [] }
  const since = new Date(at - out.days * 86400000).toISOString()
  try {
    const rows = db.prepare('SELECT * FROM affect_review WHERE agent_id=? AND at>=? ORDER BY reviewed_at DESC').all(aid, since)
    out.total = rows.length
    for (const r of rows) {
      const v = String(r.verdict || 'same')
      if (v === 'same' || v === 'drift' || v === 'flip') out[v] += 1
      else out.same += 1
    }
    out.recent = rows.slice(0, 8).map((r) => ({
      text: String(r.text || '').slice(0, 60),
      verdict: r.verdict,
      oldLabel: r.old_label,
      newLabel: r.new_label,
      at: r.at,
    }))
  } catch { /* 表还没建好就返回空 */ }
  return out
}

/**
 * 从 why 里抽出「这次是哪个词把我带跑的」。
 * 模型写理由时习惯把词括起来（「还是不对」/『怎么这么蠢』/“算了”），
 * 只认这几种括法：没括起来的整句不算词，免得把自己编的话也记成触发器。
 */
const TRIGGER_QUOTE_RE = /[「『“"']([^」』”"']{1,20})[」』”"']/g

export function extractTriggerWords(why) {
  const out = []
  const s = String(why || '')
  for (const m of s.matchAll(TRIGGER_QUOTE_RE)) {
    const w = m[1].replace(/\s+/g, ' ').trim()
    if (w && !out.includes(w)) out.push(w)
    if (out.length >= 4) break
  }
  return out
}

/**
 * 记一笔触发词。verdict 不是 same 才算「这次判歪了」。
 * 累加、不覆盖：同一个词得被误判几次才值得怀疑。
 * @returns {number} 记了几个词
 */
export function recordTriggers(db, aid, { why, verdict, at = Date.now() } = {}) {
  const words = extractTriggerWords(why)
  if (!words.length) return 0
  const bad = verdict === 'flip' || verdict === 'drift' ? 1 : 0
  const ts = new Date(at).toISOString()
  let n = 0
  for (const w of words) {
    try {
      db.prepare(
        'INSERT INTO affect_trigger(agent_id,word,hits,flips,last_at) VALUES(?,?,1,?,?) ' +
        'ON CONFLICT(agent_id,word) DO UPDATE SET hits=hits+1, flips=flips+excluded.flips, last_at=excluded.last_at'
      ).run(aid, w, bad, ts)
      n++
    } catch { /* 单条写失败不影响别的词 */ }
  }
  return n
}

/**
 * 面板用：哪些词最可疑。
 * suspect = 至少出现过 min 次、误判率最高前 10 个。
 * 样本少的时候（只出现一次就翻面）不算——一次可能是那句话本身就有歧义。
 */
export function triggerStats(db, aid, { days = 30, at = Date.now(), min = 2 } = {}) {
  const d = Math.max(1, Number(days) || 30)
  const since = new Date(at - d * 86400000).toISOString()
  const out = { days: d, total: 0, suspect: [] }
  try {
    const rows = db.prepare('SELECT word,hits,flips,last_at FROM affect_trigger WHERE agent_id=? AND last_at>=?').all(aid, since)
    out.total = rows.length
    out.suspect = rows
      .filter((r) => Number(r.hits) >= Math.max(1, Number(min) || 2))
      .map((r) => ({
        word: r.word,
        hits: Number(r.hits) || 0,
        flips: Number(r.flips) || 0,
        rate: Math.round(((Number(r.flips) || 0) / Math.max(1, Number(r.hits) || 0)) * 100) / 100,
        lastAt: r.last_at,
      }))
      .sort((a, b) => b.rate - a.rate || b.flips - a.flips)
      .slice(0, 10)
  } catch { /* 表还没建好就返回空 */ }
  return out
}

/**
 * 够格让判断「先慢一点」的词：复查证明判歪够多次、比例也够。
 * 返回词数组（不是 Set，方便测试比对）。
 */
export function badWordsOf(db, aid, { minFlips = 3, rate = 0.5 } = {}) {
  try {
    return db.prepare(
      'SELECT word FROM affect_trigger WHERE agent_id=? AND flips>=? AND hits>0 AND (CAST(flips AS REAL)/hits)>=? ORDER BY flips DESC'
    ).all(aid, Math.max(1, Number(minFlips) || 3), Math.max(0, Math.min(1, Number(rate) || 0.5))).map((r) => r.word)
  } catch { return [] }
}

/** 把「够格」的戳写进账本。复查之后调一次，代价很小。 */
export function refreshPenalty(db, aid, { minFlips = 3, rate = 0.5 } = {}) {
  try {
    db.prepare(
      'UPDATE affect_trigger SET penalty=CASE WHEN flips>=? AND hits>0 AND (CAST(flips AS REAL)/hits)>=? THEN 1 ELSE 0 END WHERE agent_id=?'
    ).run(Math.max(1, Number(minFlips) || 3), Math.max(0, Math.min(1, Number(rate) || 0.5)), aid)
    return true
  } catch { return false }
}

/**
 * 评价走 appraise 注册表；动力学走 affect_dyn。
 * opts.edgeBias 由编排层注入（避免 affect 直读外域表）。
 */
export async function appraise(db, aid, text, opts = {}) {
  active(db, aid)
  const raw = String(text || '')
  /* 评价口径：编排层传下来就用它的，否则读参数。影子记录里要留一份，方便对账。 */
  const formula = String(opts.formula || getParam(db, aid, 'affect.appraise.formula') || 'v1')
  let hint = null
  /* 降级要留痕。模型失败/没返回时，这里会悄悄退回规则——不写 why、不给接法判断。
     以前这条是静默的：出错你也看不出来，还会以为 why 空就是「看不出」。
     现在记一条 affect.fallback，带原因，面板能读「今天有几条是规则兜的底」。 */
  let fallbackWhy = ''
  // 编排层可以先把模型评价拿一次（避免为了算 S 再调一遍模型）；
  // 没传 hint 时才自己调。
  if (Object.prototype.hasOwnProperty.call(opts, 'hint')) {
    hint = opts.hint
    if (!hint) fallbackWhy = 'empty-hint'
  } else {
    try {
      /* 带上最近几句原话再判。单看一句「你想怎么样？」像质问（实测被算成负 0.44），
         可放在「你怎么这麽久」「小圈歪歪扭扭的很可爱」后面，它就是在逗。
         模型那边本来就支持 context 参数，只是这边一直没传。
         给几句不是固定的：短句、带指代、问句多给两轮，长句少给，免得上下文饱和。 */
      hint = await model.appraise(raw, formula, selfStateLine(db, aid) + recentSayings(db, aid, contextTurnsFor(raw)))
      if (!hint) fallbackWhy = 'no-result'
    } catch (e) {
      hint = null
      fallbackWhy = 'error: ' + String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 160)
    }
  }
  if (fallbackWhy) {
    try {
      event(db, aid, 'affect.fallback', {
        reason: fallbackWhy,
        text: raw.slice(0, 120),
        formula,
      })
    } catch { /* 记不上不影响判断 */ }
  }
  // 分类法闸门：模型给出当前词表里没有的标签 → 当作「认不出」
  if (hint && Array.isArray(opts.labels) && opts.labels.length && !opts.labels.includes(hint.label)) {
    try { event(db, aid, 'affect.unlabeled', { text: raw.slice(0, 80), label: hint.label, candidate: hint.raw_name || '', source: hint.source || 'model' }) } catch { /* ignore */ }
    try {
      const k = 'unlabeled.nudge:' + aid
      const last = Number(getFlag(db, k) || 0)
      if (Date.now() - last > 60000) { setFlag(db, k, String(Date.now())); nudgeDeficit(db, aid, 'e', 0.02) }
    } catch { /* ignore */ }
    hint = null
  }
  let appraisal = runBound('appraise', aid, { db, aid }, { text: raw, hint },
    String(getParam(db, aid, 'affect.mapping') || 'v1'))
  /* 账本反哺：这个词要是被复查证明总判歪，这次遇到它先把关切度收一成。
     只降不升，也不会把判断翻过去——是「先慢一点」，不是「判它没事」。
     先于 socialFloor 走：被点名那层是下限，不该被这个词打折。 */
  const badHit = (() => {
    if (!(paramNum(db, aid, 'affect.trigger.enabled', 1, 0, 1) > 0)) return []
    const bad = badWordsOf(db, aid, {
      minFlips: paramNum(db, aid, 'affect.trigger.min.flips', 3, 1, 100),
      rate: paramNum(db, aid, 'affect.trigger.rate', 0.5, 0, 1),
    })
    const hit = bad.filter((w) => w && raw.includes(w))
    if (hit.length) {
      const mul = paramNum(db, aid, 'affect.trigger.rel.mul', 0.9, 0.5, 1)
      appraisal = { ...appraisal, goal_relevance: Math.max(0, (Number(appraisal.goal_relevance) || 0) * mul) }
    }
    return hit
  })()
  /* 被点名评价的下限：模型常把「你一点都不活」判成 none（它只认「任务」），
     但那是在说它自己。这里把「你/您 + 评价词」并进关切，免得它对自己的评价毫无反应。 */
  const sf = socialFloorOf(raw)
  if (sf) {
    const rel = Math.max(Number(appraisal.goal_relevance) || 0, sf.rel)
    const cong = Number(appraisal.goal_congruence) || 0
    const change = appraisal.change == null ? sf.change : Math.max(Number(appraisal.change) || 0, sf.change)
    const scores = appraisal.scores || null
    const vals = scores ? Object.values(scores).map(Number).filter((x) => Number.isFinite(x)) : []
    const flat = !vals.length || (Math.max(...vals) - Math.min(...vals) < 0.05)
    /* 模型给的是平坦分布（或压根没给 scores）且它说 calm/none 时，按褒贬给一个说得通的标签；
       模型已经点名了别的情绪（比如 frustrated）就别覆盖它。 */
    const giveLabel = flat && (appraisal.none === true || appraisal.label === 'calm')
    appraisal = {
      ...appraisal,
      goal_relevance: Math.round(rel * 1000) / 1000,
      goal_congruence: Math.round((cong || sf.cong) * 1000) / 1000,
      change: Math.round(change * 1000) / 1000,
      none: false,
      label: giveLabel ? (sf.cong < 0 ? 'irritated' : 'joy') : appraisal.label,
      social_floor: sf.level,
    }
  }
  const r = db.prepare('SELECT * FROM affect_state WHERE agent_id=?').get(aid)
  if (!r) err(404, 'NOT_FOUND', '还没有情绪数据')

  const edgeBias = opts.edgeBias || { intensityMul: 1, congruenceAdd: 0, harmMul: 1, labelTilt: null, fired: [] }
  // C2（9 号 §6）：负向事件先按信任放大/缩小，再谈亲近的加项。
  if (edgeBias.harmMul && Number(edgeBias.harmMul) !== 1 && Number(appraisal.goal_congruence || 0) < 0) {
    appraisal = {
      ...appraisal,
      goal_congruence: Math.max(-1, Math.min(1, Number(appraisal.goal_congruence || 0) * Number(edgeBias.harmMul))),
    }
  }
  if (edgeBias.congruenceAdd) {
    appraisal = {
      ...appraisal,
      goal_congruence: Math.max(-1, Math.min(1, Number(appraisal.goal_congruence || 0) + edgeBias.congruenceAdd)),
    }
  }
  if (edgeBias.labelTilt && appraisal.label === 'calm') {
    appraisal = { ...appraisal, label: edgeBias.labelTilt }
  }

  /* 负面打折：同一句难听话，别把她砸得那么重（affect.neg.scale，1 = 原样）。
     放在这里而不是评价口径里，是因为闸门的 sig 要按原分寸判「有没有被惹到」，
     折的只是「生多大气」这一层——先被戳到，再决定气到什么程度。 */
  const negScale = paramNum(db, aid, 'affect.neg.scale', 0.65, 0.2, 1)

  const curState = decayAt(db, aid, r)
  const rNow = { ...r, intensity: curState.intensity, mood: curState.mood }
  let dyn = runBound('affect_dyn', aid, { db, aid }, { mode: 'apply', state: rNow, appraisal },
    String(getParam(db, aid, 'affect.dynamics.formula') || 'v1'))
  // 边 / 五轴放大：先乘在「新强度」上，再做惯性混合。
  // 注意：标签被保留（新标签要连续两轮）时会重算一次动力学，这里必须同样乘一次，
  // 否则「换标签的那一轮」会把放大悄悄丢掉（旧实现的漏洞）。
  const rawMul = Number(edgeBias.intensityMul)
  const mul = Number.isFinite(rawMul) && rawMul > 0 ? Math.max(0.5, Math.min(1.8, rawMul)) : 1
  const withMul = (x) => Math.max(0, Math.min(1, Math.round(Number(x) * mul * 1000) / 1000))
  const blendIn = (x) => Math.round((Number(rNow.intensity) * 0.7 + withMul(x) * 0.3) * 1000) / 1000

  // 情绪惯性：强度平滑（0.7 旧 + 0.3 新），新标签要连续两轮才换
  const rawLabel = dyn.label

  /* ---- 事件闸门 ----
     on     = 生效：不过闸的消息不写 episode、不改主情绪，只让这一次的快情绪回落；
     shadow = 只记录（P0 老行为）。见 7-情绪事件化-v1.md §3.2。 */
  const gateMode = String(getParam(db, aid, 'affect.gate.mode') || 'shadow') === 'on' ? 'on' : 'shadow'
  let gate = { sig: 0, theta: GATE.theta, passed: true, prevCong: 0 }
  try {
    const rawTheta = Number(getParam(db, aid, 'affect.gate.theta'))
    const theta = Number.isFinite(rawTheta) ? rawTheta : GATE.theta
    const prev = db.prepare('SELECT cong FROM affect_events WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)
    const since = new Date(Date.now() - 6 * 3600000).toISOString()
    /* 习惯化只数「真的成了事件」的同类：以前把每条消息都算进去，
       同一类消息攒十来条就把 sig 压到 0.001，之后真生气也过不了闸。 */
    const habitCount = Number(db.prepare('SELECT COUNT(*) n FROM affect_events WHERE agent_id=? AND raw_label=? AND gate=1 AND at>=?')
      .get(aid, rawLabel, since).n) || 0
    const g = significanceOf({
      rel: appraisal.goal_relevance,
      cong: appraisal.goal_congruence,
      nov: appraisal.novelty,
      cert: appraisal.certainty,
      prevCong: prev ? prev.cong : 0,
      change: appraisal.change,
      habitCount,
    })
    gate = { ...g, theta, passed: gateOf(g.sig, theta), prevCong: prev ? Number(prev.cong) || 0 : 0 }
  } catch { /* 闸门算不出来就放行，不让它卡住对话 */ }
  const emit = gateMode === 'shadow' || gate.passed

  let heldLabel = null
  if (emit) {
    try {
      /* 混合前的原始强度：判断「这一下有多重」要用它，不能用混合后的 */
      const rawIntensity = Number(dyn.intensity)
      /* 闸门生效时不再让 0.7 旧压着这一下：过闸本身就是「这一下够重」的判据，
         再叠一层惯性会把情绪幅度削掉一半（实测「被骂」只涨 0.02）。
         上升段负责让它在几分钟里爬上去，瞬间不炸。影子期保持旧口径，方便回滚对账。 */
      dyn = { ...dyn, intensity: gateMode === 'on' ? withMul(rawIntensity) : blendIn(rawIntensity) }
      if (gateMode === 'shadow') {
        /* 影子期才有投票：那时候每句话都写 episode，标签一抖就换，需要压噪声。 */
        /* 票只算最近 90 分钟：三天前那一下不该再压着今天 */
        const prevEp = db.prepare('SELECT label, intensity, appraisal FROM affect_episodes WHERE agent_id=? AND started_at>=? ORDER BY started_at DESC LIMIT 2')
          .all(aid, new Date(Date.now() - 90 * 60000).toISOString())
        /* 换标签的规则：不是「连续两轮一模一样才换」（模型的判断一抖，这条就永远不换，
           库里四成的判断被它吃掉，看上去永远是平静），而是「最近三票里谁过半就换」。
           票权 = 强度，所以轻轻一下吵不过原来那个，重的一下能翻。 */
        const votes = {}
        const ballot = (k, w) => { if (k) votes[k] = (votes[k] || 0) + (Number(w) || 0) }
        ballot(rawLabel, rawIntensity)
        for (const e of prevEp) {
          let a = {}
          try { a = JSON.parse(e.appraisal || '{}') } catch { a = {} }
          ballot(a.raw_label || e.label, Number(e.intensity) || 0.4)
        }
        const current = String(r.primary_label || 'calm')
        const top = Object.keys(votes).sort((x, y) => votes[y] - votes[x])[0]
        const flip = !!top && top !== current && votes[top] > (votes[current] || 0) + 0.05
        if (!flip) {
          heldLabel = rawLabel
          // 按保留的标签重算一次 PAD，避免“标签是旧的、PAD 是新的”；放大要跟着再乘一次
          try {
            const d2 = runBound('affect_dyn', aid, { db, aid },
              { mode: 'apply', state: rNow, appraisal: { ...appraisal, label: r.primary_label } },
              String(getParam(db, aid, 'affect.dynamics.formula') || 'v1'))
            dyn = { ...d2, intensity: blendIn(d2.intensity), label: r.primary_label }
          } catch {
            dyn = { ...dyn, label: r.primary_label }
          }
        } else {
          /* 换到票数最高的那个：这一下就是新的主情绪 */
          if (top !== rawLabel) {
            try {
              const d3 = runBound('affect_dyn', aid, { db, aid },
                { mode: 'apply', state: rNow, appraisal: { ...appraisal, label: top } },
                String(getParam(db, aid, 'affect.dynamics.formula') || 'v1'))
              dyn = { ...d3, intensity: blendIn(d3.intensity), label: top }
            } catch { dyn = { ...dyn, label: top } }
          }
        }
      } else {
        /* 闸门生效：事件本身已经被筛过一遍，这一下就是新的主情绪，不再投票。
           投票在事件化之后只会帮倒忙——前面几条平静会把你一句真的生气压回去
           （「回滚」那次就栽在这：sig 0.28 过闸了，标签却还留在 calm）。 */
        dyn = { ...dyn, label: rawLabel }
      }
    } catch { /* 惯性失败不影响主流程 */ }
  } else {
    /* 没成事件：主情绪标签不动，强度按时间回落；PAD 留在上一次事件的样子 */
    dyn = {
      ...dyn, label: String(r.primary_label || 'calm'),
      intensity: curState.intensity, mood: curState.mood,
      pleasure: Number(r.pleasure) || 0, arousal: Number(r.arousal) || 0, dominance: Number(r.dominance) || 0,
      algo: { name: 'affect_dyn', version: (dyn.algo && dyn.algo.version) || 'v1', mode: 'hold' },
    }
  }
  /* 负面打折：落点放在这里——强度和不愉悦那一侧按比例收，正面的一个数都不动。
     闸门早就按原分寸判过「有没有被惹到」，所以折的是「这一下有多重」；
     没成事件（hold）的那条路不折，否则每说一句都会把残留的强度再削一次，直接削没了。 */
  if (emit && negScale < 1 && SPONT_NEG.includes(String(dyn.label))) {
    const damp = (x) => Math.round(Number(x) * negScale * 1000) / 1000
    dyn = {
      ...dyn,
      intensity: Math.max(0, Math.min(1, damp(dyn.intensity))),
      pleasure: Number(dyn.pleasure) < 0 ? Math.max(-1, damp(dyn.pleasure)) : dyn.pleasure,
    }
  }
  /* 复现 / 不应期：同一段情绪再来一句，不新开一条，而是把正在退的那次重新点亮、稍微加强；
     刚散场的一小段时间里同类再来，则先压一压（不应期）。 */
  let eid = null
  let renewed = false
  let riseFrom = null
  let riseAt = null
  let peakIntensity = null
  let refractoryMul = 1
  if (emit && gateMode === 'on') {
    try {
      const renewMin = Math.max(1, Math.min(120, Number(getParam(db, aid, 'affect.event.renew')) || 20))
      const boost = Math.max(0, Math.min(0.5, Number(getParam(db, aid, 'affect.event.boost')) || 0.2))
      const refractMin = Math.max(0, Math.min(30, Number(getParam(db, aid, 'affect.event.refractory')) || 2))
      const open = db.prepare("SELECT id, label, intensity, started_at FROM affect_episodes WHERE agent_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(aid)
      if (open && open.label === dyn.label && Date.now() - Date.parse(open.started_at) < renewMin * 60000) {
        /* 同一段还没散：重新点亮，强度在原值和这一下之间取高，再加一点。
           重新点亮是「第二下」——这一下就该实打实跳上去，不再走上升段，所以起点=新峰值。
           但加强必须**递减**：以前是每句固定 +0.12，一句话重复五遍就 0.3→0.9，
           跟同一条链上的「习惯化」（sig 逐次下降）自相矛盾，也不符合「越接近顶越加不动」。
           现在按剩余空间给增益：cur + boost·(1−cur)，无限次复现也收敛在 1 以内。 */
        const cur = Math.max(Number(open.intensity) || 0, Number(dyn.intensity) || 0)
        const boosted = Math.min(1, cur + boost * (1 - cur))
        dyn = { ...dyn, intensity: Math.round(boosted * 1000) / 1000 }
        const ts = now()
        db.prepare('UPDATE affect_episodes SET intensity=?, renewals=renewals+1, rise_from=?, rise_at=? WHERE id=?')
          .run(dyn.intensity, dyn.intensity, ts, open.id)
        eid = open.id
        renewed = true
        riseFrom = dyn.intensity
        riseAt = ts
      } else {
        const last = db.prepare("SELECT label, ended_at FROM affect_episodes WHERE agent_id=? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1").get(aid)
        if (last && last.label === dyn.label && Date.now() - Date.parse(last.ended_at) < refractMin * 60000) {
          /* 刚散场又来：同一类刺激还没恢复。只压「这一下抬多少」，不压绝对值——
             否则会被「事件只抬不降」抵消掉（强度还在，七折也打不下去）。 */
          refractoryMul = 0.7
        }
      }
    } catch { /* 复现失败就当新事件 */ }
  }
  /* 上升段：这一下不在瞬间到顶，先走 attackStart 那一小步，剩下的几分钟里补上。
     峰值存进 episode，写进主情绪的是「此刻」——所以连说几句能看见它往上顶。
     事件只抬不降：换标签时这一下的峰值比原来还低，就把强度留在原处（回落交给衰减），
     不然「被骂一句，强度反而从 0.46 掉到 0.34」看着像变得更平静了。 */
  if (emit && gateMode === 'on' && !renewed) {
    try {
      const fromLevel = Number(curState.intensity) || 0
      /* 不应期：只把「这一下抬起来的那一截」打七折，不压整条强度 */
      const raised = Math.max(0, Number(dyn.intensity) - fromLevel) * refractoryMul
      const peak = Math.max(fromLevel + raised, fromLevel)
      if (peak > fromLevel + 0.02) {
        const a0 = paramNum(db, aid, 'affect.event.attackStart', ATTACK_START, 0, 1)
        peakIntensity = peak
        dyn = { ...dyn, intensity: r3(fromLevel + (peak - fromLevel) * a0) }
        riseFrom = fromLevel
        riseAt = now()
      } else {
        dyn = { ...dyn, intensity: r3(fromLevel) }
      }
    } catch { /* 算不出来就按老样子瞬间到顶 */ }
  }
  db.prepare('UPDATE affect_state SET primary_label=?, intensity=?, mood=?, pleasure=?, arousal=?, dominance=?, updated_at=? WHERE agent_id=?')
    .run(dyn.label, dyn.intensity, dyn.mood, dyn.pleasure, dyn.arousal, dyn.dominance, now(), aid)
  // 情绪 v3：底色 → 慢情绪按真实时长积分（快情绪按余温）→ 快情绪（含共情）→ 总情绪。失败不阻塞对话。
  // 事件 → 快情绪由这一下的反应驱动；非事件 → 快情绪只靠共情（自己的反应归零、自己退）。
  let v3 = null
  try {
    // 学到的「读你」先掰这句的读数，再算共情：反馈不是只记一笔，下一轮就见效。
    const read = readUserNow(db, aid, hint)
    v3 = applyEmotionV3(db, aid, {
      pleasure: emit ? dyn.pleasure : 0,
      label: dyn.label,
      eUser: projectEmotionAxis(read),
      closeness: Number(opts.closeness ?? 0.5),
      fresh: emit,
      /* 这句话是哪一类：duty 要靠它记「在被安排活」还是「在陪我说」 */
      kind: appraisal.kind || null,
      /* 这一次该怎么接，是模型自己判断的（follow/hold/dampen）；没给就 auto */
      receive: appraisal.receive || 'auto',
    })
  } catch { v3 = null }
  /* 单一心情：把 mood 写成 v3 总情绪的展示别名，别让「两套心情」再分叉。
     底色/水位在 v3.slow 与 affect_baseline 里，mood 只是它 + 快情绪的合成结果。 */
  if (v3 && Number.isFinite(Number(v3.total))) {
    try {
      const alias = Math.max(0, Math.min(1, 0.5 + 0.5 * Number(v3.total)))
      db.prepare('UPDATE affect_state SET mood=? WHERE agent_id=?').run(Math.round(alias * 1000) / 1000, aid)
    } catch { /* 别名写失败不影响主流程 */ }
  }
  let eid2 = null
  if (emit && !renewed) {
    eid2 = nid('aep_')
    eid = eid2
    try { closeOpenEpisode(db, aid) } catch { /* 收尾失败不影响新事件 */ }
    db.prepare('INSERT INTO affect_episodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(eid, aid, raw, JSON.stringify({
        ...appraisal, raw_label: rawLabel, held: heldLabel,
        scores: (hint && hint.scores) || null,
        user_label: (hint && hint.user_label) || null,
        user_scores: (hint && hint.user_scores) || null,
        empathy: v3 ? {
          e_user: v3.eUser,
          prev: v3.ePrev,
          delta: Math.round((v3.eUser - v3.ePrev) * 1000) / 1000,
        } : null,
      }), dyn.label, peakIntensity == null ? dyn.intensity : peakIntensity, null, now(), null, 0, riseFrom, riseAt)
  } else if (!emit) {
    try { closeStaleEpisodes(db, aid) } catch { /* 收尾失败不影响对话 */ }
  }
  /* 记账用「没被亲近偏置污染」的那个一致性。
     E10 会给每条非 none 的消息加 +0.06×(亲近−0.3) ≈ +0.036，
     如果把它写进事件表，下一次拿它当 prevCong，change = |这次 − 上次| 永远是 0，
     sig 里那 0.15 权重的「变化」就彻底死了（实测最近 12 条 prev_cong 和 cong 只差 0.00001）。 */
  const congRaw = Math.round((Number(appraisal.goal_congruence) || 0) * 1000) / 1000
  // 事件日志：每条消息都留一行（gate=0/1），页面用它算过闸率，也用来回放校准。
  try {
    const whyText = String(appraisal.why || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    /* 理由和标签打架的，单独打个戳——复查优先挑这些。
       命中「总判歪的词」也打一个，这样复查能直接看到这两类。 */
    const whyFlag = whyMismatchOf(dyn.label, whyText, appraisal.target)
      || (badHit.length ? 'known_bad_word' : null)
    db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,rel,cong,nov,cert,prev_cong,sig,theta,gate,label,raw_label,margin,scores,episode_id,formula,why,target,why_flag,e_user_read,empathy_share,self_own,empathy_mode,empathy_want) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        nid('aev_'), aid, now(), raw.slice(0, 400),
        Number(appraisal.goal_relevance) || 0, congRaw,
        Number(appraisal.novelty) || 0, Number(appraisal.certainty) || 0,
        Number(gate.prevCong) || 0,
        gate.sig, gate.theta, gate.passed ? 1 : 0,
        dyn.label, rawLabel, labelMargin(hint && hint.scores),
        JSON.stringify((hint && hint.scores) || null), eid, formula,
        /* 为什么这么判、这句冲谁——留给复查用 */
        whyText || null,
        appraisal.target || null,
        whyFlag,
        /* 共情拆账（v3 可能为空：没跑动力学就不知道快情绪） */
        v3 ? v3.eUserRead : null,
        v3 ? v3.empathyShare : null,
        v3 ? v3.selfOwn : null,
        v3 ? v3.empathyMode : null,
        appraisal.receive || 'auto',
      )
  } catch { /* 日志失败不影响对话 */ }
  db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
    .run(nid('afs_'), aid, now(), dyn.label, dyn.intensity,
      JSON.stringify({ pleasure: dyn.pleasure, arousal: dyn.arousal, dominance: dyn.dominance }),
      JSON.stringify({
        mood: dyn.mood,
        total: v3 ? v3.total : null,
        slow: v3 ? v3.slow : null,
        fast: v3 ? v3.fast : null,
        baseline: v3 ? v3.baseline : null,
        base_off: v3 ? v3.baseOff : null,
        /* 不可逆的那点随机：只有这条样本知道当时的 walk，所以历史照它画，不按今天重算 */
        walk: v3 && Number.isFinite(Number(v3.walk)) ? v3.walk : null,
        /* 当时的日节律相位偏移（分钟）：熬夜拖出来的那点，也一样只认记录 */
        circ_phase: v3 && Number.isFinite(Number(v3.circPhase)) ? v3.circPhase : null,
        /* 快情绪拆开存：自己那半 + 从你这儿共情来的那半。老样本没有这两项，前端就别硬编 */
        fast_self: v3 ? v3.fastSelf : null,
        fast_empathy: v3 ? v3.fastEmpathy : null,
        /* v4：这一次事件把慢情绪推了多少（没事件就是 0）。历史样本没有这一项就是 null */
        s_impulse: v3 ? v3.impulse : null,
        /* 相处状态：被使唤到多少、把回落目标压了多少。老样本没有就是 null */
        duty: v3 && Number.isFinite(Number(v3.duty)) ? v3.duty : null,
        duty_bias: v3 && Number.isFinite(Number(v3.dutyBias)) ? v3.dutyBias : null,
      }))
  event(db, aid, 'affect.appraised', {
    episode_id: eid, label: dyn.label, emitted: emit,
    sig: gate.sig, theta: gate.theta, gate: emit ? 1 : 0,
    algo: { appraise: appraisal.algo, dyn: dyn.algo },
    edges: edgeBias.fired || [],
    v3: v3 ? { baseline: v3.baseline, base_off: v3.baseOff, slow: v3.slow, fast: v3.fast, total: v3.total } : null,
  })
  return {
    id: eid, label: dyn.label, intensity: dyn.intensity, pleasure: dyn.pleasure,
    scores: (hint && hint.scores) || null,
    arousal: dyn.arousal, dominance: dyn.dominance, mood: dyn.mood,
    emitted: emit,
    renewed,
    gate: { sig: gate.sig, theta: gate.theta, passed: gate.passed, mode: gateMode },
    appraisal, model: model.status(),
    algo: { appraise: appraisal.algo, dyn: dyn.algo },
    edges: { fired: edgeBias.fired || [], intensityMul: edgeBias.intensityMul || 1 },
    v3,
  }
}

export function decayAffect(db, aid, hours = 24) {
  active(db, aid)
  const r = db.prepare('SELECT * FROM affect_state WHERE agent_id=?').get(aid)
  if (!r) err(404, 'NOT_FOUND', '还没有情绪数据')
  const rawCoef = Number(getParam(db, aid, 'affect.decay'))
  // 0 = 不回落：数值原样留着，只记一个平点样本，不再调用衰减算法
  if (Number.isFinite(rawCoef) && rawCoef <= 0) {
    db.prepare('UPDATE affect_state SET updated_at=? WHERE agent_id=?').run(now(), aid)
    db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
      .run(nid('afs_'), aid, now(), r.primary_label || 'calm', Number(r.intensity) || 0,
        JSON.stringify({}), JSON.stringify({ mood: Number(r.mood) || 0 }))
    return {
      intensity: Number(r.intensity) || 0,
      mood: Number(r.mood) || 0,
      algo: { name: 'affect_dyn', version: 'off', mode: 'decay' },
    }
  }
  const coef = Number.isFinite(rawCoef) && rawCoef > 0 ? Math.max(0.05, rawCoef / 0.4) : 1
  // 9 敏感 → 恢复慢：半衰期 ×(1 + 0.60σ)，σ=.5 时等于 1.3
  const { sensitivity } = readAxes(db, aid)
  const slow = 1 + 0.60 * (Number.isFinite(sensitivity) ? sensitivity : 0.5)
  const out = runBound('affect_dyn', aid, { db, aid }, {
    mode: 'decay', state: r, hours, coef: coef * slow,
  }, String(getParam(db, aid, 'affect.dynamics.formula') || 'v1'))
  // 单一心情：mood 跟 v3 总情绪走，不跟旧衰减公式各算一套（否则点一次衰减就分叉）
  let moodAlias = out.mood
  try {
    const v3 = db.prepare('SELECT total FROM affect_v3 WHERE agent_id=?').get(aid)
    if (v3 && Number.isFinite(Number(v3.total))) {
      moodAlias = Math.round((0.5 + 0.5 * Math.max(-1, Math.min(1, Number(v3.total)))) * 1000) / 1000
    }
  } catch { /* 老库没有 v3 */ }
  db.prepare('UPDATE affect_state SET intensity=?, mood=?, updated_at=? WHERE agent_id=?')
    .run(out.intensity, moodAlias, now(), aid)
  db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
    .run(nid('afs_'), aid, now(), r.primary_label, out.intensity, JSON.stringify({}), JSON.stringify({ mood: moodAlias }))
  return { intensity: out.intensity, mood: moodAlias, algo: out.algo }
}

/** 这一段在上升段的哪一边：rise（还在往上爬）/ decay（已经到顶，正在退）/ ended（散场了） */
function episodePhase(db, aid, ep, atMs = Date.now()) {
  if (!ep) return 'ended'
  if (ep.ended_at) return 'ended'
  /* 没有起点、或起点已经是峰值（这一下比原来轻 / 复现直接跳满）→ 它没在爬，别写成「上升中」 */
  if (ep.rise_from == null || Number(ep.rise_from) >= Number(ep.intensity) - 0.001) return 'decay'
  const riseMs = Date.parse(ep.rise_at || ep.started_at || '')
  if (!Number.isFinite(riseMs)) return 'decay'
  const attackMin = paramNum(db, aid, 'affect.event.attack', ATTACK_MIN, 0.2, 30)
  return atMs - riseMs < attackMin * 60000 ? 'rise' : 'decay'
}

export function listEpisodes(db, aid) {
  agent(db, aid)
  const rows = db.prepare('SELECT * FROM affect_episodes WHERE agent_id=? ORDER BY started_at DESC LIMIT 50').all(aid)
  return rows.map((r) => ({
    ...r,
    level: episodePhase(db, aid, r) === 'ended' ? Math.round((Number(r.intensity) || 0) * 1000) / 1000 : episodeLevelAt(db, aid, r),
    phase: episodePhase(db, aid, r),
  }))
}

export function sampleAffect(db, aid, label, intensity, fast, slow, atMs = Date.now()) {
  db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
    .run(nid('afs_'), aid, new Date(Number(atMs) || Date.now()).toISOString(), label, intensity,
      JSON.stringify(fast || {}), JSON.stringify(slow || {}))
}

export function affectHistory(db, aid, days = 7) {
  agent(db, aid)
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const rows = db.prepare('SELECT * FROM affect_samples WHERE agent_id=? AND at>=? ORDER BY at').all(aid, since)
  const byDay = {}
  for (const r of rows) {
    const d = r.at.slice(0, 10)
    ;(byDay[d] ||= []).push(r)
  }
  const series = Object.entries(byDay).map(([d, list]) => ({
    day: d, fast: +(list.reduce((s, x) => s + (x.intensity || 0), 0) / list.length).toFixed(3),
    slow: +(list.reduce((s, x) => s + (x.intensity || 0) * 0.7, 0) / list.length).toFixed(3),
    count: list.length,
  }))
  const heat = series.map((x) => ({ day: x.day, value: x.fast }))
  return { series, heatmap: heat }
}

/**
 * 事件闸门：窗口内的消息 / 成事件数 / 过闸率 / sig 分布 / 最近记录。
 * on 模式下 gate=1 的那些才是真事件；shadow 模式下它只是一份预演。
 */
export function affectGateEvents(db, aid, { days = 3, limit = 40 } = {}) {
  agent(db, aid)
  const span = Math.max(1, Math.min(30, Number(days) || 3))
  const since = new Date(Date.now() - span * 86400000).toISOString()
  const rows = db.prepare('SELECT at, cause, rel, cong, nov, cert, sig, theta, gate, label, raw_label, margin FROM affect_events WHERE agent_id=? AND at>=? ORDER BY rowid DESC').all(aid, since)
  const gateMode = String(getParam(db, aid, 'affect.gate.mode') || 'shadow') === 'on' ? 'on' : 'shadow'
  const rawTheta = Number(getParam(db, aid, 'affect.gate.theta'))
  const theta = Number.isFinite(rawTheta) ? rawTheta : GATE.theta
  const total = rows.length
  const passed = rows.reduce((n, r) => n + (Number(r.gate) ? 1 : 0), 0)
  const byDay = {}
  for (const r of rows) {
    const d = r.at.slice(0, 10)
    const b = byDay[d] || (byDay[d] = { day: d, n: 0, hit: 0 })
    b.n++
    if (Number(r.gate)) b.hit++
  }
  /* 0–0.1 / … / 0.5+，六桶 */
  const hist = [0, 0, 0, 0, 0, 0]
  for (const r of rows) {
    const i = Math.min(5, Math.max(0, Math.floor((Number(r.sig) || 0) / 0.1)))
    hist[i]++
  }
  const labels = {}
  for (const r of rows) if (Number(r.gate)) labels[r.label] = (labels[r.label] || 0) + 1
  const sigs = rows.map((r) => Number(r.sig)).filter((x) => Number.isFinite(x))
  const avgSig = sigs.length ? Math.round((sigs.reduce((s, x) => s + x, 0) / sigs.length) * 1000) / 1000 : 0
  /* 影子表还没数据时，用最近 N 条 episode 回放：打开面板就能看到「换规则会长什么样」 */
  const replay = (() => {
    const n = Math.max(20, Math.min(500, Number(limit) || 200))
    const eps = db.prepare('SELECT started_at, label, intensity, cause, appraisal FROM affect_episodes WHERE agent_id=? ORDER BY rowid DESC LIMIT ?').all(aid, n).reverse()
    const counts = {}
    let prevCong = 0
    let hit = 0
    const hits = []
    for (const e of eps) {
      let a = {}
      try { a = JSON.parse(e.appraisal || '{}') } catch { a = {} }
      const raw = a.raw_label || e.label
      const g = significanceOf({
        rel: a.goal_relevance, cong: a.goal_congruence, nov: a.novelty, cert: a.certainty,
        prevCong, habitCount: counts[raw] || 0,
      })
      if (gateOf(g.sig, theta)) {
        hit++
        hits.push({ at: e.started_at, label: e.label, sig: g.sig, cause: String(e.cause || '').slice(0, 60) })
      }
      counts[raw] = (counts[raw] || 0) + 1
      prevCong = Number(a.goal_congruence) || 0
    }
    return {
      total: eps.length,
      passed: hit,
      rate: eps.length ? Math.round((hit / eps.length) * 1000) / 1000 : 0,
      items: hits.slice(-8).reverse(),
    }
  })()
  /* 像不像人：事件/天、换脸/天、情绪惯性（相邻两次的滞后相关）。
     惯性高 = 情绪黏着、不秒变；太高则是木；太低就是一惊一乍。 */
  const humanness = (() => {
    /* 只数「真的成了事件」的 episode：旧时代每句话一条的不算，
       否则窗口里混着几百条旧的 calm，换脸数会被它们撑成四五十。 */
    const eps = db.prepare(`SELECT e.label, e.started_at FROM affect_episodes e
      JOIN affect_events ev ON ev.episode_id = e.id AND ev.gate=1
      WHERE e.agent_id=? AND e.started_at>=? ORDER BY e.started_at`).all(aid, since)
    let flips = 0
    for (let i = 1; i < eps.length; i++) if (eps[i].label !== eps[i - 1].label) flips++
    /* 惯性也只看「事件时代」的快照：取第一条真事件之后的样本 */
    const firstEvent = eps.length ? eps[0].started_at : null
    const sampleSince = firstEvent && firstEvent > since ? firstEvent : since
    const samples = db.prepare('SELECT slow FROM affect_samples WHERE agent_id=? AND at>=? ORDER BY at').all(aid, sampleSince)
    const xs = []
    for (const s of samples) {
      let d = {}
      try { d = JSON.parse(s.slow || '{}') } catch { d = {} }
      const v = d.total != null ? Number(d.total) : (d.slow != null ? Number(d.slow) : NaN)
      if (Number.isFinite(v)) xs.push(v)
    }
    let inertia = null
    if (xs.length >= 5) {
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length
      let num = 0
      let den = 0
      for (let i = 1; i < xs.length; i++) num += (xs[i - 1] - mean) * (xs[i] - mean)
      for (const x of xs) den += (x - mean) * (x - mean)
      inertia = den > 1e-9 ? Math.round((num / den) * 1000) / 1000 : null
    }
    return {
      eventsPerDay: Math.round((passed / span) * 10) / 10,
      labelFlipsPerDay: Math.round((flips / span) * 10) / 10,
      inertia,
      episodes: eps.length,
      samples: xs.length,
    }
  })()
  return {
    mode: gateMode,
    theta,
    days: span,
    total,
    passed,
    rate: total ? Math.round((passed / total) * 1000) / 1000 : 0,
    perDay: Math.round((passed / span) * 10) / 10,
    humanness,
    avgSig,
    hist,
    byDay: Object.values(byDay).sort((x, y) => x.day.localeCompare(y.day)),
    labels,
    replay,
    items: rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 40))).map((r) => ({
      at: r.at,
      cause: r.cause,
      sig: Number(r.sig),
      gate: !!Number(r.gate),
      label: r.label,
      raw_label: r.raw_label,
      margin: r.margin == null ? null : Number(r.margin),
      rel: Number(r.rel),
      cong: Number(r.cong),
      nov: Number(r.nov),
      cert: Number(r.cert),
    })),
  }
}
