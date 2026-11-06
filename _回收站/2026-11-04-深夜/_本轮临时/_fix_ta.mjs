import fs from 'node:fs'
const p = 'test/time-awareness.test.mjs'
let s = fs.readFileSync(p, 'utf8')
s = s.replace(
  "const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)",
  "const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)\n// packInjection 按 partition 分桶（buffer/T1/T3/T2/T4），没有 partition 的条目会被静默丢掉。\nconst hit = (w, id) => ({ ...rowOf(w, id), partition: 'T1' })"
)
s = s.replace('[rowOf(w, old.id), rowOf(w, newer.id)]', '[hit(w, old.id), hit(w, newer.id)]')
s = s.replace('[rowOf(w, r.id)], 400)', '[hit(w, r.id)], 400)')
s = s.replace('[rowOf(w, old.id), rowOf(w, out.id)]', '[hit(w, old.id), hit(w, out.id)]')
// statement 的 occurred 来自 memory_timeline.valid_from，不是 created_at
s = s.replace(
  "w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(6), r.id)",
  "w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(6), r.id)\n    w.db.prepare(\"UPDATE memory_timeline SET valid_from=? WHERE memory_id=? AND op='ADD'\").run(ago(6), r.id)"
)
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
