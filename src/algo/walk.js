/**
 * 不可逆的那一部分：水位的随机游走（Ornstein-Uhlenbeck 过程）。
 *
 * 为什么要有它：底色（段式慢波 + 日节律 + 激素纹 + 负荷）全是 (seed, t) 的纯函数，
 * 同一个时刻算一百遍都是同一个数。所以不管做得多细，它只能是「像」，不能是「走过」。
 *
 * 这一层不一样：它带状态、存在库里，走过就是走过——明天不会因为你重算一遍就变回原样，
 * 两条都从同一个点出发，也会因为中途的随机步子走到不同的地方。
 *
 * 用 OU 而不是纯随机游走，因为纯游走会飘到 ±∞：
 *   dw = −(w/τ)·dt + σ·√(2/τ)·dW
 * 稳态标准差就正好是 σ。τ 是「走散了多久会被拉回来」的时标。
 */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

/** Box-Muller：一个标准正态。给 Math.random 就是真随机，给固定序列就是可复现的测试。 */
export function gaussFrom(rnd) {
  let u = Number(rnd())
  let v = Number(rnd())
  if (!Number.isFinite(u) || !Number.isFinite(v)) return 0
  if (u <= 1e-12) u = 1e-12
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * 走一步。dt 给多长都行（OU 的精确解，不需要切成小步，也不会因为分段而多出方差）。
 * sd 是稳态标准差：sd=0 就是「不游走」，退回纯函数的那套底色。
 */
export function stepWalk({ walk = 0, dtHours = 0, tauH = 36, sd = 0.03, rnd = Math.random } = {}) {
  const dt = Math.max(0, Number(dtHours) || 0)
  const tau = Math.max(0.5, Number(tauH) || 36)
  const amp = Math.max(0, Number(sd) || 0)
  const w0 = Number(walk) || 0
  const k = Math.exp(-dt / tau)
  /* 不走、或者关掉：只剩自己往 0 回，不带随机 */
  if (!dt || !amp) return Math.round(clamp(w0 * k, -1, 1) * 1e6) / 1e6
  const spread = amp * Math.sqrt(Math.max(0, 1 - k * k))
  return Math.round(clamp(w0 * k + spread * gaussFrom(rnd), -1, 1) * 1e6) / 1e6
}
