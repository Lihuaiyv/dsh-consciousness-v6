/**
 * 底色 v1：段式慢波
 *
 * 设计见 v1新版本重要文档/6-情绪统筹-v1.md §3。三条硬要求：
 *   1. 个体有固定周期：出生抽一次，每段围着它抖 ±25%，不再每段重新随机；
 *   2. 幅度由敏感度决定：敏感（σ→1）起伏大，钝（σ→0）平缓；
 *   3. 段末反向的概率随当前位置变（负反馈），但不是铁律，永远留 5% 的意外。
 *
 * 纯函数、不碰库：调用方负责把段计划存进 affect_baseline，再按需 valueAtTime。
 *
 * 一条铁律：段一旦生成就存库，不重算。因为 amp 跟着 sensitivity 走，
 * 性格漂移之后重算旧段会得到不一样的结果——已过去的段不该被改写。
 */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number(x) || 0))

export const PERIOD_MIN_D = 3.5
export const PERIOD_MAX_D = 9
export const PERIOD_JITTER = 0.25
export const AMP_BASE = 0.10
export const AMP_SPAN = 0.20
/* 幅度总增益：公式给的是「敏感度→幅度」的刻度，这里才是真的要摆多大。
   太低就永远在中间一小段里蹭（慢情绪只传 75% 的底色，再一缩就看不见了）。 */
export const AMP_GAIN = 1.5
export const SEG_MIN_H = 48
export const EDGE = 0.68

/** FNV-1a：把任意字符串压成 32 位种子 */
export function hashSeed(str) {
  let h = 2166136261 >>> 0
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** mulberry32：小、快、可复现。不用 Math.random，否则同一段时间算不出同一个结果。 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 出生时抽一次：这个 agent 的主周期（天）。之后每段都围着它转。 */
export function birthPeriod(seed) {
  const rnd = mulberry32(hashSeed('period:' + seed))
  return PERIOD_MIN_D + rnd() * (PERIOD_MAX_D - PERIOD_MIN_D)
}

/** 敏感度 → 幅度。σ=0.5 → 0.20；σ=1 → 0.30；σ=0 → 0.10 */
export function ampFor(sensitivity) {
  const s = clamp(sensitivity ?? 0.5, 0, 1)
  return AMP_BASE + AMP_SPAN * s
}

/** 段末向上的概率：越低越可能往上，永远留 5% 的意外 */
export function pUp(xEnd) {
  return clamp(0.5 - 1.5 * clamp(xEnd, -1, 1), 0.05, 0.95)
}

/**
 * 生成下一段。
 * @param {object} p
 * @param {number} [p.xEnd] 上一段终点（第一段为 0）
 * @param {number} p.periodD 个体主周期（天）
 * @param {number} p.amp 幅度
 * @param {() => number} p.rnd PRNG
 * @param {number} [p.startMs] 段起点（毫秒）
 */
export function nextSegment({ xEnd = 0, periodD, amp, rnd, startMs = 0 }) {
  const dir = rnd() < pUp(xEnd) ? 1 : -1
  const a = amp * AMP_GAIN * (0.75 + 0.5 * rnd()) // 每段幅度也抖 ±25%
  const to = clamp(dir * a - 0.15 * xEnd, -EDGE, EDGE)
  const hours = Math.max(SEG_MIN_H, periodD * 24 * (1 + PERIOD_JITTER * (rnd() * 2 - 1)))
  return {
    from: clamp(xEnd, -EDGE, EDGE),
    to,
    durationH: Math.round(hours * 100) / 100,
    startMs,
    endMs: startMs + hours * 3600000,
  }
}

/**
 * 每段独立播种：seed + 段号。
 * 这样从任意一段开始算、或断点续算，结果都和从头铺一遍一样；
 * 只用一条 PRNG 流的话，续写就会错位。
 */
export function segRnd(seed, segNo) {
  return mulberry32(hashSeed(seed + '#' + String(segNo)))
}

/**
 * 从 startMs 铺到 untilMs，返回首尾相接的段计划。
 * seed 建议用 agent_id：同一个 agent 同一段时间，怎么重算都一样。
 *
 * 断点续算：传 segNo0 = 上一段段号 + 1、from0 = 上一段 to、startMs = 上一段 endMs。
 */
export function planSegments({ seed, sensitivity = 0.5, periodD, startMs, untilMs, segNo0 = 0, from0 = 0 }) {
  const out = []
  const amp = ampFor(sensitivity)
  const period = periodD ?? birthPeriod(seed)
  let xEnd = clamp(from0, -EDGE, EDGE)
  let t = startMs
  let segNo = Math.max(0, Math.floor(segNo0))
  let guard = 0
  while (t < untilMs && guard++ < 10000) {
    const seg = nextSegment({ xEnd, periodD: period, amp, rnd: segRnd(seed, segNo), startMs: t })
    seg.segNo = segNo
    out.push(seg)
    xEnd = seg.to
    t = seg.endMs
    segNo++
  }
  return out
}

/** 段内插值：两端斜率为 0，接段不折角 */
export function valueAt(seg, tMs) {
  if (!seg) return 0
  const span = seg.endMs - seg.startMs
  const u = span > 0 ? clamp((tMs - seg.startMs) / span, 0, 1) : 0
  const h = (1 - Math.cos(Math.PI * u)) / 2
  return seg.from + (seg.to - seg.from) * h
}

/** 找覆盖 tMs 的那一段并求值 */
export function valueAtTime(segs, tMs) {
  if (!Array.isArray(segs) || !segs.length) return 0
  if (tMs <= segs[0].startMs) return segs[0].from
  for (const seg of segs) {
    if (tMs < seg.endMs) return valueAt(seg, tMs)
  }
  return segs[segs.length - 1].to
}

/* ================= 底色的另外两层：日节律 + 累积负荷 =================
 *
 * 上面那条段式慢波是「几天一个来回」的主浪。只有它的话，底色看起来像一条
 * 慢慢爬的直线——不像激素。真正的激素曲线是三层叠出来的：
 *
 *   1. 段式慢波（planSegments）  —— 几天一个周期，±0.2~0.3
 *   2. 日节律（circadianAt）     —— 一天一个来回，很轻，±0.06
 *   3. 累积负荷（stepLoad）      —— 被经历推高、几天才代谢掉，±0.35 封顶
 *
 * 第三层是这次加的：持续偏着的时候，水位本身会被拖走一点（allostatic load）；
 * 没有新刺激就慢慢代谢回来。这样「一次连着几天的低谷」才是真的低谷，
 * 而不是第二天早上就被日程表拽回去。
 */

/**
 * 日节律：一天一个来回，相位由 agent 定（每个个体不一样），amplitude=0 时关掉。
 * phaseMin 是「被经历拖走的相位」（分钟，正数 = 往后挪）：连着熬夜，高点就来得更晚，
 * 不是每天按北京时间准点醒。默认 0，等于旧行为。
 */
export function circadianAt(tMs, seed, amplitude, phaseMin = 0) {
  const amp = Number(amplitude)
  if (!Number.isFinite(amp) || amp <= 0) return 0
  const s = hashSeed('circ:' + String(seed))
  const phaseH = (s % 1440) / 60 // 0~24 小时，按分钟散开
  const shiftH = (Number(phaseMin) || 0) / 60
  const h = ((Number(tMs) / 3600000) % 24 + 24) % 24
  return amp * Math.sin((2 * Math.PI * (h - phaseH - shiftH)) / 24)
}

/* ================================================== 激素纹：脉冲 / 漂移 / 长周期
 *
 * 只有段式慢波 + 一条正弦的话，水位平滑得像画出来的——一眼能看出是算的。
 * 真实的激素曲线是这几层叠的：
 *
 *   1. 脉冲式分泌（pulseAt）：一两个小时一个尖，尖完拖条尾巴；有的尖大有的尖小，
 *      也有整段安静的时候。不是等幅振荡。
 *   2. 1/f 漂移（driftAt）：几小时到一天的随机游走，看着没周期，但也不是白噪声。
 *   3. 长周期（cycleAt）：二三十天一个来回（性激素 / 季节那种），一天里根本看不出。
 *
 * 三层都是 (seed, tMs) 的纯函数：同一个时刻怎么算都一样，不因为「算过几次」而漂。
 * 所以不存库、不重算历史，也不会把已经过去的段改掉（段式慢波那条铁律不用破）。
 * 幅度给 0 就逐字退回旧的三层底色。
 */

const MIN = 60000
const HR = 3600000

/** 漂移的四个不可通约周期（小时）和权重：叠起来看着没周期，又不是白噪声 */
const DRIFT_PARTS = [[2.7, 0.45], [6.3, 0.3], [15.7, 0.18], [41, 0.3]]

/**
 * 脉动：90 分钟一格，一半多一点的格子有；上升 14 分钟、回落 40 分钟。
 *
 * 峰顶用 exp(-x^1.5)：x^1.5 在峰上是平的，所以导数在峰顶是 0——
 * 以前是两条 exp 在峰上硬接，导数从 +1/rise 一下跳到 -1/fall，
 * 一个像素级的折角，图上就是一根竖刺。现在峰是圆的，尾巴还照样拖着。
 */
export function pulseAt(tMs, seed, amp = 0) {
  const a = clamp(amp, 0, 0.3)
  const t = Number(tMs)
  if (!a || !Number.isFinite(t)) return 0
  const W = 90 * MIN
  const rise = 14 * MIN
  const fall = 40 * MIN
  const SHAPE = 1.5
  const idx = Math.floor(t / W)
  let sum = 0
  /* 看当前格和前后各一格：脉冲最长也就两三个小时；
     后一格是为了让「快要冒头」的脉冲提前开始爬升，不然会在整格边界上突然跳一下 */
  for (let k = idx - 1; k <= idx + 1; k++) {
    const r = mulberry32(hashSeed(seed + ':pulse:' + k))
    if (r() > 0.55) continue
    const center = (k + 0.1 + 0.8 * r()) * W
    const peak = a * (0.35 + 1.3 * r())
    const dt = t - center
    if (dt < -4 * rise) continue
    const tau = dt < 0 ? rise : fall
    sum += peak * Math.exp(-Math.pow(Math.abs(dt) / tau, SHAPE))
  }
  return sum
}

/** 漂移：几个不可通约的正弦叠起来，相位按 agent 抽；峰值封在 amp */
export function driftAt(tMs, seed, amp = 0) {
  const a = clamp(amp, 0, 0.3)
  const t = Number(tMs)
  if (!a || !Number.isFinite(t)) return 0
  let v = 0
  let w = 0
  for (let i = 0; i < DRIFT_PARTS.length; i++) {
    const [periodH, weight] = DRIFT_PARTS[i]
    const r = mulberry32(hashSeed(seed + ':drift:' + i))
    v += weight * Math.sin((2 * Math.PI * t) / (periodH * HR) + r() * Math.PI * 2)
    w += weight
  }
  return w ? (a * v) / w : 0
}

/** 长周期：18~34 天一个来回，周期和相位都按 agent 抽一次 */
export function cycleAt(tMs, seed, amp = 0) {
  const a = clamp(amp, 0, 0.3)
  const t = Number(tMs)
  if (!a || !Number.isFinite(t)) return 0
  const r = mulberry32(hashSeed(seed + ':cycle'))
  const periodH = (18 + 16 * r()) * 24
  const phase = r() * Math.PI * 2
  return a * Math.sin((2 * Math.PI * t) / (periodH * HR) + phase)
}

/**
 * 水位的纹理层：漂移（rough）+ 脉冲（rough 的六成）+ 长周期（cycle）。
 * 三个都给 0 就是旧行为。
 */
export function rhythmAt(tMs, seed, { rough = 0, cycle = 0 } = {}) {
  const r = clamp(rough, 0, 0.3)
  if (!r && !clamp(cycle, 0, 0.3)) return 0
  return driftAt(tMs, seed, r) + pulseAt(tMs, seed, r * 0.45) + cycleAt(tMs, seed, cycle)
}

export const LOAD_CAP = 0.35

/**
 * 累积负荷一步：被「慢情绪偏离水位多少」拖着走，自己按 tauH 代谢。
 *   dL/dt = gain·(s − bPlan − L) − L/tauH
 * 精确解：L ← L* + (L − L*)·exp(−Λ·dt)，Λ = gain + 1/tauH，L* = (gain/Λ)(s − bPlan)
 *
 * gain 大 / tau 长 = 记仇（几天缓不过来）；两者都小 = 没心没肺。
 */
export function stepLoad({ load = 0, s = 0, bPlan = 0, dtHours = 1, gain = 0.01, tauH = 168 } = {}) {
  const k = Math.max(0, Number(gain) || 0)
  const tau = Math.max(1e-6, Number(tauH) || 168)
  const lam = k + 1 / tau
  const target = (k / lam) * ((Number(s) || 0) - (Number(bPlan) || 0))
  const dt = Math.max(0, Number(dtHours) || 0)
  const out = target + ((Number(load) || 0) - target) * Math.exp(-lam * dt)
  return Math.round(clamp(out, -LOAD_CAP, LOAD_CAP) * 1000) / 1000
}
