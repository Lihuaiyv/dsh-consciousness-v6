/**
 * 表达状态：一轮里「她怎么说话」的唯一出口。
 *
 * 以前是三套各说各的：index.js 内联的「这一轮的说话分寸」、reldyn.toneOf（关系温度）、
 * selfview.toneOf（强度）。于是同一轮可能既写着「热情 0.91」又写着「语气偏冷」。
 *
 * 现在只在这里合成一次：
 *   输入：affect_state 一行（可带 v3）+ 当前对话对象的关系三轴
 *   输出：{ level, sentences, proactive, tone, warmth, formality, disclosure,
 *          initiative, felt, wish }
 *
 * 两条规则（别改）：
 *   1) 句长 / 主动性只由情绪档决定；关系只能调「温度」，不能把低落的她逼得多说。
 *   2) 输出的是「我想…」的愿望，不是「只说 1 句」的命令——命令会让她演戏。
 *
 * 纯函数：不读库、不调模型，方便单测。
 */

import { expressionFrom } from '../algo/expression.js'

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

/** 情绪词 → 感受短语（不带「我」开头，交给整句的推测口吻）。 */
const PHRASE = {
  joy: ['有点高兴', '挺高兴', '很高兴'],
  peaceful: ['挺安稳', '很安稳', '特别松'],
  curious: ['有点好奇', '挺好奇', '特别好奇'],
  calm: ['挺平静', '很平静', '静得很'],
  confused: ['有点没跟上', '有点糊涂', '脑子有点绕'],
  lost: ['有点发虚', '有点空', '有点找不着底'],
  irritated: ['有点烦', '挺烦', '挺烦的，不太想接话'],
  frustrated: ['有点挫败', '挺挫败', '挺挫败的，提不起劲'],
}

/** 强度分档：0 弱 / 1 中 / 2 强。 */
function intensityBand(intensity) {
  const i = clamp01(num(intensity, 0.4))
  if (i < 0.4) return 0
  if (i < 0.7) return 1
  return 2
}

/** 总情绪（-1~1）→ 人话分档。底色（baseline）属于插件参数，不进提示词。 */
export function moodWord(v) {
  const n = num(v, null)
  if (n == null) return ''
  if (n >= 0.2) return '偏正面'
  if (n <= -0.2) return '偏负面'
  return '中性'
}

/**
 * 此刻感受：**推测口吻**，不是断言。
 * 旧版是「此刻情绪：挫败」+「说话分寸：…」，像下命令；
 * 新版是「感觉现在大概的情绪是：…」，把权重压低——只当底子，不照着演。
 *
 * @param {object} p
 * @param {number} [p.weight] 0~1；<0.5 时句尾加一句免责，提醒这不是命令
 */
export function feltLine({ label, intensity, slow, mood, weight = 0.35 } = {}) {
  const arr = PHRASE[String(label || 'calm')] || PHRASE.calm
  const bits = [arr[intensityBand(intensity)]]
  const s = clamp(num(slow, 0), -1, 1)
  if (s <= -0.2) bits.push('不太想多说')
  else if (s >= 0.25) bits.push('愿意多说两句')
  const mw = moodWord(mood)
  const head = Number(weight) >= 0.5 ? '现在的情绪是：' : '感觉现在大概的情绪是：'
  return head + bits.join('，') + (mw ? '；整体心情' + mw : '') + '。'
}

/** 我想怎么说：软愿望，按表达档给，不是命令。 */
const WISH = {
  quiet: '我想说得短一点，不太想展开。',
  brief: '我想两三句就收住，不想铺开。',
  normal: '就正常说，不用特意收着。',
  warm: '我今天愿意多说一点。',
}

export function wishLine({ level } = {}) {
  return WISH[String(level || 'normal')] || WISH.normal
}

/**
 * 这一轮怎么写（P2）：愿望管「说多少」，这里管「写成什么样」。
 *
 * 只有愿望是不够的——模型默认的文体是助手体：先结论、再分点、最后收尾。
 * 「我想说得短一点」压不住这个默认值，得单独说一句「说完就停、不总结、不列点」。
 *
 * 仍然写成「我想…」的倾向，不是「只说 1 句」的命令：命令会让她照着演。
 */
/**
 * 这一轮怎么说（P2 · 合并版）：愿望和文体合成一句。
 *
 * 以前是两行命令——「我想说得短一点」+「一句就停，不解释」——
 * 两条都在管「说多少」，叠在一起就成了念检讨的调子。
 * 现在只给一句：说多少 + 一句底线（不列点、不总结），姿态交给材料。
 */
const CARD = {
  quiet: '一句就停，不解释；不用道歉，也不用检讨。',
  brief: '两三句说完就收，不总结，也不检讨自己。',
  normal: '随口说，说完就停。',
  warm: '我今天愿意多说一点，不总结、不列点。',
}

export function cardLine({ level } = {}) {
  return CARD[String(level || 'normal')] || CARD.normal
}

export function styleLine({ level } = {}) {
  return cardLine({ level })
}

/** 表达档 → 温度基准：低落压过关系，不反过来。 */
const TONE_WARMTH = { cool: 0.25, plain: 0.5, warm: 0.8, short: 0.45 }

const LEVELS = ['quiet', 'brief', 'normal', 'warm']

/**
 * 快情绪的「影子档」：只算给你看，不生效。
 *
 * 现在 level 只看慢情绪（v3.slow），所以刚被扎一下、快情绪很高的时候，
 * 她说话还是那副平稳样子。要不要把它接进表达，是个产品判断；
 * 先让它在旁边算着，攒够对比数据再决定——免得凭感觉改了又改回去。
 */
export function shadowLevel(baseLevel, { fast = 0, slow = 0 } = {}) {
  const at = LEVELS.indexOf(String(baseLevel || 'normal'))
  const i = at >= 0 ? at : LEVELS.indexOf('normal')
  const f = clamp(num(fast, 0), -1, 1)
  const s = clamp(num(slow, 0), -1, 1)
  let j = i
  if (f >= 0.35 && s > -0.2) j = Math.min(LEVELS.length - 1, i + 1)
  if (f <= -0.35) j = Math.max(0, i - 1)
  return LEVELS[j]
}

/**
 * 合成一次表达状态。
 * @param {object} p
 * @param {object} [p.affect] affect_state 行（可带 v3: {slow,total,baseline}）
 * @param {object} [p.relation] 关系三轴 {closeness,trust,kind,warmth,formality,disclosure,initiative}
 * @param {number} [p.ei] 外向度 0..1
 */
export function expressionState({ affect = null, relation = null, ei = 0.6, weight = 0.35 } = {}) {
  const slow = clamp(num(affect && affect.v3 ? affect.v3.slow : 0, 0), -1, 1)
  const fast = clamp(num(affect && affect.v3 ? affect.v3.fast : 0, 0), -1, 1)
  const intensity = clamp01(num(affect ? affect.intensity : 0.4, 0.4))
  // 总情绪：优先 v3（-1~1）；老库退回 affect.mood（0~1），换算到同一口径
  const total = affect && affect.v3 && affect.v3.total != null
    ? clamp(num(affect.v3.total, 0), -1, 1)
    : affect && affect.mood != null ? clamp(2 * Number(affect.mood) - 1, -1, 1) : null
  const base = expressionFrom({ slow, intensity, ei: clamp01(num(ei, 0.6)) })

  // 关系只进「温度 / 正式 / 披露」；句长和主动性以情绪为准
  const relWarmth = clamp01(num(relation && relation.warmth, 0.5))
  const relFormality = clamp01(num(relation && relation.formality, 0.4))
  const relDisclosure = clamp01(num(relation && relation.disclosure, 0.5))
  const relInitiative = clamp01(num(relation && relation.initiative, 0.5))
  const baseWarmth = TONE_WARMTH[base.tone] != null ? TONE_WARMTH[base.tone] : 0.5
  const warmth = clamp01(0.6 * relWarmth + 0.4 * baseWarmth)
  // 主动性取两边的低者：低落时不因为关系近就显得急
  const initiative = clamp01(Math.min(relInitiative, base.proactive / 2))

  return {
    level: base.level,
    // 影子：fast 高一点会怎样（不进 style / wish，只给评测和面板看）
    fast: Math.round(fast * 100) / 100,
    wouldLevel: shadowLevel(base.level, { fast, slow }),
    sentences: base.sentences,
    proactive: base.proactive,
    tone: base.tone,
    warmth: Math.round(warmth * 100) / 100,
    formality: Math.round(relFormality * 100) / 100,
    disclosure: Math.round(relDisclosure * 100) / 100,
    initiative: Math.round(initiative * 100) / 100,
    felt: feltLine({ label: affect && affect.primary_label, intensity, slow, mood: total, weight }),
    wish: wishLine({ level: base.level }),
    style: styleLine({ level: base.level }),
  }
}
