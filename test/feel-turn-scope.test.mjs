/**
 * feel 只认「这一轮写的」：比本轮起点更早的那条不许挂出来（2026-11-15 23:42 主人定）。
 * 运行：node test/feel-turn-scope.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { latestFeel } from '../src/modules/feel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const w = makeWorld()
try {
  const now = Date.now()
  const ins = (id, at, text, sessionId) => w.db.prepare(
    'INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source,turn_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, w.aid, new Date(at).toISOString(), text, 'calm', 0, 0, 0, sessionId, 'tool', null)

  ins('afe_old', now - 90 * 60000, '一小时半以前写的那句。', 'sess_a')
  ins('afe_new', now - 60000, '刚刚写的这句。', 'sess_a')

  const any = latestFeel(w.db, w.aid, { sessionId: 'sess_a' })
  check('不带门槛：还是取最新那条（旧行为不变）', any && any.text === '刚刚写的这句。', any)

  const inTurn = latestFeel(w.db, w.aid, { sessionId: 'sess_a', since: now - 5 * 60000 })
  check('本轮起点之后写的 → 收', inTurn && inTurn.text === '刚刚写的这句。', inTurn)

  const staleOnly = latestFeel(w.db, w.aid, { sessionId: 'sess_a', since: now })
  check('只有更早的那条 → 这一轮就算没有', staleOnly === null, staleOnly)

  const afterOld = latestFeel(w.db, w.aid, { sessionId: 'sess_a', since: now - 100 * 60000 })
  check('门槛比两条都早 → 仍然只给最新那条', afterOld && afterOld.text === '刚刚写的这句。', afterOld)

  const otherSession = latestFeel(w.db, w.aid, { sessionId: 'sess_b', since: now - 5 * 60000 })
  check('别的会话写的，不算这一轮', otherSession === null, otherSession)

  const noSession = latestFeel(w.db, w.aid, { since: now - 5 * 60000 })
  check('不给 session 时按全库最新（QQ 那条路的老行为）', noSession && noSession.text === '刚刚写的这句。', noSession)

  // 统一口径：thisTurn 时自己从「上一轮落轮」算，不用调用方给 since
  w.db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id,turn_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('cht_end', w.aid, 'agent', '上一轮我说的那句。', '[]', null, new Date(now - 30 * 60000).toISOString(), 'sess_a', 'tid_end')
  const autoNew = latestFeel(w.db, w.aid, { sessionId: 'sess_a', thisTurn: true })
  check('thisTurn：落轮之后写的 → 给', autoNew && autoNew.text === '刚刚写的这句。', autoNew)
  // 把新的那条抹掉，只剩「落轮之前」的旧句 → 这一轮就当没写
  w.db.prepare('DELETE FROM affect_feel WHERE id=?').run('afe_new')
  const autoOld = latestFeel(w.db, w.aid, { sessionId: 'sess_a', thisTurn: true })
  check('thisTurn：只有落轮之前写的 → 不给', autoOld === null, autoOld)
} finally { w.close() }

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
