/**
 * 会话 → 意识体认人（QQ 续绑、绑定表、发起人反查）。
 * 从 index.js 纯搬家；热路径 consciousnessBlock / hostSpec 不在这里。
 *
 * 宿主相关依赖（ensureDb / getParam / optionalService / probe）经 attachSessionAgents 注入。
 */
import { getParam as coreGetParam } from '../core.js'
import { resolveAgentId, peekPending, bindingOf, bindSession } from '../modules/binding.js'
import {
  resolveQQContext, isQQSessionId, parseOwnerQq, loadSessionMap,
  conversationIdOf, chatKeyOfSessionId,
} from '../modules/qq_bridge.js'
import { findQQSessionsFile } from '../modules/qq_watch.js'

let deps = {
  ensureDb: () => { throw new Error('session_agents: attachSessionAgents 未调用') },
  getParam: coreGetParam,
  optionalService: () => null,
  probe: () => {},
}

/** @param {{ ensureDb?: Function, getParam?: Function, optionalService?: Function, probe?: Function }} d */
export function attachSessionAgents(d = {}) {
  deps = { ...deps, ...d }
}

/**
 * QQ 会话重建后自动续绑。
 * 导出给测试用（test/qq-rebind.test.mjs）；业务里只由 attachQQBridge 的 autoBind 调。
 */
export function autoBindQQSession(db, sid, opts = {}) {
  const s = String(sid || '')
  if (!db || !isQQSessionId(s)) return null
  try { if (bindingOf(db, s)) return null } catch { /* 读不到绑定就当没绑 */ }
  // ① 聊天映射表 → chatKey → conversations 表（qq:p:<号> / qq:g:<号>）里这条聊天归谁
  let key = ''
  try {
    const file = opts && opts.sessionsFile ? String(opts.sessionsFile) : findQQSessionsFile()
    key = chatKeyOfSessionId(s, loadSessionMap(file) || {})
  } catch { key = '' }
  if (key) {
    const conv = conversationIdOf(key)
    if (conv) {
      try {
        const row = db.prepare("SELECT agent_id FROM conversations WHERE conversation_id=? AND state='active'").get(conv)
        if (row && row.agent_id) {
          const r = bindSession(db, row.agent_id, s, { source: 'qq-rebind' })
          if (r && r.ok) return r.agent_id
        }
      } catch { /* 继续走 ② */ }
    }
  }
  // ② 同一个 chatKey 的旧会话（前半段 hash 相同、只有时间戳后缀变了）还绑着谁。
  try {
    const digest = s.slice(0, 27)
    if (digest.length === 27) {
      const old = db.prepare("SELECT agent_id FROM bindings WHERE session_id LIKE ? AND session_id<>? AND state='bound' ORDER BY bound_at DESC LIMIT 1").get(digest + '-%', s)
      if (old && old.agent_id) {
        const r = bindSession(db, old.agent_id, s, { source: 'qq-rebind' })
        if (r && r.ok) return r.agent_id
      }
    }
  } catch { /* 认不出就保持原样 */ }
  return null
}

/** 一个 DSH sessionId 在 QQ 那边的身份（不是 QQ 会话返回 null）。 */
export function qqContextOf(sessionId) {
  try {
    const sid = String(sessionId || '')
    if (!isQQSessionId(sid)) return null
    const d = deps.ensureDb()
    const aid = sessionAgentId(d, sid) || activeAgentId(d)
    if (!aid) return null
    if (String(deps.getParam(d, aid, 'qq.bridge.enable') || 'off') !== 'on') return null
    const owners = parseOwnerQq(deps.getParam(d, aid, 'qq.bridge.owner_qq') || '')
    const file = deps.getParam(d, aid, 'qq.bridge.sessions_file') || findQQSessionsFile()
    return resolveQQContext(sid, { owners, sessionMap: loadSessionMap(file) })
  } catch { return null }
}

/**
 * 一个 QQ 会话键（qq-xxx 桥接会话 / qq:p: 旧通道会话）现在归谁。
 * 显式绑定优先，其次 conversations 表，最后才是当前激活的那只（只用于记账退路）。
 */
export function qqAidOf(db, key) {
  const k = String(key || '')
  if (!k) return activeAgentId(db)
  if (k.startsWith('qq:')) {
    try {
      const c = db.prepare('SELECT agent_id, state FROM conversations WHERE conversation_id=?').get(k)
      if (c && c.state === 'active' && c.agent_id) return c.agent_id
    } catch { /* 空 */ }
    return activeAgentId(db)
  }
  return sessionAgentId(db, k) || activeAgentId(db)
}

/**
 * 会话 → 意识体，只认得出、不猜：
 *   1) 绑定表里这条会话直接绑了谁；
 *   2) QQ 会话：反查桥接的会话映射表，拿到 chatKey 再查 conversations。
 */
export function agentOfSession(d, sid) {
  const s = String(sid || '')
  if (!s) return ''
  try { const a = sessionAgentId(d, s); if (a) return a } catch { /* 继续 */ }
  try {
    if (isQQSessionId(s)) {
      const map = loadSessionMap(findQQSessionsFile()) || {}
      for (const [key, id] of Object.entries(map)) {
        if (String(id) !== s) continue
        const conv = conversationIdOf(key)
        if (!conv) continue
        const row = d.prepare("SELECT agent_id FROM conversations WHERE conversation_id=? AND state='active'").get(conv)
        if (row && row.agent_id) return String(row.agent_id)
      }
    }
  } catch { /* 认不出就空 */ }
  return ''
}

export function currentQQContext() {
  try {
    const agents = deps.optionalService('agents')
    if (!agents || typeof agents.currentInitiator !== 'function') return null
    const who = agents.currentInitiator()
    if (!who || !who.id) return null
    const sid = String(who.id)
    const qc = qqContextOf(sid)
    return qc ? { ...qc, sessionId: sid } : null
  } catch { return null }
}

export function activeAgentId(db) {
  try {
    const r = db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY COALESCE(last_interaction_at, created_at) DESC LIMIT 1").get()
    return r ? r.id : null
  } catch { return null }
}

export function currentSessionId() {
  try {
    const agents = deps.optionalService('agents')
    if (!agents || typeof agents.currentInitiator !== 'function') return ''
    const who = agents.currentInitiator()
    return who && who.id ? String(who.id) : ''
  } catch { return '' }
}

/**
 * 一段会话现在归谁（只读，不写库；落绑定由 sessionEvent 的 pinSessionAgent 做）。
 */
export function sessionAgentId(db, sid) {
  const id = String(sid || '').trim()
  if (!id) return activeAgentId(db)
  try {
    const row = bindingOf(db, id)
    if (row) {
      const a = db.prepare('SELECT status FROM agents WHERE id=?').get(row.agent_id)
      if (!a || a.status === 'soft_deleted') return null
      if (a.status === 'paused') return null
      return row.agent_id
    }
  } catch { /* 解析失败走退路 */ }
  if (id.startsWith('qq-')) return null
  try {
    const pending = peekPending(db)
    if (pending) {
      const a = db.prepare('SELECT id,status FROM agents WHERE id=?').get(pending)
      if (a && a.status !== 'paused' && a.status !== 'soft_deleted') return a.id
    }
  } catch { /* 解析失败走退路 */ }
  return activeAgentId(db)
}

export function pinSessionAgent(db, sid) {
  const id = String(sid || '').trim()
  if (!id) return activeAgentId(db)
  if (id.startsWith('qq-') || id === 'legacy') return null
  try {
    if (bindingOf(db, id)) return resolveAgentId(db, id) || null
  } catch { /* 读不到就当没绑 */ }
  try {
    const got = resolveAgentId(db, id)
    if (got) return got
  } catch { /* 继续走自动钉 */ }
  try {
    const act = activeAgentId(db)
    if (act && bindSession(db, act, id, { source: 'auto' }).ok) return act
  } catch { /* 钉不上就退回当前激活，至少不串到别人 */ }
  return activeAgentId(db)
}

/** 所有「用户允许活着」的实例：后台 worker 要遍历它们，不能只照顾最近那个。 */
export function enabledAgentIds(db) {
  try {
    return db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY COALESCE(last_interaction_at, created_at) DESC").all().map((r) => r.id)
  } catch { return [] }
}

const seenSessionIds = new Set()
let sessionProbeDone = false

export function probeSessionId(sid) {
  if (sessionProbeDone) return
  if (!seenSessionIds.has(sid)) {
    if (seenSessionIds.size > 0) {
      deps.probe('probe-session-mismatch prompt=' + sid.slice(0, 12) + ' event=' + [...seenSessionIds][0].slice(0, 12))
    }
    return
  }
  sessionProbeDone = true
  deps.probe('probe-session-ok ' + sid.slice(0, 12))
}

export function noteSessionEventId(sid) {
  if (!sid) return
  seenSessionIds.add(String(sid))
  if (seenSessionIds.size > 50) {
    const first = seenSessionIds.values().next().value
    seenSessionIds.delete(first)
  }
}

export function initiatorAgentId() {
  try {
    const d = deps.ensureDb()
    const svc = deps.optionalService('agents')
    if (svc && typeof svc.currentInitiator === 'function') {
      const a = svc.currentInitiator()
      if (a && a.id) {
        const sid = String(a.id)
        if (sid.startsWith('qq-')) return sessionAgentId(d, sid) || null
        const viaSession = sessionAgentId(d, sid)
        if (viaSession) return viaSession
      }
    }
  } catch { /* 宿主没这个服务时走老路 */ }
  try { return activeAgentId(deps.ensureDb()) } catch { return null }
}

/** 后台补数据用：paused 也算（只是不主动开口），只有软删的排除。 */
export function latestAgentId(db) {
  try {
    const r = db.prepare("SELECT id FROM agents WHERE status!='soft_deleted' ORDER BY COALESCE(last_interaction_at, created_at) DESC LIMIT 1").get()
    return r ? r.id : null
  } catch { return null }
}
