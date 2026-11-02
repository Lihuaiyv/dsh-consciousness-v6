import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('C:/Users/ygys1/.dsh/consciousness/app.db')
const rows = db.prepare(`select id, text, type, created_at from memory_items
  where status!='soft_deleted' and instr(text,'?') > 0 and length(replace(text,'?','')) <= 2`).all()
const ts = new Date().toISOString()
db.exec('BEGIN')
let n = 0
try {
  for (const r of rows) {
    n += db.prepare("update memory_items set status='soft_deleted', deleted_at=? where id=?").run(ts, r.id).changes
    console.log('soft-deleted', r.id, r.type, r.created_at, JSON.stringify(r.text))
  }
  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK'); console.error('ROLLBACK', e.message); process.exitCode = 1
}
console.log('changed:', n)
console.log('remaining all-? active:', db.prepare(`select count(*) n from memory_items where status!='soft_deleted' and instr(text,'?') > 0 and length(replace(text,'?','')) <= 2`).get().n)
console.log('mem active:', db.prepare("select count(*) n from memory_items where status!='soft_deleted'").get().n)
db.close()
