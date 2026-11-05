/**
 * QQ 会话「换新」自动续绑的模拟测试。
 *
 * 背景：桥接每次重启 / 断线会换一个新的 sessionId（`qq-<24hex>-<时间戳>`），
 * 绑定表里还挂着旧的那个——新会话就变成记忆链上的陌生人（不召回、人格段也少一截）。
 * autoBindQQSession 负责把新 id 接回「这条聊天原本归谁」。
 *
 * 不碰真宿主、不碰线上库：内存 sqlite + 临时映射表文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { autoBindQQSession } from '../index.js'
import { bindingOf } from '../src/modules/binding.js'
import { qqSessionPrefix } from '../src/modules/qq_bridge.js'

const OWNER_KEY = 'u:3192248859'
const AID = 'agt_3977d80f17'
const OTHER = 'agt_0dbf42aff4'
const PREFIX = qqSessionPrefix(OWNER_KEY)
const NEW_SID = `${PREFIX}-new0001`
const OLD_SID = `${PREFIX}-old0001`

function memDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT, runtime_state TEXT, last_interaction_at TEXT, created_at TEXT);
    CREATE TABLE bindings (session_id TEXT PRIMARY KEY, agent_id TEXT, created_at TEXT, active_at TEXT, state TEXT, source TEXT, bound_at TEXT, last_seen_at TEXT, released_at TEXT, released_by TEXT);
    CREATE TABLE agent_runtime (agent_id TEXT PRIMARY KEY, state TEXT, since TEXT, reason TEXT, updated_at TEXT);
    CREATE TABLE flags (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, agent_id TEXT, type TEXT, payload TEXT, created_at TEXT);
    CREATE TABLE conversations (conversation_id TEXT PRIMARY KEY, agent_id TEXT, channel TEXT, handle TEXT, person_id TEXT, state TEXT, created_at TEXT, last_seen_at TEXT, released_at TEXT, released_by TEXT);
  `)
  const ts = new Date().toISOString()
  db.prepare('INSERT INTO agents(id,name,status,runtime_state,created_at) VALUES(?,?,?,?,?)').run(AID, '小汐', 'active', 'idle', ts)
  db.prepare('INSERT INTO agents(id,name,status,runtime_state,created_at) VALUES(?,?,?,?,?)').run(OTHER, '别人', 'active', 'idle', ts)
  return db
}

function addConv(db, convId, aid) {
  db.prepare("INSERT INTO conversations(conversation_id,agent_id,channel,state,created_at) VALUES(?,?,?,?,?)")
    .run(convId, aid, 'qq', 'active', new Date().toISOString())
}

function addBinding(db, sid, aid, at = new Date().toISOString()) {
  db.prepare(`INSERT INTO bindings(session_id,agent_id,created_at,state,source,bound_at,last_seen_at)
    VALUES(?,?,?,?,?,?,?)`).run(sid, aid, at, 'bound', 'manual', at, at)
}

function tmpMap(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqrebind-'))
  const f = path.join(dir, 'qq-sessions.json')
  fs.writeFileSync(f, JSON.stringify(obj))
  return f
}

test('R1 映射表 + conversations 有归属：新会话自动绑回那个人', () => {
  const db = memDb()
  addConv(db, 'qq:p:3192248859', AID)
  const file = tmpMap({ [OWNER_KEY]: NEW_SID })
  const got = autoBindQQSession(db, NEW_SID, { sessionsFile: file })
  assert.equal(got, AID)
  const row = bindingOf(db, NEW_SID)
  assert.ok(row, '绑定行应该在')
  assert.equal(row.agent_id, AID)
  assert.equal(row.source, 'qq-rebind')
})

test('R2 映射表还没写完：按同前缀旧会话兜底接上', () => {
  const db = memDb()
  addConv(db, 'qq:p:3192248859', AID)
  addBinding(db, OLD_SID, AID)
  // 映射表是空的（桥接刚换会话、文件还没落盘）
  const file = tmpMap({})
  const got = autoBindQQSession(db, NEW_SID, { sessionsFile: file })
  assert.equal(got, AID)
  assert.equal(bindingOf(db, NEW_SID).agent_id, AID)
})

test('R3 已经绑过的会话不动（不覆盖用户手动绑的结果）', () => {
  const db = memDb()
  addConv(db, 'qq:p:3192248859', OTHER) // 归属表里是别人
  addBinding(db, NEW_SID, AID)          // 但这段会话已经手动绑给小汐
  const file = tmpMap({ [OWNER_KEY]: NEW_SID })
  const got = autoBindQQSession(db, NEW_SID, { sessionsFile: file })
  assert.equal(got, null, '已绑定就返回 null，不动')
  assert.equal(bindingOf(db, NEW_SID).agent_id, AID, '原绑定必须保留')
})

test('R4 认不出的不瞎绑：没归属、没旧绑定就返回 null', () => {
  const db = memDb()
  const file = tmpMap({ [OWNER_KEY]: NEW_SID })
  const got = autoBindQQSession(db, NEW_SID, { sessionsFile: file })
  assert.equal(got, null)
  assert.equal(bindingOf(db, NEW_SID), null, '不能凭空建一条绑定')
})

test('R5 非 QQ 会话一律不碰', () => {
  const db = memDb()
  const file = tmpMap({})
  assert.equal(autoBindQQSession(db, 'session-abc-123', { sessionsFile: file }), null)
  assert.equal(autoBindQQSession(db, '', { sessionsFile: file }), null)
})

test('R6 续绑成功会留一条 binding.bound 事件，payload 带 qq-rebind', () => {
  const db = memDb()
  addConv(db, 'qq:p:3192248859', AID)
  const file = tmpMap({ [OWNER_KEY]: NEW_SID })
  autoBindQQSession(db, NEW_SID, { sessionsFile: file })
  const evt = db.prepare("SELECT * FROM events WHERE type='binding.bound' ORDER BY created_at DESC LIMIT 1").get()
  assert.ok(evt, '应该有 binding.bound 事件')
  assert.equal(evt.agent_id, AID)
  assert.match(evt.payload, /qq-rebind/)
})
