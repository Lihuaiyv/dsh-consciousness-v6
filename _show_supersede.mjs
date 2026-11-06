import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('C:/Users/ygys1/.dsh/consciousness/app.db', { readOnly: true })
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get('小汐').id
const txt = (id) => { try { return String(db.prepare('SELECT text FROM memory_items WHERE id=?').get(id)?.text || '(已不存在)').replace(/\s+/g, ' ').slice(0, 120) } catch { return '(查不到)' } }
const rows = db.prepare("SELECT * FROM memory_pair_judge WHERE agent_id=? AND verdict='supersede' ORDER BY judged_at DESC").all(aid)
console.log('supersede 共', rows.length, '条\n')
rows.forEach((r, i) => {
  console.log('#' + (i + 1), 'via=' + r.via, 'model=' + r.model, 'reason=' + String(r.reason || '').slice(0, 30))
  console.log('  旧:', txt(r.old_id))
  console.log('  新:', txt(r.new_id))
  console.log('')
})
db.close()
