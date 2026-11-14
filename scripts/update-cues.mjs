/**
 * 把补出来的抓手词写回库：cold_events.cues（出生判断）+ hot_events.cues（在用的那份）。
 * 用法：node scripts/update-cues.mjs scratch/cues-1111.json
 */
import fs from 'node:fs'
import { openDb } from '../src/db.js'
import { dbPath } from '../src/paths.js'

const file = process.argv[2]
const force = process.argv.includes('--force')   // 强制覆盖热库已有的抓手（默认不覆盖）
if (!file) { console.error('用法：node scripts/update-cues.mjs <cues.json> [--force]'); process.exit(1) }
const DB = process.env.DSH_DB || dbPath()
const db = openDb(DB)
const list = JSON.parse(fs.readFileSync(file, 'utf8'))

let cold = 0, hot = 0, missing = []
for (const it of list) {
  const id = String(it.id || '')
  const cues = (Array.isArray(it.cues) ? it.cues : []).map((x) => String(x).trim()).filter(Boolean)
  if (!id || !cues.length) { missing.push(id || '(空 id)'); continue }
  const r1 = db.prepare('UPDATE cold_events SET cues=? WHERE id=?').run(JSON.stringify(cues), id)
  if (r1.changes) cold++
  // 热库里来源含这条冷事件的，也一起写上（热库这份以后可以改）
  const rows = db.prepare("SELECT id, cues FROM hot_events WHERE source_cold_ids LIKE ?").all('%' + id + '%')
  for (const h of rows) {
    if (h.cues && !force) continue   // 已经有抓手词的不覆盖（热库是有状态的那份），除非 --force
    db.prepare('UPDATE hot_events SET cues=?, changed_at=? WHERE id=?').run(JSON.stringify(cues), new Date().toISOString(), h.id)
    hot++
  }
}
db.close()
console.log(JSON.stringify({ file, entries: list.length, coldUpdated: cold, hotUpdated: hot, missing }, null, 1))
