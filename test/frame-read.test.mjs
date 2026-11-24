/**
 * 找核读链单测（2026-11-23）：临时库造帧，验「读成一行」的六种情况。
 * 运行：node test/frame-read.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { ensureTable } from '../src/modules/frame_shadow.js'
import { buildReadLine, buildReadLineSync } from '../src/modules/frame_read.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

function newDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-read-'))
  const db = openDb(path.join(dir, 'app.db'))
  ensureTable(db)
  return db
}
const insF = (db, id, turn, at, core, under = null) =>
  db.prepare('INSERT OR REPLACE INTO frame_shadow (id,turn_id,created_at,core,core_goal,sents,text,under_id,plan) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, turn, at, core, '', '1', core, under, null)
const insC = (db, id, turn, conv, at = '2026-11-23T03:00:00.000Z') =>
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id,turn_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, 'agt_read', 'agent', 'x', '[]', null, at, conv, turn)

// 1 单链 + 动作去重（动作与目的同名 → 丢掉）
{
  const db = newDb()
  insF(db, 't1-A', 't1', '2026-11-23T01:00:00.000Z', '甲')
  insF(db, 't1-B', 't1', '2026-11-23T01:00:00.000Z', '乙', 't1-A')
  insF(db, 't1-C', 't1', '2026-11-23T01:00:00.000Z', '乙', 't1-A') // 重复动作
  insF(db, 't1-D', 't1', '2026-11-23T01:00:00.000Z', '甲', 't1-A') // 与目的同名
  const line = await buildReadLine(db, 'agt_read')
  check('单链：读成「在成 + 补话」', line.includes('在成：甲') && line.includes('补话：乙'), line)
  check('单链：动作去重（乙只出现一次、同名目的不重复）', (line.match(/乙/g) || []).length === 1 && (line.match(/甲/g) || []).length === 1, line)
}

// 2 跨轮：目的往上接
{
  const db = newDb()
  insF(db, 't0-A', 't0', '2026-11-23T00:00:00.000Z', '上一件')
  insF(db, 't1-A', 't1', '2026-11-23T01:00:00.000Z', '甲', 't0-A')
  const line = await buildReadLine(db, 'agt_read')
  check('跨轮：带上「接着」', line.includes('在成：甲') && line.includes('接着：上一件'), line)
}

// 2b 跨轮但父子同名：不重复写「接着」
{
  const db = newDb()
  insF(db, 't0-A', 't0', '2026-11-23T00:00:00.000Z', '同一件事')
  insF(db, 't1-A', 't1', '2026-11-23T01:00:00.000Z', '同一件事', 't0-A')
  const line = await buildReadLine(db, 'agt_read')
  check('跨轮同名：不重复写「接着」', !line.includes('接着：') && (line.match(/同一件事/g) || []).length === 1, line)
}

// 3 空库
{
  const db = newDb()
  const line = await buildReadLine(db, 'agt_read')
  check('空库：返回空串', line === '', line)
}

// 4 会话过滤：只读当前会话的帧
{
  const db = newDb()
  insC(db, 'ct_a', 'ta', 'conv:a')
  insC(db, 'ct_b', 'tb', 'conv:b')
  insF(db, 'ta-A', 'ta', '2026-11-23T01:00:00.000Z', '甲的活')
  insF(db, 'tb-A', 'tb', '2026-11-23T01:00:00.000Z', '乙的活')
  const a = await buildReadLine(db, 'agt_read', { conversationId: 'conv:a' })
  const b = await buildReadLine(db, 'agt_read', { conversationId: 'conv:b' })
  check('会话过滤：A 只读到自己的', a.includes('甲的活') && !a.includes('乙的活'), a)
  check('会话过滤：B 只读到自己的', b.includes('乙的活') && !b.includes('甲的活'), b)
}

// 5 截断：超长一行不超过 max
{
  const db = newDb()
  insF(db, 't1-A', 't1', '2026-11-23T01:00:00.000Z', '这是一件特别特别长的事情名字用来测试截断是否生效啊啊啊啊啊')
  const line = await buildReadLine(db, 'agt_read', { max: 30 })
  check('截断：不超过 max、带省略号', line.length <= 30 && line.endsWith('…'), { len: line.length, line })
}

// 6 没有目的、只有动作：也读得出来（目的兜底取第一行）
{
  const db = newDb()
  insF(db, 't1-A', 't1', '2026-11-23T01:00:00.000Z', '只剩动作')
  const line = await buildReadLine(db, 'agt_read')
  check('只有一行：当目的读', line.includes('在成：只剩动作'), line)
}

// 7 同步版（注入用）与异步版读同一行
{
  const db = newDb()
  insF(db, 't1-A', 't1', '2026-11-23T01:00:00.000Z', '甲')
  insF(db, 't1-B', 't1', '2026-11-23T01:00:00.000Z', '乙', 't1-A')
  const a = await buildReadLine(db, 'agt_read')
  const s = buildReadLineSync(db, 'agt_read')
  check('同步版和异步版读同一行', a === s && a.length > 0, { a, s })
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
