/**
 * QQ 通道健康探测的模拟测试。
 *
 * 背景（2026-11-04 的 bug）：桥接已经改成挂在宿主进程里的插件，不再开 3100 端口，
 * 但面板还在 `fetch http://127.0.0.1:3100/health`，于是永远显示「桥没起 / 桥没连上」——
 * 其实桥和 QQ 都好好的。现在先读桥自己写的运行快照（qq-runtime.json），问不出来才退回 HTTP。
 *
 * 这份测试只喂临时文件，不碰真宿主、不碰真进程表。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { qqBridgeHealth, qqBridgeProbe, qqBridgeWarming, qqWatchData } from '../src/modules/qq_watch.js'
import { qqSessionPrefix } from '../src/modules/qq_bridge.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-qqhealth-'))
}

function writeRuntime(dir, obj) {
  fs.writeFileSync(path.join(dir, 'qq-runtime.json'), JSON.stringify(obj))
}

test('H1 进程内桥：快照新鲜 + pid 就是自己 → 在线、reachable、local', () => {
  const dir = tmpDir()
  const now = Date.now()
  writeRuntime(dir, { updatedAt: now - 3000, pid: 4242, botOnline: true, uptimeSeconds: 90, sessionCount: 2 })
  const h = qqBridgeHealth({ dir, pid: 4242, at: now })
  assert.equal(h.fresh, true)
  assert.equal(h.local, true)
  assert.equal(h.online, true)
  assert.equal(h.sessions, 2)
  const p = qqBridgeProbe({ dir, pid: 4242, at: now })
  assert.ok(p, '应该给出本地结论')
  assert.equal(p.ok, true)
  assert.equal(p.bridge.reachable, true)
  assert.equal(p.bridge.local, true)
  assert.equal(p.bridge.uptime_sec, 90)
  assert.equal(p.napcat.ok, true)
})

test('H2 宿主重启后留下的旧快照：pid 对不上 → 不当作在线，交回 HTTP 探测', () => {
  const dir = tmpDir()
  const now = Date.now()
  writeRuntime(dir, { updatedAt: now - 1000, pid: 1111, botOnline: true })
  const p = qqBridgeProbe({ dir, pid: 4242, at: now })
  assert.equal(p, null, '别人的进程写的快照不能算证据')
})

test('H3 快照太旧（3 分钟没心跳）→ 不当作在线', () => {
  const dir = tmpDir()
  const now = Date.now()
  writeRuntime(dir, { updatedAt: now - 10 * 60 * 1000, pid: 4242, botOnline: true })
  assert.equal(qqBridgeHealth({ dir, pid: 4242, at: now }).fresh, false)
  assert.equal(qqBridgeProbe({ dir, pid: 4242, at: now }), null)
})

test('H4 桥活着但 QQ 没登着 → reachable 但 ok=false，并带一句人话', () => {
  const dir = tmpDir()
  const now = Date.now()
  writeRuntime(dir, { updatedAt: now - 1000, pid: 4242, botOnline: false })
  const p = qqBridgeProbe({ dir, pid: 4242, at: now })
  assert.ok(p)
  assert.equal(p.ok, false)
  assert.equal(p.bridge.reachable, true)
  assert.match(String(p.bridge.last_error), /QQ/)
  assert.match(String(p.napcat.error), /QQ/)
})

test('H5 没有运行快照（没装 / 没起）→ online 未知，probe 给 null', () => {
  const dir = tmpDir()
  const h = qqBridgeHealth({ dir, pid: 4242 })
  assert.equal(h.online, null)
  assert.equal(h.fresh, false)
  assert.equal(qqBridgeProbe({ dir, pid: 4242 }), null)
})

test('H6 快照缺字段也不炸：pid 缺失当没有证据', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'qq-runtime.json'), '{not json')
  assert.equal(qqBridgeHealth({ dir }).online, null)
  writeRuntime(dir, { updatedAt: Date.now(), botOnline: true })
  assert.equal(qqBridgeHealth({ dir }).local, false)
  assert.equal(qqBridgeProbe({ dir }), null)
})

test('H7 宿主刚重启、桥还没写第一份心跳 → 报「启动中」，不是「桥没起」', () => {
  const dir = tmpDir()
  const now = Date.now()
  writeRuntime(dir, { updatedAt: now - 5000, pid: 1111, botOnline: true })
  assert.equal(qqBridgeProbe({ dir, pid: 4242, at: now }), null)
  const w = qqBridgeWarming({ dir, pid: 4242, at: now, uptime_ms: 30 * 1000 })
  assert.ok(w, '刚启动的宿主应该给出「启动中」')
  assert.equal(w.warming, true)
  assert.equal(w.ok, false)
  assert.equal(w.bridge.reachable, false)
  assert.match(String(w.bridge.url), /重启/)
})

test('H8 宿主已经跑很久了还没心跳 → 就是真没起，不给「启动中」', () => {
  const dir = tmpDir()
  const now = Date.now()
  writeRuntime(dir, { updatedAt: now - 5000, pid: 1111, botOnline: true })
  assert.equal(qqBridgeWarming({ dir, pid: 4242, at: now, uptime_ms: 60 * 60 * 1000 }), null)
  // 快照本来就好好的，更不该报启动中
  writeRuntime(dir, { updatedAt: now - 1000, pid: 4242, botOnline: true })
  assert.equal(qqBridgeWarming({ dir, pid: 4242, at: now, uptime_ms: 30 * 1000 }), null)
})

test('W1 换下来的旧会话也能借同一个聊天认出是谁（不再写「映射表里没有这条」）', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT, created_at TEXT);
    CREATE TABLE bindings (session_id TEXT PRIMARY KEY, agent_id TEXT, state TEXT, source TEXT, bound_at TEXT);
    CREATE TABLE conversations (conversation_id TEXT PRIMARY KEY, agent_id TEXT, channel TEXT, handle TEXT, state TEXT, last_seen_at TEXT);
    CREATE TABLE fragments (session_id TEXT, created_at TEXT);
    CREATE TABLE events (type TEXT, payload TEXT, created_at TEXT);
  `)
  const aid = 'agt_x'
  const prefix = qqSessionPrefix('u:3192248859')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO agents VALUES(?,?,?,?)').run(aid, '小汐', 'active', now)
  db.prepare("INSERT INTO conversations VALUES(?,?,?,?,?,?)").run('qq:p:3192248859', aid, 'qq', '', 'active', now)
  const dir = tmpDir()
  const file = path.join(dir, 'qq-sessions.json')
  fs.writeFileSync(file, JSON.stringify({ 'u:3192248859': prefix + '-new001' }))
  db.prepare("INSERT INTO bindings VALUES(?,?,?,?,?)").run(prefix + '-new001', aid, 'bound', 'qq-rebind', now)
  db.prepare("INSERT INTO bindings VALUES(?,?,?,?,?)").run(prefix + '-old001', aid, 'bound', 'manual', now)
  const data = qqWatchData(db, { sessionsFile: file })
  const old = data.chatters.find((r) => r.session_id === prefix + '-old001')
  assert.ok(old, '旧会话应该被列出来')
  assert.equal(old.label, '私聊 3192248859')
  assert.equal(old.state, 'idle')
  const cur = data.chatters.find((r) => r.session_id === prefix + '-new001')
  assert.equal(cur.label, '私聊 3192248859')
  assert.equal(cur.state, 'ok')
})
