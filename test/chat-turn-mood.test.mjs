/**
 * chat_turns.mood：她说完一句，下一轮要读得到「我上一句是什么调子说的」。
 * 运行：node test/chat-turn-mood.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { moodLabelOf } from '../src/modules/affect.js'
import { writeChatTurn } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-mood-'))
const db = openDb(path.join(dir, 'app.db'))
const at = now()
db.prepare("INSERT INTO agents(id,name,created_at) VALUES('agt_mood','测试',?)").run(at)

// 1) 没有情绪：不编标签
check('没情绪时是 null', moodLabelOf(db, 'agt_mood') === null, moodLabelOf(db, 'agt_mood'))

// 2) 写一轮两行：不再写死 null
writeChatTurn(db, 'agt_mood', 'user', '在吗', at)
writeChatTurn(db, 'agt_mood', 'agent', '在。', at)
const rows = db.prepare("SELECT role,mood FROM chat_turns WHERE agent_id='agt_mood' ORDER BY rowid").all()
check('一轮写两行', rows.length === 2, rows)
check('没情绪时不假装有情绪', rows.every((r) => r.mood === null), rows.map((r) => r.mood))

// 3) 有情绪：写进这一句
db.prepare('INSERT INTO affect_state(agent_id,primary_label,intensity,mood,updated_at) VALUES(?,?,?,?,?)')
  .run('agt_mood', 'irritated', 0.7, 0.4, at)
check('有情绪时读得到标签', moodLabelOf(db, 'agt_mood') === 'irritated', moodLabelOf(db, 'agt_mood'))

writeChatTurn(db, 'agt_mood', 'agent', '嗯。', at)
const last = db.prepare("SELECT mood FROM chat_turns WHERE agent_id='agt_mood' AND role='agent' ORDER BY rowid DESC LIMIT 1").get()
check('新写的 agent 行带上了情绪', last && last.mood === 'irritated', last)

// 4) 老库没有 affect_state 表：不抛
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-mood2-'))
const db2 = openDb(path.join(dir2, 'app.db'))
db2.exec('DROP TABLE IF EXISTS affect_state')
db2.prepare("INSERT INTO agents(id,name,created_at) VALUES('agt_old','老库',?)").run(now())
let okOld = false
try { okOld = moodLabelOf(db2, 'agt_old') === null } catch { okOld = false }
check('没有情绪表时不抛', okOld, null)
let wroteOld = false
try { writeChatTurn(db2, 'agt_old', 'agent', '嗯', now()); wroteOld = true } catch { wroteOld = false }
check('没有情绪表时照样写对话', wroteOld, null)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
