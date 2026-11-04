/**
 * 参数 Θ（logic-gates v3 §14）。[默认值, 可调范围|null]；范围非空 = 带 * 可由 L5 调节。
 * 当前值 = 投影里 THETA_ADJUST 的结果，否则回落默认；按 scope 查：'q:<id>' → 层 → '*'。
 */

export const THETA = Object.freeze({
  alpha: [0.2, null], beta: [0.25, null],
  w_act: [0.6, null], w_verdict: [1.0, null], w_check: [1.0, null], w_invest: [0.5, null],
  theta_dup: [0.9, null], theta_rel: [0.55, null],
  // 字面分与余弦不同量纲：近义改写大约 0.13 起，无关句样本不超过 0.07
  theta_dup_lex: [0.4, null], theta_rel_lex: [0.12, null],
  n_min: [3, [2, 8]], delta_pi: [0.4, [0.25, 0.7]],
  pi_fals: [-0.5, null],
  T_trial: [7, null], N_trial: [3, [2, 6]], T_nu: [30, null],
  C_max: [3, null], pi_core: [0.5, null],
  K: [3, null], W_deg: [14, null], M_core: [5, null],
  D_v: [3, null], T_v: [30, null], T_cool: [14, null],
  k: [5, null], theta_sim: [0.6, null], tau: [30, null],
  w_q: [0.5, null], w_p: [0.4, null], w_k: [0.1, null],
  T_mature: [14, null], lambda: [0.3, [0, 0.4]], N_inhib: [2, null],
  'prior_SUB.W': [0.3, [0.05, 0.35]], 'prior_SUB.L': [0.3, [0.05, 0.35]], 'prior_SUB.V': [0.2, [0.05, 0.35]],
  'prior_COEX.L': [0.2, null], 'prior_COEX.V': [0.4, null], prior_SUSPEND: [0.1, null],
  N_delib: [3, [1, 6]], N_inq: [3, [1, 6]],
  Q_ask: [1, null], T_ask: [7, null], T_dog: [30, null], theta_surp: [1.6, null],
  c_lo: [0.02, null], c_hi: [0.25, null], n_abd: [3, null],
  N_nb: [5, null], K_open: [20, null], tau_age: [7, null],
  T_dormant: [60, null], T_clash: [7, null], T_approve: [7, null],
  T_hollow: [30, null], pi_ext: [0.9, null], T_bal: [30, null],
  T_stale: [21, null],
  F0: [20, null], O0: [5, null], Qi_lo: [0.3, null],
  // 生长序：1 = 价值观还没有一条活的时，世界观不许先长（默认为 0，先只在模拟里开）
  growth_order: [0, [0, 1]],
})

export const isTunable = (key) => !!(THETA[key] && THETA[key][1])

export function inRange(key, value) {
  const spec = THETA[key]
  if (!spec || !spec[1] || typeof value !== 'number' || !Number.isFinite(value)) return false
  return value >= spec[1][0] - 1e-9 && value <= spec[1][1] + 1e-9
}

/** 从投影 θ 表（'key@scope' → { value }）取值：先精确 scope，再层，再全局，最后默认。 */
export function thetaOf(theta, key, scope = '*', layer = null) {
  const tab = theta || {}
  for (const s of [scope, layer, '*']) {
    const hit = s ? tab[key + '@' + s] : undefined
    if (hit) return hit.value
  }
  return THETA[key] ? THETA[key][0] : undefined
}
