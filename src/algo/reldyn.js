/**
 * 关系动力学 relation_dyn@v1
 *
 * 一件事 → 三轴（亲近 κ / 信任 ρ / 依赖 δ）的增量。只做计算：
 * 不碰库、不碰模型、不读参数表；参数由调用方传入。
 *
 * 三条性质（对应 9 号文档 §5）：
 *   1. 有界：正向乘 (1−x)、负向乘 x，永远落在 0..1，不会在 0.99 卡死；
 *   2. 边际递减：越近越难更近（0.98 时再被夸几乎不动）；
 *   3. 不对称：信任破得比亲近快（rNeg 是 rPos 的 3 倍），越亲越容易被伤到。
 *
 * 依赖 δ 在 P1 用「互动类型 × 小系数」近似；P2 再接 help / share 事件。
 */

import { desensitize, stimulusKey } from './desensitize.js'

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const clamp01 = (x) => clamp(x, 0, 1)
const round = (x) => Math.round(x * 1e6) / 1e6

/** 三轴上限：留一点余量，避免「永远 1.00」 */
export const AXIS_MAX = 0.999

export const REL_DEFAULTS = {
  kPos: 0.06,          // 亲近正向步长
  kNeg: 0.05,          // 亲近负向系数（乘在当前值上）
  rPos: 0.04,          // 信任正向
  rNeg: 0.12,          // 信任负向（必须大于 rPos）
  dPos: 0.03,          // 依赖正向
  dNeg: 0.02,          // 依赖负向
  noise: 0.005,        // |v|·w 低于此值不记账（boundary 除外）
  // 被搭话本身算轻正向：冲我来的普通一句（没有好坏信号）也有地板效价。
  // 不加这一条，中性句的 v 恰好是 0，怎么调 noise 都不会动——账本里只剩夸奖和批评。
  chatFloor: 0.10,
  stepCap: 0.05,       // 单次事件单轴最大变化
  moodGain: 0.25,      // 心情对正向效价的加成上限
  hardNeg: 0.6,        // 超过这个强度的负向事件不受心情影响
  habitK: 0.35,        // 习惯化斜率
  habitTauH: 72,       // 习惯化恢复（小时）
  habitFloor: 0.2,     // 习惯化最低保留
}

/** 来源权重：工具调用 / 导入不能和面对面聊天同权 */
export const SOURCE_WEIGHT = { chat: 1, ui: 1, tool: 0.4, import: 0.7, system: 0.2 }

/** 事件类型对依赖轴的贡献比例（P1 近似） */
export const DEP_BY_KIND = {
  help: 1, share: 1, repair: 0.5,
  praise: 0.4, critic: 0.4, boundary: 0.4, chat: 0.3,
}

/**
 * 一件事的效价 v。
 * 只有「冲我来的」才算；用户自述「我好累」几乎不动关系。
 */
export function eventValence({
  goalCongruence = 0, agency = 'self', total = 0,
  directed = false, kind = 'chat', taboo = false,
} = {}) {
  if (taboo || kind === 'boundary') return -1
  const rel = directed ? 1 : 0.5
  const strength = 0.4 + 0.6 * Math.abs(num(total, 0))
  let v = num(goalCongruence, 0) * rel * strength
  if (agency !== 'other') v *= 0.3
  return round(clamp(v, -1, 1))
}

/** 心情只放大正向；负向不受心情影响（不给出「今天心情差所以更恨你」的通道） */
export function moodAdjust(v, mood, p = REL_DEFAULTS) {
  const x = num(v, 0)
  if (x <= 0) return round(clamp(x, -1, 1))
  const m = clamp01(num(mood, 0.6))
  return round(clamp(x * (1 - p.moodGain + p.moodGain * m), -1, 1))
}

/** 习惯化：同一个 (人, 类型, 标签) 反复来，冲击一次比一次小 */
export function habitOf({ count = 0, lastAt = null, now = Date.now(), p = REL_DEFAULTS } = {}) {
  return desensitize({
    count, lastAt, now,
    k: p.habitK, tauH: p.habitTauH, floor: p.habitFloor,
  })
}

/** 有效权重 w：来源 × 习惯化 × 显著性 */
export function weightOf({ source = 'chat', habit = 1, recalled = false } = {}) {
  const base = SOURCE_WEIGHT[source] ?? 1
  return round(clamp01(base * num(habit, 1) * (recalled ? 1.2 : 1)))
}

/**
 * 结算一次事件。
 * @param {{closeness?:number, trust?:number, dependence?:number}} state
 * @param {{v?:number, w?:number, kind?:string}} ev
 * @returns {{closeness:number, trust:number, dependence:number, delta:object}}
 */
export function applyEvent(state = {}, ev = {}, p = REL_DEFAULTS) {
  const cfg = { ...REL_DEFAULTS, ...(p || {}) }
  const v = clamp(num(ev.v, 0), -1, 1)
  const w = clamp01(num(ev.w, 1))
  const kind = String(ev.kind || 'chat')
  const depScale = DEP_BY_KIND[kind] ?? 0.3

  let c = clamp(num(state.closeness, 0.5), 0, AXIS_MAX)
  let t = clamp(num(state.trust, 0.5), 0, AXIS_MAX)
  let d = clamp(num(state.dependence, 0.2), 0, AXIS_MAX)

  let dc = 0, dt = 0, dd = 0
  if (v > 0) {
    dc = (1 - c) * cfg.kPos * v * w
    dt = (1 - t) * cfg.rPos * v * w
    dd = (1 - d) * cfg.dPos * v * w * depScale
  } else if (v < 0) {
    const a = Math.abs(v)
    dc = -c * cfg.kNeg * a * w
    dt = -t * cfg.rNeg * a * w
    dd = -d * cfg.dNeg * a * w * depScale
  }
  const cap = cfg.stepCap
  dc = clamp(dc, -cap, cap)
  dt = clamp(dt, -cap, cap)
  dd = clamp(dd, -cap, cap)

  const out = {
    closeness: round(clamp(c + dc, 0, AXIS_MAX)),
    trust: round(clamp(t + dt, 0, AXIS_MAX)),
    dependence: round(clamp(d + dd, 0, AXIS_MAX)),
  }
  return {
    ...out,
    delta: {
      closeness: round(out.closeness - c),
      trust: round(out.trust - t),
      dependence: round(out.dependence - d),
    },
  }
}

/** 单轴向基线回归：x(t) = x0 + (x−x0)·0.5^(idle/T½) */
export function decayAxis(x, baseline, idleDays, halfLifeDays) {
  const cur = clamp(num(x, 0.5), 0, AXIS_MAX)
  const b = clamp(num(baseline, cur), 0, AXIS_MAX)
  const half = num(halfLifeDays, 0)
  const days = num(idleDays, 0)
  if (!(half > 0) || !(days > 0)) return round(cur)
  return round(clamp(b + (cur - b) * Math.pow(0.5, days / half), 0, AXIS_MAX))
}

/**
 * 三轴一起回归。halfLife 缺省时该轴不动（主人的 κ/ρ 走 R09，不走曲线）。
 * @param {{closeness?:number,trust?:number,dependence?:number}} state
 * @param {{idleDays?:number, baseline?:object, halfLife?:object}} input
 */
export function decayRelation(state = {}, { idleDays = 0, baseline = {}, halfLife = {} } = {}) {
  const out = {
    closeness: decayAxis(state.closeness, baseline.closeness ?? state.closeness, idleDays, halfLife.closeness),
    trust: decayAxis(state.trust, baseline.trust ?? state.trust, idleDays, halfLife.trust),
    dependence: decayAxis(state.dependence, baseline.dependence ?? state.dependence, idleDays, halfLife.dependence),
  }
  return out
}

/** 修复：道歉 / 补偿只回 ρ，不回 κ；回不到受损前（留痕） */
export function repairTrust(state = {}, { strength = 0.6, w = 1, ceiling = null } = {}, p = REL_DEFAULTS) {
  const t = clamp(num(state.trust, 0.5), 0, AXIS_MAX)
  const gain = (1 - t) * p.rPos * clamp01(num(strength, 0.6)) * clamp01(num(w, 1))
  let after = t + gain
  if (ceiling != null) after = Math.min(after, clamp(num(ceiling, after), 0, AXIS_MAX))
  return { trust: round(clamp(after, 0, AXIS_MAX)), delta: round(after - t) }
}

function scaleParams(mul) {
  return {
    kPos: REL_DEFAULTS.kPos * mul.k,
    kNeg: REL_DEFAULTS.kNeg * mul.k,
    rPos: REL_DEFAULTS.rPos * mul.r,
    rNeg: REL_DEFAULTS.rNeg * mul.r,
    stepCap: REL_DEFAULTS.stepCap * (mul.cap || 1),
  }
}

function makeRelationDyn(version, mul = null) {
  return {
    name: 'relation_dyn',
    version,
    kind: 'relation_dyn',
    metrics: ['relation.step_cap', 'relation.event_rate'],
    run(_ctx, input = {}) {
      const p = mul ? scaleParams(mul) : REL_DEFAULTS
      if (input.mode === 'decay') {
        const out = decayRelation(input.state, input)
        return { ...out, algo: { name: 'relation_dyn', version, mode: 'decay' } }
      }
      if (input.mode === 'repair') {
        const out = repairTrust(input.state, input, p)
        return { ...out, algo: { name: 'relation_dyn', version, mode: 'repair' } }
      }
      const out = applyEvent(input.state, input.event, p)
      return { ...out, algo: { name: 'relation_dyn', version, mode: 'apply' } }
    },
  }
}

/** 现行 */
export const relationDynV1 = makeRelationDyn('v1')

/** 对照：步长更大、更容易被感动 / 伤到（A/B 用） */
export const relationDynV1b = makeRelationDyn('v1b', { k: 1.35, r: 1.35, cap: 1.2 })

export { stimulusKey }

// ---------------- 关系 → 表达（9 号 §6 的 C7） ----------------

/** 三档的基准温度 / 正式度 / 披露 / 主动（与 5 号 §7.3 对齐） */
export const TONE_TIERS = {
  owner: { warmth: 0.85, formality: 0.15, disclosure: 0.70, initiative: 0.75 },
  acquaintance: { warmth: 0.55, formality: 0.60, disclosure: 0.50, initiative: 0.30 },
  stranger: { warmth: 0.25, formality: 0.85, disclosure: 0.30, initiative: 0.05 },
}

/**
 * 把三轴投影成「怎么说话」。纯函数：不读库、不猜人。
 * κ 偏移基准、ρ 抬披露、mood 抬主动、E 抬温度；全部夹在 0..1。
 */
export function toneOf({ closeness = 0.5, trust = 0.5, kind = 'acquaintance', mood = 0.5, extraversion = 0.6 } = {}) {
  const tier = TONE_TIERS[kind] || TONE_TIERS.acquaintance
  const k0 = kind === 'owner' ? 0.55 : kind === 'acquaintance' ? 0.25 : 0.10
  const c = clamp01(num(closeness, 0.5))
  const t = clamp01(num(trust, 0.5))
  const e = clamp01(num(extraversion, 0.6))
  const m = clamp01(num(mood, 0.5))

  const warmth = clamp01(tier.warmth + 0.20 * (c - k0) + 0.10 * (e - 0.5) + 0.10 * (m - 0.5))
  const formality = clamp01(tier.formality - 0.15 * (c - k0) + 0.05 * (1 - e))
  const disclosure = Math.min(tier.disclosure, 0.20 + 0.60 * c + 0.20 * t)
  const initiative = clamp01(tier.initiative * (0.4 + 0.6 * c) * (0.5 + 0.5 * m))

  return {
    warmth: round(warmth),
    formality: round(formality),
    disclosure: round(disclosure),
    initiative: round(initiative),
    label: warmth >= 0.7 ? '热情' : warmth >= 0.45 ? '温和' : '疏离',
  }
}
