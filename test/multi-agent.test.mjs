/**
 * 多实例 / 会话绑定测试（schema 12）。
 *
 * 这一组只碰「谁归谁」这一层：不调模型、不起宿主、不写真实库。
 * 运行：node test/multi-agent.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { activateAgent } from '../src/features.js'
import {
  bindSession, unbindSession, unbindAgent, bindingOf, bindingsOf, resolveAgentId,
  setPending, peekPending, clearPending, touchSession, sweepBindings, runtimeStateOf, refreshAll,
  maxRunning, setMaxRunning, setDefaultAgent, runningAgentIds, bindableAgent, migrateLegacyBindings,
} from '../src/modules/binding.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-multi-'))
const dbFile = path.join(dir, 'app.db')
const db = openDb(dbFile)
attachDb(db)

function mkAgent(id, status = 'active') {
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, id, 'daily', status, now())
  return id
}

const A = mkAgent('agt_a')
const B = mkAgent('agt_b')
const C = mkAgent('agt_c')
const D = mkAgent('agt_d')

check('schema 到 13', Number(db.prepare('SELECT version FROM schema_meta').get().version) === 13)

// ---- 表结构 ----
{
  const cols = db.prepare('PRAGMA table_info(bindings)').all().map((c) => String(c.name))
  check('bindings 有 state/source/last_seen_at', ['state', 'source', 'last_seen_at'].every((c) => cols.includes(c)), cols)
  const aCols = db.prepare('PRAGMA table_info(agents)').all().map((c) => String(c.name))
  check('agents 有 runtime_state', aCols.includes('runtime_state'), aCols)
  const hb = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='heartbeats'").get()
  check('heartbeats 表建好', !!hb)
  const rt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runtime'").get()
  check('agent_runtime 表建好', !!rt)
}

// ---- 多实例：激活不再互斥 ----
{
  const r1 = activateAgent(db, A, 'user')
  const r2 = activateAgent(db, B, 'user')
  const active = db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY id").all().map((x) => x.id)
  check('两个实例能同时 active', active.includes(A) && active.includes(B), active)
  check('激活不再踢人', r1.status === 'active' && r2.status === 'active', { r1, r2 })
  check('激活 = 排给下一段新对话', peekPending(db) === B, peekPending(db))
}

// ---- 待绑定只消费一次 ----
{
  const s1 = 'sess-pending-1'
  const s2 = 'sess-pending-2'
  const got1 = resolveAgentId(db, s1)
  check('第一个新会话绑到待绑定实例', got1 === B, got1)
  check('绑完就清掉待绑定', peekPending(db) === null, peekPending(db))
  const got2 = resolveAgentId(db, s2)
  check('第二个新会话不绑任何人（默认空）', got2 === null, got2)
  check('没绑定就没写行', bindingOf(db, s2) === null)
}

// ---- 绑定 / 改绑 / 解绑 ----
{
  const s = 'sess-a-1'
  const r = bindSession(db, A, s, { source: 'manual' })
  check('手动绑定成功', r.ok && r.agent_id === A, r)
  check('解析拿到 A', resolveAgentId(db, s) === A)
  check('别人解析不到这段（不串）', resolveAgentId(db, 'sess-other') === null)

  const r2 = bindSession(db, C, s, { source: 'manual' })
  check('改绑成功', r2.ok && r2.agent_id === C, r2)
  const row = bindingOf(db, s)
  check('一段会话只留一个 bound', row && row.agent_id === C, row)
  const switched = db.prepare("SELECT * FROM events WHERE agent_id=? AND type='binding.released' ORDER BY rowid DESC LIMIT 1").get(A)
  let evPayload = {}
  try { evPayload = JSON.parse((switched && switched.payload) || '{}') } catch { evPayload = {} }
  check('换人留痕（事件里 by=switch）', !!switched && evPayload.by === 'switch' && evPayload.to === C, evPayload)

  const n = unbindSession(db, s, 'user')
  check('解绑生效', n === 1 && resolveAgentId(db, s) === null)
  check('解绑后行还在（可查）', !!db.prepare('SELECT * FROM bindings WHERE session_id=?').get(s))
}

// ---- 用户暂停优先，但绑定保留 ----
{
  const s = 'sess-pause'
  bindSession(db, A, s, { source: 'manual' })
  db.prepare("UPDATE agents SET status='paused' WHERE id=?").run(A)
  refreshAll(db)
  check('暂停后解析返回 null', resolveAgentId(db, s) === null)
  check('暂停不删绑定', !!bindingOf(db, s))
  check('暂停时在场状态 = offline', runtimeStateOf(db, A) === 'offline', runtimeStateOf(db, A))
  check('暂停后 agents.runtime_state=offline',
    db.prepare('SELECT runtime_state FROM agents WHERE id=?').get(A).runtime_state === 'offline')
  const woke = activateAgent(db, A, 'user')
  check('唤醒后接着用原来那段', resolveAgentId(db, s) === A)
  check('唤醒后在场状态离开 offline（大卡展开）',
    woke.runtime_state === 'bound' && runtimeStateOf(db, A) === 'bound', woke)
  check('唤醒后 agents.runtime_state 跟着更新',
    db.prepare('SELECT runtime_state FROM agents WHERE id=?').get(A).runtime_state === 'bound')
  clearPending(db) // 别把「下一段新对话」留给后面的回收用例
}

// ---- 并发上限 ----
{
  unbindAgent(db, A, 'test')
  unbindAgent(db, B, 'test')
  unbindAgent(db, C, 'test')
  unbindAgent(db, D, 'test')
  setMaxRunning(db, 2)
  check('上限读得回来', maxRunning(db) === 2)
  const r1 = bindSession(db, A, 'lim-1', { source: 'manual' })
  const r2 = bindSession(db, B, 'lim-2', { source: 'manual' })
  const r3 = bindSession(db, C, 'lim-3', { source: 'manual' })
  check('前两个能绑', r1.ok && r2.ok, { r1, r2 })
  check('第三个排队（RUNNING_LIMIT）', !r3.ok && r3.queued === true, r3)
  check('排队时不写绑定行', bindingOf(db, 'lim-3') === null)
  const r4 = bindSession(db, A, 'lim-4', { source: 'manual' })
  check('已挂着的实例再加一段不算新占', r4.ok === true, r4)
  check('运行中实例数 = 2', runningAgentIds(db).length === 2, runningAgentIds(db))
  setMaxRunning(db, 0)
  const r5 = bindSession(db, C, 'lim-5', { source: 'manual' })
  check('上限 0 = 不限', r5.ok === true, r5)
  setMaxRunning(db, 3)
}

// ---- 空闲回收 ----
{
  // 先清场：上限那节留了三段会话，不清掉这里会撞上限
  unbindAgent(db, A, 'test')
  unbindAgent(db, B, 'test')
  unbindAgent(db, C, 'test')
  clearPending(db)
  setMaxRunning(db, 0)
  const s = 'sess-old'
  const ok = bindSession(db, D, s, { source: 'manual' })
  check('回收用例先绑上', ok.ok === true, ok)
  const old = new Date(Date.now() - 40 * 86400000).toISOString()
  db.prepare('UPDATE bindings SET last_seen_at=? WHERE session_id=?').run(old, s)
  const n = sweepBindings(db, { idleDays: 30 })
  const row = db.prepare('SELECT * FROM bindings WHERE session_id=?').get(s)
  check('40 天没动的被回收', n === 1 && row && row.state === 'released' && resolveAgentId(db, s) === null, {
    n, row, pending: peekPending(db),
  })
  check('回收留痕 released_by=ttl', row && row.released_by === 'ttl', row)
  check('回收不动用户意图', db.prepare('SELECT status FROM agents WHERE id=?').get(D).status === 'active')
}

// ---- 在场状态 ----
{
  db.prepare("UPDATE agents SET status='active' WHERE id=?").run(D)
  unbindAgent(db, D, 'test')
  refreshAll(db)
  check('没挂会话 = idle', runtimeStateOf(db, D) === 'idle', runtimeStateOf(db, D))
  const ok = bindSession(db, D, 'state-1', { source: 'manual' })
  check('状态用例绑得上', ok.ok === true, ok)
  check('挂了会话 = bound', runtimeStateOf(db, D) === 'bound', runtimeStateOf(db, D))
  const cached = db.prepare('SELECT runtime_state FROM agents WHERE id=?').get(D).runtime_state
  check('agents.runtime_state 跟着更新', cached === 'bound', cached)
  unbindAgent(db, D, 'test')
}

// ---- last_seen 会被 touch 推进 ----
{
  const s = 'sess-touch'
  bindSession(db, A, s, { source: 'manual' })
  const before = bindingOf(db, s).last_seen_at
  const later = new Date(Date.now() + 5000).toISOString()
  touchSession(db, s, later)
  const after = bindingOf(db, s).last_seen_at
  check('touch 推进 last_seen_at', after === later && after !== before, { before, after })
}

// ---- 默认实例（默认关闭）----
{
  setDefaultAgent(db, null)
  check('默认实例默认是空的', resolveAgentId(db, 'brand-new-session') === null)
  setDefaultAgent(db, A)
  const got = resolveAgentId(db, 'brand-new-session')
  check('开了默认实例才兜底', got === A, got)
  setDefaultAgent(db, null)
  unbindSession(db, 'brand-new-session', 'test')
}

// ---- 软删实例不参与解析 ----
{
  const E = mkAgent('agt_e')
  const s = 'sess-deleted'
  bindSession(db, E, s, { source: 'manual' })
  db.prepare("UPDATE agents SET status='soft_deleted' WHERE id=?").run(E)
  check('软删后解析不到', resolveAgentId(db, s) === null)
  check('软删实例不可再绑', bindableAgent(db, E) === null)
}

// ---- 幂等：重开同一个库不炸、版本不变 ----
{
  const again = openDb(dbFile)
  const v = Number(again.prepare('SELECT version FROM schema_meta').get().version)
  check('重开库仍是 schema 13', v === 13, v)
  check('重开库绑定还在', !!again.prepare("SELECT * FROM bindings WHERE state='bound'").get())
  again.close()
}

// ---- 老库迁移：老 bindings 行不许凭空"正在挂" ----
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-legacy-'))
  const f2 = path.join(dir2, 'app.db')
  const d2 = openDb(f2)
  attachDb(d2)
  d2.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run('agt_old', '老人', 'daily', 'active', now())
  // 老功能只写三列（模拟 schema 11 时代留下的行）
  d2.prepare('DELETE FROM bindings').run()
  d2.prepare("INSERT INTO bindings(session_id,agent_id,created_at) VALUES(?,?,?)")
    .run('sess-legacy', 'agt_old', '2026-10-27T05:00:00.000Z')
  // 再开一次库 = 走一遍补列 / 收口逻辑
  d2.close()
  const d3 = openDb(f2)
  const row = d3.prepare('SELECT * FROM bindings WHERE session_id=?').get('sess-legacy')
  check('老绑定行被标成 released', row.state === 'released' && row.released_by === 'legacy', row)
  check('老行不再算正在挂', runningAgentIds(d3).length === 0, runningAgentIds(d3))

  // 迁移：raw_turns 里出现过的会话认领回来，且只跑一次
  d3.prepare(`INSERT INTO raw_turns(id,agent_id,session_id,seq,role,text,created_at,day)
    VALUES(?,?,?,?,?,?,?,?)`).run('rt1', 'agt_old', 'sess-history', 1, 'user', '你好', now(), now().slice(0, 10))
  const m1 = migrateLegacyBindings(d3, { limit: 3 })
  check('迁回有历史的会话', m1.migrated === 1 && resolveAgentId(d3, 'sess-history') === 'agt_old', m1)
  const m2 = migrateLegacyBindings(d3, { limit: 3 })
  check('迁移只跑一次', m2.migrated === 0 && m2.skipped === 'done', m2)
  d3.close()
  fs.rmSync(dir2, { recursive: true, force: true })
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
