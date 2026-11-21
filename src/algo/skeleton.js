/**
 * 情绪骨架（2026-11-18 定，先只定骨架，不填词）
 * 三根正交轴，各一个二律背反：
 *   安：在（+1） / 危（-1）    —— 5-HT，存在论
 *   欲：向（+1） / 拒（-1）    —— DA，伦理/关系
 *   觉：明（+1） / 昧（-1）    —— NE，认识论
 * 八个姿态 = 三个符号的全部组合 = 立方体八个顶点；球心 = 平常；半径 = 卷入深浅。
 */
export const AXES = [
  { key: 'an', pos: '在', neg: '危', note: '边界在不在' },
  { key: 'yu', pos: '向', neg: '拒', note: '朝不朝向' },
  { key: 'jue', pos: '明', neg: '昧', note: '显不显明' },
]

export const POSTURES = [
  { name: '敞亮', signs: [1, 1, 1] },
  { name: '安住', signs: [1, 1, -1] },
  { name: '警醒', signs: [1, -1, 1] },
  { name: '疏淡', signs: [1, -1, -1] },
  { name: '渴慕', signs: [-1, 1, 1] },
  { name: '郁结', signs: [-1, 1, -1] },
  { name: '惊惧', signs: [-1, -1, 1] },
  { name: '沉沦', signs: [-1, -1, -1] },
]

const norm = (v) => { const L = Math.hypot(...v) || 1; return v.map((x) => x / L) }

/** 姿态方向：单位向量。 */
export const postureDir = (posture) => norm(posture.signs)

/** 方向 + 强度(0~1) → 球内一点（三维坐标）。 */
export function pointOf(posture, strength = 1) {
  const d = postureDir(posture)
  const r = Math.max(0, Math.min(1, Number(strength) || 0))
  return d.map((x) => x * r)
}

/** 两姿态夹角（弧度）。 */
export function angleBetween(a, b) {
  const x = postureDir(a), y = postureDir(b)
  const dot = x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
  return Math.acos(Math.max(-1, Math.min(1, dot)))
}

/** 骨架自检：八个方向两两只允许 70.53°（相邻）或 109.47°（对面）。 */
export function selfCheck() {
  const a = Math.acos(1 / 3) * 180 / Math.PI
  const b = Math.acos(-1 / 3) * 180 / Math.PI
  const out = []
  for (let i = 0; i < POSTURES.length; i++) {
    for (let j = i + 1; j < POSTURES.length; j++) {
      const deg = angleBetween(POSTURES[i], POSTURES[j]) * 180 / Math.PI
      if (Math.abs(deg - a) > 1e-6 && Math.abs(deg - b) > 1e-6 && Math.abs(deg - 180) > 1e-6) out.push([POSTURES[i].name, POSTURES[j].name, deg])
    }
  }
  return { ok: out.length === 0, bad: out, adjacent: a, opposite: b }
}

