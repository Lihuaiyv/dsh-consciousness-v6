// 只读：看最近几轮「判定/总结」是不是同一轮触发了多次。
// 用法：node scripts/diag/turns.mjs
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const db = new DatabaseSync(path.join(root, 'runtime', 'consciousness', 'app.db'), { readOnly: true })

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%affect%' OR name LIKE '%frame%')").all()
console.log('相关表：' + tables.map((x) => x.name).join(', '))

// 最近 40 条情绪相关事件，按 turn_id 归堆，看每轮几条
const rows = db.prepare("SELECT type, payload FROM events WHERE type LIKE '%affect%' OR type LIKE '%frame%' ORDER BY rowid DESC LIMIT 200").all()
const byTurn = new Map()
for (const r of rows) {
  let p = {}
  try { p = JSON.parse(r.payload || '{}') } catch { p = {} }
  const tid = String(p.turn_id || p.turnId || '')
  if (!tid) continue
  const key = tid.slice(0, 18)
  if (!byTurn.has(key)) byTurn.set(key, [])
  byTurn.get(key).push(r.type)
}
console.log('\n每轮（turn_id 前 18 位）触发的事件数：')
let n = 0
for (const [k, list] of byTurn) {
  console.log('  ' + k + '  ' + list.length + ' 条：' + [...new Set(list)].join(', '))
  if (++n >= 12) break
}
