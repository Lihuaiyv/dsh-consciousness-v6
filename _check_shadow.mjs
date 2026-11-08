import { dbPath as _dbp } from './src/paths.js'
﻿import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(_dbp(), { readOnly: true })
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get('小汐').id
for (const t of ['memory.judge.gate','memory.judge.superseded','memory.stale_pair_seen','memory.stale_superseded']) {
  const n = db.prepare('SELECT COUNT(*) n FROM events WHERE agent_id=? AND type=?').get(aid, t).n
  const last = db.prepare('SELECT created_at FROM events WHERE agent_id=? AND type=? ORDER BY created_at DESC LIMIT 1').get(aid, t)
  console.log(t, '=', n, last ? '(last ' + last.created_at + ')' : '')
}
const cache = db.prepare('SELECT COUNT(*) n FROM memory_pair_judge WHERE agent_id=?').get(aid).n
console.log('memory_pair_judge 行数 =', cache)
const params = db.prepare('SELECT key,value FROM agent_params WHERE agent_id=? AND key LIKE ?').all(aid, 'memory.judge%')
console.log('judge 参数:', params.map(p=>p.key+'='+p.value).join(' '))
db.close()
