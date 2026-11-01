/**
 * 偏好或禁忌顶到已有价值命题时只加压力边。不改 π，不改禁忌表。对不上的不动。
 * 运行：node test/sangguan-vdef-4.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { setValue } from '../src/modules/persona.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { pressValues } from '../src/modules/sangguan/values_intake.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-vdef4-'))
const db = openDb(path.join(dir, 'app.db'))
const T = '2026-11-01T12:00:00.000Z'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run('agt_p', 'p', 'daily', 'active', T)
setValue(db, 'agt_p', { key: 'benevolence', weight: 0.8 })
const before = Object.values(loadState(db, 'agt_p').claims)[0]
db.prepare('INSERT INTO preferences VALUES(?,?,?,?,?,?)').run('prf_hit', 'agt_p', '不要照顾身边的人', 0.4, 'manual', T)
db.prepare('INSERT INTO preferences VALUES(?,?,?,?,?,?)').run('prf_miss', 'agt_p', '喜欢安静', 0.2, 'manual', T)
db.prepare('INSERT INTO taboos VALUES(?,?,?,?,?,?)').run('tab_hit', 'agt_p', '不许照顾身边的人', 'soft', 'manual', T)
const taboosBefore = db.prepare('SELECT text, level FROM taboos WHERE id=?').get('tab_hit')

const opened = pressValues(db, 'agt_p', T)
const s = loadState(db, 'agt_p')
const edges = Object.values(s.edges).filter((e) => e.active && e.type === 'PRESSURE')
const after = s.claims[before.id]
check('顶到命题的偏好和禁忌各开一条压力', opened.opened === 2 && edges.length === 2
  && edges.some((e) => e.from_id === 'prf_hit' && e.to_id === before.id)
  && edges.some((e) => e.from_id === 'tab_hit' && e.to_id === before.id), { opened, edges })
check('对不上的偏好没有边', !edges.some((e) => e.from_id === 'prf_miss'))
check('压力不改 π', after.pi === before.pi && after.n === before.n, { before: before.pi, after: after.pi })
check('禁忌表原样', JSON.stringify(db.prepare('SELECT text, level FROM taboos WHERE id=?').get('tab_hit')) === JSON.stringify(taboosBefore))
check('没有因此多出命题', Object.keys(s.claims).length === 1)
const again = pressValues(db, 'agt_p', '2026-11-02T00:00:00.000Z')
check('同一对不再加第二条', again.opened === 0 && Object.values(loadState(db, 'agt_p').edges).filter((e) => e.type === 'PRESSURE').length === 2)

console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
