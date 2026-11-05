/**
 * QQ 接线看板 · 只读数据源。
 *
 * 回答一个问题：桥接每次重启会换一个新的 sessionId，新会话有没有接回原来的意识体？
 * 没接上 = 那段聊天的记忆链是断的（不召回、人格段也少一截）。
 *
 * 这里只读库和桥接的运行文件：不写库、不发消息、不改任何状态。
 * 页面渲染在 client.js（设置 → QQ 通道 → 接线），HTTP 口是 GET /v1/qq/watch。
 */
import fs from 'node:fs'
import os from 'node:os'
import { bindingOf } from './binding.js'
import { parseChatKey, chatKeyOfSessionId, conversationIdOf, loadSessionMap } from './qq_bridge.js'

/** DSH 的家目录（和 api.js 同一口径）。 */
export function dshHome() {
  return process.env.DSH_HOME || (os.homedir() + '/.dsh')
}

/**
 * 找桥接插件的会话映射表（qq-sessions.json）。
 * 桥接默认把它写在自己的工作目录（~/.dsh/qq-bridge/），也兼容当前目录和库目录。
 * 找不到返回空串，调用方退化成「只认映射表为空」。
 */
export function findQQSessionsFile() {
  const home = dshHome()
  const candidates = []
  try { candidates.push(process.cwd() + '/qq-sessions.json') } catch { /* ignore */ }
  try { candidates.push(home + '/consciousness/qq-sessions.json') } catch { /* ignore */ }
  try { candidates.push(home + '/qq-bridge/qq-sessions.json') } catch { /* ignore */ }
  for (const f of candidates) {
    try { if (fs.existsSync(f)) return f } catch { /* ignore */ }
  }
  return ''
}

/** 运行快照多久算「还活着」。桥大约一分钟写一次，给 3 分钟够宽松。 */
const RUNTIME_FRESH_MS = 180000
/** 宿主刚启动多久之内，「还没写心跳」算正常启动过程，不算桥挂了。 */
const HOST_WARMUP_MS = 600000

/** 这个 pid 还在不在（Windows / POSIX 都走 process.kill(pid, 0)）。 */
function pidAlive(pid) {
  const n = Number(pid) || 0
  if (n <= 0) return false
  if (n === process.pid) return true
  try { process.kill(n, 0); return true } catch { return false }
}

/** 文件最后动过是什么时候；读不到给 0。 */
function mtimeMsOf(file) {
  try { return fs.statSync(file).mtimeMs } catch { return 0 }
}

/**
 * 桥接自己的健康：在线 / 最后一次活动 / 运行时长 / 是不是就跑在这个进程里。
 *
 * 为什么还要看 pid：宿主机重启后，旧进程写的 qq-runtime.json 还躺在那儿，
 * 光看「文件很新」会把上一轮的尸体当成活的。pid 对上本进程 = 进程内桥；对不上就查那个进程还在不在。
 *
 * opts 只给测试用：`{ dir, pid, at }`（生产不传）。
 */
export function qqBridgeHealth(opts = {}) {
  const base = opts.dir ? String(opts.dir) : dshHome() + '/qq-bridge'
  const nowMs = Number(opts.at) || Date.now()
  const selfPid = opts.pid == null ? process.pid : Number(opts.pid)
  const out = { dir: base, online: null, updated_at: '', pid: null, uptime: null, trace_at: '', activity_at: '', fresh: false, local: false, alive: false, age_sec: null, sessions: 0 }
  try {
    const rt = JSON.parse(fs.readFileSync(base + '/qq-runtime.json', 'utf8'))
    const at = Number(rt.updatedAt) || 0
    out.online = !!rt.botOnline
    out.updated_at = at ? new Date(at).toISOString() : ''
    out.pid = rt.pid ? Number(rt.pid) : null
    out.uptime = rt.uptimeSeconds == null ? null : Number(rt.uptimeSeconds)
    out.sessions = Number(rt.sessionCount) || 0
    out.local = out.pid != null && out.pid === selfPid
    // 测试里传了 pid 就别去碰真实进程表
    out.alive = out.local || (opts.pid == null && pidAlive(out.pid))
    if (at > 0) {
      out.age_sec = Math.max(0, Math.round((nowMs - at) / 1000))
      out.fresh = nowMs - at <= RUNTIME_FRESH_MS
    }
  } catch { /* 桥接没装或没起 */ }
  // 最后一次真的动过（不只是心跳）：trace / 收件箱 / 出站记录里最新的那个
  const touched = Math.max(
    mtimeMsOf(base + '/qq-trace.jsonl'),
    mtimeMsOf(base + '/qq-inbox.jsonl'),
    mtimeMsOf(base + '/qq-actions.log'),
  )
  out.trace_at = out.activity_at = touched > 0 ? new Date(touched).toISOString() : ''
  return out
}

/**
 * 用桥接的运行快照回答「桥还活着吗、QQ 还登着吗」，形状和 conversations.probeBridge() 一致。
 *
 * 返回 null = 本地没有可信证据（没装 / 没起 / 文件是上一轮留下的），调用方再退回 HTTP 探测。
 * 为什么要退这一步：现在的桥是**挂在宿主进程里**的插件，不开 3100 端口，
 * 原来那个「fetch http://127.0.0.1:3100/health」在进程内模式下永远是 fetch failed，
 * 于是面板一直说「桥没起」——其实桥和 QQ 都好好的。
 */
export function qqBridgeProbe(opts = {}) {
  const h = qqBridgeHealth(opts)
  if (!h.fresh || !h.alive) return null
  const online = h.online === true
  const at = h.activity_at || h.updated_at || null
  return {
    ok: online,
    source: h.local ? 'in-process' : 'runtime-file',
    bridge: {
      reachable: true,
      local: h.local,
      pid: h.pid,
      url: h.local ? '进程内（跟着宿主跑）' : '另一个进程 pid ' + h.pid,
      uptime_sec: h.uptime,
      last_inbound_at: at,
      inbound: null,
      sent: null,
      sessions: h.sessions,
      last_error: online ? null : '桥在跑，但 QQ 没登着',
    },
    napcat: { ok: online, user_id: null, nickname: null, error: online ? null : 'QQ 没登着（桥本身在跑）' },
    checked_at: new Date(Number(opts.at) || Date.now()).toISOString(),
  }
}

/**
 * 宿主刚重启、桥还没写下第一份心跳的那一分钟：这不是「桥没起」，是「还在起来」。
 * 只有宿主进程本身启动不到 10 分钟时才这么判，否则就是真没起。
 */
export function qqBridgeWarming(opts = {}) {
  const h = qqBridgeHealth(opts)
  const up = opts.uptime_ms == null ? process.uptime() * 1000 : Number(opts.uptime_ms)
  if (!h.updated_at) return null
  if (h.fresh && h.alive) return null
  if (!(up >= 0 && up < HOST_WARMUP_MS)) return null
  return {
    ok: false,
    warming: true,
    source: 'warming',
    bridge: {
      reachable: false,
      warming: true,
      local: h.local,
      pid: h.pid,
      url: '刚重启，还没写第一份心跳',
      uptime_sec: null,
      last_inbound_at: h.activity_at || h.updated_at || null,
      inbound: null,
      sent: null,
      sessions: 0,
      last_error: null,
    },
    napcat: { ok: false, user_id: null, nickname: null, error: '桥还在启动，等它写第一份心跳' },
    checked_at: new Date(Number(opts.at) || Date.now()).toISOString(),
  }
}

/** 一条聊天的接线状态：ok=通、idle=绑着但很久没动静 / 换下来的旧会话、down=没绑上。 */
export function qqWatchRow(db, key, sid, bindRow, nowMs, inMap) {
  const p = parseChatKey(key)
  const label = p ? (p.kind === 'u' ? '私聊 ' + p.id : '群 ' + p.id) : '（映射表里没有这条）'
  let bound = bindRow || null
  if (!bound) { try { bound = bindingOf(db, sid) } catch { bound = null } }
  let agentName = ''
  try {
    if (bound && bound.agent_id) {
      const a = db.prepare('SELECT name FROM agents WHERE id=?').get(bound.agent_id)
      agentName = a ? String(a.name || '') : ''
    }
  } catch { /* 名字读不到就空着 */ }
  let lastTurn = ''
  try {
    const r = db.prepare('SELECT MAX(created_at) AS t FROM raw_turns WHERE session_id=?').get(sid)
    lastTurn = r && r.t ? String(r.t) : ''
  } catch { /* 空 */ }
  let conv = null
  const convId = conversationIdOf(key)
  if (convId) { try { conv = db.prepare('SELECT agent_id, state, last_seen_at FROM conversations WHERE conversation_id=?').get(convId) } catch { conv = null } }
  const times = [lastTurn, conv && conv.last_seen_at, bound && bound.bound_at].filter(Boolean).map(String)
  times.sort()
  const lastAt = times.length ? times[times.length - 1] : ''
  const ageH = lastAt ? (nowMs - Date.parse(lastAt)) / 3600000 : null
  const isBound = !!(bound && bound.state === 'bound')
  let state = 'ok'
  let note = ''
  if (!isBound) { state = 'down'; note = '这段没绑上，记忆链是断的' } else if (!inMap) { state = 'idle'; note = '换下来的旧会话，绑定还挂着（不影响使用）' } else if (ageH != null && ageH > 24) { state = 'idle'; note = '绑着，但一天以上没说话' }
  return {
    chat_key: key,
    label,
    session_id: sid,
    short: sid.length > 8 ? sid.slice(-8) : sid,
    bound: isBound,
    agent: agentName,
    agent_id: bound ? String(bound.agent_id || '') : '',
    source: bound ? String(bound.source || '') : '',
    bound_at: bound ? String(bound.bound_at || '') : '',
    conv: convId,
    last_at: lastAt,
    age_hours: ageH == null ? null : Math.round(ageH * 10) / 10,
    state,
    note,
  }
}

/**
 * 看板数据：每个 QQ 聊天「现在绑在哪个会话上、归谁、最后一次说话是什么时候」。
 * @param {object} db 库
 * @param {{sessionsFile?: string, at?: number}} [opts] 测试可指定映射表路径和时间
 */
export function qqWatchData(db, opts = {}) {
  const stamp = (v) => {
    const t = Date.parse(String(v || ''))
    return Number.isFinite(t) ? new Date(t).toISOString() : ''
  }
  const nowMs = Number(opts.at) || Date.now()
  const file = opts.sessionsFile != null ? String(opts.sessionsFile) : findQQSessionsFile()
  const map = loadSessionMap(file) || {}
  // 同一个聊天的所有会话共享 `qq-<digest>` 前缀，所以换下来的旧会话也能借现在这条认出是谁。
  const keyByPrefix = {}
  for (const [key, sid] of Object.entries(map)) {
    const s = String(sid || '')
    if (s.length > 27) keyByPrefix[s.slice(0, 27)] = key
  }
  const keyOfOld = (sid) => chatKeyOfSessionId(sid, map) || keyByPrefix[String(sid || '').slice(0, 27)] || ''
  const seen = new Set()
  const rows = []
  const add = (key, sid, bindRow, inMap) => {
    const s = String(sid || '')
    if (!s || seen.has(s)) return
    seen.add(s)
    rows.push(qqWatchRow(db, String(key || ''), s, bindRow, nowMs, !!inMap))
  }
  // 桥接现在接管的聊天（映射表是实时的，桥接一换会话它就变）
  for (const [key, sid] of Object.entries(map)) add(key, sid, null, true)
  // 还挂着绑定的旧会话：不在映射表里也列出来，一眼能看出「换下来了还在」
  try {
    for (const b of db.prepare("SELECT * FROM bindings WHERE session_id LIKE 'qq-%' AND state='bound' ORDER BY bound_at DESC").all()) {
      add(keyOfOld(b.session_id), b.session_id, b, false)
    }
  } catch { /* 老库没有 bindings 表就只看映射表 */ }
  rows.sort((a, b) => String(b.last_at || '').localeCompare(String(a.last_at || '')))
  const recent = []
  try {
    for (const r of db.prepare("SELECT type, payload, created_at FROM events WHERE type LIKE 'qq.%' OR (type='binding.bound' AND payload LIKE '%qq-%') ORDER BY created_at DESC LIMIT 12").all()) {
      let p = {}
      try { p = JSON.parse(String(r.payload || '{}')) } catch { p = {} }
      recent.push({ type: String(r.type || ''), at: stamp(r.created_at), session: String(p.sessionId || p.session || ''), chat: String(p.chatKey || ''), source: String(p.source || '') })
    }
  } catch { /* 没有 events 表就空着 */ }
  return { at: new Date(nowMs).toISOString(), sessions_file: file, bridge: qqBridgeHealth(), chatters: rows, recent }
}
