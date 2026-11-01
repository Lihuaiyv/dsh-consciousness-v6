/**
 * 口气句：鱼格只在偏出中间时写成做法；关系用温度和披露，不写数字。
 * 运行：node test/manner.test.mjs
 */
import { axisMid, mannerLine } from '../src/algo/manner.js'
import { toneOf } from '../src/algo/reldyn.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

check('0.50 是中间', axisMid(0.5) === true)
check('0.54 仍是中间', axisMid(0.54) === true)
check('0.55 偏出', axisMid(0.55) === false)
check('空轴不写', mannerLine({}) === '')
check('全中间不写鱼格', mannerLine({ axes: { ei: 0.5, sn: 0.5, tf: 0.5, jp: 0.5, sensitivity: 0.5 } }) === '')
check('内向写成问了再答', mannerLine({ axes: { ei: 0.2 } }).includes('问了再答') && !mannerLine({ axes: { ei: 0.2 } }).includes('内向'))
check('外向可以接话', mannerLine({ axes: { ei: 0.8 } }).includes('可以自己把话接下去'))
check('敏感接住重话', mannerLine({ axes: { sensitivity: 0.8 } }).includes('对方一句重的要接住'))
check('钝感不逐句接', mannerLine({ axes: { sensitivity: 0.2 } }).includes('不必每句都接情绪'))
check('不出现鱼格两个字', !mannerLine({ axes: { ei: 0.2, tf: 0.2, jp: 0.8, sn: 0.8, sensitivity: 0.8 } }).includes('鱼格'))

const crafted = { warmth: 0.8, formality: 0.3, disclosure: 0.4, initiative: 0.6 }
const hotLine = mannerLine({ axes: {}, tone: crafted, who: '阿宁' })
check('话热但披露低：底不交', hotLine.includes('底交到表面上就停') && hotLine.startsWith('对阿宁：'), hotLine)
check('热但不写百分比', !hotLine.includes('%') && !/\d\.\d/.test(hotLine), hotLine)
const via = toneOf({ closeness: 0.5, trust: 0, kind: 'owner', mood: 0.6, extraversion: 0.6 })
check('主人、信任是 0：底不交', mannerLine({ tone: via }).includes('底交到表面上就停'), via)

const open = toneOf({ closeness: 0.8, trust: 0.8, kind: 'owner', mood: 0.6, extraversion: 0.7 })
const openLine = mannerLine({ tone: open, who: '阿宁' })
check('熟而且信得过：可以说理由', openLine.includes('可以把理由说出来'), { open, openLine })

const cold = toneOf({ closeness: 0.1, trust: 0.1, kind: 'stranger', mood: 0.4, extraversion: 0.4 })
const coldLine = mannerLine({ tone: cold, who: '路人' })
check('生分：答到表面且句子完整', coldLine.includes('答到表面上就停') && coldLine.includes('句子说完整'), { cold, coldLine })

console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail ? 1 : 0)
