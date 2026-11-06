import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('C:/Users/ygys1/.dsh/consciousness/app.db')
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get('小汐').id
const now = new Date().toISOString()
// 1) 超时参数显式写 6000：插件每次 getParam 读库，立刻生效，不用重启
db.prepare(`INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)
  ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
  .run(aid, 'memory.judge.timeout_ms', JSON.stringify(6000), now)
// 2) 清掉旧规则产生的 supersede 缓存（4 条 rule same-fact-key，已证明误判）
const del = db.prepare("DELETE FROM memory_pair_judge WHERE agent_id=? AND verdict='supersede' AND model='rule'").run(aid)
const left = db.prepare('SELECT verdict, model, COUNT(*) n FROM memory_pair_judge WHERE agent_id=? GROUP BY verdict, model').all(aid)
console.log('删掉旧 rule-supersede:', del.changes, '行')
console.log('剩下:', JSON.stringify(left))
console.log('timeout_ms =', JSON.parse(db.prepare('SELECT value FROM agent_params WHERE agent_id=? AND key=?').get(aid, 'memory.judge.timeout_ms').value))
db.close()
