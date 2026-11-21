/**
 * 夜里切事给聊天让路：最近 N 分钟有真人说话就不切。
 * 运行：node test/event-cut-pause.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { writeParam } from '../src/kernel.js'
import { createWorkers } from '../src/host/workers.js'
import { localBegin, localEnd, localBusy } from '../src/modules/local_llm.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-cut-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'a1'
db.prepare('INSERT INTO agents(id,name,created_at) VALUES(?,?,?)').run(aid, '小汐', new Date().toISOString())

const w = createWorkers({
  ensureDb: () => db,
  enabledAgentIds: () => [aid],
  summarizeForDiary: () => null,
  probe: () => {},
})

const now = Date.now()
const iso = (ms) => new Date(ms).toISOString()
const putTurn = (id, role, ms) => db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)')
  .run(id, aid, role, 'x', iso(ms))

check('没人说过话 → 可以切', w._humanQuiet(db, aid) === true)

putTurn('t1', 'user', now - 30000)
check('30 秒前有人说话 → 让路', w._humanQuiet(db, aid) === false)

db.prepare("UPDATE chat_turns SET created_at=? WHERE id='t1'").run(iso(now - 120000))
check('2 分钟前说过话（默认窗口 1 分钟）→ 可以切', w._humanQuiet(db, aid) === true)

db.prepare("UPDATE chat_turns SET role='assistant', created_at=? WHERE id='t1'").run(iso(now - 30000))
check('只有 assistant 在说 → 不算有人在聊', w._humanQuiet(db, aid) === true)

db.prepare("UPDATE chat_turns SET role='user', created_at=? WHERE id='t1'").run(iso(now + 10 * 60000))
check('未来时间（时钟异常）→ 不卡死，仍可切', w._humanQuiet(db, aid) === true)

db.prepare("UPDATE chat_turns SET role='user', created_at=? WHERE id='t1'").run(iso(now - 120000))
writeParam(db, aid, 'memory.cut.pause.minutes', 5)
check('窗口调到 5 分钟：2 分钟前仍让路', w._humanQuiet(db, aid) === false)

writeParam(db, aid, 'memory.cut.pause.minutes', 0)
check('窗口 0 = 不让路', w._humanQuiet(db, aid) === true)

writeParam(db, aid, 'memory.cut.pause.minutes', 1)
check('回到默认 1 分钟', w._humanQuiet(db, aid) === true)

/* ---------- 直接看模型有没有在用 ---------- */

check('本地空闲 → 可以切', w._humanQuiet(db, aid) === true)
localBegin()
check('本地有一个调用在跑 → 让路', w._humanQuiet(db, aid) === false)
localBegin()
check('本地两个在跑 → 也让路', w._humanQuiet(db, aid) === false)
localEnd(); localEnd()
check('跑完回到空闲 → 可以切', w._humanQuiet(db, aid) === true)
check('计数回到 0（不会越跑越多）', localBusy() === 0, localBusy())

console.log(`\n${pass} pass, ${fail} fail`)
if (fail) process.exitCode = 1
