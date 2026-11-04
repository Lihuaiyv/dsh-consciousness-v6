/**
 * 情绪 v3：个体化节奏 / 幅度看性格 / 脱敏 / 心情→表达 / 组合入口 / 边界。
 * 运行：node test/affect-v3.test.mjs
 */
import { birthPeriod, planSegments, valueAtTime, valueAt, ampFor, pUp, nextSegment, mulberry32, hashSeed,
  circadianAt, pulseAt, driftAt, cycleAt, rhythmAt, stepLoad, LOAD_CAP,
  PERIOD_MIN_D, PERIOD_MAX_D, PERIOD_JITTER, SEG_MIN_H, EDGE } from '../src/algo/baseline.js'
import { desensitize, decayedCount, stimulusKey, FLOOR, COUNT_CAP } from '../src/algo/desensitize.js'
import { expressionFrom } from '../src/algo/expression.js'
import { PAD_PRIOR, affectDynV1 } from '../src/algo/affect_dyn.js'
import { stepSlow, injectSlow, totalOf, fastOf, frameOf } from '../src/algo/emotion.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const finite = (x) => Number.isFinite(x)

const H = 3600000
const D = 24 * H
const T0 = Date.UTC(2026, 0, 1)

// ================= 一、个体化节奏 =================

const p1 = birthPeriod('agt_a')
check('同一 agent 的周期固定', p1 === birthPeriod('agt_a'), { p1 })
const p3 = birthPeriod('agt_b')
check('不同 agent 周期不同', Math.abs(p1 - p3) > 0.05, { p1, p3 })
check('周期落在区间内', p1 >= PERIOD_MIN_D && p1 <= PERIOD_MAX_D, { p1 })

const segs = planSegments({ seed: 'agt_a', sensitivity: 0.5, startMs: T0, untilMs: T0 + 120 * D })
check('铺出多段', segs.length >= 10, { n: segs.length })

const expect = { lo: Math.max(SEG_MIN_H, p1 * 24 * (1 - PERIOD_JITTER)), hi: p1 * 24 * (1 + PERIOD_JITTER) }
const badDur = segs.filter((s) => s.durationH < expect.lo - 1e-6 || s.durationH > expect.hi + 1e-6)
check('段时长围着个体周期抖', badDur.length === 0, { period: p1, expect })

check('段与段首尾相接', segs.every((s, i) => i === 0 || Math.abs(s.from - segs[i - 1].to) < 1e-9))
check('值不贴边、不越界', segs.every((s) => s.from >= -EDGE && s.from <= EDGE && s.to >= -EDGE && s.to <= EDGE))

const again = planSegments({ seed: 'agt_a', sensitivity: 0.5, startMs: T0, untilMs: T0 + 120 * D })
check('同 seed 可复现', again.length === segs.length && again.every((s, i) => Math.abs(s.to - segs[i].to) < 1e-12 && Math.abs(s.durationH - segs[i].durationH) < 1e-12))
check('段号从 0 连续', segs.every((s, i) => s.segNo === i))

// 断点续算：从第 4 段之后接着铺，必须和从头铺一遍完全一致
const cut = segs[3]
const tail = planSegments({
  seed: 'agt_a', sensitivity: 0.5, startMs: cut.endMs, untilMs: T0 + 120 * D,
  segNo0: cut.segNo + 1, from0: cut.to,
})
const resumeSame = tail.length > 0 && tail.every((s) => {
  const full = segs.find((x) => x.segNo === s.segNo)
  return full && Math.abs(full.to - s.to) < 1e-12 && Math.abs(full.durationH - s.durationH) < 1e-12
})
check('断点续算与从头一致', resumeSame, { tail: tail.length, same: tail.filter((s) => segs.find((x) => x.segNo === s.segNo)).length })

const negNo = planSegments({ seed: 'x', startMs: T0, untilMs: T0 + 3 * D, segNo0: -5 })
check('段号不为负', negNo.length > 0 && negNo[0].segNo === 0)

check('低处大概率向上', pUp(-0.4) >= 0.9, { p: pUp(-0.4) })
check('高处大概率向下', pUp(0.4) <= 0.1, { p: pUp(0.4) })
check('中间对半', Math.abs(pUp(0) - 0.5) < 1e-9)
check('永远留意外', pUp(-1) <= 0.95 && pUp(1) >= 0.05, { up: pUp(-1), down: pUp(1) })

// 段内曲线：两端对齐、单调、不越界
const seg = segs[0]
check('段起点等于 from', Math.abs(valueAt(seg, seg.startMs) - seg.from) < 1e-9)
check('段终点等于 to', Math.abs(valueAt(seg, seg.endMs) - seg.to) < 1e-9)
check('段外被夹住', Math.abs(valueAt(seg, seg.startMs - 9999999) - seg.from) < 1e-9 && Math.abs(valueAt(seg, seg.endMs + 9999999) - seg.to) < 1e-9)
check('NaN 时间不产生 NaN 值', finite(valueAt(seg, NaN)) && finite(valueAtTime(segs, NaN)))

// ================= 二、幅度看性格 =================

check('σ 高幅度大', ampFor(0.9) > ampFor(0.1), { hi: ampFor(0.9), lo: ampFor(0.1) })
check('σ=0.5 是 0.20', Math.abs(ampFor(0.5) - 0.2) < 1e-9)
check('σ 越界被夹', Math.abs(ampFor(9) - 0.3) < 1e-9 && Math.abs(ampFor(-9) - 0.1) < 1e-9, { hi: ampFor(9), lo: ampFor(-9) })
check('σ 缺省为中间', Math.abs(ampFor(undefined) - 0.2) < 1e-9)

function swing(sigma) {
  const s = planSegments({ seed: 'agt_swing', sensitivity: sigma, startMs: T0, untilMs: T0 + 240 * D })
  let lo = Infinity
  let hi = -Infinity
  for (let t = T0; t < T0 + 240 * D; t += 6 * H) {
    const v = valueAtTime(s, t)
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return hi - lo
}
const swingHi = swing(0.9)
const swingLo = swing(0.1)
check('敏感的人起伏更大', swingHi > swingLo, { swingHi: +swingHi.toFixed(3), swingLo: +swingLo.toFixed(3) })

// ================= 三、脱敏 =================

let st = { count: 0, lastAt: null }
const factors = []
let now = Date.UTC(2026, 0, 1, 9)
for (let i = 0; i < 10; i++) {
  const r = desensitize({ count: st.count, lastAt: st.lastAt, now })
  factors.push(r.factor)
  st = { count: r.nextCount, lastAt: r.nextAt }
  now += 60 * 1000
}
check('连续刺激单调递减', factors.every((f, i) => i === 0 || f <= factors[i - 1] + 1e-9), { factors })
check('第一次不打折', factors[0] === 1)
check('第二次约 0.67', Math.abs(factors[1] - 0.667) < 0.01, { second: factors[1] })
check('第十次已经很淡', factors[9] < 0.25, { tenth: factors[9] })

const after24 = desensitize({ count: st.count, lastAt: st.lastAt, now: now + 24 * H })
check('隔 24h 会恢复', after24.factor > factors[9], { after: after24.factor, before: factors[9] })
check('不会打到 0', desensitize({ count: 1000, lastAt: now, now }).factor === FLOOR)
check('计数按小时挥发', decayedCount(1, 12 * H, 12) < 0.37 && decayedCount(1, 12 * H, 12) > 0.36)
check('间隔为 0 不挥发', Math.abs(decayedCount(3, 0, 12) - 3) < 1e-9)
check('刺激指纹区分类型', stimulusKey('joy', 'chat') !== stimulusKey('joy', 'browse'))
const capped = desensitize({ count: 1e9, lastAt: now, now })
check('计数有上限', capped.nextCount <= COUNT_CAP, capped)

// ================= 四、心情 → 表达 =================

const low = expressionFrom({ slow: -0.3, intensity: 0.3 })
check('低落时话少', low.level === 'quiet' && low.sentences === 1, low)
check('低落时不主动', low.proactive === 0, low)
check('低落时语气偏冷', low.tone === 'cool', low)

const high = expressionFrom({ slow: 0.35, intensity: 0.3 })
check('偏高时愿展开', high.level === 'warm' && high.sentences === 4, high)
check('偏高时更主动', high.proactive === 2, high)

const mid = expressionFrom({ slow: 0, intensity: 0.3 })
check('中性是正常档', mid.level === 'normal' && mid.sentences === 3, mid)

const excited = expressionFrom({ slow: 0.35, intensity: 0.9 })
check('太激动时压到一句', excited.sentences === 1 && excited.proactive === 0, excited)
check('太激动时语气短促', excited.tone === 'short', excited)

const tense = expressionFrom({ slow: 0.3, intensity: 0.7 })
check('偏强时最多两句', tense.sentences <= 2, tense)

const extro = expressionFrom({ slow: 0, intensity: 0.3, ei: 0.8 })
check('外向多说一句', extro.sentences === 4, extro)
const intro = expressionFrom({ slow: 0, intensity: 0.3, ei: 0.2 })
check('内向少说一句', intro.sentences === 2, intro)
const lowExtro = expressionFrom({ slow: -0.35, intensity: 0.3, ei: 0.9 })
check('低落压过外向', lowExtro.sentences === 1 && lowExtro.proactive === 0, lowExtro)

check('句长永远 1~4', [0, 0.25, 0.5, 0.75, 1].every((x) => {
  const r = expressionFrom({ slow: -1 + 2 * x, intensity: x, ei: x })
  return r.sentences >= 1 && r.sentences <= 4
}))

// ================= 五、组合入口 =================

check('总情绪：没刺激等于慢情绪', Math.abs(totalOf(0.2, 0) - 0.2) < 1e-9, { t: totalOf(0.2, 0) })
check('总情绪：快情绪只偏 0.35', Math.abs(totalOf(0, 1) - 0.35) < 1e-9, { t: totalOf(0, 1) })
check('总情绪：不缩放慢情绪', totalOf(-0.5, 0) === -0.5, { t: totalOf(-0.5, 0) })
check('总情绪：封顶', totalOf(0.8, 1) === 1 && totalOf(-0.8, -1) === -1, { hi: totalOf(0.8, 1), lo: totalOf(-0.8, -1) })

const sSteady = (() => {
  let s = -0.6
  for (let i = 0; i < 400; i++) s = stepSlow({ s, b: 0.3, p: 0.4 })
  return s
})()
// v4：平时只往水位回落。从 −0.6 出发、水位 0.3，400 小时后应该贴着水位
// （标签先验 ω=0.005 只把它挪 0.003，不冒充底色）
check('静默时慢情绪回到水位', Math.abs(sSteady - 0.3) < 0.01, { s: sSteady })

// v4：事件冲击只按「比现状多出多少」推（advantage），不按事件本身多响
{
  const atNeutral = injectSlow({ s: 0, e: 0.6 })
  const atHigh = injectSlow({ s: 0.55, e: 0.6 })
  const atLow = injectSlow({ s: -0.2, e: 0.6 })
  check('事件从 0 出发能推得动', atNeutral > 0.05, { s: atNeutral })
  check('已经在高兴时同样的事推不动（A≈0）', Math.abs(atHigh - 0.55) < 0.01, { s: atHigh })
  check('从低处被同一个好事拽起来更多', atLow - (-0.2) > atNeutral, { s: atLow })
  check('冲击单调：事件越重推得越多', injectSlow({ s: 0, e: 0.9 }) > injectSlow({ s: 0, e: 0.3 }))
  check('坏事件往下推', injectSlow({ s: 0, e: -0.6 }) < 0)
  check('饱和：5 分钟里第 5 次推得少', injectSlow({ s: 0, e: 0.6, satN: 4 }) < injectSlow({ s: 0, e: 0.6 }))
  check('冲击不越界', injectSlow({ s: 0.95, e: 1 }) <= 1 && injectSlow({ s: -0.95, e: -1 }) >= -1)
  check('半衰期 4 小时：4 小时后差距减半', Math.abs(stepSlow({ s: 0.8, b: 0, dtHours: 4 }) - 0.4) < 0.03, { s: stepSlow({ s: 0.8, b: 0, dtHours: 4 }) })
}

{
  // 步长无关：一次走 6 小时 == 六次各走 1 小时（精确离散化该有的性质）
  let stepwise = 0
  for (let i = 0; i < 6; i++) stepwise = stepSlow({ s: stepwise, b: 0.2, p: 0.4, dtHours: 1 })
  const oneShot = stepSlow({ s: 0, b: 0.2, p: 0.4, dtHours: 6 })
  check('6 个一小时 ≈ 一次六小时', Math.abs(stepwise - oneShot) < 0.01, { stepwise, oneShot })
}

{
  // 没有新刺激：8 小时后余温退到两成左右（λ=0.205 → exp(-1.64)≈0.19）
  let s = 0.8
  for (let i = 0; i < 8; i++) s = stepSlow({ s, b: 0, p: 0, fHourly: 0, dtHours: 1 })
  check('静默一夜退到两成左右', s < 0.25 && s > 0.10, { s })
}

{
  // 水位真有拉力：同样的时长，水位高 / 低要能拉开慢情绪
  let hiSide = 0
  let loSide = 0
  for (let i = 0; i < 48; i++) {
    hiSide = stepSlow({ s: hiSide, b: 0.8, p: 0, dtHours: 1 })
    loSide = stepSlow({ s: loSide, b: -0.8, p: 0, dtHours: 1 })
  }
  check('底色的力气够：水位高低的慢情绪能拉开', Math.abs(hiSide - loSide) > 0.2, { hi: hiSide, lo: loSide })
}

{
  // 标签先验只占一丝（ω/λ ≈ 0.03），不能冒充底色
  let s = 0
  for (let i = 0; i < 500; i++) s = stepSlow({ s, b: 0, p: 1, fHourly: 0, dtHours: 1 })
  check('标签先验只占 3%', s > 0.02 && s < 0.045, { s })
}

// ================= 五-b、底色的三层：日节律 + 累积负荷 =================

{
  const amp = 0.06
  let lo = Infinity
  let hi = -Infinity
  for (let h = 0; h < 24; h++) {
    const v = circadianAt(T0 + h * H, 'agt_circ', amp)
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  check('日节律一天摸到两头', hi > amp * 0.9 && lo < -amp * 0.9, { lo: +lo.toFixed(3), hi: +hi.toFixed(3) })
  check('日节律隔天重复', Math.abs(circadianAt(T0 + 5 * H, 'agt_circ', amp) - circadianAt(T0 + 29 * H, 'agt_circ', amp)) < 1e-9)
  check('日节律相位跟着个体走',
    Math.abs(circadianAt(T0 + 3 * H, 'agt_a', amp) - circadianAt(T0 + 3 * H, 'agt_b', amp)) > 1e-6)
  check('日节律关掉就是 0', circadianAt(T0, 'agt_circ', 0) === 0 && circadianAt(T0, 'agt_circ', NaN) === 0)
}

{
  // 累积负荷：一直偏 0.3，水位被拖到 s*=(κ/Λ)·0.3 ≈ 0.19；松手一周基本代谢干净
  const gain = 0.01
  const tauH = 168
  const target = (gain / (gain + 1 / tauH)) * 0.3
  let L = 0
  for (let h = 0; h < 24 * 14; h++) L = stepLoad({ load: L, s: 0.3, bPlan: 0, dtHours: 1, gain, tauH })
  check('一直偏着，水位被拖走', L > target * 0.8 && L < target * 1.1, { L, target: +target.toFixed(3) })
  let back = L
  for (let h = 0; h < 24 * 7; h++) back = stepLoad({ load: back, s: 0, bPlan: 0, dtHours: 1, gain, tauH })
  check('松手一周基本代谢回去', Math.abs(back) < 0.08, { back })
  check('负荷有上限', Math.abs(stepLoad({ load: 5, s: 1, bPlan: -1, dtHours: 1 })) <= LOAD_CAP + 1e-9)
}

// ================= 五-b2、水位的激素纹：脉冲 / 漂移 / 长周期 =================

{
  const rough = 0.05
  const cyc = 0.06
  const seed = 'agt_grain'
  let lo = Infinity
  let hi = -Infinity
  let maxStep = 0
  let prev = null
  let turns = 0
  let lastDir = 0
  for (let m = 0; m < 24 * 60; m++) {
    const t = T0 + m * 60000
    const v = rhythmAt(t, seed, { rough, cycle: cyc })
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
    if (prev !== null) {
      maxStep = Math.max(maxStep, Math.abs(v - prev))
      const d = Math.sign(v - prev)
      if (d && lastDir && d !== lastDir) turns++
      if (d) lastDir = d
    }
    prev = v
  }
  /* 幅度不能失控：漂移 + 脉冲 + 长周期封在 rough*2 + cycle 里 */
  check('激素纹有界', hi <= rough * 2 + cyc + 1e-9 && lo >= -(rough * 2 + cyc) - 1e-9, { lo: +lo.toFixed(3), hi: +hi.toFixed(3) })
  /* 一眼能看出「不平滑」：一天里要来回拐很多次，不是一条正弦 */
  check('激素纹不平滑（一天拐十几次）', turns >= 12, { turns })
  check('激素纹没有分钟级跳变', maxStep < 0.01, { maxStep: +maxStep.toFixed(4) })

  check('激素纹可复现', rhythmAt(T0 + 12345, seed, { rough, cycle: cyc }) === rhythmAt(T0 + 12345, seed, { rough, cycle: cyc }))
  check('激素纹跟着个体走',
    Math.abs(rhythmAt(T0 + 7 * H, 'agt_a', { rough, cycle: cyc }) - rhythmAt(T0 + 7 * H, 'agt_b', { rough, cycle: cyc })) > 1e-6)
  check('激素纹给 0 就逐字退回旧样子',
    rhythmAt(T0, seed, { rough: 0, cycle: 0 }) === 0
    && driftAt(T0, seed, 0) === 0 && pulseAt(T0, seed, 0) === 0 && cycleAt(T0, seed, 0) === 0)
  check('坏输入不产生 NaN',
    finite(rhythmAt(NaN, seed, { rough, cycle: cyc })) && finite(rhythmAt(T0, seed, { rough: NaN, cycle: NaN })))

  /* 脉冲是「一阵一阵」，不是一直在高位 */
  let active = 0
  const peakAmp = 0.03
  for (let m = 0; m < 24 * 60; m++) if (Math.abs(pulseAt(T0 + m * 60000, seed, peakAmp)) > peakAmp * 0.5) active++
  const frac = active / (24 * 60)
  check('脉冲是稀疏的一阵一阵', frac > 0.1 && frac < 0.6, { frac: +frac.toFixed(2) })

  /* 长周期：一个多月里摸到两头，而且不是一天一循环 */
  let cLo = Infinity
  let cHi = -Infinity
  for (let h = 0; h < 90 * 24; h++) {
    const v = cycleAt(T0 + h * H, seed, cyc)
    cLo = Math.min(cLo, v)
    cHi = Math.max(cHi, v)
  }
  check('长周期一个多月摸到两头', cHi > cyc * 0.9 && cLo < -cyc * 0.9, { lo: +cLo.toFixed(3), hi: +cHi.toFixed(3) })
  check('长周期不是日循环', Math.abs(cycleAt(T0 + 10 * H, seed, cyc) - cycleAt(T0 + 34 * H, seed, cyc)) > 1e-6)
}

check('共情：对方难过会把自己拉低', fastOf({ fSelf: 0, eUser: -0.6, closeness: 0.99 }) < -0.05, { f: fastOf({ fSelf: 0, eUser: -0.6, closeness: 0.99 }) })
check('共情：对方高兴会把自己拉高', fastOf({ fSelf: 0, eUser: 0.6, closeness: 0.99 }) > 0.05)
check('共情：陌生人几乎不受影响', Math.abs(fastOf({ fSelf: 0.2, eUser: -0.6, closeness: 0.1 }) - 0.2) < 0.1, { f: fastOf({ fSelf: 0.2, eUser: -0.6, closeness: 0.1 }) })
check('共情：亲近比陌生影响大',
  fastOf({ fSelf: 0, eUser: -0.6, closeness: 0.99 }) < fastOf({ fSelf: 0, eUser: -0.6, closeness: 0.1 }))
check('共情：对方没情绪时等于自己', Math.abs(fastOf({ fSelf: 0.3, eUser: 0, closeness: 0.9 }) - 0.3) < 1e-9)
check('共情：波动项方向对',
  fastOf({ fSelf: 0, eUser: -0.4, ePrev: -0.1, closeness: 0.9 }) < fastOf({ fSelf: 0, eUser: -0.4, ePrev: -0.4, closeness: 0.9 }))

const fr = frameOf({ s: 0.1, b: 0.3, p: 0.4, f: 0.2, intensity: 0.4, ei: 0.6 })
check('一帧包含三样', finite(fr.s) && finite(fr.total) && fr.expression && typeof fr.expression.tone === 'string', fr)
check('一帧的值在范围内', fr.s >= -1 && fr.s <= 1 && fr.total >= -1 && fr.total <= 1)

// ================= 六、边界与坏输入 =================

check('空计划返回 0', valueAtTime([], T0) === 0 && valueAtTime(null, T0) === 0)
check('时间早于第一段取起点', valueAtTime(segs, T0 - D) === segs[0].from)
check('计划区间反了返回空', planSegments({ seed: 'x', startMs: T0, untilMs: T0 - D }).length === 0)

const badSeg = nextSegment({ xEnd: 99, periodD: 0, amp: NaN, rnd: () => 0.5, startMs: 0 })
check('坏输入不产生越界段', badSeg.to >= -EDGE && badSeg.to <= EDGE && finite(badSeg.durationH), badSeg)

const nanCases = [
  stepSlow({ s: NaN, b: NaN, p: NaN, fHourly: NaN }),
  totalOf(NaN, NaN),
  fastOf({ fSelf: NaN, eUser: NaN, ePrev: NaN, closeness: NaN }),
  expressionFrom({ slow: NaN, fast: NaN, intensity: NaN, ei: NaN }),
]
check('NaN 不穿透', finite(nanCases[0]) && finite(nanCases[1]) && finite(nanCases[2]), nanCases)
check('NaN 表达仍有档位', nanCases[3].sentences >= 1 && nanCases[3].sentences <= 4, nanCases[3])

check('未来时间不产生负计数', decayedCount(5, -H * 24, 12) >= 0)
const future = desensitize({ count: 5, lastAt: now + 48 * H, now })
check('lastAt 在未来也不崩', finite(future.factor) && future.factor >= FLOOR, future)

// 随机 300 组：所有输出都必须有限且在范围内
let bad = 0
for (let i = 0; i < 300; i++) {
  const rnd = mulberry32(i + 1)
  const pick = () => rnd() * 6 - 3
  const s = stepSlow({ s: pick(), b: pick(), p: pick(), fHourly: pick() })
  const t = totalOf(pick(), pick())
  const f = fastOf({ fSelf: pick(), eUser: pick(), ePrev: pick(), closeness: rnd() })
  const e = expressionFrom({ slow: pick(), fast: pick(), intensity: pick(), ei: pick() })
  if (!finite(s) || s < -1 || s > 1) bad++
  if (!finite(t) || t < -1 || t > 1) bad++
  if (!finite(f) || f < -1 || f > 1) bad++
  if (e.sentences < 1 || e.sentences > 4 || e.proactive < 0 || e.proactive > 2) bad++
}
check('300 组随机输入全部合法', bad === 0, { bad })

// ================= 七、7 天联调 =================

{
  const plan = planSegments({ seed: 'agt_sim', sensitivity: 0.6, startMs: T0, untilMs: T0 + 7 * D + D })
  let s = 0
  let f = 0
  let prevS = 0
  let maxJump = 0
  let badCount = 0
  let sSum = 0
  let fSum = 0
  let bSum = 0
  let hours = 0
  let stim = { count: 0, lastAt: null }
  for (let h = 0; h < 7 * 24; h++) {
    const t = T0 + h * H
    const b = valueAtTime(plan, t)
    const df = desensitize({ count: stim.count, lastAt: stim.lastAt, now: t })
    stim = { count: df.nextCount, lastAt: df.nextAt }
    const fSelf = 0.3 * (h % 2 ? 1 : -1) * df.factor
    f = fastOf({ fSelf, eUser: 0.2, ePrev: 0, closeness: 0.9 })
    s = stepSlow({ s, b, p: 0.4, fHourly: f })
    maxJump = Math.max(maxJump, Math.abs(s - prevS))
    prevS = s
    const T = totalOf(s, f)
    if (!finite(s) || !finite(T) || Math.abs(s) > 1 || Math.abs(T) > 1) badCount++
    sSum += s
    fSum += f
    bSum += b
    hours++
  }
  const avg = (x) => x / hours
  check('7 天联调不越界', badCount === 0, { badCount })
  check('慢情绪每小时跳不超过 0.2', maxJump <= 0.2 + 1e-9, { maxJump })
  /* v4 起慢情绪不再被快情绪拽：平时它只跟着水位走，快情绪那一路交给事件冲击。
     所以要验的是「稳在水位边上」，而不是「落在快情绪和水位之间」。 */
  const sAvg = avg(sSum)
  const fAvg = avg(fSum)
  const bAvg = avg(bSum)
  check('慢情绪稳在水位边上（不再被快情绪拽跑）',
    Math.abs(sAvg - bAvg) < 0.05,
    { s: +sAvg.toFixed(3), f: +fAvg.toFixed(3), b: +bAvg.toFixed(3) })
}

// ================= 锚点：平静不该自带半格正分 =================
/* 2026-11-03：peaceful 原来 0.5、calm 原来 0.4，挺平静也带正分，快情绪老贴在 0.3~0.7 掉不下来。
   往中性收了一档。这里钉住「平静落在中性偏一点点」，别再被谁改回去。 */
{
  const run = (label) => affectDynV1.run({}, {
    mode: 'apply',
    state: { pleasure: 0, arousal: 0, dominance: 0, intensity: 0.3, mood: 0.5, primary_label: label },
    appraisal: { label, goal_congruence: 0, novelty: 0, certainty: 0.8, agency: 'other' },
  })
  const pe = run('peaceful')
  const ca = run('calm')
  check('peaceful 锚点收到 0.3 以下', PAD_PRIOR.peaceful.p <= 0.3, PAD_PRIOR.peaceful)
  check('calm 锚点收到 0.2 以下', PAD_PRIOR.calm.p <= 0.2, PAD_PRIOR.calm)
  check('平静仍是中性偏一点点正，不是打成负面', pe.pleasure > 0 && pe.pleasure <= 0.3, pe)
  check('calm 比 peaceful 更中性', ca.pleasure < pe.pleasure, { calm: ca.pleasure, peaceful: pe.pleasure })
  check('joy 没被一起改低', PAD_PRIOR.joy.p >= 0.6, PAD_PRIOR.joy)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
