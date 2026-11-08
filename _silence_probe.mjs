import { dbPath as _dbp } from './src/paths.js'
﻿import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(_dbp(), { readOnly: true })
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get('小汐').id
const cnt = (sql, ...a) => { try { return db.prepare(sql).get(...a).n } catch { return -1 } }
console.log('--- open_loops 现状 ---')
console.log('总数:', cnt('SELECT COUNT(*) n FROM open_loops WHERE agent_id=?', aid))
for (const r of db.prepare('SELECT kind, state, COUNT(*) n FROM open_loops WHERE agent_id=? GROUP BY kind, state').all(aid)) {
  console.log(' ', r.kind, r.state, r.n)
}
const stale = new Date(Date.now() - 30 * 86400000).toISOString()
console.log('open 且超过 30 天:', cnt('SELECT COUNT(*) n FROM open_loops WHERE agent_id=? AND state=? AND created_at<?', aid, 'open', stale))
console.log('--- 样本 ---')
for (const r of db.prepare('SELECT text, kind, created_at FROM open_loops WHERE agent_id=? AND state=? ORDER BY created_at LIMIT 8').all(aid, 'open')) {
  console.log(' ', String(r.created_at).slice(0, 10), r.kind, String(r.text).replace(/\s+/g, ' ').slice(0, 60))
}
console.log('--- memory_items 里的「未来时」候选（粗数） ---')
console.log(cnt("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND (text LIKE '%要做%' OR text LIKE '%待办%' OR text LIKE '%明天%' OR text LIKE '%下周%' OR text LIKE '%之后%')", aid))
db.close()
