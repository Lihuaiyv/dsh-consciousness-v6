/**
 * 收信·认件零件 · 考卷
 *
 * 管的是「平台递进来的事件，认成谁、说了什么」：只认事件名和消息体形状，
 * 不碰平台内部，也不碰会话、记忆、回复。
 *
 * 运行：node test/exam-inbox.test.mjs
 */
import { HOST_EVENTS, messageText, readEvent } from '../src/host/events.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

// ================================================================ 认事件名
{
  const u = readEvent({ type: HOST_EVENTS.userMessage, data: { content: '  你好呀  ' } })
  check('用户消息：认成 user，去掉首尾空白', u.kind === 'user' && u.text === '你好呀', u)

  const a = readEvent({ type: HOST_EVENTS.assistantMessage, data: { message: { content: [{ type: 'text', text: '在的' }] } } })
  check('助手消息：认成 assistant', a.kind === 'assistant' && a.text === '在的', a)

  const other = readEvent({ type: 'session/start', data: {} })
  check('别的事件：other，空文本', other.kind === 'other' && other.text === '', other)

  check('空事件：不炸', (() => { const r = readEvent(null); return r.kind === 'other' && r.text === '' })())
  check('事件名不是字符串：不炸', (() => { const r = readEvent({ type: 42 }); return r.kind === 'other' })())
}

// ================================================================ 认消息体
{
  check('字符串 content：原样取回', messageText({ content: '一句话' }) === '一句话')
  check('数组 content：文本块拼起来，别的块跳过',
    messageText({ content: [{ type: 'text', text: '第一句' }, { type: 'image', url: 'x' }, { type: 'text', text: '第二句' }] }) === '第一句\n第二句')
  check('数组里坏块跳过不炸',
    messageText({ content: [null, { type: 'text' }, { type: 'text', text: '好的' }] }) === '好的')
  check('content 不是字符串也不是数组：空', messageText({ content: 42 }) === '')
  check('没有 message：空', messageText(null) === '')
  check('只有空白：空', messageText({ content: '   \n ' }) === '')
  check('assistant 的 data 少了 message：assistant + 空文本',
    (() => { const r = readEvent({ type: HOST_EVENTS.assistantMessage, data: {} }); return r.kind === 'assistant' && r.text === '' })())
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
