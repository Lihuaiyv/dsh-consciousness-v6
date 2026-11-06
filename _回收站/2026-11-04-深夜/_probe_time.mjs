import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('C:/Users/ygys1/.dsh/consciousness/app.db', { readOnly: true })
const r = db.prepare('SELECT created_at FROM memory_items ORDER BY created_at DESC LIMIT 3').all()
console.log(r.map(x=>x.created_at).join('\n'))
console.log('now():', new Date().toISOString(), 'local:', new Date().toString())
