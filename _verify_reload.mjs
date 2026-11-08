import { dbPath as _dbp } from './src/paths.js'
﻿import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(_dbp(), { readOnly: true })
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get('小汐').id
const since = new Date(Date.now() - 90 * 60000).toISOString()
const evs = db.prepare("SELECT created_at, payload FROM events WHERE agent_id=? AND type IN ('memory.judge.gate','memory.judge.superseded') AND created_at>=? ORDER BY created_at").all(aid, since)
console.log('重启后 90 分钟内的事件:', evs.length)
const reasons = {}
for (const e of evs) { try { const p = JSON.parse(e.payload); const k = (p.verdict || '?') + ':' + String(p.reason || '').slice(0, 28); reasons[k] = (reasons[k] || 0) + 1 } catch {} }
console.log('reason 分布:', JSON.stringify(reasons, null, 1))
const newCache = db.prepare('SELECT judged_at, verdict, model, reason FROM memory_pair_judge WHERE agent_id=? AND judged_at>=? ORDER BY judged_at DESC LIMIT 10').all(aid, since)
console.log('重启后新缓存行:', newCache.length)
for (const r of newCache) console.log(' ', r.judged_at.slice(11,19), r.verdict, r.model, String(r.reason).slice(0,30))
const oldRule = db.prepare("SELECT COUNT(*) n FROM memory_pair_judge WHERE agent_id=? AND verdict='supersede' AND model='rule'").get(aid).n
console.log('rule-supersede 残留:', oldRule)
db.close()
