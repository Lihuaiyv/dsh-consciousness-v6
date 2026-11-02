/**
 * 睡眠：两段对话之间的长空档。
 *
 * 为什么单独一个模块：空档不是「没有数据」，是一段**状态**。
 * 真实身体在睡着的八小时里情绪没有停，只是换了一套规则：
 *
 *   1. 指数回落，而且比醒着快（λ_sleep ≈ 1.5 × λ_awake）——「睡一觉退一半」；
 *   2. 醒来是一次重置，不是接着昨晚（重置永远不到 100%：气过夜还在）。
 *
 * 这些函数是纯函数：宿主（applyEmotionV3 的回填）和走势接口（affectTrend）
 * 用的是同一套，所以图上推演出来的那条曲线，和她醒来时真正算出来的值是对得上的。
 *
 * 判定按**本地时间**走：夜里（22:30–09:00）的空档算睡；白天的长空档算「不在」，
 * 走正常回落，不重置——白天三个小时没说话，不代表她睡了一觉。
 */

const H = 3600000
const MIN = 60000

/** 短于这个不算睡（打盹可以更短，但短到 1 小时以内就只是「没聊」） */
export const SLEEP_MIN_H = 1.5
/** 白天多久没说话算「不在」 */
export const AWAY_MIN_H = 3
/** 夜里的起止（本地小时，可带小数）：22:30 之后、09:00 之前 */
export const NIGHT_START_H = 22.5
export const NIGHT_END_H = 9

/** 本地小时（0~24，带小数）。按运行这台机器的时区算，和 circadian 一致。 */
export function localHour(ms) {
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return 0
  return d.getHours() + d.getMinutes() / 60
}

/** 这个时刻是不是「夜里」 */
export function isNight(ms) {
  const h = localHour(ms)
  return h >= NIGHT_START_H || h < NIGHT_END_H
}

/** 用 15 分钟采样，估这段里有多少小时落在夜里 */
export function nightHoursIn(fromMs, toMs) {
  const a = Number(fromMs)
  const b = Number(toMs)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0
  const step = 15 * MIN
  let total = 0
  let night = 0
  for (let t = a; t < b; t += step) {
    total++
    if (isNight(t + step / 2)) night++
  }
  return total ? (night / total) * ((b - a) / H) : 0
}

/**
 * 一段空档是什么。
 * @returns {null | {kind:'sleep'|'away', hours:number, night_hours:number}}
 */
export function classifyGap(fromMs, toMs) {
  const a = Number(fromMs)
  const b = Number(toMs)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null
  const hours = (b - a) / H
  const nightH = nightHoursIn(a, b)
  const r2 = (x) => Math.round(x * 100) / 100
  /* 睡着：够长，而且夜里占了一大块（长到白天的那部分也算睡，比如睡到中午） */
  if (hours >= SLEEP_MIN_H && nightH >= Math.min(2, hours * 0.45)) {
    return { kind: 'sleep', hours, night_hours: r2(nightH) }
  }
  /* 不在：白天很长的一段没说话，按正常速度回落，不重置 */
  if (hours >= AWAY_MIN_H) return { kind: 'away', hours, night_hours: r2(nightH) }
  return null
}

/**
 * 空档里的推演曲线：s 以 λ 往水位回落，一步一步算出来。
 * 返回 [{at, s}]，第一个点在 from 之后一个步长，最后一个点落在 to。
 */
export function decayCurve({ s0 = 0, fromMs, toMs, bAt, lambda, stepMs = 15 * MIN } = {}) {
  const out = []
  let s = Number(s0) || 0
  const from = Number(fromMs)
  const to = Number(toMs)
  const lam = Math.max(0, Number(lambda) || 0)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return out
  let t = from
  let guard = 0
  while (t < to && guard++ < 20000) {
    const next = Math.min(to, t + stepMs)
    const dtH = (next - t) / H
    const raw = typeof bAt === 'function' ? Number(bAt(t + stepMs / 2)) : NaN
    const target = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : s
    s = target + (s - target) * Math.exp(-lam * dtH)
    out.push({ at: next, s: Math.round(s * 1000) / 1000 })
    t = next
  }
  return out
}

/**
 * 醒来那一下的重置：往水位走一段，但永远走不满。
 * 睡 1 小时几乎不重置；睡 8 小时重置 45%（封顶）。
 */
export function wakeReset({ s = 0, b = 0, hours = 0, perHour = 0.06, cap = 0.45 } = {}) {
  const rho = Math.min(Math.max(0, Number(cap) || 0), Math.max(0, Number(perHour) || 0) * Math.max(0, Number(hours) || 0))
  const out = Number(s) + rho * (Number(b) - Number(s))
  return Math.round(Math.max(-1, Math.min(1, out)) * 1000) / 1000
}

/**
 * 把一段空档的推演曲线一次算完（含醒来重置）。
 * bAt(ms) 由调用方给：宿主和接口各自拼它的水位（段式慢波 + 日节律 + 负荷）。
 */
export function sleepCurve({ fromMs, toMs, s0, bAt, kind, lambda, perHour = 0.06, cap = 0.45 }) {
  const g = kind || (classifyGap(fromMs, toMs) || {}).kind || 'away'
  const hours = (Number(toMs) - Number(fromMs)) / H
  const curve = decayCurve({ s0, fromMs, toMs, bAt, lambda })
  const last = curve.length ? curve[curve.length - 1].s : Number(s0) || 0
  const end = g === 'sleep'
    ? wakeReset({ s: last, b: typeof bAt === 'function' ? bAt(Number(toMs)) : last, hours, perHour, cap })
    : last
  return { kind: g, hours, curve, end }
}
