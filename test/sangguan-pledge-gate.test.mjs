/**
 * P3 承诺归位：问句、反问、判断句不能变成「我答应：…」。
 * 运行：node test/sangguan-pledge-gate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-pledge-'))
process.env.DSH_HOME = home
const { openDb } = await import('../src/db.js')
const api = await import('../src/api.js')
const { extractPledges, registerPledges } = await import('../src/modules/sangguan/pledge.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const at = '2026-11-02T06:00:00.000Z'

// ---------- 抽不出来：问句 / 判断句 / 条件句 ----------
const BAD = [
  '我答应：不是今天哪个设置改了把我的语气改掉的',
  '是不是今天哪个设置改了？我明天去看看',
  '明天是不是你改的？',
  '我明天不一定去',
  '如果明天不下雨我就去',
]
for (const t of BAD) check('不抽：' + t.slice(0, 16), extractPledges(t, at).length === 0, extractPledges(t, at))

// ---------- 抽得出来：真承诺 ----------
const GOOD = [
  '我明天把脚本补上。',
  '我会在下周一给你答复。',
  '我后天去核对一遍。',
]
for (const t of GOOD) check('抽：' + t.slice(0, 16), extractPledges(t, at).length === 1, extractPledges(t, at))

// ---------- 登记：坏的进不来 ----------
const db = openDb(path.join(home, 'app.db'))
const aid = (await api.handle(db, { method: 'POST', path: '/v1/agents', token: 'user', body: { name: '承诺', __idempotencyKey: 'mk' } })).body.id
await api.handle(db, { method: 'PUT', path: '/v1/agents/' + aid + '/sangguan/config', token: 'user', body: { enabled: true, __idempotencyKey: 'on' } })

const bad = registerPledges(db, aid, { text: '我答应：不是今天哪个设置改了把我的语气改掉的', at })
check('判断句不登记', bad.registered.length === 0, bad)

const good = registerPledges(db, aid, { text: '我明天把脚本补上。', at })
check('真承诺登记一条', good.registered.length === 1, good)
if (good.registered.length) {
  const row = db.prepare('SELECT kind, text FROM persona_claims WHERE id=?').get(good.registered[0].claim_id)
  check('记成 commit', row && row.kind === 'commit', row)
  check('文本是人话（不是片段）', row && /^我答应：.*(补|写|做|去|给|修)/.test(row.text), row && row.text)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
