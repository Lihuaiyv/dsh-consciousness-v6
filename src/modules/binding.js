/**
 * 会话绑定（schema 12）——「哪段对话归哪个意识体」。
 *
 * 为什么单独一个模块：
 *   以前「谁在运行」是一个全局单值（`activeAgentId()`），所有会话都认它。
 *   多实例之后，身份必须跟着会话走：一段对话同时只认一个人，一个人可以挂几段对话。
 *
 * 三条硬规则：
 *   1. 解析不出就返回 null —— 当普通 DSH，绝不「随便挑一个」兜底（那是串评的根）。
 *   2. 绑定的实例被用户暂停时，解析也返回 null，但**保留绑定**；用户唤醒后接着用。
 *   3. 自动动作（空闲回收）只释放绑定，不改 `agents.status` —— 用户的意图不许被系统覆盖。
 */
import { now } from '../db.js'
import { nid } from '../kernel.js'

/** 同时能「挂着」的实例上限（防止一口气开十个，每个都在打模型）。 */
export const DEFAULT_MAX_RUNNING = 3
/** 一段对话多久没动就自动松绑（天）。0 = 永不自动松。 */
export const DEFAULT_IDLE_RELEASE_DAYS = 30

function flagGet(db, key) {
  try {
    const r = db.prepare('SELECT value FROM flags WHERE key=?').get(key)
    return r ? r.value : null
  } catch { return null }
}

function flagSet(db, key, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO flags(key,value) VALUES(?,?)').run(key, String(value))
  } catch { /* flags 表异常不影响主流程 */ }
}

function flagDel(db, key) {
  try { db.prepare('DELETE FROM flags WHERE key=?').run(key) } catch { /* ignore */ }
}

function numFlag(db, key, fallback) {
  const raw = Number(flagGet(db, key))
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

/** 用户改的全局上限；0 表示不限（调试用）。 */
export function maxRunning(db) {  const raw = flagGet(db, 'runtime.max_running')
  if (raw == null) return DEFAULT_MAX_RUNNING
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_MAX_RUNNING
  return Math.max(0, Math.floor(n))
}

/** 未绑定会话的兜底实例：默认空 = 新对话就是普通 DSH（主人拍板）。 */
export function defaultAgent(db) {
  return flagGet(db, 'runtime.default_agent') || null
}

/** 改并发上限（0 = 不限）。界面上「同时最多几个」调的就是它。 */
export function setMaxRunning(db, n) {
  if (n == null || n === '') flagDel(db, 'runtime.max_running')
  else flagSet(db, 'runtime.max_running', Math.max(0, Math.floor(Number(n) || 0)))
  return maxRunning(db)
}

export function setDefaultAgent(db, aid) {
  if (aid) flagSet(db, 'runtime.default_agent', aid)
  else flagDel(db, 'runtime.default_agent')
}

/** 挑好的「下一次新会话用谁」。 */
export function setPending(db, agentId) {
  flagSet(db, 'pending_bind', agentId || '')
}

export function peekPending(db) {
  return flagGet(db, 'pending_bind') || null
}

export function clearPending(db) {
  flagDel(db, 'pending_bind')
}

/** 只取出、不消费（真正绑上了才清）。 */
function consumePending(db) {
  const aid = peekPending(db)
  if (aid) clearPending(db)
  return aid || null
}

/** 这个 agent 能不能被绑（存在、没软删）。暂停的也能绑，只是解析时不算数。 */
export function bindableAgent(db, agentId) {
  if (!agentId) return null
  const row = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId)
  if (!row || row.status === 'soft_deleted') return null
  return row
}

/** 当前挂着几段对话的实例（去重；被用户暂停的不算）。 */
export function runningAgentIds(db) {
  try {
    return db.prepare(`SELECT DISTINCT b.agent_id AS id FROM bindings b
      JOIN agents a ON a.id = b.agent_id
      WHERE b.state='bound' AND a.status='active'`).all().map((r) => r.id)
  } catch { return [] }
}

/**
 * 把一段会话绑到某个实例。
 * @returns {{ok:boolean, reason?:string, session_id:string, agent_id:string, queued?:boolean}}
 */
export function bindSession(db, agentId, sessionId, { source = 'auto', at = null } = {}) {
  const sid = String(sessionId || '').trim()
  if (!sid) return { ok: false, reason: 'no_session', session_id: '', agent_id: agentId || '' }
  const a = bindableAgent(db, agentId)
  if (!a) return { ok: false, reason: 'no_agent', session_id: sid, agent_id: agentId || '' }
  const ts = at || now()

  // 已经在别人身上：记一笔「换人」再覆盖（bindings 的 session_id 是主键，同一段只留一行；
  // 谁换过谁靠 events 留痕，不靠留下第二条绑定行）
  const old = db.prepare("SELECT * FROM bindings WHERE session_id=? AND state='bound'").get(sid)
  if (old && old.agent_id !== a.id) {
    event(db, old.agent_id, 'binding.released', { session: sid, by: 'switch', to: a.id })
  }

  // 并发上限：已经挂着的实例不算新增，不受限制（否则连聊都聊不了）。
  const cap = maxRunning(db)
  const running = runningAgentIds(db)
  const isNew = !running.includes(a.id)
  if (cap > 0 && isNew && running.length >= cap) {
    return { ok: false, reason: 'running_limit', queued: true, session_id: sid, agent_id: a.id, running: running.length }
  }

  db.prepare(`INSERT INTO bindings(session_id, agent_id, created_at, state, source, bound_at, last_seen_at, released_at, released_by)
    VALUES(?,?,?,?,?,?,?,NULL,NULL)
    ON CONFLICT(session_id) DO UPDATE SET
      agent_id=excluded.agent_id, state='bound', source=excluded.source,
      bound_at=excluded.bound_at, last_seen_at=excluded.last_seen_at,
      released_at=NULL, released_by=NULL`)
    .run(sid, a.id, ts, 'bound', source, ts, ts)
  refreshRuntime(db, a.id, ts)
  event(db, a.id, 'binding.bound', { session: sid, source })
  return { ok: true, session_id: sid, agent_id: a.id }
}

/** 松一段会话（会话被删 / 用户手动 / 空闲回收）。行留着可查。 */
export function unbindSession(db, sessionId, by = 'user', at = null) {
  const sid = String(sessionId || '')
  if (!sid) return 0
  const row = db.prepare("SELECT * FROM bindings WHERE session_id=? AND state='bound'").get(sid)
  if (!row) return 0
  db.prepare("UPDATE bindings SET state='released', released_at=?, released_by=? WHERE session_id=? AND state='bound'")
    .run(at || now(), by, sid)
  refreshRuntime(db, row.agent_id, at)
  event(db, row.agent_id, 'binding.released', { session: sid, by })
  return 1
}

/** 一个实例的全部会话一起松（「一键解绑」）。 */
export function unbindAgent(db, agentId, by = 'user', at = null) {
  const rows = db.prepare("SELECT session_id FROM bindings WHERE agent_id=? AND state='bound'").all(agentId)
  for (const r of rows) unbindSession(db, r.session_id, by, at)
  return rows.length
}

export function bindingOf(db, sessionId) {
  try {
    return db.prepare("SELECT * FROM bindings WHERE session_id=? AND state='bound'").get(String(sessionId || '')) || null
  } catch { return null }
}

export function bindingsOf(db, agentId) {
  try {
    return db.prepare("SELECT * FROM bindings WHERE agent_id=? AND state='bound' ORDER BY last_seen_at DESC").all(agentId)
  } catch { return [] }
}

/** 记一次「这段对话还在用」：TTL 与在场状态都靠它。 */
export function touchSession(db, sessionId, at = null) {
  const sid = String(sessionId || '')
  if (!sid) return 0
  const ts = at || now()
  const r = db.prepare("UPDATE bindings SET last_seen_at=? WHERE session_id=? AND state='bound'").run(ts, sid)
  return Number(r.changes || 0)
}

/**
 * 解析：这段会话现在归谁。
 * 顺序：已绑定 → 待绑定 → 默认实例 → null。
 * 用户暂停的实例返回 null（但绑定不删，唤醒后接着用）。
 * @returns {string|null} agent_id
 */
export function resolveAgentId(db, sessionId, { consume = true } = {}) {
  const sid = String(sessionId || '').trim()
  if (!sid) return null
  const row = bindingOf(db, sid)
  if (row) {
    const a = db.prepare('SELECT status FROM agents WHERE id=?').get(row.agent_id)
    if (!a || a.status === 'soft_deleted') return null
    if (a.status === 'paused') return null // 用户暂停优先：不注入、不推送
    return row.agent_id
  }
  const pending = peekPending(db)
  if (pending) {
    const a = bindableAgent(db, pending)
    if (a && a.status !== 'paused') {
      const r = bindSession(db, a.id, sid, { source: 'pending' })
      if (r.ok) {
        if (consume) consumePending(db)
        return a.id
      }
      // 超出并发上限：这次先不绑，待绑定留着（下次还有机会）
      return null
    }
    // 待绑定的实例被删/被暂停：作废，免得一直挂着
    if (!a) consumePending(db)
    return null
  }
  const def = defaultAgent(db)
  if (def) {
    const a = bindableAgent(db, def)
    if (a && a.status !== 'paused') {
      const r = bindSession(db, def, sid, { source: 'default' })
      if (r.ok) return def
    }
  }
  return null
}

/** 空闲回收：太久没动的会话自动松绑（不改用户意图）。 */
export function sweepBindings(db, { idleDays = DEFAULT_IDLE_RELEASE_DAYS, at = Date.now() } = {}) {
  if (!(idleDays > 0)) return 0
  const cut = new Date(at - idleDays * 86400000).toISOString()
  const rows = db.prepare("SELECT session_id, agent_id FROM bindings WHERE state='bound' AND COALESCE(last_seen_at, bound_at, created_at) < ?").all(cut)
  for (const r of rows) unbindSession(db, r.session_id, 'ttl', new Date(at).toISOString())
  return rows.length
}

/**
 * 在场状态（派生值，缓存到 agent_runtime 供界面读）。
 * offline：用户暂停；bound：有挂着的对话；idle：在线但没人跟它说话。
 */
export function runtimeStateOf(db, agentId) {
  const a = db.prepare('SELECT status, runtime_state FROM agents WHERE id=?').get(agentId)
  if (!a || a.status === 'soft_deleted') return 'offline'
  if (a.status === 'paused') return 'offline'
  const n = Number(db.prepare("SELECT COUNT(*) n FROM bindings WHERE agent_id=? AND state='bound'").get(agentId).n || 0)
  if (n > 0) return 'bound'
  // dormant 由心跳写进 agent_runtime，这里尊重它（别一刷新就把「自动休眠」抹成 idle）
  const rt = db.prepare('SELECT state FROM agent_runtime WHERE agent_id=?').get(agentId)
  if (rt && rt.state === 'dormant') return 'dormant'
  return 'idle'
}

export function refreshRuntime(db, agentId, at = null) {
  const ts = at || now()
  const state = runtimeStateOf(db, agentId)
  db.prepare(`INSERT INTO agent_runtime(agent_id, state, since, reason, updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(agent_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`)
    .run(agentId, state, ts, null, ts)
  db.prepare('UPDATE agents SET runtime_state=? WHERE id=?').run(state, agentId)
  return state
}

/**
 * 用户点唤醒：先抹掉自动休眠 / 离线的残留，再按绑定重算在场状态。
 *
 * 为什么放在本模块：agent_runtime 的写入归在场状态这一域，features 只做编排，不再直接写它。
 * 不清这一步的话，runtimeStateOf 会把刚唤醒的卡继续判成 dormant，界面不会展开。
 */
export function wakeRuntime(db, agentId, at = null) {
  try {
    db.prepare("UPDATE agent_runtime SET state='idle', reason=NULL, updated_at=? WHERE agent_id=? AND state IN ('dormant','offline')")
      .run(at || now(), agentId)
  } catch { /* 老库没有 agent_runtime 就跳过 */ }
  return refreshRuntime(db, agentId, at)
}

/**
 * 老库迁移（只跑一次）：schema 12 之前「所有会话都归唯一那个 active」，
 * 升级后如果什么都不做，主人正在聊的那段会突然变成普通 DSH——等于把她从对话里抽走。
 *
 * 所以按**已有原文**认领：raw_turns 里出现过的最近几段会话，分别绑回它当时的主人。
 * 只认领有真实对话记录的会话；新对话仍然不绑（主人拍板）。
 */
export function migrateLegacyBindings(db, { limit = 3, at = null } = {}) {
  const done = flagGet(db, 'runtime.bindings_migrated')
  if (done === '1') return { migrated: 0, skipped: 'done' }
  let rows = []
  try {
    rows = db.prepare(`SELECT session_id, agent_id, MAX(created_at) AS last_at, COUNT(*) AS n
      FROM raw_turns WHERE session_id IS NOT NULL AND session_id<>''
      GROUP BY session_id, agent_id ORDER BY last_at DESC LIMIT ?`).all(Math.max(1, limit * 4))
  } catch { rows = [] }
  if (!rows.length) {
    flagSet(db, 'runtime.bindings_migrated', '1')
    return { migrated: 0, skipped: 'no-history' }
  }
  // 一段会话只留它出现最多的那个 agent
  const bySession = new Map()
  for (const r of rows) {
    const cur = bySession.get(r.session_id)
    if (!cur || Number(r.n) > Number(cur.n)) bySession.set(r.session_id, r)
  }
  let migrated = 0
  for (const r of [...bySession.values()].slice(0, Math.max(1, limit))) {
    if (bindingOf(db, r.session_id)) continue
    const a = bindableAgent(db, r.agent_id)
    if (!a) continue
    const res = bindSession(db, a.id, r.session_id, { source: 'migrated', at })
    if (res.ok) migrated++
  }
  flagSet(db, 'runtime.bindings_migrated', '1')
  return { migrated, skipped: null }
}

/** 全表重算（启动时 / 改完绑定后）：保证 agents.runtime_state 与真值一致。 */
export function refreshAll(db, at = null) {  const rows = db.prepare("SELECT id FROM agents WHERE status!='soft_deleted'").all()
  for (const r of rows) {
    try { refreshRuntime(db, r.id, at) } catch { /* 单行失败不影响其他 */ }
  }
  return rows.length
}

function event(db, agentId, type, payload) {
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run(nid('evt_'), agentId, type, JSON.stringify(payload || {}), now())
  } catch { /* 记账失败不影响绑定 */ }
}
