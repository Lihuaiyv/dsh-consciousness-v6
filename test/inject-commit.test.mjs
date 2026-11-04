/**
 * 取 / 说分离：主动消息、开环、潜台词、自发浮现只有真的进了注入文本才落账。
 * 运行：node test/inject-commit.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { addMemory } from '../src/modules/memory.js'
import { consciousnessBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-inject-commit-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

let seq = 0
function newAgent(budget) {
  seq += 1
  const aid = 'agt_commit_' + seq
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '取说' + seq, 'daily', 'active', now())
  if (budget != null) setParam(db, aid, 'memory.inject.budget', { value: budget })
  return aid
}
function insertProactive(aid, text = '想跟你说，今天那件事我记着。') {
  const id = 'pc_' + aid
  db.prepare('INSERT INTO proactive(id,agent_id,text,reason,state,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, aid, text, 'test', 'pending', now())
  return id
}
function insertLoop(aid, text = '答应周末重画记忆面板的图') {
  const id = 'lp_' + aid
  const past = new Date(Date.now() - 3600000).toISOString()
  db.prepare(`INSERT INTO open_loops(id,agent_id,kind,text,due_at,stale_after,state,fire_count,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, aid, 'promise', text, past, past, 'open', 0, now(), now())
  return id
}
function insertConflict(aid) {
  const id = 'cf_' + aid
  const evidence = JSON.stringify({ attribute: { sentence_a: '你昨天说喜欢咖啡', sentence_b: '你今天说讨厌咖啡' } })
  db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,evidence) VALUES(?,?,?,?,?,?,?)`)
    .run(id, aid, 'ma_' + aid, 'mb_' + aid, 'open', now(), evidence)
  return id
}
function insertSurface(aid) {
  const m = addMemory(db, aid, { text: '你上次说想把窗台那盆花换个位置。', type: 'fact' })
  const id = 'sq_' + aid
  db.prepare('INSERT INTO surface_queue(id,agent_id,memory_id,reason,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, aid, m.id, 'pulse', 'pending', now(), new Date(Date.now() + 3600000).toISOString())
  return id
}
function count(sql, ...args) {
  try { return Number(db.prepare(sql).get(...args).n || 0) } catch { return -1 }
}

// ---- 1) proactive：宽预算落账 ----
{
  const aid = newAgent(800)
  const id = insertProactive(aid)
  const text = consciousnessBlock(db, aid, {})
  check('宽预算：主动消息在文本里', text.includes('你之前想主动说一句'), text.slice(0, 200))
  check('宽预算：主动消息已 delivered',
    db.prepare('SELECT state FROM proactive WHERE id=?').get(id).state === 'delivered')
}

// ---- 2) proactive：紧预算不落账 ----
{
  const aid = newAgent(40)
  const id = insertProactive(aid)
  const text = consciousnessBlock(db, aid, {})
  check('紧预算：主动消息不在文本里', !text.includes('你之前想主动说一句'), text)
  check('紧预算：主动消息仍 pending',
    db.prepare('SELECT state FROM proactive WHERE id=?').get(id).state === 'pending')
}

// ---- 3) loop：宽预算落账、同轮只记一次 ----
{
  const aid = newAgent(800)
  const id = insertLoop(aid)
  const t1 = consciousnessBlock(db, aid, {})
  const t2 = consciousnessBlock(db, aid, {})
  const row = db.prepare('SELECT state,fire_count FROM open_loops WHERE id=?').get(id)
  check('宽预算：开环在文本里', t1.includes('还挂着') || t1.includes('最在意'), t1.slice(0, 200))
  check('宽预算：开环 fire_count=1', Number(row.fire_count) === 1, row)
  check('宽预算：开环 half_said', row.state === 'half_said', row)
  check('同轮第二次拼装：不重复记', t2.includes('还挂着') || t2.includes('最在意'), t2.slice(0, 120))
  check('同轮第二次拼装：fire_count 不变', Number(db.prepare('SELECT fire_count FROM open_loops WHERE id=?').get(id).fire_count) === 1)
}

// ---- 4) loop：紧预算不落账 ----
{
  const aid = newAgent(40)
  const id = insertLoop(aid)
  const text = consciousnessBlock(db, aid, {})
  const row = db.prepare('SELECT state,fire_count FROM open_loops WHERE id=?').get(id)
  check('紧预算：开环不在文本里', !text.includes('还挂着') && !text.includes('最在意'), text)
  check('紧预算：fire_count 仍 0', Number(row.fire_count) === 0, row)
  check('紧预算：state 仍 open', row.state === 'open', row)
}

// ---- 5) subtext：宽预算写一次，同轮不重复 ----
{
  const aid = newAgent(800)
  insertConflict(aid)
  const t1 = consciousnessBlock(db, aid, {})
  const t2 = consciousnessBlock(db, aid, {})
  const n = count("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='subtext.shown'", aid)
  check('宽预算：潜台词在文本里', t1.includes('心里其实'), t1.slice(0, 200))
  check('宽预算：潜台词事件恰 1 条', n === 1, n)
  check('同轮第二次：文本复用', t2.includes('心里其实'), t2.slice(0, 120))
  check('同轮第二次：事件仍 1 条', count("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='subtext.shown'", aid) === 1)
}

// ---- 6) subtext：紧预算不写 ----
{
  const aid = newAgent(40)
  insertConflict(aid)
  const text = consciousnessBlock(db, aid, {})
  check('紧预算：潜台词不在文本里', !text.includes('心里其实'), text)
  check('紧预算：潜台词事件 0 条', count("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='subtext.shown'", aid) === 0)
}

// ---- 7) spontaneous：宽预算消费 / 紧预算保留 ----
{
  const aid = newAgent(800)
  const qid = insertSurface(aid)
  const text = consciousnessBlock(db, aid, {})
  check('宽预算：自发浮现文本里', text.includes('心里忽然浮上来'), text.slice(0, 220))
  check('宽预算：surface_queue delivered',
    db.prepare('SELECT state FROM surface_queue WHERE id=?').get(qid).state === 'delivered')
  check('宽预算：浮现记账 1 条', count("SELECT COUNT(*) n FROM surfaced_items WHERE agent_id=? AND kind='spontaneous'", aid) === 1)
}
{
  const aid = newAgent(40)
  const qid = insertSurface(aid)
  const text = consciousnessBlock(db, aid, {})
  check('紧预算：自发浮现不在文本里', !text.includes('心里忽然浮上来'), text)
  check('紧预算：surface_queue 仍 pending',
    db.prepare('SELECT state FROM surface_queue WHERE id=?').get(qid).state === 'pending')
  check('紧预算：浮现记账 0 条', count("SELECT COUNT(*) n FROM surfaced_items WHERE agent_id=? AND kind='spontaneous'", aid) === 0)
}

// ---- 8) 开关 off：回到「取到即落账」 ----
{
  const aid = newAgent(40)
  setParam(db, aid, 'memory.inject.commit_after_pack', { value: 'off' })
  const id = insertProactive(aid)
  const text = consciousnessBlock(db, aid, {})
  check('off：主动消息仍被 delivered（旧行为）',
    db.prepare('SELECT state FROM proactive WHERE id=?').get(id).state === 'delivered', text)
}

// ---- 9) clampInjection 旧调用兼容 ----
{
  const out = (await import('../src/features.js')).clampInjection(['## 意识体：X', '正文'], 800)
  check('旧调用文本不变', out.text === '## 意识体：X\n正文', out)
  check('旧调用仍返回 dropped', Array.isArray(out.dropped), out)
  check('旧调用新增 kept/removed', out.kept instanceof Set && out.removed instanceof Set, out)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
