const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.USERPROFILE + '\\.dsh\\consciousness\\app.db', { readOnly: true });
const one=(s,...a)=>db.prepare(s).get(...a); const all=(s,...a)=>db.prepare(s).all(...a);
console.log('events cols', all("PRAGMA table_info(events)").map(c=>c.name).join(','));
console.log('param cols', all("PRAGMA table_info(params)").map(c=>c.name).join(','));
console.log('stale params', all("SELECT * FROM params WHERE key LIKE 'memory.%'").slice(0,30));
try { console.log('stale events', all("SELECT kind, COUNT(*) n FROM events WHERE kind LIKE 'memory.stale%' OR kind LIKE 'memory.fact_superseded' GROUP BY kind")); } catch(e){ console.log('no kind', e.message); }
const aid='agt_3977d80f17';
console.log('active w/ key', one("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND fact_key IS NOT NULL AND fact_key<>''", aid));
console.log('recent stale events', all("SELECT * FROM events WHERE agent_id=? AND (kind LIKE 'memory.stale%' OR kind='memory.fact_superseded') ORDER BY at DESC LIMIT 5", aid));
