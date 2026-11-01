/**
 * 脱敏 v1：同一个刺激反复来，冲击一次比一次小；隔久了才恢复。
 *
 * 不是「打折」，而是计数随时间自己挥发：
 *   n_eff = 历史计数 × exp(−间隔 / τ) + 1     （+1 是这一次）
 *   factor = max(floor, 1 / (1 + k·(n_eff − 1)))
 *
 * 默认 k=0.5、τ=12h 时：
 *   第 1 次 1.00，第 2 次 0.67，第 3 次 0.50，第 10 次 0.18；
 *   隔 24 小时后回来约 0.5 次的分量，接近重新开始。
 *
 * 怎么用：评价时把 intensity 乘上 factor；调用方把 nextCount / nextAt 存回去。
 */

export const TAU_H = 12
export const K = 0.5
export const FLOOR = 0.15
export const COUNT_CAP = 50

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 历史计数按小时挥发 */
export function decayedCount(count, gapMs, tauH = TAU_H) {
  const h = Math.max(0, num(gapMs, 0)) / 3600000
  return Math.max(0, num(count, 0)) * Math.exp(-h / Math.max(0.1, num(tauH, TAU_H)))
}

/**
 * @param {object} p
 * @param {number} [p.count] 上次留下的计数
 * @param {number|null} [p.lastAt] 上次时间（毫秒）
 * @param {number} [p.now] 这次时间
 * @param {number} [p.k] 衰减斜率，越大掉得越快
 * @param {number} [p.tauH] 恢复时间常数（小时）
 * @param {number} [p.floor] 最低保留，别打到 0
 */
export function desensitize({ count = 0, lastAt = null, now = Date.now(), k = K, tauH = TAU_H, floor = FLOOR, cap = COUNT_CAP } = {}) {
  const n0 = lastAt == null ? 0 : decayedCount(count, now - lastAt, tauH)
  const n = Math.min(num(cap, COUNT_CAP), n0 + 1)
  const factor = Math.max(floor, 1 / (1 + num(k, K) * (n - 1)))
  return {
    factor: Math.round(factor * 1000) / 1000,
    nextCount: Math.round(n * 1000) / 1000,
    nextAt: now,
  }
}

/** 刺激指纹：同类型 + 同标签算「同一件事」 */
export function stimulusKey(label, kind = 'chat') {
  return String(kind) + ':' + String(label || 'calm')
}
