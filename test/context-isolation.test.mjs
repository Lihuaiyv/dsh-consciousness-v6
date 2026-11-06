/**
 * 串会话隔离：同一个意识体开着多段对话时，「上一句」只认这一段。
 * 运行：node test/context-isolation.test.mjs
 *
 * 守的是三条注入行——「我上一句说的是」「我上一句说出来之前」「上一句落在我身上」——
 * 不许把别段会话的最后一句 / 最后一条 feel / 最后一次评价搬进这一段。
 * 共享的照旧共享：记忆、情绪、关系、日记。
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { presenceLine, lastTurnOf, webConversationId } from '../src/modules/presence.js'
import { latestFeel, recordFeel } from '../src/modules/feel.js'
import { feltSnapshot } from '../src/modules/felt_snapshot.js'
import { consciousnessBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const w = makeWorld()
const { db, aid } = w
const iso = (t) => new Date(t).toISOString()
const T = Date.now()

function clearTurns() {
  try { db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(aid) } catch { /* 老库 */ }
}
function addTurn(id, role, text, at, conv) {
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, aid, role, text, '[]', null, iso(at), conv)
}

// ---- 一、网页会话键：每段有自己的门牌，别的段不能顶
{
  check('空会话不给键', webConversationId('') === null && webConversationId(null) === null)
  check('网页键带 dsh: 前缀', webConversationId('session-ab') === 'dsh:session-ab')
  clearTurns()
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
    .run('cht_key', aid, 'user', '写进去的一句', '[]', null, iso(T - 60000), webConversationId('session-ab'))
  const row = db.prepare('SELECT conversation_id FROM chat_turns WHERE id=?').get('cht_key')
  check('会话键真落库', !!(row && row.conversation_id === 'dsh:session-ab'), row)
}

// ---- 二、presence：只引这一段的那句；不带键时保持旧行为
{
  clearTurns()
  addTurn('cht_a1', 'user', 'A 段的上一句', T - 120000, 'dsh:session-a')
  addTurn('cht_b1', 'agent', 'B 段的上一句', T - 60000, 'dsh:session-b')

  const a = presenceLine(db, aid, { conversationId: 'dsh:session-a', at: T })
  check('A 段只引自己那句', a.line.includes('A 段的上一句') && !a.line.includes('B 段'), a.line)
  const b = presenceLine(db, aid, { conversationId: 'dsh:session-b', at: T })
  check('B 段只引自己那句', b.line.includes('B 段的上一句') && !b.line.includes('A 段'), b.line)

  const noConv = presenceLine(db, aid, { at: T })
  check('不带会话键时仍是整只的最新（旧行为不破）', noConv.line.includes('B 段的上一句'), noConv.line)

  addTurn('cht_c1', 'user', 'C 段才有的', T - 30000, 'dsh:session-c')
  const a2 = presenceLine(db, aid, { conversationId: 'dsh:session-a', at: T })
  check('别的段更新了也不抢 A 段的引用', a2.line.includes('A 段的上一句') && !a2.line.includes('C 段'), a2.line)
  check('时间距离仍在（跨段只给间隔，不给原话）', /上次说话|刚才|几秒|分钟|小时/.test(a2.line), a2.line)

  const empty = presenceLine(db, aid, { conversationId: 'dsh:session-none', at: T })
  check('本段没有上一句就不引用，也不拿别段顶', !empty.line.includes('上一句说的是「'), empty.line)

  check('lastTurnOf 按会话只回本段', lastTurnOf(db, aid, { conversationId: 'dsh:session-a' }).text === 'A 段的上一句')
}

// ---- 三、feel：只取本 session 的那一条
{
  try { db.prepare('DELETE FROM affect_feel WHERE agent_id=?').run(aid) } catch { /* 老库 */ }
  recordFeel(db, aid, { text: 'A 段的手停在桌沿', sessionId: 'session-a', at: T - 60000 })
  recordFeel(db, aid, { text: 'B 段的手指压在纸上', sessionId: 'session-b', at: T - 30000 })

  const fa = latestFeel(db, aid, { sessionId: 'session-a', at: T })
  const fb = latestFeel(db, aid, { sessionId: 'session-b', at: T })
  check('feel 只取本段', !!(fa && fa.text === 'A 段的手停在桌沿'), fa)
  check('feel 不串到另一段', !!(fb && fb.text === 'B 段的手指压在纸上'), fb)
  check('不带 session 时仍取最新（旧行为不破）', (latestFeel(db, aid, { at: T }) || {}).text === 'B 段的手指压在纸上')
  check('本段没有就不拿别段顶', latestFeel(db, aid, { sessionId: 'session-none', at: T }) === null)
}

// ---- 四、快照：只念本段最后一句；对不上就不显示
{
  clearTurns()
  try { db.prepare('DELETE FROM affect_events WHERE agent_id=?').run(aid) } catch { /* 老库 */ }
  try { db.prepare('DELETE FROM affect_samples WHERE agent_id=?').run(aid) } catch { /* 老库 */ }
  const t = T - 60000
  db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,label,gate) VALUES(?,?,?,?,?,?)')
    .run('ev_iso', aid, iso(t), '这句是 B 段说的', 'irritated', 1)
  db.prepare('INSERT INTO affect_samples(id,agent_id,at,label,intensity,fast,slow) VALUES(?,?,?,?,?,?,?)')
    .run('sm_iso', aid, iso(t), 'irritated', 0.6,
      JSON.stringify({ arousal: 0.4, dominance: -0.2 }),
      JSON.stringify({ slow: -0.3, fast: -0.2, total: -0.25 }))
  addTurn('cht_b2', 'user', '这句是 B 段说的', t, 'dsh:session-b')

  const b = feltSnapshot(db, aid, { at: T, conversationId: 'dsh:session-b' })
  check('本段最后一句对得上才念', !!(b && b.line.includes('这句是 B 段说的')), b && b.line)
  const a = feltSnapshot(db, aid, { at: T, conversationId: 'dsh:session-a' })
  check('对不上就不拿别段的话冒充', a === null, a)
  const noConv = feltSnapshot(db, aid, { at: T })
  check('不带会话键时仍是旧行为（只给数/原话）', !!(noConv && noConv.line), noConv)
}

// ---- 五、整块提示词：两段各拼各的
{
  clearTurns()
  addTurn('cht_i_a', 'user', 'A 段最后一句', T - 60000, 'dsh:session-a')
  addTurn('cht_i_b', 'user', 'B 段最后一句', T - 30000, 'dsh:session-b')
  const a = consciousnessBlock(db, aid, { sessionId: 'session-a', conversationId: 'dsh:session-a' })
  const b = consciousnessBlock(db, aid, { sessionId: 'session-b', conversationId: 'dsh:session-b' })
  check('A 段提示词只带 A 的最后一句', a.includes('A 段最后一句') && !a.includes('B 段最后一句'), a.slice(-400))
  check('B 段提示词只带 B 的最后一句', b.includes('B 段最后一句') && !b.includes('A 段最后一句'), b.slice(-400))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
