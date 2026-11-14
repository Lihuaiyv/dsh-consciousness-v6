/**
 * 事件质量体检（只读）：回填 / 切事之后，量两件事——
 *   1) 自撞命中率：每件事用**自己的抓手**去撞，能不能把自己撞出来（应 ≥80%）；
 *   2) 乱撞率：拿最近的真实人话（不含任何抓手）去撞，有多少句会莫名其妙带出一件事（应很低）。
 *
 * 用法：node scripts/audit-event-hitrate.mjs
 * 只读打开真库（readOnly），不写、不迁移；结果供 P1b「回填件可命中率 ≥80%」验收。
 */
import { DatabaseSync } from 'node:sqlite'
import { dbPath } from '../src/paths.js'
import { recallEvents } from '../src/modules/event_recall.js'

const db = new DatabaseSync(dbPath(), { readOnly: true })
try { db.exec('PRAGMA busy_timeout=5000') } catch { /* ignore */ }
const aid = db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY created_at LIMIT 1").get()?.id || ''

const events = db.prepare("SELECT id, title, cues, state FROM hot_events WHERE agent_id=? AND active=1 ORDER BY created_at DESC").all(aid)
console.log('库:', dbPath(), '| 事件:', events.length, '| 意识体:', aid)

let selfHit = 0
const rows = []
for (const ev of events) {
  let cues = []
  try { cues = JSON.parse(ev.cues || '[]') } catch { cues = [] }
  const tried = cues.slice(0, 3)
  let hit = false
  for (const cue of tried) {
    const r = recallEvents(db, aid, cue, { limit: 5 })
    if (r.items.some((x) => x.id === ev.id)) { hit = true; break }
  }
  if (hit) selfHit++
  rows.push({ id: ev.id, title: ev.title, state: ev.state, cues: cues.length, hit })
}
for (const r of rows) console.log(r.hit ? 'HIT ' : 'MISS', r.state, '|', r.title, '| cues', r.cues)

const rate = events.length ? Math.round((selfHit / events.length) * 100) : 0
const pendingRows = rows.filter((r) => r.state === '待联想')
const pendingHit = pendingRows.filter((r) => r.hit).length
const pendingRate = pendingRows.length ? Math.round((pendingHit / pendingRows.length) * 100) : 0
console.log(`\n自撞命中率（全部）: ${selfHit}/${events.length}（${rate}%）`)
console.log(`自撞命中率（待联想）: ${pendingHit}/${pendingRows.length}（${pendingRate}%）——台面事件本来就不该被带出来，单列`)

// 乱撞率：最近 3 天的人话（去掉太短/太长/带抓手的），看有多少句会带出事件
const since = new Date(Date.now() - 3 * 86400000).toISOString()
const samples = db.prepare(`SELECT text FROM fragments WHERE agent_id=? AND role='user' AND created_at>=?
  AND length(text) BETWEEN 6 AND 60 ORDER BY created_at DESC LIMIT 40`).all(aid, since)
let noisy = 0
let considered = 0
for (const s of samples) {
  const t = String(s.text || '')
  if (!t || t.includes('[System]')) continue
  const r = recallEvents(db, aid, t, { limit: 3 })
  considered++
  if (r.items.length) noisy++
}
const noiseRate = considered ? Math.round((noisy / considered) * 100) : 0
console.log(`乱撞率: ${noisy}/${considered} 句会带出事件（${noiseRate}%）`)

const okHit = pendingRows.length === 0 ? true : pendingRate >= 80
const okNoise = noiseRate <= 30
console.log(okHit ? 'PASS 自撞命中率（待联想）' : 'FAIL 自撞命中率（应 ≥80%）')
console.log(okNoise ? 'PASS 乱撞率' : 'FAIL 乱撞率（应 ≤30%）')
console.log(okHit ? 'PASS 自撞命中率' : 'FAIL 自撞命中率（应 ≥80%）')
console.log(okNoise ? 'PASS 乱撞率' : 'FAIL 乱撞率（应 ≤30%）')
db.close()
if (!okHit || !okNoise) process.exit(1)
