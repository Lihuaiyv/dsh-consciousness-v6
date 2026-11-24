/**
 * 分句：找核的第一步，纯代码（不调模型）。2026-11-23 为「——」漏成一句补的锁。
 * 运行：node test/frame-sentences.test.mjs
 */
import { strip, toSent } from '../src/modules/frame_shadow.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const n = (t) => toSent(t).length

check('三句 → 3，标点留在句里', n('我先说一件事。这段是样例回复。最后一句收住。') === 3, toSent('我先说一件事。这段是样例回复。最后一句收住。'))
check('分号不切（一串分号仍是一句）', n('先看日志；再看队列；最后重跑。') === 1)
check('单句本身就是一个', n('好。') === 1)
check('加粗/链接/行内代码被抹掉，不打断分句', JSON.stringify(toSent('**重点**是这条。见 [文档](D:/x.md)，代码 `foo()` 不算。')) === JSON.stringify(['重点是这条。', '见 文档，代码 不算。']), toSent('**重点**是这条。见 [文档](D:/x.md)，代码 `foo()` 不算。'))
check('英文 ? ! 也切', n('真的吗? 太好了! 那就这样。') === 3)
check('纯符号「——」不成句', n('——') === 0, toSent('——'))
check('纯符号「……」不成句', n('……') === 0)
check('纯符号「!!」不成句', n('!!') === 0)
check('代码块整段被删，前后句子保留', n('先说结论。\n```js\nconst a = 1;\n```\n再说理由。') === 2)
check('空文本 → 0', n('') === 0 && n('   ') === 0)
check('strip：加粗符号抹掉', strip('**粗**') === '粗', strip('**粗**'))

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
