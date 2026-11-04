/**
 * 生长序（B1 修正后）：只拦「世界观立核心」，不拦世界观进保护带。
 *
 * 旧规则「V 空则 W 不许新增」会死锁：V 要真实取舍才长，工程对话里没有取舍 → V 永远空 → W 永远不长。
 * 现在：growth_order=1 时，W 进保护带照常；但立核心要有据——
 *   要么 V 已经有活命题，要么它自己的预料被现实结算过两次、至少错一次。
 *
 * 运行：node test/sangguan-growth-order.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-growth-'))
process.env.DSH_HOME = home
const { openDb } = await import('../src/db.js')
const api = await import('../src/api.js')
const { append, newId } = await import('../src/modules/sangguan/ledger.js')
const { placeOne } = await import('../src/modules/sangguan/fast.js')
const proj = await import('../src/modules/sangguan/projection.js')
const { coreLaneGate, wCoreAllowed } = await import('../src/modules/sangguan/core.js')
const led = await import('../src/modules/sangguan/ledger.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const db = openDb(path.join(home, 'app.db'))
const aid = (await api.handle(db, { method: 'POST', path: '/v1/agents', token: 'user', body: { name: '生长序', __idempotencyKey: 'mk' } })).body.id
await api.handle(db, { method: 'PUT', path: '/v1/agents/' + aid + '/sangguan/config', token: 'user', body: { enabled: true, __idempotencyKey: 'on' } })

const at = () => new Date().toISOString()
const ctx = () => ({ db, aid, at: at() })
const wCand = { layer: 'W', kind: 'belt', text: '人和人之间，话不说透就容易生出猜疑' }

// ---------- 默认关：核心不拦 ----------
check('默认关：W 立核心不被拦', coreLaneGate('W', proj.loadState(db, aid)) === null)

// ---------- 打开：W 进保护带照常，但不许立核心 ----------
append(db, aid, [{ type: 'THETA_ADJUST', actor: 'user', at: at(), payload: { key: 'growth_order', value: 1, scope: '*' } }])
{
  const r = await placeOne(ctx(), wCand, ['t'])
  check('开了：W 仍能进保护带（旧版会拒）', !(r.cls === 'REJECT' && r.reason === 'growth_order'), r)
  const s = proj.loadState(db, aid)
  check('开了：V 空、W 没结算 → 不许立核心', coreLaneGate('W', s) === 'growth_order')
  check('开了：wCoreAllowed 为假', wCoreAllowed(s) === false)
}

// ---------- 出路一：V 有活命题 → 放行 ----------
append(db, aid, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'user', at: at(), payload: { claims: [{ layer: 'V', kind: 'norm', text: '我更看重把话说明白', origin: 'user' }] } }])
check('V 有活命题：放行立核心', coreLaneGate('W', proj.loadState(db, aid)) === null)

// ---------- 出路二：W 自己的预料被结算过两次、错一次 ----------
const db2 = openDb(path.join(home, 'app2.db'))
const aid2 = (await api.handle(db2, { method: 'POST', path: '/v1/agents', token: 'user', body: { name: '生长序2', __idempotencyKey: 'mk' } })).body.id
await api.handle(db2, { method: 'PUT', path: '/v1/agents/' + aid2 + '/sangguan/config', token: 'user', body: { enabled: true, __idempotencyKey: 'on' } })
led.append(db2, aid2, [{ type: 'THETA_ADJUST', actor: 'user', at: at(), payload: { key: 'growth_order', value: 1, scope: '*' } }])
const cid = newId('claims', at())
led.append(db2, aid2, [{
  type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: at(),
  payload: { claims: [{ id: cid, layer: 'W', kind: 'belt', text: '人难受时不是要答案', origin: 'extract' }] },
}])
const nu = (n) => newId('nus', at()) + n
const n1 = nu('a')
const n2 = nu('b')
led.append(db2, aid2, [{
  type: 'NU_REGISTER', actor: 'sys', at: at(),
  payload: { nus: [
    { id: n1, claim_id: cid, expect: '你会回得短', observe: '回复长度', p: 0.6, due_at: new Date(Date.now() + 7 * 86400000).toISOString() },
    { id: n2, claim_id: cid, expect: '你会主动再找我', observe: '有没有再发消息', p: 0.6, due_at: new Date(Date.now() + 14 * 86400000).toISOString() },
  ] },
}])
led.append(db2, aid2, [{ type: 'NU_RESOLVE', actor: 'sys', at: at(), payload: { nu_id: n1, outcome: 'hit' } }])
led.append(db2, aid2, [{ type: 'NU_RESOLVE', actor: 'sys', at: at(), payload: { nu_id: n2, outcome: 'miss' } }])
check('两次结算 + 一次 miss：放行立核心', coreLaneGate('W', proj.loadState(db2, aid2)) === null)

// ---------- 只有 hit，不算有据 ----------
const db3 = openDb(path.join(home, 'app3.db'))
const aid3 = (await api.handle(db3, { method: 'POST', path: '/v1/agents', token: 'user', body: { name: '生长序3', __idempotencyKey: 'mk' } })).body.id
await api.handle(db3, { method: 'PUT', path: '/v1/agents/' + aid3 + '/sangguan/config', token: 'user', body: { enabled: true, __idempotencyKey: 'on' } })
led.append(db3, aid3, [{ type: 'THETA_ADJUST', actor: 'user', at: at(), payload: { key: 'growth_order', value: 1, scope: '*' } }])
const cid3 = newId('claims', at())
led.append(db3, aid3, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: at(), payload: { claims: [{ id: cid3, layer: 'W', kind: 'belt', text: '世界大体是有回应的', origin: 'extract' }] } }])
const m1 = nu('c')
const m2 = nu('d')
led.append(db3, aid3, [{ type: 'NU_REGISTER', actor: 'sys', at: at(), payload: { nus: [
  { id: m1, claim_id: cid3, expect: 'a', observe: 'b', p: 0.6, due_at: new Date(Date.now() + 7 * 86400000).toISOString() },
  { id: m2, claim_id: cid3, expect: 'c', observe: 'd', p: 0.6, due_at: new Date(Date.now() + 8 * 86400000).toISOString() },
] } }])
led.append(db3, aid3, [{ type: 'NU_RESOLVE', actor: 'sys', at: at(), payload: { nu_id: m1, outcome: 'hit' } }])
led.append(db3, aid3, [{ type: 'NU_RESOLVE', actor: 'sys', at: at(), payload: { nu_id: m2, outcome: 'hit' } }])
check('只有 hit、没 miss：仍不放行立核心', coreLaneGate('W', proj.loadState(db3, aid3)) === 'growth_order')

// ---------- 不误伤 L / V ----------
check('L 不受生长序影响', coreLaneGate('L', proj.loadState(db, aid)) === null)
check('V 不受生长序影响', coreLaneGate('V', proj.loadState(db, aid)) === null)

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { db2.close() } catch { /* ignore */ }
try { db3.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
