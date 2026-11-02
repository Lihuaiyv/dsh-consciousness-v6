/**
 * 「当时」冒烟：不改动任何真实数据，开临时库走一遍完整剧本，打印可核对的数字。
 * 用法：node scripts/smoke-asof.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { applyWrite } from '../src/modules/gate.js'
import { retrieveAsOf } from '../src/modules/asof.js'
import { eventsOf, timelineDrift } from '../src/modules/timeline.js'
import { memoryHealth } from '../src/modules/retrieval_log.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-smoke-asof-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_smoke'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'smoke', 'daily', 'active', now())

const write = (cand) => addMemory(db, aid, { text: cand.text, type: 'fact', fact_key: cand.fact_key || null, source: 'extract', skipConflict: true })
const gw = (text, key) => applyWrite(db, aid, { text, fact_key: key }, (c) => write({ ...c, fact_key: key }))

const t1 = Date.now()
// 400 天前的一句原话：让它成为这几条记忆的「说话时间」（不是入库时间）
const oldAt = new Date(Date.now() - 400 * 86400000).toISOString()
db.prepare(`INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)`)
  .run('rt_old', aid, 's_old', 't_old', 0, 'user', '我喜欢喝美式咖啡，不加糖；每周二晚上去游泳', oldAt, oldAt.slice(0, 10))

const coffee = addMemory(db, aid, { text: '我喜欢喝美式咖啡，不加糖', type: 'fact', fact_key: 'coffee.pref', source: 'extract', skipConflict: true, turn_id: 't_old' })
const swim1 = addMemory(db, aid, { text: '每周二晚上去游泳', type: 'fact', fact_key: 'habit.swim', source: 'extract', skipConflict: true, turn_id: 't_old' })
const up1 = gw('每周二和周四晚上去游泳', 'habit.swim')
const up2 = gw('每周二周四周六晚上去游泳', 'habit.swim')
const coffeeNew = gw('我现在不喜欢喝美式咖啡了，改喝手冲', 'coffee.pref')

const rows = db.prepare('SELECT memory_id,op,reason FROM memory_timeline WHERE agent_id=? ORDER BY seq').all(aid)
const byOp = rows.reduce((m, r) => (m[r.op] = (m[r.op] || 0) + 1, m), {})
const hist = db.prepare("SELECT memory_id,text,source FROM fact_archive WHERE agent_id=? AND source='update_history' ORDER BY created_at").all(aid)
const drift = timelineDrift(db, aid)
const health = memoryHealth(db, aid)

// 「半年前」问一次：应该答出旧版，并标「现在：…」
const past = retrieveAsOf(db, aid, '我喜欢喝什么咖啡', { at: new Date(Date.now() - 300 * 86400000).toISOString() })
const beforeSwim = retrieveAsOf(db, aid, '我什么时候去游泳', { at: new Date(Date.now() - 300 * 86400000).toISOString() })
const evSwim = eventsOf(db, aid, swim1.id).map((e) => e.op)

console.log('=== 「当时」冒烟 ===')
console.log('写入次数:', 5)
console.log('时间线事件:', rows.length, JSON.stringify(byOp))
console.log('改写旧句存根:', hist.length, hist.map((h) => h.memory_id).join(', '))
console.log('游泳的事件链:', evSwim.join(' → '))
console.log('漂移:', JSON.stringify(drift))
console.log('体检:', JSON.stringify({ memory: health.memory, drift: health.timeline_drift }))
console.log('问「半年前喜欢喝什么咖啡」:', JSON.stringify({
  ok: past.ok,
  items: (past.items || []).map((x) => ({ text: String(x.text).slice(0, 40), label: x.label, now: x.now })),
}))
console.log('问「半年前怎么去游泳」:', JSON.stringify({
  ok: beforeSwim.ok,
  items: (beforeSwim.items || []).map((x) => ({ text: String(x.text).slice(0, 40), label: x.label, now: x.now })),
}))
console.log('重写后现行正文:', db.prepare('SELECT text FROM memory_items WHERE id=?').get(swim1.id).text)
console.log('改口后现行正文:', db.prepare('SELECT text FROM memory_items WHERE id=?').get(coffee.id).text)
console.log('耗时:', Date.now() - t1, 'ms')

db.close()
fs.rmSync(dir, { recursive: true, force: true })
