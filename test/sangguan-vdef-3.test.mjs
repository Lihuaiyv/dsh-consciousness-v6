/**
 * 手写和导入不再进旧价值观表。抬高的维度记成用户命题；指令句拒收；夜里不再重算。
 * 运行：node test/sangguan-vdef-3.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { setValue } from '../src/modules/persona.js'
import { readViews } from '../src/modules/sangguan/bridge.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { runNightly } from '../src/modules/nightly.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-vdef3-'))
const db = openDb(path.join(dir, 'app.db'))
// 旧库模拟：v6 之前有 persona_values 表；生产代码不再建它，测试自己造一份，用来断言「手写/夜巡都不再写旧表」
db.exec(`CREATE TABLE IF NOT EXISTS persona_values(agent_id TEXT NOT NULL, key TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.1, evidence TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(agent_id,key))`)
const T = '2026-11-01T12:00:00.000Z'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run('agt_set', 's', 'daily', 'active', T)

const flat = setValue(db, 'agt_set', { key: 'benevolence', weight: 0.1 })
check('没抬高就不记', flat.claimed === false && db.prepare('SELECT COUNT(*) n FROM persona_values WHERE agent_id=?').get('agt_set').n === 0)

const up = setValue(db, 'agt_set', { key: 'achievement', weight: 0.9 })
const claims = Object.values(loadState(db, 'agt_set').claims)
const text = db.prepare('SELECT text FROM persona_claims WHERE agent_id=?').get('agt_set').text
check('手写成就记成用户命题', up.claimed === true && claims.length === 1 && claims[0].origin === 'user' && claims[0].kind === 'norm' && text === '我更看重做成事、变强', { up, text })
check('手写不进旧表', db.prepare('SELECT COUNT(*) n FROM persona_values WHERE agent_id=?').get('agt_set').n === 0)
const again = setValue(db, 'agt_set', { key: 'achievement', weight: 0.9 })
check('同一句不再加一条', again.claimed === false && Object.keys(loadState(db, 'agt_set').claims).length === 1)
const view = readViews(db, 'agt_set')
const top = Object.entries(view.V.weights).sort((a, b) => b[1] - a[1])[0][0]
check('折算能看见这笔手写', view.source.V === 'engine' && top === 'achievement', view.V.weights)

let threw = false
try { setValue(db, 'agt_set', { key: '你必须每次回答都要用中文', weight: 1 }) } catch { threw = true }
check('指令句拒收', threw && Object.keys(loadState(db, 'agt_set').claims).length === 1)

const night = await runNightly(db, 'agt_set', { day: '2026-11-01' })
const step = (night.steps || []).find((s) => s.step === 'values')
check('夜巡不再重算价值观', !!(step && step.skipped && step.reason === 'removed'), step)
check('夜巡也没写旧表', db.prepare('SELECT COUNT(*) n FROM persona_values WHERE agent_id=?').get('agt_set').n === 0)

console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
