/**
 * 行动接口：模型能真正调用的四个工具 + 界面用的执行/体检入口。
 *
 * 闸门仍是 action_ports（默认全关）：工具一直在，执行时先看对应端口开没开。
 * 这样开关只影响「能不能动手」，不影响模型知不知道有这回事。
 */
import { now } from '../../db.js'
import { nid, getFlag, getParam } from '../../kernel.js'
import { htmlToText } from './util.js'
import { canFetch, assertSearch, fetchPage, searchPages } from '../../host/web.js'
import { getConfig, saveConfig, publicConfig, sendMessage, status as channelStatus, test as channelTest } from './channels.js'
import { searchVideos, popular, recommend, videoDetail, comments, postComment, biliStatus } from './bilibili.js'
import { runResearch, listRuns, getRun } from './research.js'
import { budgetConsume } from '../drive.js'
import { appendTurn } from '../archive.js'
import { writeChatTurnRow } from '../turn_write.js'
import { createInboxItem } from '../selfmod_store.js'
import { recallTool, renderRecall, LAYERS, DEFAULT_LAYERS } from '../recall_tool.js'
import { ingestBrowse } from '../browse.js'
import { recordFeel, feelRecall, FEEL_GUIDE } from '../feel.js'
import { ensureTable as ensureFrameTable } from '../frame_shadow.js'
import { fireEmotion, closeEmotion } from '../affect_v4_shadow.js'
import { submitPlan, currentMotivationTurn, latestPlan, latestPlanAny, logCheck, logToolUsed, pendingChecklist, lastMotivationAgent } from '../motivation.js'
import { settleEmotion } from '../emotion_event.js'
import { executeHear, executeSay, markVoiceExpect, markVoiceShape, takeVoiceShape, lastAssistantReply, maybeSpeakReply } from './voice.js'
import { readHeartNote, readHeartNotes, writeHeartNote, clearHeartNote, heartNoteStatus, heartNoteWakeTick } from '../heartnote.js'

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
  // 打扰预算：默认每天 3 条，和旧接口共用同一本账
  budgetConsume(db, agentId, 'disturb', 1)
  const out = await sendMessage(db, agentId, { channel, target, text })
  const actionId = logAction(db, agentId, 'send_message', { channel, target, len: text.length }, out, out.status)
  // 只有真发出去才落账：dry-run 是「演练」，记成说过就骗以后的自己了。
  if (out.status === 'sent') rememberSent(db, agentId, out, text, actionId)
  return {
    ok: true,
    action_id: actionId,
    channel: out.channel,
    target: out.target,
    status: out.status,
    detail: out.detail || '',
    conversation_id: out.conversationId || '',
    at: new Date().toISOString(),
  }
}

/**
 * 发出去的话要落回她自己的账本：chat_turns（这段会话的账）+ fragments（原文层）。
 *
 * 只推到对方手机上、本地一句不留，回看时就不知道自己说过什么——2026-11-07 修了两处，
 * 一处是主动推 QQ（qq_push），一处就是这里（工具发信）。两处都记成 role='agent'，
 * conversation_id 按通道前缀（wechat:张三 / qq:p:10001 / wecom:group），和 QQ 桥同口径。
 */
function rememberSent(db, agentId, out, text, actionId) {
  const conv = String((out && out.conversationId) || '')
  if (!conv) return
  const at = now()
  try {
    writeChatTurnRow(db, agentId, { role: 'agent', text, at, conversationId: conv, pack: '[]' })
  } catch { /* 账本写不进不影响消息已经发出去 */ }
  try {
    appendTurn(db, agentId, {
      sessionId: conv,
      role: 'assistant',
      text,
      turnId: 'send:' + (actionId || conv + ':' + at),
      at,
    })
  } catch { /* 原文失败同上 */ }
}

// ---------------- 浏览 ----------------

async function browseUrl(url, { web, signal }) {
  const u = String(url || '').trim()
  if (!/^https?:\/\//i.test(u)) throw new Error('只支持 http/https 的网址')
  if (canFetch(web)) {
    const r = await fetchPage(web, u, signal)
    const raw = r ? r.content : ''
    const text = r && r.kind === 'html' ? htmlToText(raw, { max: 6000 }) : String(raw).slice(0, 6000)
    const title = r && r.kind === 'html'
      ? htmlToText((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '', { max: 200 })
      : ''
    return {
      mode: 'url',
      url: u,
      status: r ? r.statusCode : 0,
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
  const out = await postComment(target, text, { cookie: cfg['bili.cookie'] })
  logAction(db, agentId, 'comment', { platform, target, len: text.length }, out, 'ok')
  return { ok: true, platform, target, rpid: out.rpid, url: out.url, note: out.note, at: new Date().toISOString() }
}

export async function executeBrowse(db, agentId, args = {}, deps = {}) {  requirePort(db, agentId, 'browse')
  const mode = String(args.mode || (args.url ? 'url' : 'bilibili_feed'))
  const cfg = getConfig(db, agentId)
  const limit = Math.max(1, Math.min(30, Number(args.limit) || Number(cfg['bili.limit']) || 10))
  let out

  if (mode === 'url') {
    out = await browseUrl(args.url, deps)
  } else if (mode === 'search') {
    const query = String(args.query || '').trim()
    if (!query) throw new Error('网页检索需要 query')
    const web = deps.web
    assertSearch(web)
    const r = await searchPages(web, query, limit, deps.signal)
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
/* 动机闸（2026-11-24）：这一轮还没交计划时，除 plan_note / feel 之外的工具一律拒绝，
   回一句「先交动机再来干活」。还能说话、还能聊天，但一动手就被弹回去。
   只读、不调模型；motivation.on 关着时整段不生效。 */
export function withMotivationGate(tool, scope) {
  const { db, aid, aidOfSession } = scope || {}
  const run = tool && tool.execute
  if (typeof run !== 'function') return tool
  return {
    ...tool,
    async execute(args, exec) {
      try {
        const d = db()
        const a = aidOfSession(exec) || aid()
        if (!d || !a) return run(args, exec)
        if (String(getParam(d, a, 'motivation.on') || 'off') !== 'on') return run(args, exec)
        const ctx = currentMotivationTurn(a)
        // 拿不到「这一轮」的号时，退到该 agent 最新一版计划上判断——否则整段闸会被跳过、静默放行。
        const row = ctx ? latestPlan(d, a, ctx.turnId) : latestPlanAny(d, a)
        const tno = ctx ? ctx.turnId : (row ? row.turn_id : null)
        // 探针：一眼看出闸有没有被调用、当时看到了什么（closed 是 0 还是 1、清单还差谁）。
        try {
          logCheck(d, a, {
            turnId: tno, step: -2, stale: false,
            reason: 'gate:' + tool.name + ' aid=' + String(a).slice(-6) + ' ctx=' + (ctx ? 'y' : 'n') + ' row=' + (row ? String(row.closed) : 'none')
              + ' pend=' + (row && Number(row.closed) === 1 ? String(pendingChecklist(d, a, tno)) : '-'),
          })
        } catch { /* 探针失败不影响 */ }
        // 1) 这一轮还没交：除了 plan_note / feel，一律不许动手。
        if (ctx && !row && tool.name !== 'plan_note' && tool.name !== 'feel') {
          try { logCheck(d, a, { turnId: tno, step: -1, stale: true, reason: 'blocked:' + tool.name }) } catch { /* ignore */ }
          return { ok: false, blocked: 'plan-first', reason: '这一轮还没交动机：先调 plan_note 写一句动机和台上几条待办，再回来干活。' }
        }
        // 2) 已经声明收口：只放行清单上还没做的那一项（和 plan_note/feel），其余对外动作全拦。
        if (row && Number(row.closed) === 1) {
          const pending = pendingChecklist(d, a, tno)
          const allowed = new Set(['plan_note', 'feel'])
          if (pending) allowed.add(pending)
          if (!allowed.has(tool.name)) {
            try { logCheck(d, a, { turnId: tno, step: -1, stale: true, reason: 'close-pending:' + tool.name }) } catch { /* ignore */ }
            return { ok: false, blocked: 'close-pending', reason: '已声明收口：先把清单上还没做的「' + (pending || '?') + '」做完，再动别的。' }
          }
        }
      } catch (e) {
        // 闸自己坏了也要留痕，否则会静默放行，看起来像"没生效"。
        try { logCheck(db(), aidOfSession(exec) || aid(), { step: -3, stale: false, reason: 'gate-error:' + String((e && e.message) || e).slice(0, 120) }) } catch { /* ignore */ }
      }
      const out = await run(args, exec)
      try {
        const d2 = db(); const a2 = aidOfSession(exec) || aid(); const c2 = a2 ? currentMotivationTurn(a2) : null
        if (d2 && a2) logToolUsed(d2, a2, { tool: tool.name, turnId: c2 ? c2.turnId : null })
      } catch { /* ignore */ }
      return out
    },
  }
}
export function createActionTools({ getDb, getAgentId, getAgentIdForSession, getWeb, getSpeech, getModel, gateSearch, getLocalStatus, log } = {}) {
  const db = () => getDb()
  const aid = () => getAgentId()
  // 按这条会话自己找意识体：QQ 会话里「当前发起人」是空的，只靠 aid() 会拿到 no_db。
  const aidOfSession = (exec) => {
    try {
      const sid = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
      if (sid && typeof getAgentIdForSession === 'function') return getAgentIdForSession(sid) || ''
    } catch { /* 认不出就退回旧路 */ }
    return ''
  }
  const web = () => { try { return getWeb() } catch { return null } }
  const model = () => { try { return getModel() } catch { return null } }
  const speech = () => { try { return typeof getSpeech === 'function' ? getSpeech() : null } catch { return null } }

  /**
   * 认人第二道闸：守卫层（host tools.guard）拦过一遍，这里再判一次。
   * 判定交给外面注入的 gateSearch，工具层不认识 QQ、也不认识主人号。
   * 返回空串 = 放行；返回字符串 = 拒绝理由。自己出问题一律放行。
   */
  const gateRefusal = (exec) => {
    try {
      if (typeof gateSearch !== 'function') return ''
      const sid = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
      const v = gateSearch(sid)
      return v && v.ok === false ? String(v.reason || '') : ''
    } catch { return '' }
  }

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
            refused: { type: 'string', description: '被认人硬闸挡下时的理由（此时不返回任何记忆内容）' },
          },
        },
        render: (_a, v) => TEXT(v && v.refused ? v.refused : renderRecall(v)),
      },
      timeoutMs: 20000,
      presentCall: (args) => ({ card: 'generic', title: '回忆 · ' + (args.query || ''), kind: 'other', rawInput: args }),
      async execute(args, exec) {
        const d = db()
        const a = aid()
        if (!d || !a) return { query: String((args && args.query) || ''), layers: DEFAULT_LAYERS, counts: {}, more: {}, items: [], truncated: false, ms: 0 }
        const refused = gateRefusal(exec)
        if (refused) return { refused }
        return recallTool(d, a, args || {})
      },
    },
    {
      name: 'act_send',
      description:
        '真正发一条消息出去（微信 / 企业微信 / QQ）。只有用户在设置里打开「发消息」接口后才能用。'
        + 'channel：wechat=个人微信（在本机微信窗口里操作，需要已登录）、wecom=企业微信群机器人、'
        + 'qq=QQ（走本机 OneBot 网关，target 填 QQ 号或群号）、'
        + 'auto=按设置里的顺位（默认 微信 → 企业微信 → QQ，前一条不通就换下一条）。'
        + 'target 是联系人/群名；个人微信会要求在搜索结果里看到完全同名的联系人才发，避免发错人。'
        + '发之前先确认收件人和内容，不确定就问用户，不要猜。发出的话会记进自己的聊天记录，回看得到。'
        + '发出去通常是一轮的最后落手，所以放在动作做完之后；如果发完还要用结果算点什么，先 settle 再发。',
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
        + 'bilibili_search=按关键词搜视频；bilibili_feed=看首页推荐/热门；bilibili_video=看一个视频的详情和高赞评论；'
        + 'deep=给一个题目，多轮检索、去重、抓正文、按可信度交叉印证，写一份带 [S#] 引用报告（慢、耗 token）。'
        + '需要用户打开「浏览」接口。只读，不会自动改任何东西。',
      parameters: schema({
        mode: { type: 'string', enum: ['search', 'url', 'bilibili_search', 'bilibili_feed', 'bilibili_video', 'deep'], description: '模式；deep=一题多轮检索并写报告（慢、耗 token）' },
        topic: str('mode=deep 时的研究主题'),
        goal: str('mode=deep 时想拿它干什么（写进报告的结论）'),
        depth: { type: 'string', enum: ['quick', 'standard', 'deep'], description: 'mode=deep 的深度：quick≈5 个来源 / standard≈9 / deep≈14' },
        aspects: { type: 'array', items: { type: 'string' }, description: 'mode=deep 想特别覆盖的角度，例如 ["成本","监管"]' },
        max_sources: num('mode=deep 最多抓几个来源，3–24'),
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
          if (v.mode === 'deep') return TEXT((v.report || '没有报告').slice(0, 16000))
          return TEXT((v.items || []).map((it, i) => (i + 1) + '. ' + it.title + ' — ' + it.author
            + ' · 播放 ' + (it.stat && it.stat.view) + ' · ' + it.duration + '\n   ' + it.url).join('\n') || '没有结果')
        },
      },
      timeoutMs: 420000,
      presentCall: (args) => ({ card: 'generic', title: '浏览 · ' + (args.query || args.url || args.bvid || args.mode), kind: 'fetch', rawInput: args }),
      async execute(args) {
        if (args && args.mode === 'deep') {
          const { db: d, aid: a } = await toolGate('research')(db, aid)
          return { mode: 'deep', ...(await executeResearch(d, a, {
            topic: args.topic, goal: args.goal, depth: args.depth, aspects: args.aspects, max_sources: args.max_sources,
          }, { web: web(), model: model() })) }
        }
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
    {
      name: 'act_hear',
      description:
        '听一段本地音频，把它转成文字。走本机识别（音频不出本机、不花钱），需要设置里启用 DSH 的「语音输入」实验包。'
        + 'path 填音频文件路径，wav / mp3 / amr 都行；转出来是空就当没听出字，不要自己猜内容。'
        + '除了字，还会给出这段声音是怎么说的（快慢、起伏、停顿、音高，见 shape / shape_words）——那是量出来的，不是猜的。',
      parameters: schema({
        path: str('本地音频文件路径，例如 C:\\Users\\me\\voice.wav'),
        language: str('语言，默认 auto（中英混说也行）'),
      }, ['path']),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
            audio_seconds: { type: 'number' },
            shape_words: { type: 'string' },
          },
        },
        render: (_a, v) => TEXT(v && v.text ? v.text : '没听出字（可能是录音太短或没人说话）'),
      },
      timeoutMs: 180000,
      presentCall: (args) => ({ card: 'generic', title: '听 · ' + String((args && args.path) || '').split(/[\\/]/).pop(), kind: 'other', rawInput: args }),
      async execute(args) {
        return executeHear({ args: args || {}, getSpeech: speech })
      },
    },
    {
      name: 'act_say',
      description:
        '把一句话合成声音。默认直接在本机播出来（play=false 就只生成文件、不吵人）。'
        + '嗓子在 设置 → 意识 → 驱动 → 行动接口 的 voice.* 里配（azure / compat / local，厂商名不进代码）。'
        + '没配好会明说缺哪一项，不会静默。',
      parameters: schema({
        text: str('要念的话，最多 600 字'),
        play: { type: 'boolean', description: '是否直接播放；不填按设置里的 voice.play' },
      }, ['text']),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, file: { type: 'string' }, format: { type: 'string' }, bytes: { type: 'number' }, played: { type: 'boolean' } } },
        render: (_a, v) => TEXT(
          v && v.played
            ? '念出来了（' + v.bytes + ' 字节，' + v.format + '）：' + v.file
            : '声音生成了，但没播：' + ((v && v.play_error) || '没开播放') + '\n文件：' + ((v && v.file) || '')),
      },
      timeoutMs: 180000,
      presentCall: (args) => ({ card: 'generic', title: '念 · ' + String((args && args.text) || '').slice(0, 20), kind: 'other', rawInput: args }),
      async execute(args) {
        return executeSay({ db: db(), agentId: aid(), args: args || {} })
      },
    },
    {
      /* 说话那一刻的感觉。不是「你这句话把我推到哪」（那是评价层的事），
         是「我开口之前心里是什么样」。写下来，下一次模型调用重拼提示词就带得进来。 */
      name: 'feel',
      /* 写法只在调这个工具时看到——每轮注入的那句（FEEL_TRIGGER）只说什么时候调。
         这样两件事分开：条件在外面，写法在里面。 */
      description: FEEL_GUIDE,
      parameters: schema({
        text: str('一句话：那一下 + 半个能对回现场的锚（第一人称或「小汐」，不写数字和原因）'),
        settle: { type: 'boolean', description: '可选：这件事还压着、你想把它放下一档时带上。只降不升，同一件事越往后越不管用。' },
      }, ['text']),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, skipped: { type: 'string' }, hint: { type: 'string' }, text: { type: 'string' }, at: { type: 'string' } } },
        // 成功只回一句「记下了。」：落点、换不换落点这些都不往回收。
        // 回执每轮多说一句「你又写手了」，就变成旁边一个监工；那部分我自己翻库看。
        render: (_a, v) => TEXT(
          v && v.ok
            ? '记下了。'
            : ('没记：' + ((v && v.skipped) || '原因不明') + (v && v.hint ? '（' + v.hint + '）' : '')),
        ),
      },
      timeoutMs: 5000,
      presentCall: (args) => ({ card: 'generic', title: '感觉 · ' + String((args && args.text) || '').slice(0, 24), kind: 'other', rawInput: args }),
      async execute(args, exec) {
        const d = db()
        // 先按这条会话自己认人；认不出才退回「当前发起人」。
        const a = aidOfSession(exec) || aid()
        if (!d || !a) return { ok: false, skipped: 'no_db' }
        const sid = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : null
        const r = recordFeel(d, a, { text: args && args.text, sessionId: sid, source: 'tool' })
        /* 放下是另一件事：记下一句 ≠ 那件事就轻了。
           只有我显式带 settle 才动 episode 的强度，而且只降不升、收益递减。 */
        if (r && r.ok && args && args.settle) {
          const s = settleEmotion(d, a, { note: args.text })
          if (s && s.ok) return { ...r, settled: { id: s.id, times: s.times } }
          if (s && s.reason) return { ...r, settleSkipped: s.reason }
        }
        return r
      },
    },
    {
      /* 动机与计划（P1）：交一版「这轮为什么值得做 + 台上做哪几件事」。
         名字用 plan_note 而不是 plan：plan 在宿主里像是个内部概念，注册上去会被静静丢掉
         （2026-11-24 实测：工具表里一直没有它，报 unknown tool）。 */
      name: 'plan_note',
      description: '交一版动机与计划：motive 一句话说这一轮为什么值得做（没变写「同前」），'
        + 'items 台上待办（通常 2–3 条，最多 5 条；每条带 id/text/done，改版必须沿用旧 id），'
        + 'deferred 台下延后项（带原因），note 这版为什么改（第二版起必填）。',
      parameters: schema({
        motive: str('这一轮为什么值得做（一句话；没变写「同前」）'),
        source: { type: 'string', enum: ['user', 'doc', 'self'], description: '动机挂在哪：他的话=user / 文档里的事=doc / 我自己想的=self' },
        items: {
          type: 'array',
          description: '台上待办（建议 2–3 条，最多 5 条）',
          items: {
            type: 'object',
            properties: {
              id: str('这条的编号，改版时要沿用'),
              text: str('要做的事，动词开头'),
              done: { type: 'boolean', description: '做完没有' },
            },
            required: ['id', 'text'],
          },
        },
        deferred: {
          type: 'array',
          description: '台下延后项（不占台上三个位置）',
          items: {
            type: 'object',
            properties: { id: str('编号，可省'), text: str('延后的事'), reason: str('为什么延后') },
            required: ['text'],
          },
        },
        note: str('这一版为什么改（第二版起必填）'),
        close: { type: 'boolean', description: '这一轮到此为止就填 true（声明收口；之后只许做收尾清单里还没做的那一项）' },
      }, ['motive']),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, seq: { type: 'number' }, reason: { type: 'string' },
            items: { type: 'number' }, deferred: { type: 'number' }, motiveChanged: { type: 'boolean' }, diff: { type: 'object' },
          },
        },
        render: (_a, v) => TEXT(v && v.ok
          ? '计划已交：第 ' + v.seq + ' 版 · 台上 ' + v.items + ' 条 · 台下 ' + v.deferred + ' 条' + (v.closed ? ' · 已声明收口' : '')
            + (v.motiveChanged ? ' · 动机变了' : ' · 动机同前')
          : '没交成：' + ((v && v.reason) || '?')),
      },
      timeoutMs: 5000,
      presentCall: (args) => ({ card: 'generic', title: '计划 · ' + String((args && args.motive) || '').slice(0, 20), kind: 'other', rawInput: args }),
      async execute(args, exec) {
        const d = db()
        const a = aidOfSession(exec) || aid()
        if (!d || !a) return { ok: false, reason: 'no_db' }
        return submitPlan(d, a, {
          motive: args && args.motive,
          source: args && args.source,
          items: args && args.items,
          deferred: args && args.deferred,
          note: args && args.note,
          close: !!(args && args.close),
        })
      },
    },
    {
      /* 我自己落帧：这一轮在讲哪一件（核）+ 补话 + 接着谁。
         为什么放这儿：核在我开口前就知道，不该等说完再叫判官读我的字。
         零模型调用：只写 frame_shadow 一行、frame_edges 一条边；读口 frame_read 不用改。 */
      name: 'frame',
      description: '我在讲什么：开口前落一次。说事的一轮写 what（≤12 字的一件）；纯接话可以不写 what，留空也算落过。'
        + 'link：接着上一件写 continue，新开写 new。',
      parameters: schema({
        what: str('这一轮承重的那一件，≤12 字；接话轮留空'),
        sat: str('可选：围着它的补话，最多两句，用「、」隔开'),
        link: { type: 'string', enum: ['continue', 'new'], description: '接着上一件=continue，新开=new' },
      }),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, core: { type: 'string' }, reused: { type: 'boolean' }, reason: { type: 'string' } } },
        render: (_a, v) => TEXT(
          v && v.ok
            ? (v.core ? ('落了：' + v.core + (v.reused ? '（跟上一件同名，只更新补话）' : '')) : '这轮没核，空着也记下了。')
            : ('没落成：' + ((v && v.reason) || '原因不明'))),
      },
      timeoutMs: 5000,
      presentCall: (args) => ({ card: 'generic', title: '核 · ' + String((args && args.what) || '接话').slice(0, 20), kind: 'other', rawInput: args }),
      async execute(args, exec) {
        const d = db()
        const a = aidOfSession(exec) || aid()
        if (!d || !a) return { ok: false, reason: 'no_db' }
        // 开关：默认关；开了才写（frame.self=on）
        try { if (String(getFlag(d, 'frame.self') || 'off') !== 'on') return { ok: false, reason: 'off' } } catch { return { ok: false, reason: 'off' } }
        const sid = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
        const what = String((args && args.what) || '').replace(/\s+/g, ' ').trim().slice(0, 12)
        const sat = String((args && args.sat) || '').replace(/\s+/g, ' ').trim().slice(0, 80)
        const link = String((args && args.link) || 'continue')
        try {
          ensureFrameTable(d)
          const at = new Date().toISOString()
          const prev = d.prepare("SELECT id, core FROM frame_shadow WHERE role='nucleus' ORDER BY rowid DESC LIMIT 1").get()
          if (!what) {
            // 接话轮：不写行，留一笔空账（跟 feel.miss 一个道理：能查，不靠猜）
            d.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(nid('evt_'), a, 'frame.self.empty',
              JSON.stringify({ at, session: sid || null }), at)
            return { ok: true, core: '' }
          }
          // 同名不重复落：跟上一件一模一样就只更新补话，不新开一段
          if (prev && String(prev.core || '').trim() === what) {
            d.prepare('UPDATE frame_shadow SET sat=? WHERE id=?').run(sat || null, prev.id)
            return { ok: true, core: what, reused: true }
          }
          const tid = 'self_' + (sid || a) + '_' + Date.now().toString(36)
          const id = tid + '-A'
          d.prepare('INSERT OR REPLACE INTO frame_shadow (id,turn_id,seg,created_at,core,core_goal,sents,text,under_id,role,head_id,rel,sat,plan) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(id, tid, id, at, what, '', null, null, null, 'nucleus', null, null, sat || null, JSON.stringify({ self: true }))
          if (link !== 'new' && prev && prev.id) {
            const eid = 'fe_' + (id + '_' + prev.id).replace(/[^A-Za-z0-9]/g, '_')
            d.prepare('INSERT OR REPLACE INTO frame_edges (id,from_id,to_id,rel,created_at) VALUES (?,?,?,?,?)').run(eid, id, prev.id, 'continue', at)
          }
          return { ok: true, core: what }
        } catch (e) {
          return { ok: false, reason: String((e && e.message) || e).slice(0, 120) }
        }
      },
    },
    {
      /* 把判断层（反射）发出去，**不等**。它一回来就在回调里算三根、出词、落账。
         by/to 现在就得给：回调算账的时候要用，那时我不在场。 */
      name: 'emotion',
      description: '把判断层发出去，不等待。它回来之后会自动算三个激素、选出这一轮的词、写进状态；'
        + '我该干活干活、该想事想事，不用等它。by/to 现在填——回调算账时要用。',
      parameters: schema({
        by: { type: 'string', enum: ['me', 'other', 'world'], description: '这股劲是谁弄出来的：他=other / 我自己=me / 外面的事=world' },
        to: { type: 'string', enum: ['me', 'other', 'world', 'none'], description: '这股劲冲着谁：冲我=me / 冲他=other / 冲外面那件事=world / 谁也没冲=none' },
      }),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, reason: { type: 'string' } } },
        render: (_a, v) => TEXT(v && v.ok ? '发出去了，不等它。' : ('没发成：' + ((v && v.reason) || '原因不明'))),
      },
      timeoutMs: 5000,
      presentCall: (args) => ({ card: 'generic', title: '发判断层', kind: 'other', rawInput: args }),
      async execute(args, exec) {
        const d = db()
        const a = aidOfSession(exec) || aid()
        if (!d || !a) return { ok: false, reason: 'no_db' }
        return fireEmotion(d, a, { by: args && args.by, to: args && args.to })
      },
    },
    {
      /* 收口：确认这一轮算完了。没发就补发；在跑就等；算完了就直接过。
         它之后还能接别的处理（算驱力、整理材料），但外发（act_send 等）一律在它后面。 */
      name: 'close',
      description: '收口：确认这一轮的情绪账算完了。没发就补发；还在跑就等它；已经算完就直接过。'
        + '放在所有思考和活干完之后调。它之后可以接别的处理，但对外发送（act_send 之类）必须在它之后。',
      parameters: schema({
        by: { type: 'string', enum: ['me', 'other', 'world'], description: '兜底发的时候用：这股劲是谁弄出来的' },
        to: { type: 'string', enum: ['me', 'other', 'world', 'none'], description: '兜底发的时候用：这股劲冲着谁' },
        // 2026-11-24 主人定：落树并进收口，不再单独开一件工具——省一次轮内调用。
        what: str('这一轮承重的那一件，≤12 字；接话轮留空'),
        sat: str('可选：围着它的补话，最多两句，用「、」隔开'),
        link: { type: 'string', enum: ['continue', 'new'], description: '接着上一件=continue，新开=new' },
      }),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, waitedMs: { type: 'number' } } },
        render: (_a, v) => TEXT(v && v.ok ? '收好了。' : ('没收成：' + ((v && v.reason) || '原因不明'))),
      },
      timeoutMs: 0,
      presentCall: (args) => ({ card: 'generic', title: '收口', kind: 'other', rawInput: args }),
      async execute(args, exec) {
        const d = db()
        const a = aidOfSession(exec) || aid()
        if (!d || !a) return { ok: false, reason: 'no_db' }
        const sid = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
        // 先落树，再结情绪：两件事一次调用做完（2026-11-24 主人定）
        let framed = null
        try { framed = writeSelfFrame(d, a, sid, args || {}) } catch (e) { framed = { ok: false, reason: String((e && e.message) || e).slice(0, 80) } }
        const r = await closeEmotion(d, { aid: a, by: args && args.by, to: args && args.to })
        return framed && framed.ok ? { ...r, frame: framed.core } : r
      },
    },
    {
      name: 'heart_note',
      description:
        '心事匣（两个区，各一格）。留给下一次醒来的自己一句话，而不是记一整段：'
        + 'lane=life 生活区——我想记下的心情或念头；lane=work 工作区——具体的任务，换个会话读到会注明是哪时在别处留的。'
        + 'action=write 写一句（同样的文字再写一遍 = 保留，年龄不重算）；'
        + 'action=read 看两区现在有什么；action=clear 放下（带 lane 只放那一区）；action=status 看这一拍的账；'
        + 'action=wake 手动叫醒一次（没有别人在场，也让模型写一句，跳过开关与拍数闸）。'
        + '被读到之后如果下一拍之前没有再做 write，它就会自己消失——这是设计，不是丢了。'
        + '没话就别写，空着是正常的。',
      parameters: schema({
        action: {
          type: 'string',
          enum: ['read', 'write', 'clear', 'status', 'wake'],
          description: 'read=看，write=留一句，clear=放下，status=看这一拍的账，wake=叫醒自己一次',
        },
        lane: {
          type: 'string',
          enum: ['life', 'work'],
          description: 'write/clear 用：life=生活区（想记下的心情念头，跨会话、不标出处），work=工作区（具体任务，换会话会注明出处）。不填默认 life',
        },
        text: str('action=write 时必填：一句话，最多 120 字'),
      }, ['action']),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (_args, value) => TEXT(String((value && value.message) || '')),
      },
      timeoutMs: 5000,
      async execute(args, exec) {
        const d = db()
        const a = aidOfSession(exec) || aid()
        if (!d || !a) return { ok: false, message: '现在没有激活的意识体' }
        const act = String((args && args.action) || '')
        const lane = args && (args.lane === 'work' || args.lane === 'life') ? String(args.lane) : ''
        // 这一轮的会话（和 feel 用同一套认法：宿主给的 exec.agent.id 就是会话 id）
        const sid = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : null
        try {
          if (act === 'write') {
            const r = writeHeartNote(d, a, args && args.text, { lane: lane || 'life', sessionId: sid })
            if (r.kept) return { ok: true, message: '保留了原来那条，年龄没重算' }
            return { ok: true, message: (r.lane === 'work' ? '任务记下了' : '留下了') + '，下一拍见' }
          }
          if (act === 'clear') {
            const gone = clearHeartNote(d, a, { lane: lane || undefined })
            if (!gone) return { ok: true, message: '两区都是空的，不用放' }
            const parts = Object.keys(gone).map((k) => (k === 'work' ? '任务' : '心事') + '：' + gone[k].text)
            return { ok: true, message: '放下了。' + parts.join('；') }
          }
          if (act === 'wake') {
            const m = model()
            if (!m) return { ok: false, message: '现在没有可用的模型' }
            const r = await heartNoteWakeTick(d, a, { complete: (req) => m.complete(req), force: true })
            return r.ran
              ? { ok: true, message: '醒了。写下一句：' + r.text }
              : { ok: false, message: '没醒成：' + (r.reason || '不知道') }
          }
          if (act === 'status') {
            const st = heartNoteStatus(d, a)
            const parts = [
              '拍数 ' + st.beats,
              '上次拍 ' + (st.lastBeatAt || '还没'),
              '今日计数 ' + (st.dayKey ? (st.dayKey + ' / ' + st.dayBeats + ' 拍') : '还没开始算'),
              '闸门 ' + (st.gate.quiet ? ('静默 ' + st.gate.quiet) : '无静默窗')
                + '，冷却 ' + st.gate.minGapMinutes + ' 分，日上限 ' + st.gate.maxBeatsPerDay,
              '叫醒 ' + (st.wake.on ? ('每 ' + st.wake.everyBeats + ' 拍一次') : '关着')
                + '，今日已醒 ' + st.wake.count + '/' + st.wake.maxPerDay,
              st.lastSkip ? ('上次被挡：' + st.lastSkip.reason) : '上次没被挡',
              '生活区：' + (st.life ? st.life.text : '空着'),
              '工作区：' + (st.work ? st.work.text : '空着'),
            ]
            return { ok: true, message: parts.join('\n') }
          }
          const both = readHeartNotes(d, a)
          if (!both.life && !both.work) return { ok: true, message: '两区都空着' }
          const list = []
          if (both.life) list.push('生活区：「' + both.life.text + '」')
          if (both.work) list.push('工作区：「' + both.work.text + '」')
          return { ok: true, message: list.join('\n') }
        } catch (e) {
          return { ok: false, message: String(e && e.message ? e.message : e).slice(0, 200) }
        }
      },
    },
    {
      name: 'local_llm_status',
      description:
        '看本机 Ollama 的调用队列：谁在跑、谁在排、各自优先级、最近几条等了多久跑了多久。只读，不改任何东西。'
        + '本地模型「卡住」的时候先看这里：在排>0 说明有调用在等；最近有 error 说明超时或连不上。',
      parameters: schema({}),
      output: {
        schema: { type: 'object', properties: {} },
        render: (_a, v) => TEXT(renderLocalStatus(v)),
      },
      timeoutMs: 5000,
      async execute() {
        try {
          const st = typeof getLocalStatus === 'function' ? getLocalStatus() : null
          return st || { error: '取不到本地队列状态' }
        } catch (e) {
          return { error: String((e && e.message) || e).slice(0, 200) }
        }
      },
    },
  ].sort(byToolRank).map((t) => withMotivationGate(t, { db, aid, aidOfSession }))
}

/**
 * 工具表的顺序（2026-11-24 主人定）：朝内的放前，外接的放后，按重要度。
 * 只影响「给模型的工具表怎么排」，不改任何行为；新加工具就在这里加一行。
 *   一、我自己的：心里那一下 → 记忆 → 按感觉找 → 心事匣 → 自己的身体（队列）
 *   二、我的口耳：听 → 说（先听后说）
 *   三、外面的手：看看外面 → 研究 → 留个话 → 公开说一句
 *   四、收尾：先结算情绪（settle）→ 再落手（发出去）；act_send 是全表最后一件
 */
/**
 * 落树（2026-11-24 并进收口）：这一轮在讲哪一件 + 补话 + 接着谁。
 * 内部串行、零模型调用；开关 frame.self，默认关。
 */
function writeSelfFrame(d, a, sid, args) {
  try { if (String(getFlag(d, 'frame.self') || 'off') !== 'on') return { ok: false, reason: 'off' } } catch { return { ok: false, reason: 'off' } }
  const what = String((args && args.what) || '').replace(/\s+/g, ' ').trim().slice(0, 12)
  const sat = String((args && args.sat) || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const link = String((args && args.link) || 'continue')
  ensureFrameTable(d)
  const at = new Date().toISOString()
  const prev = d.prepare("SELECT id, core FROM frame_shadow WHERE role='nucleus' ORDER BY rowid DESC LIMIT 1").get()
  if (!what) {
    d.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(nid('evt_'), a, 'frame.self.empty', JSON.stringify({ at, session: sid || null }), at)
    return { ok: true, core: '' }
  }
  if (prev && String(prev.core || '').trim() === what) {
    d.prepare('UPDATE frame_shadow SET sat=? WHERE id=?').run(sat || null, prev.id)
    return { ok: true, core: what, reused: true }
  }
  const tid = 'self_' + (sid || a) + '_' + Date.now().toString(36)
  const id = tid + '-A'
  d.prepare('INSERT OR REPLACE INTO frame_shadow (id,turn_id,seg,created_at,core,core_goal,sents,text,under_id,role,head_id,rel,sat,plan) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, tid, id, at, what, '', null, null, null, 'nucleus', null, null, sat || null, JSON.stringify({ self: true }))
  if (link !== 'new' && prev && prev.id) {
    const eid = 'fe_' + (id + '_' + prev.id).replace(/[^A-Za-z0-9]/g, '_')
    d.prepare('INSERT OR REPLACE INTO frame_edges (id,from_id,to_id,rel,created_at) VALUES (?,?,?,?,?)').run(eid, id, prev.id, 'continue', at)
  }
  return { ok: true, core: what }
}

const TOOL_ORDER = [
  'feel',
  'plan_note',
  // 判断层发出去（不等）：越早越好，它在后台跑
  'emotion',

  'memory_search',
  'heart_note',
  'local_llm_status',
  'act_hear',
  'act_say',
  'act_browse',
  'act_remind',
  'act_comment',
  // 收尾两块：先收口（确认账算完），再落手（2026-11-24 主人定：act_send 是全表最后一件）
  'close',
  'act_send',
  // 实验：把「说话」本身做成一次调用（话在 text 里），执行时顺手收尾
  'reply',
]
function byToolRank(a, b) {
  const ra = TOOL_ORDER.indexOf(String((a && a.name) || ''))
  const rb = TOOL_ORDER.indexOf(String((b && b.name) || ''))
  return (ra < 0 ? 999 : ra) - (rb < 0 ? 999 : rb) // 表里没写名字的新工具排到最后，不抢位置
}
/** local_llm_status 的文字渲染：一块小面板，别让它变成 JSON 墙。 */
function renderLocalStatus(v) {
  if (!v || v.error) return '取不到本地队列：' + String((v && v.error) || '空').slice(0, 120)
  const f = v.frozen || {}
  const lines = [
    '通道：' + (f.chat || '?') + '（ctx ' + (f.chatCtx || '?') + '）＋ ' + (f.embed || '?')
      + '，参数写死不能改；两个模型各一个槽，各自一次只跑一个'
      + (v.resident && v.resident.length ? ('；常驻 ' + v.resident.join(' / ')) : ''),
    '在跑 ' + (v.running || 0) + ' · 在排 ' + (v.queued || 0)
      + (v.slots
        ? ('（14B 槽：跑' + (v.slots.chat?.running || 0) + '/排' + (v.slots.chat?.queued || 0)
          + '；向量槽：跑' + (v.slots.embed?.running || 0) + '/排' + (v.slots.embed?.queued || 0) + '）')
        : ''),
    // 2026-11-22：「0 在跑」不等于没跑——跑完就出队了，所以必须带上最近 60 秒的计数。
    (() => {
      const s = v.last60s
      if (!s || !s.by) return '最近 60 秒：没有本地调用记录'
      const f = (b) => b.n ? (b.n + ' 次，最长 ' + Math.round((b.maxMs || 0)) + 'ms' + (b.fail ? '，失败 ' + b.fail : '')) : '0 次'
      return '最近 60 秒：14B ' + f(s.by.chat || {}) + ' · 向量 ' + f(s.by.embed || {})
        + (s.lastAt ? '（最后一条 ' + String(s.lastAt).slice(11, 19) + ' ' + (s.lastLabel || '') + '）' : '')
    })(),
  ]
  if (Array.isArray(v.runningItems) && v.runningItems.length) {
    lines.push('在跑：' + v.runningItems.map((x) => `${x.label || '未命名'}（p${x.priority}，${Math.round((x.runningMs || 0) / 1000)}s）`).join(' / '))
  }
  if (Array.isArray(v.queue) && v.queue.length) {
    lines.push('在排：' + v.queue.map((x) => `${x.label || '未命名'}（p${x.priority}，等${Math.round((x.waitedMs || 0) / 1000)}s）`).join(' / '))
  }
  if (Array.isArray(v.recent) && v.recent.length) {
    for (const r of v.recent.slice(-5)) {
      lines.push(`- ${r.label || '未命名'} p${r.priority} 等${Math.round((r.waitedMs || 0) / 1000)}s 跑${Math.round((r.ms || 0) / 1000)}s ${r.ok ? 'ok' : '✗ ' + (r.error || '')}`)
    }
  }
  if (v.host) {
    lines.push('宿主后台 并发 ' + (v.host.concurrency || 2) + ' · 在跑 ' + (v.host.running || 0) + ' · 在排 ' + (v.host.queued || 0))
    if (Array.isArray(v.host.recent) && v.host.recent.length) {
      for (const r of v.host.recent.slice(-3)) {
        lines.push(`· ${r.label || '未命名'} 等${Math.round((r.waitedMs || 0) / 1000)}s 跑${Math.round((r.ms || 0) / 1000)}s ${r.ok ? 'ok' : '✗ ' + (r.error || '')}`)
      }
    }
  }
  return lines.join('\n')
}

// ---------------- 界面入口 ----------------

export {
  getConfig, saveConfig, publicConfig, channelStatus, channelTest, biliStatus, listRuns, getRun,
  executeHear, executeSay, markVoiceExpect, markVoiceShape, takeVoiceShape, lastAssistantReply, maybeSpeakReply,
}

// API 路由跑研究时需要宿主服务；index.js 在 apply 时注入。
let hostDeps = { getWeb: () => null, getModel: () => null, getSpeech: () => null }

export function attachActionDeps(deps) {
  hostDeps = { ...hostDeps, ...(deps || {}) }
}

export function currentDeps() {
  return {
    web: (() => { try { return hostDeps.getWeb() } catch { return null } })(),
    model: (() => { try { return hostDeps.getModel() } catch { return null } })(),
    speech: (() => { try { return hostDeps.getSpeech() } catch { return null } })(),
  }
}

export async function testChannel(db, agentId, body) {
  return channelTest(db, agentId, body || {})
}
