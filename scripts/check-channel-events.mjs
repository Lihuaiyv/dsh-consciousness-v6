/**
 * D1 通道联想锁（2026-11-13）
 *
 * 锁三件事：
 *   1. 非网页通道（/chat、微信、QQ 走的 features.chatReply）也能撞出事件；
 *   2. 一轮最多一条；撞上才浮现，撞不上返回空；
 *   3. 真拼进提示词才记账：markSurfaced（转台面）+ events.event.inject。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { eventLineForTurn } from '../src/features.js'

const P = path.join(os.tmpdir(), 'dsh-check-channel-events-' + Date.now() + '.db')
let fails = 0
const ok = (name, cond, extra) => {
  if (cond) { console.log('PASS', name) } else { fails++; console.log('FAIL', name, extra ? JSON.stringify(extra) : '') }
}

try {
  const db = openDb(P)
  const aid = 'a1'
  const old = new Date(Date.now() - 2 * 24 * 3600e3).toISOString()
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '小测', 'daily', 'active', old)

  const cold = (id, title, story, end) => db.prepare(`INSERT INTO cold_events
    (id,agent_id,title,story,who,start_at,end_at,turn_ids,quotes,cues,status,weight,quality,cut_rev,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, aid, title, story, '主人', end, end, '["t1"]', '["x"]', '["双层麦辣鸡"]', '过去了', 0.5, 'model', 1, old)
  const hot = (id, coldId, title, story, want) => db.prepare(`INSERT INTO hot_events
    (id,agent_id,title,story,cues,source_cold_ids,op,reason,version,active,state,want,ceiling,mentions,quality,created_at,changed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, aid, title, story, '["双层麦辣鸡"]', JSON.stringify([coldId]), 'born', 'x', 1, 1, '待联想', want, 1.0, 0, 'model', old, old)

  cold('cev_1', '那口双层麦辣鸡', '晚上吃了双层麦辣鸡，酱多了点。', old)
  cold('cev_2', '第二口双层麦辣鸡', '又吃了一次，还是酱多。', old)
  hot('hev_1', 'cev_1', '那口双层麦辣鸡', '晚上吃了双层麦辣鸡，酱多了点。', 0.8)
  hot('hev_2', 'cev_2', '第二口双层麦辣鸡', '又吃了一次，还是酱多。', 0.7)

  const line = eventLineForTurn(db, aid, '晚上想吃双层麦辣鸡', { channel: 'chat' })
  ok('撞上事件并拼成一行', line.includes('忽然想起') && line.includes('双层麦辣鸡'), line)
  ok('一轮最多一条（只出现一次「忽然想起」）', (line.match(/忽然想起/g) || []).length === 1, line)
  const hotAfter = db.prepare("SELECT state FROM hot_events WHERE id='hev_1'").get()
  ok('真拼进去才记浮现：状态转台面', hotAfter && hotAfter.state === '台面', hotAfter)
  const injected = db.prepare("SELECT COUNT(*) n FROM events WHERE type='event.inject'").get()
  ok('落 event.inject 账', injected.n === 1, injected)

  const none = eventLineForTurn(db, aid, '今天天气怎么样', { channel: 'wechat' })
  ok('撞不上就返回空', none === '', none)

  db.close()
} catch (e) {
  fails++
  console.log('FAIL 通道联想异常:', (e && e.stack) || e)
} finally {
  try { fs.rmSync(P) } catch { /* 清理失败不影响结论 */ }
}
process.exit(fails ? 1 : 0)
