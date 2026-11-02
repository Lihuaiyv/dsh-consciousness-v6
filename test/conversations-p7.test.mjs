/**
 * P7：把某段会话改绑到别的角色。
 * 以前只有全局 default_agent，已经绑过的号改不动；这条接口补的就是这一块。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p7-'))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }
}
async function call(db, method, p, body = {}) {
  const req = { method, path: p, body: method === 'GET' ? body : { ...body, __idempotencyKey: 'k' + Math.random().toString(36).slice(2) }, token: 'user' }
  return handle(db, req)
}

const db = openDb(path.join(dir, 'p7.db'))
const A = (await call(db, 'POST', '/v1/agents', { name: '甲' })).body.id
const B = (await call(db, 'POST', '/v1/agents', { name: '乙' })).body.id
await call(db, 'PUT', '/v1/qq/settings', { default_agent: A, owner: '3192248859' })

const owner = { channel: 'qq', handle: '3192248859' }
const OWNER_CONV = 'qq:p:3192248859'

// ① 先用默认角色聊一句，会话自动绑到 A
{
  const r = await call(db, 'POST', '/v1/chat', { text: '你好', conversation_id: OWNER_CONV, speaker: owner, default_agent: A })
  check('默认绑到 A', r.body.agent_id === A, r.body.agent_id)
}

// ② 改绑到 B：下一句就该是 B 接
{
  const b = await call(db, 'POST', '/v1/conversations/bind', { conversation_id: OWNER_CONV, agent_id: B, handle: '3192248859' })
  check('绑定返回新角色名', b.status === 200 && b.body.agent_name === '乙', b.body)
  const r = await call(db, 'POST', '/v1/chat', { text: '你是谁', conversation_id: OWNER_CONV, speaker: owner, default_agent: A })
  check('改绑后由 B 回话', r.body.agent_id === B, r.body.agent_id)
  check('改绑不影响主人身份', r.body.learned === true, r.body.learned)
}

// ③ 只影响这一段：另一个号还是 A
{
  const r = await call(db, 'POST', '/v1/chat', { text: '你好呀', conversation_id: 'qq:p:5550009', speaker: { channel: 'qq', handle: '5550009' }, default_agent: A })
  check('别的号不受影响，仍归 A', r.body.agent_id === A, r.body.agent_id)
}

// ④ A 的记忆没被 B 串走
{
  const bMem = Number(db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND text LIKE '%你是谁%'").get(B).n)
  const aMem = Number(db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND text LIKE '%你是谁%'").get(A).n)
  check('B 记了这段', bMem > 0, bMem)
  check('A 没被写进同一句', aMem === 0, aMem)
}

// ⑤ 列表能按角色筛，并带出归属
{
  const all = await call(db, 'GET', '/v1/conversations')
  check('会话列表有两条', all.body.conversations.length >= 2, all.body.conversations.length)
  const onlyB = await call(db, 'GET', '/v1/conversations?agent_id=' + B)
  check('按角色筛只剩 B 的', onlyB.body.conversations.every((c) => c.agent_id === B) && onlyB.body.conversations.length >= 1, onlyB.body.conversations.length)
}

// ⑥ 释放：下一句回到默认角色 A
{
  const r = await call(db, 'DELETE', '/v1/conversations/' + encodeURIComponent(OWNER_CONV))
  check('释放成功', r.status === 200 && r.body.released === 1, r.body)
  const back = await call(db, 'POST', '/v1/chat', { text: '回来了吗', conversation_id: OWNER_CONV, speaker: owner, default_agent: A })
  check('释放后回到默认 A', back.body.agent_id === A, back.body.agent_id)
}

// ⑦ 坏输入：不存在的角色 / 缺参数 / 写权限
{
  const bad1 = await call(db, 'POST', '/v1/conversations/bind', { conversation_id: OWNER_CONV, agent_id: 'agt_nope' })
  check('不存在的角色被拒', bad1.status === 404, bad1.status)
  const bad2 = await call(db, 'POST', '/v1/conversations/bind', { conversation_id: '', agent_id: B })
  check('缺 conversation_id 被拒', bad2.status === 400, bad2.status)
  const req = { method: 'POST', path: '/v1/conversations/bind', body: { conversation_id: OWNER_CONV, agent_id: B, __idempotencyKey: 'kx' }, token: 'viewer' }
  const bad3 = await handle(db, req)
  check('viewer 不能改绑', bad3.status === 403, bad3.status)
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败', fail); process.exit(1) }
