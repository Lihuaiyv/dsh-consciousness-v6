// 网格选词：位置 → 片 → 格 → 按典型度 × 浓淡挑一个词
// 主线从 affect_v4.js 的 gridDistribution 进（不是开关；2026-11-23 清掉旧注释里那个已废弃的 affect.v4.grid 开关名）
import { GRID_CELLS, GRID_ANNOT, GRID_SLOTS, GRID_LEVEL } from './lexicon_grid.js'
import { LEXICON_V4 } from './lexicon_v4.js'
// 十四族那层 2026-11-21 整层删了：判断层每轮现判，判偏就拽词，没用。

const BY = ['我', '对方', '外面']
const TO = ['冲自己', '冲对方', '冲外面', '无']

// 判断层的值域跟网格的字面不一样（2026-11-20 查到）：
//   judgment.by   → me / self / other / world
//   frame.target  → me / owner / other / world
// 不映射的话，每一帧都会落进「无·无」，判据白给。
const BY_MAP = {
  我: '我', self: '我', me: '我',
  对方: '对方', other: '对方', owner: '对方', you: '对方',
  外面: '外面', world: '外面', thing: '外面', event: '外面'
}
// TARGET_MAP（frame.target → 冲谁）2026-11-22 删：那是「这句话冲谁说」，主语是对方；
// 情绪落格只认判断层的 `to`（我冲谁），不拿它顶。见 slotOf。
const TO_ALIAS = {
  冲自己: '冲自己', 自己: '冲自己', self: '冲自己', me: '冲自己',
  冲对方: '冲对方', 对方: '冲对方', other: '冲对方', you: '冲对方', owner: '冲对方',
  冲外面: '冲外面', 外面: '冲外面', world: '冲外面', thing: '冲外面',
  // 注意：**空字符串不映射成「无」**。空 = 没给（不落格）；「无」只认明说的 none / 无。
  无: '无', none: '无'
}

// 词 → 它属于哪一片（GRID_CELLS 里 284 个词都有片，2026-11-21 核过）
const WORD_CELL = new Map()
for (let i = 0; i < GRID_CELLS.length; i++) for (const w of GRID_CELLS[i].words) WORD_CELL.set(w, i)

const dist3 = (a, b) => Math.sqrt((a.s - b.s) ** 2 + (a.n - b.n) ** 2 + (a.d - b.d) ** 2)

/**
 * 2026-11-21：书面腔的词。它们坐标没问题，但不像「我此刻的感觉」——
 * 真实的人被道歉时说「愣了一下」「气还没顺」，不会说「如梦初醒」「闻宠若惊」。
 * 这一批不删（主人 11-19 说过别手删、全放回），只在打分时降一档，
 * 让同一位置上的口语词（有点慌 / 心里堵 / 缓过来）先被挑走。
 */
const LITERARY = new Set([
  '无可如何', '无所事事', '豁然开朗', '闻宠若惊', '惊喜交集', '惘然若失', '愤世嫉俗',
  '震撼人心', '惊喜交加', '得意扬扬', '义愤填膺', '愤不欲生', '心浮气躁', '恨入骨髓',
  '自鸣得意', '惊慌失措', '心不在焉', '喜出望外', '心潮澎湃', '如梦初醒', '与世无争',
  '清心寡欲', '热泪盈眶', '怒不可遏', '怒气冲冲', '心急火燎', '心有余悸', '敢怒不敢言',
  '麻木不仁', '愁眉苦脸', '坐立不安', '同病相怜', '孤芳自赏', '患得患失',
])
export const LITERARY_PENALTY = 0.18
export const isLiterary = (name) => LITERARY.has(String(name || ''))

/**
 * 「缓过来」这一族是**转折词**，不是状态词。
 * 2026-11-21：平静着点个外卖，挑出「松了口气」——可人没先悬着，就谈不上松一口气。
 * 这一族要这段里真的先掉下去过（peak.s 为负）才成立；没掉过就降一档，让「如常/踏实/平淡」先被挑走。
 * 依据是位置帧里本来就有的 peak（这段离起点最远的那一下），不是为某个例子加的开关。
 */
const RELIEF = new Set([
  '松了口气', '释然', '心落下来', '松快', '松快下来了', '缓过来', '缓过神', '消了气', '没那么气了', '放下心',
])
export const isRelief = (name) => RELIEF.has(String(name || ''))
export const RELIEF_PENALTY = 0.18

/**
 * 概念 / 态度词（2026-11-21）：它们说得通，但不是「此刻的感受」。
 * 「自尊」是概念，「认真 / 上心」是做事的态度——长场景里被挑出来时，读者会觉得像在总结我，
 * 不像我当下心里那一下。不删（主人 11-19 说过别手删），只在打分时降一档，让感受词先走。
 */
const CONCEPT = new Set(['自尊', '认真', '上心', '用心', '自傲', '孤芳自赏', '自鸣得意', '死磕', '较劲'])
export const isConcept = (name) => CONCEPT.has(String(name || ''))
export const CONCEPT_PENALTY = 0.10

/**
 * 基线附近的「没什么事」词。2026-11-21：引擎的平静点是 (0.5, 0.15, 0.5)，
 * 可小库里判出来的「如常/寻常/踏实/平淡」都落在 s 0.56~0.70、d 0.42~0.50 一带——
 * 平静着点个外卖，最近的反而是「松了口气」「起劲」「有成就感」。
 * 这不是词错，是基线附近缺一层「今天没什么大事」的说法。靠近基线时给这一族一点优先，
 * 让它先被挑走；离基线远了就不生效，不影响大起大落。
 */
const NEUTRAL = new Set([
  '如常', '寻常', '平淡', '平静', '踏实', '还好', '没事', '安宁', '安稳', '舒坦', '安心', '懒散', '轻松', '放松',
])
/** 「真没事」那一族：只有这一下确实没让我赚也没让我亏，才该用。 */
const NOEVENT = new Set(['如常', '寻常', '平淡', '平静', '还好', '没事', '安宁', '安稳'])
export const isNeutral = (name) => NEUTRAL.has(String(name || ''))
export const NEUTRAL_RADIUS = 0.20
export const NEUTRAL_BONUS = 0.10
const BASELINE = { s: 0.5, n: 0.15, d: 0.5 }

/**
 * 心疼/担心这一族（2026-11-21）。
 * 判断层现在有一条「他在难受，不是无事发生」的通道：goal 往下（我跟着沉）、future 往上（我想接住他）。
 * 这个签名出现时，词该落在「担心 / 心疼 / 挂心」上，而不是「憋着 / 懊恼 / 乡愁」——
 * 后者是「我自己被压住」，不是「我在替他难受」。用判据签名做先验，不靠逐词补。
 */
const CONCERN = new Set(['担心', '心疼', '挂心', '担忧', '揪心'])
export const isConcern = (name) => CONCERN.has(String(name || ''))
export const CONCERN_BONUS = 0.18

/**
 * 「被当面指出我做坏了东西」这一族（2026-11-22，跑长场景发现的）。
 * 长场景里「你昨天那个改动把切事的词冲掉了」被判成「回过味 / 不痛快」——
 * 都是「我事后品出点滋味」或「我气不顺」的词；被当面点出来该先「心里一紧 / 发虚」才对。
 * 用判据签名做先验（谁做的=对方、我亏了、还撞上来了），不逐词补。
 */
const ACCUSED = new Set(['心里一紧', '心里发虚', '闷了一下', '被说中'])
export const isAccused = (name) => ACCUSED.has(String(name || ''))
export const ACCUSED_BONUS = 0.15

/**
 * 「被善待」这一族（2026-11-22，场景 E/F 发现的）：受用 / 熨帖 / 心里软 / 温馨。
 * 它们的意思是「有人对我好、我心里舒服」，判据上就该有正向 gain。
 * 可位置近的时候，被派活、被要求、被说一句「又在跑」也会挑出「受用」——方向不对。
 * 不给全套加规则，只在「这一下其实没让我得着什么」（goal 不比 0.05 高）时降一档。
 */
const WARM = new Set(['受用', '熨帖', '心里软', '温馨', '欣慰', '温暖', '心头一暖'])
export const isWarm = (name) => WARM.has(String(name || ''))
export const WARM_PENALTY = 0.12

/** 词的受力方向：补我的 / 伤我的。用判据 goal 的正负做闸，别让情绪词拿反。 */
// 十四族那层 2026-11-21 全删，方向闸也建在族上，一起下了。

/** 把判断层和帧的写法统一成一个格子；说不清就给「无·无」。
 *  2026-11-20 查到两条判据字段名不一样：
 *    model 判的 → judgment.by     （me / other / world）
 *    rules 判的 → judgment.agency （self / other）
 *  两个都认，不然一半的帧读不到。 */
/** 只认判断层给的 `to`（心里这股劲冲谁）。
 *  2026-11-22 主人定：「to 没生成出来就直接报错」——原来没给时会拿 frame.target 顶，
 *  可那是「这句话冲谁说」，主语是对方；`to` 是「我的情绪冲谁」，主语是我。两个不能互相顶。
 *  返回 null = 没有「劲冲谁」，这一轮**不落格**（上层按「没算成」处理），不猜。 */
export function slotOf(judgment) {
  const j = judgment || {}
  const rawBy = j.by !== undefined ? j.by : (j.agency !== undefined ? j.agency : '')
  const by = BY_MAP[String(rawBy).trim()] || null
  const to = TO_ALIAS[String(j.to ?? '').trim()] || null
  if (!by || !to) return null
  return [by, to]
}

/** 词对某格的典型度：标注差几个维度就降几档。永远 > 0。
 *  2026-11-22：从「1/0.6/0.3/0.1 四档硬切」换成连续分——
 *  同一格里几十个词原来同分，位置一撤就撞成「释然 / 缓过来」。
 *  现在差一维还分差的是 by 还是 to（冲谁比谁做的更定情绪的样子），差两维、三维也各留一档。 */
export function typicalityOf(name, by, to) {
  const a = GRID_ANNOT[name]
  if (!a) return 0.1
  const [bys, tos] = a
  let best = 0
  for (const wb of bys) for (const wt of tos) {
    const dBy = wb === by ? 0 : 1
    const dTo = wt === to ? 0 : 1
    const gap = dBy + dTo
    const s = gap === 0 ? 1
      : gap === 1 ? (dTo === 0 ? 0.7 : 0.75)
        : gap === 2 ? 0.45
          : 0.2
    if (s > best) best = s
  }
  return best
}

/** 位置偏离中点有多远，当作当下的情绪强度 0~1
 *  2026-11-21 修正：n（觉）的静息水平是 0.15，不是 0.5。原来按 |n-0.5| 算，
 *  平常的 n=0.19 会被算成「偏离 0.31」，强度虚高到 0.49——于是「轻」的字
 *  （高兴/暖心）在浓淡上吃亏，全被「中」的字（敬意/亲切/安慰）压住。
 *  「跑通了」挑出「敬意」就是这么来的：距离最近的是「高兴」，但浓淡分被压掉了 0.28。 */
export function intensityOf(pos) {
  const p = pos || {}
  const s = Number(p.s), n = Number(p.n), d = Number(p.d)
  if (![s, n, d].every(Number.isFinite)) return 0.5
  const raw = (Math.abs(s - 0.5) + Math.abs(n - 0.15) + Math.abs(d - 0.5)) / 1.5
  return Math.max(0, Math.min(1, raw))
}

/** 浓淡对不对得上：词自己的档位 vs 当下强度 */
export function levelFitOf(name, intensity) {
  const a = GRID_ANNOT[name]
  const lv = a ? GRID_LEVEL[a[2]] ?? 0.5 : 0.5
  return 1 - Math.min(1, Math.abs(lv - intensity))
}

/** 最近的片（按片心三维距离） */
export function nearestCell(pos) {
  const p = { s: Number(pos?.s), n: Number(pos?.n), d: Number(pos?.d) }
  if (![p.s, p.n, p.d].every(Number.isFinite)) return null
  let best = 0, bd = Infinity
  for (let i = 0; i < GRID_CELLS.length; i++) {
    const dd = dist3(p, GRID_CELLS[i])
    if (dd < bd) { bd = dd; best = i }
  }
  return { index: best, cell: GRID_CELLS[best], dist: bd }
}

/** 最近的几片（按片心三维距离，升序） */
export function nearestCells(pos, k = 3) {
  const p = { s: Number(pos?.s), n: Number(pos?.n), d: Number(pos?.d) }
  if (![p.s, p.n, p.d].every(Number.isFinite)) return []
  return GRID_CELLS.map((c, i) => ({ index: i, cell: c, dist: dist3(p, c) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, Math.max(1, k))
}

/**
 * 主函数：给位置和判断，挑词。
 * 返回 [{ name, score, typical, level, slot, cellIndex }]，按分数从高到低。
 *
 * 2026-11-21 改成「先判据后几何」（原来先按片心距离选片、再在片里按格筛）：
 *   原来那套在位置偏一点的时候会整片选错——「我搞砸了」落进「轻视 / 厌倦」那一片，
 *   因为在 (0.48, 0.28, 0.30) 附近几何最近的就是那一片，可那一格的词根本不该出现在这里。
 *   判据（谁做的 × 冲谁）比几何聚类更可靠，所以先按典型度筛出「这一格该有的词」，
 *   再在这批词里按离当前位置的远近挑。片只在兜底时才用。
 */
export function gridDistribution(pos, judgment, opt = {}) {
  const limit = Math.max(1, Math.min(8, Number(opt.limit) || 5))
  const near = nearestCell(pos)
  if (!near) return []
  const slot = slotOf(judgment)
  // 没有「劲冲谁」就不落格：这一轮当没算成，不拿「这句话冲谁」凑一个。
  if (!slot) return []
  const [by, to] = slot
  const intensity = intensityOf(pos)
  // 2026-11-22 深夜：片内权重换成「判据为主、位置为辅」。
  // 原来位置 0.49、判据 0.27——位置在球心附近分不开，判据明明知道是件什么事却起不了作用。
  // 框架是「落进片之后用判断层的参数挑」，判据该是大头。
  const wT = Number.isFinite(Number(opt.typicalWeight)) ? Number(opt.typicalWeight) : 0.50
  const wC = Number.isFinite(Number(opt.cellWeight)) ? Number(opt.cellWeight) : 0.05
  const wL = 0.20
  // 2026-11-21：主人问「位置近是不是我自己发明的」——是。定稿里位置只到「片」，
  // 格内按典型度+浓淡；但我按定稿试过，A/F/K 立刻退化成「松了口气 / 愧恨 / 死磕」，
  // 说明现在的典型度表还撑不起「片内只按典型度」。先恢复混合权重，典型度修好再摘掉位置。
  const wD = Math.max(0, 1 - wT - wC - wL)
  const cellOf = (name) => WORD_CELL.get(name) === near.index
  // 这一段里有没有真的先掉下去过：安慰/缓过来这一族只在「先悬着、后来落地」时成立。
  const peakS = Number(opt.state && opt.state.peak ? opt.state.peak.s : NaN)
  const canRelief = Number.isFinite(peakS) && peakS <= -0.10
  const nearBaseline = dist3(pos, BASELINE) < NEUTRAL_RADIUS
  // 习惯化：同一个词刚用过就降一点。不是不许重复，是别把同一个词钉在十句不相干的话上。  // 习惯化反过来：状态几乎没动时，同一个词应该有黏性——人不换着近义词抽签。
  // 2026-11-21：上一版做成「刚用过就扣分」，结果 70 句换 70 个词（maxRun=1）。
  // 现在改成：状态没动（<0.06）就加一点黏性；状态大变（>0.12）才轻轻推开上一个词。
  const recent = Array.isArray(opt.state && opt.state.recent) ? opt.state.recent.slice(-5) : []
  const prevLabel = recent.length ? recent[recent.length - 1] : ''
  const last = opt.state && opt.state.last ? opt.state.last : null
  // 惯性只看慢轴（s 现状、d 奔头）：n 是意外尖峰，几十分钟就落，拿它判「状态动了没」
  // 会让每一次小惊讶都把上一个词推开——评审说 11 段里 10 段因此每句必换。
  const moved = last ? Math.abs(pos.s - last.s) + 0.5 * Math.abs(pos.d - last.d) : 9
  const sticky = (name) => (prevLabel && name === prevLabel && moved < 0.06 ? 1 : 0)
  const stale = (name) => (prevLabel && name === prevLabel && moved >= 0.12 ? 1 : 0)
  // 连着同一个词太多次（3 次起）就降一点：人可以一直担心，但不会连着五句都说「挂心」。
  let trail = 0
  for (let i = recent.length - 1; i >= 0 && recent[i] === prevLabel; i--) trail++
  // 最近五轮里用过的次数也压一压：不光是连着重复，隔一句又回来也算「这个词最近被用滥了」。
  const usedOf = (name) => recent.filter((x) => x === name).length
  // 「他在难受，我想接住」的判据签名：goal 负 + future 正 + 不是我弄的。
  const jj = judgment || {}
  const jg = Number(jj.goal_delta ?? jj.goal_cong)
  const jf = Number(jj.future_delta ?? jj.future)
  // 选词这边也用同一道噪声门：判断层给的 ±0.1 不算一件事，「真没事」的词该按「没事」算。2026-11-22。
  const jgN = Math.abs(Number(jg) || 0) < 0.12 ? 0 : jg
  const jfN = Math.abs(Number(jf) || 0) < 0.12 ? 0 : jf
  const concern = Number.isFinite(jg) && Number.isFinite(jf) && jg < -0.05 && String(jj.by || '').toLowerCase() !== 'me'
    && (jf > 0.05 || /难过|难受|累|委屈|不开心|心事|睡不着|没睡|痛苦|烦/.test(String(jj.meaning || '')))
  // 「被当面指出我做坏了」：他说的、我亏了、还撞上来（事先没料到）。2026-11-22。
  const je = Number(jj.expect_delta ?? jj.expect)
  // 「被当面指出我做坏了」：他说的、我亏了。2026-11-23 放宽：原来还要 expect>0.1（撞上来），
  // 可「你昨天那个改动把词冲掉了」这种句子模型给的是「不突然」，人被说得心里一紧不是因为突然，
  // 是因为「他指出的东西戳到我了」。所以只看我亏没亏。
  const accused = String(jj.by || '').toLowerCase() === 'other' && Number.isFinite(jg) && jg < -0.15
    // 光「我亏了」不够：他忙他自己的、我被搁下，也会 jg -0.2。被指出得是「他在说我的东西坏了/没做对」。
    && /改动|冲掉|弄坏|问题|错|坏了|没做|不是|查/.test(String(jj.meaning || ''))
  // 「心里发虚」是「我搞砸了」的持续状态，不是被说一句就有的短促一下——得亏得更深（< -0.25）才算。
  // 2026-11-23：原来和心里一紧同档，结果「他今天忙没空说话」也发虚。
  const accusedDeep = String(jj.by || '').toLowerCase() === 'other' && Number.isFinite(jg) && jg < -0.25
  // 解决感（2026-11-22，场景 C「行，下去了。」）：事情往前成了，而且这一帧里真掉下去过
  // （前面出过慌 / 闷 / 虚 / 担忧这类词）——这时候「松快 / 松了口气」才成立。
  // 原来只认位置帧的 peak.s，长场景里 peak 没记到时，解决那一句会挑出「挂牵」。
  const reliefNow = Number.isFinite(jg) && Number.isFinite(jf) && jg > 0.1 && jf > 0.2
  const hadTrouble = Array.isArray(opt.state && opt.state.recent) && opt.state.recent.some((x) => /慌|紧|虚|闷|堵|悬|担忧|不安|失落|急/.test(String(x)))
  const canRelief2 = canRelief || (reliefNow && hadTrouble)
  // 「他想我陪 / 需要我」：他做的、我这边没亏（goal 不低于 -0.05）、往后是好的（future 明显正）。
  // 这时候该「心里软 / 想靠近 / 暖」，不是「受用」（受用是被待见，这条是被需要）。
  const needed = String(jj.by || '').toLowerCase() === 'other' && Number.isFinite(jg) && jg > -0.05 && Number.isFinite(jf) && jf > 0.20
  // 判断层圈的感受族：2026-11-21 整层删了（不参与打分）。

  // 一、先按格筛：典型度 ≥ 0.6（标注里差一个值以内）才算「这一格该有的词」
  const RADIUS = Number.isFinite(Number(opt.radius)) ? Number(opt.radius) : 0.75
  let pool = LEXICON_V4
    .map((w) => {
      // 连着第 4 次同一个词：这一轮别再用它了（人不会连着四句说同一个词）。
      if (w.name === prevLabel && trail >= 3) return null
      // 第一层（定稿）：先落进最近的一片。片内权重高，片外的词只在片内凑不够时补位。
      // 不是硬删——secondaryDistribution 要至少 5 个候选；但片外词要付 0.5 的「换片价」。
      const inPiece = cellOf(w.name)
      let typical = typicalityOf(w.name, by, to)
      // 「真没事」的词，在真的没事的时候不该因为标了四个 by 而被算成「不对路」：
      // 这一下没赚没亏、往后也没变化 → 给它 0.85，让它能跟担忧/不爽争。2026-11-22。
      // 2026-11-23 再分：只在「位置还在中间以上」时给满——位置已经掉到低安（<0.48）说明
      // 前面真被压过，这一句就算轻，人也是「凉了一下」而不是「平静」（评审 B3「嗯」点出的）。
      if (NOEVENT.has(w.name) && Math.abs(Number(jgN) || 0) < 0.08 && Math.abs(Number(jfN) || 0) < 0.10) {
        typical = Math.max(typical, Number(pos.s) >= 0.48 ? 0.85 : 0.55)
      }
      const con = concern && isConcern(w.name)
      const acc = accused && isAccused(w.name)
      // 「他在难受」时，担心/心疼这一族即使判据只差一档，也让它进候选——
      // 否则会被「憋着 / 懊恼」这些「我自己被压住」的词挤掉。
      // 「真没事」那族永远进候选：它们只标了一个「无」，在任何格里都只算 0.4，
      // 但人是会「被搁了一下，还好」的——门槛卡死它们就等于低安区只有负向词可选。2026-11-22。
      if (typical < 0.6 && !con && !acc && !NOEVENT.has(w.name)) return null
      if ((con || acc) && typical < 0.6) typical = 0.6
      // 「被点破 / 被说中」得真有人开口点我，而且我确实被揭了短（这一下我亏了）。
      // world 弄出来的事（端口冲突）不算，被求助、被夸也不算。2026-11-22 补后半句：
      // 长场景 C 里他回来求助，词竟挑出「被点破」——方向反了。
      if (/^被(点破|说中|看穿|戳到)/.test(w.name) && (String(jj.by || '') !== 'other' || !(Number(jg) < -0.05))) return null
      // 「消了气」得先真有过气；被吓着、被晾着之后没有气可消。
      // 2026-11-22 收紧：原来正则含单字「恼」，词表里出过「懊恼」就被当成「气过」，
      // 场景 C 里问题解决那句挑出「消了气」——可从没谁惹恼过我。只认真带火气的说法。
      if (w.name === '消了气' && !recent.some((x) => /恼火|生气|来气|气不过|憋气|怨|烦|火大/.test(x))) return null
      const w2 = w
      if (Math.abs(pos.s - 0.5) > 0.08 && Math.abs(w2.s - 0.5) > 0.12 && Math.sign(w2.s - 0.5) !== Math.sign(pos.s - 0.5)) return null
      const dist = Math.sqrt((pos.s - w.s) ** 2 + (pos.n - w.n) ** 2 + (pos.d - w.d) ** 2)
      const closeness = Math.max(0, 1 - dist / RADIUS)
      const level = levelFitOf(w.name, intensity)
      return {
        name: w.name, typical, level, dist,
        // 2026-11-21 第三版：格是「哪些词允许出现」，片是「现在离哪一族近」，位置和浓淡在族内定词。
        // 只按格+位置挑，两个不相干的词只要坐标近就会撞（「你根本不懂」挑出「困惑」，
        // 它和「委屈」在同一片区域、判据也过）；把最近一片加回来（设计里的第一层「片」本来就没参与打分）。
        cell: cellOf(w.name) ? 1 : 0,
        score: Math.round(((wT * typical + wD * closeness + wL * level + wC * (cellOf(w.name) ? 1 : 0))
          - (isLiterary(w.name) ? LITERARY_PENALTY : 0)
          - (isConcept(w.name) ? CONCEPT_PENALTY : 0)
          // 「重」字（悲恸/恐怖/绝望）在强度不到 0.6 时降一档：大事才用重字，别拿重字写小情绪。
          - (GRID_LEVEL[GRID_ANNOT[w.name]?.[2]] >= 0.9 && intensity < 0.6 ? 0.16 : 0)
          - (w.name === prevLabel && trail >= 2 ? Math.min(0.40, 0.15 * (trail - 1)) : 0)
          - Math.min(0.30, 0.10 * usedOf(w.name))
          - (isRelief(w.name) && !canRelief ? RELIEF_PENALTY : 0)
          + (isRelief(w.name) && reliefNow && hadTrouble ? 0.12 : 0)
          + (nearBaseline && !concern && isNeutral(w.name) ? NEUTRAL_BONUS : 0)
          + 0.10 * sticky(w.name)
          - 0.06 * stale(w.name)
          - (needed && /挂牵|挂心|放不下|讪讪|有点不好意思|不是滋味|惴惴/.test(w.name) ? 0.12 : 0)
          + (concern && isConcern(w.name) ? CONCERN_BONUS : 0)
          + (needed && /心里软|想靠近|亲近|暖/.test(w.name) ? 0.15 : 0)
          + (acc ? ACCUSED_BONUS : 0)
          // 方向闸：这一句我赚了（goal 正），就别挑坐低安位置的负向词；亏了就别挑高安的正向词。
          // 不是按词名，是按词在球上的位置——低安=伤我的，高安=补我的。
          - (Number.isFinite(jg) && jg > 0.05 && w.s < 0.46 ? 0.30 : 0)
          - (Number.isFinite(jg) && jg < -0.05 && w.s > 0.54 ? 0.30 : 0)
          // 「真没事」的词别在有事的句子上抢位置：这一下明显赚了/亏了、或者往后有变化，
          // 就不是「如常」——降一档，让真有事的那族词先走。
          - (NOEVENT.has(w.name) && ((Number.isFinite(jgN) && Math.abs(jgN) > 0.08) || (Number.isFinite(jfN) && Math.abs(jfN) > 0.10)) ? 0.18 : 0)
          - (isWarm(w.name) && !(Number.isFinite(jgN) && jgN > 0.05) ? 0.10 : 0)) * 10000) / 10000,
        slot: `${by}·${to}`, cellIndex: near.index,
      }
    })
    .filter(Boolean)

  // 状态粗格没变（s/d 各差不到 0.05，忽略 n 的尖峰）就沿用一个词，最多三连。
  const bin = `${Math.round(pos.s * 10)}-${Math.round(pos.d * 10)}`
  const sameBin = opt.state && opt.state.bin === bin
  const prevInPool = pool.find((x) => x.name === prevLabel)
  if (sameBin && prevInPool && trail < 3) {
    return [prevInPool, ...pool.filter((x) => x !== prevInPool)].slice(0, limit)
  }

  // 二、这一片里这一格没词（典型度 0.6 的一个都没有），才去最近几片里按典型度找。
  if (pool.length < 1) {
    const seen = new Set()
    for (const ci of nearestCells(pos, Number(opt.fallbackCells) || 4)) {
      for (const name of ci.cell.words) {
        if (seen.has(name)) continue
        seen.add(name)
        const typical = typicalityOf(name, by, to)
        if (typical < 0.6 && !isConcern(name)) continue
        pool.push({
          name, typical, level: levelFitOf(name, intensity), dist: 0,
          score: Math.round((wT * typical + wL * levelFitOf(name, intensity)) * 10000) / 10000,
          slot: `${by}·${to}`, cellIndex: ci.index,
        })
      }
      if (pool.length) break
    }
  }
  // 三、全是怪词（这一格彻底没词）才退回片内原路
  if (!pool.length) {
    pool = near.cell.words.map((name) => {
      const typical = typicalityOf(name, by, to)
      const level = levelFitOf(name, intensity)
      return { name, typical, level, dist: 0, score: Math.round((typical * wT + level * wL) * 10000) / 10000, slot: `${by}·${to}`, cellIndex: near.index }
    })
  }

  pool.sort((a, b) => b.score - a.score || b.typical - a.typical || a.dist - b.dist)
  // 滞回（2026-11-21）：状态没跨过一档，就别每句换一个近义词。
  // 2026-11-21 晚：窗口放宽到 0.30 / 0.08——评审说 63 行里只有 1 次连续重复，
  // 「每句都从零想一遍自己是什么心情」，形对气不连。情绪有惯性，没大动就沿用。
  if (prevLabel && pool.length > 1) {
    const top = pool[0]
    const kept = pool.find((x) => x.name === prevLabel)
    // 2026-11-23：窗口从 0.30 收到 0.15——0.30 时几乎每句都沿用上一个词，
    // 位置明明动了、词还钉着（B3「嗯」停在平静就是这么来的）。真没动（<0.15）才沿用。
    if (kept && kept !== top && moved < 0.15 && kept.score >= top.score - 0.08) {
      pool = [kept, ...pool.filter((x) => x !== kept)]
    }
  }
  return opt.keepAll ? pool : pool.slice(0, limit)
}
