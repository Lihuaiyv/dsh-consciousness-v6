/**
 * 基线：每天往记忆里写了多少（只读，不改库）。
 *
 * 用途（P2 收写前）：翻「停每轮 episode」的默认之前，先知道现在长什么样——
 *   - memory_items 每天新增多少、其中 episode 占多少；
 *   - fragments / chat_turns 每天多少（原料层）；
 *   - 最近 14 天逐日，好看趋势，不被单日噪声骗。
 * 真库只读打开（readOnly:true + busy_timeout），不写、不迁移。
 */
import { DatabaseSync } from 'node:sqlite'
import { dbPath } from '../src/paths.js'

const db = new DatabaseSync(dbPath(), { readOnly: true })
try { db.exec('PRAGMA busy_timeout=5000') } catch { /* 读不到也能继续 */ }

const q = (sql, ...args) => {
  try { return db.prepare(sql).all(...args) } catch (e) { return [{ error: String((e && e.message) || e).slice(0, 120) }] }
}

console.log('库:', dbPath())

const byType = q("SELECT type, COUNT(*) n FROM memory_items GROUP BY type ORDER BY n DESC")
console.log('\nmemory_items 总量（按 type）:')
for (const r of byType) console.log(' ', r.type || '(空)', r.n)

const days = q(`SELECT substr(created_at,1,10) d, SUM(type='episode') ep, COUNT(*) all_n
  FROM memory_items GROUP BY d ORDER BY d DESC LIMIT 14`)
console.log('\n最近 14 天 memory_items（UTC 日）:')
for (const r of days) console.log(' ', r.d, 'episode=' + (r.ep || 0), '全部=' + r.all_n)

const frag = q(`SELECT day, COUNT(*) n FROM fragments GROUP BY day ORDER BY day DESC LIMIT 7`)
console.log('\n最近 7 天 fragments:')
for (const r of frag) console.log(' ', r.day, r.n)

const chat = q(`SELECT substr(created_at,1,10) d, COUNT(*) n FROM chat_turns GROUP BY d ORDER BY d DESC LIMIT 7`)
console.log('\n最近 7 天 chat_turns:')
for (const r of chat) console.log(' ', r.d, r.n)

const cover = q(`SELECT
  (SELECT COUNT(*) FROM memory_items WHERE type='episode') ep,
  (SELECT COUNT(*) FROM memory_items) all_mem,
  (SELECT COUNT(*) FROM hot_events WHERE active=1) hot,
  (SELECT COUNT(*) FROM cold_events) cold,
  (SELECT COUNT(*) FROM confluence_log) cflog,
  (SELECT COUNT(*) FROM revisit) revisit`)
console.log('\n覆盖:', JSON.stringify(cover[0]))

const retr = q(`SELECT COUNT(*) n FROM retrieval_log WHERE at >= ?`, new Date(Date.now() - 86400000).toISOString())
console.log('最近 24h 检索次数:', JSON.stringify(retr[0]))

db.close()
