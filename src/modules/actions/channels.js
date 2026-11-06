/**
 * 行动通道：配置读写 + 三种真实发送方式。
 *
 *   微信（个人）  wechat.js → PowerShell + UIAutomation
 *   微信（企业）  群机器人 webhook（官方接口，最稳；只能发群）
 *   QQ           OneBot v11 HTTP（NapCat / Lagrange 等网关）
 *
 * 所有通道都走同一个返回形状：{ ok, channel, target, status, detail }。
 * 配置存 action_config 表，按点号 key 扁平保存，只存改过的项。
 */
import { now } from '../../db.js'
import * as wechat from './wechat.js'
import { biliStatus } from './bilibili.js'

export const DEFAULTS = {
  'wechat.mode': 'uia', // uia | wecom | auto（只管 auto 时 wecom 要不要排到最前）
  'wechat.backend': 'auto', // auto | wechatauto | uia
  'wechat.default_target': '文件传输助手',
  'wechat.wecom_webhook': '',
  'wechat.allow_keys_fallback': false,
  'wechat.launch': true,
  'wechat.dry_run': false,
  // 发消息的顺位：auto 时从前往后试，前一条不通就换下一条。微信第一（2026-11-07 起）。
  'send.order': 'wechat,wecom,qq',
  // 收信（只读本地库，不动窗口）：默认开；skip 里的会话不记（微信团队这类服务号）。
  'wechat.inbox.enable': true,
  'wechat.inbox.skip': 'weixin',
  'wechat.inbox.limit': 40,
  // 回话前先「正在输入」：真在她的输入框里打草稿，写好再整句覆盖发送。lead 是回车前停多久。
  'wechat.typing.enable': true,
  'wechat.typing.lead_ms': 1200,
  'qq.mode': 'onebot',
  'qq.base_url': 'http://127.0.0.1:3000',
  'qq.token': '',
  'qq.default_target_type': 'private',
  'qq.default_target': '',
  'bili.cookie': '',
  'bili.limit': 10,
  'research.depth': 'standard',
  'research.max_sources': 12,
  'research.seen_days': 60,
}

const BOOL_KEYS = new Set(['wechat.allow_keys_fallback', 'wechat.launch', 'wechat.dry_run', 'wechat.inbox.enable', 'wechat.typing.enable'])
const NUM_KEYS = new Set(['bili.limit', 'research.max_sources', 'research.seen_days', 'wechat.inbox.limit', 'wechat.typing.lead_ms'])
const ENUMS = {
  'wechat.mode': ['uia', 'wecom', 'auto'],
  'wechat.backend': ['auto', 'wechatauto', 'uia'],
  'qq.mode': ['onebot'],
  'qq.default_target_type': ['private', 'group'],
  'research.depth': ['quick', 'standard', 'deep'],
}

function coerce(key, value) {
  if (BOOL_KEYS.has(key)) {
    if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true'
    return !!value
  }
  if (NUM_KEYS.has(key)) {
    const n = Number(value)
    return Number.isFinite(n) ? n : DEFAULTS[key]
  }
  let v = value == null ? '' : String(value)
  if (ENUMS[key] && !ENUMS[key].includes(v)) v = DEFAULTS[key]
  return v
}

export function getConfig(db, agentId) {
  const out = { ...DEFAULTS }
  try {
    const rows = db.prepare('SELECT key, value FROM action_config WHERE agent_id=?').all(agentId)
    for (const r of rows) {
      if (!(r.key in DEFAULTS)) continue
      try { out[r.key] = coerce(r.key, JSON.parse(r.value)) } catch { /* 坏值回默认 */ }
    }
  } catch { /* 老库没有这张表时用默认 */ }
  return out
}

/** 密钥类配置：界面拿到的是打码值，保存回来的空串不能当「清空」。 */
const SECRET_KEYS = new Set(['wechat.wecom_webhook', 'qq.token', 'bili.cookie'])

export function saveConfig(db, agentId, patch) {
  const clean = {}
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue
    // 空串 = 这次没改（设置页回传的常常是打码值或空），否则改一次别的项就把密钥抹了；
    // 真要清空，传 null。
    if (SECRET_KEYS.has(k) && v !== null && String(v == null ? '' : v).trim() === '') continue
    clean[k] = coerce(k, v)
  }
  const stmt = db.prepare('INSERT OR REPLACE INTO action_config(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
  for (const [k, v] of Object.entries(clean)) stmt.run(agentId, k, JSON.stringify(v), now())
  return getConfig(db, agentId)
}

/** 只改配置的公开视图：把 webhook / token 之类打码，界面可以安全展示。 */
export function publicConfig(cfg) {
  const mask = (s) => {
    const v = String(s || '')
    if (!v) return ''
    return v.length <= 8 ? '••••' : v.slice(0, 4) + '••••' + v.slice(-4)
  }
  return {
    ...cfg,
    'wechat.wecom_webhook': mask(cfg['wechat.wecom_webhook']),
    'qq.token': mask(cfg['qq.token']),
    'bili.cookie': mask(cfg['bili.cookie']),
    has_wecom_webhook: !!cfg['wechat.wecom_webhook'],
    has_qq_token: !!cfg['qq.token'],
    has_bili_cookie: !!cfg['bili.cookie'],
  }
}

// ---------------- 企业微信群机器人 ----------------

export async function sendWecom(webhook, text, { timeout = 12000 } = {}) {
  const url = String(webhook || '').trim()
  if (!url) throw new Error('没有配置企业微信群机器人 webhook：在设置里把 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=… 粘进来')
  let u
  try { u = new URL(url) } catch { throw new Error('企业微信 webhook 不是合法 URL') }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('企业微信 webhook 只允许 http/https')

  const parts = []
  const body = String(text || '')
  for (let i = 0; i < body.length || i === 0; i += 1800) parts.push(body.slice(i, i + 1800))
  if (!parts.length) parts.push('')
  const results = []
  for (const part of parts) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: part || '（空消息）' } }),
        signal: ctrl.signal,
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error('企业微信 HTTP ' + r.status)
      if (Number(data.errcode) !== 0) throw new Error('企业微信返回 ' + data.errcode + '：' + (data.errmsg || ''))
      results.push({ ok: true })
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('企业微信 webhook 超时')
      throw e
    } finally { clearTimeout(timer) }
  }
  return { ok: true, status: 'sent', parts: results.length, detail: '企业微信群机器人已接收' }
}

// ---------------- QQ OneBot ----------------

export function onebotEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('没有配置 OneBot 地址')
  let u
  try { u = new URL(base) } catch { throw new Error('OneBot 地址不是合法 URL：' + base) }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('OneBot 只支持 http/https')
  return base
}

export async function sendOneBot({ baseUrl, token, targetType, target, text }, { timeout = 15000 } = {}) {
  const base = onebotEndpoint(baseUrl)
  const type = targetType === 'group' ? 'group' : 'private'
  if (!String(target || '').trim()) throw new Error('没有给 QQ ' + (type === 'group' ? '群号' : 'QQ 号'))
  const id = String(target).trim().replace(/^qq:/i, '')
  if (!/^\d{4,20}$/.test(id)) throw new Error('QQ ' + (type === 'group' ? '群号' : '号') + '看起来不对：' + id)
  const endpoint = base + (type === 'group' ? '/send_group_msg' : '/send_private_msg')
  const payload = type === 'group'
    ? { group_id: Number(id), message: String(text || '') }
    : { user_id: Number(id), message: String(text || '') }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    const raw = await r.text()
    let data = null
    try { data = JSON.parse(raw) } catch { data = null }
    if (!r.ok) throw new Error('OneBot HTTP ' + r.status + '：' + raw.slice(0, 200))
    const ok = data && (data.retcode === 0 || data.status === 'ok')
    if (!ok) throw new Error('OneBot 返回失败：' + raw.slice(0, 300))
    return {
      ok: true,
      status: 'sent',
      detail: 'QQ ' + (type === 'group' ? '群 ' + id : id) + ' 已接收',
      message_id: data && data.data && data.data.message_id,
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('OneBot 超时：确认 NapCat 正在运行、地址 ' + base + ' 正确')
    if (e && /fetch failed|ECONNREFUSED|connect/i.test(String(e.message || e))) {
      throw new Error('连不上 OneBot（' + base + '）：确认 NapCat 已启动、端口一致、token 正确。原始错误：' + String(e.message || e))
    }
    throw e
  } finally { clearTimeout(timer) }
}

export async function onebotProbe({ baseUrl, token }, { timeout = 4000 } = {}) {
  const base = onebotEndpoint(baseUrl)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(base + '/get_login_info', {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      signal: ctrl.signal,
    })
    const data = await r.json().catch(() => ({}))
    const ok = r.ok && data && (data.retcode === 0 || data.status === 'ok')
    return {
      ok: !!ok,
      reachable: true,
      logged_in: !!ok,
      user: ok ? ((data.data && (data.data.nickname || data.data.user_id)) || '') : '',
      error: ok ? '' : ('OneBot 返回 ' + JSON.stringify(data).slice(0, 160)),
    }
  } catch (e) {
    return { ok: false, reachable: false, logged_in: false, user: '', error: String((e && e.message) || e) }
  } finally { clearTimeout(timer) }
}

// ---------------- 统一入口 ----------------

/** 三条通道的固定名字。`send.order` 只能调顺序，不能凭空造通道。 */
export const CHANNELS = ['wechat', 'wecom', 'qq']

/**
 * 发送顺位：`send.order` 里写到的按顺序用，没写到的补在后面，写错的直接丢掉
 * ——配置坏了也不能把消息发到没人看的地方去。
 */
export function channelOrder(cfg) {
  const raw = String((cfg && cfg['send.order']) || DEFAULTS['send.order'])
  const list = raw.split(/[,，;；\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => CHANNELS.includes(s))
  for (const c of CHANNELS) if (!list.includes(c)) list.push(c)
  return [...new Set(list)]
}

/**
 * 这条发送落在账本里的 conversation_id（和 QQ 桥 / 微信同口径）。
 * 发出去的话要能回看：光存在对方手机上等于她这边没说过。
 */
export function conversationIdOfSend(channel, target, cfg = {}) {
  const to = String(target || '').trim()
  if (channel === 'wechat') return to ? 'wechat:' + to : ''
  if (channel === 'wecom') return 'wecom:group'
  if (channel === 'qq') {
    const id = to.replace(/^qq:/i, '')
    if (!id) return ''
    return cfg['qq.default_target_type'] === 'group' ? 'qq:g:' + id : 'qq:p:' + id
  }
  return ''
}

/** 缺收件人：auto 时这不是「发失败」，是「这条通道没配好」，应该换下一条。 */
function noTarget(msg) {
  const e = new Error(msg)
  e.noTarget = true
  return e
}

const REASON_TEXT = { no_webhook: '没配企业微信 webhook', no_target: '没有收件人' }

/** 把一句话交给某一条通道。失败就抛，由 sendMessage 决定要不要换下一条。 */
async function sendThrough(cfg, channel, { target, text }) {
  if (channel === 'wecom') {
    const out = await sendWecom(cfg['wechat.wecom_webhook'], text)
    return { ...out, target: '企业微信群' }
  }
  if (channel === 'wechat') {
    const to = String(target || cfg['wechat.default_target'] || '').trim()
    if (!to) throw noTarget('没有给微信收件人')
    const out = await wechat.send({
      target: to,
      text,
      backend: cfg['wechat.backend'] || 'auto',
      launch: cfg['wechat.launch'] !== false,
      allowKeysFallback: cfg['wechat.allow_keys_fallback'] === true,
      dryRun: cfg['wechat.dry_run'] === true,
      // 微信被关到托盘时要先把它拉起来（最多 25 秒）再发；65 秒会把这种正常情况掐死。
      timeoutMs: 150000,
    })
    if (!out.ok) throw new Error(out.message || ('微信发送失败：' + (out.code || 'UNKNOWN')))
    return {
      ok: true,
      target: to,
      status: out.sent ? 'sent' : 'dry-run',
      detail: out.message,
      mode: out.mode,
      steps: out.steps,
    }
  }
  const to = String(target || cfg['qq.default_target'] || '').trim()
  if (!to) throw noTarget('没有给 QQ 收件人')
  const out = await sendOneBot({
    baseUrl: cfg['qq.base_url'],
    token: cfg['qq.token'],
    targetType: cfg['qq.default_target_type'],
    target: to,
    text,
  })
  return { ...out, target: to }
}

/**
 * @param {{channel?:'wechat'|'wecom'|'qq'|'auto', target?:string, text:string}} req
 *
 * 显式通道就是显式：说发微信就发微信，不再因为「模式配了企业微信」被偷偷改道。
 * auto 才按顺位挨个试：缺配置的跳过，发失败的换下一条，全都不通才报错。
 */
export async function sendMessage(db, agentId, req) {
  const cfg = getConfig(db, agentId)
  const text = String(req.text || '')
  if (!text.trim()) throw new Error('要发的内容是空的')
  const channel = String(req.channel || 'auto').toLowerCase()
  if (!['wechat', 'wecom', 'qq', 'auto'].includes(channel)) throw new Error('不认识的通道：' + channel)

  if (channel !== 'auto') {
    const out = await sendThrough(cfg, channel, { target: req.target, text })
    return { ...out, channel, conversationId: conversationIdOfSend(channel, out.target, cfg) }
  }

  const order = channelOrder(cfg)
  // wechat.mode=wecom 的意思是「我这儿的微信其实走企业微信」：那就把 wecom 提到最前，
  // 顺位表其余部分不动——用户自己排的顺序还是要认。
  if (cfg['wechat.mode'] === 'wecom') order.sort((a, b) => (a === 'wecom' ? -1 : b === 'wecom' ? 1 : 0))
  const tried = []
  let lastErr = null
  for (const ch of order) {
    if (ch === 'wecom' && !String(cfg['wechat.wecom_webhook'] || '').trim()) {
      tried.push({ channel: ch, ok: false, reason: 'no_webhook' })
      continue
    }
    try {
      const out = await sendThrough(cfg, ch, { target: req.target, text })
      return {
        ...out,
        channel: ch,
        conversationId: conversationIdOfSend(ch, out.target, cfg),
        tried,
      }
    } catch (e) {
      if (e && e.noTarget) {
        tried.push({ channel: ch, ok: false, reason: 'no_target' })
        continue
      }
      tried.push({ channel: ch, ok: false, error: String((e && e.message) || e).slice(0, 160) })
      lastErr = e
    }
  }
  const why = tried.map((t) => t.channel + '：' + (t.reason ? (REASON_TEXT[t.reason] || t.reason) : t.error || '失败')).join('；')
  const err = new Error('没有一条通道发得出去（顺位 ' + order.join(' → ') + '）：' + why)
  if (lastErr) err.cause = lastErr
  throw err
}

// ---------------- 体检 ----------------

const probeCache = new Map()
const PROBE_TTL = 45 * 1000

export async function status(db, agentId, { fresh = false } = {}) {
  const hit = probeCache.get(agentId)
  if (!fresh && hit && Date.now() - hit.at < PROBE_TTL) return hit.value

  const cfg = getConfig(db, agentId)
  const [pyOk, wx, qq, bili] = await Promise.all([
    wechat.wechatautoAvailable().catch(() => false),
    (async () => {
      try {
        const p = await wechat.probe(20000)
        return {
          ok: !!p.ok,
          logged_in: !!(p.probe && p.probe.logged_in),
          window: p.window || null,
          error: p.ok ? '' : (p.message || p.code || ''),
          nodes: (p.probe && p.probe.nodes) ? p.probe.nodes.length : 0,
        }
      } catch (e) {
        return { ok: false, logged_in: false, window: null, error: String((e && e.message) || e), nodes: 0 }
      }
    })(),
    cfg['qq.mode'] === 'onebot'
      ? onebotProbe({ baseUrl: cfg['qq.base_url'], token: cfg['qq.token'] })
      : Promise.resolve({ ok: false, reachable: false, logged_in: false, user: '', error: '未启用 OneBot' }),
    biliStatus(),
  ])

  const ports = {}
  try {
    for (const r of db.prepare('SELECT name, enabled FROM action_ports WHERE agent_id=?').all(agentId)) {
      ports[r.name] = !!r.enabled
    }
  } catch { /* 老库 */ }

  const value = {
    wechat: {
      ...wx,
      mode: cfg['wechat.mode'],
      backend: cfg['wechat.backend'] || 'auto',
      wechatauto: pyOk,
      python: wechat.pythonStatus(),
      default_target: cfg['wechat.default_target'],
      wecom_configured: !!cfg['wechat.wecom_webhook'],
      hint: pyOk
        ? '个人微信：Python 后端可用（wechatauto-replica）'
        : wx.logged_in
          ? '个人微信窗口可操作（UIA 后端）'
          : (cfg['wechat.wecom_webhook'] ? '个人微信不可用时可走企业微信群机器人' : '个人微信需要已登录；微信 4.1 建议装 wechatauto-replica'),
    },
    qq: { ...qq, base_url: cfg['qq.base_url'], target_type: cfg['qq.default_target_type'] },
    bili: { ...bili, note: bili.ok ? (bili.note || '') : '连不上 B 站' },
    ports,
    config: publicConfig(cfg),
    at: new Date().toISOString(),
  }
  probeCache.set(agentId, { at: Date.now(), value })
  return value
}

export async function test(db, agentId, { channel, target, text } = {}) {
  const cfg = getConfig(db, agentId)
  const ch = String(channel || 'wechat')
  if (ch === 'wechat') {
    const backend = cfg['wechat.backend'] || 'auto'
    const pyOk = await wechat.wechatautoAvailable()
    // UIA 后端才依赖窗口探测；Python 后端自己会处理窗口，探不到也不用拦
    if (backend === 'uia' || !pyOk) {
      const p = await wechat.probe(20000)
      if (!p.ok) return { ok: false, channel: 'wechat', status: 'unavailable', detail: p.message || p.code }
      if (!p.probe || !p.probe.logged_in) {
        return { ok: false, channel: 'wechat', status: 'not_logged_in', detail: '微信停在登录窗口' }
      }
    }
    const out = await wechat.send({
      target: String(target || cfg['wechat.default_target'] || '').trim(),
      text: String(text || '这是一条通道测试：' + new Date().toLocaleString('zh-CN')),
      backend,
      launch: false,
      allowKeysFallback: cfg['wechat.allow_keys_fallback'] === true,
      dryRun: false,
      timeoutMs: 65000,
    })
    return { ok: !!out.ok, channel: 'wechat', status: out.ok ? 'sent' : 'failed', detail: out.message || out.code, steps: out.steps }
  }
  if (ch === 'wecom') {
    const out = await sendWecom(cfg['wechat.wecom_webhook'], String(text || '这是一条企业微信通道测试'))
    return { ok: true, channel: 'wecom', status: out.status, detail: out.detail }
  }
  if (ch === 'qq') {
    const p = await onebotProbe({ baseUrl: cfg['qq.base_url'], token: cfg['qq.token'] })
    if (!p.ok) return { ok: false, channel: 'qq', status: 'unreachable', detail: p.error }
    const out = await sendOneBot({
      baseUrl: cfg['qq.base_url'],
      token: cfg['qq.token'],
      targetType: cfg['qq.default_target_type'],
      target: String(target || cfg['qq.default_target'] || '').trim(),
      text: String(text || '这是一条 QQ 通道测试'),
    })
    return { ok: true, channel: 'qq', status: out.status, detail: out.detail }
  }
  throw new Error('不认识的通道：' + ch)
}

