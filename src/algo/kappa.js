/**
 * κ：扣掉「碰巧一致」之后的吻合度。
 *   cohenKappa  两个评分者
 *   fleissKappa 三个及以上评分者
 */
export function cohenKappa(a, b) {
  const pairs = []
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x == null || y == null || x === '' || y === '') continue
    if (x === 'skip' || y === 'skip') continue
    pairs.push([String(x), String(y)])
  }
  const n = pairs.length
  if (!n) return { kappa: null, n: 0, po: null, pe: null }
  let agree = 0
  const countsA = {}
  const countsB = {}
  for (const [x, y] of pairs) {
    if (x === y) agree++
    countsA[x] = (countsA[x] || 0) + 1
    countsB[y] = (countsB[y] || 0) + 1
  }
  const po = agree / n
  let pe = 0
  const cats = new Set([...Object.keys(countsA), ...Object.keys(countsB)])
  for (const c of cats) pe += ((countsA[c] || 0) / n) * ((countsB[c] || 0) / n)
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe)
  return { kappa: +kappa.toFixed(3), n, po: +po.toFixed(3), pe: +pe.toFixed(3) }
}

/**
 * Fleiss' κ：三到多个评分者。
 * 只统计「每个人都标了」的完整样本；缺失或 skip 的行整行忽略。
 */
export function fleissKappa(rows) {
  const complete = rows.filter((r) => r.every((x) => x != null && x !== '' && x !== 'skip'))
  const n = complete.length
  if (!n) return { kappa: null, n: 0 }
  const m = rows[0] ? rows[0].length : 0
  if (m < 2) return { kappa: null, n: 0 }
  const counts = {}
  let pSum = 0
  for (const r of complete) {
    const c = {}
    for (const x of r) { const k = String(x); c[k] = (c[k] || 0) + 1 }
    let pi = 0
    for (const v of Object.values(c)) pi += v * (v - 1)
    pSum += pi / (m * (m - 1))
    for (const [k, v] of Object.entries(c)) counts[k] = (counts[k] || 0) + v
  }
  const pBar = pSum / n
  const total = n * m
  let pe = 0
  for (const v of Object.values(counts)) pe += (v / total) ** 2
  const kappa = pe === 1 ? 1 : (pBar - pe) / (1 - pe)
  return { kappa: +kappa.toFixed(3), n }
}
