/**
 * 「这段字是不是人对我说的话」——机器消息 / 文档块不进情绪评价。
 * 运行：node test/human-text.test.mjs
 *
 * 来由（2026-11-10）：抽 20 条「含糊判决」逐条看，发现 4 条根本不是对话——
 * 机器消息、文档章节、引用块都被当成「对我说的话」判了情绪，账上算成含糊。
 * 这里守两条：该拦的拦住；真人说的话一句都不许误伤。
 */
import { looksNonHuman } from '../src/algo/appraise.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

/* 该拦的 */
const BLOCKED = [
  ['机器：Team Lead 头', 'You are the Team Lead named "lead". Use list_agents({}) to find your teammates.'],
  ['机器：跑团提醒', '[SCHEDULE REMINDER BATCH] reminders_json: [{"schedule_id":"x"}]'],
  ['机器：goal 控制标', '<goal_round>3</goal_round> 继续'],
  ['机器：运行时快照', 'Current runtime context. This snapshot supersedes earlier snapshots.'],
  ['文档：章节开头', '二、意义（只当判据，不是定义） 这里不回答「意义是什么」。'],
  ['文档：附注', '附：两边各有什么、怎么拼起来（旁支）'],
  ['文档：引用块', '原话：「这里面最有所谓神秘感的变量，其实是我的话。」'],
  ['文档：表格行', '| 项 | 数 |\n|---|---|'],
]
for (const [name, text] of BLOCKED) check('拦住 · ' + name, looksNonHuman(text) !== null, looksNonHuman(text))

/* 不许误伤的：真人说的，哪怕很短、带符号 */
const ALLOWED = [
  '你多说点啊宝宝！你好敷衍！',
  '更客观更现实是吧。',
  '欧克宝宝。不拆你了。',
  '> 你把这条删了吧',           // 真人引用格式，带「>」但很短——按现在的规则会被拦？见下
  '二是我觉得这样不太好',        // 以「二是」开头，不是「二、」
  '算了。',
  '我有点难过',
  '015',
]
for (const text of ALLOWED) check('放过 · ' + JSON.stringify(text.slice(0, 16)), looksNonHuman(text) === null, looksNonHuman(text))

/* 空串：算「没人说话」，不是「人说了空话」 */
check('空串单独一类', looksNonHuman('') === 'empty' && looksNonHuman('   ') === 'empty')

/* 长文带列表：转贴的笔记，拦 */
const longList = '今天的记录\n- 第一条\n- 第二条\n- 第三条\n' + 'x'.repeat(400)
check('长文 + 三个列表项 → 文档', looksNonHuman(longList) === 'document', looksNonHuman(longList))

/* 长文但没列表：可能是真人写了一大段，不拦 */
const longProse = '我想了很久，' + '还是觉得这件事得慢慢说。'.repeat(40)
check('长文但没列表：不拦', looksNonHuman(longProse) === null, looksNonHuman(longProse))

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
