/**
 * 行动接口：模型能真正调用的四个工具 + 界面用的执行/体检入口。
 *
 * 闸门仍是 action_ports（默认全关）：工具一直在，执行时先看对应端口开没开。
 * 这样开关只影响「能不能动手」，不影响模型知不知道有这回事。
 */
import { now } from '../../db.js'
import { nid } from '../../kernel.js'
import { htmlToText } from './util.js'
import { getConfig, saveConfig, publicConfig, sendMessage, status as channelStatus, test as channelTest } from './channels.js'
import { searchVideos, popular, recommend, videoDetail, comments, postComment, biliStatus } from './bilibili.js'
import { runResearch, listRuns, getRun } from './research.js'
import { budgetConsume, budgetRefund } from '../drive.js'
import { createInboxItem } from '../selfmod_store.js'
import { recallTool, renderRecall, LAYERS, DEFAULT_LAYERS } from '../recall_tool.js'
import { asOfSearch, renderAsOf } from '../asof.js'
import { rememberFact } from '../remember_tool.js'
import { ingestBrowse } from '../browse.js'

export const PORTS = ['send_message', 'browse', 'research', 'remind']

export const PORT_LABELS = {
  send_message: '发消息（微信 / QQ）',
  browse: '浏览（网页 / B 站）',
  research: '研究搜集（多轮检索 + 可信度）',
  remind: '提醒',
}

export function requirePort(db, agentId, port) {
  const r = db.prepare('SELECT enabled FROM action_ports WHERE agent_id=? AND name=?').get(agentId, port)
  if (!r || !r.enabled) {
    throw new Error('行动接口「' + (PORT_LABELS[port] || port) + '」还没开：'
      + '去 设置 → 意识 → 驱力 → 行动接口 打开它，再让我动手。')
  }
}

function logAction(db, agentId, port, request, result, status) {
  try {
    const id = nid('act_')
    db.prepare('INSERT INTO action_log VALUES(?,?,?,?,?,?)').run(
      id, agentId, port, JSON.stringify({ request, result: result || null }), status, now())
    return id
  } catch { return null }
}

function textOf(v, max = 4000) {
  return String(v == null ? '' : v).slice(0, max)
}

// ---------------- 发消息 ----------------

export async function executeSend(db, agentId, args = {}) {
  requirePort(db, agentId, 'send_message')
  const text = textOf(args.text, 6000)
  if (!text.trim()) throw new Error('要发的内容是空的')
  const channel = String(args.channel || 'auto').toLowerCase()
  const target = String(args.target || '').trim()
  // 打扰预算：默认本月 3 条；先扣、失败退回
  budgetConsume(db, agentId, 'disturb', 1)
  try {
    const out = await sendMessage(db, agentId, { channel, target, text })
    logAction(db, agentId, 'send_message', { channel, target, len: text.length }, out, out.status)
    return {
      ok: true,
      channel: out.channel,
      target: out.target,
      status: out.status,
      detail: out.detail || '',
      at: new Date().toISOString(),
    }
  } catch (e) {
    try { budgetRefund(db, agentId, 'disturb', 1) } catch { /* ignore */ }
    throw e
  }
}

// ---------------- 浏览 ----------------

/** 拦私网 / link-local / localhost，防 SSRF（P4.7）。可配置例外见 action_config browse.allow_private。 */
export function isBlockedBrowseHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h === 'localhost.localdomain') return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  // IPv4
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const a = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    if (a.some((n) => n > 255)) return true
    if (a[0] === 10) return true
    if (a[0] === 127) return true
    if (a[0] === 0) return true
    if (a[0] === 169 && a[1] === 254) return true
    if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true
    if (a[0] === 192 && a[1] === 168) return true
    if (a[0] === 100 && a[1] >= 64 && a[1] <= 127) return true // CGNAT
    return false
  }
  // IPv6 粗拦：fc/fd ULA、fe80 link-local
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  return false
}

function assertBrowseUrlAllowed(url, cfg = {}) {
  let u
  try { u = new URL(String(url || '').trim()) } catch { throw new Error('网址不合法') }
  if (!/^https?:$/i.test(u.protocol)) throw new Error('只支持 http/https 的网址')
  const allowPrivate = cfg['browse.allow_private'] === true || cfg['browse.allow_private'] === 'true'
  if (!allowPrivate && isBlockedBrowseHost(u.hostname)) {
    throw new Error('不能打开内网 / 本机地址（私网、link-local、localhost）')
  }
  return u.href
}

async function browseUrl(url, { web, signal, cfg }) {
  const u = assertBrowseUrlAllowed(url, cfg)
  if (web && typeof web.fetch === 'function') {
    const r = await web.fetch({ url: u }, signal)
    const body = (r && r.body) || {}
    const text = body.kind === 'html' ? htmlToText(String(body.content || ''), { max: 6000 }) : String(body.content || '').slice(0, 6000)
    const title = body.kind === 'html'
      ? htmlToText((String(body.content || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '', { max: 200 })
      : ''
    return {
      mode: 'url',
      url: u,
      status: Number(r && r.statusCode) || 0,
      truncated: !!(r && r.truncated),
      title,
      text,
    }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(u, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } })
    const html = await r.text()
    return {
      mode: 'url',
      url: u,
      status: r.status,
      truncated: html.length > 200000,
      title: htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '', { max: 200 }),
      text: htmlToText(html, { max: 6000 }),
    }
  } finally { clearTimeout(timer) }
}

/**
 * 发一条公开评论（目前只支持 B 站）。和发消息共用「对外说话」的预算与端口。
 * 不可撤回：调用前必须拿到用户明确同意。
 */
export async function executeComment(db, agentId, args = {}) {
  requirePort(db, agentId, 'send_message')
  const platform = String(args.platform || 'bilibili').toLowerCase()
  if (platform !== 'bilibili') throw new Error('目前只支持 B 站评论：platform=bilibili')
  const text = String(args.text || '').trim()
  if (!text) throw new Error('评论内容是空的')
  if (text.length > 800) throw new Error('B 站评论最多 800 字')
  const target = String(args.target || args.bvid || '').trim()
  if (!target) throw new Error('要评论哪个视频？给我 bvid（BV…）')
  const cfg = getConfig(db, agentId)
  if (!cfg['bili.cookie']) {
    throw new Error('写评论需要登录态：设置 → 行动接口 → 浏览 → B 站 Cookie，至少填 SESSDATA 和 bili_jct')
  }
  budgetConsume(db, agentId, 'disturb', 1)
  try {
    const out = await postComment(target, text, { cookie: cfg['bili.cookie'] })
    logAction(db, agentId, 'comment', { platform, target, len: text.length }, out, 'ok')
    return { ok: true, platform, target, rpid: out.rpid, url: out.url, note: out.note, at: new Date().toISOString() }
  } catch (e) {
    try { budgetRefund(db, agentId, 'disturb', 1) } catch { /* ignore */ }
    throw e
  }
}

export async function executeBrowse(db, agentId, args = {}, deps = {}) {  requirePort(db, agentId, 'browse')
  const mode = String(args.mode || (args.url ? 'url' : 'bilibili_feed'))
  const cfg = getConfig(db, agentId)
  const limit = Math.max(1, Math.min(30, Number(args.limit) || Number(cfg['bili.limit']) || 10))
  let out

  if (mode === 'url') {
    out = await browseUrl(args.url, { ...deps, cfg })
  } else if (mode === 'search') {
    const query = String(args.query || '').trim()
    if (!query) throw new Error('网页检索需要 query')
    const web = deps.web
    if (!web || typeof web.search !== 'function') throw new Error('宿主没有 web 检索服务，搜不了')
    const r = await web.search({ query, maxResults: limit }, deps.signal)
    out = {
      mode,
      query,
      answer: String((r && r.content) || '').slice(0, 4000),
      items: ((r && r.sources) || []).map((s) => ({
        title: String(s.title || '').slice(0, 200),
        url: s.url,
        snippet: String(s.snippet || '').slice(0, 500),
        published_at: s.publishedAt || '',
      })),
    }
  } else if (mode === 'bilibili_search') {
    const query = String(args.query || '').trim()
    if (!query) throw new Error('B 站搜索需要 query')
    const r = await searchVideos(query, { limit, order: String(args.order || 'totalrank'), signal: deps.signal })
    out = { mode, query, total: r.total, items: r.items }
  } else if (mode === 'bilibili_feed') {
    let r
    try { r = await recommend({ limit, signal: deps.signal }) } catch { r = await popular({ limit, signal: deps.signal }) }
    out = { mode, items: r.items }
  } else if (mode === 'bilibili_video') {
    const ref = String(args.bvid || args.url || '').trim()
    if (!ref) throw new Error('B 站视频需要 bvid')
    const detail = await videoDetail(ref, { signal: deps.signal })
    let hot = { items: [], total: 0 }
    try { hot = await comments(ref, { limit: Math.min(10, limit), signal: deps.signal }) } catch { /* 评论失败不影响详情 */ }
    out = { mode, video: detail, comments: hot.items, comments_total: hot.total }
  } else {
    throw new Error('不认识的浏览模式：' + mode)
  }

  logAction(db, agentId, 'browse', { mode, query: args.query || args.url || args.bvid || '' }, null, 'ok')
  // P3：抓完不再扔。标题/正文/query 落 browse_items，给探索的 browseNew 和 tag 面板用。
  // 摘要失败不能反过来弄坏一次成功的浏览，所以整段 best-effort。
  try {
    const items = Array.isArray(out.items) ? out.items : []
    const first = items[0] || {}
    const video = out.video || null
    const title = String(first.title || (video && video.title) || out.title || '').slice(0, 300)
    const text = String(out.answer || items.map((x) => [x.title, x.snippet].filter(Boolean).join(' ')).join('\n') ||
      (video ? [video.title, video.desc].filter(Boolean).join('\n') : '') || '').slice(0, 8000)
    ingestBrowse(db, agentId, {
      url: String(first.url || (video && video.url) || out.url || ''),
      title, text, query: String(out.query || args.query || ''),
      dwell_ms: Number(out.dwell_ms) || 0, channel: 'browse',
    })
  } catch { /* 浏览成功就算成功；记忆这条线另算 */ }
  return { ok: true, ...out, at: new Date().toISOString() }
}

// ---------------- 研究 ----------------

export async function executeResearch(db, agentId, args = {}, deps = {}) {
  requirePort(db, agentId, 'research')
  const today = now().slice(0, 10)
  let runsToday = 0
  try {
    runsToday = Number(db.prepare('SELECT COUNT(*) n FROM research_runs WHERE agent_id=? AND created_at>=?').get(agentId, today).n || 0)
  } catch { runsToday = 0 }
  if (runsToday >= 10) throw new Error('今天已经跑过 10 次研究了，先消化一下已有的报告')

  const cfg = getConfig(db, agentId)
  const depth = String(args.depth || cfg['research.depth'] || 'standard')
  const maxSources = Number(args.max_sources || cfg['research.max_sources'] || 12)
  const out = await runResearch({
    db, agentId,
    topic: String(args.topic || '').trim(),
    goal: String(args.goal || '').trim(),
    depth,
    aspects: Array.isArray(args.aspects) ? args.aspects : [],
    maxSources,
    web: deps.web,
    model: deps.model,
    signal: deps.signal,
  })
  return {
    ok: true,
    run_id: out.run_id,
    topic: out.topic,
    depth: out.depth,
    stats: out.stats,
    sources: out.sources.map((s) => ({
      tag: '[S' + (s.sid + 1) + ']', title: s.title, url: s.url, domain: s.domain,
      tier: s.tier_label, score: s.score, published_at: s.published_at,
    })),
    claims: out.claims.map((c) => ({
      claim: c.claim, confidence: c.confidence, label: c.label,
      support: c.sids.map((i) => '[S' + (i + 1) + ']'),
    })),
    report: out.report,
    file: out.file,
    at: out.at,
  }
}

// ---------------- 提醒 ----------------

export function executeRemind(db, agentId, args = {}) {
  requirePort(db, agentId, 'remind')
  const text = textOf(args.text, 200)
  if (!text.trim()) throw new Error('提醒内容不能为空')
  const at = args.at ? String(args.at).slice(0, 40) : null
  if (at && Number.isNaN(Date.parse(at))) throw new Error('at 要是 ISO 时间（例如 2026-11-01T09:00:00+08:00）')
  const id = createInboxItem(db, agentId, {
    lane: 'todo', refId: null,
    title: text, detail: 'remind', priority: 2, ttlDays: 1,
    expiresAt: at,
  })
  logAction(db, agentId, 'remind', { text, at }, { inbox_id: id }, 'queued')
  return { ok: true, inbox_id: id, text, at, note: '已进收件箱；不会弹系统通知' }
}

const TEXT = (text) => [{ type: 'text', text: String(text) }]

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })

function toolGate(name) {
  return async (getDb, getAid) => {
    const db = getDb()
    const aid = getAid()
    if (!aid) throw new Error('现在没有激活的意识体')
    requirePort(db, aid, name)
    return { db, aid }
  }
}

/**
 * 建四个模型工具。web/model 延迟取：工具注册时宿主服务可能还没挂好。
 */
export function createActionTools({ getDb, getAgentId, getWeb, getModel, log } = {}) {
  const db = () => getDb()
  const aid = () => getAgentId()
  const web = () => { try { return getWeb() } catch { return null } }
  const model = () => { try { return getModel() } catch { return null } }

  return [
    {
      name: 'memory_search',
      description:
        '再查一次自己的长期记忆——每轮自动注入之外的补查。只读，不改任何记忆。'
        + '默认查记忆条目 + 对话原文；查不到先换说法（also），再换层（layers）。',
      parameters: schema({
        query: str('要查什么：一两个关键词，或一句短话'),
        also: { type: 'array', items: { type: 'string' }, description: '换 1–3 种说法一起查（同义词、换语序），比只查一句召回高' },
        layers: {
          type: 'array', items: { type: 'string', enum: LAYERS },
          description: 'memory=记忆条目 episode=纪要 diary=日记 raw=对话原文 fact=事实存根；默认 ["memory","raw"]',
        },
        days: num('只查最近 N 天，0 = 不限（默认）'),
        k: num('每层最多几条，1–12，默认 6'),
        detail: {
          type: 'string', enum: ['brief', 'full'],
          description: 'brief=每条截 120 字（默认，先扫一遍）；full=给全文，单条最多 1200 字',
        },
        context: num('原文命中时前后各带几轮，0–3，默认 0'),
        include: {
          type: 'array', items: { type: 'string', enum: ['superseded'] },
          description: '加 "superseded" 才带已被新说法取代的旧说法（默认不带，它会冒充现状）',
        },
        as_of: str('问「那时候」才填：日期（2026-03-15）或说法（去年三月 / 上周 / 三个月前）。填了就只答当时算数的记忆，并标出和现在的不同'),
        axis: {
          type: 'string', enum: ['said', 'recorded'],
          description: '配合 as_of：said=按用户说话时间（默认）；recorded=按我记下来的时间',
        },
      }, ['query']),
      output: {
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            counts: { type: 'object' },
            more: { type: 'object' },
            truncated: { type: 'boolean' },
            items: { type: 'array' },
          },
        },
        render: (_a, v) => TEXT(v && v.asof ? renderAsOf(v) : renderRecall(v)),
      },
      timeoutMs: 20000,
      presentCall: (args) => ({ card: 'generic', title: '回忆 · ' + (args.query || '') + (args.as_of ? ' @' + args.as_of : ''), kind: 'other', rawInput: args }),
      async execute(args) {
        const d = db()
        const a = aid()
        if (!d || !a) return { query: String((args && args.query) || ''), layers: DEFAULT_LAYERS, counts: {}, more: {}, items: [], truncated: false, ms: 0 }
        const asOf = String((args && args.as_of) || '').trim()
        if (asOf) return { asof: true, ...asOfSearch(d, a, String(args.query || ''), asOf, args.axis, args.k) }
        return recallTool(d, a, args || {})
      },
    },
    {
      name: 'memory_remember',
      description:
        '主动记住一条长期事实（偏好/身份/决定/关系）。走写入门控：同 key 可改写，极性相反会开冲突。'
        + '只写稳定断言；流水账别用。配对 memory_search 做查/写。',
      parameters: schema({
        text: str('要记住的一句完整中文事实'),
        key: str('可选短键，同一件事改写时复用'),
        type: { type: 'string', enum: ['fact', 'appraisal', 'reflection'], description: '默认 fact' },
        op: { type: 'string', enum: ['add', 'update', 'delete', 'noop'], description: '默认 add；改正用 update+key；作废用 delete' },
        importance: num('0~1，默认 0.75'),
      }, ['text']),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            id: { type: 'string' },
            badge: { type: 'string' },
          },
        },
        render: (_a, v) => TEXT(
          (v && v.ok ? '已记 · ' : '未写入 · ')
          + (v && v.action ? v.action : '')
          + (v && v.badge ? ' · ' + v.badge : '')
          + (v && v.id ? ' · ' + v.id : '')
          + (v && v.reason ? ' · ' + v.reason : ''),
        ),
      },
      timeoutMs: 15000,
      presentCall: (args) => ({ card: 'generic', title: '记住 · ' + String((args && args.text) || '').slice(0, 24), kind: 'other', rawInput: args }),
      async execute(args) {
        const d = db()
        const a = aid()
        if (!d || !a) return { ok: false, reason: 'no agent' }
        return rememberFact(d, a, args || {})
      },
    },
    {
      name: 'act_send',
      description:
        '真正发一条消息出去（微信 / 企业微信 / QQ）。只有用户在设置里打开「发消息」接口后才能用。'
        + 'channel：wechat=个人微信（在本机微信窗口里操作，需要已登录）、wecom=企业微信群机器人、'
        + 'qq=QQ（走本机 OneBot 网关，target 填 QQ 号或群号）、auto=按设置里的默认通道。'
        + 'target 是联系人/群名；个人微信会要求在搜索结果里看到完全同名的联系人才发，避免发错人。'
        + '发之前先确认收件人和内容，不确定就问用户，不要猜。',
      parameters: schema({
        channel: { type: 'string', enum: ['wechat', 'wecom', 'qq', 'auto'], description: '通道' },
        target: str('收件人：微信联系人名 / QQ 号 / QQ 群号；wecom 可省略'),
        text: str('消息正文'),
      }, ['text']),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, channel: { type: 'string' }, target: { type: 'string' }, status: { type: 'string' }, detail: { type: 'string' } } },
        render: (_a, v) => TEXT('已发出 · ' + (v.channel || '') + (v.target ? ' → ' + v.target : '') + '\n' + (v.detail || '')),
      },
      timeoutMs: 90000,
      presentCall: (args) => ({ card: 'generic', title: '发消息 · ' + (args.target || args.channel || ''), kind: 'other', rawInput: args }),
      async execute(args) {
        const { db: d, aid: a } = await toolGate('send_message')(db, aid)
        return executeSend(d, a, args || {})
      },
    },
    {
      name: 'act_browse',
      description:
        '查资料或刷 B 站。mode：search=通用网页检索（不限 B 站，返回标题/链接/摘要）；url=抓一个网页的正文；'
        + 'bilibili_search=按关键词搜视频；bilibili_feed=看首页推荐/热门；bilibili_video=看一个视频的详情和高赞评论。'
        + '需要用户打开「浏览」接口。只读，不会自动改任何东西。',
      parameters: schema({
        mode: { type: 'string', enum: ['search', 'url', 'bilibili_search', 'bilibili_feed', 'bilibili_video'], description: '模式' },
        url: str('mode=url 时的网址'),
        query: str('mode=search / bilibili_search 时的关键词'),
        bvid: str('mode=bilibili_video 时的 BV 号'),
        limit: num('返回条数，1–30，默认 10'),
        order: { type: 'string', enum: ['totalrank', 'click', 'pubdate', 'dm', 'stow'], description: 'B 站搜索排序' },
      }, ['mode']),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, mode: { type: 'string' } } },
        render: (_a, v) => {
          if (!v) return TEXT('没有结果')
          if (v.mode === 'url') return TEXT((v.title ? v.title + '\n' : '') + (v.text || '').slice(0, 6000))
          if (v.mode === 'search') {
            const head = v.answer ? v.answer + '\n\n' : ''
            return TEXT(head + (v.items || []).map((it, i) => (i + 1) + '. ' + it.title + '\n   ' + it.url
              + (it.snippet ? '\n   ' + it.snippet : '')).join('\n')).slice(0, 7000)
          }
          if (v.mode === 'bilibili_video') {
            const d = v.video || {}
            return TEXT([
              d.title, d.author + ' · ' + d.url, '播放 ' + (d.stat && d.stat.view) + ' / 评论 ' + (d.stat && d.stat.reply),
              String(d.description || '').slice(0, 800),
              '',
              '高赞评论：',
              ...(v.comments || []).slice(0, 8).map((c) => '· ' + c.author + '：' + c.text.slice(0, 140)),
            ].join('\n'))
          }
          return TEXT((v.items || []).map((it, i) => (i + 1) + '. ' + it.title + ' — ' + it.author
            + ' · 播放 ' + (it.stat && it.stat.view) + ' · ' + it.duration + '\n   ' + it.url).join('\n') || '没有结果')
        },
      },
      timeoutMs: 90000,
      presentCall: (args) => ({ card: 'generic', title: '浏览 · ' + (args.query || args.url || args.bvid || args.mode), kind: 'fetch', rawInput: args }),
      async execute(args) {
        const { db: d, aid: a } = await toolGate('browse')(db, aid)
        return executeBrowse(d, a, args || {}, { web: web(), signal: undefined })
      },
    },
    {
      name: 'act_comment',
      description:
        '在一个公开视频下面发评论（目前支持 B 站）。这是公开、不可撤回的写操作：只有用户明确说「发这条评论」才调用，'
        + '内容要用户先看过。需要「发消息」接口开启，并配置带 SESSDATA + bili_jct 的 B 站 Cookie。'
        + 'target 填 BV 号；text 是评论正文（≤800 字）。',
      parameters: schema({
        platform: { type: 'string', enum: ['bilibili'], description: '平台，目前只有 bilibili' },
        target: str('视频 BV 号，例如 BV1xx411c7mD'),
        text: str('评论正文，最多 800 字'),
      }, ['target', 'text']),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, target: { type: 'string' }, rpid: { type: 'string' }, url: { type: 'string' } } },
        render: (_a, v) => TEXT('评论已发出：' + (v.url || v.target || '') + (v.rpid ? '\n评论 id ' + v.rpid : '')),
      },
      timeoutMs: 60000,
      presentCall: (args) => ({ card: 'generic', title: '发评论 · ' + (args.target || ''), kind: 'other', rawInput: args }),
      async execute(args) {
        const { db: d, aid: a } = await toolGate('send_message')(db, aid)
        return executeComment(d, a, args || {})
      },
    },
    {
      name: 'act_research',
      description:
        '给一个题目和目的，自己多轮检索、去重、抓正文、按来源可信度交叉印证，写一份带 [S#] 引用的中文报告。'
        + '会跳过最近读过的同一 URL，不会把旧料当新发现。'
        + 'depth：quick=一轮 5 个来源；standard=两轮约 9 个；deep=三轮约 14 个（更慢、token 更多）。'
        + '需要用户打开「研究搜集」接口。适合「尽量多搜集某方面信息、还要判断可不可信/能不能做」的任务。',
      parameters: schema({
        topic: str('研究主题'),
        goal: str('想拿它来干什么（会写进报告的结论和可行性部分）'),
        depth: { type: 'string', enum: ['quick', 'standard', 'deep'], description: '深度' },
        aspects: { type: 'array', items: { type: 'string' }, description: '特别想覆盖的角度，例如 ["成本","监管"]' },
        max_sources: num('最多抓多少个来源，3–24'),
      }, ['topic']),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, run_id: { type: 'string' }, report: { type: 'string' } } },
        render: (_a, v) => TEXT((v && v.report ? v.report : '没有报告').slice(0, 16000)),
      },
      timeoutMs: 420000,
      presentCall: (args) => ({ card: 'generic', title: '研究 · ' + (args.topic || ''), kind: 'fetch', rawInput: args }),
      async execute(args) {
        const { db: d, aid: a } = await toolGate('research')(db, aid)
        return executeResearch(d, a, args || {}, { web: web(), model: model() })
      },
    },
    {
      name: 'act_remind',
      description: '把一件事放进用户的收件箱（可带到期时间）。这是「提醒」接口，不会发微信/QQ；要发消息用 act_send。',
      parameters: schema({
        text: str('提醒什么'),
        at: str('可选，ISO 时间，例如 2026-11-01T09:00:00+08:00'),
      }, ['text']),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, inbox_id: { type: 'string' } } },
        render: (_a, v) => TEXT('已放进收件箱：' + (v.text || '') + (v.at ? '（' + v.at + '）' : '')),
      },
      timeoutMs: 20000,
      presentCall: (args) => ({ card: 'generic', title: '提醒 · ' + (args.text || ''), kind: 'other', rawInput: args }),
      async execute(args) {
        const { db: d, aid: a } = await toolGate('remind')(db, aid)
        return executeRemind(d, a, args || {})
      },
    },
  ]
}

// ---------------- 界面入口 ----------------

export { getConfig, saveConfig, publicConfig, channelStatus, channelTest, biliStatus, listRuns, getRun }

// API 路由跑研究时需要宿主服务；index.js 在 apply 时注入。
let hostDeps = { getWeb: () => null, getModel: () => null }

export function attachActionDeps(deps) {
  hostDeps = { ...hostDeps, ...(deps || {}) }
}

export function currentDeps() {
  return {
    web: (() => { try { return hostDeps.getWeb() } catch { return null } })(),
    model: (() => { try { return hostDeps.getModel() } catch { return null } })(),
  }
}

export async function testChannel(db, agentId, body) {
  // P4.5：关端口不能真发；强制 dry-run，且要过 send_message 闸门
  requirePort(db, agentId, 'send_message')
  const req = { ...(body || {}), dryRun: true }
  return channelTest(db, agentId, req)
}
