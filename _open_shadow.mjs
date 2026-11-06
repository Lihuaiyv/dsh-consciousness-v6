import { DatabaseSync } from 'node:sqlite'
const dbPath = 'C:/Users/ygys1/.dsh/consciousness/app.db'
const db = new DatabaseSync(dbPath)
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get('小汐').id
const now = new Date().toISOString()
const put = db.prepare(`INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)
  ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
const read = (k) => {
  const r = db.prepare('SELECT value FROM agent_params WHERE agent_id=? AND key=?').get(aid, k)
  if (!r) return '(未设置，走默认)'
  try { return JSON.parse(r.value) } catch { return r.value }
}
console.log('--- 改动前 ---')
for (const k of ['memory.judge.enable','memory.judge.gate','memory.judge.nightly','memory.judge.daily_max','memory.judge.timeout_ms','memory.judge.min_interval_ms']) console.log(' ', k, '=', read(k))
put.run(aid, 'memory.judge.enable', JSON.stringify('on'), now)
put.run(aid, 'memory.judge.gate', JSON.stringify('shadow'), now)
console.log('--- 改动后 ---')
for (const k of ['memory.judge.enable','memory.judge.gate','memory.judge.nightly']) console.log(' ', k, '=', read(k))
db.close()
