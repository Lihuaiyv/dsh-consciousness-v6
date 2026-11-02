/**
 * P3：记忆闸。
 * 陌生人照常聊、照常落自己会话的账，但不许进长期记忆/关系账本；
 * 主人号（默认 3192248859）照旧学。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { buildReplySystem } from '../src/model.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p3-'))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }
}
async function call(db, method, p, body = {}) {
  const req = { method, path: p, body: method === 'GET' ? body : { ...body, __idempotencyKey: 'k' + Math.random().toString(36).slice(2) }, token: 'user' }
  return handle(db, req)
}
const count = (db, sql, ...args) => Number(db.prepare(sql).get(...args).n || 0)

const db = openDb(path.join(dir, 'p3.db'))
const made = await call(db, 'POST', '/v1/agents', { name: '小测' })
const aid = made.body.id
await call(db, 'PUT', '/v1/qq/settings', { default_agent: aid, owner: '3192248859' })

const baseMem = count(db, 'SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid)
const baseAxis = count(db, 'SELECT COUNT(*) n FROM axis_evidence WHERE agent_id=?', aid)
const baseRelEv = count(db, 'SELECT COUNT(*) n FROM rel_evidence WHERE agent_id=?', aid)
const baseTurns = count(db, 'SELECT COUNT(*) n FROM chat_turns WHERE agent_id=?', aid)

// ① 陌生人连发 3 句
for (const t of ['你好', '我叫路人甲', '我最喜欢吃火锅了']) {
  const r = await call(db, 'POST', '/v1/chat', {
    text: t, conversation_id: 'qq:p:222',
    speaker: { channel: 'qq', handle: '222' }, default_agent: aid,
  })
  check('陌生人也能正常回 [' + t + ']', r.status === 200 && !!r.body.reply, r.body)
  check('回应标记 learned=false [' + t + ']', r.body.learned === false, r.body.learned)
}

const afterMem = count(db, 'SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid)
const afterAxis = count(db, 'SELECT COUNT(*) n FROM axis_evidence WHERE agent_id=?', aid)
const afterRelEv = count(db, 'SELECT COUNT(*) n FROM rel_evidence WHERE agent_id=?', aid)
const afterTurns = count(db, 'SELECT COUNT(*) n FROM chat_turns WHERE agent_id=?', aid)

check('陌生人话没进长期记忆', afterMem === baseMem, { baseMem, afterMem })
check('陌生人话没进五轴证据', afterAxis === baseAxis, { baseAxis, afterAxis })
check('陌生人话没进关系证据', afterRelEv === baseRelEv, { baseRelEv, afterRelEv })
check('陌生人话照样落自己的会话账', afterTurns - baseTurns === 6, { baseTurns, afterTurns })
check('陌生人会话单独成行',
  count(db, "SELECT COUNT(*) n FROM conversations WHERE conversation_id='qq:p:222'") === 1)

// ② 主人号：照旧学
const memBeforeOwner = count(db, 'SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid)
const r2 = await call(db, 'POST', '/v1/chat', {
  text: '我最近在弄记忆检索', conversation_id: 'qq:p:3192248859',
  speaker: { channel: 'qq', handle: '3192248859' }, default_agent: aid,
})
check('主人回话 learned=true', r2.status === 200 && r2.body.learned === true, r2.body)
const memAfterOwner = count(db, 'SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid)
check('主人的话会进长期记忆', memAfterOwner > memBeforeOwner, { memBeforeOwner, memAfterOwner })

// ③ 陌生人：不给私有上下文、不用主人称呼、不许承诺记住
{
  const sysOwner = buildReplySystem({ style: { address: '主人' }, isOwner: true, contextBlock: 'PRIVATE' })
  const sysGuest = buildReplySystem({ style: { address: '主人' }, isOwner: false, contextBlock: '' })
  check('有包时称呼不复述（包里已有）', !sysOwner.includes('称呼对方为「主人」'), sysOwner.slice(0, 80))
  check('无包时才补称呼', buildReplySystem({ style: { address: '主人' }, isOwner: true }).includes('称呼对方为「主人」'))
  check('陌生人提示不叫主人', !sysGuest.includes('称呼对方为「主人」') && sysGuest.includes('不是主人'), sysGuest.slice(0, 120))
  check('陌生人提示不许承诺记住', sysGuest.includes('不要承诺'), sysGuest.slice(-120))
  const g = await call(db, 'POST', '/v1/chat', {
    text: '你好呀', conversation_id: 'qq:p:666',
    speaker: { channel: 'qq', handle: '666' }, default_agent: aid,
  })
  check('陌生人回包不带意识体包', g.status === 200 && g.body.context_chars === 0, g.body.context_chars)
}

// ④ 换主人号后，老主人也不算主人了
await call(db, 'PUT', '/v1/qq/settings', { owner: '888' })
const memBefore = count(db, 'SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid)
const r3 = await call(db, 'POST', '/v1/chat', {
  text: '我还是主人呀', conversation_id: 'qq:p:3192248859b',
  speaker: { channel: 'qq', handle: '3192248859' }, default_agent: aid,
})
check('换主人号后旧号降级', r3.status === 200 && r3.body.learned === false, r3.body)
check('降级后不再写记忆', count(db, 'SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid) === memBefore)

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败', fail); process.exit(1) }
