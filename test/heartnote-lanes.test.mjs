/**
 * 心事匣两区（2026-11-16 主人定）：
 *   生活区 = 我记下的心情/念头，跨会话、不标出处；
 *   工作区 = 具体任务，换会话时注明「今天 00:23 你在另一个会话里留给自己的任务：…」。
 * 运行：node test/heartnote-lanes.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import {
  writeHeartNote, readHeartNotes, clearHeartNote, heartNoteLines, heartNoteTick,
} from '../src/modules/heartnote.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-heartnote-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_heartnote'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
  .run(aid, '心事匣', 'daily', 'active', now(), 13)
// 测试里不让冷却闸挡住「拍」：冷却 0 分钟、日上限放宽
db.prepare('INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)').run(aid, 'heart.note.min_gap_minutes', '0', now())
db.prepare('INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)').run(aid, 'heart.note.max_beats_per_day', '1000', now())

// ---- 1 两区各写一条，互不覆盖
{
  writeHeartNote(db, aid, '今天有点困，但心里是稳的。', { lane: 'life' })
  writeHeartNote(db, aid, '把心事匣分两区，先写验收再动代码。', { lane: 'work', sessionId: 'session-A' })
  const both = readHeartNotes(db, aid)
  check('生活区写进去了', both.life && both.life.text.includes('有点困'), both)
  check('工作区写进去了', both.work && both.work.text.includes('分两区'), both)
  check('两区互不覆盖', both.life.text !== both.work.text)
}

// ---- 2 注入：生活区不标出处；工作区同会话不带「另一个会话」
{
  const lines = heartNoteLines(db, aid, Date.now(), { sessionId: 'session-A' })
  const text = lines.join('\n')
  check('生活区有一行', text.includes('(我上一条留给自己的话：今天有点困'), text)
  check('工作区同会话 → 不带「另一个会话」', text.includes('(你留给自己的任务：把心事匣分两区') && !text.includes('另一个会话'), text)
  check('末尾有「还惦记就重写」的提醒', text.includes('还惦记就用 heart_note'), text)
}

// ---- 3 同一拍第二次拼装不重复挂
{
  const again = heartNoteLines(db, aid, Date.now(), { sessionId: 'session-A' })
  check('同一拍只挂一次', again.length === 0, again)
}

// ---- 4 换会话：工作区注明出处，生活区照旧不标
{
  // 先把上一拍的两区「露过」推进一拍，让它们重新可挂
  heartNoteTick(db, aid, Date.now())
  const at = Date.now()
  const lines = heartNoteLines(db, aid, at, { sessionId: 'session-B' })
  const text = lines.join('\n')
  check('换会话 → 工作区注明是另一个会话', /\(\S* \S+ 你在另一个会话里留给自己的任务：把心事匣分两区/.test(text), text)
  check('生活区仍不标出处', text.includes('(我上一条留给自己的话：今天有点困') && !/留给自己的话：[^)]*另一个会话/.test(text), text)
}

// ---- 5 露过没再写 → 下一拍散（两区各自散）
{
  heartNoteTick(db, aid, Date.now() + 1) // 这一拍把「露过且没重写」的两区都散掉
  const both = readHeartNotes(db, aid)
  check('生活区露过没续 → 散了', both.life === null, both.life)
  check('工作区露过没续 → 散了', both.work === null, both.work)
}

// ---- 6 只放一个区
{
  writeHeartNote(db, aid, '留着看的那句。', { lane: 'life' })
  writeHeartNote(db, aid, '这条任务要放掉。', { lane: 'work', sessionId: 'session-A' })
  const gone = clearHeartNote(db, aid, { lane: 'work' })
  const both = readHeartNotes(db, aid)
  check('只放了工作区', gone && gone.work && !gone.life, gone)
  check('生活区还在', both.life && both.life.text.includes('留着看'), both)
  check('工作区空了', both.work === null, both)
}

// ---- 7 老数据（单槽 note）并进生活区
{
  const aid2 = 'agt_heartnote_old'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
    .run(aid2, '老心事', 'daily', 'active', now(), 13)
  db.prepare('INSERT INTO flags(key,value) VALUES(?,?)').run('heart_note.' + aid2, JSON.stringify({
    beats: 3, note: { text: '老格式那条', leftAt: Date.now(), beatNo: 2, shownAtBeat: null, touchedAtBeat: 2 },
  }))
  const both = readHeartNotes(db, aid2)
  check('老的单槽 → 生活区', both.life && both.life.text === '老格式那条', both)
  check('老条目不会变成工作区', both.work === null, both)
}

// ---- 8 没有会话 id 时，工作区只给普通说法（不瞎标）
{
  // 换一个干净的意识体，避免拍数干扰
  const aid3 = 'agt_heartnote_nosid'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
    .run(aid3, '无会话', 'daily', 'active', now(), 13)
  writeHeartNote(db, aid3, '一条没记会话的任务。', { lane: 'work' })
  const text = heartNoteLines(db, aid3, Date.now(), {}).join('\n')
  check('没有会话 id → 不标「另一个会话」', text.includes('(你留给自己的任务：一条没记会话的任务') && !text.includes('另一个会话'), text)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
