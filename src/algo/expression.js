/**
 * 表达 v1：心情 → 说话方式的长效耦合
 *
 * 现在句长只看「这一下的强度」，所以低落了一整天，说话也不变短。
 * 这里加两条：
 *   - 慢情绪定基调：低落时少说、不主动；偏高时愿意展开；
 *   - 这一下的强度仍然压上限：太激动时话短，跟原来一致。
 * 外向 / 内向在中间微调，但压不过「低落」。
 *
 * 纯函数，不读写库。接入点：index.js 的语气档（原来只算 intensity）。
 */

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const clamp01 = (x) => clamp(x, 0, 1)

export const LEVELS = {
  quiet: { sentences: 1, proactive: 0 },
  brief: { sentences: 2, proactive: 0 },
  normal: { sentences: 3, proactive: 1 },
  warm: { sentences: 4, proactive: 2 },
}

function toneOf(s, i) {
  if (i > 0.8) return 'short'
  if (s <= -0.2) return 'cool'
  if (s >= 0.25) return 'warm'
  return 'plain'
}

/**
 * @param {object} p
 * @param {number} [p.slow] 慢情绪 [-1,1]
 * @param {number} [p.intensity] 这一下的强度 [0,1]
 * @param {number} [p.ei] 外向度 [0,1]，0.5 中性
 */
export function expressionFrom({ slow = 0, intensity = 0.4, ei = 0.5 } = {}) {
  const s = clamp(num(slow, 0), -1, 1)
  const i = clamp01(num(intensity, 0.4))
  const e = clamp01(num(ei, 0.5))

  // 1) 慢情绪定基调
  let level = 'normal'
  if (s <= -0.2) level = 'quiet'
  else if (s <= -0.05) level = 'brief'
  else if (s >= 0.25) level = 'warm'

  let sentences = LEVELS[level].sentences
  let proactive = LEVELS[level].proactive

  // 2) 强度压上限（跟原来一致）
  if (i > 0.8) {
    sentences = 1
    proactive = 0
  } else if (i > 0.6) {
    sentences = Math.min(sentences, 2)
    proactive = 0
  }

  // 3) 外向多说半句，内向少说半句；低落档不给这句（低落压过性格）
  if (e >= 0.65 && sentences < 4 && i <= 0.6 && level !== 'quiet') sentences += 1
  if (e <= 0.35 && sentences > 1) sentences -= 1

  // 4) 低落时不主动（这条优先于外向）
  if (s <= -0.2) proactive = 0

  return {
    level,
    sentences: Math.max(1, Math.min(4, sentences)),
    proactive: Math.max(0, Math.min(2, proactive)),
    tone: toneOf(s, i),
  }
}
