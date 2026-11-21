/**
 * 门禁锁：候选池（P3 地基）——四路收成一种形状、排序去重、一轮只留一条。
 * 临时库跑，跑完删；不碰真库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { setFlag } from '../src/kernel.js'
import { collectCandidates, rankCandidates, pickOne } from '../src/modules/candidate_pool.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, 'check-pool.tmp.db')
for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 没有就算了 */ } }

const checks = []
const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name, ok ? '' : JSON.stringify(detail).slice(0, 300)) }

try {
  const db = openDb(file)
  const aid = 'agt_pool'
  const at = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  const stamp = new Date().toISOString()
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at) VALUES(?,?,?,?,?)').run(aid, '测试', 'daily', 'active', stamp)
  db.prepare(`INSERT INTO cold_events(id,agent_id,title,story,who,start_at,end_at,turn_ids,quotes,cues,status,weight,cut_rev,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('c1', aid, '一件旧事', '经过', '主人', at, at, '[]', '[]', '["抓手甲"]', '过去了', 0.8, 1, stamp)
  db.prepare(`INSERT INTO hot_events(id,agent_id,title,story,cues,source_cold_ids,op,reason,version,active,state,want,ceiling,mentions,created_at,changed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('h1', aid, '一件旧事', '经过', '["抓手甲","专名乙"]', '["c1"]', 'born', '', 1, 1, '待联想', 0.9, 1, 0, stamp, stamp)
  db.prepare(`INSERT INTO surface_queue(id,agent_id,memory_id,reason,state,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?)`).run('sq1', aid, 'm_pulse', 'pulse', 'pending', stamp, null)
  db.prepare(`INSERT INTO open_loops(id,agent_id,kind,text,due_at,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('ol1', aid, 'task', '还挂着的一件事', stamp, 'open', stamp, stamp)

  const pool = collectCandidates(db, aid, { query: '今天抓手甲出现了', memories: [{ id: 'm1', text: '一条记忆', score: 0.9, type: 'fact' }] })
  // pulse 只有直塞开着才进池（关着时「只排不消费」，不该来争这一行）
  setFlag(db, 'surface.direct', 'on')
  const poolWithPulse = collectCandidates(db, aid, { query: '今天抓手甲出现了', memories: [{ id: 'm1', text: '一条记忆', score: 0.9, type: 'fact' }] })
  setFlag(db, 'surface.direct', 'off')
  const srcsNoPulse = new Set(pool.map((c) => c.source))
  ck('直塞关着：pulse 不进池（不拿旧念头争这一行）', !srcsNoPulse.has('pulse'), [...srcsNoPulse])
  const sources = new Set(poolWithPulse.map((c) => c.source))
  ck('四路都进池：event/memory/pulse/loop', ['event', 'memory', 'pulse', 'loop'].every((s) => sources.has(s)), [...sources])
  ck('形状统一：source/id/text/score', pool.every((c) => c.source && c.id && c.score != null), pool.slice(0, 2))

  const ranked = rankCandidates([...pool, ...pool], { limit: 10 })
  ck('排序去重：同一件事不留两条', ranked.length <= pool.length && new Set(ranked.map((c) => c.source + ':' + c.id)).size === ranked.length, ranked.map((c) => c.source + ':' + c.id))

  const one = pickOne(pool)
  ck('一轮只留一条', !!one && typeof one.source === 'string', one)
  ck('分数高的先（事件 1.x > 记忆 0.9）', one && one.source === 'event', one)

  const noQuery = collectCandidates(db, aid, { memories: [{ id: 'm1', text: '一条记忆', score: 0.9 }] })
  ck('没这句话就不撞事件', !noQuery.some((c) => c.source === 'event'), noQuery.map((c) => c.source))
  db.close()
} finally {
  for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 清理 */ } }
}

const fail = checks.filter((c) => !c.ok)
if (fail.length) { console.error('候选池锁失败:', fail.length); process.exit(1) }
console.log('候选池锁 ok')
