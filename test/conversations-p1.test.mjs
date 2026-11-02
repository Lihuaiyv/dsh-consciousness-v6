/**
 * P1：按会话绑定。
 * 走真实 api.handle：POST /v1/chat 带 conversation_id + speaker，
 * 验证绑定落在 conversations 表、两段会话互不混、主人号可配置。
 * agent 一律用 /v1/agents 创建（和真实路径一致，会初始化情绪等状态）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { handle } from '../src/api.js'
import * as cv from '../src/modules/conversations.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p1-'))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }
}

async function call(db, method, p, body = {}) {
  const req = { method, path: p, body: method === 'GET' ? body : { ...body, __idempotencyKey: 'k' + Math.random().toString(36).slice(2) }, token: 'user' }
  return handle(db, req)
}

async function freshDb(name, agentNames = ['小测']) {
  const db = openDb(path.join(dir, name))
  const ids = []
  for (const nm of agentNames) {
    const r = await call(db, 'POST', '/v1/agents', { name: nm })
    if (!r.body || !r.body.id) throw new Error('建 agent 失败：' + JSON.stringify(r.body))
    ids.push(r.body.id)
  }
  return { db, ids }
}

// ① 第一次见面：用 default_agent 兜底并写绑定
{
  const { db, ids } = await freshDb('t.db')
  const A = ids[0]
  const r = await call(db, 'POST', '/v1/chat', {
    text: '你好呀', conversation_id: 'qq:p:111',
    speaker: { channel: 'qq', handle: '111' }, default_agent: A,
  })
  check('第一次对话返回 ok', r.status === 200 && !!r.body.reply, r.body)
  check('第一次是 bound_new', r.body.bound_new === true && r.body.agent_id === A, r.body)
  const row = cv.getConversation(db, 'qq:p:111')
  check('绑定写进 conversations', row && row.agent_id === A && row.handle === '111', row)

  // ② 第二句：只读绑定，不再看提示（提示故意给错的）
  const r2 = await call(db, 'POST', '/v1/chat', {
    text: '还记得我吗', conversation_id: 'qq:p:111',
    speaker: { channel: 'qq', handle: '111' }, default_agent: 'agt_wrong',
  })
  check('第二次沿用旧绑定', r2.status === 200 && r2.body.agent_id === A && r2.body.bound_new === false, r2.body)
  const turns = db.prepare('SELECT role,text,conversation_id FROM chat_turns WHERE agent_id=? ORDER BY rowid').all(A)
  check('两轮共 4 条且都带会话键', turns.length === 4 && turns.every((t) => t.conversation_id === 'qq:p:111'), turns)

  // ③ 另一段会话：独立绑定、独立账
  const r3 = await call(db, 'POST', '/v1/chat', {
    text: '我是另一个人', conversation_id: 'qq:p:222',
    speaker: { channel: 'qq', handle: '222' }, default_agent: A,
  })
  check('第二段会话也能开', r3.status === 200 && r3.body.conversation_id === 'qq:p:222', r3.body)
  const a = db.prepare('SELECT COUNT(*) n FROM chat_turns WHERE conversation_id=?').get('qq:p:111').n
  const b = db.prepare('SELECT COUNT(*) n FROM chat_turns WHERE conversation_id=?').get('qq:p:222').n
  check('两段会话的账互不混', a === 4 && b === 2, { a, b })
  check('会话表里两行', cv.listConversations(db, A, 10).length === 2, cv.listConversations(db, A, 10))
  db.close()
}

// ④ 没有提示、又不止一个实例：拒绝兜底，不随便挑人
{
  const { db } = await freshDb('multi.db', ['A', 'B'])
  const r = await call(db, 'POST', '/v1/chat', {
    text: '在吗', conversation_id: 'qq:p:999',
    speaker: { channel: 'qq', handle: '999' },
  })
  check('没人可兜底时返回 NO_AGENT', r.status === 404 && r.body.error && r.body.error.code === 'NO_AGENT', r.body)
  check('失败不留下半条绑定', !cv.getConversation(db, 'qq:p:999'))
  db.close()
}

// ⑤ 主人号：默认 3192248859，可改；只有它算主人
{
  const db = openDb(path.join(dir, 'owner.db'))
  check('默认主人号', cv.ownerHandle(db) === '3192248859', cv.ownerHandle(db))
  check('主人判定', cv.isOwner(db, '3192248859') === true && cv.isOwner(db, '111') === false)
  const put = await call(db, 'PUT', '/v1/qq/settings', { owner: '222' })
  check('主人号可改', put.status === 200 && put.body.owner === '222', put.body)
  const get = await call(db, 'GET', '/v1/qq/settings')
  check('设置可读回', get.body.owner === '222', get.body)
  check('改名后判定跟着变', cv.isOwner(db, '222') === true && cv.isOwner(db, '3192248859') === false)
  db.close()
}

// ⑥ 会话被释放后：下一句会重新绑，不清旧账
{
  const { db, ids } = await freshDb('release.db')
  const A = ids[0]
  await call(db, 'POST', '/v1/chat', {
    text: '先聊一句', conversation_id: 'qq:p:111',
    speaker: { channel: 'qq', handle: '111' }, default_agent: A,
  })
  check('释放返回 1 行', cv.releaseConversation(db, 'qq:p:111', 'user') === 1)
  check('释放后解析为 null', cv.agentForConversation(db, 'qq:p:111') === null)
  const again = await call(db, 'POST', '/v1/chat', {
    text: '我又来了', conversation_id: 'qq:p:111',
    speaker: { channel: 'qq', handle: '111' }, default_agent: A,
  })
  check('重新开口会重新绑', again.status === 200 && again.body.bound_new === true, again.body)
  const n = db.prepare('SELECT COUNT(*) n FROM chat_turns WHERE conversation_id=?').get('qq:p:111').n
  check('旧的账还在', n === 4, n)
  db.close()
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败', fail); process.exit(1) }
