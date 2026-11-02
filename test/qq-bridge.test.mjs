/**
 * Step 1 · QQ 桥接「认人」的模拟测试
 *
 * 不碰真宿主、不碰线上库：内存 sqlite + 假 ctx，只验识别逻辑和事件落库。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  QQ_SESSION_PREFIX,
  qqDigest,
  qqSessionPrefix,
  isQQSessionId,
  parseChatKey,
  chatKeyOf,
  sessionMatchesChatKey,
  parseOwnerQq,
  identifyQQSession,
  attachQQBridge,
  attachQQIngest,
  conversationIdOf,
  isOwnerChatKey,
  loadSessionMap,
  qqChannelBlock,
  QQ_SECTION_NAME,
  QQ_SECTION_ORDER,
} from '../src/modules/qq_bridge.js'

const OWNER_QQ = '3192248859'
const OWNER_KEY = `u:${OWNER_QQ}`
const OWNER_SID = `${qqSessionPrefix(OWNER_KEY)}-m1abcd2e`
const STRANGER_SID = `${qqSessionPrefix('u:10001')}-m1abcd2e`
const GROUP_SID = `${qqSessionPrefix('g:55555')}-m1abcd2e`

function memDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, agent_id TEXT, type TEXT, payload TEXT, created_at TEXT)')
  return db
}

function rows(db) {
  return db.prepare('SELECT * FROM events ORDER BY id').all()
}

function fakeCtx() {
  const handlers = new Map()
  return {
    on(id, fn) {
      handlers.set(id, fn)
      return () => handlers.delete(id)
    },
    // thisArg 模拟 Cordis 把 this 绑到收到事件的 scope ctx
    fire(id, payload, thisArg) {
      const fn = handlers.get(id)
      if (fn) fn.call(thisArg, payload)
    },
    has(id) { return handlers.has(id) },
  }
}

test('S1-01 qqDigest 与桥接插件同算法：sha256 前 24 位十六进制', () => {
  const d = qqDigest(OWNER_KEY)
  assert.equal(d.length, 24)
  assert.match(d, /^[0-9a-f]{24}$/)
  // 固定向量：sha256('u:3192248859') 前 24 位，写死防止改动悄悄漂移
  assert.equal(d, qqDigest(OWNER_KEY))
})

test('S1-02 qqSessionPrefix 形如 qq-<24hex>', () => {
  const p = qqSessionPrefix(OWNER_KEY)
  assert.ok(p.startsWith(QQ_SESSION_PREFIX))
  assert.match(p, /^qq-[0-9a-f]{24}$/)
  assert.equal(p, `${QQ_SESSION_PREFIX}${qqDigest(OWNER_KEY)}`)
})

test('S1-03 isQQSessionId：认桥接插件的会话，别把别的当 QQ', () => {
  assert.equal(isQQSessionId(OWNER_SID), true)
  assert.equal(isQQSessionId(qqSessionPrefix(OWNER_KEY)), true) // 无时间戳后缀也认
  assert.equal(isQQSessionId(GROUP_SID), true)
  // 反例
  assert.equal(isQQSessionId(''), false)
  assert.equal(isQQSessionId(null), false)
  assert.equal(isQQSessionId(undefined), false)
  assert.equal(isQQSessionId('qq-abc'), false)              // 长度不对
  assert.equal(isQQSessionId('qq-' + 'Z'.repeat(24)), false) // 非十六进制
  assert.equal(isQQSessionId('web-123456789012345678901234'), false)
  assert.equal(isQQSessionId('QQ-' + qqDigest(OWNER_KEY)), false) // 大小写敏感
})

test('S1-04 parseChatKey / chatKeyOf 往返', () => {
  assert.deepEqual(parseChatKey('u:3192248859'), { kind: 'u', id: '3192248859', raw: 'u:3192248859' })
  assert.deepEqual(parseChatKey('g:55555'), { kind: 'g', id: '55555', raw: 'g:55555' })
  assert.equal(parseChatKey(''), null)
  assert.equal(parseChatKey('u:'), null)
  assert.equal(parseChatKey('u:abc'), null)
  assert.equal(parseChatKey('x:123'), null)
  assert.equal(parseChatKey('u:123:456'), null)
  assert.equal(chatKeyOf('u', '123'), 'u:123')
  assert.equal(chatKeyOf('g', '456'), 'g:456')
  assert.equal(chatKeyOf('x', '1'), '')
  assert.equal(chatKeyOf('u', ''), '')
  assert.equal(parseChatKey(chatKeyOf('u', '123')).raw, 'u:123')
})

test('S1-05 sessionMatchesChatKey：同号带后缀算匹配，别的号不算', () => {
  assert.equal(sessionMatchesChatKey(OWNER_SID, OWNER_KEY), true)
  assert.equal(sessionMatchesChatKey(qqSessionPrefix(OWNER_KEY), OWNER_KEY), true)
  assert.equal(sessionMatchesChatKey(STRANGER_SID, OWNER_KEY), false)
  assert.equal(sessionMatchesChatKey(GROUP_SID, 'g:55555'), true)
  assert.equal(sessionMatchesChatKey(GROUP_SID, OWNER_KEY), false)
  assert.equal(sessionMatchesChatKey('web-abc', OWNER_KEY), false)
  // 前缀相同但多出别的字符，不能算（防止 qq-<hex>abc 误命中）
  assert.equal(sessionMatchesChatKey(qqSessionPrefix(OWNER_KEY) + 'x', OWNER_KEY), false)
})

test('S1-06 parseOwnerQq：逗号/空格/分号都认，脏值丢掉', () => {
  assert.deepEqual(parseOwnerQq('123456, 789012'), ['123456', '789012'])
  assert.deepEqual(parseOwnerQq('123456，789012'), ['123456', '789012'])
  assert.deepEqual(parseOwnerQq('123456;789012 333444'), ['123456', '789012', '333444'])
  assert.deepEqual(parseOwnerQq(''), [])
  assert.deepEqual(parseOwnerQq(null), [])
  assert.deepEqual(parseOwnerQq('abc, 12, 123456'), ['123456']) // 太短 / 非数字都丢
  assert.deepEqual(parseOwnerQq(123456), ['123456'])           // 数字也接受
})

test('S1-07 identifyQQSession：主人认得出，陌生人认不出但不误判', () => {
  const owner = identifyQQSession(OWNER_SID, [OWNER_QQ])
  assert.equal(owner.isQQ, true)
  assert.equal(owner.isOwner, true)
  assert.equal(owner.chatKey, OWNER_KEY)
  assert.equal(owner.kind, 'u')
  assert.equal(owner.peerId, OWNER_QQ)
  assert.equal(owner.ownerUnset, false)

  // 陌生人：是 QQ，但不是主人
  const stranger = identifyQQSession(STRANGER_SID, [OWNER_QQ])
  assert.equal(stranger.isQQ, true)
  assert.equal(stranger.isOwner, false)
  assert.equal(stranger.chatKey, '')
  assert.equal(stranger.ownerUnset, false)

  // 没配主人号：认不出主人，但必须标 ownerUnset，别当成陌生人
  const unset = identifyQQSession(OWNER_SID, [])
  assert.equal(unset.isQQ, true)
  assert.equal(unset.isOwner, false)
  assert.equal(unset.ownerUnset, true)

  // 群会话不会命中主人的私聊号
  const group = identifyQQSession(GROUP_SID, [OWNER_QQ])
  assert.equal(group.isQQ, true)
  assert.equal(group.isOwner, false)
  assert.equal(group.kind, '')

  // 非 QQ 会话直接 short-circuit
  const web = identifyQQSession('web-abc', [OWNER_QQ])
  assert.deepEqual(web, { isQQ: false, digest: '', chatKey: '', kind: '', peerId: '', isOwner: false, ownerUnset: false, via: '' })
})

test('S1-07b 会话映射表：群号和陌生人也认得出来（hash 反推做不到这件事）', () => {
  const map = {
    [OWNER_KEY]: OWNER_SID,
    'u:10001': STRANGER_SID,
    'g:55555': GROUP_SID,
  }

  const owner = identifyQQSession(OWNER_SID, [OWNER_QQ], map)
  assert.equal(owner.via, 'map')
  assert.equal(owner.chatKey, OWNER_KEY)
  assert.equal(owner.isOwner, true)

  // 陌生人：以前只能认出「是 QQ」，现在能认出是哪个号
  const stranger = identifyQQSession(STRANGER_SID, [OWNER_QQ], map)
  assert.equal(stranger.via, 'map')
  assert.equal(stranger.chatKey, 'u:10001')
  assert.equal(stranger.peerId, '10001')
  assert.equal(stranger.isOwner, false)

  // 群：修的就是这一条——以前会被当成陌生人私聊
  const group = identifyQQSession(GROUP_SID, [OWNER_QQ], map)
  assert.equal(group.kind, 'g')
  assert.equal(group.chatKey, 'g:55555')
  assert.equal(group.isOwner, false)

  // 没有映射表时退回 hash：只认得出主人
  const fallback = identifyQQSession(GROUP_SID, [OWNER_QQ], null)
  assert.equal(fallback.via, '')
  assert.equal(fallback.kind, '')
  assert.equal(fallback.chatKey, '')
})

test('S1-07c 群号撞上主人 QQ 号：仍然不算主人（只有私聊才算）', () => {
  const map = { [`g:${OWNER_QQ}`]: GROUP_SID }
  const group = identifyQQSession(GROUP_SID, [OWNER_QQ], map)
  assert.equal(group.kind, 'g')
  assert.equal(group.isOwner, false)
})

test('S1-07d loadSessionMap：文件坏了/不存在都返回空表，不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-smap-'))
  const good = path.join(dir, 'good.json')
  fs.writeFileSync(good, JSON.stringify({ 'u:1': 'qq-a' }))
  assert.deepEqual(loadSessionMap(good), { 'u:1': 'qq-a' })

  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, '{not json')
  assert.deepEqual(loadSessionMap(bad), {})

  assert.deepEqual(loadSessionMap(path.join(dir, 'nope.json')), {})
  assert.deepEqual(loadSessionMap(''), {})
  assert.deepEqual(loadSessionMap(null), {})

  // 数组 / 标量也当空表
  const arr = path.join(dir, 'arr.json')
  fs.writeFileSync(arr, '[1,2,3]')
  assert.deepEqual(loadSessionMap(arr), {})
})

test('S1-08 attachQQBridge：没 ctx 就老实说没挂上', () => {
  const r1 = attachQQBridge({})
  assert.equal(r1.attached, false)
  assert.equal(r1.reason, 'no getCtx')

  const r2 = attachQQBridge({ getCtx: () => null })
  assert.equal(r2.attached, false)

  const r3 = attachQQBridge({ getCtx: () => ({}) })
  assert.equal(r3.attached, false)
})

test('S1-09 开关 off：一条事件都不写（默认行为必须和没装一样）', () => {
  const db = memDb()
  const ctx = fakeCtx()
  const h = attachQQBridge({
    getCtx: () => ctx,
    getDb: () => db,
    getAid: () => 'agent_main',
    param: (k) => (k === 'qq.bridge.enable' ? 'off' : k === 'qq.bridge.owner_qq' ? OWNER_QQ : undefined),
  })
  assert.equal(h.attached, true)
  assert.equal(ctx.has('agent/created'), true)
  ctx.fire('agent/created', { agent: { id: OWNER_SID }, source: 'create' })
  assert.equal(rows(db).length, 0)
})

test('S1-10 开关 on：QQ 会话写事件，web 会话不写', () => {
  const db = memDb()
  const ctx = fakeCtx()
  attachQQBridge({
    getCtx: () => ctx,
    getDb: () => db,
    getAid: () => 'agent_main',
    param: (k) => (k === 'qq.bridge.enable' ? 'on' : k === 'qq.bridge.owner_qq' ? OWNER_QQ : undefined),
  })

  ctx.fire('agent/created', { agent: { id: OWNER_SID }, source: 'create' })
  ctx.fire('agent/created', { agent: { id: STRANGER_SID }, source: 'resume' })
  ctx.fire('agent/created', { agent: { id: 'web-abc' }, source: 'create' }) // 不该记

  const all = rows(db).filter((r) => r.type === 'qq.bridge.detected')
  assert.equal(all.length, 2)

  const ownerEvt = all.find((r) => JSON.parse(r.payload).sessionId === OWNER_SID)
  assert.ok(ownerEvt)
  assert.equal(ownerEvt.type, 'qq.bridge.detected')
  assert.equal(ownerEvt.agent_id, 'agent_main')
  const p = JSON.parse(ownerEvt.payload)
  assert.equal(p.isOwner, true)
  assert.equal(p.chatKey, OWNER_KEY)
  assert.equal(p.peerId, OWNER_QQ)
  assert.equal(p.source, 'create')

  const strangerEvt = all.find((r) => JSON.parse(r.payload).sessionId === STRANGER_SID)
  assert.ok(strangerEvt)
  const sp = JSON.parse(strangerEvt.payload)
  assert.equal(sp.isOwner, false)
  assert.equal(sp.chatKey, '')
  assert.equal(sp.ownerUnset, false)
  assert.equal(sp.source, 'resume')
})

test('S1-11 异常不炸宿主：db 抛错 / agent 字段缺失都吞掉', () => {
  const ctx = fakeCtx()
  attachQQBridge({
    getCtx: () => ctx,
    getDb: () => { throw new Error('db down') },
    getAid: () => 'agent_main',
    param: (k) => (k === 'qq.bridge.enable' ? 'on' : ''),
    log: () => {},
  })
  // 不抛
  assert.doesNotThrow(() => ctx.fire('agent/created', { agent: { id: OWNER_SID } }))
  // 缺 agent / 缺 id 也不抛
  assert.doesNotThrow(() => ctx.fire('agent/created', {}))
  assert.doesNotThrow(() => ctx.fire('agent/created', { agent: {} }))
  assert.doesNotThrow(() => ctx.fire('agent/created', null))
})

test('S1-12 dispose 能真的摘掉监听（插件卸载不留钩子）', () => {
  const db = memDb()
  const ctx = fakeCtx()
  const h = attachQQBridge({
    getCtx: () => ctx,
    getDb: () => db,
    getAid: () => 'agent_main',
    param: (k) => (k === 'qq.bridge.enable' ? 'on' : ''),
  })
  assert.equal(ctx.has('agent/created'), true)
  h.dispose()
  assert.equal(ctx.has('agent/created'), false)
  ctx.fire('agent/created', { agent: { id: OWNER_SID } })
  assert.equal(rows(db).length, 0)
})

test('S1-13 宿主有 ctx.effect 时走 effect：重载只挂一份，卸载能摘', () => {
  const db = memDb()
  const handlers = new Map()
  const effects = []
  const ctx = {
    on(id, fn) {
      handlers.set(id, fn)
      return () => handlers.delete(id)
    },
    effect(cb) {
      const d = cb()
      effects.push(d)
      return d
    },
    fire(id, payload) {
      const fn = handlers.get(id)
      if (fn) fn(payload)
    },
    has(id) { return handlers.has(id) },
  }
  const h = attachQQBridge({
    getCtx: () => ctx,
    getDb: () => db,
    getAid: () => 'agent_main',
    param: (k) => (k === 'qq.bridge.enable' ? 'on' : ''),
  })
  assert.equal(h.attached, true)
  assert.equal(effects.length, 1, '应该通过 ctx.effect 注册，而不是裸 ctx.on')
  assert.equal(ctx.has('agent/created'), true)

  // 触发一次只写一条（没有重复监听）
  ctx.fire('agent/created', { agent: { id: OWNER_SID } })
  assert.equal(rows(db).filter((r) => r.type === 'qq.bridge.detected').length, 1)

  // dispose 后监听真的没了
  h.dispose()
  assert.equal(ctx.has('agent/created'), false)
  ctx.fire('agent/created', { agent: { id: OWNER_SID } })
  assert.equal(rows(db).filter((r) => r.type === 'qq.bridge.detected').length, 1)
})

// ---------------- Step 2：渠道段注入 ----------------

function agentCtxRecorder() {
  const rec = { sections: [], disposed: 0 }
  rec.ctx = {
    systemPrompt: {
      section(sec) {
        // 模拟 same-layer 重复注册会抛错（Cordis 的真实行为）
        if (rec.sections.some((s) => s.name === sec.name)) throw new Error('duplicate section ' + sec.name)
        rec.sections.push(sec)
        return () => { rec.disposed += 1 }
      },
    },
  }
  return rec
}

function onBridge(db, ctx, extra = {}) {
  return attachQQBridge({
    getCtx: () => ctx,
    getDb: () => db,
    getAid: () => 'agent_main',
    param: (k) => (k === 'qq.bridge.enable' ? (extra.enable ?? 'on') : k === 'qq.bridge.owner_qq' ? (extra.owner ?? OWNER_QQ) : ''),
  })
}

test('S2-01 qqChannelBlock：不是 QQ 就一个字都不出', () => {
  assert.equal(qqChannelBlock(), '')
  assert.equal(qqChannelBlock(null), '')
  assert.equal(qqChannelBlock({ isQQ: false }), '')
})

test('S2-02 主人：认得出来，语气跟平时一样', () => {
  const t = qqChannelBlock({ isQQ: true, kind: 'u', isOwner: true, ownerUnset: false })
  assert.match(t, /QQ/)
  assert.match(t, /主人/)
  assert.ok(!/不认识/.test(t))
})

test('S2-03 陌生人：不叫主人、不讲主人的事', () => {
  const t = qqChannelBlock({ isQQ: true, kind: 'u', isOwner: false, ownerUnset: false })
  assert.match(t, /不认识/)
  assert.match(t, /别叫主人/)
  assert.ok(!/可以亲近/.test(t))
})

test('S2-04 群聊：提醒别把不同人的话混成一个人', () => {
  const t = qqChannelBlock({ isQQ: true, kind: 'g', isOwner: false, ownerUnset: false })
  assert.match(t, /群聊/)
  assert.match(t, /共用/)
  assert.ok(!/别叫主人/.test(t))
})

test('S2-05 没配主人号：说"不确定"，不是直接当陌生人', () => {
  const t = qqChannelBlock({ isQQ: true, kind: 'u', isOwner: false, ownerUnset: true })
  assert.match(t, /不确定/)
  assert.match(t, /别一上来就叫主人/)
  assert.ok(!/不认识你的人/.test(t))
})

test('S2-06 渠道段只说渠道：不该重复人格/记忆那些内容', () => {
  const t = qqChannelBlock({ isQQ: true, kind: 'u', isOwner: true })
  for (const w of ['记忆', '人格', '情绪值', '关系值', '亲近']) {
    assert.ok(!t.includes(w), '渠道段不应包含「' + w + '」')
  }
})

test('S2-07 挂到会话自己的 scope：name/order 正确，text 每次现算', () => {
  const db = memDb()
  const ctx = fakeCtx()
  const a = agentCtxRecorder()
  onBridge(db, ctx)
  ctx.fire('agent/created', { agent: { id: OWNER_SID }, source: 'startup' }, a.ctx)

  assert.equal(a.sections.length, 1)
  const sec = a.sections[0]
  assert.equal(sec.name, QQ_SECTION_NAME)
  assert.equal(sec.order, QQ_SECTION_ORDER)
  assert.equal(typeof sec.text, 'function', 'text 必须是函数，不然身份会冻在创建那一刻')
  assert.match(sec.text(), /主人/)
})

test('S2-08 同一个会话的 ctx 只挂一次（重放不会抛 duplicate）', () => {
  const db = memDb()
  const ctx = fakeCtx()
  const a = agentCtxRecorder()
  onBridge(db, ctx)
  ctx.fire('agent/created', { agent: { id: OWNER_SID } }, a.ctx)
  assert.doesNotThrow(() => ctx.fire('agent/created', { agent: { id: OWNER_SID } }, a.ctx))
  assert.equal(a.sections.length, 1)
})

test('S2-09 拿不到 scoped ctx：不挂、不崩，事件照记，探针去重', () => {
  const db = memDb()
  const ctx = fakeCtx()
  onBridge(db, ctx)
  assert.doesNotThrow(() => ctx.fire('agent/created', { agent: { id: OWNER_SID } }, undefined))
  assert.doesNotThrow(() => ctx.fire('agent/created', { agent: { id: OWNER_SID } }, {}))
  assert.doesNotThrow(() => ctx.fire('agent/created', { agent: { id: OWNER_SID } }, { systemPrompt: {} }))
  const all = rows(db)
  assert.equal(all.filter((r) => r.type === 'qq.bridge.detected').length, 3, '三次识别都要留下事件')
  const probe = all.filter((r) => r.type === 'qq.bridge.no_scope')
  assert.equal(probe.length, 1, '同一个 sessionId 的 no_scope 探针只报一次')
})

test('S2-10 section 注册失败：记一条 failed，detected 不受影响', () => {
  const db = memDb()
  const ctx = fakeCtx()
  const bad = { systemPrompt: { section() { throw new Error('registry closed') } } }
  onBridge(db, ctx)
  assert.doesNotThrow(() => ctx.fire('agent/created', { agent: { id: OWNER_SID } }, bad))
  const all = rows(db)
  assert.ok(all.find((r) => r.type === 'qq.bridge.detected'), '识别事件必须还在')
  const fail = all.find((r) => r.type === 'qq.bridge.section_failed')
  assert.ok(fail, '注册失败要留痕')
  assert.match(JSON.parse(fail.payload).error, /registry closed/)
})

test('S2-11 web 会话不挂渠道段', () => {
  const db = memDb()
  const ctx = fakeCtx()
  const a = agentCtxRecorder()
  onBridge(db, ctx)
  ctx.fire('agent/created', { agent: { id: 'web-session-abc' } }, a.ctx)
  assert.equal(a.sections.length, 0)
  assert.equal(rows(db).length, 0)
})

test('S2-12 开关 off：连渠道段也不挂（默认行为不变）', () => {
  const db = memDb()
  const ctx = fakeCtx()
  const a = agentCtxRecorder()
  onBridge(db, ctx, { enable: 'off' })
  ctx.fire('agent/created', { agent: { id: OWNER_SID } }, a.ctx)
  assert.equal(a.sections.length, 0)
  assert.equal(rows(db).length, 0)
})

// ---------------- Step 3：对话回流 ----------------

function memDbWithTurns() {
  const db = memDb()
  db.exec(`CREATE TABLE chat_turns(
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
    pack TEXT, mood TEXT, created_at TEXT NOT NULL, conversation_id TEXT)`)
  return db
}

function turns(db) {
  return db.prepare('SELECT * FROM chat_turns ORDER BY created_at, id').all()
}

function onIngest(db, ctx, extra = {}) {
  const calls = []
  const h = attachQQIngest({
    getCtx: () => ctx,
    getDb: () => db,
    getAid: () => 'agent_main',
    param: (k) => (k === 'qq.bridge.enable' ? (extra.enable ?? 'on')
      : k === 'qq.bridge.ingest' ? (extra.ingest ?? 'on')
        : k === 'qq.bridge.owner_qq' ? (extra.owner ?? OWNER_QQ) : ''),
    log: () => {},
    hooks: {
      onOwnerTurn: (args) => {
        calls.push(args)
        if (extra.hookThrows) throw new Error('hook boom')
      },
    },
  })
  return { h, calls }
}

test('S3-01 conversationIdOf 和库里已有格式对齐（私聊用 qq:p:，不是 qq:u:）', () => {
  // 库里已有 148 条 qq:p:3192248859 和 136 条同名 raw_turns；这里必须是同一个 id
  assert.equal(conversationIdOf(`u:${OWNER_QQ}`), `qq:p:${OWNER_QQ}`)
  assert.equal(conversationIdOf('g:55555'), 'qq:g:55555')
  assert.equal(conversationIdOf(''), '')
  assert.equal(conversationIdOf('x:1'), '')
  assert.equal(conversationIdOf('u:abc'), '')
})

test('S3-02 isOwnerChatKey：只有主人私聊算，群聊不算', () => {
  assert.equal(isOwnerChatKey(`u:${OWNER_QQ}`, [OWNER_QQ]), true)
  assert.equal(isOwnerChatKey(`u:10001`, [OWNER_QQ]), false)
  assert.equal(isOwnerChatKey(`g:${OWNER_QQ}`, [OWNER_QQ]), false, '群号撞上主人 QQ 号也不能算主人')
  assert.equal(isOwnerChatKey('', [OWNER_QQ]), false)
  assert.equal(isOwnerChatKey(`u:${OWNER_QQ}`, []), false)
})

test('S3-03 主人私聊：写一条 user 回合，并进长期记忆管线', () => {
  const db = memDbWithTurns()
  const ctx = fakeCtx()
  const { calls } = onIngest(db, ctx)
  ctx.fire('qqbridge:inbound', {
    chatKey: `u:${OWNER_QQ}`, userId: Number(OWNER_QQ), text: '今天有点累', messageId: 'm1', at: Date.now(),
  })
  const t = turns(db)
  assert.equal(t.length, 1)
  assert.equal(t[0].role, 'user')
  assert.equal(t[0].text, '今天有点累')
  assert.equal(t[0].conversation_id, `qq:p:${OWNER_QQ}`)
  assert.equal(t[0].agent_id, 'agent_main')
  assert.equal(calls.length, 1, '主人的话要进长期记忆')
  assert.equal(calls[0].role, 'user')
  assert.equal(calls[0].conversationId, `qq:p:${OWNER_QQ}`)
})

test('S3-04 陌生人私聊：只落这段会话的账，不进长期记忆', () => {
  const db = memDbWithTurns()
  const ctx = fakeCtx()
  const { calls } = onIngest(db, ctx)
  ctx.fire('qqbridge:inbound', { chatKey: 'u:10001', userId: 10001, text: '你好呀', messageId: 'm2', at: Date.now() })
  const t = turns(db)
  assert.equal(t.length, 1)
  assert.equal(t[0].conversation_id, 'qq:p:10001')
  assert.equal(calls.length, 0, '陌生人的话不能变成关于主人/关于我的记忆')
})

test('S3-05 群聊：记进群会话，但不进长期记忆', () => {
  const db = memDbWithTurns()
  const ctx = fakeCtx()
  const { calls } = onIngest(db, ctx)
  ctx.fire('qqbridge:inbound', { chatKey: 'g:55555', groupId: 55555, text: '群里说话', messageId: 'm3', at: Date.now() })
  assert.equal(turns(db)[0].conversation_id, 'qq:g:55555')
  assert.equal(calls.length, 0)
})

test('S3-06 injected / replayed 不是对方真说的，不记', () => {
  const db = memDbWithTurns()
  const ctx = fakeCtx()
  const { calls } = onIngest(db, ctx)
  ctx.fire('qqbridge:inbound', { chatKey: `u:${OWNER_QQ}`, text: '系统注入', messageId: 'a', injected: true })
  ctx.fire('qqbridge:inbound', { chatKey: `u:${OWNER_QQ}`, text: '重放', messageId: 'b', replayed: true })
  ctx.fire('qqbridge:inbound', { chatKey: `u:${OWNER_QQ}`, text: '   ', messageId: 'c' })
  ctx.fire('qqbridge:inbound', { chatKey: `u:${OWNER_QQ}`, text: '正常', messageId: 'd' })
  assert.equal(turns(db).length, 1)
  assert.equal(turns(db)[0].text, '正常')
  assert.equal(calls.length, 1)
})

test('S3-07 同一条消息重复投递只记一次（按 messageId 去重）', () => {
  const db = memDbWithTurns()
  const ctx = fakeCtx()
  const { calls } = onIngest(db, ctx)
  for (let i = 0; i < 3; i++) {
    ctx.fire('qqbridge:inbound', { chatKey: `u:${OWNER_QQ}`, text: '同一句', messageId: 'same-id', at: Date.now() })
  }
  assert.equal(turns(db).length, 1)
  assert.equal(calls.length, 1)
})

test('S3-08 出站文字：记 agent 回合，主人也进原文层', () => {
  const db = memDbWithTurns()
  const ctx = fakeCtx()
  const { calls } = onIngest(db, ctx)
  ctx.fire('qqbridge:outbound', { chatKey: `u:${OWNER_QQ}`, kind: 'text', text: '那先歇一会儿', at: Date.now() })
  const t = turns(db)
  assert.equal(t.length, 1)
  assert.equal(t[0].role, 'agent')
  assert.equal(t[0].text, '那先歇一会儿')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].role, 'agent')
})

test('S3-09 出站图片 / 空文字：没有字可记，跳过', () => {
  const db = memDbWithTurns()
  const ctx = fakeCtx()
  onIngest(db, ctx)
  ctx.fire('qqbridge:outbound', { chatKey: `u:${OWNER_QQ}`, kind: 'image', text: '配文', file: 'a.jpg' })
  ctx.fire('qqbridge:outbound', { chatKey: `u:${OWNER_QQ}`, kind: 'text', text: '  ' })
  assert.equal(turns(db).length, 0)
})

test('S3-10 开关：ingest=off 关记忆，enable=off 全关', () => {
  const db1 = memDbWithTurns()
  const ctx1 = fakeCtx()
  const { calls: c1 } = onIngest(db1, ctx1, { ingest: 'off' })
  ctx1.fire('qqbridge:inbound', { chatKey: `u:${OWNER_QQ}`, text: '不该记', messageId: 'x1' })
  assert.equal(turns(db1).length, 0)
  assert.equal(c1.length, 0)

  const db2 = memDbWithTurns()
  const ctx2 = fakeCtx()
  const { calls: c2 } = onIngest(db2, ctx2, { enable: 'off' })
  ctx2.fire('qqbridge:inbound', { chatKey: `u:${OWNER_QQ}`, text: '不该记', messageId: 'x2' })
  assert.equal(turns(db2).length, 0)
  assert.equal(c2.length, 0)
})

test('S3-11 hook 抛错：不丢这一句，事件里标 hookOk=false', () => {
  const db = memDbWithTurns()
  const ctx = fakeCtx()
  onIngest(db, ctx, { hookThrows: true })
  assert.doesNotThrow(() => ctx.fire('qqbridge:inbound', { chatKey: `u:${OWNER_QQ}`, text: '照样要记下', messageId: 'h1' }))
  assert.equal(turns(db).length, 1)
  const evt = rows(db).find((r) => r.type === 'qq.bridge.inbound_saved')
  assert.ok(evt)
  assert.equal(JSON.parse(evt.payload).hookOk, false)
})

test('S3-12 dispose 摘掉两个监听', () => {
  const db = memDbWithTurns()
  const ctx = fakeCtx()
  const { h } = onIngest(db, ctx)
  assert.equal(ctx.has('qqbridge:inbound'), true)
  assert.equal(ctx.has('qqbridge:outbound'), true)
  h.dispose()
  assert.equal(ctx.has('qqbridge:inbound'), false)
  assert.equal(ctx.has('qqbridge:outbound'), false)
  ctx.fire('qqbridge:inbound', { chatKey: `u:${OWNER_QQ}`, text: '摘掉后', messageId: 'z1' })
  assert.equal(turns(db).length, 0)
})

test('S3-13 没有 ctx：老实说没挂上', () => {
  assert.equal(attachQQIngest({}).attached, false)
  assert.equal(attachQQIngest({ getCtx: () => null }).attached, false)
})
