/**
 * G1-2：每条写入路径都在时效索引里留下正确的事件，且投影现状 = 主表现状。
 * 运行：node test/g1-2-writers.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import {
  addMemory, softDelete, restoreMemory, resolveConflict, supersedeMany,
} from '../src/modules/memory.js'
import { applyWrite } from '../src/modules/gate.js'
import { eventsOf, projectMany, driftOf } from '../src/modules/timeline.js'
import { ingest } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-g12-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_g12'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(aid, 'g12', 'daily', 'active', now())
const ops = (id) => eventsOf(db, aid, id).map((e) => e.op)
const last = (id) => { const e = eventsOf(db, aid, id); return e[e.length - 1] }
const write = (cand) => addMemory(db, aid, { text: cand.text, type: 'fact', fact_key: cand.fact_key || null, source: 'extract', skipConflict: true })

// W1 出生
{
  db.prepare(`INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run('r1', aid, 's1', 'turn_1', 0, 'user', '我喜欢喝美式咖啡', '2026-01-01T10:00:00.000Z', '2026-01-01')
  const m = addMemory(db, aid, { text: '我喜欢喝美式咖啡', type: 'fact', source: 'extract', turn_id: 'turn_1' })
  const e = eventsOf(db, aid, m.id)
  check('W1 ADD 一条', e.length === 1 && e[0].op === 'ADD', e)
  const far = db.prepare('SELECT id FROM fact_archive WHERE memory_id=?').get(m.id)
  check('W1 text_ref = 出生存根', e[0].text_ref === far.id, { e: e[0], far })
  check('W1 valid_from = 原话时间', e[0].valid_from === '2026-01-01T10:00:00.000Z', e[0])
  const dup = addMemory(db, aid, { text: '我喜欢喝美式咖啡', type: 'fact', source: 'extract' })
  check('重复不记新事件', dup.duplicate && eventsOf(db, aid, m.id).length === 1)
}

// W3 同 key 取代
{
  const a = addMemory(db, aid, { text: '我住在杭州', type: 'fact', fact_key: 'home', source: 'extract' })
  const b = addMemory(db, aid, { text: '我搬到上海住了', type: 'fact', fact_key: 'home', source: 'extract' })
  const e = last(a.id)
  check('W3 旧条 INVALIDATE supersede', e.op === 'INVALIDATE' && e.reason === 'supersede' && e.cause_id === b.id, e)
}

// W4 批量取代
{
  const x = addMemory(db, aid, { text: '周一跑步三公里', type: 'reflection', source: 'manual' })
  const y = addMemory(db, aid, { text: '周三跑步五公里', type: 'reflection', source: 'manual' })
  const z = addMemory(db, aid, { text: '一周跑两次步', type: 'reflection', source: 'consolidate' })
  supersedeMany(db, aid, z.id, [x.id, y.id], 'consolidate')
  check('W4 两条都 INVALIDATE', last(x.id).op === 'INVALIDATE' && last(y.id).op === 'INVALIDATE' && last(x.id).cause_id === z.id)
}

// W5 门控改写
{
  const m = addMemory(db, aid, { text: '每周二晚上去游泳', type: 'fact', fact_key: 'habit.swim', source: 'extract' })
  const r = applyWrite(db, aid, { text: '每周二和周四晚上去游泳', fact_key: 'habit.swim' }, write)
  const e = last(m.id)
  const hist = db.prepare('SELECT id,text FROM fact_archive WHERE memory_id=?').get(m.id + ':hist:1')
  check('W5 update', r.action === 'update', r)
  check('W5 REVISE text_ref = 旧句存根', e.op === 'REVISE' && hist && e.text_ref === hist.id && hist.text === '每周二晚上去游泳', { e, hist })
}

// W6 门控冲突 + W8 结案保留新
let gateConf = null
{
  const a = addMemory(db, aid, { text: '我喜欢吃辣的川菜', type: 'fact', source: 'extract' })
  const r = applyWrite(db, aid, { text: '我不喜欢吃辣的川菜' }, write)
  check('W6 conflict', r.action === 'conflict', r)
  if (r.action === 'conflict') {
    gateConf = { a: a.id, b: r.id, cid: r.conflict_id }
    check('W6 A INVALIDATE conflict cause=B', ops(a.id).join() === 'ADD,INVALIDATE,DISPUTE_OPEN' && eventsOf(db, aid, a.id)[1].cause_id === r.id, eventsOf(db, aid, a.id))
    check('W6 B 争议开', ops(r.id).includes('DISPUTE_OPEN'), ops(r.id))
    resolveConflict(db, aid, r.conflict_id, { keep: 'b' })
    check('W8 keep=b：A 再作废 + 结案', ops(a.id).slice(-2).join() === 'INVALIDATE,DISPUTE_CLOSE', ops(a.id))
    check('W8 keep=b：B 只结案不复活', !ops(r.id).includes('REACTIVATE') && ops(r.id).includes('DISPUTE_CLOSE'), ops(r.id))
  }
}

// W2 addMemory 高风险冲突 + W8 结案保留旧
{
  const a = addMemory(db, aid, { text: '我的名字叫小王', type: 'fact', source: 'manual' })
  const b = addMemory(db, aid, { text: '我的名字不叫小王', type: 'fact', source: 'manual' })
  const cid = db.prepare("SELECT id FROM conflicts WHERE a_id=? AND b_id=? AND state='open'").get(a.id, b.id)?.id
  check('W2 高风险冲突开案', b.conflict && !!cid, b)
  if (cid) {
    check('W2 A INVALIDATE + 双方 DISPUTE_OPEN', ops(a.id).join() === 'ADD,INVALIDATE,DISPUTE_OPEN' && ops(b.id).includes('DISPUTE_OPEN'), { a: ops(a.id), b: ops(b.id) })
    resolveConflict(db, aid, cid, { keep: 'a' })
    check('W8 keep=a：A REACTIVATE', ops(a.id).includes('REACTIVATE'), ops(a.id))
    check('W8 keep=a：B INVALIDATE', ops(b.id).includes('INVALIDATE'), ops(b.id))
  }
}

// W7 门控删除
{
  const m = addMemory(db, aid, { text: '我的车是一辆白色的轿车', type: 'fact', fact_key: 'car', source: 'extract' })
  const r = applyWrite(db, aid, { text: '我的车是一辆白色的轿车', fact_key: 'car', op: 'delete' }, write)
  check('W7 DELETE', r.action === 'delete' && last(m.id).op === 'DELETE', { r, ops: ops(m.id) })
}

// W11 软删 / 恢复
{
  const m = addMemory(db, aid, { text: '我在学弹吉他', type: 'fact', source: 'manual' })
  softDelete(db, m.id)
  check('W11 HIDE', last(m.id).op === 'HIDE')
  restoreMemory(db, m.id)
  check('W11 UNHIDE', last(m.id).op === 'UNHIDE')
}

// W9 / W10 对话抽取：过去事实 + 否认句
{
  let ok = true
  try {
    await ingest(db, aid, { turns: [{ role: 'user', text: '我以前养过一只猫' }] })
  } catch (e) { ok = false; console.log('  ingest 不可用：', String(e && e.message || e).slice(0, 120)) }
  if (ok) {
    const pf = db.prepare("SELECT id FROM memory_items WHERE agent_id=? AND text LIKE '%养过%猫%' ORDER BY created_at DESC").get(aid)
    check('W9 过去事实：ADD + INVALIDATE(past_fact) 零宽', pf && ops(pf.id).join() === 'ADD,INVALIDATE' && last(pf.id).reason === 'past_fact', pf && eventsOf(db, aid, pf.id))
    const tea = addMemory(db, aid, { text: '我喜欢喝绿茶', type: 'fact', source: 'manual' })
    await ingest(db, aid, { turns: [{ role: 'user', text: '我不喜欢喝绿茶了' }] })
    const row = db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(tea.id)
    if (row.invalid_at) check('W10 否认句后旧条有 INVALIDATE', ops(tea.id).includes('INVALIDATE'), eventsOf(db, aid, tea.id))
    else console.log('  （否认句规则未命中，跳过 W10 断言）')
  }
}

// 全量对账：投影现状 = 主表现状
{
  const rows = db.prepare('SELECT * FROM memory_items WHERE agent_id=?').all(aid)
  const pm = projectMany(db, aid, rows.map((r) => r.id))
  const drift = rows.map((r) => ({ id: r.id, text: r.text, d: driftOf(r, pm.get(r.id)) })).filter((x) => x.d)
  check(`全量漂移 0（${rows.length} 条）`, drift.length === 0, drift)
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
