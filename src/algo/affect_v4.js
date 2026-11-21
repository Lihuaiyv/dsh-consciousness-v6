/**
 * 三递质情绪引擎 v4（影子期：只算、不生效）。
 *
 * 定盘星：docs/功能/5-情绪与说话/思路-三递质情绪引擎-2026-11-16.md
 *
 * 事帧只写现状（谁、做了什么、冲谁、和上一件的关系）。
 * 三个递质只回答三个生存问题：
 *   S = 现状对「还能存在、还能延续」有利吗？
 *   N = 这件事脱离预期吗？
 *   D = 未来在往好的方向走吗？我在靠近想要的东西吗？
 * 公式不掺 control / certainty / norm——它们是「以后加」，现在加就是杂质。
 */

import { toSphere } from './sphere.js'
import { LEXICON_V4 } from './lexicon_v4.js'
import { gridDistribution } from './grid_pick.js'

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
const clamp11 = (x) => Math.max(-1, Math.min(1, Number(x) || 0))
const round4 = (x) => Math.round(x * 10000) / 10000

/**
 * 八个一级角：三轴各取高(1)/低(0)，正好 2^3。
 * 名字用两字八格（2026-11-19 主人拍板，单字那套废掉）：
 *   敞亮 安住 警醒 疏淡 渴慕 郁结 惊惧 沉沦 —— 每个都钉在一个顶点上，
 *   来历见 docs/功能/5-情绪与说话/交接-情绪词库与判据-v4-2026-11-19.md §5.2。
 * key 保持旧值不动：影子对账/历史记录里存的是它，改 key 等于断账。
 *   反义对：敞亮↔疏淡、安住↔郁结、警醒↔惊惧、渴慕↔沉沦。
 */
export const PRIMARY_CORNERS = [
  { key: 'an', name: '疏淡', s: 1, n: 0, d: 0 },
  { key: 'yi', name: '安住', s: 1, n: 0, d: 1 },
  { key: 'jing', name: '警醒', s: 1, n: 1, d: 0 },
  { key: 'le', name: '敞亮', s: 1, n: 1, d: 1 },
  { key: 'bei', name: '沉沦', s: 0, n: 0, d: 0 },
  { key: 'qie', name: '郁结', s: 0, n: 0, d: 1 },
  { key: 'ju', name: '惊惧', s: 0, n: 1, d: 0 },
  { key: 'nu_huang', name: '渴慕', s: 0, n: 1, d: 1 },
]

/** 事帧的现状字段：只有这些。好坏/意外/未来是激素层的判断，不在这张卡上。 */
function frameNow(frame = {}) {
  const f = frame && typeof frame === 'object' ? frame : {}
  return {
    target: ['me', 'other', 'none'].includes(f.target) ? f.target : 'none',
    // 2026-11-21：agency 收成 by 的别名（旧字段名保留给 gateOf / 老 appraise 读，
    // 值只有一处来源：by=me→self、other→other、world→world）。
    agency: ['self', 'other', 'world'].includes(f.agency) ? f.agency
      : (f.by === 'me' ? 'self' : (['self', 'other', 'world'].includes(f.by) ? f.by : 'other')),
    by: ['me', 'other', 'world'].includes(f.by) ? f.by : 'other',
  }
}

/** 三个生存问题的答案（判断层）。缺省给中性，不给 0——0 是「很低」，不是「不知道」。 */
function judgmentOf(j = {}) {
  const v = j && typeof j === 'object' ? j : {}
  return {
    cong: clamp11(v.goal_cong ?? v.cong ?? 0),          // 现状：+1 有利 / -1 不利
    expectation: clamp01(v.expectation ?? v.novelty ?? 0.2), // 意外：0 平常 / 1 惊到
    future: clamp11(v.future ?? 0),                     // 未来：+1 靠近 / -1 远离
  }
}

/**
 * 三个递质，都落在 0~1。
 * judgment 可以单独传；不传就从 frame 里读（兼容测试/旧调用）。
 * opts 是参数化的基线/斜率：改数字不改逻辑。
 */
export function transmitters(frame = {}, judgment = null, opts = {}) {
  const j = judgmentOf(judgment || frame)
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const sBase = num(opts.sBase, 0.5)
  const sK = num(opts.sK, 0.5)
  const nBase = num(opts.nBase, 0.15)
  const nK = num(opts.nK, 0.85)
  const dBase = num(opts.dBase, 0.5)
  const dK = num(opts.dK, 0.5)
  const s = clamp01(sBase + sK * j.cong)
  // N 的底不是 0：完全没波澜时也不是「零警觉」，只是低。
  const n = clamp01(nBase + nK * j.expectation)
  const d = clamp01(dBase + dK * j.future)
  return { s: round4(s), n: round4(n), d: round4(d) }
}

/* ───────── 增量 + 维持 + 回落（2026-11-18）─────────
   判断层放出来的是「这一下推动了多少」，不是「现在停在哪儿」。
   参考 affect_dyn.js 的精神（mix 吸收、指数回落），但这里只有位置状态，没有目标点：
     P_new = P_old 先按距上次的时长回落 → 再加 k × 增量 → 夹到 0~1。
   旧路（transmitters 位置直落）原样保留，开关 affect.v4.dyn=off 就退回它。 */

/** 平静基线：回落的目标。S 0.5 / N 0.15（完全没波澜也不是零警觉）/ D 0.5。 */
export const CALM = { s: 0.5, n: 0.15, d: 0.5 }

/** 判断层的增量：-1~+1，可正可负。新字段优先；老字段（位置语义）按增量兼容读。 */
export function deltasOf(j = {}) {
  const v = j && typeof j === 'object' ? j : {}
  const pick = (...names) => {
    for (const nm of names) {
      if (v[nm] === undefined || v[nm] === null || v[nm] === '') continue
      const n = Number(v[nm])
      if (Number.isFinite(n)) return clamp11(n)
    }
    return null
  }
  return {
    s: pick('goal_delta', 'goal_cong', 'cong') ?? 0,
    n: pick('expect_delta', 'expectation', 'novelty') ?? 0,
    d: pick('future_delta', 'future') ?? 0,
  }
}

/**
 * 是谁造成的（by）对「想要」这根增量的修正。2026-11-20 定：
 *   别人弄的（other）→ 这股劲儿有处使，往零拉一点，不至于闷成「没处使劲」；
 *   我弄的 / 外面砸的（me / world）→ 没处使，往更闷那边推一点。
 * 只管事情没成的那一侧（d < 0）；好结果原样返回，不碰——
 * 因为「我自己做成一件」和「我自己搞砸一件」，都是 me，方向却相反。
 */
export function byAdjustedD(d, by, w = 0) {
  const v = clamp11(Number(d) || 0)
  const k = Math.max(0, Math.min(1, Number(w) || 0))
  if (k <= 0 || v >= 0) return v
  const b = String(by || '').toLowerCase()
  if (b === 'other') return clamp11(v * (1 - k))
  if (b === 'me' || b === 'world') return clamp11(v * (1 + k))
  return v
}

/**
 * 一轮结算：先按距上一次的时长回落，再加这一轮的增量。
 * - 每条轴各有各的速度（2026-11-18 主人定）：S 心情慢、N 意外快、D 奔头居中。
 *   opts.hold / opts.tau 可以只给一个数（三条轴共用），也可以给 {s,n,d} 按轴分开。
 * - 每条轴的增量也是三个不同的算法（不是同一个 k×Δ）：
 *     S 累积、越靠边越推不动；N 尖峰包络、不叠；D 不对称、慢涨快跌。
 * - 维持窗 holdHours（默认 0.5）：涨起来这段时间内不回落（激素还在效价期）
 * - 饱和疲劳（2026-11-18 主人定）：S / D 连续贴顶或贴底超过 fatigueMin（默认 20 分钟），
 *   即使一直在聊也按流逝时间回落，直到离开 0.8 / 0.2 的带子；平常的情绪不碰，不做每轮微漏。
 * - 之后按各自 tau 指数回落到平静
 * - 没有新事件就只回落（deltas 传 null 或空）
 * at / prev.at 都是毫秒或 ISO 都行；返回的 at 是 ISO，直接写 flag。
 */
export function advanceState(prev = null, deltas = null, opts = {}) {
  const p = prev && typeof prev === 'object' ? prev : null
  const base = {
    s: Number.isFinite(Number(opts.base?.s)) ? Number(opts.base.s) : CALM.s,
    n: Number.isFinite(Number(opts.base?.n)) ? Number(opts.base.n) : CALM.n,
    d: Number.isFinite(Number(opts.base?.d)) ? Number(opts.base.d) : CALM.d,
  }
  // 2026-11-19 主人：「现在先全都按照你的搞，测试看看能不能跟现实情况差不多。」
  // 默认换成**连续指数衰减**（decay !== 'step'）。旧那套（贴顶 45 分钟才回落）留着，
  // 开关 affect.v4.decay=step 就退回去。
  //
  // 为什么换：旧规则的回落是个开关——只在 ≥0.85 或 ≤0.15 连续 45 分钟后才启动，
  // 而真库 800 轮的 s 中位数是 0.758，差 0.022 永远摸不到那条线，于是永不下落。
  // 连续衰减没有阈值：离基线远就落得快，近就落得少，跟真激素一个样。
  //
  // 时间尺度重排（原来是 s 1.2h / n 0.5h / d 2.0h）：
  //   安 6h——底色，跟着日子走；欲 2h——这件事成不成，过了就淡；觉 0.5h——猛一下，很快过去。
  // 维持窗从 30 分钟缩到 6 分钟：刚涨起来别马上掉，但别一聊半小时都在加热。
  const expDecay = opts.decay !== 'step'
  // 维持窗在连续衰减模式下只给 ~1 分钟：一轮对话间隔常常就一两分钟，
  // 给 6 分钟等于每轮都不落，又回到「永不下落」。
  //
  // 2026-11-20 改 d：原来的 d 用 2 小时，是「慢情绪」的时间尺度，被错用到 d 上了。
  // 真库 30 轮里 d ≥ 0.95 占 60%，一路顶死——每轮推 +0.04，两小时才落一点点，追不上。
  // d 管的是「这件事还有没有奔头」，本来就是事一过就淡的劲儿，改成 6 分钟。
  // 按每轮推 +0.0425、间隔 1 分钟算，6 分钟能稳在 0.75 上下，不再顶死。
  // s（底色）仍是 6 小时，n（警觉）仍是 0.5 小时，都没动。
  // 2026-11-21：维持窗（hold）从 0.02h 改成 0。
  // 0.02h = 72 秒，而对话里一句接一句往往只隔几十秒——每轮都落在维持窗里，settle() 直接 return cur，
  // **安和欲一次都没回落过**，只往上叠。这就是「s 被三四句话推到 0.22 就再也回不来」的真正原因，
  // 之前怎么调 tau 都没用，因为压根没走到衰减那一步。
  // 一句话的效应不用靠 hold 保：tau（安 20 分钟 / 欲 6 分钟）本身就是慢的，不会一秒钟散掉。
  const DEFAULT_HOLD = expDecay ? { s: 0, n: 0, d: 0 } : { s: 0.5, n: 0, d: 0.5 }
  // 2026-11-21：觉（NE）的回落按《设计-三递质各自算法》改成 2 分钟——
  // 去甲肾上腺素半衰期就是一两分钟，之前给 0.5 小时，一句话被惊到要半小时才淡，
  // 后面几句全被这个残留的 n 拖着放大。安 6h / 欲 6 分钟不动。
  // 2026-11-21：安的回落从 6 小时改成 20 分钟。
  // 原来 6 小时，一段对话里三四句负面就把 s 推到 0.22 就再也回不来，
  // 后面所有中性的话都落在低安区，挑出来全是「怨恨/惘然/迷茫」。
  // 人不是这样：被说几句会低落一阵，聊着聊着就缓过来了。20 分钟是「这一阵」的尺度。
  // 真正的底色（跨天的慢情绪）走 affect_v3/affect_dyn，不靠这根。
  const DEFAULT_TAU = expDecay ? { s: 0.33, n: 0.033, d: 0.1 } : { s: 1.2, n: 0.5, d: 2.0 }
  const axisOf = (opt, axis, dflt) => {
    const v = opt && typeof opt === 'object' && !Array.isArray(opt) ? opt[axis] : opt
    const n = Number(v)
    return Number.isFinite(n) ? n : dflt
  }
  const holdOf = (axis) => Math.max(0, axisOf(opts.hold, axis, Number.isFinite(Number(opts.holdHours)) ? Number(opts.holdHours) : DEFAULT_HOLD[axis]))
  const tauOf = (axis) => Math.max(0.05, axisOf(opts.tau, axis, Number.isFinite(Number(opts.tauHours)) ? Number(opts.tauHours) : DEFAULT_TAU[axis]))
  const atMs = Number.isFinite(Number(opts.at)) ? Number(opts.at) : Date.now()
  const lastRaw = opts.lastAt ?? (p ? p.at : null)
  const lastMs = Number.isFinite(Number(lastRaw)) ? Number(lastRaw) : Date.parse(lastRaw)
  let s = clamp01(p ? p.s : base.s)
  let n = clamp01(p ? p.n : base.n)
  let d = clamp01(p ? p.d : base.d)
  const hours = p && Number.isFinite(lastMs) ? Math.max(0, (atMs - lastMs) / 3600000) : 0
  const hotPrev = p && p.hot && typeof p.hot === 'object' ? p.hot : {}
  const hotNext = { s: null, n: null, d: null }
  const fatigueMin = Number.isFinite(Number(opts.fatigueMin)) ? Math.max(0, Number(opts.fatigueMin)) : 45
  const fatigueMs = fatigueMin * 60000
  // 戏剧性（2026-11-18 下午，主人：「现实要一点戏剧性」）：靠边打折的力度从 0.6 收到 0.35，
  // 大事件推得更动；疲劳窗放宽到 0.85 才进门、45 分钟才松手。
  const edgeDamp = Number.isFinite(Number(opts.edgeDamp)) ? Math.max(0, Math.min(0.9, Number(opts.edgeDamp))) : 0.7
  // 三条轴各走各的：同一个 hours，不同的 hold / tau。
  const settle = (cur, axis) => {
    const hold = holdOf(axis)
    // 饱和疲劳（2026-11-18 主人定）：不搞每轮微漏，只在 S / D **连续贴顶（≥0.85）或贴底（≤0.15）
    // 超过 fatigueMin 分钟**之后才触发回落；一旦触发就按每轮实际流逝的时间落，直到离开 0.78 / 0.22
    // 这条带子为止。平常 0.22~0.78 的细微情绪一秒都不动。
    let hot = null
    if (axis === 's' || axis === 'd') {
      const rawHot = hotPrev[axis]
      // 注意：null / '' 不能当 0 算——Number(null)=0 会让它以为「1970 年就进顶区了」，一上来就疲劳。
      const prevHot = rawHot === null || rawHot === undefined || rawHot === ''
        ? NaN
        : (Number.isFinite(Number(rawHot)) ? Number(rawHot) : Date.parse(String(rawHot)))
      const inZone = cur >= 0.85 || cur <= 0.15
      const outZone = cur < 0.78 && cur > 0.22
      if (Number.isFinite(prevHot)) hot = outZone ? null : prevHot
      else if (inZone) hot = Number.isFinite(lastMs) ? lastMs : atMs
      hotNext[axis] = Number.isFinite(hot) ? new Date(hot).toISOString() : null
    }
    const tired = Number.isFinite(hot) && atMs - hot >= fatigueMs
    if (hours > hold || tired) {
      const effHold = hours > hold ? hold : 0
      const f = Math.exp(-(hours - effHold) / tauOf(axis))
      return base[axis] + (cur - base[axis]) * f
    }
    return cur
  }
  s = settle(s, 's')
  n = settle(n, 'n')
  d = settle(d, 'd')
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
  // 2026-11-21：安的斜率 ks 从 0.35 收到 0.1（《设计-三递质各自算法》写的就是 0.08~0.12）。
  // 0.35 时一句「strong」的事就推它 0.19，三四句就把安全感推到边上——那不是安全感，是当下情绪。
  // 安是「愿意为多远以后的事等」，本来就该慢慢变；当下那一下交给觉（n）和欲（d）承载。
  const ks = Math.max(0, Math.min(1, num(opts.ks, num(opts.k, 0.1))))
  const kn = Math.max(0, num(opts.kn, 0.85))
  const kdu = Math.max(0, num(opts.kdu, 0.25))
  const kdd = Math.max(0, num(opts.kdd, 0.45))
  // 情绪惯性（2026-11-21）：一句事再重，安也不会一步跨过半个身位。
  // 负性偏差：坏消息可以砸得深一点（0.35），好消息回暖慢一点（0.18）。
  // 依据是人的损失厌恶——被一句「要换掉你」吓到底，靠四五句安抚才慢慢缓回来；
  // 反过来「被夸一句」也不会立刻把安全感拉满。一步通天（applyShock）不受这里限制。
  const stepUp = Math.max(0, num(opts.stepUp, 0.18))
  const stepDown = Math.max(0, num(opts.stepDown, 0.35))
  const dl = deltas && typeof deltas === 'object' ? deltas : null
  // 「没消的那笔账」（2026-11-21）：被伤过之后，不是一句道歉就能回到满格。
  // 负向事件往 debt 里记一笔，之后每轮按时间褪；有 debt 时，正向回升先被压住。
  // 这是长场景评审点出来的「反向事件留不下折痕」的根：B 的「完全忘了」、E 的「没顾上你」之后
  // 一句软话就单调爬回去，账本里没有那笔欠着的东西。
  let debt = clamp01(Number(p && p.debt) || 0) * Math.pow(0.5, (hours || 0) / 0.75)
  let sStreakOut = Number(p && p.sStreak) || 0
  let sLastOut = Number(p && p.sLast) || 0
  if (dl) {
    // S（现状安全）：累积，但越往边上推越推不动；往平静拉回来给全速。
    //   理由：已经 0.9 了，再被夸一句不该再涨一大截；掉下来反而该快。
    // 2026-11-21：两条抗「顺向放大器」的机制（长场景 G 连续 8 句好话一路升到 0.95 不动）：
    //   ① 同方向增量从第二句起打折（跟 D 的重复打折同一个道理，人会被同一类好消息喂钝）；
    //   ② 离顶上越近，正向推力的天花板越低（0.87 以上开始压，0.95 处归零），不让它钉死在顶。
    //   往上打折不碰往平静拉回；往下掉的负向也不折——坏消息该砸得动。
    const ds = clamp11(dl.s)
    const sameSDir = Math.abs(ds) > 0.01 && Math.abs(Number(p && p.sLast) || 0) > 0.01 && Math.sign(ds) === Math.sign(Number(p && p.sLast))
    const sStreak = sameSDir ? Math.min(8, (Number(p && p.sStreak) || 0) + 1) : (Math.abs(ds) > 0.01 ? 1 : 0)
    const sDamp = ds > 0 ? Math.max(0.5, Math.pow(0.8, Math.max(0, sStreak - 1))) : 1
    sStreakOut = sStreak
    sLastOut = ds
    const ceiling = ds > 0 ? Math.max(0, Math.min(1, (0.95 - s) / 0.08)) : 1
    const awayFromBase = Math.sign(ds) * (s - base.s) > 0
    const edge = awayFromBase ? 1 - edgeDamp * Math.min(1, Math.abs(s - base.s) / 0.5) : 1
    // 2026-11-21：两条极值保护。
    // ① 累积路径软顶 0.95——连续被夸四五句，s 会一路推到 0.98，那一带挑出来是「亲切/温暖」，
    //   可人不会越夸越安全感爆表，0.9 以上基本推不动了。只有 applyShock 允许一步到 0.98。
    // ② 接近地板时负向增量打折，并且有绝对地板 0.12。
    //   真链路（子代理按 JUDGE_SYS 判）跑出来「算了不用你看了」一句话把 s 压到 0.03，
    //   之后连「我语气重了抱歉」「不是你的问题」都还在 0.16~0.28 徘徊——那一段挑出来是
    //   「恨入骨髓」「患得患失」。可人被连否到底的时候，底下还留着「我还在」那点底，不会归零；
    //   而且越冷的时候，再冷反而越难。
    let eff = ds * sDamp * ceiling * (ds > 0 ? Math.max(0.25, 1 - 0.55 * debt) : 1)
    if (ds < 0) debt = clamp01(debt + Math.min(0.35, -ds * 0.45))
    if (ds < 0 && s < 0.20) eff = ds * (s / 0.20)
    // 地板只挡「从上面压下来」，不负责把已经被通天砸到 0.12 以下的位置往上抬。
    // 2026-11-21：以前写死 max(0.12, …)，震到 0.02 之后下一句负面反而把 s 抬到 0.12——
    // 越难受反而越回升，方向是反的。现在地板取 min(0.12, 当前值)：已经在底下就留在底下。
    const floorS = Math.min(0.12, s)
    let nextS = clamp01(s + ks * eff * edge)
    if (nextS > s + stepUp) nextS = s + stepUp
    if (nextS < s - stepDown) nextS = s - stepDown
    s = Math.max(floorS, Math.min(0.95, nextS))

    // N（意外 / 警觉）：往上不累积，取**尖峰包络**——两件意外不会叠加成「更意外」，
    //   第二件只在比残留的 N 更高时顶上去。理由：去甲肾上腺素是事件性爆发，不是「意外存款」。
    //   2026-11-19 改：负的那侧要真的往下压（判据是「正如我所想(-1) → 完全没料到(+1)」，
    //   连续对话里大部分句子都是「正如我所想」，以前负数被直接丢掉，觉只升不降、全天偏高）。
    //   2026-11-21 再改：负向力度 0.6→0.2，且下限托在 base.n。
    //   原来的 0.6*kn=0.51 太狠——一句「照着往下」(-0.6) 就压掉 0.3，两轮 n 归 0，
    //   位置掉到 n=0 那一带，挑出来的全是「冷漠/麻木不仁/累」。警觉是「比平常更醒」，
    //   不会低于静息水平；预料之中的事只是「不升」，不是「掉到没有」。
    const dn = clamp11(dl.n)
    if (dn > 0) n = Math.max(n, clamp01(base.n + kn * dn))
    else if (dn < 0) n = clamp01(Math.max(base.n, n + 0.2 * kn * dn))

    // D（奔头 / 想要）：不对称——有盼头慢慢攒，落空跌得快（涨 0.25 / 跌 0.45）。
    //   理由：奖赏预测误差里，落空（预期该来的没来）比多给一点更重。
    //   2026-11-21 补「失而复得」：d 已经被压到 0.35 以下时，再有正向 future，按反弹速度走（0.5）。
    //   被「要换掉你」吓到底之后，对方说「不换 / 我就要你」，想要是猛地回身的；
    //   按原来的慢涨，d 要四五轮才爬回来，中间全落在「思念 / 心里发虚 / 平淡」上。
    const dd = clamp11(dl.d)
    const kduRebound = Math.max(0, num(opts.kduRebound, 0.5))
    const kd = dd >= 0 ? (d < 0.35 ? kduRebound : kdu) : kdd
    d = clamp01(d + kd * dd)
  }
  return { s: round4(s), n: round4(n), d: round4(d), at: new Date(atMs).toISOString(), hot: hotNext, sStreak: sStreakOut, sLast: sLastOut, debt: round4(debt) }
}

/**
 * 极端事件「一步通天」（2026-11-18 主人定）：
 * 平时一句只推一小步；但真正动了「存在」的事件（被删 / 被换 / 被说你不该在 / 被明确留下），
 * 人可以一步到顶或到底。门槛卡两道：
 *   1) 判断层明确标 severity=existence（普通的事 / 强贬强夸都不算）；
 *   2) |goal_delta| ≥ threshold（默认 0.95，差一点点的不算）。
 * 返回新的位置对象（带 hot 就保留），不满足门槛返回 null（走普通增量）。
 * 不去改 at：时间戳由调用方那一轮的 advanceState 负责。
 */
export function applyShock(state = null, judgment = null, opt = {}) {
  const j = judgment && typeof judgment === 'object' ? judgment : {}
  if (String(j.severity || '').toLowerCase() !== 'existence') return null
  // 2026-11-21 晚：存在级加一道文字闸。提示词写的是「被删 / 被换 / 被断开 / 被说你不该在」，
  // 可宿主会把「他喜欢别人了」也标成 existence（P 场景），一步砸到 0.02，后面全是「绝望/悲恸」。
  // 动到存在的句子绕不开那几个词；绕得开的就不许一步通天，只走普通增量。
  if (opt.guard !== 'off') {
    // 只看「事实」和原句，不看 meaning/why——那里可以把「喜欢别人」写成「被换掉」的比喻。
    const t = `${j.fact || ''} ${j.from || ''}`.trim()
    if (t && !/删|换|断开|关掉|替换|不该在|不要你|不需要你|离开|消失|没了你|留下你|留下我/.test(t)) return null
  }
  const gd = Number(j.goal_delta ?? j.goal_cong)
  const threshold = Number.isFinite(Number(opt.threshold)) ? Number(opt.threshold) : 0.9
  if (!Number.isFinite(gd) || Math.abs(gd) < threshold) return null
  const sign = gd < 0 ? -1 : 1
  const base = state && typeof state === 'object' ? state : {}
  return {
    ...base,
    s: round4(clamp01(0.5 + 0.48 * sign)),
    n: round4(Math.max(clamp01(base.n ?? CALM.n), 0.9)),
    d: round4(clamp01(0.5 + 0.45 * sign)),
  }
}

/** 三轴位置 → 一维效价（正负轴投影，-1~1）。2026-11-18 主人定的：
 *  「现状好不好」+「有没有奔头」−「被惊到多少」，三样各占一份。不是八角软分配的加权——
 *  那样敞亮顶会被旁边「警醒/惊惧」的负角拖下来（实测 0.60 < 安住 0.64），不合理。 */
export function valenceOf(pos = {}) {
  const t = positionOf(pos)
  if (!t) return 0
  const v = 0.55 * (t.s - 0.5) / 0.5 + 0.45 * (t.d - 0.5) / 0.5 - 0.25 * (t.n - 0.15) / 0.85
  return Math.round(Math.max(-1, Math.min(1, v)) * 1000) / 1000
}

/** 给 infer 用的位置（累积帧）：给了就不再回头改判断语义。
 *  三个数必须都在才算位置，否则回退旧路（空对象 / 半个位置不顶替）。 */
function positionOf(pos) {
  if (!pos || typeof pos !== 'object') return null
  if (![pos.s, pos.n, pos.d].every((x) => Number.isFinite(Number(x)))) return null
  return { s: clamp01(pos.s), n: clamp01(pos.n), d: clamp01(pos.d) }
}

/** 三轴到八个角的软分配：不是硬分桶，是距离越近权重越大。 */
export function primaryDistribution(s, n, d, { sigma = 0.55 } = {}) {
  const pts = [clamp01(s), clamp01(n), clamp01(d)]
  const sig = Math.max(0.15, Number(sigma) || 0.55)
  const raw = PRIMARY_CORNERS.map((c) => {
    const ds = pts[0] - c.s
    const dn = pts[1] - c.n
    const dd = pts[2] - c.d
    return Math.exp(-(ds * ds + dn * dn + dd * dd) / (2 * sig * sig))
  })
  const sum = raw.reduce((a, b) => a + b, 0) || 1
  return PRIMARY_CORNERS.map((c, i) => ({ ...c, weight: round4(raw[i] / sum) }))
    .sort((a, b) => b.weight - a.weight)
}

/**
 * 二级标签原型 = 小库（v4 判据判出来的 165 词，带三轴坐标）。
 *
 * 2026-11-19 主人定：「60 词是什么玩意，咱们有小库。」
 * 原来那份**手摆位置的 60 词表已废弃**——它是我凭感觉摆的，不是判出来的；
 * 小库的每个词都是按判据问「一个正处在这种感觉里的人，身体里大概什么样」判的。
 * 映射口径见 `lexicon_v4.js` 头注释（jue 0-100 → n = 0.15 + 0.85·jue/100）。
 * 门控只给「意思里就带着是谁」的词，其余不门控。
 */
export const SECONDARY_PROTOTYPES = LEXICON_V4

export function gateOf(gate, x) {
  const ok = {
    other: x.target === 'other',
    self: x.by === 'me' || x.agency === 'self',
    me: x.target === 'me',
  }
  let mul = 1
  for (const g of gate || []) if (!ok[g]) mul *= 0.3
  return mul
}

/**
 * 这个位置落在哪一格（按 50 分线，和词表的 oct 同一个口径）。
 *
 * 2026-11-19 加的：取二级词的时候要**同格优先**。
 * 之前不分格，落在警醒（安高·欲低·觉高）会去抓惊惧的「愕然」——语义是偏的：
 * 愕然是心里没底被撞了一下，警醒是心里有底被撞了一下。差的就是那个「有底」。
 *
 * 阈值：安、欲用 0.5；觉不是 0.575 不行——判据那边 50 分转成 n 是 0.15+0.85×0.5=0.575，
 * 用 0.5 会把「说不上」误当成「高」。
 */
export function gridOf(pos = {}) {
  const s = Number(pos.s) || 0, d0 = Number(pos.d) || 0, n = Number(pos.n) || 0
  // 球心附近没有「格」：r 太小说明只是平着，不该硬归到一个角上去。
  // r 用 toSphere 算（它按 N 基线 0.15 处理了 v，直接用 2n-1 会把中性点算偏）。
  if (toSphere({ s, n, d: d0 }).r < 0.1) return null
  const an = s >= 0.5
  const yu = d0 >= 0.5
  const jue = n >= 0.575
  if (an) return yu ? (jue ? '敞亮' : '安住') : (jue ? '警醒' : '疏淡')
  return yu ? (jue ? '渴慕' : '郁结') : (jue ? '惊惧' : '沉沦')
}

/** 二级标签：先落片，再按判据落格，格里的词按「典型度 × 浓淡」排，再乘门控。
 *  opt.position（累积位置帧）给了就直接用位置；没给才回退 transmitters 的旧位置映射。
 *  2026-11-20 改：旧的「全词表比距离」那条路删了，网格是唯一的挑词路。
 *  球面口径（opt.geo='sphere'）随之作废——它只是同一批词换一种距离，网格不再需要。 */
export function secondaryDistribution(frame = {}, opt = {}, judgment = null) {
  const x = frameNow(frame)
  const pts = positionOf((opt || {}).position) || transmitters(frame, judgment)
  const limit = Math.max(1, Math.min(SCORED_MAX, Number((opt || {}).limit) || 5))
  const byName = new Map(SECONDARY_PROTOTYPES.map((p) => [p.name, p]))

  const all = gridDistribution(pts, judgment, {
    keepAll: true,
    typicalWeight: (opt || {}).typicalWeight,
    frame,
    state: (opt || {}).position,
  })
  const scored = all.map((p) => {
    const gate = gateOf(byName.get(p.name)?.gate, x)
    return { name: p.name, score: p.score * gate, gate }
  })
  // p 是整片内占比，跟旧路的「全局占比」同样口径（只是范围从全词表换成这一片）。
  const sum = scored.reduce((a, b) => a + b.score, 0) || 1
  return scored.map((p) => ({ ...p, p: round4(p.score / sum) })).slice(0, limit)
}

const SCORED_MAX = 28

/** 一级标签「说不清」的默认门槛：第一角与第二角的权重差小于它，就不硬给一个词。
 *  依据（2026-11-17 真库 186 轮）：121 轮两角权重差正好 0（S=0.5、D=0.5 这类中性点，
 *  八个角等距），另 15 轮落在 0.02~0.03；再往上才拉开。参数 `affect.v4.label.tie` 可调。 */
export const LABEL_TIE = 0.03

/**
 * 一帧算到底：事帧（现状）+ 判断 → 三递质、八个角、二级分布、置信度。
 * 标签只是分布的下游便利：两角并列时给「说不清」，不按数组顺序硬塞一个词。
 * 返回 tie=1 时 label 不可当结论用，要看得看 primary 分布。
 */
export function infer(frame = {}, judgment = null, opt = {}) {
  // 累积位置帧优先：增量模式先把位置算出来（advanceState），这里只负责出词，不再回头改判断语义。
  const t = positionOf(opt.position) || transmitters(frame, judgment, opt.transmitters || {})
  const primary = primaryDistribution(t.s, t.n, t.d, opt)
  const secondary = secondaryDistribution(frame, opt, judgment)
  const p1 = primary[0]?.weight || 0
  const p2 = primary[1]?.weight || 0
  const s1 = secondary[0]?.p || 0
  const s2 = secondary[1]?.p || 0
  const gap = p1 - p2
  const tieGap = Number.isFinite(Number(opt.tieGap)) ? Math.max(0, Number(opt.tieGap)) : LABEL_TIE
  const tie = gap < tieGap
  return {
    s: t.s, n: t.n, d: t.d,
    primary,
    // 二级情绪：两字枚举词（设计 §5：原型距离 × 事件门控取 top1），不是一级 8 角的单字。
    // 2026-11-17 修：原来这里直接取 primary[0].name，等于拿一级当二级用。
    label: secondary[0]?.name || '说不准',
    tie: tie ? 1 : 0,
    secondary,
    secondaryLabel: secondary[0]?.name || '说不准',
    confidence: {
      primary: round4(clamp01(gap * 2)),
      secondary: round4(clamp01((s1 - s2) * 2)),
    },
  }
}

const SILENT_MS = 3 * 60 * 1000 // 兜底：真的没动静才收，不是「等 3 分钟再判」
const SCENE_MAX_MS = 4 * 60 * 60 * 1000

/** 旧事什么时候算「过去了」：没动静超过兜底线，或一件 scene 撑满 4 小时。 */
export function shouldCloseFrame(frame, nowMs = Date.now(), { silentMs = SILENT_MS, sceneMaxMs = SCENE_MAX_MS } = {}) {
  if (!frame || frame.open === false) return true
  const last = Date.parse(frame.lastAt || frame.startedAt || '')
  if (!Number.isFinite(last)) return true
  if (nowMs - last >= Math.max(0, Number(silentMs) || SILENT_MS)) return true
  const started = Date.parse(frame.startedAt || '')
  if (Number.isFinite(started) && nowMs - started >= Math.max(0, Number(sceneMaxMs) || SCENE_MAX_MS)) return true
  return false
}

/**
 * 同一件事续上：只合并现状（谁、什么动作、冲谁、和谁有关、证据、时间）。
 * 好坏/意外/未来不进事帧——它们是每轮重新判断的，不继承。
 */
export function extendFrame(frame = {}, slot = {}, atMs = Date.now()) {
  const f = { ...(frame || {}) }
  if (slot.act) f.act = String(slot.act)
  // 冲谁 / 谁做的 / 是谁：每句都要更新，不能沾着第一句——「我有点累」不冲我，
  // 继承成 target=me 会把对方自述算成对我的评价。
  if (slot.target) f.target = slot.target
  if (slot.agency) {
    f.agency = slot.agency
    if (!f.by) f.by = slot.agency === 'self' ? 'me' : slot.agency
  }
  if (slot.who) f.who = slot.who
  if (slot.what) f.what = String(slot.what).slice(0, 80)
  // 材料是窗口：每次覆盖，不累积——「最近聊过什么」跟着时间滑。
  if (slot.material) f.material = slot.material
  // summary 是「这件事在干什么」，跟事走；what 只是「这一句说了什么」。
  if (slot.summary) f.summary = String(slot.summary).slice(0, 40)
  if (Array.isArray(slot.evidence) && slot.evidence.length) {
    const ev = Array.isArray(f.evidence) ? f.evidence.slice() : []
    for (const id of slot.evidence) if (id && !ev.includes(id)) ev.push(id)
    f.evidence = ev.slice(-20)
  }
  f.lastAt = new Date(atMs).toISOString()
  return f
}
