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

/** 日节律：一天一个来回，相位由 agent 定（每个个体不一样），amplitude=0 时关掉 */
export function circadianAt(tMs, seed, amplitude) {
  const amp = Number(amplitude)
  if (!Number.isFinite(amp) || amp <= 0) return 0
  const s = hashSeed('circ:' + String(seed))
  const phaseH = (s % 1440) / 60 // 0~24 小时，按分钟散开
  const h = ((Number(tMs) / 3600000) % 24 + 24) % 24
  return amp * Math.sin((2 * Math.PI * (h - phaseH)) / 24)
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
