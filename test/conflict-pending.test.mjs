/**
 * 待判冲突的出口（第二步）：夜里重判 + 超期作废。
 * 运行：node test/conflict-pending.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory, rejudgePendingConflicts } from '../src/modules/memory.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-pending-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_pending'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'pending', 'daily', 'active', now())

const row = (id) => db.prepare('SELECT * FROM conflicts WHERE id=?').get(id)

function seed(cid, { ageMs = 7200000, bMissing = false } = {}) {
  const a = addMemory(db, aid, { text: '主人说周末要去爬山，早上八点出发', type: 'fact', source: 'test', skipConflict: true })
  db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(iso(ageMs + 600000), a.id)
  let bId = 'mem_missing_' + cid
  if (!bMissing) {
    const b = addMemory(db, aid, { text: '主人说周末不去爬山了，改成在家休息', type: 'fact', source: 'test', skipConflict: true })
    db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(iso(ageMs), b.id)
    bId = b.id
  }
  db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,evidence)
    VALUES(?,?,?,?, 'pending', ?, 'high', 'polarity', '{}')`).run(cid, aid, a.id, bId, iso(ageMs))
  return { aId: a.id, bId }
}

// ---- 1. 放了两小时的待判：夜里重判，判「补充」就结案
{
  seed('cfl_p1')
  const out = await rejudgePendingConflicts(db, aid, { complete: async () => '补充', limit: 5 })
  const c = row('cfl_p1')
  check('重判了一条', out.settled === 1, out)
  check('结论是补充 → 结案', c.state === 'resolved' && c.resolution === 'supplement', c)
}

// ---- 2. 刚写入的（10 分钟）不抢白天的异步链
{
  seed('cfl_p2', { ageMs: 600000 })
  let calls = 0
  const out = await rejudgePendingConflicts(db, aid, { complete: async () => { calls++; return '补充' }, limit: 5 })
  check('不到一小时的先不动', calls === 0 && out.skipped >= 1 && row('cfl_p2').state === 'pending', out)
}

// ---- 3. 超 7 天：作废退场，不再问
{
  seed('cfl_p3', { ageMs: 8 * 86400000 })
  let calls = 0
  const out = await rejudgePendingConflicts(db, aid, { complete: async () => { calls++; return '补充' }, limit: 5 })
  const c = row('cfl_p3')
  check('超期不问模型', calls === 0, calls)
  check('超期作废退场', c.state === 'resolved' && c.resolution === 'unknown', c)
  check('退场计数', out.retired === 1, out)
}

// ---- 4. 没模型：留在 pending，别乱结案
{
  seed('cfl_p4')
  const out = await rejudgePendingConflicts(db, aid, { complete: null, limit: 5 })
  check('没模型不结案', row('cfl_p4').state === 'pending' && out.settled === 0, out)
}

// ---- 5. 两侧记忆不在了：也退场，别留孤儿
{
  seed('cfl_p5', { bMissing: true })
  const out = await rejudgePendingConflicts(db, aid, { complete: async () => '补充', limit: 5 })
  const c = row('cfl_p5')
  check('孤儿待判退场', c.state === 'resolved' && c.resolution === 'unknown', c)
  check('退场计数 +1', out.retired === 1, out)
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
