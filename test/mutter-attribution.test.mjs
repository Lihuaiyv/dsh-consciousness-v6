/**
 * 嘀咕归因：喂给模型的这一轮必须带「user: / assistant:」说话人标签。
 *
 * 2026-11-04 的坑：writeMutter 把 system + turns 交给 model.summarize，
 * 而两个模型适配器在有 system 时会把非 system 内容拼成裸文本、丢掉 role，
 * 嘀咕于是把她自己列的几类当成主人说的。这里锁住组装这一层。
 * 运行：node test/mutter-attribution.test.mjs
 */
import { mutterMessages } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const sys = '你就是这个意识体。'
const turns = [
  { role: 'user', text: '类似什么问题你会用到？' },
  { role: 'assistant', text: '大概会是这几种：手上有报错、函数名、文件路径就直接 grep。' },
]
const msg = mutterMessages(sys, turns)

check('两条消息：system + user', Array.isArray(msg) && msg.length === 2, msg)
check('system 原样带上', msg[0].role === 'system' && msg[0].content === sys, msg[0])
check('正文在一条 user 消息里', msg[1].role === 'user', msg[1])

const lines = msg[1].content.split('\n')
check('user 那句标 user:', lines[0] === 'user: 类似什么问题你会用到？', lines[0])
check(
  'assistant 那句标 assistant:，不会被算成 user:',
  lines[1] === 'assistant: 大概会是这几种：手上有报错、函数名、文件路径就直接 grep。',
  lines[1],
)
check('正文里没有裸拼的段（每行都有标记）', lines.every((l) => /^(user|assistant): /.test(l)), lines)

// chat_turns / QQ 桥接里角色会写成 agent，同样归到 assistant
const agentMsg = mutterMessages(sys, [
  { role: 'user', text: '在吗' },
  { role: 'agent', text: '在。' },
])
const agentLines = agentMsg[1].content.split('\n')
check('agent 归一成 assistant:', agentLines[1] === 'assistant: 在。', agentLines)

// 空 text 不抛、不丢行
const empty = mutterMessages(sys, [{ role: 'user', text: '' }, { role: 'assistant' }])
check('空文本不抛且保留两行', empty[1].content.split('\n').length === 2, empty[1].content)

// materials（第 4 步）：真实的 feel / 咽回去的话放在对话前面，且不冒充对话行
const withMat = mutterMessages(sys, turns, ['（我自己之前写下的：有点想缩）', '（这一轮咽回去的半句：算了）'])
const mlines = withMat[1].content.split('\n')
check('材料在对话前', mlines[0] === '（我自己之前写下的：有点想缩）' && mlines[1] === '（这一轮咽回去的半句：算了）', mlines.slice(0, 2))
check('材料之后才是带标签的对话', mlines[3] === 'user: 类似什么问题你会用到？', mlines[3])
check('材料行不会被误判成对话行', !/^(user|assistant): /.test(mlines[0]) && !/^(user|assistant): /.test(mlines[1]), mlines.slice(0, 2))
check('空材料不多留空行', mutterMessages(sys, turns, [])[1].content === msg[1].content, null)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
