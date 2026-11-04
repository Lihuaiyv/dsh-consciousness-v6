/**
 * 日记 v2 · 模型通道形状回归测试
 * 现场 bug：diary 传 {role, text}，宿主适配器只读 content → 模型收到空 messages。
 * 运行：node test/diary-model-shape.test.mjs
 */
import { createModel, attachHostLlm } from '../src/model.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

let seen = null
const fakeLlm = {
  listProviders: () => [{ id: 'p' }],
  listModels: async () => [{ id: 'm' }],
  stream(opts) {
    seen = opts
    return (async function* () { yield { type: 'text-delta', text: '好' } })()
  },
}
const ctx = {
  get(name) {
    if (name === 'llm') return fakeLlm
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    return null
  },
}
attachHostLlm(() => ctx)
const m = createModel()

check('宿主模型通道可用', m.status().primary === 'ok', m.status())

{
  const out = await m.chatPrimary([
    { role: 'system', text: 'SYS' },
    { role: 'user', text: 'USER' },
  ], 100, false, 0.3)
  check('老写法 {role,text} 能跑通', out === '好', out)
  check('老写法：system 没丢', seen && seen.system === 'SYS', seen && seen.system)
  check('老写法：正文没丢', seen && seen.messages[0].content[0].text === 'USER', seen && seen.messages)
}

{
  const out = await m.chatPrimary([
    { role: 'system', content: 'SYS2' },
    { role: 'user', content: 'USER2' },
  ], 100, false, 0.3)
  check('标准写法 {role,content} 能跑通', out === '好', out)
  check('标准写法：system 没丢', seen && seen.system === 'SYS2', seen && seen.system)
  check('标准写法：正文没丢', seen && seen.messages[0].content[0].text === 'USER2', seen && seen.messages)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
