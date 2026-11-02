/**
 * 外部会话账（schema 13）——「这段 QQ 私聊/群归哪个意识体」。
 *
 * 和 bindings 分开：bindings 管 DSH 网页会话；这里管外部通道。
 * 一条消息进来先算 conversation_id（qq:p:<号> / qq:g:<群号>），再查这张表；
 * 查不到才用一次 default_agent 兜底并写下来。桥里不再每句话决定 agent。
 */
import { now } from '../db.js'

/** 没配置时的默认主人号（主人的常用大号）。 */
const FALLBACK_OWNER = process.env.DSHC_QQ_OWNER || '3192248859'

function flagGet(db, key) {
  try {
    const r = db.prepare('SELECT value FROM flags WHERE key=?').get(key)
    return r ? r.value : null
  } catch { return null }
}

function flagSet(db, key, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO flags(key,value) VALUES(?,?)').run(key, String(value))
  } catch { /* flags 异常不影响主流程 */ }
}

/** 会话键：私聊 qq:p:<QQ号>，群聊 qq:g:<群号>。 */
export function conversationKey({ channel = 'qq', type = 'private', handle = '' } = {}) {
  const ch = String(channel || 'qq').toLowerCase()
  const kind = type === 'group' ? 'g' : 'p'
  return `${ch}:${kind}:${String(handle).trim()}`
}

export function getConversation(db, conversationId) {
  try {
    return db.prepare('SELECT * FROM conversations WHERE conversation_id=?').get(String(conversationId)) || null
  } catch { return null }
}

export function touchConversation(db, conversationId) {
  try {
    db.prepare('UPDATE conversations SET last_seen_at=? WHERE conversation_id=?').run(now(), String(conversationId))
  } catch { /* 记账失败不影响回复 */ }
}

export function bindConversation(db, conversationId, agentId, { channel = 'qq', handle = '', personId = null, source = 'auto' } = {}) {
  const at = now()
  db.prepare(`INSERT INTO conversations(conversation_id,agent_id,channel,handle,person_id,state,created_at,last_seen_at,released_at,released_by)
    VALUES(?,?,?,?,?, 'active', ?,?,NULL,NULL)
    ON CONFLICT(conversation_id) DO UPDATE SET
      agent_id=excluded.agent_id, channel=excluded.channel, handle=excluded.handle,
      person_id=COALESCE(excluded.person_id, conversations.person_id),
      state='active', last_seen_at=excluded.last_seen_at, released_at=NULL, released_by=?`)
    .run(String(conversationId), String(agentId), String(channel || 'qq'), String(handle || ''), personId || null, at, at, String(source || 'auto'))
  return getConversation(db, conversationId)
}

export function releaseConversation(db, conversationId, by = 'user') {
  try {
    return db.prepare("UPDATE conversations SET state='released', released_at=?, released_by=? WHERE conversation_id=?")
      .run(now(), String(by), String(conversationId)).changes
  } catch { return 0 }
}

/** 这段会话现在归谁：只认本行；暂停/软删/已释放都解析为 null，不随便兜底。 */
export function agentForConversation(db, conversationId) {
  const row = getConversation(db, conversationId)
  if (!row || row.state !== 'active') return null
  let agent = null
  try { agent = db.prepare('SELECT * FROM agents WHERE id=?').get(row.agent_id) } catch { agent = null }
  if (!agent || agent.status === 'soft_deleted' || agent.status === 'paused') return null
  return agent
}

/**
 * 解析链：已绑 → default_agent 提示 → 唯一 active 实例 → null。
 * 只有第一次会写行；之后每句话都只读绑定，不再看提示。
 */
export function resolveOrBind(db, conversationId, { hint = '', channel = 'qq', handle = '' } = {}) {
  const row = getConversation(db, conversationId)
  if (row && row.state === 'active') {
    const agent = agentForConversation(db, conversationId)
    if (agent) { touchConversation(db, conversationId); return { agent, bound_new: false } }
    return { agent: null, bound_new: false, reason: 'agent_unavailable' }
  }
  let agent = null
  const want = String(hint || flagGet(db, 'qq.default_agent') || '')
  if (want) {
    try { agent = db.prepare('SELECT * FROM agents WHERE id=?').get(want) } catch { agent = null }
    if (agent && (agent.status === 'soft_deleted')) agent = null
  }
  if (!agent) {
    try {
      const act = db.prepare("SELECT * FROM agents WHERE status='active'").all()
      if (act.length === 1) agent = act[0]
    } catch { /* 老库异常 */ }
  }
  if (!agent) return { agent: null, bound_new: false, reason: 'no_default_agent' }
  bindConversation(db, conversationId, agent.id, { channel, handle, source: 'auto' })
  return { agent, bound_new: true }
}

export function listConversations(db, agentId = null, limit = 50) {
  try {
    const sql = agentId
      ? 'SELECT * FROM conversations WHERE agent_id=? ORDER BY last_seen_at DESC LIMIT ?'
      : 'SELECT * FROM conversations ORDER BY last_seen_at DESC LIMIT ?'
    return (agentId ? db.prepare(sql).all(String(agentId), limit) : db.prepare(sql).all(limit))
  } catch { return [] }
}

// ---------------- 提示词预算 ----------------

/** QQ 端每次回话最多带多少字上下文（0/未设 = 默认 4000，约两三千 token）。 */
export function promptBudget(db) {
  const n = Number(flagGet(db, 'qq.prompt_budget'))
  if (!Number.isFinite(n) || n <= 0) return 4000
  return Math.max(400, Math.min(12000, Math.round(n)))
}

export function setPromptBudget(db, n) {
  const v = Math.max(400, Math.min(12000, Number(n) || 4000))
  flagSet(db, 'qq.prompt_budget', v)
  return v
}

// ---------------- 多轮历史 / 召回条数 ----------------

/** 每次回话带几轮历史（1 轮 = 你一句我一句）。0 = 不带。默认 8。 */
export function historyTurns(db) {
  const raw = flagGet(db, 'qq.history_turns')
  if (raw == null || raw === '') return 8
  const n = Number(raw)
  if (!Number.isFinite(n)) return 8
  return Math.max(0, Math.min(20, Math.round(n)))
}

export function setHistoryTurns(db, n) {
  const v = Math.max(0, Math.min(20, Math.round(Number(n) || 0)))
  flagSet(db, 'qq.history_turns', v)
  return v
}

/** 每轮从记忆库取几条相关记忆。默认 10。 */
export function recallItems(db) {
  const raw = flagGet(db, 'qq.recall_items')
  if (raw == null || raw === '') return 10
  const n = Number(raw)
  if (!Number.isFinite(n)) return 10
  return Math.max(3, Math.min(20, Math.round(n)))
}

export function setRecallItems(db, n) {
  const v = Math.max(3, Math.min(20, Math.round(Number(n) || 10)))
  flagSet(db, 'qq.recall_items', v)
  return v
}

// ---------------- 默认实例 ----------------

export function defaultAgentId(db) {
  return String(flagGet(db, 'qq.default_agent') || '')
}

export function setDefaultAgentId(db, agentId) {
  flagSet(db, 'qq.default_agent', String(agentId || '').trim())
  return defaultAgentId(db)
}

// ---------------- 主人 ----------------

export function ownerHandle(db) {
  return String(flagGet(db, 'qq.owner') || FALLBACK_OWNER)
}

export function setOwnerHandle(db, handle) {
  flagSet(db, 'qq.owner', String(handle || '').trim())
  return ownerHandle(db)
}

/**
 * 号本身：去掉空白和通道前缀。
 * 桥那头可能传 `qq:3192248859`、`3192248859@qq`、带空格的号，
 * 以前是逐字相等，于是主人偶尔会被判成陌生人（反过来又怕宽松了把陌生人认成主人）。
 */
function bareHandle(h) {
  return String(h == null ? '' : h)
    .trim()
    .replace(/^(qq|wechat|wecom|wx|tg|group):/i, '')
    .replace(/@(qq|wechat|wecom|wx)$/i, '')
    .trim()
}

/** 只有主人号说的话，才算「关于主人」的事实。空号一律不是主人。 */
export function isOwner(db, handle) {
  const h = bareHandle(handle)
  if (!h) return false
  return h === bareHandle(ownerHandle(db))
}

/**
 * 本机通道（网页/后台自己）没有「号」这个概念，说话的就是主人本人。
 * 外部通道（qq/wechat…）漏了号，只能当陌生人——宁可少学，不可串人。
 */
const LOCAL_CHANNELS = new Set(['', 'ui', 'web', 'local', 'dsh', 'host'])

export function isLocalChannel(channel) {
  return LOCAL_CHANNELS.has(String(channel == null ? '' : channel).trim().toLowerCase())
}

// ---------------- 通道健康（掉线排查） ----------------

/** 桥的地址；换端口时用环境变量 DSHC_BRIDGE 覆盖。 */
export function bridgeBase() {
  return String(process.env.DSHC_BRIDGE || 'http://127.0.0.1:3100').replace(/\/+$/, '')
}

/**
 * 问一下桥「你还活着吗、QQ 还登着吗」。
 * 桥自己会去连 NapCat，所以这里一次就能看出是桥挂了还是 NapCat 挂了。
 */
export async function probeBridge(base = bridgeBase(), timeoutMs = 2500) {
  const checked_at = now()
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) throw new Error('bridge http ' + r.status)
    const j = await r.json()
    const qq = j.qq || null
    const qqOk = j.qq_ok != null ? !!j.qq_ok : !!(qq && qq.retcode === 0 && !qq.error)
    return {
      ok: qqOk,
      bridge: {
        reachable: true,
        url: base,
        uptime_sec: j.uptime_sec ?? null,
        default_agent: j.defaultAgent || '',
        dry_run: !!j.dryRun,
        last_inbound_at: j.last_inbound_at || null,
        last_sent_at: j.last_sent_at || null,
        inbound: j.inbound ?? null,
        sent: j.sent ?? null,
        last_error: j.last_error || null,
      },
      napcat: {
        ok: qqOk,
        user_id: (qq && qq.data && qq.data.user_id) ?? null,
        nickname: (qq && qq.data && qq.data.nickname) ?? null,
        error: qqOk ? null : String((qq && (qq.error || qq.message)) || 'unreachable'),
      },
      checked_at,
    }
  } catch (e) {
    return {
      ok: false,
      bridge: { reachable: false, url: base, error: String((e && e.message) || e) },
      napcat: { ok: false, error: '桥没应答，NapCat 状态未知' },
      checked_at,
    }
  }
}
