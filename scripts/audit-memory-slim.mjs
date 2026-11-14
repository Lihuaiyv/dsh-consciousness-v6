/**
 * 影子统计：如果只停「每轮原话」这一类 episode，会少写多少、会丢什么（只读，不动库）。
 *
 * 口径（P2 收身规则，2026-11-13）：
 *   - 停写：`type='episode' AND source='manual'` —— 每轮 user 原话在 memory_items 再写一遍的那类；
 *   - 保留：fact / reflection / appraisal 全部；episode 里的 self（自我经历）/ life（生活）/ work-digest。
 * 历史数据一行不动，只统计「以后会少多少」。
 */
import { DatabaseSync } from 'node:sqlite'
import { dbPath } from '../src/paths.js'

const db = new DatabaseSync(dbPath(), { readOnly: true })
try { db.exec('PRAGMA busy_timeout=5000') } catch { /* ignore */ }
const q = (sql, ...args) => { try { return db.prepare(sql).all(...args) } catch (e) { return [{ error: String((e && e.message) || e).slice(0, 120) }] } }
const one = (sql, ...args) => q(sql, ...args)[0] || {}

console.log('库:', dbPath())

console.log('\n== 按 type × source ==')
for (const r of q("SELECT type, source, COUNT(*) n FROM memory_items GROUP BY type, source ORDER BY type, n DESC")) {
  console.log(' ', String(r.type).padEnd(12), String(r.source).padEnd(12), r.n)
}

const stop = one("SELECT COUNT(*) n FROM memory_items WHERE type='episode' AND source='manual'")
console.log('\n停写口径（episode + manual）历史总量:', stop.n)

console.log('\n最近 14 天「每轮原话」逐日:')
for (const r of q(`SELECT substr(created_at,1,10) d, COUNT(*) n FROM memory_items
  WHERE type='episode' AND source='manual' GROUP BY d ORDER BY d DESC LIMIT 14`)) {
  console.log(' ', r.d, r.n)
}

const dup = one(`SELECT COUNT(*) n FROM memory_items m
  JOIN fragments f ON f.agent_id=m.agent_id AND f.turn_id=m.source_turn_id AND f.text=m.text
  WHERE m.type='episode' AND m.source='manual'`)
console.log('\n这些行里，和 fragments 同轮同文、一字不差的:', dup.n, '（这就是「同一句话两份」的那一份）')

const prov = one(`SELECT COUNT(*) n FROM memory_items m
  LEFT JOIN memory_provenance p ON p.memory_id=m.id
  WHERE m.type='episode' AND m.source='manual' AND p.memory_id IS NULL`)
console.log('没有 provenance 证据链的:', prov.n)

const feel = one(`SELECT COUNT(*) n FROM memory_items WHERE type='episode' AND source='manual' AND feel_id IS NOT NULL`)
console.log('挂了 feel_id 的（停了以后情绪接缝会变稀）:', feel.n)

const keep = one(`SELECT COUNT(*) n FROM memory_items WHERE NOT (type='episode' AND source='manual')`)
console.log('\n保留口径（其余全部）历史总量:', keep.n)

const rate = one(`SELECT ROUND(AVG(n),1) avg FROM (
  SELECT substr(created_at,1,10) d, COUNT(*) n FROM memory_items
  WHERE type='episode' AND source='manual' AND created_at >= ?
  GROUP BY d)`, new Date(Date.now() - 7 * 86400000).toISOString())
console.log('最近 7 天日均停写量:', rate.avg, '条/天')

db.close()
