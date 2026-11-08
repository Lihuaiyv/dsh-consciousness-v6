/**
 * 「被砸中的时候，关系不该自动把我调暖」——温度里情绪让位的幅度。
 * 运行：node test/expression-affect-weight.test.mjs
 *
 * 原来：warmth = 0.6·关系 + 0.4·档位底色，再大的事也只占四成。
 * 现在：强度越高，关系让得越多（默认到 0.25），参数 expression.affect.weight 可调。
 *
 * 验五件事：
 *   1. 强度不高（≤0.4）时，和旧公式逐字一致——不打扰平时
 *   2. 同样很亲的关系，被砸中之后温度降下来
 *   3. 参数给 0 就回到旧行为（可回退）
 *   4. heat 永远在 [0, 1] 且不超过参数上限
 *   5. 关系再亲也挡不住「被砸中」那一下（方向不能反）
 */
import { expressionState, AFFECT_WEIGHT_DEFAULT } from '../src/modules/expression_state.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}
const near = (a, b, eps = 0.005) => Math.abs(a - b) <= eps

const close = { warmth: 0.92, formality: 0.13, disclosure: 0.7, initiative: 0.57 }
const calmAffect = { primary_label: 'calm', intensity: 0.4, v3: { slow: 0.05, fast: 0, total: 0.05 } }
const hitAffect = { primary_label: 'irritated', intensity: 1, v3: { slow: 0.05, fast: 0.3, total: 0.15 } }

const base = expressionState({ affect: calmAffect, relation: close })
check('平时 heat=0', base.heat === 0, base.heat)

/* 旧公式的直接对照：关系温度 1.0、档位底色 0.5（plain）→ 0.6·1 + 0.4·0.5 = 0.80 */
const plainFull = expressionState({ affect: calmAffect, relation: { warmth: 1, formality: 0.2, disclosure: 0.5, initiative: 0.5 } })
check('平时温度和旧公式一致（0.80）', near(plainFull.warmth, 0.8), plainFull.warmth)

const hit = expressionState({ affect: hitAffect, relation: close })
check('被砸中时 heat > 0', hit.heat > 0, hit.heat)
check('被砸中时温度更低', hit.warmth < base.warmth, { base: base.warmth, hit: hit.warmth })
check('heat 不超过参数上限', hit.heat <= AFFECT_WEIGHT_DEFAULT + 1e-9, hit.heat)

const off = expressionState({ affect: hitAffect, relation: close, weightAffect: 0 })
check('参数给 0 回到旧行为（heat=0 且比默认更暖）', off.heat === 0 && off.warmth > hit.warmth, { off: off.warmth, hit: hit.warmth })

const colder = expressionState({ affect: hitAffect, relation: { ...close, warmth: 0.3 } })
check('关系冷 + 被砸中 → 更冷', colder.warmth < hit.warmth, { hit: hit.warmth, colder: colder.warmth })

const stranger = expressionState({ affect: calmAffect, relation: { warmth: 0.2, formality: 0.8, disclosure: 0.2, initiative: 0.2 } })
check('heat 不会为负', stranger.heat >= 0, stranger.heat)

// 关系再亲也挡不住那一下：亲密度拉满，被砸中仍低于平静时
const veryClose = { warmth: 1, formality: 0, disclosure: 0.9, initiative: 0.9 }
const a = expressionState({ affect: calmAffect, relation: veryClose })
const b = expressionState({ affect: hitAffect, relation: veryClose })
check('关系满格也挡不住那一下', b.warmth < a.warmth, { calm: a.warmth, hit: b.warmth })

/* 旧公式里的「档位底色」拿不到，就用 heat=0 时反推：baseWarmth = (warmth - 0.6*rel)/0.4 */
function toneWarmthOf(warmth, st) {
  const rel = close.warmth
  const bw = (warmth - 0.6 * rel) / 0.4
  return Number.isFinite(bw) ? bw : 0.5
}

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
