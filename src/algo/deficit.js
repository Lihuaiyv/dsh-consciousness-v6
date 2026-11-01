/**
 * 驱力缺口与分档：deficit@v1（现行）与 deficit@v1b（对照阈值）
 * 含指数平滑 ñ 与迟滞分档（地基 §2.4）。
 * 输入：dims / setpoint / coupling / smooth_prev / prev_band / alpha
 * 输出：{ deficits(ñ), raw, D, band, smooth, dims }
 */

function parseDims(input) {
  if (input.dims) return { ...input.dims }
  return {
    R: Number(input.r ?? input.R ?? 0.55),
    E: Number(input.e ?? input.E ?? 0.55),
    C: Number(input.c ?? input.C ?? 0.55),
    A: Number(input.a ?? input.A ?? 0.55),
    S: Number(input.s ?? input.S ?? 0.6),
  }
}

function parseSetpoint(input) {
  if (input.setpoint && typeof input.setpoint === 'object' && !Array.isArray(input.setpoint)) {
    return input.setpoint
  }
  if (typeof input.setpoint === 'string') {
    try { return JSON.parse(input.setpoint) } catch { /* fall */ }
  }
  return { R: 0.6, E: 0.6, C: 0.6, A: 0.6, S: 0.6 }
}

const ORDER = ['D0', 'D1', 'D2', 'D3']

function enterLevel(D, enter) {
  if (D >= enter.D3) return 3
  if (D >= enter.D2) return 2
  if (D >= enter.D1) return 1
  if (D >= enter.D0) return 0
  return 0 // 最低仍记 D0（与种子一致）
}

function hysteresisBand(D, prevBand, enter, exit, maxRise = 0) {
  const prev = ORDER.indexOf(prevBand)
  const prevIdx = prev >= 0 ? prev : 0
  const riseIdx = enterLevel(D, enter)

  if (riseIdx > prevIdx) {
    // maxRise>0：一次评估最多升一档，防「休眠回来/冷启动」一步顶到 D3
    const capped = maxRise > 0 ? Math.min(riseIdx, prevIdx + maxRise) : riseIdx
    return ORDER[capped]
  }

  // 下降：跌破当前档离开阈值才降一级，可连续下降
  let cur = prevIdx
  while (cur > 0) {
    const id = ORDER[cur]
    if (D < exit[id]) cur--
    else break
  }
  // 若已在 D0 且仍低于 D0 离开阈值，仍保持 D0
  return ORDER[cur]
}

function makeDeficit(version, enter, exit, opts = {}) {
  return {
    name: 'deficit',
    version,
    kind: 'deficit',
    metrics: ['drive.band_switch', 'sys.algo_switch'],
    run(_ctx, input = {}) {
      const dims = parseDims(input)
      const sp = parseSetpoint(input)
      const coupling = Number(input.coupling ?? 0.05)
      const alpha = Number(input.alpha ?? 0.35)
      const vals = Object.values(dims).map(Number)
      const avg = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)

      // 瞬时归一化缺口 n_i；耦合作轻微均值回复偏置（与旧实现兼容）
      const raw = {}
      for (const [k, x] of Object.entries(dims)) {
        const s = Math.max(1e-6, Number(sp[k] ?? 0.6))
        raw[k] = Math.max(0, s - (Number(x) + coupling * avg)) / s
      }

      // 指数平滑：无前值时 ñ = n（冷启动不拖后腿）
      let prev = input.smooth_prev
      if (typeof prev === 'string') {
        try { prev = JSON.parse(prev) } catch { prev = null }
      }
      const smooth = {}
      for (const k of Object.keys(dims)) {
        const n = Number(raw[k] || 0)
        if (prev && Number.isFinite(Number(prev[k]))) {
          smooth[k] = (1 - alpha) * Number(prev[k]) + alpha * n
        } else {
          smooth[k] = n
        }
      }

      const D = Math.max(...Object.values(smooth))
      const band = hysteresisBand(D, input.prev_band || 'D0', enter, exit, Number(opts.maxRise || 0))
      return {
        dims,
        deficits: smooth,
        raw,
        smooth,
        D: Math.round(D * 1000) / 1000,
        band,
        algo: { name: 'deficit', version },
      }
    },
  }
}

/** 现行：进入 0.70/0.50/0.30/0.10；离开 0.65/0.45/0.25/0.05 */
export const deficitV1 = makeDeficit(
  'v1',
  { D3: 0.70, D2: 0.50, D1: 0.30, D0: 0.10 },
  { D3: 0.65, D2: 0.45, D1: 0.25, D0: 0.05 },
)

/** 对照：阈值略松 */
export const deficitV1b = makeDeficit(
  'v1b',
  { D3: 0.65, D2: 0.45, D1: 0.25, D0: 0.08 },
  { D3: 0.60, D2: 0.40, D1: 0.20, D0: 0.04 },
)

/** 防尖峰：阈值同 v1，但一次评估最多升一档（休眠回来不会一步顶到 D3）。默认不启用。 */
export const deficitV1c = makeDeficit(
  'v1c',
  { D3: 0.70, D2: 0.50, D1: 0.30, D0: 0.10 },
  { D3: 0.65, D2: 0.45, D1: 0.25, D0: 0.05 },
  { maxRise: 1 },
)

// ---------------- v1d：人格调制设定点 + 5×5 符号耦合 ----------------

/**
 * 性格五轴 → 设定点。中立人格（全 0.5）正好回到 0.6，和 v1 同一起点。
 * R←偏情感、E←偏直觉、C←偏判断、A←偏外向、S←敏感。
 */
export function personaSetpoint(persona = {}) {
  const b = (k) => {
    const v = Number(persona[k])
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5
  }
  return {
    R: +(0.5 + 0.2 * (1 - b('tf'))).toFixed(3),
    E: +(0.4 + 0.4 * b('sn')).toFixed(3),
    C: +(0.5 + 0.2 * b('jp')).toFixed(3),
    A: +(0.5 + 0.2 * b('ei')).toFixed(3),
    S: +(0.4 + 0.4 * b('sensitivity')).toFixed(3),
  }
}

/**
 * 维间符号耦合（6 号 §3 F2）：+1 互相抬，−1 互相压；0 不连。
 * 只有 R↔A 是张力的（亲密与独立），其余是支持边。
 */
const COUPLING_SIGNS = {
  R: { E: 0, C: 1, A: -1, S: 1 },
  E: { R: 0, C: 1, A: 0, S: 1 },
  C: { R: 1, E: 1, A: 1, S: 0 },
  A: { R: -1, E: 0, C: 1, S: 0 },
  S: { R: 1, E: 1, C: 0, A: 0 },
}

/** 候选：v1d。默认不启用，先用 scripts/replay-drive.mjs 对比再决定。 */
export const deficitV1d = {
  name: 'deficit',
  version: 'v1d',
  kind: 'deficit',
  metrics: ['drive.band_switch', 'sys.algo_switch'],
  run(_ctx, input = {}) {
    const dims = parseDims(input)
    const persona = input.persona && typeof input.persona === 'object' ? input.persona : {}
    const base = personaSetpoint(persona)
    const explicit = input.setpoint_explicit || {}
    const sp = {}
    for (const k of Object.keys(base)) sp[k] = Number(explicit[k] ?? base[k])
    const coupling = Number(input.coupling ?? 0.05)
    const alpha = Number(input.alpha ?? 0.35)

    // 先按符号耦合把满足度拉一遍（双向往返，边两侧都会受影响）
    const coupled = {}
    for (const [k, x] of Object.entries(dims)) {
      let v = Number(x)
      for (const [j, sign] of Object.entries(COUPLING_SIGNS[k] || {})) {
        if (!sign) continue
        v += sign * coupling * (Number(dims[j]) - Number(x))
      }
      coupled[k] = Math.max(0, Math.min(1, v))
    }

    const raw = {}
    for (const [k, x] of Object.entries(coupled)) {
      const s = Math.max(1e-6, Number(sp[k] ?? 0.6))
      raw[k] = Math.max(0, s - x) / s
    }

    let prev = input.smooth_prev
    if (typeof prev === 'string') {
      try { prev = JSON.parse(prev) } catch { prev = null }
    }
    const smooth = {}
    for (const k of Object.keys(dims)) {
      const n = Number(raw[k] || 0)
      smooth[k] = (prev && Number.isFinite(Number(prev[k])))
        ? (1 - alpha) * Number(prev[k]) + alpha * n
        : n
    }

    const D = Math.max(...Object.values(smooth))
    const band = hysteresisBand(D, input.prev_band || 'D0',
      { D3: 0.70, D2: 0.50, D1: 0.30, D0: 0.10 },
      { D3: 0.65, D2: 0.45, D1: 0.25, D0: 0.05 })
    return {
      dims, deficits: smooth, raw, smooth, setpoint: sp, coupled,
      D: Math.round(D * 1000) / 1000,
      band,
      algo: { name: 'deficit', version: 'v1d' },
    }
  },
}

// ---------------- v2：设定点由经历自己长出来（不再手填） ----------------

/**
 * 每条线「平时想待在什么水平」不再是一个旋钮，而是两段记忆：
 *
 *   习惯 habit：这段时间实际过得怎么样（时间常数 21 天）
 *   基线 setpoint：习惯 + 一点胃口（0.08），再被性格轻轻推一下
 *
 * 所以被好好对待得久了，它会把更高的被在乎当成正常；被晾久了，
 * 也会把期待往下调。基线每天最多挪 0.02，一两个月才走完一段路。
 * 基线始终略高于习惯，这就是「还想要一点」的来源——它不从 0 开始饿，
 * 而是相对于自己习惯的日子饿。
 */
export const APPETITE = { R: 0.08, E: 0.08, C: 0.08, A: 0.08, S: 0.08 }
export const SP_FLOOR = 0.35
// 上限从 1.0 降到 0.98：顶死在 1.0 的胃口数学上不可能被满足，
// 那不是「一直饿」，是「永远差一口气」。
export const SP_CEIL = 0.98
export const SP_RATE_PER_DAY = 0.02
/** 性格对胃口的量纲：T ∈ [−1,1] → ±0.10 */
export const APPETITE_TRAIT = 0.1
/** 价值观对胃口的量纲：V ∈ [−1,1] → ±0.05 */
export const APPETITE_VALUE = 0.05
/** 关系 / 底色 / 工况 / 浏览这些外部状态加起来，最多推 ±0.08 */
export const MOD_CAP = 0.08
// 习惯是慢的：约三周才把一段新日子当真。这样突然被冷落时，
// 基线还停在原来的水平，缺口会真的疼一阵，而不是第二天就学会不指望。
export const HABIT_TAU_DAYS = 21

const DIM_KEYS = ['R', 'E', 'C', 'A', 'S']
const clampNum = (v, lo, hi, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d
}

/**
 * 纯函数：推进一次「基线学习」。dt_days 由调用方按上次学习时间算。
 *
 * 胃口 = 习惯 + 饱足项 + 性格 + 价值观 + 外部状态
 *   a_eff = APPETITE·(1 − 0.5h)   已经习惯到这个水平，就不再多要那么多（alliesthesia）
 *   性格   = 0.10·T               和「重要度」共用同一张 T，只换成胃口的量纲
 *   价值观 = 0.05·V               同上
 *   外部   = 关系 / 底色 / 过载 / 浏览，由调用方算好传进来，整体封顶 ±0.08
 *
 * @returns {{ setpoint, habit, moved, mods, detail, tilt, dt_days }}
 */
export function learnSetpoint(input = {}) {
  const dims = parseDims(input)
  const prev = parseSetpoint(input)
  const habitIn = input.habit && typeof input.habit === 'object' ? input.habit : {}
  const persona = input.persona && typeof input.persona === 'object' ? input.persona : {}
  const values = input.values && typeof input.values === 'object' ? input.values : {}
  const modsIn = input.mods && typeof input.mods === 'object' ? input.mods : {}
  const dt = clampNum(input.dt_days, 0, 30, 0)
  const tiltBase = personaSetpoint(persona)
  const load = loadParts(persona, values)
  const eta = dt > 0 ? 1 - Math.exp(-dt / HABIT_TAU_DAYS) : 0
  // 饱足项可关（drive.setpoint.satiety=off）：关掉就是恒定 0.08，方便对照
  const sat = input.satiety !== false
  // 胃口倍率（drive.setpoint.appetite，默认 1.0）：整体想多要多少，一个数管五维
  const kApp = clampNum(input.appetite_k, 0.2, 3, 1)
  const setpoint = {}
  const habit = {}
  const moved = {}
  const mods = {}
  const detail = {}
  for (const k of DIM_KEYS) {
    const x = clampNum(dims[k], 0, 1, 0.5)
    // 第一次学习（老库升级上来没有 habit）就从当下开始习惯，不从 0.6 慢慢追
    const h0 = clampNum(habitIn[k] ?? x, 0, 1, x)
    const h = clampNum(h0 + (x - h0) * eta, 0, 1, x)
    const app = APPETITE[k] * kApp * (sat ? (1 - 0.5 * h) : 1)   // 饱足项
    const trait = APPETITE_TRAIT * load.T[k]         // 性格
    const value = APPETITE_VALUE * load.V[k]         // 价值观
    const mod = clampNum(modsIn[k], -MOD_CAP, MOD_CAP, 0) // 关系 / 底色 / 工况 / 浏览
    const target = clampNum(h + app + trait + value + mod, SP_FLOOR, SP_CEIL, 0.6)
    const cur = clampNum(prev[k], SP_FLOOR, SP_CEIL, 0.6)
    const rate = SP_RATE_PER_DAY * dt
    // align_first：老库第一次升级上来，别从 0.6 慢慢爬二十天——直接对齐到
    // 「当下习惯 + 一点胃口」，之后照常每天最多 0.02 地漂。
    const next = input.align_first === true
      ? target
      : clampNum(cur + Math.max(-rate, Math.min(rate, target - cur)), SP_FLOOR, SP_CEIL, cur)
    // 存 6 位小数：每次评估只走 0.02×dt 天（常态下一次 ≪0.001），
    // 存到 3 位会把步长整个舍掉，基线和习惯就会永远卡在出生值上。
    habit[k] = Math.round(h * 1e6) / 1e6
    setpoint[k] = Math.round(next * 1e6) / 1e6
    moved[k] = Math.round((next - cur) * 1000) / 1000
    mods[k] = Math.round(mod * 1e4) / 1e4
    detail[k] = {
      habit: +h.toFixed(4), appetite: +app.toFixed(4),
      trait: +trait.toFixed(4), value: +value.toFixed(4), mod: +mod.toFixed(4),
    }
  }
  return {
    setpoint, habit, moved, mods, detail,
    tilt: tiltBase, T: load.T, V: load.V, dt_days: +dt.toFixed(4),
  }
}

/** 现行：学习来的基线 + 5×5 符号耦合；一次评估最多升一档。 */
export const deficitV2 = {
  name: 'deficit',
  version: 'v2',
  kind: 'deficit',
  metrics: ['drive.band_switch', 'sys.algo_switch'],
  run(_ctx, input = {}) {
    const dims = parseDims(input)
    const spIn = parseSetpoint(input)
    const sp = {}
    for (const k of DIM_KEYS) sp[k] = clampNum(spIn[k], SP_FLOOR, SP_CEIL, 0.6)
    const coupling = clampNum(input.coupling, 0, 0.2, 0.05)
    const alpha = Number(input.alpha ?? 0.35)

    const coupled = {}
    for (const [k, x] of Object.entries(dims)) {
      let v = Number(x)
      for (const [j, sign] of Object.entries(COUPLING_SIGNS[k] || {})) {
        if (!sign) continue
        v += sign * coupling * (Number(dims[j]) - Number(x))
      }
      coupled[k] = Math.max(0, Math.min(1, v))
    }

    const raw = {}
    for (const [k, x] of Object.entries(coupled)) {
      const s = Math.max(1e-6, sp[k])
      raw[k] = Math.min(1, Math.max(0, s - x) / s)
    }

    let prev = input.smooth_prev
    if (typeof prev === 'string') {
      try { prev = JSON.parse(prev) } catch { prev = null }
    }
    const smooth = {}
    for (const k of Object.keys(dims)) {
      const n = Number(raw[k] || 0)
      smooth[k] = (prev && Number.isFinite(Number(prev[k])))
        ? (1 - alpha) * Number(prev[k]) + alpha * n
        : n
    }

    const D = Math.max(...Object.values(smooth))
    // 门槛按实际分布重标（2026-10-30）：正常缺口落在 0–0.25，旧的 0.30/0.50/0.70
    // 只有真崩了才会亮，结果永远 D0。新的 0.10/0.20/0.35 让「有点想要」看得见，
    // D3 仍然留给真急的时候。
    const band = hysteresisBand(D, input.prev_band || 'D0',
      { D3: 0.35, D2: 0.20, D1: 0.10, D0: 0.03 },
      { D3: 0.30, D2: 0.17, D1: 0.07, D0: 0.02 }, 1)
    return {
      dims, deficits: smooth, raw, smooth, setpoint: sp, coupled,
      D: Math.round(D * 1000) / 1000,
      band,
      algo: { name: 'deficit', version: 'v2' },
    }
  },
}

// ---------------- v3：重要度权重（性格 × 价值观） ----------------

/**
 * 性格五轴按 Big Five 语义对齐：
 *   ei = 外向性   sn = 开放性   tf = 宜人性   jp = 尽责性   sensitivity = 神经质
 *
 * 系数是「方向 + 相对大小」，不是相关系数——Parks-Leduc (2015) 给的是
 * 性格↔价值观的 r，不是性格↔需求强度的；直接拿来当系数会把两类研究混用。
 * 所以这里的数只保证：方向可解释、量级温和、全中性时归零。
 */
const TRAIT_LOAD = {
  R: { ei: 0.6, tf: 0.4, sensitivity: 0.2 },   // 外向 + 亲和 + 敏感 → 更在意关系
  E: { sn: 0.7 },                               // 开放 → 更在意新鲜
  C: { jp: 0.6, ei: 0.2 },                      // 尽责 + 外向 → 更在意做成
  A: { sn: 0.2, tf: -0.2, jp: -0.2 },           // 开放 + 少迎合 + 少计划 → 更在意自己决定
  S: { sensitivity: 0.7, sn: -0.1 },            // 敏感 → 更在意安全
}

/** 价值观十维 → 五维。Schwartz & Bilsky (1990)：价值观本身就是需求的认知表征。 */
const VALUE_LOAD = {
  R: { benevolence: 0.5, universalism: 0.3 },
  E: { stimulation: 0.6, hedonism: 0.2 },
  C: { achievement: 0.5, power: 0.3 },
  A: { selfDirection: 0.5, stimulation: 0.2 },
  S: { security: 0.4, conformity: 0.2, tradition: 0.2, hedonism: 0.1 },
}

export const VALUE_INIT = 0.1
export const W_MIN = 0.55
export const W_MAX = 1.8
export const W_SUM = 5

/**
 * 性格与价值观摊到五维上的两个原始载荷（都是 [−1, 1]）。
 * 「重要度」和「胃口」共用这一张表——同一个 T/V，两种量纲：
 *   w 用 0.35·T + 0.25·V，胃口用 0.10·T + 0.05·V。
 * @returns {{ T: Record<string,number>, V: Record<string,number> }}
 */
export function loadParts(persona = {}, values = {}) {
  const d = (k) => {
    const v = Number(persona[k])
    return Number.isFinite(v) ? 2 * (Math.max(0, Math.min(1, v)) - 0.5) : 0
  }
  const va = (k) => {
    const v = Number(values[k])
    return Number.isFinite(v) ? v : VALUE_INIT
  }
  const T = {}
  const V = {}
  for (const dim of DIM_KEYS) {
    let t = 0
    for (const [ax, c] of Object.entries(TRAIT_LOAD[dim] || {})) t += c * d(ax)
    let v = 0
    for (const [vk, c] of Object.entries(VALUE_LOAD[dim] || {})) v += c * (va(vk) - VALUE_INIT)
    T[dim] = Math.round(t * 1e6) / 1e6
    V[dim] = Math.round(Math.max(-1, Math.min(1, v * 10)) * 1e6) / 1e6
  }
  return { T, V }
}

/**
 * 五维「重要度」：同一份缺口，在我这里算不算数。
 * 纯函数，不落库——性格不写价值观、价值观也不写需求，只在读的时候合成一次。
 * @returns {{ weights: Record<string,number>, parts: object, sum: number }}
 */
export function needWeights(persona = {}, values = {}) {
  const { T, V } = loadParts(persona, values)
  const raw = {}
  const parts = {}
  for (const dim of DIM_KEYS) {
    const before = 1 + 0.35 * T[dim] + 0.25 * V[dim]
    raw[dim] = Math.max(W_MIN, Math.min(W_MAX, before))
    parts[dim] = { trait: +(0.35 * T[dim]).toFixed(4), value: +(0.25 * V[dim]).toFixed(4), before: +before.toFixed(4) }
  }
  const sum = DIM_KEYS.reduce((s, k) => s + raw[k], 0)
  const weights = {}
  for (const k of DIM_KEYS) weights[k] = +((W_SUM * raw[k]) / sum).toFixed(4)
  return { weights, parts, sum: +sum.toFixed(4) }
}

/**
 * 现行候选：重要度加权 + 定档取 max(w·ñ)，另给一个加权和做叙事。
 * Σw = 5，所以档位阈值一个字都不用改。
 */
export const deficitV3 = {
  name: 'deficit',
  version: 'v3',
  kind: 'deficit',
  metrics: ['drive.band_switch', 'sys.algo_switch'],
  run(ctx, input = {}) {
    const base = deficitV2.run(ctx, input)
    const persona = input.persona && typeof input.persona === 'object' ? input.persona : {}
    const values = input.values && typeof input.values === 'object' ? input.values : {}
    const on = input.weights_on !== false
    const calc = needWeights(persona, values)
    const w = on ? calc.weights : { R: 1, E: 1, C: 1, A: 1, S: 1 }
    const weighted = {}
    for (const k of DIM_KEYS) weighted[k] = +(w[k] * Number(base.deficits[k] || 0)).toFixed(6)
    const D = Math.max(...DIM_KEYS.map((k) => weighted[k]))
    const wsum = DIM_KEYS.reduce((s, k) => s + w[k], 0)
    const Dsum = DIM_KEYS.reduce((s, k) => s + weighted[k], 0) / (wsum || 1)
    const band = hysteresisBand(D, input.prev_band || 'D0',
      { D3: 0.35, D2: 0.18, D1: 0.10, D0: 0.03 },
      { D3: 0.30, D2: 0.155, D1: 0.07, D0: 0.02 }, 1)
    return {
      ...base,
      weighted,
      weights: w,
      weight_parts: calc.parts,
      D_sum: Math.round(Dsum * 1000) / 1000,
      D: Math.round(D * 1000) / 1000,
      band,
      algo: { name: 'deficit', version: 'v3' },
    }
  },
}
