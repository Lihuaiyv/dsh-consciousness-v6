/**
 * 三毒（贪 / 嗔 / 痴）—— 6 号《理论背书》F5 + §5.2 初值。
 *
 *   greed    = 0.30 + 0.5·(max(0,D_R−D̄) + max(0,D_E−D̄))      // 依恋/探索缺口高于均值才算“贪”
 *   anger    = 0.10 + 0.5·irritation + (load>0.8 ? 0.10 : 0)      // 基线 + E9 工况项
 *   delusion = 1 − certainty
 *   certainty= 0.70 + min(0.20, 记忆条数·0.01) − max(0, load−0.5)·0.20
 *
 * 初值取 §5.2 的 0.30 / 0.10 / 0.30（出生时 D_R=D_E=D̄，所以贪只剩基线）。
 * 只读派生，不落库：同一时刻的情绪、驱力、工况算出来就是同一结果；
 * 宗教词只进状态与界面，不进对话（§8 禁止清单）。
 */
import { now } from '../db.js'
import { agent } from '../kernel.js'
import { getAffect } from './affect.js'
import { getDrive } from './drive.js'

export const BASELINE = Object.freeze({ greed: 0.3, anger: 0.1, certainty: 0.7 })

const clamp = (v) => Math.max(0, Math.min(1, +Number(v).toFixed(3)))

function conditionOf(db, aid) {
  try {
    const r = db.prepare('SELECT load,attention,state FROM condition_state WHERE agent_id=?').get(aid)
    if (r) return { load: Number(r.load), attention: Number(r.attention), state: r.state }
  } catch { /* 老库没有工况表 */ }
  return { load: 0.2, attention: 0.8, state: 'focus' }
}

function memoryCount(db, aid) {
  try {
    return db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid).n
  } catch { return 0 }
}

export function getPoisons(db, aid) {
  agent(db, aid)
  let drive = null
  try { drive = getDrive(db, aid) } catch { drive = null }
  let affect = null
  try { affect = getAffect(db, aid) } catch { affect = null }
  const cond = conditionOf(db, aid)
  const deficits = (drive && drive.deficits) || {}
  const keys = ['R', 'E', 'C', 'A', 'S']
  const vals = keys.map((k) => Math.max(0, Math.min(1, Number(deficits[k] || 0))))
  const mean = vals.reduce((a, b) => a + b, 0) / keys.length
  const excess = Math.max(0, vals[0] - mean) + Math.max(0, vals[1] - mean)

  const greed = clamp(BASELINE.greed + excess * 0.5)
  const label = affect ? String(affect.primary_label || '') : ''
  const irritation = affect && ['irritated', 'frustrated'].includes(label) ? Number(affect.intensity || 0) : 0
  const anger = clamp(BASELINE.anger + irritation * 0.5 + (cond.load > 0.8 ? 0.1 : 0))
  const mems = memoryCount(db, aid)
  const certainty = clamp(BASELINE.certainty + Math.min(0.2, mems * 0.01) - Math.max(0, cond.load - 0.5) * 0.2)
  const delusion = clamp(1 - certainty)

  return {
    greed, anger, delusion, certainty,
    at: now(),
    inputs: {
      deficits, mean: +mean.toFixed(3), excess: +excess.toFixed(3),
      label, intensity: affect ? Number(affect.intensity || 0) : 0,
      load: cond.load, attention: cond.attention, condition: cond.state,
      memories: mems, band: drive ? drive.band : null,
    },
    baseline: { ...BASELINE },
    formula: 'greed=0.30+0.5·(R缺−均值)+0.5·(E缺−均值)；anger=0.10+0.5·irritation+(load>0.8?0.10)；delusion=1−certainty',
  }
}
