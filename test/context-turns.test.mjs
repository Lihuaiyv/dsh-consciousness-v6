/**
 * 上下文该给几轮：短句/指代/问句多给，长句少给，封顶。
 * 运行：node test/context-turns.test.mjs
 */
import { contextTurnsFor } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

check('长句只给三句', contextTurnsFor('把页面右下角那个统计数字改成保留两位小数并且加个百分比') === 3, { v: contextTurnsFor('把页面右下角那个统计数字改成保留两位小数并且加个百分比') })
check('短问句多给', contextTurnsFor('卡了？') === 6, { v: contextTurnsFor('卡了？') })
check('「你想怎么样？」多给', contextTurnsFor('你想怎么样？') === 6, { v: contextTurnsFor('你想怎么样？') })
check('带指代多给', contextTurnsFor('这个是干啥的') === 6, { v: contextTurnsFor('这个是干啥的') })
check('「算了」多给', contextTurnsFor('算了') === 6, { v: contextTurnsFor('算了') })
check('普通短句不多给', contextTurnsFor('好了') === 3, { v: contextTurnsFor('好了') })
check('空串给默认', contextTurnsFor('') === 3 && contextTurnsFor(null) === 3)
check('英文长句给默认', contextTurnsFor('please update the sidebar padding to twelve pixels') === 3)
check('可以调 base', contextTurnsFor('好了', { base: 2 }) === 2)
check('封顶不会超过 max', contextTurnsFor('它', { max: 8 }) === 8)
check('长得像问句但很短也算', contextTurnsFor('为啥呢') === 6, { v: contextTurnsFor('为啥呢') })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
