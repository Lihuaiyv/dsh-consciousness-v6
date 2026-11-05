/**
 * QQ 会话里的 feel：没有「当前发起人」时，按会话自己认人，不能退化成 no_db。
 * 真机日志：tool/result「没记：no_db」→ 一条 QQ 的 feel 都没写进去。
 * 运行：node test/feel-session-aid.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { createActionTools } from '../src/modules/actions/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) } else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelaid-'))
const db = openDb(path.join(dir, 'app.db'))
const AID = 'agt_feel_aid'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(AID, '小汐', 'daily', 'active', new Date().toISOString())

const SESSION = 'qq-0123456789abcdef01234567-abc'

// 1) 旧行为：只有「当前发起人」，QQ 会话里是空的 → no_db
{
  const tools = createActionTools({ getDb: () => db, getAgentId: () => '' })
  const feel = tools.find((t) => t.name === 'feel')
  const r = await feel.execute({ text: '只有发起人时写不进去' }, { agent: { id: SESSION } })
  check('没有会话解析器时：仍会 no_db（记录问题依旧存在时行为不变）', r.ok === false && r.skipped === 'no_db', r)
}

// 2) 新行为：按会话认人 → 写进去，且 session 记在这条会话上
{
  const tools = createActionTools({
    getDb: () => db,
    getAgentId: () => '',
    getAgentIdForSession: (sid) => (sid === SESSION ? AID : ''),
  })
  const feel = tools.find((t) => t.name === 'feel')
  const r = await feel.execute({ text: '在 QQ 上也记得住' }, { agent: { id: SESSION } })
  check('按会话认人后：不再 no_db', r.ok === true, r)
  const row = db.prepare('SELECT agent_id, session_id, text FROM affect_feel ORDER BY at DESC LIMIT 1').get()
  check('落到了这条会话的意识体名下', row && row.agent_id === AID, row)
  check('session_id 记的是 QQ 会话', row && row.session_id === SESSION, row)
}

// 3) 认不出会话就老实退回当前发起人，不拿别人家的库乱写
{
  const tools = createActionTools({
    getDb: () => db,
    getAgentId: () => AID,
    getAgentIdForSession: () => '',
  })
  const feel = tools.find((t) => t.name === 'feel')
  const r = await feel.execute({ text: '认不出会话时退回发起人' }, { agent: { id: 'sess_unknown' } })
  // 12 秒闸可能让它「too_soon」，关键是它走到 recordFeel 了、不再 no_db
  check('认不出会话时退回当前发起人（不再 no_db）', r.skipped !== 'no_db', r)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
