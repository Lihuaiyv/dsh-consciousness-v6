/**
 * daily 主模型失败 → 本地逐件兜底（2026-11-13）
 *
 * 锁三件事：
 *   1. 主模型抛错 + 开关开 → 走本地逐件，事件仍落库；
 *   2. 兜底事件 weight ≤0.35（低信心，不冒充完整的事）；
 *   3. 本地也失败 → 不崩、不写假事件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { setFlag } from '../src/kernel.js'
import { splitDayBatch } from '../src/modules/event_split.js'
import { writeColdEvents } from '../src/modules/event_write.js'

const P = path.join(os.tmpdir(), 'dsh-check-daily-fallback-' + Date.now() + '.db')
let fails = 0
const ok = (name, cond, extra) => {
  if (cond) { console.log('PASS', name) } else { fails++; console.log('FAIL', name, extra ? JSON.stringify(extra) : '') }
}

try {
  const db = openDb(P)
  const aid = 'a1'
  const at = '2026-11-12T03:00:00Z'
  const turn = (id, role, text, t) => db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at,turn_id,mode) VALUES(?,?,?,?,?,?,?)').run(id, aid, role, text, t, 't' + id.slice(1), 'chat')
  const frag = (id, role, text, t) => db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)').run(id, aid, 's1', 't' + id.slice(1), Number(id.slice(1)), role, text, t, '2026-11-12')
  turn('c1', 'user', '修 dsh.js 的宿主适配层，改到一半', at)
  turn('c2', 'agent', '好，先补契约那条', at)
  frag('f1', 'user', '修 dsh.js 的宿主适配层，改到一半', at)
  frag('f2', 'assistant', '好，先补契约那条', at)

  setFlag(db, 'memory.cut.daily.local_fallback', '1')

  const hostDown = async () => { throw new Error('host quota exhausted') }
  const local = async (req) => {
    if (/开头那一件/.test(String(req.system))) {
      return { text: JSON.stringify({ title: '修宿主适配层', who: '主人', started_at: at, ended_at: at, turn_ids: ['t1'], quotes: ['修 dsh.js 的宿主适配层，改到一半'], cues: ['宿主适配层'], status: '过去了', weight: 0.5, story: '在修 dsh.js 的宿主适配层。' }), ms: 5 }
    }
    return { text: '{}', ms: 5 }
  }

  const r = await splitDayBatch(db, aid, '2026-11-12', {
    complete: hostDown,
    localCut: local,
    onEvents: (ev) => { writeColdEvents(db, aid, ev) },
  })
  ok('主模型挂了也能兜底（fallbackCalls=1）', r.fallbackCalls === 1, { fallbackCalls: r.fallbackCalls, calls: r.calls, results: r.results })
  const ev = db.prepare('SELECT title,weight,cues FROM cold_events').get()
  ok('兜底事件落库', !!ev && ev.title === '修宿主适配层', ev)
  ok('兜底事件 weight ≤0.35', !!ev && Number(ev.weight) <= 0.35, ev)
  ok('cues 带规则补的专名（dsh.js）', !!ev && String(ev.cues).includes('dsh.js'), ev && ev.cues)

  // 本地也挂 → 不崩、不写假事件
  db.prepare('DELETE FROM cold_events').run()
  db.prepare('DELETE FROM hot_events').run()
  db.prepare("DELETE FROM flags WHERE key LIKE 'events.cut.%'").run()
  const r2 = await splitDayBatch(db, aid, '2026-11-12', {
    complete: hostDown,
    localCut: async () => { throw new Error('local down') },
    onEvents: () => {},
  })
  ok('本地也挂：不崩、没有假事件', db.prepare('SELECT COUNT(*) n FROM cold_events').get().n === 0, { r2: r2.results })

  db.close()
} catch (e) {
  fails++
  console.log('FAIL daily 兜底异常:', (e && e.stack) || e)
} finally {
  try { fs.rmSync(P) } catch { /* 清理失败不影响结论 */ }
}
process.exit(fails ? 1 : 0)
