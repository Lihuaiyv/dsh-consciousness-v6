import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as c from './core.js'
import * as f from './features.js'
import { agent, ApiError, err, tx, getParam } from './core.js'
import { now } from './db.js'
import * as th from './modules/thoughts.js'
import * as sv from './modules/selfview.js'
import * as wv from './modules/worldview.js'
import * as lv from './modules/lifeview.js'
import { readViews, explainValues } from './modules/sangguan/bridge.js'
import * as ps from './modules/poisons.js'
import * as ar from './modules/archive.js'
import * as diary from './modules/diary.js'
import * as rt from './modules/retrieve.js'
import * as pk from './modules/pack.js'
import * as rl from './modules/retrieval_log.js'
import * as en from './modules/entities.js'
import * as ex from './modules/extract_queue.js'
import * as cf from './modules/conflict.js'
import * as ni from './modules/nightly.js'
import * as csl from './modules/consolidate.js'
import * as jg from './modules/judge.js'
import * as tp from './modules/temps.js'
import * as vt from './modules/vault.js'
import * as sd from './modules/study.js'
import * as asof from './modules/asof.js'
import * as R from './modules/relations.js'
import * as axe from './modules/axis_evidence.js'
import * as rope from './modules/rope.js'
import * as selfScan from './modules/self_scan.js'
import * as personaJudge from './modules/persona_judge.js'
import { setAxisIntent, getAxisIntent, clearAxisIntent, releaseAxis, AXIS_KEYS, anchorLine } from './modules/traits.js'
import * as personaProbe from './modules/persona_probe.js'
import { refreshHeat, tierStats } from './modules/tiers.js'
import * as act from './modules/actions/index.js'
import * as br from './modules/browse.js'
import * as sg from './modules/sangguan/api.js'
import * as bd from './modules/binding.js'
import * as cv from './modules/conversations.js'
import * as au from './modules/self_author.js'
import * as res from './modules/self_residue.js'
import { lifeTick, lifeLine } from './modules/life.js'
import { model as kernelModel } from './kernel.js'
import { unzipStore } from './zip.js'

function roleOf(token) {
  if (token === 'user') return ['user', null]
  if (token === 'system') return ['system', null]
  if (token === 'viewer') return ['viewer', null]
  if (token?.startsWith('user:')) return ['user', token.slice(5)]
  if (token?.startsWith('system:')) return ['system', token.slice(7)]
  if (token?.startsWith('viewer:')) return ['viewer', token.slice(7)]
  return [null, null]
}

function scoped(bound, aid) {
  if (bound && bound !== aid) err(404, 'NOT_FOUND', 'agent 不存在')
}

// 按资源 id 反查归属：绑定到某个 agent 的调用方不能碰别人的资源
function ownerOf(db, table, id, bound) {
  let row
  try { row = db.prepare('SELECT agent_id FROM ' + table + ' WHERE id=?').get(id) } catch { row = null }
  if (!row) err(404, 'NOT_FOUND', '资源不存在')
  if (bound && row.agent_id !== bound) err(404, 'NOT_FOUND', '资源不存在')
  return row.agent_id
}

function q(path, key) {
  return new URL('http://x' + path).searchParams.get(key)
}

export async function handle(db, req) {
  const method = req.method || 'GET'
  const path = req.path || ''
  const body = req.body || {}
  const token = req.token
  const [role, bound] = roleOf(token)
  if (!role) return { status: 401, body: { error: { code: 'UNAUTHORIZED', message: '缺少或无效的 token' } } }
  if (role === 'system') return { status: 403, body: { error: { code: 'FORBIDDEN', message: 'system 角色只能由宿主内部调用' } } }
  if (!f.rateLimit('role:' + role)) return { status: 429, body: { error: { code: 'RATE_LIMITED', message: '请求过于频繁' } } }
  if (role === 'viewer' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return { status: 403, body: { error: { code: 'FORBIDDEN', message: 'viewer 只读' } } }
  }

  try {
    const out = await dispatch(db, method, path, body, role, bound)
    if (out?.zip) return { status: 200, body: { zip_base64: out.zip.toString('base64') } }
    return { status: 200, body: out }
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: { error: { code: e.code, message: e.message, details: e.details } } }
    return { status: 500, body: { error: { code: 'INTERNAL', message: String(e.message || e) } } }
  }
}

async function finishRoutes(db, out) {
  if (out && out.__queueProactive) {
    const { aid, manual } = out.__queueProactive
    try { return (await f.queueProactive(db, aid, { manual: !!manual })) || { queued: false } } catch (e) { return { queued: false, reason: String((e && e.message) || e) } }
  }
  return out
}

async function dispatch(db, method, path, body, role, bound) {
  const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
  const readOnlyPost = path.endsWith('/pack') || path.endsWith('/events/stream')
  const key = body.__idempotencyKey
  if (write && !readOnlyPost && !key) err(400, 'INVALID_ARGUMENT', '写命令必须带 Idempotency-Key')
  if (write && key) {
    const hash = crypto.createHash('sha256').update(JSON.stringify({ method, path, body })).digest('hex')
    const old = db.prepare('SELECT * FROM idempotency WHERE key=?').get(key)
    if (old) {
      if (old.body_hash !== hash) err(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键的请求体不同')
      if (Number(old.status) !== 200) err(409, 'IDEMPOTENCY_IN_PROGRESS', '同一幂等键正在处理')
      return JSON.parse(old.response)
    }
    try {
      db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run(key, hash, 0, '', now())
    } catch (e) {
      // 并发抢同一个 key：抢输的一方要么拿到已完成结果，要么明确告诉用户正在处理
      const again = db.prepare('SELECT * FROM idempotency WHERE key=?').get(key)
      if (again && again.body_hash !== hash) err(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键的请求体不同')
      if (again && Number(again.status) === 200) return JSON.parse(again.response)
      err(409, 'IDEMPOTENCY_IN_PROGRESS', '同一幂等键正在处理')
    }
    try {
      const out = await finishRoutes(db, await routes(db, method, path, body, role, bound))
      db.prepare('UPDATE idempotency SET status=200, response=? WHERE key=?').run(JSON.stringify(out), key)
      return out
    } catch (e) {
      db.prepare('DELETE FROM idempotency WHERE key=? AND status=0').run(key)
      throw e
    }
  }
  return finishRoutes(db, await routes(db, method, path, body, role, bound))
}

async function routes(db, method, path, body, role, bound) {
  if (path === '/health') {
    const v = db.prepare('SELECT version FROM schema_meta').get()
    const n = db.prepare('SELECT COUNT(*) n FROM agents').get()
    return { ok: true, schema_version: Number(v?.version || 0), mode: 'ok', agents: Number(n?.n || 0), model: c.modelStatus(), pending_agent: f.getFlag(db, 'pending_agent') }
  }
  // ---- 外部通道（QQ）：按会话绑定，不经过网页的 session/bindings ----
  if (method === 'POST' && path === '/v1/chat') {
    const conv = String(body.conversation_id || '').trim()
    if (!conv) err(400, 'INVALID_ARGUMENT', 'conversation_id 不能为空')
    const sp = body.speaker && typeof body.speaker === 'object' ? body.speaker : {}
    const channel = String(sp.channel || 'qq')
    const handle = String(sp.handle || '').trim()
    const got = cv.resolveOrBind(db, conv, { hint: String(body.default_agent || ''), channel, handle })
    if (!got.agent) err(404, 'NO_AGENT', '这段会话没有可用的意识体：' + (got.reason || 'unbound'))
    const out = await f.chatReply(db, got.agent.id, {
      text: body.text,
      conversation_id: conv,
      speaker: { channel, handle, name: String(sp.name || '') },
    })
    return { ...out, agent_id: got.agent.id, conversation_id: conv, bound_new: !!got.bound_new }
  }
  if (method === 'GET' && path.split('?')[0] === '/v1/conversations') {
    const only = q(path, 'agent_id') || null
    return { conversations: cv.listConversations(db, only, 50) }
  }
  if (method === 'POST' && path === '/v1/conversations/bind') {
    if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以改会话归属')
    const convId = String(body.conversation_id || '').trim()
    const agentId = String(body.agent_id || '').trim()
    if (!convId || !agentId) err(400, 'INVALID_ARGUMENT', 'conversation_id 和 agent_id 都要给')
    let target = null
    try { target = db.prepare('SELECT id, name, status FROM agents WHERE id=?').get(agentId) } catch { target = null }
    if (!target || target.status === 'soft_deleted') err(404, 'NOT_FOUND', '没有这个意识体：' + agentId)
    const row = cv.bindConversation(db, convId, agentId, {
      channel: String(body.channel || 'qq'),
      handle: String(body.handle || ''),
      source: 'user',
    })
    return { ...row, agent_name: target.name }
  }
  if (method === 'DELETE' && /^\/v1\/conversations\/[^/]+$/.test(path)) {
    if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以改会话归属')
    const id = decodeURIComponent(path.replace('/v1/conversations/', ''))
    return { conversation_id: id, released: cv.releaseConversation(db, id, 'user') }
  }
  if (method === 'GET' && path.split('?')[0] === '/v1/qq/health') {
    const h = await cv.probeBridge()
    let last = null
    try {
      last = db.prepare("SELECT conversation_id, handle, last_seen_at FROM conversations WHERE state='active' ORDER BY last_seen_at DESC LIMIT 1").get() || null
    } catch { last = null }
    return { ...h, last_conversation: last, owner: cv.ownerHandle(db), default_agent: cv.defaultAgentId(db) }
  }
  if (method === 'GET' && path === '/v1/qq/settings') {
    return { owner: cv.ownerHandle(db), default_agent: cv.defaultAgentId(db), prompt_budget: cv.promptBudget(db), history_turns: cv.historyTurns(db), recall_items: cv.recallItems(db), conversations: cv.listConversations(db, null, 20) }
  }
  if (method === 'PUT' && path === '/v1/qq/settings') {
    if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以改 QQ 通道设置')
    if (body.owner != null) cv.setOwnerHandle(db, body.owner)
    if (body.default_agent != null) cv.setDefaultAgentId(db, body.default_agent)
    if (body.prompt_budget != null) cv.setPromptBudget(db, body.prompt_budget)
    if (body.history_turns != null) cv.setHistoryTurns(db, body.history_turns)
    if (body.recall_items != null) cv.setRecallItems(db, body.recall_items)
    return { owner: cv.ownerHandle(db), default_agent: cv.defaultAgentId(db), prompt_budget: cv.promptBudget(db), history_turns: cv.historyTurns(db), recall_items: cv.recallItems(db) }
  }
  if (method === 'GET' && path.split('?')[0] === '/v1/agents') {
    const all = q(path, 'include_deleted') === '1'
    const sql = all ? 'SELECT * FROM agents' : "SELECT * FROM agents WHERE status!='soft_deleted'"
    const rows = db.prepare(sql).all().filter((a) => !bound || a.id === bound)
    // 多实例：每行带上「在场状态 / 挂着几段对话 / 要不要绑下一段新会话」
    const pending = bd.peekPending(db)
    const counts = new Map()
    try {
      for (const r of db.prepare("SELECT agent_id, COUNT(*) n FROM bindings WHERE state='bound' GROUP BY agent_id").all()) {
        counts.set(r.agent_id, Number(r.n))
      }
    } catch { /* 老库没有 bindings 列时保持 0 */ }
    return rows.map((a) => {
      let runtime_state = a.runtime_state || 'idle'
      try { runtime_state = bd.runtimeStateOf(db, a.id) } catch { /* 老库 */ }
      // 已 active 时列上的 offline 是暂停残留，不当真
      if (a.status === 'active' && runtime_state === 'offline') runtime_state = 'idle'
      return {
        ...a,
        runtime_state,
        bound_sessions: counts.get(a.id) || 0,
        pending_bind: pending === a.id,
      }
    })
  }
  if (method === 'POST' && path === '/v1/runtime/max-running') {
    if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以改并发上限')
    const n = Number(body.max_running)
    if (!Number.isFinite(n) || n < 0 || n > 20) err(400, 'INVALID_ARGUMENT', 'max_running 只能是 0~20（0 = 不限）')
    const out = bd.setMaxRunning(db, n)
    try { bd.refreshAll(db) } catch { /* 状态下次刷新会补 */ }
    return { max_running: out }
  }
  // 这段对话现在归谁：头牌（对话标题旁的身份牌）按会话查，不再全局找一个 active
  {
    const sm = path.split('?')[0].match(/^\/v1\/sessions\/([^/]+)\/agent$/)
    if (sm) {
      const sid = decodeURIComponent(sm[1])
      const brow = bd.bindingOf(db, sid)
      if (!brow) return { session_id: sid, agent: null, state: 'unbound' }
      const a = db.prepare('SELECT id,name,avatar,status FROM agents WHERE id=?').get(brow.agent_id)
      return {
        session_id: sid,
        state: a && a.status === 'paused' ? 'paused' : 'bound',
        agent: a ? { id: a.id, name: a.name, avatar: a.avatar || null } : null,
        since: brow.bound_at || brow.created_at,
      }
    }
  }
  if (method === 'GET' && path.split('?')[0] === '/v1/runtime') {
    // 运行总览：谁在跑、各有几段对话、心跳健康、并发余量。界面与排障共用这一份。
    const cap = bd.maxRunning(db)
    const running = bd.runningAgentIds(db)
    const agents = db.prepare("SELECT id,name,status,runtime_state,last_seen_at,last_heartbeat_at FROM agents WHERE status!='soft_deleted'").all()
    const hb = new Map()
    try {
      for (const r of db.prepare('SELECT * FROM heartbeats').all()) hb.set(r.agent_id, r)
    } catch { /* 心跳表未建时返回空 */ }
    return {
      max_running: cap, running: running.length, slots_left: cap > 0 ? Math.max(0, cap - running.length) : null,
      default_agent: bd.defaultAgent(db), pending_bind: bd.peekPending(db),
      agents: agents.map((a) => {
        const h = hb.get(a.id)
        return {
          id: a.id, name: a.name, status: a.status,
          runtime_state: bd.runtimeStateOf(db, a.id),
          bound_sessions: bd.bindingsOf(db, a.id).length,
          last_seen_at: a.last_seen_at, last_heartbeat_at: a.last_heartbeat_at,
          heartbeat: h ? { next_at: h.next_at, last_at: h.last_at, last_ms: h.last_ms, failures: h.failures, mode: h.mode } : null,
        }
      }),
    }
  }
  if (method === 'POST' && path === '/v1/agents') {
    const name = String(body.name || '新意识体').trim() || '新意识体'
    // 名字里已经有替换字符（U+FFFD），说明上游把 UTF-8 编坏了；宁可报错也别静默存成乱码
    if (name.includes('\uFFFD')) err(400, 'INVALID_ARGUMENT', '名字里有编码损坏的字符（�），请用 UTF-8 重新提交')
    const dup = db.prepare("SELECT id FROM agents WHERE name=? AND status!='soft_deleted'").get(name)
    if (dup) err(409, 'NAME_TAKEN', '已经有同名的意识体了')
    const aid = c.nid('agt_')
    db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(aid, name, 'daily', 'active', now())
    c.seedState(db, aid)
    f.seedRelations(db, aid)
    // 多实例：新建只是「活着 + 排给下一段新对话」，不抢走别人正在用的会话
    bd.setPending(db, aid)
    try { bd.refreshRuntime(db, aid) } catch { /* 在场状态下次刷新会补 */ }
    return { id: aid, status: 'active', pending: true }
  }
  if (method === 'POST' && path === '/v1/agents/import/freeform') return f.importFreeform(db, body)
  if (method === 'POST' && path === '/v1/agents/import') {
    let buf = null
    if (!body.encrypted) {
      buf = Buffer.from(String(body.zip_base64 || ''), 'base64')
      if (!buf.length) err(400, 'INVALID_ARGUMENT', '缺少 zip_base64')
    }
    let baseName = String(body.name || '').trim()
    if (!baseName && buf) {
      try {
        const files = unzipStore(buf)
        const ag = files['tables/agents.json'] ? JSON.parse(files['tables/agents.json'].toString('utf8')) : []
        baseName = (ag[0] && ag[0].name) || '导入的意识体'
      } catch { baseName = '导入的意识体' }
    }
    baseName = (baseName || '导入的意识体').slice(0, 40)
    let name = baseName
    let k = 1
    while (db.prepare("SELECT 1 FROM agents WHERE name=? AND status!='soft_deleted'").get(name)) {
      k++
      name = baseName + ' · 导入' + (k > 2 ? ' ' + (k - 1) : '')
    }
    const aid = c.nid('agt_')
    db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?, 'daily', 'active', ?, 1)").run(aid, name, now())
    c.seedState(db, aid)
    try {
      const out = f.importFull(db, aid, body)
      if (!out || !Number(out.imported)) {
        db.prepare('DELETE FROM agents WHERE id=?').run(aid)
        err(400, 'INVALID_ARGUMENT', '包里没有可导入的意识数据（结构不对或不是本插件的导出）')
      }
      db.prepare("UPDATE agents SET status='paused' WHERE id=?").run(aid)
      return { id: aid, name, ...out }
    } catch (e) {
      db.prepare('DELETE FROM agents WHERE id=?').run(aid)
      throw e
    }
  }
  if (method === 'GET' && path === '/v1/metrics/catalog') return c.METRICS.map(([key, label]) => ({ key, label }))
  if (method === 'GET' && path === '/v1/algos') return f.catalogAlgos()

  // ---- 关系域：人物账本（v2）。分类不是节点，人是节点；旧 /relations 暂留一版 ----
  const relUrl = path.split('?')[0]
  let pm = relUrl.match(/^\/v1\/agents\/([^/]+)\/persons$/)
  if (pm) {
    const aid = pm[1]
    scoped(bound, aid)
    R.bootstrap(db, aid)
    if (method === 'GET') {
      return R.listPersons(db, aid, { tier: q(path, 'tier'), status: q(path, 'status'), q: q(path, 'q') })
    }
    if (method === 'POST') return R.remember(db, aid, body, { source: 'ui' })
    err(405, 'METHOD_NOT_ALLOWED', '只支持 GET / POST')
  }
  pm = relUrl.match(/^\/v1\/agents\/([^/]+)\/persons\/resolve$/)
  if (pm) {
    scoped(bound, pm[1])
    R.bootstrap(db, pm[1])
    if (method !== 'GET') err(405, 'METHOD_NOT_ALLOWED', '认人只接受 GET')
    return R.resolve(db, pm[1], q(path, 'q') || q(path, 'query') || '', { context: q(path, 'context') || '' })
  }
  pm = relUrl.match(/^\/v1\/agents\/([^/]+)\/persons\/([^/]+)(?:\/(card|edges|axes))?$/)
  if (pm) {
    const aid = pm[1], pid = decodeURIComponent(pm[2]), act = pm[3]
    scoped(bound, aid)
    R.bootstrap(db, aid)
    if (method === 'GET' && act === 'card') {
      return { id: pid, card: R.cardText(db, aid, pid), person: R.publicPerson(db, aid, pid) }
    }
    if (method === 'GET' && act === 'axes') {
      return R.axesSeries(db, aid, pid, Number(q(path, 'days') || 30))
    }
    if (method === 'GET' && act === 'edges') {
      return R.personDetail(db, aid, pid).edges
    }
    if (method === 'GET' && !act) return R.personDetail(db, aid, pid)
    if (method === 'POST' && act === 'edges') return R.upsertEdgeApi(db, aid, { ...body, from_id: pid })
    err(405, 'METHOD_NOT_ALLOWED', '不支持的方法')
  }
  // 三观引擎：路由与开关判断都在 sangguan/api.js，这里只转发
  const sgm = relUrl.match(/^\/v1\/agents\/([^/]+)\/sangguan(\/.*)?$/)
  if (sgm) {
    scoped(bound, sgm[1])
    agent(db, sgm[1])
    return sg.route(db, sgm[1], method, sgm[2] || '/', new URL('http://x' + path).searchParams, body, role)
  }
  let m = path.split('?')[0].match(/^\/v1\/agents\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/)
  if (m) {
    const aid = m[1], sub = m[2], sub2 = m[3]
    scoped(bound, aid)
    if (method === 'GET' && !sub) return agent(db, aid)
    if (method === 'DELETE' && !sub) {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以删除意识体')
      return c.softDeleteAgent(db, aid)
    }
    if (method === 'POST' && sub === 'restore') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以恢复意识体')
      return c.restoreAgent(db, aid)
    }
    if (method === 'POST' && sub === 'activate') return f.activateAgent(db, aid, role)
    // 手动改绑：把某段对话交给这个意识体（超并发上限时排队，不踢别人）
    if (method === 'POST' && sub === 'bind') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以改绑会话')
      const sid = String(body.session_id || body.session || '').trim()
      if (!sid) err(400, 'INVALID_ARGUMENT', 'session_id 必填')
      const out = bd.bindSession(db, aid, sid, { source: 'manual' })
      if (!out.ok && out.queued) err(409, 'RUNNING_LIMIT', '同时在跑的实例已达上限（' + out.running + '）；先休眠一个再绑')
      if (!out.ok) err(404, 'NOT_FOUND', out.reason === 'no_agent' ? 'agent 不存在' : '绑定失败：' + out.reason)
      return out
    }
    // 解绑：带 session_id 只松那一段；不带就把这个实例的所有对话都松开
    if (method === 'POST' && sub === 'unbind') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以解绑会话')
      const sid = String(body.session_id || body.session || '').trim()
      if (sid) return { session_id: sid, released: bd.unbindSession(db, sid, 'user') }
      return { agent_id: aid, released: bd.unbindAgent(db, aid, 'user') }
    }
    if (method === 'GET' && sub === 'sessions') return { agent_id: aid, items: bd.bindingsOf(db, aid) }
    if (method === 'POST' && sub === 'browse' && sub2 === 'ingest') return br.ingestBrowse(db, aid, body)
    if (method === 'GET' && sub === 'browse' && sub2 === 'items') return br.listBrowse(db, aid, Number(q(path, 'limit') || 20))
    if (method === 'GET' && sub === 'chat') return f.listChat(db, aid, Number(q(path, 'limit') || 60))
    if (method === 'POST' && sub === 'chat') return f.chatReply(db, aid, body)
    if (method === 'PATCH' && !sub) {
      if (body.name !== undefined) {
        const nm = String(body.name).trim().slice(0, 40) || '新意识体'
        if (nm.includes('\uFFFD')) err(400, 'INVALID_ARGUMENT', '名字里有编码损坏的字符（�），请用 UTF-8 重新提交')
        const dup = db.prepare("SELECT id FROM agents WHERE name=? AND status!='soft_deleted' AND id!=?").get(nm, aid)
        if (dup) err(409, 'NAME_TAKEN', '已经有同名的意识体了')
        db.prepare('UPDATE agents SET name=? WHERE id=?').run(nm, aid)
      }
      if (body.mode !== undefined) {
        if (!['daily', 'work'].includes(body.mode)) err(400, 'INVALID_ARGUMENT', 'mode 只能是 daily / work')
        db.prepare('UPDATE agents SET mode=? WHERE id=?').run(body.mode, aid)
      }
      return agent(db, aid)
    }
    if (method === 'GET' && sub === 'avatar') {
      const r = db.prepare('SELECT avatar FROM agents WHERE id=?').get(aid)
      return { data: (r && r.avatar) || null }
    }
    if (method === 'PUT' && sub === 'avatar') {
      let v = String(body.data || '')
      if (!v) return db.prepare('UPDATE agents SET avatar=NULL WHERE id=?').run(aid), { cleared: true }
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(v)) err(400, 'INVALID_ARGUMENT', '只接受 png/jpeg/webp/gif 的 data URL')
      if (v.length > 400000) err(413, 'TOO_LARGE', '头像过大（压缩后需 ≤ 300KB）')
      db.prepare('UPDATE agents SET avatar=? WHERE id=?').run(v, aid)
      return { ok: true, bytes: v.length }
    }
    if (method === 'GET' && sub === 'memory' && sub2 === 'timeline') return sd.timeline(db, aid, { days: Number(q(path, 'days') || 14) })
    // G1：单条记忆的版本时间线（Mem0 式 history）
    {
      const hm = relUrl.match(/^\/v1\/agents\/([^/]+)\/memory\/([^/]+)\/history$/)
      if (hm && method === 'GET') {
        scoped(bound, hm[1])
        agent(db, hm[1])
        const h = asof.memoryHistory(db, hm[1], decodeURIComponent(hm[2]), { axis: q(path, 'axis') || undefined })
        return h || err(404, 'NOT_FOUND', '记忆不存在或已删除')
      }
    }
    // G1：「某天当时」查询 ?q=&at= 或 &from=&to=（或 q 里自带「去年三月」），axis 可选 said / recorded
    if (method === 'GET' && sub === 'memory' && sub2 === 'as-of') {
      const v = asof.retrieveAsOf(db, aid, String(q(path, 'q') || ''), {
        at: q(path, 'at') || undefined, from: q(path, 'from') || undefined, to: q(path, 'to') || undefined,
        axis: q(path, 'axis') || undefined, k: Number(q(path, 'k') || 6),
      })
      return { ...v, text: asof.renderAsOf(v) }
    }
    if (method === 'GET' && sub === 'memory' && sub2 === 'top') return sd.topMemory(db, aid, { limit: Number(q(path, 'limit') || 99) })
    // 抽样体检：拿现存自省过一遍「价值裁判」，看写入闸门会拦下多少（只读，不写库）
    if (method === 'GET' && sub === 'memory' && sub2 === 'judge') {
      return jg.judgeSample(db, aid, { limit: Number(q(path, 'limit') || 30), floor: Number(q(path, 'floor') || 0.7) })
    }
    if (method === 'GET' && sub === 'memory') return c.listMemory(db, aid, q(path, 'include_deleted') === '1')
    // 存量分级：把判得低的自省打成冷层（只动温度，不删不改内容）。dry_run=1 只统计。
    if (method === 'POST' && sub === 'memory' && sub2 === 'demote') {
      const dryRun = body.dryRun === true || body.dry_run === true || String(body.dry_run || '') === '1'
      return jg.demoteByJudge(db, aid, {
        limit: Number(body.limit) || 20,
        floor: Number(body.floor) || 0.7,
        cursor: body.cursor ? String(body.cursor) : null,
        dryRun,
      })
    }
    // 存量检索卡回填：在插件进程内跑宿主模型；一次 10 条，循环调用即可补完。
    if (method === 'POST' && sub === 'memory' && sub2 === 'enrich') return f.backfillCards(db, aid, body)
    // 存量记忆整理：让模型把重复的自省合并成一条。dryRun=1 只出方案、不落库。
    if (method === 'POST' && sub === 'memory' && sub2 === 'consolidate') {
      const dryRun = body.dryRun === true || body.dry_run === true || String(body.dry_run || '') === '1'
      return csl.consolidatePending(db, aid, {
        limit: Number(body.limit) || 3,
        minSim: body.minSim != null ? Number(body.minSim) : undefined,
        maxBatch: body.maxBatch != null ? Number(body.maxBatch) : undefined,
        dryRun,
      })
    }
    if (method === 'GET' && sub === 'memory' && sub2 === 'consolidate') {
      const batches = csl.planBatches(db, aid, { limit: Number(q(path, 'limit') || 10) })
      return { can: csl.canConsolidate(), batches: batches.map((b) => ({ size: b.length, ids: b.map((m) => m.id), texts: b.map((m) => String(m.text || '').slice(0, 80)) })) }
    }
    if (method === 'POST' && sub === 'memory') return c.addMemory(db, aid, { ...body, source: body.source || 'manual' })
    if (method === 'GET' && sub === 'turns' && sub2) return sd.turnDetail(db, aid, sub2) || err(404, 'NOT_FOUND', '这句原话找不到了')
    if (method === 'POST' && sub === 'pack') {
      const t = Date.now()
      const out = c.recall(db, aid, body.query || '')
      f.recordMetric(db, aid, 'sys.inject_latency', Date.now() - t)
      return out
    }
    if (method === 'GET' && sub === 'params') return c.paramsList(db, aid)
    if (method === 'PUT' && sub === 'params' && sub2) return c.setParam(db, aid, decodeURIComponent(sub2), body)
    if (method === 'GET' && sub === 'persona' && sub2 === 'selfview') {
      return sv.getSelfview(db, aid, { detail: q(path, 'detail') === '1' })
    }
    if (method === 'POST' && sub === 'persona' && sub2 === 'selfview') return sv.regenerate(db, aid)
    if (method === 'GET' && sub === 'persona' && sub2 === 'drift') return f.personaDrift(db, aid)
    // 五轴证据账本 + 自陈意图 + 手动交回经历
    if (method === 'GET' && sub === 'persona' && sub2 === 'evidence') return { axes: axe.snapshot(db, aid) }
    // 性格拔河：每根轴左右两个拉力池现在各有多少、谁领先、基线在哪
    if (method === 'GET' && sub === 'persona' && sub2 === 'rope') return { axes: rope.snapshot(db, aid), scan_at: rope.lastScanAt(db, aid) }
    // 手动扫一次（调试/界面按钮）：默认补最近 24 小时；hours=0 从上次扫到的地方接着补
    if (method === 'POST' && sub === 'persona' && sub2 === 'scan') {
      const hours = Number(body.hours)
      const out = Number.isFinite(hours) && hours > 0
        ? selfScan.scanRecent(db, aid, hours)
        : selfScan.scan(db, aid, {})
      return out
    }
    // 「交回经历」的另一半：把两池清零，但不碰慢值和基线
    if (method === 'POST' && sub === 'persona' && sub2 === 'rope') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以清池子')
      return rope.clearPools(db, aid, body.axis ? String(body.axis) : null)
    }
    // 第二判：词表拿不准的轮次，模型判、规则验；dryRun=1 只看不写
    if (method === 'GET' && sub === 'persona' && sub2 === 'judge') return personaJudge.stats(db, aid)
    if (method === 'POST' && sub === 'persona' && sub2 === 'judge') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以手动跑第二判')
      const out = await personaJudge.run(db, aid, { limit: Number(body.limit || 24), dryRun: body.dryRun === true })
      if (out && out.dryRun) out.preview = (out.preview || []).slice(0, 20)
      return out
    }
    // 人格锚：一行「你现在是什么样」，界面展示 / 宿主注入都用它
    if (method === 'GET' && sub === 'persona' && sub2 === 'anchor') return { line: anchorLine(db, aid) }
    // 每周情境探针：校准用，只落表不进池
    if (method === 'GET' && sub === 'persona' && sub2 === 'probe') return { weeks: personaProbe.recent(db, aid, Number(q(path, 'weeks') || 4)) }
    if (method === 'POST' && sub === 'persona' && sub2 === 'probe') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以手动跑探针')
      return personaProbe.run(db, aid, { force: body.force === true })
    }
    if (method === 'GET' && sub === 'persona' && sub2 === 'intent') {
      return { intents: AXIS_KEYS.map((k) => ({ axis: k, target: getAxisIntent(db, aid, k) })).filter((x) => x.target != null) }
    }
    if (method === 'PUT' && sub === 'persona' && sub2 === 'intent') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以设定意图')
      const key = String(body.key || body.axis || '')
      if (body.target == null) return clearAxisIntent(db, aid, key)
      return setAxisIntent(db, aid, key, Number(body.target), Number(body.days || 7))
    }
    if (method === 'POST' && sub === 'persona' && sub2 === 'axis') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以交回经历')
      return releaseAxis(db, aid, String(body.key || body.axis || ''), body.why || '交回经历')
    }
    if (method === 'GET' && sub === 'persona' && sub2 === 'axes') return c.personaAxes(db, aid)
    if (method === 'GET' && sub === 'persona') return c.getPersona(db, aid)
    if (method === 'PUT' && sub === 'persona' && sub2) return c.setPersona(db, aid, decodeURIComponent(sub2), body, role)
    if (method === 'GET' && sub === 'affect' && sub2 === 'poisons') return ps.getPoisons(db, aid)
    if (method === 'GET' && sub === 'affect' && sub2 === 'history') return f.affectHistory(db, aid, Number(q(path, 'days') || 7))
    if (method === 'GET' && sub === 'affect' && sub2 === 'trend') return f.affectTrend(db, aid, Number(q(path, 'days') || 7))
    if (method === 'GET' && sub === 'affect' && sub2 === 'radar') return f.affectRadar(db, aid)
    if (method === 'GET' && sub === 'affect' && sub2 === 'guess') return c.userGuess(db, aid, { limit: Number(q(path, 'limit') || 8) })
    if (method === 'POST' && sub === 'affect' && sub2 === 'feedback') return c.recordUserFeedback(db, aid, body)
    if (method === 'GET' && sub === 'affect' && sub2 === 'events') return c.affectGateEvents(db, aid, { days: Number(q(path, 'days') || 3), limit: Number(q(path, 'limit') || 40) })
    if (method === 'GET' && sub === 'affect' && sub2 === 'review') return f.reviewStats(db, aid, { days: Number(q(path, 'days') || 14) })
    if (method === 'GET' && sub === 'affect' && sub2 === 'triggers') return f.triggerStats(db, aid, { days: Number(q(path, 'days') || 30), min: Number(q(path, 'min') || 2) })
    if (method === 'GET' && sub === 'affect' && sub2 === 'fallback') return f.fallbackStats(db, aid, { days: Number(q(path, 'days') || 7) })
    if (method === 'GET' && sub === 'affect' && sub2 === 'episodes') return c.listEpisodes(db, aid)
    if (method === 'GET' && sub === 'affect') return c.getAffect(db, aid)
    if (method === 'POST' && sub === 'affect' && sub2 === 'appraise') return f.appraiseWithEdges(db, aid, body.text || '')
    if (method === 'POST' && sub === 'eval' && sub2 === 'identity-blind') return f.runIdentityBlind(db, aid)
    if (method === 'GET' && sub === 'eval' && sub2 === 'hard-gates') return f.runHardGates(db, aid)
    if (method === 'GET' && sub === 'eval' && sub2 === 'calibration') return f.suggestCalibration(db, aid)
    if (method === 'POST' && sub === 'eval' && sub2 === 'calibration') return f.applyCalibration(db, aid, body.keys, role)
    if (method === 'GET' && sub === 'edges') return f.getEdgeGraph(db, aid)
    if (method === 'POST' && sub === 'affect' && sub2 === 'decay') return c.decayAffect(db, aid, Number(body.hours || 24))
    if (method === 'POST' && sub === 'affect' && sub2 === 'rebuild-baseline') return c.rebuildBaselineAhead(db, aid)
    if (method === 'POST' && sub === 'affect' && sub2 === 'reestimate') {
      const a = c.getAffect(db, aid)
      db.prepare('UPDATE affect_state SET intensity=?, mood=?, updated_at=? WHERE agent_id=?')
        .run(Math.min(1, a.intensity + 0.1), Math.min(1, a.mood + 0.05), now(), aid)
      return { intensity: +Math.min(1, a.intensity + 0.1).toFixed(3), mood: +Math.min(1, a.mood + 0.05).toFixed(3) }
    }
    if (method === 'GET' && sub === 'relations' && sub2 === 'history') return f.relationHistory(db, aid, Number(q(path, 'limit') || 20))
    if (method === 'POST' && sub === 'model' && sub2 === 'probe') return f.probeAppraise(db, aid, body.text, body.formula || 'v1', body.context || '')
    if (method === 'POST' && sub === 'proactive' && sub2 === 'queue') return { __queueProactive: { aid, manual: true } }
    if (method === 'POST' && sub === 'knowledge') return c.draftFromKnowledge(db, aid, body)
    if (method === 'GET' && sub === 'drivers') return f.driverFindings(db, aid)
    if (method === 'GET' && sub === 'targets') return f.targetProgress(db, aid)
    if (method === 'GET' && sub === 'drafts') return c.listDrafts(db, aid)
    if (method === 'POST' && sub === 'drafts') return f.draftsWithSuggestion(db, aid)
    if (method === 'POST' && sub === 'proposals' && sub2 === 'read') {
      const ready = db.prepare("SELECT id FROM proposals WHERE agent_id=? AND state='shadowed' AND shadow_done>=shadow_total").all(aid).map((r) => r.id)
      db.prepare('INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('proposal.seen:' + aid, JSON.stringify(ready))
      return { ok: true, read_at: now(), seen: ready.length }
    }
    if (method === 'GET' && sub === 'learning') return f.getLearningPrefs(db, aid)
    if (method === 'PUT' && sub === 'learning') return f.setLearningPrefs(db, aid, body)
    if (method === 'GET' && sub === 'proactive' && sub2 === 'settings') return f.getProactivePrefs(db, aid)
    if (method === 'GET' && sub === 'proactive' && sub2 === 'why') {
      return { ...f.proactiveDecision(db, aid, {}), last: f.lastProactiveDecision(db, aid) }
    }
    if (method === 'GET' && sub === 'proactive' && sub2 === 'decisions') return f.listProactiveDecisions(db, aid, Number(q(path, 'limit') || 20))
    if (method === 'GET' && sub === 'proactive' && sub2 === 'stats') return f.proactiveStats(db, aid)
    if (method === 'PUT' && sub === 'proactive' && sub2 === 'settings') return f.setProactivePrefs(db, aid, body)
    if (method === 'GET' && sub === 'proactive') return f.listProactive(db, aid)
    if (method === 'POST' && sub === 'proactive' && sub2) return f.ackProactive(db, aid, sub2)
    if (method === 'GET' && sub === 'blind') return f.startBlind(db, aid)
    if (method === 'POST' && sub === 'blind' && sub2) return f.scoreBlind(db, aid, sub2, body.answers)
    if (method === 'GET' && sub === 'legitimacy') return c.legitimacy(db, aid)
    // ---- 分层记忆：T4 原文 / 事实存根 / T2 纪要 / T3 日记 / 热度账本 ----
    if (method === 'GET' && sub === 'retrieve') {
      const lambda = Number(getParam(db, aid, 'memory.decay.lambda')) || 0.02
      const out = rt.retrieve(db, aid, q(path, 'q') || '', {
        k: Number(q(path, 'k') || 8),
        scene: q(path, 'scene') || undefined,
        // 与每轮注入同一条口径：遗忘阈值 / 衰减也作用在 v3 检索上
        floor: Number(getParam(db, aid, 'memory.recall.floor')) || 0,
        decayVersion: String(getParam(db, aid, 'memory.decay.formula') || 'v1'),
        decayScale: Math.max(0.1, Math.min(10, 0.02 / lambda)),
        summaryInjected: String(getParam(db, aid, 'memory.inject.user_summary') || 'off') === 'on',
        selfQuota: Number(getParam(db, aid, 'memory.inject.self_quota')) || 0,
        selfFreshBoost: Number(getParam(db, aid, 'memory.inject.self_fresh')) || 0,
      })
      if (q(path, 'pack') === '1') out.packed = pk.packInjection({ buffer: out.buffer, items: out.items })
      return out
    }
    if (method === 'GET' && sub === 'retrieval-log') {
      return {
        items: rl.listRetrievalLog(db, aid, { limit: Number(q(path, 'limit') || 30), days: Number(q(path, 'days') || 7), scene: q(path, 'scene') }),
      }
    }
    if (method === 'GET' && sub === 'retrieval-stats') return rl.retrievalStats(db, aid, Number(q(path, 'days') || 7))
    // ---- P2 写入侧：实体 / 抽取队列 ----
    if (method === 'GET' && sub === 'entities') {
      if (sub2) return { entity: sub2, items: en.factsOfEntity(db, aid, sub2, Number(q(path, 'limit') || 20)) }
      return { items: en.listEntities(db, aid, Number(q(path, 'limit') || 50)) }
    }
    if (method === 'GET' && sub === 'extract-queue') return ex.queueStats(db, aid)
    if (method === 'POST' && sub === 'extract-queue' && sub2 === 'retry') return { retried: ex.retryFailed(db, aid) }
    if (method === 'GET' && sub === 'archive' && sub2 === 'facts') {
      const query = q(path, 'q')
      return {
        items: query
          ? ar.searchFactArchive(db, aid, query, Number(q(path, 'k') || 8))
          : ar.listFactArchive(db, aid, { limit: Number(q(path, 'limit') || 50), offset: Number(q(path, 'offset') || 0) }),
        mode: query ? 'search' : 'timeline',
      }
    }
    if (method === 'GET' && sub === 'archive') {
      const query = q(path, 'q')
      if (query) return { items: ar.searchRaw(db, aid, query, Number(q(path, 'k') || 8)), mode: 'search' }
      return {
        items: ar.listRaw(db, aid, { day: q(path, 'day'), session: q(path, 'session'), limit: q(path, 'limit'), offset: q(path, 'offset') }),
        mode: 'timeline',
      }
    }
    if (method === 'GET' && sub === 'sessions') return ar.listSessions(db, aid, Number(q(path, 'limit') || 50))
    if (method === 'GET' && sub === 'episodes') return ar.listEpisodes(db, aid, { day: q(path, 'day'), limit: Number(q(path, 'limit') || 30) })
    if (method === 'GET' && sub === 'diaries' && sub2) {
      const row = ar.getDiary(db, aid, sub2)
      if (row) return row
      // 没写成不是 404：把待补状态带回去，面板才能说「等模型回来补」。
      const pend = diary.pendingForDay(db, aid, sub2)
      if (pend) return { day: sub2, text: '', source: 'none', pending: true, attempts: Number(pend.attempts || 0), fail_reason: pend.last_error || null }
      return err(404, 'NOT_FOUND', '这一天没有日记')
    }
    if (method === 'GET' && sub === 'diary' && sub2 === 'pending') return { items: diary.listPending(db, aid, { days: Number(q(path, 'days') || 30) }) }
    if (method === 'POST' && sub === 'diaries' && sub2 === 'rewrite') {
      const day = String(body.day || '').trim()
      if (!day) return err(400, 'INVALID_ARGUMENT', '缺少 day')
      let chat = null
      try {
        if (kernelModel.status().primary === 'ok') {
          chat = (messages, opt = {}) => kernelModel.chatPrimary(messages, opt.maxTokens ?? 900, !!opt.json, opt.temperature ?? 0.8)
        }
      } catch { chat = null }
      const out = await ar.buildDiary(db, aid, day, { force: true, chat })
      if (!out) return err(404, 'NOT_FOUND', '这一天没有可用的日记材料')
      return out
    }
    if (method === 'GET' && sub === 'tiers') return tierStats(db, aid)
    if (method === 'POST' && sub === 'tiers' && sub2 === 'refresh') return refreshHeat(db, aid)
    if (method === 'GET' && sub === 'diary') return f.diary(db, aid, Number(q(path, 'days') || 7))
    if (method === 'GET' && sub === 'metrics' && sub2 === 'history') return f.metricsHistory(db, aid, Number(q(path, 'days') || 30), q(path, 'keys'))
    // Shadow 观测：只读聚合；给页面 / curl / CLI 一个入口。
    if (method === 'GET' && sub === 'shadow') return res.shadowReport(db, aid, { days: Number(q(path, 'days') || 7) })
    if (method === 'GET' && sub === 'drive') return c.getDrive(db, aid)
    if (method === 'POST' && sub === 'drive' && sub2 === 'evaluate') return c.evaluateDrive(db, aid)
    if (method === 'POST' && sub === 'drive' && sub2 === 'satisfy') {
      return c.applySatisfaction(db, aid, body, { skipDecay: body.skipDecay !== false })
    }
    if (method === 'GET' && sub === 'action-ports') return c.listPorts(db, aid)
    if (method === 'PUT' && sub === 'action-ports' && sub2) return c.setPort(db, aid, sub2, body, role)
    // ---- 行动层：通道配置 / 体检 / 测试发送 / 研究 ----
    if (method === 'GET' && sub === 'action-config') return act.getConfig(db, aid)
    if (method === 'PUT' && sub === 'action-config') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以改行动通道配置')
      return act.saveConfig(db, aid, body)
    }
    if (method === 'GET' && sub === 'action-status') {
      return await act.channelStatus(db, aid, { fresh: q(path, 'fresh') === '1' })
    }
    if (method === 'POST' && sub === 'actions' && sub2 === 'test') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以测试通道')
      return await act.testChannel(db, aid, body)
    }
    // ---- 写评论 ----
    if (method === 'POST' && sub === 'comments') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以发评论')
      return await act.executeComment(db, aid, body)
    }
    if (method === 'GET' && sub === 'research' && sub2) {
      const run = act.getRun(db, aid, decodeURIComponent(sub2))
      if (!run) err(404, 'NOT_FOUND', '没有这次研究')
      return run
    }
    if (method === 'GET' && sub === 'research') {
      return { items: act.listRuns(db, aid, Number(q(path, 'limit') || 20)) }
    }
    if (method === 'POST' && sub === 'research') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以直接跑研究；模型请用 act_research 工具')
      return await act.executeResearch(db, aid, body, act.currentDeps())
    }
    if (method === 'POST' && sub === 'tokens' && sub2 === 'refill') return c.refillTokens(db, aid)
    if (method === 'POST' && sub === 'tokens' && sub2 === 'consume') return c.consumeToken(db, aid, body.class)
    if (method === 'GET' && sub === 'proposals') return c.listProposals(db, aid)
    if (method === 'POST' && sub === 'proposals') return c.createProposal(db, aid, body)
    if (method === 'GET' && sub === 'inbox') return c.inbox(db, aid)
    if (method === 'GET' && sub === 'changes') return c.listChanges(db, aid)
    if (method === 'GET' && sub === 'overview') return c.overview(db, aid)
    if (method === 'GET' && sub === 'thoughts') return th.getThoughts(db, aid)
    if (method === 'GET' && sub === 'vault' && !sub2) {
      return vt.warehouse(db, aid, { budget: Number(getParam(db, aid, 'memory.inject.budget')) || undefined })
    }
    if (method === 'GET' && sub === 'vault' && sub2 === 'history') return vt.history(db, aid, { days: Number(q(path, 'days')) || 365 })
    if (method === 'GET' && sub === 'vault' && sub2 === 'root') return { root: vt.getDocsRoot(db), v: vt.VAULT_VER }
    if (method === 'POST' && sub === 'vault' && sub2 === 'root') {
      try { return { root: vt.setDocsRoot(db, body.path) } }
      catch (e) { return err(400, 'INVALID_ARGUMENT', String((e && e.message) || e)) }
    }
    if (method === 'POST' && sub === 'vault' && sub2 === 'export') return vt.exportDocs(db, aid, { root: body.root || vt.getDocsRoot(db) })
    if (method === 'POST' && sub === 'vault' && sub2 === 'open') return vt.openFolder(body.path, { root: body.root || vt.getDocsRoot(db) })
    if (method === 'GET' && sub === 'temps') return { stats: tp.tempStats(db, aid) }
    if (method === 'POST' && sub === 'temps' && sub2 === 'tick') return { moved: tp.tickTemps(db, aid) }
    if (method === 'GET' && sub === 'consolidation') return { items: ni.consolidationLog(db, aid, Number(q(path, 'days') || 14)), last: ni.lastConsolidation(db, aid) }
    if (method === 'POST' && sub === 'consolidation' && sub2 === 'run') {
      let summarize = null
      try { if (c.model.status().primary === 'ok') summarize = (t) => c.model.summarize(t) } catch { summarize = null }
      const out = await ni.runNightly(db, aid, { day: body.day || undefined, force: body.force === true, summarize })
      // 顺手长一次偏好：巩固完记忆，正好有新鲜材料可以长出「喜欢/讨厌」
      if (body.grow !== false) {
        try {
          const g = await f.autoGrowPreferences(db, aid)
          out.steps = (out.steps || []).concat([{ step: 'preferences', ok: true, added: g.added.length, reason: g.reason }])
          out.grown = g.added
        } catch (e) {
          out.steps = (out.steps || []).concat([{ step: 'preferences', ok: false, error: String((e && e.message) || e) }])
        }
      }
      return out
    }
    if (method === 'GET' && sub === 'conflicts' && sub2 === 'stats') return cf.conflictStats(db, aid)
    if (method === 'GET' && sub === 'conflicts' && sub2) {
      const detail = cf.conflictDetail(db, aid, sub2)
      return detail || err(404, 'NOT_FOUND', '冲突不存在')
    }
    if (method === 'POST' && sub === 'conflicts' && sub2 === 'escalate') {
      return cf.escalateConflict(db, aid, String(body.id || ''), body) || err(404, 'NOT_FOUND', '冲突不存在')
    }
    if (method === 'POST' && sub === 'conflicts' && sub2) return c.resolveConflict(db, aid, sub2, body)
    if (method === 'GET' && sub === 'conflicts') return c.listConflicts(db, aid)
    if (method === 'GET' && sub === 'relations' && sub2 === 'health') {
      R.bootstrap(db, aid)
      return R.health(db, aid)
    }
    if (method === 'GET' && sub === 'relations' && sub2 === 'review') return { items: R.listReview(db, aid) }
    if (method === 'GET' && sub === 'relations' && sub2 === 'events') {
      R.bootstrap(db, aid)
      return { items: R.listEvents(db, aid, Number(q(path, 'limit') || 20)) }
    }
    if (method === 'POST' && sub === 'relations' && sub2 === 'tick') return R.tick(db, aid, body)
    if (method === 'GET' && sub === 'mentions') {
      R.bootstrap(db, aid)
      return { items: R.listMentions(db, aid, { state: q(path, 'state') || undefined }) }
    }
    if (method === 'GET' && sub === 'relations') return f.listRelations(db, aid)
    if (method === 'POST' && sub === 'relations') return f.upsertRelation(db, aid, body)
    if (method === 'GET' && sub === 'values' && sub2 === 'explain') return { ...explainValues(db, aid), source: 'engine' }
    if (method === 'POST' && sub === 'values' && sub2 === 'grow') return { ok: true, retired: true, reason: '旧十维表已下线；价值观从三观命题折算' }
    if (method === 'GET' && sub === 'values') return readViews(db, aid, { only: 'V' }).V.items
    if (method === 'GET' && sub === 'worldview' && sub2 === 'explain') return { ...wv.explainWorldview(db, aid), source: 'meter' }
    if (method === 'POST' && sub === 'worldview' && sub2 === 'grow') return wv.growWorldview(db, aid, { force: true })
    if (method === 'GET' && sub === 'worldview') return readViews(db, aid, { grow: true, only: 'W' }).W.items
    if (method === 'GET' && sub === 'lifeview' && sub2 === 'explain') return { ...lv.explainLifeview(db, aid), source: 'meter' }
    if (method === 'POST' && sub === 'lifeview' && sub2 === 'grow') return lv.growLifeview(db, aid, { force: true })
    if (method === 'GET' && sub === 'lifeview') return readViews(db, aid, { grow: true, only: 'L' }).L.items
    if (method === 'PUT' && sub === 'values') return f.setValue(db, aid, body)
    // 必须排在通用 POST /preferences 之前：子路径也要先匹配
    if (method === 'POST' && sub === 'preferences' && sub2 === 'grow') return f.growPreferences(db, aid, body)
    if (method === 'DELETE' && sub === 'preferences' && sub2) return f.removePreference(db, aid, sub2)
    if (method === 'GET' && sub === 'preferences') return f.listPreferences(db, aid)
    // 界面点出来的永远是手写：origin 由服务端定，不给客户端留改的口子
    if (method === 'POST' && sub === 'preferences') return f.addPreference(db, aid, { ...body, origin: 'manual' })
    if (method === 'GET' && sub === 'taboos') return f.listTaboos(db, aid)
    if (method === 'POST' && sub === 'taboos') return f.addTaboo(db, aid, body)
    if (method === 'GET' && sub === 'persona' && sub2 === 'drift') return f.personaDrift(db, aid)
    if (method === 'GET' && sub === 'affect' && sub2 === 'poisons') return ps.getPoisons(db, aid)
    if (method === 'GET' && sub === 'affect' && sub2 === 'history') return f.affectHistory(db, aid, Number(q(path, 'days') || 7))
    if (method === 'GET' && sub === 'affect' && sub2 === 'trend') return f.affectTrend(db, aid, Number(q(path, 'days') || 7))
    if (method === 'GET' && sub === 'affect' && sub2 === 'events') return c.affectGateEvents(db, aid, { days: Number(q(path, 'days') || 3), limit: Number(q(path, 'limit') || 40) })
    if (method === 'GET' && sub === 'affect' && sub2 === 'review') return f.reviewStats(db, aid, { days: Number(q(path, 'days') || 14) })
    if (method === 'GET' && sub === 'affect' && sub2 === 'triggers') return f.triggerStats(db, aid, { days: Number(q(path, 'days') || 30), min: Number(q(path, 'min') || 2) })
    if (method === 'GET' && sub === 'affect' && sub2 === 'fallback') return f.fallbackStats(db, aid, { days: Number(q(path, 'days') || 7) })
    if (method === 'GET' && sub === 'condition') return f.getCondition(db, aid)
    if (method === 'PUT' && sub === 'condition') return f.setCondition(db, aid, body)
    if (method === 'GET' && sub === 'cooldowns') return f.listCooldowns(db, aid)
    if (method === 'GET' && sub === 'budget') return f.budgetGet(db, aid)
    if (method === 'PUT' && sub === 'budget') return f.budgetSet(db, aid, body)
    if (method === 'GET' && sub === 'rules') return f.listRules(db, aid)
    if (method === 'POST' && sub === 'rules') return f.saveRuleVersion(db, aid, body.note || '')
    if (method === 'GET' && sub === 'algo-bindings') return f.listAlgoBindings(db, aid)
    if (method === 'PUT' && sub === 'algo-bindings' && sub2) return f.patchAlgoBinding(db, aid, decodeURIComponent(sub2), body, role)
    if (method === 'GET' && sub === 'bindings') return c.listBindings(db, aid)
    if (method === 'GET' && sub === 'artifacts') return c.listArtifacts(db, aid, q(path, 'kind') || null)
    if (method === 'GET' && sub === 'actions') return f.listActions(db, aid)
    if (method === 'POST' && sub === 'actions') return f.executeAction(db, aid, body)
    if (method === 'POST' && sub === 'ingest') return f.ingest(db, aid, body)
    if (method === 'POST' && sub === 'metrics' && sub2 === 'sample') return f.sampleMetrics(db, aid)
    if (method === 'GET' && sub === 'export' && sub2 === 'full') return f.exportFull(db, aid)
    if (method === 'POST' && sub === 'import' && sub2 === 'full') return f.importFull(db, aid, body)
    // 记忆仓库：只导出 / 导入记忆那几张表；随意文本交给模型整理成记忆
    if (method === 'GET' && sub === 'export' && sub2 === 'memory') return f.exportMemory(db, aid)
    if (method === 'POST' && sub === 'import' && sub2 === 'memory') return f.importMemory(db, aid, body)
    if (method === 'POST' && sub === 'import' && sub2 === 'loose') return f.importLooseMemory(db, aid, body)
    if (method === 'GET' && sub === 'metrics') {
      const vals = f.computeMetrics(db, aid)
      return Object.fromEntries(c.METRICS.map(([k, label]) => [k, { value: vals[k] ?? null, label }]))
    }
    if (method === 'POST' && sub === 'pause') {
      // 只改用户意图；绑定保留（唤醒后接着用原来那几段对话）
      db.prepare("UPDATE agents SET status='paused' WHERE id=?").run(aid)
      try { bd.refreshRuntime(db, aid) } catch { /* 在场状态下次刷新会补 */ }
      return { id: aid, status: 'paused', runtime_state: 'offline', bound_sessions: bd.bindingsOf(db, aid).length }
    }
    if (method === 'POST' && sub === 'resume') {
      db.prepare("UPDATE agents SET status='active' WHERE id=?").run(aid)
      try { bd.refreshRuntime(db, aid) } catch { /* 在场状态下次刷新会补 */ }
      return { id: aid, status: 'active', runtime_state: bd.runtimeStateOf(db, aid), bound_sessions: bd.bindingsOf(db, aid).length }
    }
    // /export 与 /export/full 同为全量；旧「仅记忆」schema_version 1 仍可导入
    if (method === 'GET' && sub === 'export') return f.exportFull(db, aid)
    if (method === 'POST' && sub === 'import') {
      if (body.encrypted || [6, 7, 8, 9, 10, 11].includes(Number(body.schema))) return f.importFull(db, aid, body)
      try {
        const buf = Buffer.from(body.zip_base64 || '', 'base64')
        const files = unzipStore(buf)
        const manifest = JSON.parse(files['manifest.json'].toString('utf8'))
        const ver = Number(manifest.schema ?? manifest.schema_version)
        // 全量包（schema 6+ 或带 tables/）走 importFull；旧 schema_version 1 记忆包走 importZip
        if ([6, 7, 8, 9, 10, 11].includes(ver) || Object.keys(files).some((k) => k.startsWith('tables/'))) {
          return f.importFull(db, aid, body)
        }
        return c.importZip(db, aid, buf)
      } catch {
        const buf = Buffer.from(body.zip_base64 || '', 'base64')
        return c.importZip(db, aid, buf)
      }
    }
  }

  // ---- 人物 / 边 / 提及（全局资源；归属按行反查） ----
  m = path.match(/^\/v1\/persons\/([^/]+)(?:\/(promote|merge|rename))?$/)
  if (m) {
    const pid = decodeURIComponent(m[1]), act = m[2]
    const row = db.prepare('SELECT agent_id FROM rel_person WHERE id=?').get(pid)
    if (!row) err(404, 'NOT_FOUND', '人物不存在')
    scoped(bound, row.agent_id)
    if (method === 'DELETE' && !act) {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以删除人物')
      return R.removePerson(db, row.agent_id, pid)
    }
    if (method === 'POST' && act === 'promote') return R.promotePerson(db, row.agent_id, pid)
    if (method === 'POST' && act === 'rename') {
      if (!body || !body.name) err(400, 'INVALID_ARGUMENT', 'name 必填')
      return R.renamePerson(db, row.agent_id, pid, body.name)
    }
    if (method === 'POST' && act === 'merge') {
      if (!body.into_id) err(400, 'INVALID_ARGUMENT', 'into_id 必填')
      return R.mergePersons(db, row.agent_id, pid, body.into_id)
    }
    err(405, 'METHOD_NOT_ALLOWED', '不支持的方法')
  }

  m = path.match(/^\/v1\/edges\/([^/]+)$/)
  if (m && method === 'DELETE') {
    const eid = decodeURIComponent(m[1])
    const row = db.prepare('SELECT agent_id FROM rel_edge WHERE id=?').get(eid)
    if (!row) err(404, 'NOT_FOUND', '关系边不存在')
    scoped(bound, row.agent_id)
    return R.invalidateEdge(db, row.agent_id, eid)
  }

  m = path.match(/^\/v1\/mentions\/([^/]+)\/(link|ignore)$/)
  if (m && method === 'POST') {
    const mid = decodeURIComponent(m[1])
    const row = db.prepare('SELECT agent_id FROM rel_mention WHERE id=?').get(mid)
    if (!row) err(404, 'NOT_FOUND', '提及不存在')
    scoped(bound, row.agent_id)
    return R.linkMentionApi(db, row.agent_id, mid, m[2] === 'link' ? body.person_id : null)
  }

  m = path.match(/^\/v1\/relations\/([^/]+)$/)
  if (m) {
    if (method === 'DELETE') {
      if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以删除关系')
      return f.deleteRelation(db, m[1])
    }
    if (method === 'PUT') {
      const old = db.prepare('SELECT * FROM relations WHERE id=?').get(m[1])
      if (!old) err(404, 'NOT_FOUND', '关系不存在')
      return f.upsertRelation(db, old.agent_id, { ...body, id: m[1] })
    }
  }

  m = path.match(/^\/v1\/agents\/([^/]+)\/bindings\/([^/]+)\/(activate|restore-v0)$/)
  if (m && method === 'POST') {
    const aid = m[1], kind = decodeURIComponent(m[2]), action = m[3]
    scoped(bound, aid)
    if (action === 'restore-v0') return c.restoreV0(db, aid, kind)
    if (!body.artifact_id) err(400, 'INVALID_ARGUMENT', 'artifact_id 必填')
    return c.activateBinding(db, aid, kind, body.artifact_id)
  }

  m = path.match(/^\/v1\/agents\/([^/]+)\/artifacts\/([^/]+)\/pin$/)
  if (m && method === 'POST') {
    const aid = m[1], artId = decodeURIComponent(m[2])
    scoped(bound, aid)
    return c.pinArtifact(db, aid, artId)
  }

  m = path.match(/^\/v1\/rules\/([^/]+)\/activate$/)
  if (m && method === 'POST') {
    const row = db.prepare('SELECT agent_id FROM rule_versions WHERE id=?').get(m[1])
    if (!row) err(404, 'NOT_FOUND', '版本不存在')
    scoped(bound, row.agent_id)
    return f.activateRuleVersion(db, row.agent_id, m[1])
  }

  m = path.match(/^\/v1\/memory\/([^/]+)(?:\/(restore))?$/)
  if (m) {
    ownerOf(db, 'memory_items', m[1], bound)
    if (method === 'PATCH') return c.setMemoryMark(db, m[1], body)
    if (method === 'DELETE') return c.softDelete(db, m[1])
    if (method === 'POST' && m[2] === 'restore') return c.restoreMemory(db, m[1])
  }

  m = path.match(/^\/v1\/proposals\/([^/]+)(?:\/(approve|reject|shadow|promote))?$/)
  if (m) {
    ownerOf(db, 'proposals', m[1], bound)
    if (method === 'GET') return c.getProposal(db, m[1])
    if (method === 'POST' && m[2] === 'approve') return tx(db, () => c.approve(db, m[1], role))
    if (method === 'POST' && m[2] === 'reject') return c.reject(db, m[1], body, role)
    if (method === 'POST' && m[2] === 'shadow') return c.shadowTick(db, m[1])
    if (method === 'POST' && m[2] === 'promote') { ownerOf(db, 'proposals', m[1], bound); return c.promoteDraft(db, ownerOf(db, 'proposals', m[1], bound), m[1], body) }
  }

  m = path.match(/^\/v1\/agents\/([^/]+)\/life(?:\/(tick))?$/)
  if (m) {
    const aid = m[1]
    scoped(bound, aid)
    if (method === 'GET') return { line: lifeLine(db, aid), enabled: true }
    // 手动让她去过一次日子：只走「想一想」，不联网，不碰发消息端口。
    if (method === 'POST' && m[2] === 'tick') return lifeTick(db, aid, { model: kernelModel, force: !!body.force })
  }

  m = path.match(/^\/v1\/agents\/([^/]+)\/author(?:\/(rollback))?$/)
  if (m) {
    const aid = m[1]
    scoped(bound, aid)
    if (method === 'GET') return au.authorStats(db, aid)
    if (method === 'POST' && !m[2]) return au.authorChange(db, aid, body)
    if (method === 'POST' && m[2] === 'rollback') {
      if (!body.change_id) err(400, 'INVALID_ARGUMENT', 'change_id 必填')
      return au.rollbackAuthor(db, aid, body.change_id)
    }
  }

  m = path.match(/^\/v1\/changes\/([^/]+)\/rollback$/)
  if (m && method === 'POST') { ownerOf(db, 'changes', m[1], bound); return c.rollbackChange(db, m[1], role) }

  m = path.match(/^\/v1\/conflicts\/([^/]+)\/resolve$/)
  if (m && method === 'POST') {
    ownerOf(db, 'conflicts', m[1], bound)
    const cf = db.prepare('SELECT agent_id FROM conflicts WHERE id=?').get(m[1])
    if (!cf) err(404, 'NOT_FOUND', '冲突不存在')
    const keep = body.keep || (body.resolution === 'new' ? 'b' : body.resolution === 'context' ? 'both' : 'a')
    return c.resolveConflict(db, cf.agent_id, m[1], { keep })
  }

  if (path === '/v1/inbox/bulk' && method === 'POST') return c.inboxBulk(db, body)
  if (path === '/v1/maintenance/settle' && method === 'POST') {
    if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以结算')
    return tx(db, () => c.settleObservations(db))
  }
  if (path === '/v1/catalog' && method === 'GET') return f.catalog()
  if (method === 'GET' && path.split('?')[0] === '/v1/taxonomy') {
    const want = q(path, 'agent_id') || (db.prepare("SELECT id FROM agents WHERE status='active' LIMIT 1").get() || {}).id
    if (!want) err(400, 'INVALID_ARGUMENT', '没有 active 意识体')
    return f.taxonomyInfo(db, want)
  }
  if (path === '/v1/maintenance/backup-drill' && method === 'GET') return f.backupDrill()
  if (path === '/v1/maintenance/purge' && method === 'POST') {
    if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以清理')
    return c.purgeExpired(db)
  }
  if (method === 'GET' && path.split('?')[0].startsWith('/v1/agents/') && path.split('?')[0].endsWith('/events/stream')) {
    const aid = path.split('?')[0].split('/')[3]
    scoped(bound, aid)
    return f.eventsSince(db, aid, q(path, 'last'))
  }
  // 没匹配上：把路径记到文件里，下次「接口不存在」不用猜是谁在调
  try {
    const line = new Date().toISOString() + '\t' + method + '\t' + path + '\n'
    fs.appendFileSync(path.join(os.homedir(), '.dsh', 'consciousness', 'api-404.log'), line)
  } catch { /* 记日志失败不影响报错 */ }
  err(404, 'NOT_FOUND', '接口不存在：' + method + ' ' + path.split('?')[0])
}
