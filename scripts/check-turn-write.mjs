/**
 * 门禁锁：writeChatTurns——一轮两行、pack/mood/conversation_id/turn_id 都落对。
 * 临时库跑，跑完删；不碰真库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { writeChatTurns } from '../src/modules/turn_write.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, 'check-turn-write.tmp.db')
for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 没有就算了 */ } }

const checks = []
const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name, ok ? '' : JSON.stringify(detail)) }

try {
  const db = openDb(file)
  const aid = 'agt_tw'
  writeChatTurns(db, aid, { user: '问一句', agent: '答一句', conversationId: 'conv1', mood: 'calm', packUser: '["p1"]', turnId: 'turn_test_1' })
  const rows = db.prepare('SELECT role,text,pack,mood,conversation_id,turn_id FROM chat_turns ORDER BY created_at').all()
  const user = rows.find((r) => r.role === 'user')
  const agent = rows.find((r) => r.role === 'agent')
  ck('一轮两行', rows.length === 2 && user && agent, rows)
  ck('user 的 pack/mood/会话都在', user && user.pack === '["p1"]' && user.mood === 'calm' && user.conversation_id === 'conv1', user)
  ck('agent 的包是空的', agent && agent.pack === '[]', agent)
  ck('两行同一个 turn_id', user && agent && user.turn_id === 'turn_test_1' && agent.turn_id === 'turn_test_1', rows)
  // 不传 turnId → 两行都 NULL（老行「无链」口径）
  writeChatTurns(db, aid, { user: '再问', agent: '再答' })
  const nullRows = db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE turn_id IS NULL OR turn_id='' ").get().n
  ck('不传就不编', nullRows === 2, { nullRows })
  db.close()
} finally {
  for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 清理 */ } }
}

const fail = checks.filter((c) => !c.ok)
if (fail.length) { console.error('写链锁失败:', fail.length); process.exit(1) }
console.log('写链锁 ok')
