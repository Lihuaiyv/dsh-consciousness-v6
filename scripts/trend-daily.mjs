/**
 * 方向灯：逐天看「这两天在往下掉」是不是真的在往下掉。
 * 运行：node scripts/trend-daily.mjs [天数]
 *
 * 只读线上库。它回答两件事：
 *   1. 每天收盘时的慢情绪，相对那一天的水位起点（affect_baseline.from_val）偏了多少
 *   2. 这些天里，注入闸（say.once）到底放行过几次 trend.*
 *
 * 为什么要有它：闸的考卷只验证「说满三天就收声」，验证不了「方向灯自己是不是连着三天都说对」。
 * 明天查的时候，一条命令就能分清：是方向翻了，还是闸漏了。
 */
import { DatabaseSync } from 'node:sqlite'

const DB = 'C:/Users/ygys1/.dsh/consciousness/app.db'
const days = Math.max(1, Math.min(30, Number(process.argv[2]) || 7))
const db = new DatabaseSync(DB)
const DAY = 86400000

const aidRow = db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY rowid DESC LIMIT 1").get()
const aid = aidRow && aidRow.id
if (!aid) { console.log('没有活跃 agent'); process.exit(0) }

const segs = db.prepare('SELECT from_val, to_val, started_at, duration_h FROM affect_baseline WHERE agent_id=? ORDER BY started_at').all(aid)
const segAt = (ms) => {
  let hit = null
  for (const s of segs) {
    const start = Date.parse(s.started_at)
    if (!Number.isFinite(start)) continue
    const end = start + Number(s.duration_h || 0) * 3600000
    if (ms >= start && ms < end) hit = s
    if (start <= ms) hit = hit || s
  }
  return hit
}

console.log('agent: ' + aid + '   最近 ' + days + ' 天')
console.log('日期         收盘慢情绪   水位起点   偏移     方向      当天被放行的闸')
for (let d = days - 1; d >= 0; d--) {
  const dayStart = Date.now() - d * DAY
  const day = new Date(dayStart).toISOString().slice(0, 10)
  const next = new Date(dayStart + DAY).toISOString().slice(0, 10)
  const rows = db.prepare('SELECT at, slow FROM affect_samples WHERE agent_id=? AND at>=? AND at<? ORDER BY at').all(aid, day + 'T00:00:00.000Z', next + 'T00:00:00.000Z')
  let slow = null
  for (const r of rows) {
    let o = {}
    try { o = JSON.parse(r.slow || '{}') } catch {}
    if (o.slow != null && Number.isFinite(Number(o.slow))) slow = Number(o.slow)
  }
  const seg = segAt(dayStart)
  const from = seg ? Number(seg.from_val) : NaN
  const delta = slow != null && Number.isFinite(from) ? slow - from : NaN
  const dir = !Number.isFinite(delta) ? '—' : (delta >= 0.08 ? 'up' : delta <= -0.08 ? 'down' : 'flat')
  const says = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='say.once' AND created_at>=? AND created_at<?").all(aid, day + 'T00:00:00.000Z', next + 'T00:00:00.000Z')
    .map((r) => { try { return JSON.parse(r.payload || '{}').key } catch { return '' } })
    .filter((k) => k && k.startsWith('trend'))
  console.log(day + '  ' +
    (slow == null ? '  —  ' : slow.toFixed(3).padStart(8)) + '  ' +
    (Number.isFinite(from) ? from.toFixed(3).padStart(8) : '     —  ') + '  ' +
    (Number.isFinite(delta) ? delta.toFixed(3).padStart(7) : '    —  ') + '  ' +
    dir.padEnd(7) + '  ' + (says.length ? says.join(',') : '—'))
}
db.close()
