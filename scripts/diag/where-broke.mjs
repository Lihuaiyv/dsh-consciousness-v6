// 只读体检：把两次调用（宿主 / 本地）最近的行逐条列出来，成功失败都标出来。
// 用法：node scripts/diag/where-broke.mjs
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const db = new DatabaseSync(path.join(root, 'runtime', 'consciousness', 'app.db'), { readOnly: true })
const pick = (sql) => { try { return db.prepare(sql).all() } catch (e) { return [{ err: String(e.message).slice(0, 70) }] } }

console.log('【宿主调用】host_calls 最近 10 条（新→旧）')
for (const r of pick('SELECT at,label,ms,ok FROM host_calls ORDER BY id DESC LIMIT 10')) {
  if (r.err) { console.log('   ' + r.err); break }
  console.log('   ' + String(r.at).slice(11, 19) + '  ' + r.label + '  ' + r.ms + 'ms  ' + (r.ok ? '成功' : '失败'))
}

console.log('\n【本地调用】local_calls 最近 12 条（新→旧）')
for (const r of pick('SELECT at,slot,label,ms,ok FROM local_calls ORDER BY id DESC LIMIT 12')) {
  if (r.err) { console.log('   ' + r.err); break }
  console.log('   ' + String(r.at).slice(11, 19) + '  ' + String(r.slot).padEnd(5) + '  ' + r.label + '  ' + r.ms + 'ms  ' + (r.ok ? '成功' : '失败'))
}
