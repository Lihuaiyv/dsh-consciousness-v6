/**
 * 参数扫描：想让「饿」真的看得出来，胃口倍率和回落速度各该给多少。
 * 只跑稳态：固定日子过法，跑 12 天，取最后一天的五维缺口。
 */
import { learnSetpoint, deficitV3 } from '../src/algo/deficit.js'

const DIMS = ['R', 'E', 'C', 'A', 'S']
const DT = 1 / 12
const PULL = 0.3
const CAP = 0.08
const X0 = { R: 0.704, E: 0.872, C: 0.801, A: 0.607, S: 0.964 }
const SP0 = { R: 0.738, E: 0.98, C: 0.583, A: 0.614, S: 0.98 }
const H0 = { R: 0.631, E: 0.886, C: 0.698, A: 0.579, S: 0.947 }
// 代理目标：就是今天五个传感器的读数
const P = { R: 0.72, E: 0.857, C: 0.80, A: 0.612, S: 0.95 }
const PERSONA = { ei: 0.598, sn: 0.5, tf: 0.51, jp: 0.5, sensitivity: 0.8 }
const VALUES = {
  benevolence: 0.1259, achievement: 0.1052, selfDirection: 0.1033, hedonism: 0.101,
  conformity: 0.0954, power: 0.095, security: 0.095, stimulation: 0.095,
  tradition: 0.0922, universalism: 0.0922,
}
const MODS = { R: 0.0381, E: 0, C: 0, A: 0, S: 0.0139 }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function steady({ appetiteK = 1, decay = 0.04, days = 12 }) {
  const x = { ...X0 }
  let sp = { ...SP0 }
  let habit = { ...H0 }
  for (let d = 0; d < days; d++) {
    for (let e = 0; e < 12; e++) {
      for (const k of DIMS) {
        x[k] = clamp(x[k] + clamp((P[k] - x[k]) * PULL, -CAP, CAP) - decay * DT, 0, 1)
      }
      const l = learnSetpoint({
        dims: x, setpoint: sp, habit, persona: PERSONA, values: VALUES, mods: MODS,
        dt_days: DT, appetite_k: appetiteK,
      })
      sp = l.setpoint; habit = l.habit
    }
  }
  const out = deficitV3.run({}, { dims: x, setpoint: sp, persona: PERSONA, values: VALUES, alpha: 0.35 })
  return {
    D: out.D,
    band: out.band,
    R: out.deficits.R, E: out.deficits.E, C: out.deficits.C, A: out.deficits.A, S: out.deficits.S,
    spR: sp.R, spE: sp.E, spS: sp.S,
  }
}

const rows = []
for (const k of [1, 1.5, 2, 2.5, 3]) {
  for (const dec of [0.04, 0.12, 0.25]) {
    const s = steady({ appetiteK: k, decay: dec })
    rows.push({
      胃口倍率: k,
      日回落: dec,
      R: +s.R.toFixed(3), E: +s.E.toFixed(3), C: +s.C.toFixed(3), A: +s.A.toFixed(3), S: +s.S.toFixed(3),
      D: s.D, 档: s.band,
    })
  }
}
console.table(rows)
