/**
 * 界面「我最近怎么感觉」：每条 feel 带着产生它的那轮对话（你一句、我一句）。
 * 运行：node test/feel-around.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { listFeels, getFeel } from '../src/modules/feel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelaround-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_feelaround'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '圆', 'daily', 'active', new Date().toISOString())

const iso = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString()
function turn(id, role, text, offsetSec) {
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, aid, role, text, '[]', null, iso(offsetSec), null)
}
function feel(id, text, offsetSec) {
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid, iso(offsetSec), text, 'curious', 0.1, 0.2, 0.3, null, 'tool')
}

// 一条有上下文的：user 在前，agent 在后
feel('afe_ctx', '被问得心里有点热', 0)
turn('cht_u', 'user', '你最近还好吗', -30)
turn('cht_a', 'agent', '还行，你呢。这回我想说实话。', 20)
// 一条没有对话的
feel('afe_solo', '空落落的一条', -7200)

const list = listFeels(db, aid, { limit: 10 })
const hit = list.find((f) => f.id === 'afe_ctx')
check('列表带 around.user', hit && hit.around && hit.around.user === '你最近还好吗', hit && hit.around)
check('列表带 around.agent', hit && hit.around && hit.around.agent === '还行，你呢。这回我想说实话。', hit && hit.around)
const solo = list.find((f) => f.id === 'afe_solo')
check('没对话时 around 为空', solo && solo.around && solo.around.user === null && solo.around.agent === null, solo && solo.around)

const one = getFeel(db, aid, 'afe_ctx')
check('单条也带前后两句', one && one.around && one.around.user === '你最近还好吗' && one.around.agent.startsWith('还行'), one && one.around)

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
