/**
 * 第二步：三种接收方式（同向 / 反向 / 衰减）。
 * v1 必须和老行为一模一样；v2 只在特定条件下换方式。
 * 运行：node test/empathy-mode.test.mjs
 */
import { empathyPartsOf, fastOf, EMPATHY_KAPPA } from '../src/algo/emotion.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps

// ---------- 一、v1 不许变 ----------
const v1cases = [
  { eUser: -0.6, ePrev: 0, closeness: 0.9, selfNow: 0 },
  { eUser: -0.2, ePrev: -0.1, closeness: 0.5, selfNow: -0.2 },
  { eUser: 0.7, ePrev: 0, closeness: 0.8, selfNow: 0.3 },
  { eUser: -0.9, ePrev: -0.8, closeness: 1, selfNow: -0.8 },
]
for (const c of v1cases) {
  const a = empathyPartsOf(c)
  const b = empathyPartsOf({ ...c, mode: 'v1' })
  check('v1 和默认一致 ' + JSON.stringify(c), a.share === b.share && a.mode === 'share', { a: a.share, b: b.share })
}

// ---------- 二、v2 的三种方式 ----------
const mild = empathyPartsOf({ eUser: -0.2, ePrev: 0, closeness: 0.9, selfNow: 0, mode: 'v2' })
check('轻度不悦走同向', mild.mode === 'share' && mild.share < 0, mild)

const deepCalm = empathyPartsOf({ eUser: -0.7, ePrev: 0, closeness: 0.9, selfNow: -0.02, mode: 'v2' })
const deepCalmV1 = empathyPartsOf({ eUser: -0.7, ePrev: 0, closeness: 0.9, selfNow: -0.02, mode: 'v1' })
check('你沉我站得住 → 反向稳住', deepCalm.mode === 'hold', deepCalm)
check('反向：仍然往下（不是变高兴）', deepCalm.share < 0, { share: deepCalm.share })
check('反向：只留三成左右，比 v1 少一半以上', Math.abs(deepCalm.share) < Math.abs(deepCalmV1.share) * 0.5,
  { v2: deepCalm.share, v1: deepCalmV1.share })

const deepDeep = empathyPartsOf({ eUser: -0.7, ePrev: 0, closeness: 0.9, selfNow: -0.6, mode: 'v2' })
const deepDeepV1 = empathyPartsOf({ eUser: -0.7, ePrev: 0, closeness: 0.9, selfNow: -0.6, mode: 'v1' })
check('我也沉了：不反向，改成衰减，别再往下压', deepDeep.mode === 'dampen' && deepDeep.share < 0
  && Math.abs(deepDeep.share) < Math.abs(deepDeepV1.share), { v2: deepDeep, v1: deepDeepV1.share })

const bothHot = empathyPartsOf({ eUser: -0.85, ePrev: 0, closeness: 0.9, selfNow: -0.7, mode: 'v2' })
check('两边都激动 → 衰减', bothHot.mode === 'dampen', bothHot)
const bothHotV1 = empathyPartsOf({ eUser: -0.85, ePrev: 0, closeness: 0.9, selfNow: -0.7, mode: 'v1' })
check('衰减之后被带得比 v1 少', Math.abs(bothHot.share) < Math.abs(bothHotV1.share), {
  v2: bothHot.share, v1: bothHotV1.share,
})

const posHigh = empathyPartsOf({ eUser: 0.8, ePrev: 0, closeness: 0.9, selfNow: 0.7, mode: 'v2' })
check('高兴也一样会衰减', posHigh.mode === 'dampen', posHigh)

const posCalm = empathyPartsOf({ eUser: 0.8, ePrev: 0, closeness: 0.9, selfNow: 0, mode: 'v2' })
check('你高兴我不沉（不反向，不衰减）', posCalm.mode === 'share' && posCalm.share > 0, posCalm)

// ---------- 三、错的方向不可能出现 ----------
for (const self of [-0.05, -0.15, 0]) {
  const p = empathyPartsOf({ eUser: -0.9, ePrev: -0.2, closeness: 1, selfNow: self, mode: 'v2' })
  check('你很难受时我不可能被推成正的 ' + self, p.share <= 0, p)
}
const caps = empathyPartsOf({ eUser: -1, ePrev: 0, closeness: 1, selfNow: 0, mode: 'v2' })
check('单次共情权重不超过 κ', Math.abs(caps.w) <= EMPATHY_KAPPA + 1e-9, caps)

// ---------- 四、整条快情绪的走向 ----------
const holdFast = fastOf({ fSelf: 0, eUser: -0.7, ePrev: 0, closeness: 0.9, selfNow: -0.02, mode: 'v2' })
const shareFast = fastOf({ fSelf: 0, eUser: -0.7, ePrev: 0, closeness: 0.9, selfNow: -0.02, mode: 'v1' })
check('同一句难听的：v2 里我不掉那么狠', holdFast > shareFast, { v2: holdFast, v1: shareFast })
check('但也没有变正（不假装开心）', holdFast <= 0.05, { v2: holdFast })

// ---------- 五、边界 ----------
const e0 = empathyPartsOf({ eUser: 0, ePrev: 0, closeness: 1, selfNow: 0, mode: 'v2' })
check('对方没情绪时什么都不发生', e0.share === 0 && e0.mode === 'share', e0)

const edge = empathyPartsOf({ eUser: -0.35, ePrev: 0, closeness: 1, selfNow: 0.2, mode: 'v2' })
check('刚好到反向阈值就触发', edge.mode === 'hold', edge)

const justAbove = empathyPartsOf({ eUser: -0.34, ePrev: 0, closeness: 1, selfNow: 0.2, mode: 'v2' })
check('差一点不触发', justAbove.mode === 'share', justAbove)

const standLow = empathyPartsOf({ eUser: -0.35, ePrev: 0, closeness: 1, selfNow: -0.2, mode: 'v2' })
check('我站不住时不反向', standLow.mode === 'share', standLow)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
