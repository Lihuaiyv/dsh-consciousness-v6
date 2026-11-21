// 验收（2026-11-18）：旧 fast 的历史读者接上 v4 当场
// 覆盖：表达档、自读、feel 落库、评估用的自状态行；过时/没有 v4 时退回旧 fast。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { setFlag } from '../src/kernel.js'
import { getAffect } from '../src/parts/affect/index.js'
import { selfStateLine } from '../src/parts/affect/index.js'
import { expressionState } from '../src/modules/expression_state.js'
import { applySelfRead } from '../src/modules/self_read.js'
import { recordFeel } from '../src/modules/feel.js'

let passed = 0
function check(name, ok, detail) {
  if (!ok) { console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); process.exit(1) }
  passed++
  console.log('ok', name)
}
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affect-live-'))
const db = openDb(path.join(dir, 'a.db'))
const aid = 'agt_live'
const t = new Date().toISOString()
db.prepare('INSERT INTO agents(id,name,created_at) VALUES(?,?,?)').run(aid, '小汐', t)
db.prepare('INSERT INTO affect_state(agent_id,primary_label,intensity,mood,updated_at) VALUES(?,?,?,?,?)').run(aid, 'calm', 0.5, 0.6, t)
db.prepare('INSERT INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)').run(aid, 0, 0.2, 0.0, 0.2, t, t)

/* 1) 没有 v4：读者用旧 fast */
let expr = expressionState({ affect: getAffect(db, aid) })
check('没有 v4：表达档的「fast」还是旧值 0', near(expr.fast, 0), expr.fast)

/* 2) 有 v4：表达档、自状态行都读当场 */
setFlag(db, 'affect.v4.valence', JSON.stringify({ v: 0.8, s: 0.9, n: 0.3, d: 0.85, label: '欣喜', at: new Date().toISOString(), conv: 'c' }))
expr = expressionState({ affect: getAffect(db, aid) })
check('有 v4：表达档的「fast」用当场投影 0.8', near(expr.fast, 0.8), expr.fast)
check('有 v4：自状态行写的是「当场 S/N/D」', /当场 S 0\.90/.test(selfStateLine(db, aid)) && /欣喜/.test(selfStateLine(db, aid)), selfStateLine(db, aid))

/* 3) 自读：v4 在的时候只当观察，不回头拨旧 fast */
const sr = applySelfRead(db, aid, '谢谢你，我今天真的好开心，你真好')
check('自读：v4 在场时不改旧 fast（只观察）', sr.applied === false && sr.reason === 'v4_live', sr)
const fastAfter = Number(db.prepare('SELECT fast FROM affect_v3 WHERE agent_id=?').get(aid).fast)
check('自读：v4 在场时 fast 列没被写', near(fastAfter, 0, 0.0001), fastAfter)

/* 4) feel 落库：fast 列装的是当场投影 */
const rf = recordFeel(db, aid, { text: '这下终于稳了', source: 'tool' })
const row = rf.ok ? db.prepare('SELECT fast,slow,total FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid) : null
check('feel：当场投影进 fast 列（0.8）', row && near(row.fast, 0.8, 0.001), { rf, row })
check('feel：总情绪 = 慢 0.2 + 0.35×0.8 = 0.48', row && near(row.total, 0.48, 0.001), row)

/* 5) v4 过时：全体退回旧 fast */
setFlag(db, 'affect.v4.valence', JSON.stringify({ v: 0.8, s: 0.9, n: 0.3, d: 0.85, label: '欣喜', at: new Date(Date.now() - 3 * 3600000).toISOString(), conv: 'c' }))
expr = expressionState({ affect: getAffect(db, aid) })
check('v4 过时：表达档退回旧 fast 0', near(expr.fast, 0), expr.fast)
check('v4 过时：自状态行退回「慢情绪/快情绪」', /慢情绪 .*快情绪/.test(selfStateLine(db, aid)), selfStateLine(db, aid))

db.close()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
console.log(`\n${passed} 项全过`)
