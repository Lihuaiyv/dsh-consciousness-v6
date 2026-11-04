/**
 * QQ 桥接 · 整体功能模拟（端到端）
 *
 * 把桥接插件会真实发出的那几串东西按顺序喂进来，走完整条链：
 *   QQ 消息 → agent/created（建会话）→ 系统提示挂渠道段 → 回复发回 QQ → 落库
 *
 * 这里不 mock 业务函数，只 mock 宿主边界（ctx.on / ctx.effect / systemPrompt.section）
 * 和参数存储，验的是「这几块拼在一起对不对」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  attachQQBridge,
  attachQQIngest,
  qqSessionPrefix,
  QQ_SECTION_NAME,
} from '../src/modules/qq_bridge.js'

const OWNER_QQ = '3192248859'
const OWNER_CHAT = `u:${OWNER_QQ}`
const OWNER_SID = `${qqSessionPrefix(OWNER_CHAT)}-m1abcd2e`
const STRANGER_CHAT = 'u:10001'
const STRANGER_SID = `${qqSessionPrefix(STRANGER_CHAT)}-m1abcd2e`
const GROUP_CHAT = 'g:55555'
const GROUP_SID = `${qqSessionPrefix(GROUP_CHAT)}-m1abcd2e`

// ---------------------------------------------------------------- 宿主边界

function makeHost() {
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
    fire(id, payload, thisArg) {
      const fn = handlers.get(id)
      if (fn) fn.call(thisArg, payload)
    },
    has(id) { return handlers.has(id) },
  }
  return { ctx, handlers, effects }
}

/** 一个会话自己的 ctx：只有 systemPrompt.section，和宿主一样同名重复会抛。 */
function makeAgentCtx() {
  const rec = { sections: [] }
  rec.ctx = {
    systemPrompt: {
      section(sec) {
        if (rec.sections.some((s) => s.name === sec.name)) throw new Error('duplicate ' + sec.name)
        rec.sections.push(sec)
        return () => { rec.sections = rec.sections.filter((s) => s !== sec) }
      },
    },
  }
  return rec
}

function makeParam(init = {}) {
  const vals = {
    'qq.bridge.enable': 'off',
    'qq.bridge.owner_qq': '',
    'qq.bridge.ingest': 'on',
    'qq.bridge.sessions_file': '',
    ...init,
  }
  return {
    get: (k) => vals[k],
    set: (k, v) => { vals[k] = v },
  }
}

/** 桥接插件真实会写出来的那张表：key → sessionId。 */
function makeSessionsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-qq-'))
  const file = path.join(dir, 'qq-sessions.json')
  fs.writeFileSync(file, JSON.stringify({
    [OWNER_CHAT]: OWNER_SID,
    [STRANGER_CHAT]: STRANGER_SID,
    [GROUP_CHAT]: GROUP_SID,
  }))
  return file
}

// ---------------------------------------------------------------- 库

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, agent_id TEXT, type TEXT, payload TEXT, created_at TEXT)')
  db.exec(`CREATE TABLE chat_turns(
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
    pack TEXT, mood TEXT, created_at TEXT NOT NULL, conversation_id TEXT)`)
  return db
}

const evts = (db) => db.prepare('SELECT * FROM events ORDER BY rowid').all().map((r) => ({
  type: r.type, payload: JSON.parse(r.payload),
}))
const turns = (db) => db.prepare('SELECT * FROM chat_turns ORDER BY rowid').all()

// ---------------------------------------------------------------- 组装

function boot(opts = {}) {
  const host = makeHost()
  const db = makeDb()
  const param = makeParam({
    'qq.bridge.sessions_file': opts.noSessionsFile ? '' : makeSessionsFile(),
    ...opts.params,
  })
  const hookCalls = []
  const deps = {
    getCtx: () => host.ctx,
    getDb: () => db,
    getAid: () => 'agent_main',
    param: param.get,
    log: () => {},
  }
  const bridge = attachQQBridge(deps)
  const ingest = attachQQIngest({
    ...deps,
    hooks: {
      onOwnerTurn: (args) => { hookCalls.push(args) },
    },
  })
  return { host, db, param, hookCalls, bridge, ingest }
}

/** 模拟桥接插件：一条 QQ 消息进来 → 建会话 → 模型回完 → 发回 QQ */
function qqRound(env, { chatKey, sid, messageId, text, reply, agentCtx }) {
  env.host.ctx.fire('qqbridge:inbound', {
    chatKey,
    userId: Number(String(chatKey).slice(2)) || 0,
    groupId: chatKey.startsWith('g:') ? Number(String(chatKey).slice(2)) : 0,
    messageId,
    text,
    at: Date.now(),
  })
  env.host.ctx.fire('agent/created', { agent: { id: sid }, source: 'startup' }, agentCtx)
  env.host.ctx.fire('qqbridge:outbound', {
    chatKey, kind: 'text', text: reply, batches: 1, mode: 'text', at: Date.now(),
  })
}

// ---------------------------------------------------------------- 场景

test('E2E-01 主人私聊：认出来 → 挂渠道段 → 双向落库 → 进长期记忆', () => {
  const env = boot({ params: { 'qq.bridge.enable': 'on', 'qq.bridge.owner_qq': OWNER_QQ } })
  const a = makeAgentCtx()
  qqRound(env, {
    chatKey: OWNER_CHAT, sid: OWNER_SID, messageId: 'm1',
    text: '今天有点累', reply: '那先趴一会儿，我在这。', agentCtx: a.ctx,
  })

  // 渠道段挂上了，而且只有一段
  assert.equal(a.sections.length, 1)
  assert.equal(a.sections[0].name, QQ_SECTION_NAME)
  assert.match(a.sections[0].text(), /主人/)

  // 双向都落进同一个 conversation_id —— 而且和库里已有的 qq:p: 前缀一致
  const t = turns(env.db)
  assert.equal(t.length, 2)
  assert.deepEqual(t.map((x) => x.role), ['user', 'agent'])
  assert.ok(t.every((x) => x.conversation_id === `qq:p:${OWNER_QQ}`))

  // 主人的话进了长期记忆管线
  assert.equal(env.hookCalls.length, 2)
  assert.deepEqual(env.hookCalls.map((c) => c.role), ['user', 'agent'])

  // 排查用的痕迹齐了
  const types = evts(env.db).map((e) => e.type)
  assert.ok(types.includes('qq.bridge.detected'))
  assert.ok(types.includes('qq.bridge.inbound_saved'))
  assert.ok(types.includes('qq.bridge.outbound_saved'))
})

test('E2E-01b QQ 主人的回话也会留下关系余量', () => {
  const env = boot({ params: { 'qq.bridge.enable': 'on', 'qq.bridge.owner_qq': OWNER_QQ } })
  const a = makeAgentCtx()
  // 先攒 5 句偏暖的常态，让「她自己的中位数」站住
  for (let i = 0; i < 5; i++) {
    qqRound(env, {
      chatKey: OWNER_CHAT, sid: OWNER_SID, messageId: 'warm' + i,
      text: '在吗 ' + i, reply: '今天还挺好的，放松了哈哈，第' + i + '句。', agentCtx: a.ctx,
    })
  }
  // 再来一句明显偏冷
  qqRound(env, {
    chatKey: OWNER_CHAT, sid: OWNER_SID, messageId: 'cold1',
    text: '你怎么了', reply: '算了，没什么好说的，随便吧。', agentCtx: a.ctx,
  })
  const rows = env.db.prepare("SELECT payload FROM events WHERE agent_id='agent_main' AND type='rel.self_residue'").all()
  assert.ok(rows.length >= 1, 'QQ 主人回话应记一条 rel.self_residue')
  const first = JSON.parse(rows[0].payload)
  assert.equal(first.dir, 'cold')
  assert.ok(Number(first.delta) < 0)
})

test('E2E-02 陌生人私聊：照样聊、渠道段换成陌生人口径、但不进长期记忆', () => {
  const env = boot({ params: { 'qq.bridge.enable': 'on', 'qq.bridge.owner_qq': OWNER_QQ } })
  const a = makeAgentCtx()
  qqRound(env, {
    chatKey: STRANGER_CHAT, sid: STRANGER_SID, messageId: 's1',
    text: '你是机器人吗', reply: '我是小汐呀。', agentCtx: a.ctx,
  })

  assert.equal(a.sections.length, 1)
  assert.match(a.sections[0].text(), /不认识/)
  assert.ok(!/对方是主人/.test(a.sections[0].text()))

  const t = turns(env.db)
  assert.equal(t.length, 2, '陌生人也要留这段会话的账')
  assert.ok(t.every((x) => x.conversation_id === 'qq:p:10001'))
  assert.equal(env.hookCalls.length, 0, '陌生人的话不能进长期记忆/关系账本')
})

test('E2E-03 群聊：进群会话，带上"别把不同人混成一个人"的提醒，不进长期记忆', () => {
  const env = boot({ params: { 'qq.bridge.enable': 'on', 'qq.bridge.owner_qq': OWNER_QQ } })
  const a = makeAgentCtx()
  qqRound(env, {
    chatKey: GROUP_CHAT, sid: GROUP_SID, messageId: 'g1',
    text: '大家好', reply: '大家好呀。', agentCtx: a.ctx,
  })
  assert.match(a.sections[0].text(), /群聊/)
  assert.ok(turns(env.db).every((x) => x.conversation_id === 'qq:g:55555'))
  assert.equal(env.hookCalls.length, 0)
})

test('E2E-04 默认关：整条链一条不写，和没装这个插件一样', () => {
  const env = boot() // 全部默认值
  const a = makeAgentCtx()
  qqRound(env, {
    chatKey: OWNER_CHAT, sid: OWNER_SID, messageId: 'd1',
    text: '默认关', reply: '默认回', agentCtx: a.ctx,
  })
  assert.equal(a.sections.length, 0, '关着不能往系统提示里加东西')
  assert.equal(turns(env.db).length, 0)
  assert.equal(evts(env.db).length, 0)
  assert.equal(env.hookCalls.length, 0)
})

test('E2E-05 同一个会话重放 agent/created：不重复挂，也不抛 duplicate', () => {
  const env = boot({ params: { 'qq.bridge.enable': 'on', 'qq.bridge.owner_qq': OWNER_QQ } })
  const a = makeAgentCtx()
  env.host.ctx.fire('agent/created', { agent: { id: OWNER_SID }, source: 'startup' }, a.ctx)
  assert.doesNotThrow(() => env.host.ctx.fire('agent/created', { agent: { id: OWNER_SID }, source: 'resume' }, a.ctx))
  assert.equal(a.sections.length, 1)
})

test('E2E-06 渠道段身份是现算的：后补主人号，下一轮就认得出', () => {
  const env = boot({ params: { 'qq.bridge.enable': 'on', 'qq.bridge.owner_qq': '' } })
  const a = makeAgentCtx()
  env.host.ctx.fire('agent/created', { agent: { id: OWNER_SID } }, a.ctx)
  assert.match(a.sections[0].text(), /不确定/, '没配主人号时先按不确定处理')

  env.param.set('qq.bridge.owner_qq', OWNER_QQ)
  assert.match(a.sections[0].text(), /对方是主人/, '补上主人号后，同一段提示要跟着变')
})

test('E2E-07 进出站被重复投递（重连/重放）：同一句只记一次', () => {
  const env = boot({ params: { 'qq.bridge.enable': 'on', 'qq.bridge.owner_qq': OWNER_QQ } })
  const a = makeAgentCtx()
  for (let i = 0; i < 3; i++) {
    qqRound(env, {
      chatKey: OWNER_CHAT, sid: OWNER_SID, messageId: 'dup-1',
      text: '同一句话', reply: '同一个回复', agentCtx: a.ctx,
    })
  }
  const t = turns(env.db)
  // 入站按 messageId 去重 → 1 条；出站按内容+5 秒窗口去重 → 1 条
  assert.equal(t.filter((x) => x.role === 'user').length, 1)
  assert.equal(t.filter((x) => x.role === 'agent').length, 1)
})

test('E2E-08 主人和陌生人同在一个库里：各归各的会话，不串人', () => {
  const env = boot({ params: { 'qq.bridge.enable': 'on', 'qq.bridge.owner_qq': OWNER_QQ } })
  const ao = makeAgentCtx()
  const as = makeAgentCtx()
  qqRound(env, { chatKey: OWNER_CHAT, sid: OWNER_SID, messageId: 'o1', text: '主人的话', reply: '主人回复', agentCtx: ao.ctx })
  qqRound(env, { chatKey: STRANGER_CHAT, sid: STRANGER_SID, messageId: 's2', text: '陌生人的话', reply: '陌生人回复', agentCtx: as.ctx })

  const ownerTurns = turns(env.db).filter((x) => x.conversation_id === `qq:p:${OWNER_QQ}`)
  const strangerTurns = turns(env.db).filter((x) => x.conversation_id === 'qq:p:10001')
  assert.equal(ownerTurns.length, 2)
  assert.equal(strangerTurns.length, 2)
  // 长期记忆只认主人的那两条
  assert.deepEqual(env.hookCalls.map((c) => c.conversationId), [`qq:p:${OWNER_QQ}`, `qq:p:${OWNER_QQ}`])
})

test('E2E-09 dispose 两套钩子：整条链彻底停', () => {
  const env = boot({ params: { 'qq.bridge.enable': 'on', 'qq.bridge.owner_qq': OWNER_QQ } })
  const a = makeAgentCtx()
  env.bridge.dispose()
  env.ingest.dispose()
  assert.equal(env.host.ctx.has('agent/created'), false)
  assert.equal(env.host.ctx.has('qqbridge:inbound'), false)
  assert.equal(env.host.ctx.has('qqbridge:outbound'), false)
  qqRound(env, { chatKey: OWNER_CHAT, sid: OWNER_SID, messageId: 'x', text: '卸载后', reply: '不该记', agentCtx: a.ctx })
  assert.equal(turns(env.db).length, 0)
  assert.equal(a.sections.length, 0)
})

test('E2E-10 非法事件不炸：null / 缺字段 / 非 QQ 会话', () => {
  const env = boot({ params: { 'qq.bridge.enable': 'on', 'qq.bridge.owner_qq': OWNER_QQ } })
  assert.doesNotThrow(() => env.host.ctx.fire('agent/created', null, undefined))
  assert.doesNotThrow(() => env.host.ctx.fire('agent/created', { agent: {} }, {}))
  assert.doesNotThrow(() => env.host.ctx.fire('qqbridge:inbound', null))
  assert.doesNotThrow(() => env.host.ctx.fire('qqbridge:inbound', {}))
  assert.doesNotThrow(() => env.host.ctx.fire('qqbridge:outbound', { kind: 'text' }))
  assert.doesNotThrow(() => env.host.ctx.fire('qqbridge:inbound', { chatKey: 'u:abc', text: 'x' }))
  env.host.ctx.fire('agent/created', { agent: { id: 'web-abc' } }, {})
  assert.equal(turns(env.db).length, 0)
  assert.equal(evts(env.db).filter((e) => e.type === 'qq.bridge.detected').length, 0)
})
