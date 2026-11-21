/**
 * 忘口识别锁（v0，2026-11-15）
 * 只识别、不执行：误判一次就会把真话藏起来，所以先把「宽/窄」钉住。
 */
import { detectForgetIntent } from '../src/modules/forget_intent.js'

let fails = 0
const ok = (name, cond, extra) => {
  if (cond) { console.log('PASS', name) } else { fails++; console.log('FAIL', name, extra ? JSON.stringify(extra) : '') }
}

const yes = [
  '把刚才那句忘掉吧',
  '这条记忆删掉',
  '这件事别再提了',
  '忘掉它',
  '刚才那段抹掉',
  '我说的话不要再提了',
]
const no = [
  '你忘了吗',
  '别忘了我',
  '我忘了',
  '记不记得上次说的',
  '把这条记下来',
  '忘掉',
  '今天天气怎么样',
  '这段代码删掉也不影响吧',   // 太像在聊技术，不动回忆
  '这是一句很长很长的话，里面提到了忘掉这件事，但是它明显不是在对意识体下遗忘指令，因为真正的指令应该很短而且对象很明确，长度也超过了六十字的小闸门，所以按规则这里应该被放过，不该记成一次要忘的请求，也不该去动记忆库里的任何东西。',
]

for (const t of yes) ok('要忘：' + t.slice(0, 12), detectForgetIntent(t) === true, detectForgetIntent(t))
for (const t of no) ok('不误判：' + t.slice(0, 12), detectForgetIntent(t) === false, detectForgetIntent(t))
process.exit(fails ? 1 : 0)
