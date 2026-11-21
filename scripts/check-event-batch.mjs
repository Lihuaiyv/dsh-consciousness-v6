/**
 * B2 批量切事锁（2026-11-13）
 *
 * 锁三件事：
 *   1. 分模式：work 段只产一条「工作段」摘要，daily 段照常产事件；
 *   2. 断点续切：切完一块才存进度，重跑从下一块续，不重付；
 *   3. 每日硬顶：maxCalls 到了就停（stopped=cap）。
 * 用假模型跑，不花模型钱、不碰真库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { splitDayBatch } from '../src/modules/event_split.js'
import { writeColdEvents } from '../src/modules/event_write.js'

const P = path.join(os.tmpdir(), 'dsh-check-event-batch-' + Date.now() + '.db')
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

  // 工作段（t1）+ 日常段（t2）
  turn('c1', 'user', '修 dsh.js 的宿主适配层，改到一半', at, 'work')
  turn('c2', 'agent', '好，先补契约那条', at, 'work')
  frag('f1', 'user', '修 dsh.js 的宿主适配层，改到一半', at)
  frag('f2', 'assistant', '好，先补契约那条', at)
  turn('c3', 'user', '晚上那口双层麦辣鸡一般般', at2, 'chat')
  turn('c4', 'agent', '嗯，酱多了点', at2, 'chat')
  frag('f3', 'user', '晚上那口双层麦辣鸡一般般', at2)
  frag('f4', 'assistant', '嗯，酱多了点', at2)

  // 2026-11-15（D59）：日常段也要吃〔留〕——pin 落在哪件的时间区间里，就当那件的证据
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('evt_pin_batch', aid, 'quote.pin',
    JSON.stringify({ text: '这句我想留着', turn_id: null, session: 's1', mood: null, at: at2 }), at2)

  const fake = async (req) => {
    const text = String(req.text || '')
    // 2026-11-17：工作段不再出摘要，跟日常段一样真切事件——所以这里按正文分派，不按 system。
    // 注意先判日常：第二块会带上一块的尾巴当上下文，先判 dsh.js 会把日常块误判成工作块。
    if (text.includes('麦辣鸡')) {
      return JSON.stringify([{ title: '双层麦辣鸡一般般', who: '主人', started_at: at2, ended_at: at2, turn_ids: ['t3'], quotes: ['晚上那口双层麦辣鸡一般般'], cues: ['双层麦辣鸡', '麦辣'], status: '过去了', weight: 0.4, story: '吃了双层麦辣鸡，觉得一般般，酱多了点。' }])
    }
    return JSON.stringify([{ title: '修 dsh.js 宿主适配层', who: '主人', started_at: at, ended_at: at, turn_ids: ['t1'], quotes: ['修 dsh.js 的宿主适配层，改到一半'], cues: ['dsh.js', '宿主适配层'], status: '没过去', weight: 0.6, story: '在修 dsh.js 的宿主适配层，契约补到一半。' }])
  }

  const modes = []
  const eventsSeen = []
  const write = { added: 0, rejected: 0 }
  const r = await splitDayBatch(db, aid, '2026-11-12', {
    complete: fake,
    onEvents: (ev, meta) => {
      modes.push(meta.mode)
      for (const x of ev) eventsSeen.push(x)
      const w = writeColdEvents(db, aid, ev)
      write.added += w.added
      write.rejected += w.rejected
    },
  })
  ok('两块：work + daily 各一次', r.chunks === 2 && r.calls === 2, { chunks: r.chunks, calls: r.calls })
  ok('两种模式都被切到', modes.includes('work') && modes.includes('daily'), modes)
  ok('两条都写进冷库', write.added === 2 && write.rejected === 0, write)
  const titles = db.prepare('SELECT title FROM cold_events ORDER BY created_at').all().map((x) => x.title)
  ok('工作段也真切成了事（不再出摘要）', titles.some((t) => t.includes('dsh.js')) && !titles.some((t) => t.startsWith('工作段：')), titles)
  // 2026-11-15（D59）：pin 落在日常段那件的时间区间里，就该出现在它的引文里
  {
    const daily = eventsSeen.find((e) => String(e.title).includes('麦辣鸡') || String(e.title).includes('一般般'))
    ok('日常段吃到〔留〕的句子', !!(daily && Array.isArray(daily.quotes) && daily.quotes.includes('这句我想留着')), { daily: daily && daily.quotes })
  }
  // 2026-11-17：工作段改成真切之后，引文由模型给，但硬门不变——必须是原文子串
  {
    const workEv = db.prepare("SELECT title, quotes FROM cold_events WHERE title LIKE '%dsh.js%'").get()
    let wq = []
    try { wq = JSON.parse((workEv && workEv.quotes) || '[]') } catch { wq = [] }
    ok('工作段引文是原文子串', wq.some((q) => String(q).includes('修 dsh.js 的宿主适配层')), { quotes: wq })
  }
  const pos = db.prepare("SELECT value FROM flags WHERE key='events.cut.2026-11-12.pos'").get()
  ok('进度已落（断点续切的前提）', !!(pos && pos.value), pos)

  // 重跑应从断点续：把进度清掉重来一次，用 maxCalls=1 验硬顶
  db.prepare("DELETE FROM flags WHERE key LIKE 'events.cut.%'").run()
  const r2 = await splitDayBatch(db, aid, '2026-11-12', { complete: fake, maxCalls: 1, onEvents: () => {} })
  ok('硬顶：到 1 次就停', r2.calls === 1 && r2.stopped === 'cap' && r2.finished === false, { calls: r2.calls, stopped: r2.stopped, finished: r2.finished })
  const r3 = await splitDayBatch(db, aid, '2026-11-12', { complete: fake, maxCalls: 1, onEvents: () => {} })
  ok('续跑：第二轮从下一块开始', r3.startedAt === 1 && r3.finished === true, { startedAt: r3.startedAt, finished: r3.finished })

  // 2026-11-15（D49）：断点已到最后一块之后 → 再跑一轮应该「没块可切但已完成」，不是永远 pending
  // 2026-11-17（D72）：最后一块还会长——断点在这块里时要重切这块，不能跳过
  const r4 = await splitDayBatch(db, aid, '2026-11-12', { complete: fake, onEvents: () => {} })
  ok('断点已在末尾：finished 为真（不再空转 pending）', r4.finished === true, { finished: r4.finished, calls: r4.calls, startedAt: r4.startedAt, chunks: r4.chunks })

  // 追加一段新碎片（同一个 turn_id 的新行、更晚的时间）→ 再跑一轮应该切到新尾巴
  const lateAt = '2026-11-12T09:00:00Z'
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at,turn_id,mode) VALUES(?,?,?,?,?,?,?)')
    .run('c9', aid, 'user', '再补一句：晚上那顿还行', lateAt, 't9', 'chat')
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at,turn_id,mode) VALUES(?,?,?,?,?,?,?)')
    .run('c10', aid, 'agent', '嗯，那挺好', lateAt, 't9', 'chat')
  db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('f9', aid, 's1', 't9', 9, 'user', '再补一句：晚上那顿还行', lateAt, '2026-11-12')
  db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('f10', aid, 's1', 't9', 10, 'assistant', '嗯，那挺好', lateAt, '2026-11-12')
  const lateFake = async (req) => {
    if (/digest/.test(String(req.system))) return JSON.stringify({ digest: '补聊晚饭', cues: ['晚饭', '挺好'] })
    return JSON.stringify([{ title: '补聊晚饭', who: '主人', started_at: lateAt, ended_at: lateAt, turn_ids: ['t9'], quotes: ['再补一句：晚上那顿还行'], cues: ['晚饭', '挺好'], status: '过去了', weight: 0.4, story: '补齐晚饭那句。' }])
  }
  const r5 = await splitDayBatch(db, aid, '2026-11-12', { complete: lateFake, onEvents: () => {} })
  const pos2 = db.prepare("SELECT value FROM flags WHERE key='events.cut.2026-11-12.pos'").get()
  ok('尾巴长出来：要切到新尾巴', r5.finished === true && pos2 && pos2.value === 't9', { finished: r5.finished, pos: pos2 && pos2.value, startedAt: r5.startedAt })

  db.close()
} catch (e) {
  fails++
  console.log('FAIL 批量切事锁异常:', (e && e.stack) || e)
} finally {
  try { fs.rmSync(P) } catch { /* 清理失败不影响结论 */ }
}
process.exit(fails ? 1 : 0)
