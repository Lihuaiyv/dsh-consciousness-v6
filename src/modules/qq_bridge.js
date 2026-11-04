/**
 * QQ 桥接适配 · Step 1「认人」
 *
 * 背景：dsh-qq-onebot-bridge 把每条 QQ 会话建成一个 DSH agent，
 * sessionId 形如 `qq-<sha256(chatKey)[:24]>-<base36 时间戳>`，chatKey 是 `u:<QQ号>` 或 `g:<群号>`。
 * 它刻意不管人格/记忆（README 里写明交给别的插件），所以「谁在说话」要我们自己认。
 *
 * 这一层只做识别，不改任何行为：
 *   - 这个 agent 是不是 QQ 来的（sessionId 前缀 + 24 位十六进制）
 *   - 是不是主人私聊（用配置里的主人 QQ 号正向算 hash 比对——hash 不可逆，只能正向验）
 *   - 认出来了就写一条 events，供后面 Step 2/3 和排查用
 *
 * 为什么不能从 sessionId 反推 QQ 号：sha256 是单向的。
 * 陌生人的 key 只能等桥接插件的 inbound 事件（带 chatKey）来告诉我们，Step 3 再处理。
 *
 * 参数（kernel.js PARAMS）：
 *   qq.bridge.enable    on/off（默认 off，关着时这一层完全不介入）
 *   qq.bridge.owner_qq  主人 QQ 号，逗号分隔（空 = 认不出主人，事件里标 ownerUnset）
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { moodLabelOf } from './affect.js'
import { recordReplyResidue } from './self_residue.js'
import { now } from '../db.js'

export const QQ_SESSION_PREFIX = 'qq-'

/** qq-<24 位小写十六进制>，后面可能跟 -<base36 时间戳>。 */
const QQ_SESSION_RE = /^qq-[0-9a-f]{24}(?:-[0-9a-z]+)?$/

/** 桥接插件 sessionPrefix() 的同一算法：sha256(key).hex.slice(0,24)。 */
export function qqDigest(chatKey) {
  return createHash('sha256').update(String(chatKey)).digest('hex').slice(0, 24)
}

/** `u:123` → `qq-<digest>`（不含时间戳后缀）。 */
export function qqSessionPrefix(chatKey) {
  return QQ_SESSION_PREFIX + qqDigest(chatKey)
}

export function isQQSessionId(sessionId) {
  return QQ_SESSION_RE.test(String(sessionId || ''))
}

/** `u:123` / `g:456` → { kind, id, raw }；非法返回 null。 */
export function parseChatKey(key) {
  const m = /^([ug]):(\d+)$/.exec(String(key || ''))
  if (!m) return null
  return { kind: m[1], id: m[2], raw: `${m[1]}:${m[2]}` }
}

export function chatKeyOf(kind, id) {
  const k = String(kind || '')
  const n = String(id || '')
  if ((k !== 'u' && k !== 'g') || !/^\d+$/.test(n)) return ''
  return `${k}:${n}`
}

/** 这个 sessionId 是否属于这条 chatKey（私聊 u: / 群 g:）。 */
export function sessionMatchesChatKey(sessionId, chatKey) {
  const sid = String(sessionId || '')
  if (!isQQSessionId(sid)) return false
  const prefix = qqSessionPrefix(chatKey)
  return sid === prefix || sid.startsWith(prefix + '-')
}

/** 主人 QQ 号配置：`123,456` → ['123','456']。 */
export function parseOwnerQq(raw) {
  return String(raw == null ? '' : raw)
    .split(/[,，\s;；]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{4,}$/.test(s))
}

/**
 * 读桥接插件的会话映射表（`qq-sessions.json`）：`{ "u:123": "qq-xxxx-yyyy", "g:456": "..." }`。
 *
 * 为什么需要它：sessionId 里的 hash 是单向的，靠主人号正向算只能认出主人自己，
 * 群号和陌生人永远认不出来（群聊会被错当成"陌生人私聊"）。
 * 桥接插件每次建会话都会往这个文件写一行，反过来就成了唯一能认全所有会话的线索。
 * 读不到就返回空表，调用方自动退化到 hash 匹配。
 */
export function loadSessionMap(file) {
  if (!file) return {}
  try {
    const raw = fs.readFileSync(String(file), 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch { return {} }
}

/** 在一张 key→sessionId 的表里反查 sessionId。 */
export function chatKeyOfSessionId(sessionId, sessionMap) {
  const sid = String(sessionId || '')
  if (!sid || !sessionMap || typeof sessionMap !== 'object') return ''
  for (const [key, val] of Object.entries(sessionMap)) {
    if (String(val) === sid) return String(key)
  }
  return ''
}

/**
 * 认一个 agent 是不是 QQ 会话、是谁。
 *
 * 两条路，优先第一条：
 *   1. sessionMap（从 qq-sessions.json 读出来的反查表）—— 群号/陌生人都认得；
 *   2. 主人号正向 hash 比对 —— 没有映射文件时的兜底，只认得出主人自己。
 */
export function identifyQQSession(sessionId, ownerQqList = [], sessionMap = null) {
  const sid = String(sessionId || '')
  if (!isQQSessionId(sid)) {
    return { isQQ: false, digest: '', chatKey: '', kind: '', peerId: '', isOwner: false, ownerUnset: false, via: '' }
  }
  const m = /^qq-([0-9a-f]{24})/.exec(sid)
  const digest = m ? m[1] : ''
  const owners = Array.isArray(ownerQqList) ? ownerQqList : []

  let foundKey = chatKeyOfSessionId(sid, sessionMap)
  let via = foundKey ? 'map' : ''
  if (!foundKey) {
    for (const qq of owners) {
      const key = `u:${qq}`
      if (qqDigest(key) === digest) { foundKey = key; via = 'hash'; break }
    }
  }

  const parsed = foundKey ? parseChatKey(foundKey) : null
  const isOwner = !!(parsed && parsed.kind === 'u' && owners.includes(parsed.id))
  return {
    isQQ: true,
    digest,
    chatKey: parsed ? parsed.raw : '',
    kind: parsed ? parsed.kind : '',
    peerId: parsed ? parsed.id : '',
    isOwner,
    // 没配主人号时，认不出主人不等于「确认他是陌生人」，单独标出来，别误伤。
    ownerUnset: owners.length === 0,
    via,
  }
}

function localEvent(db, aid, type, payload) {
  try {
    const id = 'evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10)
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(id, aid, type, JSON.stringify(payload), now())
  } catch { /* 记事件失败不影响主流程 */ }
}

/** QQ 渠道段的名字。刻意不用 'dsh-consciousness'：同名会遮蔽整份人格包，不是我们想要的。 */
export const QQ_SECTION_NAME = 'dsh-consciousness-qq'
/** 紧跟在全局人格段（order 12）后面。 */
export const QQ_SECTION_ORDER = 13

/**
 * QQ 渠道段：只说「换个地方说话要注意什么」。
 * 人格 / 记忆 / 情绪仍由全局段（order 12，所有 agent 都能看到）负责——
 * 桥接插件走的是真 agent loop，所以那份包对 QQ 会话本来就生效，这里不重复给。
 *
 * 两段内容不重叠：一个管「我是谁」，一个管「在这条线上怎么开口」。
 */
export function qqChannelBlock(info = {}) {
  if (!info || info.isQQ !== true) return ''
  const lines = [
    '【你现在在 QQ 上】',
    '这条消息从 QQ 进来，对方看不到网页界面。',
    '- 短：一两句就够。别写小标题、编号列表、加粗、代码块，QQ 不渲染这些，只会变成一堆符号。',
    '- 只凭文字和图片理解对方：没有语气、没有表情，别把猜的说成确定的。',
  ]
  const isGroup = info.kind === 'g' || info.channel === 'qq-group'
  if (isGroup) {
    lines.push('- 这是群聊：群里所有人共用这一段对话，别把 A 说的话当成 B 说的。')
  } else if (info.isOwner) {
    lines.push('- 对方是主人：跟平时一样就好。')
  } else if (info.ownerUnset) {
    lines.push('- 还不确定对方是谁（主人号没配）：先用平常的分寸，别一上来就叫主人。')
  } else {
    lines.push('- 对方是不认识你的人：别叫主人，别用只对主人的亲密语气，也别讲你和主人之间的事。')
  }
  return lines.join('\n')
}

/**
 * 挂上去。opts:
 *   getCtx    () => 宿主 ctx（Cordis）
 *   getDb     () => db
 *   getAid    () => 当前意识体 agent id
 *   param     (key) => 实例参数值
 *   log       (msg) => void
 */
export function attachQQBridge(opts = {}) {
  const { getCtx, getDb, getAid, param, log } = opts
  if (typeof getCtx !== 'function') return { attached: false, reason: 'no getCtx' }
  let ctx = null
  try { ctx = getCtx() } catch { ctx = null }
  if (!ctx || typeof ctx.on !== 'function') return { attached: false, reason: 'no ctx.on' }

  // 已经挂过渠道段的 agent ctx。用 WeakSet 而不是 Set<sessionId>：
  // 同一个会话 resume 时会有一个全新的 agentCtx，旧的那个已被 Cordis 销毁，不能拿 id 当成"已挂过"。
  const registeredAgents = new WeakSet()
  // 「拿不到会话 ctx」的探针去重：同一个 sessionId 只报一次，免得刷屏。
  const noScopeReported = new Set()

  // 注意：这里必须是普通 function 而不是箭头函数。
  // agent/created 的签名是 `(this: Scoped<Agent>, payload)`，this 绑到该会话自己的 ctx；
  // 渠道段要注册进那个 scope（不是插件根 scope），否则 web 也会看到「你在 QQ 上」。
  function handle(payload) {
    try {
      const paramOf = (k) => (typeof param === 'function' ? param(k) : undefined)
      const db = typeof getDb === 'function' ? getDb() : null
      if (!db) return
      const aid = typeof getAid === 'function' ? getAid() : ''
      if (!aid) return
      const enabled = String(paramOf('qq.bridge.enable') ?? 'off')
      if (enabled !== 'on') return
      const agent = payload && payload.agent ? payload.agent : null
      const sessionId = String((agent && agent.id) || (payload && payload.sessionId) || '')
      if (!isQQSessionId(sessionId)) return
      const owners = parseOwnerQq(paramOf('qq.bridge.owner_qq'))
      // 有了这张反查表才认得出群号和陌生人；读不到就退化成只认主人
      const sessionMap = loadSessionMap(paramOf('qq.bridge.sessions_file'))
      const who = identifyQQSession(sessionId, owners, sessionMap)
      localEvent(db, aid, 'qq.bridge.detected', {
        sessionId,
        source: String((payload && payload.source) || ''),
        chatKey: who.chatKey,
        kind: who.kind,
        peerId: who.peerId,
        isOwner: who.isOwner,
        ownerUnset: who.ownerUnset,
        via: who.via,
      })

      // Step 2：给这个会话挂渠道段（人格包由全局段负责，不在这里重复）。
      const agentCtx = (this && this.systemPrompt && typeof this.systemPrompt.section === 'function') ? this : null
      if (!agentCtx) {
        // 探针：agent/created 的签名是 (this: Scoped<Agent>, payload)，理论上 this 就是会话 ctx。
        // 万一宿主不绑 this，这里会留痕，否则就是「人格包在、渠道段静默没有」——最难查的那种。
        if (!noScopeReported.has(sessionId) && noScopeReported.size < 50) {
          noScopeReported.add(sessionId)
          localEvent(db, aid, 'qq.bridge.no_scope', { sessionId })
        }
        return
      }
      if (registeredAgents.has(agentCtx)) return
      try {
        agentCtx.systemPrompt.section({
          name: QQ_SECTION_NAME,
          order: QQ_SECTION_ORDER,
          // 每次组装都重新认一遍，不把身份冻在创建那一刻：
          // 后补主人号、或者同一个号从陌生人变成主人，下一轮就生效。
          text: () => {
            try {
              const liveMap = loadSessionMap(paramOf('qq.bridge.sessions_file'))
              const live = identifyQQSession(sessionId, parseOwnerQq(paramOf('qq.bridge.owner_qq')), liveMap)
              return qqChannelBlock(live)
            } catch { return '' }
          },
        })
        registeredAgents.add(agentCtx)
      } catch (e) {
        // 注册失败不能影响事件已经记下的那次识别；记一笔方便排查
        localEvent(db, aid, 'qq.bridge.section_failed', { sessionId, error: String(e && e.message ? e.message : e).slice(0, 200) })
      }
    } catch (e) {
      try { if (typeof log === 'function') log('[qq_bridge] agent/created 处理失败: ' + (e && e.message ? e.message : e)) } catch { /* ignore */ }
    }
  }

  let dispose = null
  try {
    // 优先走 ctx.effect：插件热重载 / 卸载时 Cordis 自动摘监听。
    // 只把它记在局部变量里是不够的——重载一次就会多一个监听，同一条 agent/created 写两遍事件。
    const ret = typeof ctx.effect === 'function'
      ? ctx.effect(() => ctx.on('agent/created', handle))
      : ctx.on('agent/created', handle)
    if (typeof ret === 'function') dispose = ret
    else if (ret && typeof ret.dispose === 'function') dispose = () => ret.dispose()
  } catch (e) {
    return { attached: false, reason: 'ctx.on failed: ' + (e && e.message ? e.message : e) }
  }
  return {
    attached: true,
    dispose: () => { try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ } },
  }
}

// ---------------------------------------------------------------- Step 3 · 记忆回流

/**
 * 桥接插件的 chatKey（`u:123` / `g:456`）→ 我们库里一直在用的 conversation_id。
 *
 * 私聊刻意映射成 `qq:p:<号>` 而不是 `qq:u:<号>`：库里已经有 148 条 `qq:p:3192248859`
 * 的聊天记录和 136 条同名 raw_turns。换一套前缀等于把同一个人的历史劈成两段，
 * 以后在网页侧翻不到「他在 QQ 上说过什么」。
 */
export function conversationIdOf(chatKey) {
  const p = parseChatKey(chatKey)
  if (!p) return ''
  return p.kind === 'u' ? `qq:p:${p.id}` : `qq:g:${p.id}`
}

/** 这条 chatKey 是不是主人的私聊（群聊一律不算）。 */
export function isOwnerChatKey(chatKey, ownerQqList = []) {
  const p = parseChatKey(chatKey)
  if (!p || p.kind !== 'u') return false
  return (Array.isArray(ownerQqList) ? ownerQqList : []).includes(p.id)
}

/**
 * 给 index.js 用：把一个 DSH sessionId 翻成「这段对话在 QQ 上是谁」。
 *
 * 为什么要它：意识体本来就有 session/event 旁路，QQ 会话的对话本来就会被它记下来——
 * 只是不知道是什么渠道，conversation_id 落了 null，和网页那 3000 多条混在一起。
 * 这里只补「翻译」和「主人判定」，**不另写一条路**，否则同一句话会记两遍。
 *
 * @returns {{isQQ:boolean, chatKey:string, conversationId:string, isOwner:boolean, ownerUnset:boolean, channel:'qq-private'|'qq-group'|''}}
 */
export function resolveQQContext(sessionId, { owners = [], sessionMap = null } = {}) {
  const who = identifyQQSession(sessionId, owners, sessionMap)
  if (!who.isQQ) {
    return { isQQ: false, chatKey: '', conversationId: '', isOwner: false, ownerUnset: false, channel: '' }
  }
  return {
    isQQ: true,
    chatKey: who.chatKey,
    conversationId: who.chatKey ? conversationIdOf(who.chatKey) : '',
    isOwner: who.isOwner,
    ownerUnset: who.ownerUnset,
    channel: who.kind === 'g' ? 'qq-group' : (who.kind === 'u' ? 'qq-private' : ''),
  }
}

/**
 * 订阅桥接插件的只读事件，把 QQ 上的对话记进库。
 *
 * 分工：
 *   - chat_turns：两个人都记（这是「这段会话自己的账」，不管对方是谁）
 *   - 长期记忆 / 关系账本：只记主人（陌生人说的话不能变成「关于主人」的事实——串人的根源）
 * 后半段从 hooks.onOwnerTurn 走，那边复用主聊天同一条管线，避免两套记忆两条命。
 *
 * opts:
 *   getCtx / getDb / getAid / param / log  同上
 *   hooks.onOwnerTurn({ db, aid, role, text, conversationId, at, chatKey })  主人回合的额外处理
 */
export function attachQQIngest(opts = {}) {
  const { getCtx, getDb, getAid, param, log, hooks = {} } = opts
  if (typeof getCtx !== 'function') return { attached: false, reason: 'no getCtx' }
  let ctx = null
  try { ctx = getCtx() } catch { ctx = null }
  if (!ctx || typeof ctx.on !== 'function') return { attached: false, reason: 'no ctx.on' }

  // 事件是 fire-and-forget 的只读旁路，可能重放 / 重复投递；按消息身份去重，别把一句话记成三条。
  const seen = new Set()
  const guard = (key) => {
    if (!key) return false
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > 800) {
      const first = seen.values().next().value
      if (first !== undefined) seen.delete(first)
    }
    return true
  }

  const flag = (k) => String((typeof param === 'function' ? param(k) : '') ?? '')
  const enabled = () => flag('qq.bridge.enable') === 'on' && flag('qq.bridge.ingest') !== 'off'
  const ownerList = () => parseOwnerQq(flag('qq.bridge.owner_qq'))
  const atOf = (t) => {
    const n = Number(t)
    return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : now()
  }
  const writeTurn = (db, aid, role, text, conv, at, owner = false) => {
    // QQ 通道没有当轮 expressionState 基准：用她在这个会话里自己的历史中位数。
    // 先落余量再写当前这一行，避免拿自己刚说的话当自己的常态。
    if (role === 'agent' && owner) {
      try { recordReplyResidue(db, aid, text, { conv, at: Date.parse(at) || Date.now() }) } catch { /* 余量失败不影响落库 */ }
    }
    const id = 'cht_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10)
    // 记下她说话时的情绪；QQ 这条路径以前也写 null，统计里一半是空的。
    db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, aid, role, text, '[]', moodLabelOf(db, aid), at, conv)
  }
  const callOwnerHook = (ctxArgs) => {
    if (typeof hooks.onOwnerTurn !== 'function') return true
    try {
      hooks.onOwnerTurn(ctxArgs)
      return true
    } catch (e) {
      try { if (typeof log === 'function') log('[qq_bridge] onOwnerTurn 失败: ' + (e && e.message ? e.message : e)) } catch { /* ignore */ }
      return false
    }
  }

  function onInbound(payload) {
    try {
      if (!enabled()) return
      if (!payload || typeof payload !== 'object') return
      // injected = 桥接插件自己塞给模型的话；replayed = 重放。都不是对方真说的。
      if (payload.injected === true || payload.replayed === true) return
      const text = String(payload.text || '').trim()
      if (!text) return
      const chatKey = String(payload.chatKey || '')
      const conv = conversationIdOf(chatKey)
      if (!conv) return
      const db = typeof getDb === 'function' ? getDb() : null
      const aid = typeof getAid === 'function' ? getAid() : ''
      if (!db || !aid) return
      const mid = String(payload.messageId || '')
      if (!guard(mid ? 'in:' + mid : 'in:' + chatKey + ':' + text.slice(0, 60))) return
      const owner = isOwnerChatKey(chatKey, ownerList())
      const at = atOf(payload.at)
      writeTurn(db, aid, 'user', text, conv, at, owner)
      const hookOk = owner ? callOwnerHook({ db, aid, role: 'user', text, conversationId: conv, at, chatKey }) : true
      localEvent(db, aid, 'qq.bridge.inbound_saved', {
        chatKey, conversationId: conv, owner, chars: text.length, hookOk,
      })
    } catch (e) {
      try { if (typeof log === 'function') log('[qq_bridge] inbound 处理失败: ' + (e && e.message ? e.message : e)) } catch { /* ignore */ }
    }
  }

  function onOutbound(payload) {
    try {
      if (!enabled()) return
      if (!payload || typeof payload !== 'object') return
      if (String(payload.kind || '') !== 'text') return // 图片没有文字可记
      const text = String(payload.text || '').trim()
      if (!text) return
      const chatKey = String(payload.chatKey || '')
      const conv = conversationIdOf(chatKey)
      if (!conv) return
      const db = typeof getDb === 'function' ? getDb() : null
      const aid = typeof getAid === 'function' ? getAid() : ''
      if (!db || !aid) return
      // 同一条回复可能分批发 / 重试发：按「内容 + 5 秒窗口」去重，不按 messageId（出站没有）。
      if (!guard('out:' + chatKey + ':' + text.slice(0, 80) + ':' + Math.floor(Date.now() / 5000))) return
      const owner = isOwnerChatKey(chatKey, ownerList())
      const at = atOf(payload.at)
      writeTurn(db, aid, 'agent', text, conv, at, owner)
      const hookOk = owner ? callOwnerHook({ db, aid, role: 'agent', text, conversationId: conv, at, chatKey }) : true
      localEvent(db, aid, 'qq.bridge.outbound_saved', {
        chatKey, conversationId: conv, owner, chars: text.length, hookOk,
      })
    } catch (e) {
      try { if (typeof log === 'function') log('[qq_bridge] outbound 处理失败: ' + (e && e.message ? e.message : e)) } catch { /* ignore */ }
    }
  }

  let dispose = null
  try {
    if (typeof ctx.effect === 'function') {
      const ret = ctx.effect(() => {
        const a = ctx.on('qqbridge:inbound', onInbound)
        const b = ctx.on('qqbridge:outbound', onOutbound)
        return () => {
          try { if (typeof a === 'function') a() } catch { /* ignore */ }
          try { if (typeof b === 'function') b() } catch { /* ignore */ }
        }
      })
      if (typeof ret === 'function') dispose = ret
      else if (ret && typeof ret.dispose === 'function') dispose = () => ret.dispose()
    } else {
      const a = ctx.on('qqbridge:inbound', onInbound)
      const b = ctx.on('qqbridge:outbound', onOutbound)
      dispose = () => {
        try { if (typeof a === 'function') a() } catch { /* ignore */ }
        try { if (typeof b === 'function') b() } catch { /* ignore */ }
      }
    }
  } catch (e) {
    return { attached: false, reason: 'ctx.on failed: ' + (e && e.message ? e.message : e) }
  }
  return {
    attached: true,
    dispose: () => { try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ } },
  }
}
