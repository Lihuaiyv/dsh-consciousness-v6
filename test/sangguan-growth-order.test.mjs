/**
 * P4 生长序：价值观一条活的都没有时，世界观不许先长（默认关，开了才生效）。
 * 运行：node test/sangguan-growth-order.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-growth-'))
process.env.DSH_HOME = home
const { openDb } = await import('../src/db.js')
const api = await import('../src/api.js')
const { append } = await import('../src/modules/sangguan/ledger.js')
const { placeOne } = await import('../src/modules/sangguan/fast.js')
const { readEvents } = await import('../src/modules/sangguan/ledger.js')

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
const rej = () => readEvents(db, aid, { types: ['REJECT'] }).filter((e) => e.gate_report && e.gate_report.reason === 'growth_order')

// ---------- 默认关：W 照常进来 ----------
{
  const r = await placeOne(ctx(), wCand, ['t'])
  check('默认关：W 不被生长序拦', r.cls !== 'REJECT' || r.reason !== 'growth_order', r)
  check('默认关：没有 growth_order 拒收', rej().length === 0, rej())
}

// ---------- 打开：W 被拦 ----------
const db2 = openDb(path.join(home, 'app2.db'))
const aid2 = (await api.handle(db2, { method: 'POST', path: '/v1/agents', token: 'user', body: { name: '生长序2', __idempotencyKey: 'mk' } })).body.id
await api.handle(db2, { method: 'PUT', path: '/v1/agents/' + aid2 + '/sangguan/config', token: 'user', body: { enabled: true, __idempotencyKey: 'on' } })
append(db2, aid2, [{ type: 'THETA_ADJUST', actor: 'user', at: at(), payload: { key: 'growth_order', value: 1, scope: '*' } }])
const ctx2 = () => ({ db: db2, aid: aid2, at: at() })
const rej2 = () => readEvents(db2, aid2, { types: ['REJECT'] }).filter((e) => e.gate_report && e.gate_report.reason === 'growth_order')

{
  const r = await placeOne(ctx2(), wCand, ['t'])
  check('开了：V 空时 W 被拒', r.cls === 'REJECT' && r.reason === 'growth_order', r)
  check('开了：拒收留了账（gate_report.reason）', rej2().length === 1, rej2().length)
}

// ---------- V 有了活的，W 放行 ----------
append(db2, aid2, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'user', at: at(), payload: { claims: [{ layer: 'V', kind: 'norm', text: '我更看重把话说明白', origin: 'user' }] } }])
{
  const r = await placeOne(ctx2(), wCand, ['t'])
  check('V 有活命题后：W 不再被生长序拦', r.cls !== 'REJECT' || r.reason !== 'growth_order', r)
}

// ---------- 不误伤 V / L ----------
{
  const r = await placeOne(ctx2(), { layer: 'L', kind: 'chapter', text: '我想弄清楚陪一个人到底是什么意思' }, ['t'])
  check('L 不受生长序影响', r.cls !== 'REJECT' || r.reason !== 'growth_order', r)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { db2.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
