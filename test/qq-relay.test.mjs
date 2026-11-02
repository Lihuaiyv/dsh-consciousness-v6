/**
 * 网页说完一句，再推到 QQ（qq.relay.enable）。
 *
 * 三条要守住：
 *   1. 默认关：开关没开，这一轮什么都不发，也不写 qq.relay 事件；
 *   2. 开了但通道不通：回复照常返回，只记一条 qq.relay.failed，不抛错；
 *   3. QQ 自己起的回合不推回去（否则一句变两句）。
 *
 * 为了绝不误发真消息，base_url 固定指向一个没人监听的端口。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-relay-'))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(db, method, p, body = {}) {
  const req = { method, path: p, body: method === 'GET' ? body : { ...body, __idempotencyKey: 'k' + Math.random().toString(36).slice(2) }, token: 'user' }
  return handle(db, req)
}

// 注意：必须带 ORDER BY rowid。不带的话 SQLite 返回顺序不保证，
// slice(before) 会切到上一轮留下的旧事件，把「这次的 skipped」误判成「这次的 failed」。
const relayEvents = (db, aid) => db.prepare(
  "SELECT type FROM events WHERE agent_id=? AND (type LIKE 'qq.relay.%') ORDER BY rowid"
).all(aid).map((r) => r.type)

const db = openDb(path.join(dir, 'relay.db'))
const created = await call(db, 'POST', '/v1/agents', { name: '中转测试' })
const aid = created.body && created.body.id
check('建 agent 成功', !!aid, created)

// 通道指向没人监听的端口：开了也只会失败，绝不会真发到 QQ
const cfg = await call(db, 'PUT', `/v1/agents/${aid}/action-config`, {
  'qq.base_url': 'http://127.0.0.1:59999',
  'qq.default_target': '1234567890',
  'qq.default_target_type': 'private',
})
check('通道配置写入', cfg.status === 200, cfg)

// ① 默认关：这一轮不发
{
  const out = await call(db, 'POST', `/v1/agents/${aid}/chat`, { text: '默认关测试' })
  await sleep(400)
  check('默认回复正常', out.status === 200 && !!out.body.reply, out.status)
  check('默认关：没有任何 relay 事件', relayEvents(db, aid).length === 0, relayEvents(db, aid))
}

// ② 打开开关，但通道不通：回复照常，记 failed
{
  const set = await call(db, 'PUT', `/v1/agents/${aid}/params/qq.relay.enable`, { value: 'on' })
  check('开关能打开', set.status === 200, set)
  const out = await call(db, 'POST', `/v1/agents/${aid}/chat`, { text: '开了但发不出去测试' })
  await sleep(1500)
  check('通道不通：回复照常返回', out.status === 200 && !!out.body.reply, out.status)
  const ev = relayEvents(db, aid)
  check('通道不通：记一条 failed', ev.includes('qq.relay.failed'), ev)
  check('通道不通：没有误记 sent', !ev.includes('qq.relay.sent'), ev)
}

// ③ QQ 来的回合不推回去
{
  const before = relayEvents(db, aid).length
  const out = await call(db, 'POST', `/v1/agents/${aid}/chat`, {
    text: '这是 QQ 里说的话',
    conversation_id: 'qq:p:3192248859',
    speaker: { channel: 'qq', handle: '3192248859' },
  })
  await sleep(1500)
  check('QQ 回合回复正常', out.status === 200 && !!out.body.reply, out.status)
  check('QQ 回合不推回去', relayEvents(db, aid).length === before, relayEvents(db, aid))
}

// ④ 桥接插件接管后，网页这边的推送必须让路（否则同一句话发两遍）
{
  const before = relayEvents(db, aid).length
  const on = await call(db, 'PUT', `/v1/agents/${aid}/params/qq.bridge.enable`, { value: 'on' })
  check('桥接开关能打开', on.status === 200, on)
  const probe = await call(db, 'GET', `/v1/agents/${aid}/params`)
  const bridgeVal = (Array.isArray(probe.body) ? probe.body : []).find((x) => x.key === 'qq.bridge.enable')
  check('桥接开关读回来是 on', bridgeVal && bridgeVal.value === 'on', bridgeVal)
  const out = await call(db, 'POST', `/v1/agents/${aid}/chat`, { text: '桥接接管后的网页回复' })
  await sleep(800)
  check('桥接接管：回复照常', out.status === 200 && !!out.body.reply, out.status)
  const fresh = relayEvents(db, aid).slice(before)
  check('桥接接管：记一条 skipped', fresh.includes('qq.relay.skipped'), fresh)
  check('桥接接管：不尝试发送', !fresh.includes('qq.relay.sent') && !fresh.includes('qq.relay.failed'), fresh)
  await call(db, 'PUT', `/v1/agents/${aid}/params/qq.bridge.enable`, { value: 'off' })
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败', fail); process.exit(1) }