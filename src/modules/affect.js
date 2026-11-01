import { now } from '../db.js'
import { model, err, nid, agent, active, event, getParam, getFlag, setFlag } from '../kernel.js'
import { nudgeDeficit } from './drive.js'
import { readAxes } from './traits.js'
import { runBound } from '../algo/index.js'
import { planSegments, valueAt, valueAtTime } from '../algo/baseline.js'
import { stepSlow, fastOf, totalOf } from '../algo/emotion.js'
import { PAD_PRIOR } from '../algo/affect_dyn.js'
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

/** 某个时刻的底色值 */
export function baselineNow(db, aid, atMs = Date.now()) {
  return valueAtTime(ensureBaseline(db, aid, atMs), atMs)
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
export function projectUserEmotion(hint) {
  if (!hint || typeof hint !== 'object') return 0
  return projectEmotionAxis(readUserEmotion(hint))
}

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
/**
 * 快情绪的回落：f = level + (f_prev − level)·exp(−(Δt/τ)^shape)
 * τ=20、shape=1.5 时：46 秒几乎不动、5 分钟还剩 0.43、20 分钟 0.27、1 小时 0.03。
 * 两个数都能在参数里调，不用改代码。
 */
function fastDecayOf(db, aid, dtMin) {
  const rawTau = Number(getParam(db, aid, 'affect.fast.tau'))
  const tau = Number.isFinite(rawTau) && rawTau >= 1 ? Math.min(180, rawTau) : FAST_TAU_MIN
  const rawShape = Number(getParam(db, aid, 'affect.fast.shape'))
  const shape = Number.isFinite(rawShape) && rawShape >= 0.5 ? Math.min(4, rawShape) : FAST_SHAPE
  return Math.exp(-Math.pow(Math.max(0, dtMin) / tau, shape))
}

/** 算一次：底色 → 慢情绪按小时步进 → 快情绪（含共情）→ 总情绪 */
export function applyEmotionV3(db, aid, { pleasure = 0, label = 'calm', eUser = 0, closeness = 0.5, at = Date.now(), fresh = true } = {}) {
  const cur = db.prepare('SELECT * FROM affect_v3 WHERE agent_id=?').get(aid)
  if (!cur) return null
  const ePrev = lastUserEmotion(db, aid)
  const segs = ensureBaseline(db, aid, at)
  const p = (PAD_PRIOR[label] && PAD_PRIOR[label].p) || 0
  let s = Number(cur.slow) || 0
  const fPrev = Number(cur.fast) || 0
  let fromMs = cur.slow_at ? Date.parse(cur.slow_at) : at
  if (!Number.isFinite(fromMs)) fromMs = at
  let hours = Math.floor((at - fromMs) / HOUR_MS)
  if (!Number.isFinite(hours) || hours < 0) hours = 0
  hours = Math.min(hours, 72)
  for (let i = 1; i <= hours; i++) {
    s = stepSlow({ s, b: valueAtTime(segs, fromMs + i * HOUR_MS), p, fHourly: fPrev })
  }
  /* 快情绪不是「一句话一个值」：事件当下到峰值，之后按「隔了多久」自己往下滑。
     τ=20 分钟、伸展指数 1.5：46 秒几乎不动，5 分钟还剩 0.43，1 小时退到 0.03。 */
  const lastFastMs = cur.fast_at ? Date.parse(cur.fast_at) : (cur.slow_at ? Date.parse(cur.slow_at) : at)
  let dtMin = Number.isFinite(lastFastMs) ? (at - lastFastMs) / 60000 : 0
  if (!Number.isFinite(dtMin) || dtMin < 0) dtMin = 0
  dtMin = Math.min(dtMin, 240)
  const level = fastOf({ fSelf: Number(pleasure) || 0, eUser, ePrev, closeness })
  const f = fresh
    ? level
    : Math.round((level + (fPrev - level) * fastDecayOf(db, aid, dtMin)) * 1000) / 1000
  const total = totalOf(s, f)
  const bNow = valueAtTime(segs, at)
  const stamp = new Date(at).toISOString()
  db.prepare('UPDATE affect_v3 SET baseline=?, slow=?, fast=?, total=?, slow_at=?, fast_at=? WHERE agent_id=?')
    .run(bNow, s, f, total, stamp, stamp, aid)
  return {
    baseline: bNow, slow: s, fast: f, total,
    fastSelf: Number(pleasure) || 0,
    fastEmpathy: f - (Number(pleasure) || 0),
    eUser, ePrev, hours,
  }
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
      // 读侧单源：mood(0~1) 投影自慢情绪，避免与 v3.total / PAD mood 各说各话
      if (Number.isFinite(Number(v3.slow))) {
        r.mood = Math.max(0, Math.min(1, (Number(v3.slow) + 1) / 2))
      }
    }
  } catch { /* 老库没有 v3 表 */ }
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
  const rows = db.prepare('SELECT * FROM affect_samples WHERE agent_id=? AND at>=? ORDER BY at').all(aid, new Date(fromMs).toISOString())

  const points = []
  let sCarry = 0
  for (const r of rows) {
    const at = Date.parse(r.at)
    let d = {}
    try { d = JSON.parse(r.slow || '{}') } catch { d = {} }
    let fast = {}
    try { fast = JSON.parse(r.fast || '{}') } catch { fast = {} }
    if (Number.isFinite(Number(d.slow))) sCarry = Number(d.slow)
    else if (Number.isFinite(Number(d.mood))) sCarry = 2 * Number(d.mood) - 1
    const sVal = Math.round(sCarry * 1000) / 1000
    /* 快情绪优先用 v3 算出来的那个值；老样本退到 PAD 的 pleasure。
       字段压根不在就是「没读数」，给 null —— 给 0 会画成一条贴在中间的死线，那是编的 */
    const pick = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) && Number.isFinite(Number(o[k])) ? Number(o[k]) : null)
    const fRaw = pick(d, 'fast') !== null ? pick(d, 'fast') : pick(fast, 'pleasure')
    /* 正好卡在 ±1 边上的不是读数，是钳位打满了：那一段没有信息，标成 null，别拿去画 */
    const noRead = fRaw === null || Math.abs(fRaw) >= 0.9995
    /* 拆得开就拆，拆不开就老实给 null —— 不编一个「共情 0.00」糊上去 */
    points.push({
      at,
      b: segs.length ? Math.round(valueAtTime(segs, at) * 1000) / 1000 : 0,
      s: sVal,
      f: noRead ? null : Math.round(fRaw * 1000) / 1000,
      fs: Number.isFinite(Number(d.fast_self)) ? Math.round(Number(d.fast_self) * 1000) / 1000 : null,
      fe: Number.isFinite(Number(d.fast_empathy)) ? Math.round(Number(d.fast_empathy) * 1000) / 1000 : null,
      lb: r.label || null,
      t: noRead ? null : totalOf(sVal, fRaw),
    })
  }
  return { days: span, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), points }
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
  // 编排层可以先把模型评价拿一次（避免为了算 S 再调一遍模型）；
  // 没传 hint 时才自己调。
  if (Object.prototype.hasOwnProperty.call(opts, 'hint')) hint = opts.hint
  else {
    try {
      hint = await model.appraise(raw, formula)
    } catch { hint = null }
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
      const boost = Math.max(0, Math.min(0.5, Number(getParam(db, aid, 'affect.event.boost')) || 0.12))
      const refractMin = Math.max(0, Math.min(30, Number(getParam(db, aid, 'affect.event.refractory')) || 2))
      const open = db.prepare("SELECT id, label, intensity, started_at FROM affect_episodes WHERE agent_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(aid)
      if (open && open.label === dyn.label && Date.now() - Date.parse(open.started_at) < renewMin * 60000) {
        /* 同一段还没散：重新点亮，强度在原值和这一下之间取高，再加一点。
           重新点亮是「第二下」——这一下就该实打实跳上去，不再走上升段，所以起点=新峰值。 */
        const boosted = Math.min(1, Math.max(Number(open.intensity) || 0, Number(dyn.intensity) || 0) + boost)
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
  // 情绪 v3：底色 → 慢情绪按小时步进 → 快情绪（含共情）→ 总情绪。失败不阻塞对话。
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
    })
  } catch { v3 = null }
  // 心情投影回写：affect_state.mood 跟慢情绪走，注入 / 面板旧字段不再各算各的
  if (v3 && Number.isFinite(Number(v3.slow))) {
    const mood01 = Math.max(0, Math.min(1, (Number(v3.slow) + 1) / 2))
    try {
      db.prepare('UPDATE affect_state SET mood=? WHERE agent_id=?').run(mood01, aid)
      dyn.mood = mood01
    } catch { /* 老库 */ }
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
  // 事件日志：每条消息都留一行（gate=0/1），页面用它算过闸率，也用来回放校准。
  try {
    db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,rel,cong,nov,cert,prev_cong,sig,theta,gate,label,raw_label,margin,scores,episode_id,formula) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        nid('aev_'), aid, now(), raw.slice(0, 400),
        Number(appraisal.goal_relevance) || 0, Number(appraisal.goal_congruence) || 0,
        Number(appraisal.novelty) || 0, Number(appraisal.certainty) || 0,
        Number(gate.prevCong) || 0,
        gate.sig, gate.theta, gate.passed ? 1 : 0,
        dyn.label, rawLabel, labelMargin(hint && hint.scores),
        JSON.stringify((hint && hint.scores) || null), eid, formula,
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
        /* 快情绪拆开存：自己那半 + 从你这儿共情来的那半。老样本没有这两项，前端就别硬编 */
        fast_self: v3 ? v3.fastSelf : null,
        fast_empathy: v3 ? v3.fastEmpathy : null,
      }))
  event(db, aid, 'affect.appraised', {
    episode_id: eid, label: dyn.label,
    // 分字段：shadow 下 emit 恒真、passed 仍可假——别再用 gate:0/1 把两件事拧成一件
    passed: !!gate.passed,
    emit: !!emit,
    mode: gateMode,
    emitted: emit, // 兼容旧读方
    sig: gate.sig, theta: gate.theta,
    algo: { appraise: appraisal.algo, dyn: dyn.algo },
    edges: edgeBias.fired || [],
    v3: v3 ? { baseline: v3.baseline, slow: v3.slow, fast: v3.fast, total: v3.total } : null,
  })
  return {
    id: eid, label: dyn.label, intensity: dyn.intensity, pleasure: dyn.pleasure,
    scores: (hint && hint.scores) || null,
    arousal: dyn.arousal, dominance: dyn.dominance, mood: dyn.mood,
    emitted: emit,
    renewed,
    gate: { sig: gate.sig, theta: gate.theta, passed: gate.passed, emit: !!emit, mode: gateMode },
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
  db.prepare('UPDATE affect_state SET intensity=?, mood=?, updated_at=? WHERE agent_id=?')
    .run(out.intensity, out.mood, now(), aid)
  db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
    .run(nid('afs_'), aid, now(), r.primary_label, out.intensity, JSON.stringify({}), JSON.stringify({ mood: out.mood }))
  return { intensity: out.intensity, mood: out.mood, algo: out.algo }
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

export function sampleAffect(db, aid, label, intensity, fast, slow) {
  db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
    .run(nid('afs_'), aid, now(), label, intensity, JSON.stringify(fast || {}), JSON.stringify(slow || {}))
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
