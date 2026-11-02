/**
 * 表达档迟滞：慢情绪在阈值上抖，不应该让她的「脸」来回跳。
 * 运行：node test/level-hysteresis.test.mjs
 */
import { expressionState } from '../src/modules/expression_state.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const at = (slow, prev) => expressionState({ affect: { v3: { slow } }, prev })

check('没有上一轮 → 按阈值给档', at(0.26).level === 'warm', at(0.26).level)
check('刚跨过阈值 → 保持上一档', at(0.23, { level: 'warm', slow: 0.26 }).level === 'warm',
  at(0.23, { level: 'warm', slow: 0.26 }))
check('跨得多 → 正常换档', at(0.4, { level: 'normal', slow: 0.1 }).level === 'warm',
  at(0.4, { level: 'normal', slow: 0.1 }))
{
  const e = at(-0.18, { level: 'quiet', slow: -0.25 })
  check('保持 quiet 时句子也收着', e.level === 'quiet' && e.sentences === 1, e)
}
check('回到 quiet 时主动性归零', at(-0.22, { level: 'normal', slow: -0.15 }).proactive === 0,
  at(-0.22, { level: 'normal', slow: -0.15 }))
check('返回里带上本轮的 slow 快照', typeof at(0.3).slow === 'number', at(0.3).slow)
check('迟滞不改变 wish/style 的来源', at(0.23, { level: 'warm', slow: 0.26 }).style === at(0.23, { level: 'warm', slow: 0.26 }).style)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
