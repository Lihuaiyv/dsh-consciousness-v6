/**
 * P3 接线锁（2026-11-15）
 *
 * 锁三件事：
 *   1. chatReply 的「自己想起」走候选池：事件命中 → 一条事件行 + 浮现记账；
 *   2. 事件撞不上、队列里有 pending → 出一行「忽然想起旧念头」；
 *   3. 浮现只排不消费：surface_queue 状态仍是 pending。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { setFlag } from '../src/kernel.js'
import { selfRecallLineForTurn, webSelfRecallLine } from '../src/features.js'

const P = path.join(os.tmpdir(), 'dsh-check-self-recall-' + Date.now() + '.db')
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

  const cold = (id, title, story) => db.prepare(`INSERT INTO cold_events
    (id,agent_id,title,story,who,start_at,end_at,turn_ids,quotes,cues,status,weight,quality,cut_rev,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, aid, title, story, '主人', old, old, '["t1"]', '["x"]', '["双层麦辣鸡"]', '过去了', 0.5, 'model', 1, old)
  const hot = (id, coldId, title, story, want) => db.prepare(`INSERT INTO hot_events
    (id,agent_id,title,story,cues,source_cold_ids,op,reason,version,active,state,want,ceiling,mentions,quality,created_at,changed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, aid, title, story, '["双层麦辣鸡"]', JSON.stringify([coldId]), 'born', 'x', 1, 1, '待联想', want, 1.0, 0, 'model', old, old)

  cold('cev_1', '那口双层麦辣鸡', '晚上吃了双层麦辣鸡，酱多了点。')
  hot('hev_1', 'cev_1', '那口双层麦辣鸡', '晚上吃了双层麦辣鸡，酱多了点。', 0.8)

  const line = selfRecallLineForTurn(db, aid, '晚上想吃双层麦辣鸡', { channel: 'chat' })
  ok('事件命中：候选池拼成一行', line.includes('忽然想起') && line.includes('双层麦辣鸡'), line)
  ok('一轮最多一条（只出现一次「忽然想起」）', (line.match(/忽然想起/g) || []).length === 1, line)
  const hotAfter = db.prepare("SELECT state FROM hot_events WHERE id='hev_1'").get()
  ok('真拼进去才记浮现：状态转台面', hotAfter && hotAfter.state === '台面', hotAfter)
  const injected = db.prepare("SELECT COUNT(*) n FROM events WHERE type='event.inject'").get()
  ok('落 event.inject 账', injected.n === 1, injected)

  // 网页主路径：和 chatReply 共用同一个渲染/记账口
  cold('cev_2', '第二口双层麦辣鸡', '又吃了一次，还是酱多。')
  hot('hev_2', 'cev_2', '第二口双层麦辣鸡', '又吃了一次，还是酱多。', 0.7)
  const web = webSelfRecallLine(db, aid, { id: 'hev_2', title: '第二口双层麦辣鸡', story: '又吃了一次，还是酱多。', score: 0.6 })
  ok('网页主路径：同一个渲染口', web.includes('第二口双层麦辣鸡') && web.includes('忽然想起'), web)
  const hot2 = db.prepare("SELECT state FROM hot_events WHERE id='hev_2'").get()
  ok('网页主路径也记浮现', hot2 && hot2.state === '台面', hot2)

  // 浮现候选：事件撞不上，但队列里有一条 pending
  db.prepare(`INSERT INTO memory_items(id,agent_id,type,text,source,last_decay_at,created_at)
    VALUES(?,?,?,?,?,?,?)`).run('mem_old', aid, 'fact', '我答应过要修视频皮肤', 'manual', old, old)
  db.prepare(`INSERT INTO surface_queue(id,agent_id,memory_id,reason,state,created_at)
    VALUES(?,?,?,?,?,?)`).run('sq_1', aid, 'mem_old', 'idle', 'pending', old)
  // 默认 surface.direct=off：pulse「只排不消费」，不拿它来争这一行（实测会每轮都赢）
  const pulseOff = selfRecallLineForTurn(db, aid, '今天天气怎么样', { channel: 'wechat' })
  ok('直塞关着：浮现不参与这一行', pulseOff === '', pulseOff)
  setFlag(db, 'surface.direct', 'on')
  const pulse = selfRecallLineForTurn(db, aid, '今天天气怎么样', { channel: 'wechat' })
  ok('直塞开着：出一行旧念头', pulse.includes('修视频皮肤') && pulse.includes('忽然想起'), pulse)
  const sq = db.prepare("SELECT state FROM surface_queue WHERE id='sq_1'").get()
  ok('浮现只排不消费（仍 pending）', sq && sq.state === 'pending', sq)
  setFlag(db, 'surface.direct', 'off')

  db.prepare("DELETE FROM surface_queue WHERE id='sq_1'").run()
  const none = selfRecallLineForTurn(db, aid, '今天天气怎么样', { channel: 'chat' })
  ok('没有事件/队列时返回空', none === '', none)

  // 第三来源：答应过的事（开环）——只有到点的才出，出一次按 loops 的节流记账
  db.prepare(`INSERT INTO open_loops(id,agent_id,kind,text,due_at,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('loop_1', aid, 'task', '把视频皮肤修好', old, 'open', old, old)
  const loop = selfRecallLineForTurn(db, aid, '今天天气怎么样', { channel: 'chat' })
  ok('开环到点：出一行「答应过的事」', loop.includes('答应过的事') && loop.includes('视频皮肤'), loop)
  const loopRow = db.prepare("SELECT state,fire_count FROM open_loops WHERE id='loop_1'").get()
  ok('开环真拼进去才记账（转 half_said、提一次）', loopRow && loopRow.state === 'half_said' && loopRow.fire_count === 1, loopRow)
  const loopAgain = selfRecallLineForTurn(db, aid, '今天天气怎么样', { channel: 'chat' })
  ok('6 小时节流：同一条不会连着提', loopAgain === '', loopAgain)

  db.close()
} catch (e) {
  fails++
  console.log('FAIL P3 接线异常:', (e && e.stack) || e)
} finally {
  try { fs.rmSync(P) } catch { /* 清理失败不影响结论 */ }
}
process.exit(fails ? 1 : 0)
