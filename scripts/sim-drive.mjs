/**
 * 驱力模拟：30 天，每小时推进一次，看「是不是一直都有驱力」。
 * 用真代码（learnSetpoint / deficitV3），只把外部世界换成合成输入。
 */
import { learnSetpoint, deficitV3, APPETITE } from '../src/algo/deficit.js'

const DIMS = ['R', 'E', 'C', 'A', 'S']
const DAYS = 30
const EVENTS_PER_DAY = 12
const DT = 1 / EVENTS_PER_DAY
const DECAY = 0.04 * DT            // 满足度自然回落
const PULL = 0.25
const CAP = 0.08

// 今天的真实状态当起点
const START = { R: 0.671, E: 0.872, C: 0.781, A: 0.607, S: 0.964 }
const BASE = { R: 0.66, E: 0.87, C: 0.78, A: 0.60, S: 0.96 }
const PERSONA = { ei: 0.598, sn: 0.5, tf: 0.51, jp: 0.5, sensitivity: 0.8 }
const VALUES = {
  benevolence: 0.1259, achievement: 0.1052, selfDirection: 0.1033, hedonism: 0.101,
  conformity: 0.0954, power: 0.095, security: 0.095, stimulation: 0.095,
  tradition: 0.0922, universalism: 0.0922,
}
const MODS = { R: 0.0381, E: 0, C: 0, A: 0, S: 0.0139 }

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const gauss = (r) => (r() + r() + r() + r() - 2) / 2 // 近似 N(0, 0.29)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 造一天的外部世界：基底 + 噪声 + 10% 的坏日子 */
function world(r, badChance, noise = 0.05) {
  const bad = r() < badChance
  const out = {}
  for (const k of DIMS) {
    let p = BASE[k] + noise * gauss(r)
    if (bad && (k === 'R' || k === 'S' || k === 'C')) p -= 0.10
    out[k] = clamp(p, 0.05, 1)
  }
  return out
}

/** 跑一个场景；appetite 是「怎么算胃口」的策略钩子 */
function run({ name, seed = 7, badChance = 0.12, appetiteMode = 'current', satiety = true, noise = 0.05, pull = PULL }) {
  const r = rng(seed)
  const x = { ...START }
  let sp = { R: 0.7382, E: 0.98, C: 0.5832, A: 0.614, S: 0.98 }
  let habit = { R: 0.615, E: 0.982, C: 0.519, A: 0.558, S: 0.984 }
  let fast = { ...START }          // 短周期习惯（τ≈2.5 天）
  const FAST_TAU = 2.5
  const FAST_APP = 0.10
  const recent = []            // 近 3 天的 x 历史（滚动高点用）
  const days = []
  for (let d = 0; d < DAYS; d++) {
    let sumD = 0
    const bands = {}
    for (let e = 0; e < EVENTS_PER_DAY; e++) {
      const p = world(r, badChance, noise)
      for (const k of DIMS) {
        let dlt = (p[k] - x[k]) * pull
        dlt = clamp(dlt, -CAP, CAP)
        x[k] = clamp(x[k] + dlt - DECAY, 0, 1)
      }
      recent.push({ ...x })
      if (recent.length > 3 * EVENTS_PER_DAY) recent.shift()

      // 胃口：交给真代码；satiety=false 时饱足项退化成恒定 0.08
      const learn = learnSetpoint({
        dims: x,
        setpoint: sp,
        habit,
        persona: PERSONA,
        values: VALUES,
        mods: appetiteMode === 'nomods' ? { R: 0, E: 0, C: 0, A: 0, S: 0 } : MODS,
        dt_days: DT,
        align_first: d === 0 && e === 0,
        satiety,
      })
      sp = learn.setpoint
      habit = learn.habit

      // 短周期习惯：τ≈2.5 天，跟着最近几天的日子走
      const etaFast = 1 - Math.exp(-DT / FAST_TAU)
      for (const k of DIMS) fast[k] = clamp(fast[k] + (x[k] - fast[k]) * etaFast, 0, 1)

      // 双时间尺度：胃口取「慢基线」和「短期习惯 + 更大胃口」里更高的那个
      if (appetiteMode === 'dual') {
        for (const k of DIMS) sp[k] = clamp(Math.max(sp[k], fast[k] + FAST_APP), 0.35, 0.99)
      }
      // 近三天高点参照（已验证无效，留作对照）
      if (appetiteMode === 'peak') {
        for (const k of DIMS) {
          const peak = Math.max(...recent.map((h) => h[k]))
          sp[k] = clamp(Math.max(sp[k], 0.92 * peak), 0.35, 0.99)
        }
      }

      const out = deficitV3.run({}, {
        dims: x, setpoint: sp, persona: PERSONA, values: VALUES,
        prev_band: 'D0', alpha: 0.35,
      })
      sumD += out.D
      bands[out.band] = (bands[out.band] || 0) + 1
    }
    days.push({ d: d + 1, D: sumD / EVENTS_PER_DAY, bands })
  }
  const Ds = days.map((d) => d.D)
  const n = Ds.length
  const mean = Ds.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(Ds.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
  const hasDrive = Ds.filter((v) => v >= 0.10).length / n
  const deep = Ds.filter((v) => v >= 0.18).length / n
  const stuck = Ds.filter((v) => v < 0.05).length / n
  return {
    name,
    meanD: +mean.toFixed(3),
    波动: +sd.toFixed(3),
    minD: +Math.min(...Ds).toFixed(3),
    maxD: +Math.max(...Ds).toFixed(3),
    有驱力: +(hasDrive * 100).toFixed(0) + '%',
    深缺口: +(deep * 100).toFixed(0) + '%',
    几乎不饿: +(stuck * 100).toFixed(0) + '%',
  }
}

const rows = [
  run({ name: 'A 现状（饱足 0.08 + 上限 0.98）' }),
  run({ name: 'D 现状，日子更平（坏日 3%）', badChance: 0.03 }),
  run({ name: 'E 现状，日子更糙（坏日 30%）', badChance: 0.3 }),
  run({ name: 'G 现状但去掉关系/底色', appetiteMode: 'nomods' }),
  run({ name: 'J 双时间尺度（短期习惯 τ2.5 + 0.10）', appetiteMode: 'dual' }),
  run({ name: 'M 跟手更快：pull .35', pull: 0.35 }),
  run({ name: 'N 跟手更快 + 世界更晃（噪声 .12 / 坏日 20%）', pull: 0.35, noise: 0.12, badChance: 0.2 }),
  run({ name: 'P 跟手更快 + 世界更晃 + 双尺度', pull: 0.35, noise: 0.12, badChance: 0.2, appetiteMode: 'dual' }),
]
console.table(rows)

// 逐维看：30 天后每维的胃口与缺口各是多少（场景 A）
{
  const r = rng(7)
  const x = { ...START }
  let sp = { R: 0.7382, E: 0.98, C: 0.5832, A: 0.614, S: 0.98 }
  let habit = { R: 0.615, E: 0.982, C: 0.519, A: 0.558, S: 0.984 }
  for (let d = 0; d < DAYS; d++) {
    for (let e = 0; e < EVENTS_PER_DAY; e++) {
      const p = world(r, 0.12)
      for (const k of DIMS) {
        x[k] = clamp(x[k] + clamp((p[k] - x[k]) * PULL, -CAP, CAP) - DECAY, 0, 1)
      }
      const l = learnSetpoint({ dims: x, setpoint: sp, habit, persona: PERSONA, values: VALUES, mods: MODS, dt_days: DT })
      sp = l.setpoint; habit = l.habit
    }
  }
  const out = deficitV3.run({}, { dims: x, setpoint: sp, persona: PERSONA, values: VALUES, alpha: 0.35 })
  console.log('\n30 天后（场景 A）：')
  console.table(DIMS.map((k) => ({
    维: k,
    现在: +x[k].toFixed(3),
    胃口: +sp[k].toFixed(3),
    习惯: +habit[k].toFixed(3),
    缺口: +out.deficits[k].toFixed(3),
    权重: +out.weights[k].toFixed(3),
    加权: +(out.deficits[k] * out.weights[k]).toFixed(3),
  })))
  console.log('D =', out.D, ' D_sum =', out.D_sum, ' 档位 =', out.band)
}
