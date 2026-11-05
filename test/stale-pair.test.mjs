/**
 * S4 状态词测试：只判断「没做完 → 做好了」的时间顺序更新。
 * 运行：node test/stale-pair.test.mjs
 */
import { isStalePair, hasPendingState, hasDoneState } from '../src/modules/stale_pair.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

check('旧条含「还没」', hasPendingState('情绪快照还没做完'))
check('新条含「做好了」', hasDoneState('情绪快照已经做好了'))
check('没做完 → 做好了', isStalePair('情绪快照还没做完', '情绪快照已经做好了'))
check('待办 → 上线', isStalePair('这个功能还在待办里', '功能已经上线了'))
check('方向反了不算', !isStalePair('情绪快照已经做好了', '情绪快照还没做完'))
check('普通改口不算', !isStalePair('用户喜欢猫', '用户喜欢狗'))
check('旧条已带完成词不算', !isStalePair('情绪快照已经做好了但还没测试', '情绪快照已经完成'))

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
