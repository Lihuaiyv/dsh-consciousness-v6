/**
 * 情绪球面骨架（2026-11-18，设计见 docs/功能/5-情绪与说话/设计-情绪球面骨架-2026-11-18.md）
 *
 * 只做几何：把 S/N/D 映到单位球里的「方向 + 半径」。
 *   u = 2S−1、v = 2N−1、w = 2D−1；r = |(u,v,w)|/√3；方向 = 归一化。
 * 球心 = 平静，外壳 = 极端；半径就是强度。
 *
 * 2026-11-18 落地时的一个发现：现有 60 个词按「8 角族」分是 7/8/8/18/3/1/15/15 个，
 * 并不均匀（-1,+1,-1 一族 18 个）。所以这一版先把「查表」换成角距离 + 半径差，
 * 词本身还留在原来的语义位置；「4 层 × 15 个均匀格」的重排另做（会动词表，要另定）。
 */

/**
 * 八个方向的族名 = 两字八格（2026-11-19 定）。
 * 旧的八个族名（上扬/惊喜/安心/松弛/紧张/沮丧/硬撑/发木）**已废弃**：
 * 那套是按「有没有危险」起的，把「想要但要不到」全压成一个「硬撑」；
 * 两字这套是按三根轴分别想的，每个名字钉在一个顶点上。
 * 依据：交接-情绪骨架与词表-2026-11-18 §二、交接-情绪词库与判据-v4-2026-11-19 §5.2。
 *
 * dir 的顺序是 [u, v, w] = [2S−1, 2N−1, 2D−1]。
 */
export const FAMILIES = [
  { key: 'le', zh: '敞亮', dir: [1, 1, 1] },    // S高 N高 D高
  { key: 'jing', zh: '警醒', dir: [1, 1, -1] },  // S高 N高 D低
  { key: 'an', zh: '安住', dir: [1, -1, 1] },    // S高 N低 D高
  { key: 'song', zh: '疏淡', dir: [1, -1, -1] }, // S高 N低 D低
  { key: 'jin', zh: '渴慕', dir: [-1, 1, 1] },   // S低 N高 D高
  { key: 'ju', zh: '郁结', dir: [-1, 1, -1] },   // S低 N高 D低
  { key: 'ying', zh: '惊惧', dir: [-1, -1, 1] }, // S低 N低 D高
  { key: 'mu', zh: '沉沦', dir: [-1, -1, -1] },  // S低 N低 D低
]

/** 4 层半径（设计里的 0.15 / 0.40 / 0.65 / 0.90）。 */
export const LAYERS = [0.15, 0.40, 0.65, 0.90]

export function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)) }

/** S/N/D → {u,v,w,r,dir,rLayer}。r∈0~1，dir 单位向量；r≈0 时 dir 为 null。 */
export function toSphere(pos = {}) {
  const s = clamp01(pos.s === undefined ? 0.5 : pos.s)
  const n = clamp01(pos.n === undefined ? 0.15 : pos.n)
  const d = clamp01(pos.d === undefined ? 0.5 : pos.d)
  const u = 2 * s - 1
  // N 的中性不是 0.5：平静 N=0.15。正向到 1 拉开；负向只剩 0.15 的余量（比预想更平淡）
  const v = n >= 0.15 ? (n - 0.15) / 0.85 : (n - 0.15) / 0.15
  const w = 2 * d - 1
  const len = Math.sqrt(u * u + v * v + w * w)
  const r = len / Math.sqrt(3)
  const dir = len < 1e-6 ? null : [u / len, v / len, w / len]
  // 半径落在哪一层（0~3）；给模板化的强度档用
  let rLayer = 0
  for (let i = 1; i < LAYERS.length; i++) if (r >= (LAYERS[i] + LAYERS[i - 1]) / 2) rLayer = i
  return { s, n, d, u, v, w, r, dir, rLayer }
}

/** 两个方向的夹角（弧度，0~π）。任一为空（球心）时返回 π（和谁都不算近）。 */
export function angleBetween(a, b) {
  if (!a || !b) return Math.PI
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
  return Math.acos(dot)
}

/** 方向属于哪个族：取最近的立方体顶点。 */
export function familyOf(pos = {}) {
  const t = pos.dir ? pos : toSphere(pos)
  if (!t.dir) return null
  let best = null
  for (const f of FAMILIES) {
    const L = Math.sqrt(3)
    const dot = (t.dir[0] * f.dir[0] + t.dir[1] * f.dir[1] + t.dir[2] * f.dir[2]) / L
    if (!best || dot > best.dot) best = { fam: f, dot }
  }
  return best ? best.fam : null
}

/**
 * 某个原型在球面上的位置：词本身留在原语义坐标上，只是换算成方向 + 半径。
 * 返回 { word, dir, r, rLayer }。
 */
export function spherePointOf(word) {
  const t = toSphere(word)
  return { word, dir: t.dir, r: t.r, rLayer: t.rLayer }
}

/**
 * 球面查表：按「角距离 + 半径差」给每个原型打分（越小越近）。
 * 权重：角度占七成、半径占三成——同一族里靠近的层才算近，但跨层不鼓励。
 * 返回 Map(name → {score, angle, dr})，由调用方接门控与归一化。
 */
export function sphereScores(pos, prototypes, { wAngle = 0.7, wRadius = 0.3 } = {}) {
  const t = toSphere(pos)
  const out = new Map()
  for (const p of prototypes) {
    const q = toSphere(p)
    const ang = angleBetween(t.dir, q.dir) / Math.PI // 0~1
    const dr = Math.abs(t.r - q.r) / Math.sqrt(3) // 0~1 —— 半径差也归一到 √3（理论最大）
    out.set(p.name, { score: wAngle * ang + wRadius * dr, angle: ang * Math.PI, dr: q.r - t.r })
  }
  return out
}
