/**
 * 水位闸锁（v2.1 P1.5）：把「只收待联想、情绪不单独触发」钉成可重跑的检查。
 *
 * 为什么要锁：`recallEvents` 曾经收 '台面' 的事件，浮过一次还能立刻再浮一遍；
 * 后来改成只收 '待联想'，但没有测试，谁都可能顺手改回去。
 * 这个脚本用临时库跑一遍，只验这一件事，不碰真库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { recallEvents } from '../src/modules/event_recall.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, 'event-recall-check.tmp.db')
for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 没有就算了 */ } }

const db = openDb(file)
const aid = 'agt_gate'
const at = new Date(Date.now() - 2 * 3600 * 1000).toISOString() // 2 小时前：过了「诞生 30 分钟」那道门
const stamp = new Date().toISOString()

db.prepare('INSERT INTO agents(id,name,mode,status,created_at) VALUES(?,?,?,?,?)').run(aid, '闸门测试', 'daily', 'active', stamp)
const cold = db.prepare(`INSERT INTO cold_events(id,agent_id,title,story,who,start_at,end_at,turn_ids,quotes,cues,status,weight,cut_rev,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
cold.run('c1', aid, '待联想的事', '故事一', '主人', at, at, '[]', '[]', '["抓手甲"]', '过去了', 0.8, 1, stamp)
cold.run('c2', aid, '台面的事', '故事二', '主人', at, at, '[]', '[]', '["台面抓手"]', '过去了', 0.8, 1, stamp)
const hot = db.prepare(`INSERT INTO hot_events(id,agent_id,title,story,cues,source_cold_ids,op,reason,version,active,state,want,ceiling,mentions,created_at,changed_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
hot.run('h1', aid, '待联想的事', '故事一', '["抓手甲","专名抓手"]', '["c1"]', 'born', '', 1, 1, '待联想', 0.9, 1, 0, stamp, stamp)
hot.run('h2', aid, '台面的事', '故事二', '["台面抓手","台面专名"]', '["c2"]', 'born', '', 1, 1, '台面', 0.9, 1, 0, stamp, stamp)

const checks = []
const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name, ok ? '' : JSON.stringify(detail)) }

const r1 = recallEvents(db, aid, '今天说到抓手甲了')
ck('待联想能撞上', r1.items.some((x) => x.id === 'h1'), r1.items)
ck('台面不收（水位闸）', !r1.items.some((x) => x.id === 'h2'), r1.items)
const r2 = recallEvents(db, aid, '台面抓手来了')
ck('台面事件单独撞也不收', r2.items.length === 0, r2.items)
const r3 = recallEvents(db, aid, '今天有点沉，明天要早起')
ck('只有情绪、没抓手 → 0 条', r3.items.length === 0, r3.items)

db.close()
for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 清理 */ } }
const fail = checks.filter((c) => !c.ok)
if (fail.length) { console.error('水位闸锁失败:', fail.length); process.exit(1) }
console.log('水位闸锁 ok — 只收待联想，情绪不单独触发')
