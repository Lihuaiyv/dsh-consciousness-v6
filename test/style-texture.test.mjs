/**
 * 说话质感：表达卡（P2）与文体清单（P3）。
 * 运行：node test/style-texture.test.mjs
 */
import { styleLine, wishLine, expressionState, feltLine, cardLine } from '../src/modules/expression_state.js'
import { expressionFrom } from '../src/algo/expression.js'
import { clampInjection } from '../src/features.js'
import { examplesBlock } from '../src/modules/examples.js'
import { detectMode, resolveMode, guardBlock, styleInjection, styleText } from '../src/modules/style_mode.js'
import { noteStyleMode, styleModeCache } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

// ---- 表达卡
{
  const levels = ['quiet', 'brief', 'normal', 'warm']
  check('四档都有话', levels.every((l) => styleLine({ level: l }).length > 0))
  check('四档各不相同', new Set(levels.map((l) => styleLine({ level: l }))).size === 4)
  check('未知档退回 normal', styleLine({ level: '乱写' }) === styleLine({ level: 'normal' }))
  check('空参数不炸', styleLine() === styleLine({ level: 'normal' }))
  check('说的是倾向不是命令', !/只准|必须|禁止|只能说/.test(styleLine({ level: 'quiet' })))
  check('quiet 要求停', /停/.test(styleLine({ level: 'quiet' })))
  check('warm 允许多说但不列点', /多说/.test(styleLine({ level: 'warm' })) && /不列点/.test(styleLine({ level: 'warm' })))
  // 短 ≠ 低头：只约束「说多少」的话，模型会自己补上道歉和检讨的口吻
  check('短档写明不用道歉/检讨', /道歉|检讨/.test(styleLine({ level: 'quiet' })) && /检讨/.test(styleLine({ level: 'brief' })))
  check('短档不是命令口吻', !/不要道歉|不许|禁止/.test(styleLine({ level: 'quiet' })))
  check('每句都短', levels.every((l) => Array.from(styleLine({ level: l })).length <= 24), levels.map((l) => Array.from(styleLine({ level: l })).length))
}

// ---- 与情绪档联动
{
  // 慢情绪很低 → quiet；很高 → warm
  const low = expressionState({ affect: { v3: { slow: -0.8, total: -0.5 }, intensity: 0.3, primary_label: 'lost' } })
  const high = expressionState({ affect: { v3: { slow: 0.6, total: 0.5 }, intensity: 0.3, primary_label: 'joy' } })
  check('低落时表达卡也变短', low.level === 'quiet' && low.style === styleLine({ level: 'quiet' }), low)
  check('高兴时表达卡允许多说', high.level === 'warm' && high.style === styleLine({ level: 'warm' }), high)
  check('wish 与 style 不重复', low.wish !== low.style)
}

// ---- 预算保护：这一行不该被整行丢掉
{
  const lines = [
    '## 意识体：小汐',
    '你现在就是「小汐」。',
    '感觉现在大概的情绪是：挺高兴。',
    '我想怎么说：就正常说，说完就停。',
    '现在：现在是晚上；我上一句说的是「嗯，我在」。',
    '最近我自己写下的（日记）：\n- 今天改了一堆东西。'.repeat(3),
  ]
  const out = clampInjection(lines, 60)
  check('超预算时表达卡还在', out.text.includes('我想怎么说'), out)
  check('丢的是日记不是表达卡', out.dropped.includes('diary'), out.dropped)
}

// ---- 示例按档走，不再每轮全量
{
  const quietN = examplesBlock(null, { level: 'quiet' }).split('\n').length
  const warmN = examplesBlock(null, { level: 'warm' }).split('\n').length
  check('低落时例子更少', quietN < warmN, { quietN, warmN })
}

// ---- 模式判定（P3）
{
  const work = [
    '帮我改一下 src/api.js 的报错',
    '```js\nconst a = 1\n```',
    'C:\\Users\\x\\app.db 读一下',
    'pnpm test 跑一遍',
    '这个函数返回 undefined',
    '数据库那块编译不过',
  ]
  const chat = ['今天好累', '你觉得呢', '嗯', '在吗', '我有点想你', '晚安', '随便聊聊', '']
  check('干活的话判成 work', work.every((t) => detectMode(t) === 'work'), work.filter((t) => detectMode(t) !== 'work'))
  check('闲聊的话判成 chat', chat.every((t) => detectMode(t) === 'chat'), chat.filter((t) => detectMode(t) !== 'chat'))
  check('空话不判成干活', detectMode('') === 'chat' && detectMode(null) === 'chat')

  check('参数显式 chat 覆盖判定', resolveMode('chat', 'work') === 'chat')
  check('参数显式 work 覆盖判定', resolveMode('work', 'chat') === 'work')
  check('auto 跟缓存走', resolveMode('auto', 'work') === 'work' && resolveMode('auto', 'chat') === 'chat')
  check('auto 没缓存当闲聊', resolveMode(undefined, undefined) === 'chat')
  check('乱写的参数当 auto', resolveMode('乱写', 'work') === 'work')
}

// ---- 文体清单
{
  check('off 不给清单', guardBlock('off') === '')
  check('soft 有三条禁令', /不要列点/.test(guardBlock('soft')) && /不要用「总之/.test(guardBlock('soft')))
  check('strong 更严', guardBlock('strong').length > guardBlock('soft').length && /首先/.test(guardBlock('strong')))
  check('没传按 soft', guardBlock() === guardBlock('soft'))
}

// ---- 组合：闲聊才加，干活不加
{
  const chat = styleInjection({ mode: 'chat', level: 'normal', guard: 'soft' })
  const work = styleInjection({ mode: 'work', level: 'normal', guard: 'soft' })
  // 「怎么说」并进了表达卡（index.js 用 cardLine 注入），这里只剩清单一条
  check('闲聊只给清单一条', Array.isArray(chat) && chat.length === 1, chat)
  check('清单说的是不要什么', chat[0].startsWith('不要列点'), chat[0])
  check('干活一行都不给', Array.isArray(work) && work.length === 0, work)
  check('guard=off 什么都不给', styleInjection({ mode: 'chat', guard: 'off' }).length === 0)
  check('档位影响表达卡', cardLine({ level: 'quiet' }) !== cardLine({ level: 'warm' }))
  check('表达卡与 styleText 同源', styleText('warm') === cardLine({ level: 'warm' }))
}

// ---- 缓存：最近一句记下来的模式
{
  check('noteStyleMode 返回并记住', noteStyleMode('agt_1', '改一下 src/a.js') === 'work' && styleModeCache.get('agt_1') === 'work')
  check('下一句改回闲聊', noteStyleMode('agt_1', '今天好累') === 'chat' && styleModeCache.get('agt_1') === 'chat')
  check('不同实例互不串台', noteStyleMode('agt_2', 'pnpm test') === 'work' && styleModeCache.get('agt_1') === 'chat')
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
