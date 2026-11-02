/**
 * 收尾测试：只在本地的深夜、今天聊够了、对方没在提问/告别时给念头。
 * 运行：node test/closing.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { closingIntentOf } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-closing-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_close_' + Math.random().toString(36).slice(2, 8)
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '收尾', 'daily', 'active', now())

function seedTurns(at, lastUserText, lastAgentText = '嗯。') {
  db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(aid)
  const rows = []
  for (let i = 0; i < 4; i++) {
    rows.push({ role: 'user', text: i === 3 ? lastUserText : '在吗 ' + i })
    rows.push({ role: 'agent', text: i === 3 ? lastAgentText : '嗯，在。' })
  }
  const ins = db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)')
  rows.forEach((r, i) => ins.run('ct_' + i, aid, r.role, r.text, new Date(at - (rows.length - i) * 60000).toISOString()))
}

const night = new Date(2026, 10, 2, 23, 40).getTime()
const day = new Date(2026, 10, 2, 15, 0).getTime()

// 1) 深夜 + 8 条 + 陈述句 → 给念头
seedTurns(night, '今天这堆东西总算改完了')
const a = closingIntentOf(db, aid, { at: night })
check('深夜聊够了：给收尾念头', !!a && a.line.includes('先收一收'), a)

// 2) 对方在提问 → 不打断
seedTurns(night, '你困不困？')
check('对方提问：不收尾', closingIntentOf(db, aid, { at: night }) === null)

// 3) 对方在告别 → 不重复
seedTurns(night, '晚安')
check('对方说晚安：不重复收尾', closingIntentOf(db, aid, { at: night }) === null)

// 4) 白天 → 不收尾
seedTurns(day, '今天这堆东西总算改完了')
check('白天：不收尾', closingIntentOf(db, aid, { at: day }) === null)

// 5) 刚说过收尾 → 30 分钟内不再说
seedTurns(night, '今天这堆东西总算改完了', '我先去睡了。')
check('刚收过尾：30 分钟内不再说', closingIntentOf(db, aid, { at: night }) === null)

// 6) 聊得不够 → 不催
db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(aid)
db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)')
  .run('ct_x', aid, 'user', '嗯', new Date(night - 60000).toISOString())
check('只聊了两句：不催收尾', closingIntentOf(db, aid, { at: night }) === null)

// 7) quiet 档：换一句更软的说法
seedTurns(night, '今天这堆东西总算改完了')
const q = closingIntentOf(db, aid, { at: night, level: 'quiet' })
check('quiet 档：换软说法', !!q && q.line.includes('不太想说话'), q)

// 8) 23:10 还没到 23:30：不催
const early = new Date(2026, 10, 2, 23, 10).getTime()
seedTurns(early, '今天这堆东西总算改完了')
check('23:10 还没到点：不收尾', closingIntentOf(db, aid, { at: early }) === null)

// 9) 疑问词在中间也算问句
seedTurns(night, '你怎么看')
check('「你怎么看」算问句：不收尾', closingIntentOf(db, aid, { at: night }) === null)

// 10) 告别语不在开头也算
seedTurns(night, '那我先睡了')
check('「我先睡了」是告别：不重复', closingIntentOf(db, aid, { at: night }) === null)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
