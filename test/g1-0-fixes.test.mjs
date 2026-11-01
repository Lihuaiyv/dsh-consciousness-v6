/**
 * G1-0：改写版本不丢 / 旧句存不进不覆盖正文 / 硬删连旧版本一起清。
 * 运行：node test/g1-0-fixes.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { addMemory, softDelete } from '../src/modules/memory.js'
import { applyWrite } from '../src/modules/gate.js'
import { purgeExpired } from '../src/core.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-g10-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_g10'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'g10', 'daily', 'active', now())
const write = (cand) => addMemory(db, aid, { text: cand.text, type: 'fact', fact_key: cand.fact_key || null, source: 'extract' })
const hist = (id) => db.prepare("SELECT memory_id,text FROM fact_archive WHERE agent_id=? AND substr(memory_id,1,?)=? ORDER BY memory_id")
  .all(aid, (id + ':hist:').length, id + ':hist:')

// D2：同一毫秒内连续两次改写，两个旧版本都要在
{
  const m = addMemory(db, aid, { text: '每周二晚上去游泳', type: 'fact', fact_key: 'habit.swim', source: 'extract' })
  const r1 = applyWrite(db, aid, { text: '每周二和周四晚上去游泳', fact_key: 'habit.swim' }, write)
  const r2 = applyWrite(db, aid, { text: '每周二周四周六晚上去游泳', fact_key: 'habit.swim' }, write)
  check('两次都是 update', r1.action === 'update' && r2.action === 'update', { r1, r2 })
  const h = hist(m.id)
  check('两个旧版本都留底', h.length === 2, h)
  check('旧版本原句正确', h.some((x) => x.text === '每周二晚上去游泳') && h.some((x) => x.text === '每周二和周四晚上去游泳'), h)
  const cur = db.prepare('SELECT text FROM memory_items WHERE id=?').get(m.id).text
  check('现行版是最后一次', cur === '每周二周四周六晚上去游泳', cur)
}

// D3：旧句存不进冷库 → 不覆盖正文，退回新增一行
{
  const m = addMemory(db, aid, { text: '喜欢在周末爬山', type: 'fact', fact_key: 'habit.hike', source: 'extract' })
  const ver = db.prepare('SELECT version FROM memory_items WHERE id=?').get(m.id).version
  // 预先占住这个版本号的存根位，且内容不同 → 视为留底失败
  db.prepare(`INSERT INTO fact_archive(id,agent_id,memory_id,text,source,created_at) VALUES(?,?,?,?,?,?)`)
    .run('far_block', aid, m.id + ':hist:' + ver, '别的内容', 'update_history', now())
  const r = applyWrite(db, aid, { text: '喜欢在周末去爬山看日出', fact_key: 'habit.hike' }, write)
  check('留底失败走 update_failed', r.action === 'new' && r.fallback === 'update_failed', r)
  const cur = db.prepare('SELECT text FROM memory_items WHERE id=?').get(m.id).text
  check('原正文没被覆盖', cur === '喜欢在周末爬山', cur)
}

// D1：硬删连改写旧版本一起清；前缀比较不误删相似 id
{
  const m = addMemory(db, aid, { text: '我住在杭州西湖边', type: 'fact', fact_key: 'home.city', source: 'extract' })
  applyWrite(db, aid, { text: '我住在杭州滨江', fact_key: 'home.city' }, write)
  check('删前有旧版本', hist(m.id).length === 1, hist(m.id))
  // 一个只差「_」位置字符的存根：LIKE 'mem_x:%' 会误中它
  const lookalike = m.id.replace('_', 'X') + ':hist:1'
  db.prepare(`INSERT INTO fact_archive(id,agent_id,memory_id,text,source,created_at) VALUES(?,?,?,?,?,?)`)
    .run('far_lookalike', aid, lookalike, '无关的存根', 'update_history', now())
  softDelete(db, m.id)
  db.prepare('UPDATE memory_items SET deleted_at=? WHERE id=?').run(new Date(Date.now() - 8 * 86400000).toISOString(), m.id)
  purgeExpired(db)
  check('主表已删', !db.prepare('SELECT 1 FROM memory_items WHERE id=?').get(m.id))
  check('出生存根已删', !db.prepare('SELECT 1 FROM fact_archive WHERE memory_id=?').get(m.id))
  check('改写旧版本已删', hist(m.id).length === 0, hist(m.id))
  check('相似 id 的存根没被误删', !!db.prepare('SELECT 1 FROM fact_archive WHERE memory_id=?').get(lookalike))
  const fts = db.prepare("SELECT COUNT(*) n FROM fact_fts WHERE id NOT IN (SELECT id FROM fact_archive)").get().n
  check('存根索引没有孤儿', fts === 0, fts)
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
