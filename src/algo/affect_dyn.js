/**
 * 情绪动力学：affect_dyn@v1 / @v1b
 * mode=apply（默认）：{ state, appraisal } → 新 PAD / intensity / mood
 * mode=decay：{ state, hours, coef? } → 衰减后的 intensity / mood
 */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

/** 情绪标签 → PAD 锚点（修复 v1：PAD 必须跟着标签走，不能各自漂移） */
export const PAD_PRIOR = {
  joy: { p: 0.7, a: 0.4, d: 0.4 },
  /* 2026-11-03：平静这一档原来给到 0.5，等于「挺平静」也带半格正分，
     快情绪老贴在 0.3~0.7 不掉，「我是不是个镜子」那段自述就是被这个数带出来的。
     往中性收：peaceful 0.5→0.25、calm 0.4→0.15。joy 那些不动，正负两端先分开看。 */
  peaceful: { p: 0.25, a: -0.3, d: 0.2 },
  curious: { p: 0.3, a: 0.4, d: 0.1 },
  calm: { p: 0.15, a: -0.2, d: 0.1 },
  confused: { p: -0.2, a: 0.3, d: -0.3 },
  lost: { p: -0.3, a: 0.2, d: -0.4 },
  irritated: { p: -0.4, a: 0.5, d: 0.2 },
  frustrated: { p: -0.5, a: 0.4, d: -0.3 },
}

function makeAffectDyn(version, applyScale, decayScale) {
  return {
    name: 'affect_dyn',
    version,
    kind: 'affect_dyn',
    metrics: ['affect.intensity_mae', 'sys.algo_switch'],
    run(_ctx, input = {}) {
      if (input.mode === 'decay') {
        const state = input.state || {}
        const hours = Math.max(0, Number(input.hours ?? 24))
        const coef = Math.max(0.05, Number(input.coef ?? 1))
        const intensity = clamp(Number(state.intensity || 0) * Math.exp(-hours / (6 * decayScale * coef)), 0, 1)
        const mood = clamp(Number(state.mood || 0) * Math.exp(-hours / (24 * decayScale * coef)), 0, 1)
        return {
          intensity: Math.round(intensity * 1000) / 1000,
          mood: Math.round(mood * 1000) / 1000,
          primary_label: state.primary_label || state.label || 'calm',
          algo: { name: 'affect_dyn', version, mode: 'decay' },
        }
      }

      const state = input.state || {}
      const res = input.appraisal || {}
      const s = applyScale
      const label = String(res.label || state.primary_label || 'calm')
      const prior = PAD_PRIOR[label] || { p: 0, a: 0, d: 0 }
      const delta = 0.3 + 0.3 * Math.abs(Number(res.goal_congruence) || 0) + 0.1 * (Number(res.novelty) || 0)
      const intensity = clamp(0.3 * Number(state.intensity || 0) + 0.7 * delta * s, 0, 1)
      // PAD 向标签锚点回归，再叠加评价偏移；每次最多靠近一半，避免瞬间饱和
      // 愉悦轴的偏移系数比另外两轴大：一句话顺不顺你的意，最该体现在这一轴上
      const mix = (prev, target) => 0.45 * Number(prev || 0) + 0.55 * target
      const pleasure = clamp(mix(state.pleasure, prior.p + 0.32 * s * (Number(res.goal_congruence) || 0)), -1, 1)
      const arousal = clamp(mix(state.arousal, prior.a + 0.15 * s * (Number(res.novelty) || 0)), -1, 1)
      const dominance = clamp(mix(state.dominance, prior.d + (res.agency === 'self' ? 0.05 : -0.05) * s), -1, 1)
      const mood = clamp(0.8 * Number(state.mood || 0) + 0.2 * (0.5 + 0.5 * prior.p), 0, 1)
      return {
        label,
        intensity: Math.round(intensity * 1000) / 1000,
        pleasure: Math.round(pleasure * 1000) / 1000,
        arousal: Math.round(arousal * 1000) / 1000,
        dominance: Math.round(dominance * 1000) / 1000,
        mood: Math.round(mood * 1000) / 1000,
        algo: { name: 'affect_dyn', version, mode: 'apply' },
      }
    },
  }
}

/** 现行：与原 affect.js 系数一致 */
export const affectDynV1 = makeAffectDyn('v1', 1, 1)

/** 对照：评价冲击更强、时间衰减更快 */
export const affectDynV1b = makeAffectDyn('v1b', 1.35, 0.7)
