/**
 * 世界观 / 人生观不再读旧价值观表。两张表再怎么偏，这两层的推导不变。
 * 运行：node test/sangguan-vdef-2.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { growWorldview } from '../src/modules/worldview.js'
import { growLifeview } from '../src/modules/lifeview.js'
import { DIMS } from '../src/modules/values.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-vdef2-'))
const db = openDb(path.join(dir, 'app.db'))
// 旧库模拟：v6 之前有 persona_values 表；生产代码不再建它，测试自己造一份来验迁移/兼容
db.exec(`CREATE TABLE IF NOT EXISTS persona_values(agent_id TEXT NOT NULL, key TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.1, evidence TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(agent_id,key))`)
const T = '2026-11-01T12:00:00.000Z'
const add = (id) => db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, id, 'daily', 'active', T)
add('agt_bare')
add('agt_vals')
for (const [k] of DIMS) db.prepare('INSERT INTO persona_values VALUES(?,?,?,?,?)').run('agt_vals', k, k === 'benevolence' || k === 'achievement' ? 0.9 : 0.02, '[]', T)

const wBare = growWorldview(db, 'agt_bare', { force: true })
const wVals = growWorldview(db, 'agt_vals', { force: true })
const sameW = wBare.every((a) => {
  const b = wVals.find((x) => x.key === a.key)
  return b && a.weight === b.weight
})
check('旧价值观表不再改变世界观', sameW && wVals.every((x) => !(x.evidence || []).some((e) => e.source === 'values')), wVals.map((x) => [x.key, x.weight]))

const lBare = growLifeview(db, 'agt_bare', { force: true })
const lVals = growLifeview(db, 'agt_vals', { force: true })
const sameL = lBare.every((a) => {
  const b = lVals.find((x) => x.key === a.key)
  return b && a.weight === b.weight
})
check('旧价值观表不再改变人生观', sameL && lVals.every((x) => !(x.evidence || []).some((e) => e.source === 'values')), lVals.map((x) => [x.key, x.weight]))

console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
