/**
 * 复习与年龄：先看清楚真实库里「被想起过几次」长什么样（只读）。
 *
 *   node scripts/bench-rehearsal.mjs [db 路径]
 *
 * 第 0 步只回答：hits 分布、last_hit_at 覆盖、以及「有多少条真的被复习过」。
 * 第 1 步做完后，同一个脚本会多出一段「复习抵年龄之后档位变了多少」的对照。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const home = process.env.USERPROFILE || process.env.HOME || '.'
const src = process.argv[2] || path.join(home, '.dsh', 'consciousness', 'app.db')
if (!fs.existsSync(src)) { console.error('找不到库：' + src); process.exit(2) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-reh-'))
const copy = path.join(dir, 'app.db')
fs.copyFileSync(src, copy)
for (const ext of ['-wal', '-shm']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, copy + ext)

const db = new DatabaseSync(copy, { readOnly: true })
const rows = db.prepare(`SELECT id,text,created_at,hits,last_hit_at,stability,importance,type,mark
  FROM memory_items WHERE status='active' AND invalid_at IS NULL`).all()
db.close()

const DAY = 86400000
const nowMs = Date.now()
const age = (r) => {
  const t = Date.parse(String(r.created_at || ''))
  return Number.isFinite(t) ? (nowMs - t) / DAY : null
}

const hist = {}
for (const r of rows) {
  const h = Math.min(20, Number(r.hits || 0))
  hist[h] = (hist[h] || 0) + 1
}
const withHit = rows.filter((r) => Number(r.hits || 0) > 0).length
const withRecent = rows.filter((r) => {
  const t = Date.parse(String(r.last_hit_at || ''))
  return Number.isFinite(t) && nowMs - t < 7 * DAY
}).length
const ages = rows.map(age).filter((x) => x != null).sort((a, b) => a - b)

console.log(JSON.stringify({
  db: src,
  total: rows.length,
  hits_hist: hist,
  reviewed_once: withHit,
  reviewed_pct: Math.round((withHit / rows.length) * 1000) / 10 + '%',
  recent_7d: withRecent,
  age_days: {
    min: Math.round(ages[0] || 0),
    median: Math.round(ages[Math.floor(ages.length / 2)] || 0),
    max: Math.round(ages[ages.length - 1] || 0),
  },
}, null, 2))

// 最常被想起的几条，看看 hits 到底在数什么
const top = [...rows].sort((a, b) => Number(b.hits || 0) - Number(a.hits || 0)).slice(0, 5)
console.log('\n--- hits 最高的五条 ---')
for (const r of top) {
  console.log(`hits=${r.hits || 0}  年龄=${Math.round(age(r) || 0)} 天  ${String(r.text).replace(/\s+/g, ' ').slice(0, 50)}`)
}
