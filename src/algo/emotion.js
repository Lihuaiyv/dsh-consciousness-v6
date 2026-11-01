/**
 * 情绪 v3 的组合入口：把四条规则串成一次计算。
 *
 * 只做计算，不碰库、不碰 model：
 *   stepSlow   慢情绪一小时一步（86% 惯性 + 12% 底色 + 1% 标签 + 1% 快情绪）
 *   fastOf     快情绪（自己的反应 + 共情水平项 + 共情波动项）
 *   totalOf    总情绪（慢 + 0.35×快，偏移不是平分）
 *   frameOf    一次算完：下一步慢情绪、总情绪、表达档
 *
 * 接入点在 P2：affect.js 评价后调 frameOf，把 sNext / total 写回 affect_state。
 */

import { expressionFrom } from './expression.js'

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const clamp01 = (x) => clamp(x, 0, 1)
export const INERTIA = 0.86
export const W_BASE = 0.12
export const W_LABEL = 0.01
export const W_FAST = 0.01
export const KAPPA = 0.35
export const EMPATHY_KAPPA = 0.25
export const EMPATHY_SWAY = 0.5
export const CLOSE_BASE = 0.3
export const CLOSE_SPAN = 0.7

/** 慢情绪：一小时一步 */
export function stepSlow({ s = 0, b = 0, p = 0, fHourly = 0, inertia = INERTIA, wb = W_BASE, wl = W_LABEL, wf = W_FAST } = {}) {
  const out = num(inertia, INERTIA) * num(s, 0) + num(wb, W_BASE) * num(b, 0) + num(wl, W_LABEL) * num(p, 0) + num(wf, W_FAST) * num(fHourly, 0)
  return Math.round(clamp(out, -1, 1) * 1000) / 1000
}

/** 总情绪：慢 + 快在慢上的投影 */
export function totalOf(s = 0, f = 0, kappa = KAPPA) {
  const out = num(s, 0) + num(kappa, KAPPA) * num(f, 0)
  return Math.round(clamp(out, -1, 1) * 1000) / 1000
}

/**
 * 快情绪：自己的反应 + 共情。
 * 对方情绪越强（|eUser| 大）、越亲近（closeness 高），被带得越多；κ 封顶。
 */
export function fastOf({ fSelf = 0, eUser = 0, ePrev = 0, closeness = 0.5, kappa = EMPATHY_KAPPA, sway = EMPATHY_SWAY, closeBase = CLOSE_BASE, closeSpan = CLOSE_SPAN } = {}) {
  const e = clamp(num(eUser, 0), -1, 1)
  const prev = clamp(num(ePrev, 0), -1, 1)
  const c = clamp01(num(closeness, 0.5))
  const w = clamp(num(kappa, EMPATHY_KAPPA), 0, 1) * Math.abs(e) * (num(closeBase, CLOSE_BASE) + num(closeSpan, CLOSE_SPAN) * c)
  const out = num(fSelf, 0) + w * e + num(sway, EMPATHY_SWAY) * w * (e - prev)
  return Math.round(clamp(out, -1, 1) * 1000) / 1000
}

/** 一次算完：下一步慢情绪、总情绪、表达档 */
export function frameOf({ s = 0, b = 0, p = 0, f = 0, fHourly, intensity = 0.4, ei = 0.5, kappa = KAPPA } = {}) {
  const sNext = stepSlow({ s, b, p, fHourly: fHourly ?? f })
  const total = totalOf(sNext, f, kappa)
  const expression = expressionFrom({ slow: sNext, intensity, ei })
  return { s: sNext, total, expression }
}
