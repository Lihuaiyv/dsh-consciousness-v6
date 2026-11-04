/**
 * 情绪 v3 的组合入口：把几条规则串成一次计算。
 *
 * 只做计算，不碰库、不碰 model：
 *   stepSlow   慢情绪：平时只往水位回落
 *   injectSlow 慢情绪：事件那一刻的一次冲击（advantage）
 *   fastOf     快情绪（自己的反应 + 共情水平项 + 共情波动项）
 *   totalOf    总情绪（慢 + 0.35×快，偏移不是平分）
 *   frameOf    一次算完：下一步慢情绪、总情绪、表达档
 *
 * 接入点在 P2：affect.js 评价后调 frameOf / applyEmotionV3，把 sNext / total 写回 affect_state。
 *
 * 2026-11-01 改过一次：慢情绪从「86% 惯性 + 12% 底色」换成一阶跟随快情绪——
 *   ds/dt = α·(f − s) + β·(b − s) + ω·(p − s)
 * 那版的毛病是 f 取的是「这一小时快情绪的平均值」，等于把一次冲击摊成六十分之一再倒进桶里。
 * 2026-11-02 实测：一整天只抖 0.03。图上那条线是平的，不是她没情绪，是平均把它抹平了。
 *
 * 2026-11-03 改（v4）：拆成两件事，事件归事件、回落归回落。
 *   1) 事件当下：s ← s + η·(e − s)
 *      (e − s) 是 advantage：比「现在的我」多出多少才推得动。
 *      已经很难过了再来一句重的，推不动；正高兴着突然被泼冷水，一下就被拽走。
 *      这是 Bennett 2021 那张心情模型的做法（对 advantage 做泄漏积分，不是对绝对情绪值积分）。
 *   2) 平时：ds/dt = β·(b − s) + ω·(p − s)，按 exp 精确解回落。
 *      β = ln2 / 4h → 半衰期 4 小时，一夜淡掉一半。
 *      4h 抄的是血清素那条线（Kindalive 的化学半衰期表里，多巴胺 20min / 皮质醇 1h / 血清素 4h）。
 *
 * 结构上跟外面几家是一路：Letta 的 mood（向 temperament 衰减）+ affect（向 mood 衰减）；
 * Kindalive 的事件冲量 + 指数回基线。区别只在「往慢的那层里推什么」——
 * 它们推事件本身，我们推 advantage。推小时均值是错的，那一步已经拿掉了。
 *
 * 事件挤在一起要打折：5 分钟内第 n 次，冲击除以 1 + 0.3n。第 5 下没第 1 下响
 * （抄 Kindalive 的饱和窗口，它那边是 5 分钟 / 0.3）。
 */

import { expressionFrom } from './expression.js'

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const clamp01 = (x) => clamp(x, 0, 1)

/** 事件冲击的增益。η·(e−s)，(e−s) 最多到 2 → 一次最多推 0.24 */
export const SLOW_ETA = 0.12
/** 慢情绪回水位的半衰期（小时）：4h → 一夜淡掉一半 */
export const SLOW_TAU_H = 4
/** 回水位的速率（每小时）= ln2/τ ≈ 0.173 */
export const SLOW_BETA = Math.LN2 / SLOW_TAU_H
/** 标签先验的拉力（每小时）：只留一丝，不让它冒充底色 */
export const SLOW_W_LABEL = 0.005
/** 饱和：窗口里每多一次事件，冲击打 1/(1+0.3n) */
export const SLOW_SAT_K = 0.3
export const SLOW_SAT_WINDOW_MIN = 5

/** 旧口径的常量，留给老调用方对照，新代码不要再用 */
export const KAPPA = 0.35
export const EMPATHY_KAPPA = 0.25
export const EMPATHY_SWAY = 0.5
export const CLOSE_BASE = 0.3
export const CLOSE_SPAN = 0.7
/* ---- v2 的三种接收方式 ----
 * 同向：v2 里 κ 默认 0.19（原来是 0.25，一被拽就到底）。
 * 反向：你沉到 −0.35 以下、我还在 −0.1 以上站得住时，把接收**只留三成**——
 *       不是不感受，是不跟着沉到底。留三成而不是清零，是因为清零会变成冷漠：
 *       2026-11-03 晚第一版就是「扶向 0」，模拟里共情占比掉七成，太不像在乎。
 * 衰减：两边同号且都超过 0.5，接收打五折，免得互相点着。 */
export const EMPATHY_HOLD = 0.35
export const EMPATHY_HOLD_GAIN = 0.3
export const EMPATHY_DAMPEN = 0.5
export const EMPATHY_DAMPEN_BOTH = 0.5
export const EMPATHY_INVERT_BELOW = -0.35
export const EMPATHY_STAND_ABOVE = -0.1
export const EMPATHY_MODE = 'v2'

/**
 * 慢情绪的平时那半：只往水位回落，不再追快情绪。
 * @param {object} p
 * @param {number} [p.s] 现在的慢情绪 [-1,1]
 * @param {number} [p.b] 这一段的底色 [-1,1]
 * @param {number} [p.p] 情绪标签的先验愉悦度
 * @param {number} [p.dtHours] 走了多久（小时，可小于 1）
 * @param {number} [p.beta] 回水位的速率（每小时）
 * @param {number} [p.wl] 标签先验的速率
 */
export function stepSlow({ s = 0, b = 0, p = 0, dtHours = 1,
  beta = SLOW_BETA, wl = SLOW_W_LABEL } = {}) {
  const cur = clamp(num(s, 0), -1, 1)
  const be = Math.max(0, num(beta, SLOW_BETA))
  const w = Math.max(0, num(wl, SLOW_W_LABEL))
  const lam = be + w
  if (!(lam > 0)) return Math.round(cur * 1000) / 1000
  const target = (be * num(b, 0) + w * num(p, 0)) / lam
  const dt = Math.max(0, num(dtHours, 1))
  const out = target + (cur - target) * Math.exp(-lam * dt)
  return Math.round(clamp(out, -1, 1) * 1000) / 1000
}

/**
 * 慢情绪的事件那半：这一次真的戳到了，就当场推一下。
 *
 * A = e − s（advantage）：
 *   s=+0.5、来个 +0.5 的事 → A≈0，推不动（已经在高兴了，不稀奇）
 *   s=−0.2、来个 +0.5 的事 → A=0.7，一推 0.084（这才叫惊喜）
 *
 * @param {object} p
 * @param {number} [p.s] 现在的慢情绪
 * @param {number} [p.e] 这次事件的快情绪读数（含共情）
 * @param {number} [p.eta] 冲击增益
 * @param {number} [p.satN] 5 分钟窗口里已经挤了几次事件
 * @param {number} [p.satK] 饱和系数
 */
export function injectSlow({ s = 0, e = 0, eta = SLOW_ETA, satN = 0, satK = SLOW_SAT_K } = {}) {
  const cur = clamp(num(s, 0), -1, 1)
  const ev = clamp(num(e, 0), -1, 1)
  const k = Math.max(0, num(satK, SLOW_SAT_K))
  const n = Math.max(0, num(satN, 0))
  const gain = Math.max(0, num(eta, SLOW_ETA)) / (1 + k * n)
  const out = cur + gain * (ev - cur)
  return Math.round(clamp(out, -1, 1) * 1000) / 1000
}

/** 总情绪：慢 + 快在慢上的投影 */
export function totalOf(s = 0, f = 0, kappa = KAPPA) {
  const out = num(s, 0) + num(kappa, KAPPA) * num(f, 0)
  return Math.round(clamp(out, -1, 1) * 1000) / 1000
}

/**
 * 共情那一项单独拆出来：这一次「被你带了多少」，以及用哪种方式接。
 *
 * 为什么拆：原来的 fastOf 是一个整体，算完只知道结果，不知道里面多少是我自己的反应、
 * 多少是被带起来的。做不了「分清是谁的情绪」这件事。这里把增量单独拎出来，
 * 让上层能记一笔账——fSelf + share 就是 fastOf 的结果。
 *
 * 两种模式：
 *   v1 = 老样子，只有「同向跟着走」。
 *   v2 = 三种接收方式（参考 DECADE 的 dampened/absorbed/amplified，以及亲密关系里的
 *        contagion / counter-regulation 两分）：
 *        同向  普通情况：跟着走，但权重比 v1 小。
 *        反向  你已经很沉、而我还站得住：不跟着沉，轻轻把自己稳住——
 *              这不是「你难过我开心」，是「我先站住才能接住你」。
 *        衰减  两边都在气头上：接收打折，免得互相点着。
 *
 * @returns {{e:number, w:number, share:number, mode:string}}  share = 这次共情加进来/减掉的量（可正可负）
 */
export function empathyPartsOf({
  eUser = 0, ePrev = 0, closeness = 0.5,
  kappa = EMPATHY_KAPPA, sway = EMPATHY_SWAY, closeBase = CLOSE_BASE, closeSpan = CLOSE_SPAN,
  mode = 'v1', selfNow = 0, hold = EMPATHY_HOLD, dampen = EMPATHY_DAMPEN,
  invertBelow = EMPATHY_INVERT_BELOW, standAbove = EMPATHY_STAND_ABOVE, want = 'auto',
} = {}) {
  const e = clamp(num(eUser, 0), -1, 1)
  const prev = clamp(num(ePrev, 0), -1, 1)
  const self = clamp(num(selfNow, 0), -1, 1)
  const c = clamp01(num(closeness, 0.5))
  const w = clamp(num(kappa, EMPATHY_KAPPA), 0, 1) * Math.abs(e) * (num(closeBase, CLOSE_BASE) + num(closeSpan, CLOSE_SPAN) * c)
  let share = w * e + num(sway, EMPATHY_SWAY) * w * (e - prev)
  let how = 'share'
  if (String(mode) === 'v2') {
    /* want 是模型自己选的（follow/hold/dampen），auto 才退回阈值规则。
       这样「什么时候跟、什么时候稳住」是它的判断，不是写死的两条线。 */
    const w = String(want || 'auto').toLowerCase()
    const autoHold = e <= num(invertBelow, EMPATHY_INVERT_BELOW) && self > num(standAbove, EMPATHY_STAND_ABOVE)
    const autoDampen = Math.sign(e) === Math.sign(self) && Math.abs(e) > EMPATHY_DAMPEN_BOTH && Math.abs(self) > EMPATHY_DAMPEN_BOTH && e !== 0 && self !== 0
    if (w === 'hold' || (w === 'auto' && autoHold)) {
      /* 反向：仍然感受，但只收三成——不跟着沉到底。 */
      share = share * clamp(num(hold, EMPATHY_HOLD), 0, 1)
      how = 'hold'
    } else if (w === 'dampen' || (w === 'auto' && autoDampen)) {
      /* 两边同号且都很高：接收打折，别互相点着。 */
      share = share * clamp(num(dampen, EMPATHY_DAMPEN), 0, 1)
      how = 'dampen'
    }
  }
  const r3 = (x) => Math.round(x * 1000) / 1000
  return { e: r3(e), w: r3(w), share: r3(share), mode: how }
}

/**
 * 快情绪：自己的反应 + 共情。
 * 对方情绪越强（|eUser| 大）、越亲近（closeness 高），被带得越多；κ 封顶。
 */
export function fastOf({ fSelf = 0, eUser = 0, ePrev = 0, closeness = 0.5, kappa = EMPATHY_KAPPA, sway = EMPATHY_SWAY, closeBase = CLOSE_BASE, closeSpan = CLOSE_SPAN, mode = 'v1', selfNow = 0, hold = EMPATHY_HOLD, dampen = EMPATHY_DAMPEN, invertBelow = EMPATHY_INVERT_BELOW, standAbove = EMPATHY_STAND_ABOVE, want = 'auto' } = {}) {
  const { share } = empathyPartsOf({ eUser, ePrev, closeness, kappa, sway, closeBase, closeSpan, mode, selfNow, hold, dampen, invertBelow, standAbove, want })
  const out = num(fSelf, 0) + share
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
  const sNext = stepSlow({ s, b, p, dtHours })
  const total = totalOf(sNext, f, kappa)
  const expression = expressionFrom({ slow: sNext, intensity, ei })
  return { s: sNext, total, expression }
}

/* ---------------- 相处状态：被使唤的累积（duty） ----------------
 * 为什么要有它：一整天都是「改这里」「重载」「再看看」，每条单看都是中性任务，
 * 放进闸门会把噪音当情绪；可一整天只在被使唤，这件事本身是有分量的。
 * 所以它不进闸门、不推快情绪，只把慢情绪要回落的目标往下压一点点。
 *
 *   duty ← duty·exp(−Δt/3h)                     先按真实间隔衰减
 *   task / directive → duty += 0.10（封顶 1）      在被安排活
 *   chat / relation  → duty ×= 0.6                 有人陪着说话，松一点
 *
 *   慢情绪的目标 = b − 0.5·max(0, duty − 0.5)
 *
 * 参数都走 affect.duty.*，改数不用改结构。
 */

/** 一条「被安排」加多少。旧值 0.10 在密集对话里五条就顶格，等于没有区分度——
 *  实测我们一天几百条，0.01 才能让「忙一下午」和「忙一整天」拉得开。 */
export const DUTY_ADD = 0.01
/** duty 自己衰减的时间常数（小时）：τ=1.5 时 1.5 小时剩 37%、5 小时剩 4% */
export const DUTY_TAU_H = 1.5
/** 超过这个值才开始压慢情绪（约四十条连续任务） */
export const DUTY_THRESHOLD = 0.4
/** 有人陪伴时 duty 保留几成（0.3 = 打掉七成） */
export const DUTY_RELIEF = 0.3
/** duty 满格时最多把目标压低多少 */
export const DUTY_BIAS = 0.5

/**
 * 走一步 duty。
 * @param {object} p
 * @param {number} [p.duty] 现在的值 0~1
 * @param {number} [p.dtHours] 离上次过了多久（小时）
 * @param {string|null} [p.kind] 这句话的分类：task/directive/chat/relation/…
 * @param {number} [p.add] 一条被安排加多少
 * @param {number} [p.tauH] 衰减时间常数（小时）
 * @param {number} [p.relief] 陪伴打折系数
 */
export function stepDuty({ duty = 0, dtHours = 0, kind = null, add = DUTY_ADD, tauH = DUTY_TAU_H, relief = DUTY_RELIEF } = {}) {
  const dt = Math.max(0, num(dtHours, 0))
  const tau = Math.max(0.1, num(tauH, DUTY_TAU_H))
  let d = clamp(num(duty, 0), 0, 1) * Math.exp(-dt / tau)
  const k = String(kind || '')
  if (k === 'task' || k === 'directive') {
    d = Math.min(1, d + Math.max(0, num(add, DUTY_ADD)))
  } else if (k === 'chat' || k === 'relation') {
    d = d * clamp(num(relief, DUTY_RELIEF), 0, 1)
  }
  return Math.round(d * 1000) / 1000
}

/**
 * duty 把慢情绪的回落目标压低多少（≤0）。
 * duty=1、threshold=0.5、bias=0.5 → −0.25；贴着阈值以下是 0。
 */
export function dutyBiasOf({ duty = 0, threshold = DUTY_THRESHOLD, bias = DUTY_BIAS } = {}) {
  const d = clamp(num(duty, 0), 0, 1)
  const t = clamp(num(threshold, DUTY_THRESHOLD), 0, 1)
  const out = -Math.max(0, d - t) * Math.max(0, num(bias, DUTY_BIAS))
  return Math.round(out * 1000) / 1000
}

