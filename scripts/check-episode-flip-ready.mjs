/**
 * 翻「停每轮 episode」默认之前先跑这个（只读）：够不够条件，一屏说清。
 *
 * 判据（写死在 docs/P2-收身规则 §三 与计划 P2）：
 *   A. 切事 worker 真跑过：有 events.cut.* 闸，或近 48h 有新热事件；
 *   B. 事件盖得住：近 72h 新增 active 热事件 ≥15 件（约每天 5 件）；
 *   C. 事件质量：待联想事件自撞命中率 ≥80%；
 *   D. 当前开关状态（已关/仍开只做提示，不阻断）。
 * 三项都过才 READY；任何一项不过都打印原因，不许拍脑袋翻。
 */
import { DatabaseSync } from 'node:sqlite'
import { dbPath } from '../src/paths.js'
import { recallEvents } from '../src/modules/event_recall.js'

const db = new DatabaseSync(dbPath(), { readOnly: true })
try { db.exec('PRAGMA busy_timeout=5000') } catch { /* ignore */ }
const aid = db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY created_at LIMIT 1").get()?.id || ''
const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) || {} } catch { return {} } }
const all = (sql, ...a) => { try { return db.prepare(sql).all(...a) } catch { return [] } }

const out = []
const add = (ok, name, detail) => { out.push({ ok, name, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name, '—', detail) }

// A. 切事 worker 跑过
const cuts = all('SELECT key FROM flags WHERE key LIKE ?', 'events.cut.%')
const hotRecent = one(`SELECT COUNT(*) n, MAX(created_at) m FROM hot_events WHERE agent_id=? AND active=1 AND created_at>=?`, aid, new Date(Date.now() - 48 * 3600000).toISOString())
const aOk = cuts.length > 0 || Number(hotRecent.n) > 0
add(aOk, 'A 切事 worker 跑过', cuts.length ? `${cuts.length} 个 events.cut.*；近48h新热事 ${hotRecent.n || 0}` : `没有 events.cut.*；近48h新热事 ${hotRecent.n || 0}`)

// B. 事件盖得住（近 72h 新增 active 热事）
const cover = one(`SELECT COUNT(*) n FROM hot_events WHERE agent_id=? AND active=1 AND created_at>=?`, aid, new Date(Date.now() - 72 * 3600000).toISOString())
const bOk = Number(cover.n) >= 15
add(bOk, 'B 事件盖得住（近72h ≥15 件）', `${cover.n || 0} 件（约每天 ${(Number(cover.n || 0) / 3).toFixed(1)} 件）`)

// C. 事件质量（待联想自撞命中率）
const pending = all("SELECT id, cues FROM hot_events WHERE agent_id=? AND active=1 AND state='待联想'", aid)
let hit = 0
for (const ev of pending) {
  let cues = []
  try { cues = JSON.parse(ev.cues || '[]') } catch { cues = [] }
  const got = cues.slice(0, 3).some((cue) => recallEvents(db, aid, cue, { limit: 5 }).items.some((x) => x.id === ev.id))
  if (got) hit++
}
const rate = pending.length ? Math.round((hit / pending.length) * 100) : 0
const cOk = pending.length > 0 && rate >= 80
add(cOk, 'C 待联想自撞 ≥80%', `${hit}/${pending.length}（${rate}%）`)

// D. 开关现状（提示，不阻断）
const ep = one("SELECT value FROM flags WHERE key='memory.episode.write'").value
console.log((ep === 'off' ? 'INFO 停写开关已关' : 'INFO 停写开关仍开（默认，翻默认就是把它设 off）'))

const ready = aOk && bOk && cOk
console.log(ready ? '\nREADY：三项都过，可以翻默认（记得先影子对比 10 题）' : '\nNOT READY：先补上面 FAIL 的项，别翻')
db.close()
if (!ready) process.exit(1)
