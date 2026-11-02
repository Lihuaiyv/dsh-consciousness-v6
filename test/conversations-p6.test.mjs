/**
 * P6：通道健康（掉线告警）。
 * 桥在 / NapCat 在 / NapCat 掉线 / 桥整个没起，这四种要说得出是哪一种。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { probeBridge } from '../src/modules/conversations.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p6-'))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }
}
async function call(db, method, p, body = {}) {
  const req = { method, path: p, body: method === 'GET' ? body : { ...body, __idempotencyKey: 'k' + Math.random().toString(36).slice(2) }, token: 'user' }
  return handle(db, req)
}

// 假桥：可切换 QQ 在线 / 掉线
let qqMode = 'ok'
const fake = http.createServer((req, res) => {
  if (req.url.startsWith('/health')) {
    const body = qqMode === 'ok'
      ? { ok: true, uptime_sec: 42, defaultAgent: 'agt_x', dryRun: false, last_inbound_at: '2026-11-02T04:00:00Z', last_sent_at: '2026-11-02T04:00:01Z', inbound: 3, sent: 3, last_error: null, qq_ok: true, qq: { retcode: 0, data: { user_id: 2680603386, nickname: '某只鱼' } } }
      : { ok: true, uptime_sec: 42, defaultAgent: 'agt_x', dryRun: false, inbound: 3, sent: 3, last_error: 'ask: timeout', qq_ok: false, qq: { error: 'ECONNREFUSED' } }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  res.writeHead(404); res.end('no')
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const port = fake.address().port
const base = 'http://127.0.0.1:' + port

// ① 一切正常
{
  const h = await probeBridge(base)
  check('桥活着 + QQ 在线 = ok', h.ok === true, h)
  check('带出 QQ 昵称', h.napcat.nickname === '某只鱼', h.napcat)
  check('带出最后收发时间', !!h.bridge.last_inbound_at && !!h.bridge.last_sent_at, h.bridge)
  check('带出运行时长', h.bridge.uptime_sec === 42, h.bridge.uptime_sec)
}

// ② NapCat 掉线：桥还在，但 QQ 不在
{
  qqMode = 'down'
  const h = await probeBridge(base)
  check('NapCat 掉线时 ok=false', h.ok === false, h.ok)
  check('桥仍标记可达', h.bridge.reachable === true, h.bridge)
  check('说明是 QQ 那边的问题', h.napcat.ok === false && !!h.napcat.error, h.napcat)
  check('带出上次错误', h.bridge.last_error === 'ask: timeout', h.bridge.last_error)
  qqMode = 'ok'
}

// ③ 桥整个没起
{
  const h = await probeBridge('http://127.0.0.1:9', 400)
  check('桥没起时 ok=false', h.ok === false, h.ok)
  check('桥标记不可达', h.bridge.reachable === false, h.bridge)
}

// ④ 接口里能拿到「最近一段会话」
{
  const db = openDb(path.join(dir, 'p6.db'))
  const aid = (await call(db, 'POST', '/v1/agents', { name: '小测' })).body.id
  await call(db, 'PUT', '/v1/qq/settings', { default_agent: aid, owner: '3192248859' })
  await call(db, 'POST', '/v1/chat', { text: '你好', conversation_id: 'qq:p:3192248859', speaker: { channel: 'qq', handle: '3192248859' }, default_agent: aid })
  process.env.DSHC_BRIDGE = base
  const r = await call(db, 'GET', '/v1/qq/health')
  check('健康接口有结果', r.status === 200 && typeof r.body.ok === 'boolean', r.body)
  check('健康接口带最近会话', r.body.last_conversation && r.body.last_conversation.conversation_id === 'qq:p:3192248859', r.body.last_conversation)
  check('健康接口带 owner', r.body.owner === '3192248859', r.body.owner)
  delete process.env.DSHC_BRIDGE
  db.close()
}

fake.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败', fail); process.exit(1) }
