/**
 * S5 状态词保护测试：待办/承诺不压、不模糊。
 * 运行：node test/state-guard.test.mjs
 */
import { isThin } from '../src/modules/consolidate.js'
import { shouldFade } from '../src/modules/memory_fade.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// 压缩保护
check('待办不压', isThin({ text: '提醒接口还没开启，等开启后设三天后提醒', importance: 0.3 }) === false)
check('普通流水账照压', isThin({ text: '今天聊了很多事，聊得挺开心', importance: 0.3 }) === true)
check('高重要度本来就不压', isThin({ text: '用户的名字叫李怀玉', importance: 0.9 }) === false)

// 模糊保护
const old = (text) => ({ text, type: 'fact', importance: 0.3, mark: 'normal' })
check('待办不模糊', shouldFade(old('这件事还没做完，等之后再做'), 200) === false)
check('普通旧事会模糊', shouldFade(old('以前聊过的一件小事'), 200) === true)
check('钉住的不模糊', shouldFade({ ...old('普通旧事'), mark: 'locked' }, 200) === false)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
