/**
 * Shadow 观测聚合：余量 / 内心行落账 / 记忆来源。
 * 运行：node test/shadow-report.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { nid, setParam } from '../src/kernel.js'
import { addMemory } from '../src/modules/memory.js'
import { recordSelfResidue, shadowReport } from '../src/modules/self_residue.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}
const evt = (db, aid, type, payload) => db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
  .run(nid('evt_'), aid, type, JSON.stringify(payload), now())

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-shadow-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_shadow'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '观测', 'daily', 'active', now())

// 3 条余量：2 冷 1 暖；1 条提示；1 条结算
recordSelfResidue(db, aid, { dir: 'cold', delta: -0.5, warmth: -0.4, expected: 0.2 })
recordSelfResidue(db, aid, { dir: 'cold', delta: -0.6, warmth: -0.5, expected: 0.2 })
recordSelfResidue(db, aid, { dir: 'warm', delta: 0.5, warmth: 0.6, expected: 0.1 })
evt(db, aid, 'rel.self_residue.shown', { residue_id: 'r1' })
evt(db, aid, 'rel.self_residue.settled', { ids: ['r1', 'r2'], dir: 'cold', v: -0.08, changed: 1 })

// 内心行：主动消息落账 1、开环丢弃 1
evt(db, aid, 'inject.mind_committed', { key: 'proactive' })
evt(db, aid, 'inject.mind_dropped', { key: 'loop' })

// 记忆来源：1 条转述低置信、1 条自己看到的
addMemory(db, aid, { text: '从聊天里记下：主人在改接线。', type: 'fact', source: 'extract', confidence: 0.5 })
addMemory(db, aid, { text: '我自己看到的：窗外的天阴着。', type: 'fact', source: 'life', confidence: 0.9 })

setParam(db, aid, 'relation.selfresidue.settle', { value: 'on' })
const out = shadowReport(db, aid, { days: 7 })

check('余量记录 3 条', out.residue.recorded === 3, out.residue)
check('余量提示 1 条', out.residue.shown === 1, out.residue)
check('余量结算 1 条', out.residue.settled === 1, out.residue)
check('冷 2 暖 1', out.residue.by_dir.cold === 2 && out.residue.by_dir.warm === 1, out.residue.by_dir)
check('最近一条结算带 ids', Array.isArray(out.residue.last_settle?.ids) && out.residue.last_settle.ids.length === 2, out.residue.last_settle)
check('结算开关为 on', out.residue.settling === true, out.residue)
check('内心行落账 1', out.mind.committed === 1, out.mind)
check('内心行丢弃 1', out.mind.dropped === 1, out.mind)
check('丢弃率 0.5', out.mind.dropped_rate === 0.5, out.mind)
check('按 key 分开', out.mind.by_key.proactive.committed === 1 && out.mind.by_key.loop.dropped === 1, out.mind.by_key)
check('记忆总数 2', out.memory.total === 2, out.memory)
check('低置信 1', out.memory.low_confidence === 1, out.memory)
check('来源分组', out.memory.by_source.some((x) => x.source === 'extract' && x.n === 1) && out.memory.by_source.some((x) => x.source === 'life' && x.n === 1), out.memory.by_source)
check('参数快照', out.params['relation.selfresidue.settle'] === 'on', out.params)

// 窗口外的事件不算：把一条余量挪到 40 天前
const oldest = db.prepare("SELECT id FROM events WHERE agent_id=? AND type='rel.self_residue' ORDER BY created_at ASC LIMIT 1").get(aid)
db.prepare('UPDATE events SET created_at=? WHERE id=?')
  .run(new Date(Date.now() - 40 * 86400000).toISOString(), oldest.id)
const out7 = shadowReport(db, aid, { days: 7 })
check('窗口外不计', out7.residue.recorded === 2, out7.residue)

// 坏 payload 不抛
db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(nid('evt_'), aid, 'inject.mind_dropped', '{bad', now())
const outBad = shadowReport(db, aid, { days: 7 })
check('坏 payload 不抛', outBad.mind.dropped === 2 && outBad.mind.by_key.unknown.dropped === 1, outBad.mind)

// API 入口
const api = await handle(db, { method: 'GET', path: `/v1/agents/${aid}/shadow?days=7`, body: {}, token: 'user' })
check('API 200', api.status === 200, api)
check('API 带余量字段', !!api.body && typeof api.body.residue?.recorded === 'number', api.body)
check('API 带内心字段', !!api.body && typeof api.body.mind?.dropped_rate === 'number', api.body)

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
