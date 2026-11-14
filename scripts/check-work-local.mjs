/**
 * B1 work 段本地锁（2026-11-13）
 *
 * 锁三件事：
 *   1. work 块走 localCut，不花主模型调用；
 *   2. daily 块仍走主模型（calls 只数主模型）；
 *   3. 本地失败时回退主模型，事不能丢。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { splitDayBatch } from '../src/modules/event_split.js'
import { writeColdEvents } from '../src/modules/event_write.js'

const P = path.join(os.tmpdir(), 'dsh-check-work-local-' + Date.now() + '.db')
let fails = 0
const ok = (name, cond, extra) => {
  if (cond) { console.log('PASS', name) } else { fails++; console.log('FAIL', name, extra ? JSON.stringify(extra) : '') }
}

try {
  const db = openDb(P)
  const aid = 'a1'
  const at = '2026-11-12T03:00:00Z'
  const at2 = '2026-11-12T06:00:00Z'
  const turn = (id, role, text, t, mode) => db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at,turn_id,mode) VALUES(?,?,?,?,?,?,?)').run(id, aid, role, text, t, 't' + id.slice(1), mode)
  const frag = (id, role, text, t) => db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)').run(id, aid, 's1', 't' + id.slice(1), Number(id.slice(1)), role, text, t, '2026-11-12')

  turn('c1', 'user', '修 dsh.js 的宿主适配层，改到一半', at, 'work')
  turn('c2', 'agent', '好，先补契约那条', at, 'work')
  frag('f1', 'user', '修 dsh.js 的宿主适配层，改到一半', at)
  frag('f2', 'assistant', '好，先补契约那条', at)
  turn('c3', 'user', '晚上那口双层麦辣鸡一般般', at2, 'chat')
  turn('c4', 'agent', '嗯，酱多了点', at2, 'chat')
  frag('f3', 'user', '晚上那口双层麦辣鸡一般般', at2)
  frag('f4', 'assistant', '嗯，酱多了点', at2)

  let hostCalls = 0
  const host = async (req) => {
    hostCalls++
    if (/digest/.test(String(req.system))) return JSON.stringify({ digest: '主模型兜底摘要', cues: ['主模型', '兜底'] })
    return JSON.stringify([{ title: '双层麦辣鸡一般般', who: '主人', started_at: at2, ended_at: at2, turn_ids: ['t3'], quotes: ['晚上那口双层麦辣鸡一般般'], cues: ['双层麦辣鸡', '麦辣'], status: '过去了', weight: 0.4, story: '吃了双层麦辣鸡，觉得一般般，酱多了点。' }])
  }
  let localCalls = 0
  const local = async () => {
    localCalls++
    return { text: JSON.stringify({ digest: '本地摘要：修宿主适配层', cues: ['宿主适配层', '契约'] }), ms: 7 }
  }

  const r = await splitDayBatch(db, aid, '2026-11-12', {
    complete: host,
    localCut: local,
    onEvents: (ev) => { writeColdEvents(db, aid, ev) },
  })
  ok('work 块走本地（localCalls=1）', localCalls === 1 && r.localCalls === 1, { localCalls, r: r.localCalls })
  ok('daily 块仍走主模型（hostCalls=1）', hostCalls === 1 && r.calls === 1, { hostCalls, calls: r.calls })
  const titles = db.prepare('SELECT title FROM cold_events ORDER BY created_at').all().map((x) => x.title)
  ok('两条都写进冷库', titles.length === 2, titles)
  ok('work 段用的是本地摘要', titles.some((t) => t.includes('本地摘要')), titles)

  // 本地失败 → work 走词法（不花主模型钱），daily 仍主模型
  db.prepare("DELETE FROM flags WHERE key LIKE 'events.cut.%'").run()
  db.prepare('DELETE FROM cold_events').run()
  db.prepare('DELETE FROM hot_events').run()
  let host2 = 0, local2 = 0
  const r2 = await splitDayBatch(db, aid, '2026-11-12', {
    complete: async (req) => { host2++; return host(req) },
    localCut: async () => { local2++; throw new Error('local down') },
    onEvents: (ev) => { writeColdEvents(db, aid, ev) },
  })
  ok('本地失败 → work 走词法（host 只被 daily 调）', host2 === 1 && local2 === 1 && r2.lexicalCalls === 1, { host2, local2, lexical: r2.lexicalCalls })
  const lex = db.prepare("SELECT title,quality,weight FROM cold_events WHERE quality='lexical'").get()
  ok('词法事件落库、quality=lexical、weight≤0.35', !!lex && Number(lex.weight) <= 0.35, lex)
  ok('回退后 daily 事件仍落库', db.prepare("SELECT COUNT(*) n FROM cold_events WHERE quality='model'").get().n === 1)

  db.close()
} catch (e) {
  fails++
  console.log('FAIL work 本地锁异常:', (e && e.stack) || e)
} finally {
  try { fs.rmSync(P) } catch { /* 清理失败不影响结论 */ }
}
process.exit(fails ? 1 : 0)
