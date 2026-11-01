/**
 * 情绪事件闸门：gate@v1（P2 生效）
 *
 * 解决的问题：管线把「每一条消息」都当成一次情绪事件，于是每句话都有一个标签。
 * 这一层只回答一个问题——**这件事值不值得起情绪**。答案不是一个标签，而是一个
 * 显著性 sig；只有 sig 过线，才允许开一次 episode。
 *
 *   sig = rel^0.5 · (0.45·|c| + 0.25·nov + 0.15·(1−cert) + 0.15·|Δc|) · habit
 *   habit = 1 / (1 + 0.5 · 同类事件近期次数)
 *
 * 依据见 v1新版本重要文档/7-情绪事件化-v1.md §2–§3：
 *   - Russell 2003：核心情感常在，只有「归因于某个原因」才开始 episode
 *   - Frijda 1988：情绪由「变化」触发；重复刺激会习惯化
 *   - Loossens 2020（AIM）：离散状态是连续动力学跨阈值的结果
 *   - Verduyn 2009：事件重要性、起点强度决定持续时长
 *
 * 挡位由 affect.gate.mode 决定：on = 生效（默认），shadow = 只记录不接管。
 * 过闸线取 0.10：宁可多记住几次真的生气/高兴，也别把日子过成一条直线。
 */

export const GATE_VERSION = 'v2'

export const GATE = {
  /** 过闸线。0.10 比影子期的 0.15 松一档：任务话仍过不去，语气一变就能进 */
  theta: 0.10,
  /** 四项权重，和为 1 */
  w: { cong: 0.45, nov: 0.25, unc: 0.15, change: 0.15 },
  /** 习惯化强度：同类事件每多一次，显著性按 1/(1+k·n) 打折 */
  habitK: 0.5,
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(Number(x)) ? Number(x) : lo))
const clamp01 = (x) => clamp(x, 0, 1)
const round3 = (x) => Math.round(Number(x) * 1000) / 1000

/**
 * 算一次显著性。
 * @param {object} p
 * @param {number} p.rel   关切相关性 0~1：碰没碰到它在乎的事（不是任务相关性）
 * @param {number} p.cong  关切一致性 -1~1：顺不顺它在乎的事
 * @param {number} p.nov   新异 0~1：是不是新信息
 * @param {number} p.cert  确定 0~1：它有多确定自己看懂了
 * @param {number} p.prevCong 上一次同类评价的一致性，用来算「变化」
 * @param {number|null} p.change 模型直接给的变化量 0~1（concern 口径）；不给就用 |c − prevCong|
 * @param {number} p.habitCount 近 6 小时同类事件次数
 * @returns {{sig:number, base:number, habit:number, change:number, rel:number}}
 */
export function significanceOf({
  rel = 0, cong = 0, nov = 0, cert = 0.8, prevCong = 0, change = null, habitCount = 0,
  habitK = GATE.habitK, w = GATE.w,
} = {}) {
  const r = clamp01(rel)
  const c = clamp(cong, -1, 1)
  const delta = change == null || !Number.isFinite(Number(change))
    ? clamp(Math.abs(c - clamp(prevCong, -1, 1)), 0, 1)
    : clamp01(change)
  const base = Math.sqrt(r) * (
    Number(w.cong) * Math.abs(c) +
    Number(w.nov) * clamp01(nov) +
    Number(w.unc) * (1 - clamp01(cert)) +
    Number(w.change) * delta
  )
  const habit = 1 / (1 + Math.max(0, Number(habitK) || 0) * Math.max(0, Number(habitCount) || 0))
  return {
    sig: round3(base * habit),
    base: round3(base),
    habit: round3(habit),
    change: round3(delta),
    rel: round3(r),
  }
}

/** 过闸判定 */
export function gateOf(sig, theta = GATE.theta) {
  const t = Number.isFinite(Number(theta)) ? Number(theta) : GATE.theta
  return Number(sig) >= t
}

/** 八类分布的领先幅度（top1 − top2）；判不清时给 P1 用来写「说不清」 */
export function labelMargin(scores) {
  if (!scores || typeof scores !== 'object') return null
  const v = Object.values(scores).map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => b - a)
  if (v.length < 2) return null
  return round3(v[0] - v[1])
}

/** 一次算全：显著性 + 是否过闸 + 标签领先幅度。调用方只读，不产生副作用。 */
export function shadowGate(p = {}) {
  const out = significanceOf(p)
  const theta = Number.isFinite(Number(p.theta)) ? Number(p.theta) : GATE.theta
  return { ...out, theta, gate: gateOf(out.sig, theta), margin: labelMargin(p.scores) }
}

/**
 * 「被点名评价」的下限。
 *
 * 模型经常把「你一点都不活」「都不饿阿」判成 none——因为它在判断「任务顺不顺」时，
 * 这类话不属于任何任务。但那是在说它自己：被评价、被抱怨、被夸，按定义就碰到了
 * 它在乎的事（自尊与能力、关系）。这里给一个不依赖模型自由打分的下限：
 *   · 话里点到了「你 / 您」，又带了评价词  → relevance ≥ 0.55，按褒贬给 congruence；
 *   · 只点了「你 / 您」，没有评价词        → relevance ≥ 0.35（够不着闸门，仍算相关）；
 *   · 没点名                              → null，不改模型判断。
 * 纯函数，不碰库；调用方负责把结果和模型输出取 max。
 */
export function socialFloorOf(text) {
  const t = String(text || '')
  const directed = /(你|您)/.test(t)
  /* 「它自己的状态」也可以不点名：『都不饿阿』『一点不活』说的就是它。
     但「我不饿」是在说对方自己，排除掉。 */
  const agentState = /(不饿|不活|没反应|太平|没感觉|不像人|不生动|太木|太冷)/.test(t)
  const mine = /我[^，。！？]{0,4}(不饿|不活|没反应|太平|没感觉|不像人|不生动)/.test(t)
  /* 情绪词：不是句式，是「人在气头上会说的话」。这类短句离开上下文本来就是
     对着对方说的（服了 / 无语 / 算了 / 离谱），模型单看会判成闲聊，这里补一道。 */
  const idiom = /(服了|无语|醉了|离谱|什么玩意|算了|行吧|呵呵|emmm|绷不住)/.test(t)
  if (!directed && !agentState && !idiom) return null
  if (!directed && mine) return null
  const strong = agentState || idiom || /(不活|没反应|太平|不像|不够|太差|笨|蠢|懒|慢|厉害|棒|喜欢|讨厌|烦|气|失望|谢谢|夸|饿|冷|暖|委屈|难受|开心|高兴|错|糟糕|活|不错|真好)/.test(t)
  // 不要裸「太」：「太好了 / 太喜欢」是褒义；负面靠「太差」等强词或其它否定词。
  const neg = idiom || /(不|没|差|笨|蠢|懒|慢|讨厌|烦|气|失望|错|糟糕)/.test(t)
  if (!strong) return { rel: 0.35, cong: 0, change: 0.1, level: 'addressed' }
  return { rel: idiom ? 0.5 : 0.55, cong: neg ? -0.35 : 0.45, change: 0.35, level: idiom ? 'idiom' : 'evaluated' }
}
