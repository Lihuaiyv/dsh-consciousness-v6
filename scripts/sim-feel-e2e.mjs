/**
 * feel 全链路端到端模拟（临时库，不碰线上）。
 * 运行：node scripts/sim-feel-e2e.mjs
 *
 * 走一遍真实顺序：
 *   ① 注入里有什么（触发句）
 *   ② 工具 description 里有什么（写法）
 *   ③ 调一次 feel → 落库
 *   ④ 下一轮注入里出现的「我上一句说出来之前」
 *   ⑤ 预算压到很紧时，触发句还在不在（单开额度）
 *   ⑥ 两次注入各占多少字
 */
import { makeWorld } from '../test/eval-persona/setup.mjs'
import { consciousnessBlock } from '../index.js'
import { createActionTools } from '../src/modules/actions/index.js'
import { FEEL_TRIGGER, FEEL_GUIDE } from '../src/modules/feel.js'
import { clampInjection } from '../src/modules/pack.js'

const w = makeWorld()
const { db, aid } = w
const tools = createActionTools({ getDb: () => db, getAgentId: () => aid })
const feel = tools.find((t) => t.name === 'feel')

const line = (s) => console.log('\n' + '─'.repeat(6) + ' ' + s + ' ' + '─'.repeat(6))
const show = (s) => console.log(String(s).trim())

line('① 注入里的触发句（每轮）')
const block0 = consciousnessBlock(db, aid)
const triggerLine = String(block0).split('\n').find((l) => l.includes('就调 feel 记一句')) || '(没找到)'
show(triggerLine)
console.log('  字数：', triggerLine.length)

line('② 工具 description（只在调用时看到）')
show(feel.description)
console.log('  字数：', feel.description.length)

line('③ 调一次 feel')
const r = await feel.execute({ text: '拆开之后发现里面是空的，反而更想继续拆' }, { agent: { id: 'sess_sim' } })
show(JSON.stringify(r))

line('④ 下一轮注入里多出来的那行')
const block1 = consciousnessBlock(db, aid)
const feelLine = String(block1).split('\n').find((l) => l.includes('我上一句说出来之前')) || '(没找到)'
show(feelLine)

line('⑤ 预算压到 200，触发句还在不在')
// 必须按真实形状传：带 key 的对象。纯字符串会被自动标成 #0，测不到 reservedKeys。
const lines = [
  { text: FEEL_TRIGGER, key: 'feelguide' },
  { text: '（随便一条长记忆）'.repeat(40), key: 'mem1' },
  { text: '（另一条）'.repeat(40), key: 'mem2' },
]
const packed = clampInjection(lines, 200, ['feelguide'])
show('保留：' + JSON.stringify([...packed.kept]))
show('丢掉：' + JSON.stringify(packed.dropped))
show('预算 200 之后实际 tokens：' + packed.tokens)
show('触发句还在正文里：' + packed.text.includes('就调 feel 记一句'))
show('trigger 被截断：' + !packed.text.includes('真没有，就不调'))

line('⑥ 两次注入各占多少字')
console.log('  写 feel 之前：', String(block0).length, '字')
console.log('  写 feel 之后：', String(block1).length, '字')
console.log('  差值：', String(block1).length - String(block0).length, '字')

line('⑦ 极端压力：100 条巨长记忆 + 预算 100，会不会卡死')
const big = [{ text: FEEL_TRIGGER, key: 'feelguide' }]
for (let i = 0; i < 100; i++) big.push({ text: '（很长的一条记忆内容）'.repeat(50), key: 'm' + i })
const t0 = Date.now()
const brutal = clampInjection(big, 100, ['feelguide'])
const ms = Date.now() - t0
show('耗时：' + ms + 'ms')
show('实际 tokens：' + brutal.tokens)
show('丢了 ' + brutal.dropped.length + ' 次')
show('触发句没被截断：' + brutal.text.includes('真没有，就不调'))
console.log('  → 结果：' + (ms < 3000 && brutal.text.includes('真没有，就不调') ? '正常退出，没卡死' : '有问题'))
