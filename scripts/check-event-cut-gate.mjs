/**
 * D39 / D38 事件切事闸验收（2026-11-14）
 *
 * 锁的是「太早盖章」：
 *   1. done 的章必须带指纹（doneAt = 切到的最晚碎片时间）；
 *   2. 章之后又来了新碎片 → 这一天要被判成「需要续切」，不能永远跳过；
 *   3. 老闸（只有 agt=done、没有 state/doneAt）不批量重切，只报 legacy-done；
 *   4. 三处键（state / aid.state / agt done）要一起写，worker 和旧闸都能读到。
 * 用临时库跑，不碰真库、不花钱。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { dayCutGate, stampDayCut, latestFragmentAt } from '../src/modules/event_write.js'

const P = path.join(os.tmpdir(), 'dsh-check-cut-gate-' + Date.now() + '.db')
let fails = 0
const ok = (name, cond, extra) => {
  if (cond) console.log('PASS', name)
  else { fails++; console.log('FAIL', name, extra ? JSON.stringify(extra) : '') }
}

try {
  const db = openDb(P)
  const aid = 'a1'
  const day = '2026-11-12'
  const frag = (id, t) => db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, aid, 's1', 't' + id, Number(id.slice(1)), 'user', '第 ' + id + ' 句', t, day)

  frag('g1', '2026-11-12T03:00:00Z')
  frag('g2', '2026-11-12T04:00:00Z')

  ok('没切过的天：该切', (() => { const g = dayCutGate(db, aid, day); return g.cut === true && g.reason === 'not-done' })(), dayCutGate(db, aid, day))

  // 盖章：done + 指纹 = 当前最新碎片
  const stamped = stampDayCut(db, aid, day, 'done')
  ok('盖章指纹 = 最新碎片时间', stamped === '2026-11-12T04:00:00Z', { stamped })

  const flags = Object.fromEntries(db.prepare('SELECT key,value FROM flags').all().map((r) => [r.key, r.value]))
  ok('三处键一起写（state / aid.state / agt done）',
    flags['events.cut.' + day + '.state'] === 'done'
    && flags['events.cut.' + day + '.' + aid + '.state'] === 'done'
    && flags['events.cut.' + day + '.' + aid] === 'done',
    { state: flags['events.cut.' + day + '.state'], aidState: flags['events.cut.' + day + '.' + aid + '.state'], agt: flags['events.cut.' + day + '.' + aid] })

  ok('切完了、没有新碎片：跳过', (() => { const g = dayCutGate(db, aid, day); return g.cut === false && g.reason === 'up-to-date' })(), dayCutGate(db, aid, day))

  // 2026-11-16（D70）：指纹要取「实际切到的那一轮」，不是「碎片最新到哪」；给一个比最新碎片早的 marker
  {
    const db7 = openDb(P + '7')
    const day7 = '2026-11-09'
    db7.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('m1', aid, 's1', 'tm1', 1, 'user', '句', '2026-11-09T03:00:00Z', day7)
    db7.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('m2', aid, 's1', 'tm2', 2, 'user', '句', '2026-11-09T05:00:00Z', day7)
    db7.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('m3', aid, 's1', 'tm3', 3, 'user', '句', '2026-11-09T05:00:00Z', day7)
    const stampMarker = stampDayCut(db7, aid, day7, 'done', '2026-11-09T03:00:00Z')
    ok('指纹取实际切到的那一轮（marker），不取碎片最新', stampMarker === '2026-11-09T03:00:00Z', { stampMarker })
    const g7 = dayCutGate(db7, aid, day7)
    ok('章盖在进度前面时：判回要续切', g7.cut === true && g7.reason === 'new-fragments', g7)
    db7.close()
  }

  // 盖章之后又聊了 → 必须判成「需要续切」
  // 2026-11-17：这条原来用 23:30Z，按本地日（UTC+8）那已经是次日凌晨 07:30，不该算 11-12 的尾巴；
  // 日界统一后改用本地 18:00 的碎片，测的仍然是「章之后又来新碎片」。
  frag('g3', '2026-11-12T10:00:00Z')
  ok('章之后又来新碎片：要续切', (() => { const g = dayCutGate(db, aid, day); return g.cut === true && g.reason === 'new-fragments' })(), dayCutGate(db, aid, day))

  // 老闸：只有 agt=done，没有 state / doneAt
  const db2 = openDb(P + '2')
  const day2 = '2026-11-11'
  const frag2 = (id, t) => db2.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, aid, 's1', 't' + id, Number(id.slice(1)), 'user', '句', t, day2)
  frag2('h1', '2026-11-11T03:00:00Z')
  db2.prepare("INSERT INTO flags(key,value) VALUES(?,?)").run('events.cut.' + day2 + '.' + aid, 'done')
  const g2 = dayCutGate(db2, aid, day2)
  ok('老闸不批量重切：legacy-done', g2.cut === false && g2.reason === 'legacy-done', g2)
  ok('老闸提示可能有洞：backfillGap', g2.backfillGap === true, g2)
  ok('老闸能补指纹', latestFragmentAt(db2, aid, day2) === '2026-11-11T03:00:00Z')

  // 回填盖的章：state=pending + agt=done + 没有 pos → 不重切（否则整天再跑一遍）
  const db3 = openDb(P + '3')
  const day3 = '2026-11-10'
  db3.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('k1', aid, 's1', 'tk1', 1, 'user', '句', '2026-11-10T03:00:00Z', day3)
  db3.prepare("INSERT INTO flags(key,value) VALUES(?,?)").run('events.cut.' + day3 + '.state', 'pending')
  db3.prepare("INSERT INTO flags(key,value) VALUES(?,?)").run('events.cut.' + day3 + '.' + aid, 'done')
  const g3 = dayCutGate(db3, aid, day3)
  ok('回填章（无 pos）不重切', g3.cut === false && g3.reason === 'legacy-done', g3)

  // 断点续切的章：state=pending + agt=done + 有 pos → 必须继续（11-13 的教训）
  db3.prepare("INSERT INTO flags(key,value) VALUES(?,?)").run('events.cut.' + day3 + '.pos', 'tk1')
  const g4 = dayCutGate(db3, aid, day3)
  ok('断点章（有 pos）要续切', g4.cut === true && g4.reason === 'not-done', g4)

  // 有 pos、但冷库已经覆盖到最新碎片（回填补过）→ 不重切，只补指纹
  db3.prepare("INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)")
    .run('k2', aid, 's1', 'tk2', 2, 'user', '句', '2026-11-10T04:00:00Z', day3)
  const g5 = dayCutGate(db3, aid, day3)
  ok('冷库没覆盖到最新：仍要续切', g5.cut === true && g5.reason === 'not-done', g5)
  db3.prepare(`INSERT INTO cold_events(id,agent_id,title,story,who,start_at,end_at,turn_ids,quotes,cues,status,weight,quality,cut_rev,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('cev_g', aid, '测试件', '经过', '主人', '2026-11-10T03:00:00Z', '2026-11-10T04:00:00Z', '["tk1","tk2"]', '["句"]', '["测试"]', '过去了', 0.5, 'model', 1, '2026-11-10T05:00:00Z')
  const g6 = dayCutGate(db3, aid, day3)
  ok('冷库已覆盖到最新：covered-by-events 不重切', g6.cut === false && g6.reason === 'covered-by-events', g6)

  // 空天
  ok('没有碎片：不切', (() => { const g = dayCutGate(db, aid, '2026-11-01'); return g.cut === false && g.reason === 'no-fragments' })(), dayCutGate(db, aid, '2026-11-01'))

  db.close()
  db2.close()
} catch (e) {
  fails++
  console.log('FAIL 切事闸异常:', (e && e.stack) || e)
} finally {
  for (const p of [P, P + '2']) { try { fs.rmSync(p) } catch { /* 不影响结论 */ } }
}
process.exit(fails ? 1 : 0)
