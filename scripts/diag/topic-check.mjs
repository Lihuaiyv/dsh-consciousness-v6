// 只读：专门查「事帧」这一环最近有没有发起、有没有失败留痕。
// 用法：node scripts/diag/topic-check.mjs
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const db = new DatabaseSync(path.join(root, 'runtime', 'consciousness', 'app.db'), { readOnly: true })
const q = (sql) => { try { return db.prepare(sql).all() } catch (e) { return [{ err: String(e.message).slice(0, 80) }] } }

console.log('【事帧】local_calls 里 label=affect:topic 最近 6 条')
for (const r of q("SELECT at,ms,ok FROM local_calls WHERE label='affect:topic' ORDER BY id DESC LIMIT 6")) {
  if (r.err) { console.log('  ' + r.err); break }
  console.log('   ' + String(r.at).slice(11, 19) + '  ' + r.ms + 'ms  ' + (r.ok ? '成功' : '失败'))
}

console.log('\n【本地失败】最近 8 条失败的本地调用（不限种类）')
for (const r of q('SELECT at,slot,label,ms FROM local_calls WHERE ok=0 ORDER BY id DESC LIMIT 8')) {
  if (r.err) { console.log('  ' + r.err); break }
  console.log('   ' + String(r.at).slice(11, 19) + '  ' + r.slot + '  ' + r.label + '  ' + r.ms + 'ms')
}

console.log('\n【宿主失败】最近 5 条失败的宿主调用')
for (const r of q('SELECT at,label,ms FROM host_calls WHERE ok=0 ORDER BY id DESC LIMIT 5')) {
  if (r.err) { console.log('  ' + r.err); break }
  console.log('   ' + String(r.at).slice(11, 19) + '  ' + r.label + '  ' + r.ms + 'ms')
}

console.log('\n【帧表】affect_v4_shadow 列名')
const cols = q('PRAGMA table_info(affect_v4_shadow)').map((c) => c.name).filter(Boolean)
console.log('   ' + (cols.length ? cols.join(', ') : '（没有这张表或读不到）'))
