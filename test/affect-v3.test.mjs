/**
 * 情绪 v3：个体化节奏 / 幅度看性格 / 脱敏 / 心情→表达 / 组合入口 / 边界。
 * 运行：node test/affect-v3.test.mjs
 */
import { birthPeriod, planSegments, valueAtTime, valueAt, ampFor, pUp, nextSegment, mulberry32, hashSeed,
  PERIOD_MIN_D, PERIOD_MAX_D, PERIOD_JITTER, SEG_MIN_H, EDGE } from '../src/algo/baseline.js'
import { desensitize, decayedCount, stimulusKey, FLOOR, COUNT_CAP } from '../src/algo/desensitize.js'
import { expressionFrom } from '../src/algo/expression.js'
import { stepSlow, totalOf, fastOf, frameOf } from '../src/algo/emotion.js'

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
  let s = 0
  for (let i = 0; i < 200; i++) s = stepSlow({ s, b: 0.3, p: 0.4, fHourly: 0.3 })
  return s
})()
check('慢情绪收敛到底色附近', Math.abs(sSteady - 0.315) < 0.03, { s: sSteady })

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
  let gapSum = 0
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
    gapSum += Math.abs(s - b)
    hours++
  }
  check('7 天联调不越界', badCount === 0, { badCount })
  check('慢情绪每小时跳不超过 0.2', maxJump <= 0.2 + 1e-9, { maxJump })
  check('慢情绪大致跟着底色', gapSum / hours < 0.12, { avgGap: +(gapSum / hours).toFixed(3) })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
