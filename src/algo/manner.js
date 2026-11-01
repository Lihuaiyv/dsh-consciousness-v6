/**
 * 鱼格和关系 → 这一轮怎么说话。纯函数。
 * 中间带与 traits.isMid 同一套百分位：离 0.5 不到 5 个点就不写。
 * 不出现「偏内向」「亲近 0.72」「可以说到 68%」这种标签和数字。
 */

const NEUTRAL = 0.5
const MID = 0.05

export function axisMid(v) {
  const cents = Math.round(Number(v) * 100)
  if (!Number.isFinite(cents)) return true
  return Math.abs(cents - Math.round(NEUTRAL * 100)) < Math.round(MID * 100)
}

const AXIS_BITS = [
  ['ei', '可以自己把话接下去', '问了再答，少自己起话头'],
  ['sn', '先说眼前具体的事', '可以顺着意思往下想'],
  ['tf', '先把事情说清楚，再谈感受', '先接住对方的感受'],
  ['jp', '能定的就说定', '先别把话说死'],
  ['sensitivity', '对方一句重的要接住', '不必每句都接情绪'],
]

function axisBits(axes) {
  const src = axes && typeof axes === 'object' ? axes : {}
  const bits = []
  for (const [k, hi, lo] of AXIS_BITS) {
    const v = Number(src[k])
    if (axisMid(v)) continue
    bits.push(v > NEUTRAL ? hi : lo)
  }
  return bits
}

/** tone 来自 toneOf：warmth / formality / disclosure / initiative，都在 0~1。 */
function relationBits(tone) {
  if (!tone || typeof tone !== 'object') return []
  const warmth = Number(tone.warmth)
  const formality = Number(tone.formality)
  const disclosure = Number(tone.disclosure)
  const initiative = Number(tone.initiative)
  if (![warmth, formality, disclosure, initiative].every(Number.isFinite)) return []
  if (warmth >= 0.7 && disclosure < 0.55) return ['话可以热，底交到表面上就停']
  if (disclosure >= 0.55) {
    const bits = ['可以把理由说出来']
    if (initiative >= 0.4) bits.push('可以追问一句')
    return bits
  }
  if (disclosure < 0.4 || warmth < 0.45) {
    const bits = ['答到表面上就停']
    if (formality >= 0.55) bits.push('句子说完整')
    return bits
  }
  if (formality >= 0.55) return ['句子说完整，答到事情本身']
  return ['可以说得随意一点']
}

/**
 * @param {{ axes?: object, tone?: object, who?: string }} p
 * @returns {string} 没有可说的就返回空串，不带句号
 */
export function mannerLine({ axes, tone, who } = {}) {
  const bits = [...axisBits(axes), ...relationBits(tone)]
  if (!bits.length) return ''
  const name = String(who || '').trim()
  return (name ? '对' + name + '：' : '') + bits.join('，')
}
