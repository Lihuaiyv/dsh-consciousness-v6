/**
 * 情绪 v3 的组合入口：把四条规则串成一次计算。
 *
 * 只做计算，不碰库、不碰 model：
 *   stepSlow   慢情绪：一阶跟随快情绪，底色只做长程回归
 *   fastOf     快情绪（自己的反应 + 共情水平项 + 共情波动项）
 *   totalOf    总情绪（慢 + 0.35×快，偏移不是平分）
 *   frameOf    一次算完：下一步慢情绪、总情绪、表达档
 *
 * 接入点在 P2：affect.js 评价后调 frameOf，把 sNext / total 写回 affect_state。
 *
 * 2026-11-01 改：慢情绪原来是「86% 惯性 + 12% 底色 + 1% 标签 + 1% 快情绪」，
 * 稳态里快情绪只占 7%——它稳的是底色那个数，不是刚才发生的事。现在换成一阶跟随：
 *
 *   ds/dt = α·(f − s) + β·(b − s) + ω·(p − s)
 *
 *   s* = (α·f + β·b + ω·p) / (α+β+ω)   稳态（α=0.09、β=0.07，f 五成半 / b 四成）
 *   λ  = α+β+ω                          到达速率（λ≈0.165 → τ≈6h）
 *   s(t+dt) = s* + (s − s*)·exp(−λ·dt)  精确解：走多久就按多久算，跟调用步长无关
 *
 * 两个速度是分开的：α 管「追上刚才的事」，β 管「滑回自己的水位」。
 * β 调大不是让底色赢——是让水位真正有拉力，这样底色自己的波浪（日节律 +
 * 累积负荷，见 baseline.js）才能从慢情绪上透出来。
 */

import { expressionFrom } from './expression.js'

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const clamp01 = (x) => clamp(x, 0, 1)
/** 慢情绪追快情绪的速率（每小时）。α+β 决定「多久退掉」，α:β 决定「谁说话更算数」 */
export const SLOW_ALPHA = 0.09
/** 底色回归（每小时）。不能太小：太小等于底色没力气，慢情绪会黏在刚才那一下上；
 *  也不能太大：太大就成了没心没肺。现在 α:β ≈ 9:11 → 稳态里四成半由刚才的事定、五成半由水位定，
 *  水位拉得回来，但一件大事仍然改得动她。 */
export const SLOW_BETA = 0.11
/** 标签先验的拉力（每小时）：只留一丝，不让它冒充底色 */
export const SLOW_W_LABEL = 0.005

/** 旧口径的常量，留着给老调用方对照，新代码不要再用 */

export const KAPPA = 0.35
export const EMPATHY_KAPPA = 0.25
export const EMPATHY_SWAY = 0.5
export const CLOSE_BASE = 0.3
export const CLOSE_SPAN = 0.7

/**
 * 慢情绪：真 EMA。
 * @param {object} p
 * @param {number} [p.s] 现在的慢情绪 [-1,1]
 * @param {number} [p.b] 这一段的底色 [-1,1]
 * @param {number} [p.p] 情绪标签的先验愉悦度
 * @param {number} [p.fHourly] 这一段快情绪的平均值
 * @param {number} [p.dtHours] 走了多久（小时，可小于 1）
 * @param {number} [p.alpha] 追快情绪的速率
 * @param {number} [p.beta] 回底色的速率
 * @param {number} [p.wl] 标签先验的速率
 */
export function stepSlow({ s = 0, b = 0, p = 0, fHourly = 0, dtHours = 1,
  alpha = SLOW_ALPHA, beta = SLOW_BETA, wl = SLOW_W_LABEL } = {}) {
  const cur = num(s, 0)
  const a = Math.max(0, num(alpha, SLOW_ALPHA))
  const be = Math.max(0, num(beta, SLOW_BETA))
  const w = Math.max(0, num(wl, SLOW_W_LABEL))
  const lam = a + be + w
  if (!(lam > 0)) return Math.round(clamp(cur, -1, 1) * 1000) / 1000
  const target = (a * num(fHourly, 0) + be * num(b, 0) + w * num(p, 0)) / lam
  const dt = Math.max(0, num(dtHours, 1))
  const out = target + (cur - target) * Math.exp(-lam * dt)
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

/**
 * 快慢耦合：同样的刺激，水位低（累了、压着）的时候反应更大，水位高的时候更扛得住。
 * couple = 1 − gain·b，夹在 0.4~2 之间；gain=0 就是旧的「加不加都一样」。
 */
export function coupledF(raw = 0, b = 0, gain = 0) {
  const g = Math.max(0, num(gain, 0))
  const bb = clamp(num(b, 0), -1, 1)
  const couple = clamp(1 - g * bb, 0.4, 2)
  const out = num(raw, 0) * couple
  return Math.round(clamp(out, -1, 1) * 1000) / 1000
}

/** 一次算完：下一步慢情绪、总情绪、表达档 */
export function frameOf({ s = 0, b = 0, p = 0, f = 0, fHourly, dtHours = 1, intensity = 0.4, ei = 0.5, kappa = KAPPA } = {}) {
  const sNext = stepSlow({ s, b, p, fHourly: fHourly ?? f, dtHours })
  const total = totalOf(sNext, f, kappa)
  const expression = expressionFrom({ slow: sNext, intensity, ei })
  return { s: sNext, total, expression }
}
