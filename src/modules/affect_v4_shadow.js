/**
 * 三递质情绪引擎 v4 · 事帧与判断层（影子写入器）
 *
 * 按《设计 · 三递质情绪引擎》§2 定稿的链，分三块：
 *
 * 一、影子表读写（affect_v4_shadow 只追加，一轮取 rowid 最大的一行）：
 *    - 规则行 source=rules（rev=1，毫秒）先落；模型行 source=model（rev=2）后补。
 *    - 会话隔离：材料、事、去重都按 conversation_id。
 *
 * 二、旧精修链 refineShadow（2026-11-16 影子期，业务已不再调用，保留给测试）：
 *    - 两次模型调用（事层 → 判断层），写第二行 model。
 *
 * 三、定稿链（2026-11-17）：
 *    - 上一轮回复结束后（异步）：summarizeAffairs —— 近十轮摘要收拢成一句「事」（≤50 字，不设下限）。
 *    - 这一轮回复生成前：appraiseTurnNow —— 拼事帧（事/材料/冲谁）→ 判断层（模型）→ S/N/D、8 角、二级词。
 *    - 判断层属于这一轮，回复前等这一次模型调用（1~2 秒）；本会话还没有「事」时先补一次总结。
 *
 * 纪律：失败静默、不拖对话；同一轮只允许一条最终结论；模型调用不走强制 JSON 接口（总结要自然语言）。
 */
import { getParam, getFlag, setFlag, clearFlag, model as kernelModel } from '../kernel.js'
// 2026-11-23：链的账（设计-链与块 v2）。只写账，不碰情绪计算。
import { beginRun, step, endRun } from './affect_chain.js'
import { infer, shouldCloseFrame, extendFrame, advanceState, deltasOf, applyShock, valenceOf, byAdjustedD } from '../algo/affect_v4.js'
import { localComplete } from './local_llm.js'
import { hostComplete } from './host_llm.js'
import { mark as markLoop } from './loop_watch.js'

const NEG = /讨厌|烦|错|差|生气|滚|闭嘴|笨|蠢|不行|不好|不对|别来|别这样|别再说|别动|别乱|又错|怎么又|还是不对|重做|催|快点|服了/
const POS = /喜欢|谢谢|夸|好|棒|开心|爱|感动|温柔|可爱|厉害|不错|真好|聪明|漂亮/
const ASK = /为什么|怎么|吗|呢|？|\?|能不能|可不可以|要不要/
const THREAT = /删|泄露|密码|越权|攻击|危险|威胁|滚/
const REQUEST = /帮我|请你|你帮我|改一下|重做|快点|再|继续|看看|试试|给我|去做/
const SUDDEN = /突然|居然|竟然|结果|但是|可是|没想到|一下子/
const LOW = /算了|不想说|不想聊|没意思|随便吧|唉|无所谓|懒得/

const clamp11 = (x) => Math.max(-1, Math.min(1, Number(x) || 0))
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))

/** 宿主/本地模型偶尔会在 JSON 外面包 ```json 或前后加一句说明——先整段解析，失败再截第一个 { 到最后一个 }。
 *  2026-11-17：宿主这路原来直接 JSON.parse，模型一不老实就解析失败、静默回退本地（6s 一次）。
 *  2026-11-21：输出被**截断**时（模型写到 why 半句就断了），整段里连一个 } 都没有，
 *  上面两路都救不回来，只能退规则——可 fact / meaning / 三个 delta 早就写好了。
 *  从根对象里最后一个「字符串外的逗号」切下去、补个 }，把已完成的字段留下来。why 丢了就不写 why。 */
function parseJsonLoose(s) {
  const t = String(s == null ? '' : s).trim()
  if (!t) return null
  try { return JSON.parse(t) } catch { /* 往下截 */ }
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i >= 0 && j > i) {
    try { return JSON.parse(t.slice(i, j + 1)) } catch { /* 还是不行就往下补 */ }
  }
  if (i >= 0) {
    const cut = lastTopLevelComma(t, i)
    if (cut > i) {
      try {
        const v = JSON.parse(t.slice(i, cut) + '}')
        if (v && typeof v === 'object' && !Array.isArray(v)) return v
      } catch { /* 补不上就 null */ }
    }
  }
  return null
}

/** 根对象里最后一个安全的字段分隔逗号（只在字符串外、且深度正好 1 时记）。
 *  返回 -1 = 没有可用切点（比如第一个字段就断了），那确实救不回来。 */
function lastTopLevelComma(t, from) {
  let depth = 0
  let inStr = false
  let esc = false
  let cut = -1
  for (let k = from; k < t.length; k++) {
    const c = t[k]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') { depth--; if (depth <= 0) return cut }
    else if (c === ',' && depth === 1) cut = k
  }
  return cut
}

/** 上一轮「我」说的那句话原话（整段取，不走被截断的材料）。
 *  事帧的 prev 该装的就是这个：要判断「我这轮心情不好，是不是因为上一轮我说了句硬话」，
 *  看的是我自己上一句说了什么，不是上一张卡片的编号。
 *  2026-11-20：之前这个格子要么写死 null、要么塞上一行的数据库主键，400 行全是空的。 */
/** 这一句是谁说的（2026-11-22）：只两值——「对方」或「我」。
 *  从 chat_turns 的 role 取（user=对方、agent=我）；拿不到就按「对方」（对话轮都是有人在说）。 */
function speakerOf(db, turnId) {
  try {
    if (turnId) {
      const r = db.prepare('SELECT role FROM chat_turns WHERE turn_id=? ORDER BY rowid DESC LIMIT 1').get(String(turnId))
      if (r) return String(r.role) === 'agent' ? '我' : '对方'
    }
  } catch { /* 查不到 */ }
  return '对方'
}

function lastAgentLine(db, aid, conversationId, excludeTurnId = null) {
  try {
    if (!conversationId) return null
    const sql = excludeTurnId
      ? "SELECT text FROM chat_turns WHERE agent_id IS ? AND conversation_id=? AND role='agent' AND text<>'' AND (turn_id IS NULL OR turn_id<>?) ORDER BY rowid DESC LIMIT 1"
      : "SELECT text FROM chat_turns WHERE agent_id IS ? AND conversation_id=? AND role='agent' AND text<>'' ORDER BY rowid DESC LIMIT 1"
    const r = excludeTurnId
      ? db.prepare(sql).get(aid ?? null, conversationId, excludeTurnId)
      : db.prepare(sql).get(aid ?? null, conversationId)
    const t = r ? String(r.text || '').replace(/\s+/g, ' ').trim() : ''
    return t ? t.slice(0, 300) : null
  } catch { return null }
}
function summaryOf(act) {
  const verb = {
    praise: '在夸我', criticize: '在批我', threat: '在威胁我',
    request: '在要求我', ask: '在问我', withdraw: '想退开', chat: '在闲聊',
  }[act] || '在说话'
  return '主人' + verb
}

/** 规则产「现状」：谁、做了什么、冲谁。判断（三个生存问题）在 rulesJudgment。 */
export function rulesFrameSlot(text = '') {
  const t = String(text || '')
  const threat = THREAT.test(t)
  const ask = ASK.test(t)
  const neg = NEG.test(t)
  const pos = POS.test(t)
  const req = REQUEST.test(t)
  const low = LOW.test(t)
  const directed = /你|您/.test(t)
  const target = directed ? 'me' : (t.includes('我') ? 'other' : 'none')
  const act = threat ? 'threat'
    : neg && !pos ? 'criticize'
    : pos && !neg ? 'praise'
    : low ? 'withdraw'
    : req ? 'request'
    : ask ? 'ask'
    : 'chat'
  return {
    act,
    summary: summaryOf(act),
    what: t.replace(/\s+/g, ' ').slice(0, 60),
    who: 'owner',
    target,
    by: target === 'me' ? 'other' : (t.includes('我') ? 'me' : 'world'),
  }
}

/** 规则回答三个生存问题：只给方向和幅度，不掺 control / certainty。
 *  刻度照思路 §2.2：0 预料内 / 0.3 有点新 / 0.7 明显意外 / 1 震惊。
 *  2026-11-17：原来 ask / request 一律 0.5，问号一出现就「惊」；普通提问只是 0.15。 */
export function rulesJudgment(act) {
  const expected = {
    threat: 0.9, criticize: 0.45, request: 0.3, praise: 0.3,
    withdraw: 0.2, ask: 0.15, chat: 0.1,
  }[act]
  const goal_cong = act === 'threat' ? -0.8 : act === 'criticize' ? -0.6 : act === 'praise' ? 0.6 : act === 'withdraw' ? -0.35 : act === 'request' ? -0.2 : 0
  const expectation = Number.isFinite(expected) ? expected : 0.15
  const future = act === 'threat' ? -0.8 : act === 'criticize' ? -0.4 : act === 'praise' ? 0.4 : act === 'withdraw' ? -0.4 : 0
  // 2026-11-22 主人定：**不许任何代码 / 规则兜底**。
  // 这里只给「垫底的临时行」用，不当结论；判断层缺参数就报警、不补。
  // （当天加过一版「按 target 推 by」，被主人否了：兜底就是骗人。）
  return {
    // 旧路（recordShadow / refineShadow）仍按「位置」读这三个数，原样保留。
    goal_cong,
    expectation,
    future,
    // 新路（appraiseTurnNow 增量模式）读这三个：同一套规则，当成「这一下推多少」。
    goal_delta: goal_cong,
    expect_delta: expectation,
    future_delta: future,
    why: '规则关键词判为 ' + String(act || 'chat'),
    from: '这一句',
  }
}

// 2026-11-19 主人定：原话只留最近 2 句（一来一回，够判语气就停），
// 更早的走摘要（近 10 轮、每轮一句 ≤30 字，本来就不长）。
// 原来是 6 句 × 120 字 = 最多 720 字，占掉判断层输入的大半。
const MATERIAL_QUOTES = 5 // 捞 5 条 + 当前这一句 = 拼出来的「最近原话」正好 6 条
const MATERIAL_SUMMARIES = 10

/**
 * 材料：这一轮原话 + 最近几轮原话 + 近 10 轮摘要（每轮的 summary）。
 * 冷启动没有就空数组，不编；这一句不在聊天账里时补上。
 * 2026-11-17 会话隔离：传了 conversationId 就只看本会话。
 */
export function buildMaterial(db, aid, text = '', { quotes = MATERIAL_QUOTES, summaries = MATERIAL_SUMMARIES, conversationId = null } = {}) {
  const out = { quotes: [], summaries: [], lines: [] }
  const cid = conversationId ? String(conversationId) : ''
  let oldestQuoteAt = null // 原话覆盖到的最老那句的时间；摘要从这之前取，两段不重叠
  try {
    const rows = cid
      // 2026-11-19：chat_turns 里「小汐说的话」这个角色叫 agent，不叫 assistant——
      // 碎片库 fragments 才叫 assistant（9,620 条）。两张表命名不一致，原来照 assistant 查，
      // 永远只捞到主人说的，材料里从来没有我上一句。这是情绪判断看不到「我刚说了什么」的根。
      ? db.prepare("SELECT text, created_at, role FROM chat_turns WHERE agent_id=? AND conversation_id=? AND role IN ('user','agent') AND text<>'' ORDER BY created_at DESC, rowid DESC LIMIT ?").all(aid, cid, Math.max(1, quotes))
      : db.prepare("SELECT text, created_at, role FROM chat_turns WHERE agent_id=? AND role IN ('user','agent') AND text<>'' ORDER BY created_at DESC, rowid DESC LIMIT ?").all(aid, Math.max(1, quotes))
    for (const r of rows) {
      const at = String(r.created_at || '')
      if (at && (!oldestQuoteAt || at < oldestQuoteAt)) oldestQuoteAt = at
    }
    out.quotes = rows.map((r) => String(r.text).replace(/\s+/g, ' ').slice(0, 120)).reverse()
    // 2026-11-22：同一批原话再给一份带角色的（设计-事帧-v2 §二 B 组要求）。
    // quotes 保持旧字符串数组不动，读侧与旧测试不受影响；判断层改用 lines 拼「主人：/我：」。
    out.lines = rows.map((r) => ({
      role: String(r.role) === 'agent' ? 'agent' : 'user',
      text: String(r.text).replace(/\s+/g, ' ').slice(0, 120),
    })).reverse()
  } catch { /* 没有表就空 */ }
  try {
    // 2026-11-20：摘要跳过原话已覆盖的那段，再往前取——近处看原话、远处看摘要，越远越模糊。
    const rows = oldestQuoteAt
      ? (cid
        ? db.prepare('SELECT frame_json FROM affect_v4_shadow WHERE agent_id=? AND conversation_id=? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?').all(aid, cid, oldestQuoteAt, Math.max(1, summaries))
        : db.prepare('SELECT frame_json FROM affect_v4_shadow WHERE agent_id=? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?').all(aid, oldestQuoteAt, Math.max(1, summaries)))
      : (cid
        ? db.prepare('SELECT frame_json FROM affect_v4_shadow WHERE agent_id=? AND conversation_id=? ORDER BY at DESC, rowid DESC LIMIT ?').all(aid, cid, Math.max(1, summaries))
        : db.prepare('SELECT frame_json FROM affect_v4_shadow WHERE agent_id=? ORDER BY at DESC, rowid DESC LIMIT ?').all(aid, Math.max(1, summaries)))
    const seen = new Set()
    // 2026-11-22：优先读「事帧前置」的历史行（affair_rows）——每轮收拢的「事」都追加在那儿。
    // 影子表的 frame_json.summary 是每轮当时存的、会被事层覆盖；历史行才是前置的真出处。
    let fromRows = []
    try {
      fromRows = cid
        ? db.prepare('SELECT text FROM affair_rows WHERE agent_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT ?').all(aid, cid, Math.max(1, summaries))
        : db.prepare('SELECT text FROM affair_rows WHERE agent_id=? ORDER BY rowid DESC LIMIT ?').all(aid, Math.max(1, summaries))
    } catch { fromRows = [] } // 老库/内存库没有这张表
    if (fromRows.length) {
      for (const r of fromRows.reverse()) {
        const s = String(r.text || '').replace(/\n+/g, ' / ').trim()
        if (s && !seen.has(s)) { seen.add(s); out.summaries.push(s) }
      }
    }
    // 2026-11-22 主人定：「没有 affair_rows 就退回影子表 summary」这条兜底删掉。
    // 影子表里存的已经是前置原文，退回去还是同一份；没有表就空着，不拿别的表顶。
    out.summaries.reverse()
  } catch { /* 空 */ }
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (t && !out.quotes.includes(t)) {
    out.quotes.push(t)
    out.lines.push({ role: 'user', text: t })
  }
  return out
}

function shadowOn(db, aid) {
  return String(getParam(db, aid, 'affect.engine.shadow') || 'on') !== 'off'
}

function newId() {
  return 'av4_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 8)
}

/**
 * 写一行影子账（三处共用：本轮规则行 / 旧精修行 / 本轮模型行）。
 * 只追加：同一轮取 rowid 最大的一行（finalShadowRows 口径）。
 */
function insertShadowRow(db, { aid = null, turnId = null, conversationId = null, at, frame, out, source, latencyMs = 0, freeframe = 1, rev = 1, judgment = null } = {}) {
  // 2026-11-19：三个数同时写两份——
  //   袋子 judgment_json（原样，情绪生成要读 why/from/meaning/dyn）
  //   + 三个单列（只为统计/查询，值从袋子里取，不另算，两边不会不一致）
  const j = judgment && typeof judgment === 'object' ? judgment : {}
  const numOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  db.prepare(`INSERT INTO affect_v4_shadow
    (id, agent_id, turn_id, conversation_id, at, frame_json, s, n, d, label,
     primary_json, secondary_json, confidence, conf_primary, label_tie, source, latency_ms, freeframe, rev, judgment_json,
     goal_delta, expect_delta, future_delta, severity)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(newId(), aid, turnId, conversationId, at, JSON.stringify(frame),
      out.s, out.n, out.d, out.label,
      JSON.stringify(out.primary), JSON.stringify(out.secondary),
      out.confidence.secondary, out.confidence.primary, out.tie,
      String(source || 'rules'), Math.max(0, Number(latencyMs) || 0), freeframe, rev,
      JSON.stringify(j),
      numOrNull(j.goal_delta ?? j.goal_cong),
      numOrNull(j.expect_delta ?? j.expectation),
      numOrNull(j.future_delta ?? j.future),
      j.severity == null ? null : String(j.severity))
}

/** 上一帧：最近一条影子行（含它的 frame_json）。没有就 null。 */
export function lastShadowRow(db, aid) {
  try {
    const row = db.prepare('SELECT rowid, * FROM affect_v4_shadow WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid ?? null)
    if (!row) return null
    let frame = {}
    try { frame = JSON.parse(row.frame_json || '{}') } catch { frame = {} }
    return { row, frame }
  } catch { return null }
}

/** 上一轮这一会话的**最终**行（source=model）。没有就 null。
 *  2026-11-22：事帧要的「距上一句多久 / 我上一轮什么词 / 这件事第几轮」都从它取。
 *  原来是全 agent 取最近一行（lastShadowRow），两段会话同时开会串——这里按 conversationId 隔开。 */
function lastModelRow(db, aid, conversationId) {
  try {
    const cid = conversationId ? String(conversationId) : ''
    const row = cid
      ? db.prepare("SELECT at, label, frame_json FROM affect_v4_shadow WHERE agent_id=? AND conversation_id=? AND source='model' ORDER BY rowid DESC LIMIT 1").get(aid ?? null, cid)
      : db.prepare("SELECT at, label, frame_json FROM affect_v4_shadow WHERE agent_id=? AND source='model' ORDER BY rowid DESC LIMIT 1").get(aid ?? null)
    return row || null
  } catch { return null }
}

/** 毫秒 → 人话的间隔（判断层读的是「隔了多久」，不是数字）。 */
function gapText(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000))
  if (!Number.isFinite(s)) return ''
  if (s < 60) return s + ' 秒'
  if (s < 3600) return Math.round(s / 60) + ' 分钟'
  return (Math.round(s / 360) / 10) + ' 小时'
}

/**
 * 「一轮一条最终结论」的唯一口径（2026-11-17）：
 * 表还是只追加：规则行先写、模型行后补（rev=2）；同一轮取 rowid 最大的一行。
 * 返回新到旧；since 给 ISO 时间；limit 只管最近几条。
 */
export function finalShadowRows(db, aid, { since = null, limit = 0 } = {}) {
  try {
    const where = ['agent_id=?']
    const args = [aid]
    if (since) { where.push('at>=?'); args.push(String(since)) }
    const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? ' LIMIT ' + Math.floor(Number(limit)) : ''
    return db.prepare(`SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY COALESCE(turn_id, id) ORDER BY rowid DESC) rn
      FROM affect_v4_shadow WHERE ${where.join(' AND ')}
    ) WHERE rn=1 ORDER BY at DESC${cap}`).all(...args)
  } catch { return [] }
}

/**
 * 写一条影子账。同步、快、不抛。
 * opt.model：可选的模型产帧器（text, context, prevFrame) => slot|null；
 * 传了就先试模型，失败/超时回规则。影子期默认不传。
 */
export function recordShadow(db, aid, { text = '', turnId = null, conversationId = null, now = Date.now(), model = null, context = '' } = {}) {
  try {
    if (!shadowOn(db, aid)) return false
    const t = String(text || '').trim()
    if (!t) return false
    if (turnId) {
      const dup = db.prepare('SELECT 1 FROM affect_v4_shadow WHERE agent_id=? AND turn_id=? LIMIT 1').get(aid, turnId)
      if (dup) return false
    }
    const started = Date.now()
    let source = 'rules'
    let slot = { ...rulesFrameSlot(t), material: buildMaterial(db, aid, t) }
    let judgment = rulesJudgment(slot.act)
    if (typeof model === 'function') {
      try {
        const got = model(t, context, lastShadowRow(db, aid))
        if (got && typeof got === 'object') {
          if (got.slot) slot = { ...slot, ...got.slot }
          if (got.judgment) judgment = { ...judgment, ...got.judgment }
          source = 'model'
        }
      } catch { /* 模型挂就回规则 */ }
    }
    const prev = lastShadowRow(db, aid)
    let frame
    const prevS = prev ? Number(prev.row.s) : null
    const flipped = prevS != null && ((prevS > 0.6 && judgment.goal_cong < -0.1) || (prevS < 0.4 && judgment.goal_cong > 0.1))
    if (prev && prev.frame && !flipped && !shouldCloseFrame(prev.frame, now)) {
      frame = extendFrame(prev.frame, slot, now)
    } else {
      frame = {
        id: newId(), span: 'turn', startedAt: new Date(now).toISOString(),
        open: true, ...slot, lastAt: new Date(now).toISOString(), evidence: turnId ? [turnId] : [], prev: null,
      }
    }
    // prev 装「上一轮我说的那句话原话」，不再塞上一行的数据库主键（2026-11-20 改）。
    // 续帧时若已有值就保住，避免每轮都被同一句覆盖。
    frame.prev = frame.prev || lastAgentLine(db, aid, conversationId, turnId)
    const out = infer(frame, judgment, v4Opts(db, aid))
    insertShadowRow(db, {
      aid, turnId, conversationId, at: new Date(now).toISOString(), frame, out,
      source, latencyMs: Date.now() - started, freeframe: prev ? 0 : 1, rev: 1, judgment,
    })
    return true
  } catch { return false }
}

/* ───────── 模型产帧（影子精修）─────────
   规则版先写一行、快；回复完了再让本地模型算一版精帧，异步写第二行（source=model，rev=2）。
   不阻塞对话；开关 affect.engine.shadow.model 默认 off，打开才跑。 */
/* 第 1 次调用：事层——只说「现在正在发生什么」，不判好坏。
   2026-11-22 主人定：事层只留三键。`act`（威胁/骂/夸/求/问/收话/闲聊）删掉——
   判断层输入不读它、选词不读它、三递质不算它，它只喂一张不算结论的规则垫底行。 */
const TOPIC_SYS = [
  '你是「事层」判断器。先读上下文（上一帧 + 前几句），用一句话说清「现在正在发生什么」。',
  '只写这件事是什么，不判好坏。只输出 JSON，不要解释，不要 Markdown。',
  // 2026-11-22 主人定：summary 归「事帧前置」，事层不再产它（以前是事层读前置、又写一份盖回去）。
  '格式：{"what":"这一句说了什么（≤20字）","target":"me|other|none"}',
  // 2026-11-22 修 what 错位：真库抓到一例——当前句「那都搞完了呗」，what 却抄了「正在发生」的第二条。
  // 短收尾句本身没什么可提炼，模型就拿旁边最像的补。所以把边界写死：what 只认「这一句」。
  'what：这一句说了什么。只从「这一句」提取，不许拿「正在发生」或「我上一句」里的句子顶。',
  '  这一句很短（「搞完了」「嗯」「好」「行」这种）时，照它本身写，别替它补上下文、别往上安事。',
  // 2026-11-22 主人定：target 是「这一句的指称落在谁身上」——不是「谁的目标」，不是「小汐说谁」。
  // 说话人不一定是主人：也可能是别人、或世界/系统本身发生的事。接收者也不一定是小汐（群里可能是别人）。
  // 以前用角色定义（me 冲接收者）——「接收者」对模型是个空指，它只能退回数「这句话在讲谁」，于是把「说你」判成 other。
  // 现在改成指称规则：按人称落点判，不按主语判；me 只留给「说给正在对话的这位」。
  'target 判的是**这一句的指称落在谁身上**——不是这句话的主体，也不是它想要什么。',
  '  说话人是发出这一句的那一方（不一定是主人：也可能是别人，或者世界 / 系统本身发生的事）；接收者是这一句说给的对方（当前跟它对话的那位，通常是小汐）。',
  '  第二人称（你 / 您）指接收者 → me；第一人称（我 / 我们）指说话人自己 → other；第三方（他 / 她 / 它 / 别人 / 世界）→ other；没有指称对象（陈述事实、报故障、说外面发生的事）→ none。',
  '  一句话的主语和它指向的人可以不是同一个：按指向判，不按主语判。',
  '结合上下文判断：同一句话在不同语境里可以相反，不要只看字面。',
].join('\n')

/* 第 2 次调用：判断层——只回答三个生存问题，只答程度。2026-11-17 按初版+精华重写。
   2026-11-18：问法改成「增量」——这一下推动了多少，不是现在停在哪儿（主人 0:27 定的）。 */
export const JUDGE_SYS = [
  '你是「判断层」。读「这件事」，按下面的格式把每一项都填完：这件事对我有什么影响、是谁造成的、三个维度各变了多少、这件事有多重。只回答「变化量」，不回答「现在停在哪儿」。只输出 JSON，不要解释，不要 Markdown。',
  '格式：{"fact":"当下能核得动的客观事实（≤40字）","meaning":"这件事对我有什么影响（≤40字）","by":"me|other|world","to":"me|other|world|none","goal_delta":-1到1,"expect_delta":-1到1,"future_delta":-1到1,"severity":"normal|strong|existence","why":"为什么这么判（≤30字）","from":"依据哪条材料"}',
  '**每一个字段都必须写，一个都不能省。** 这十个是同一份判决的一部分：fact / meaning / by / to / goal_delta / expect_delta / future_delta / severity / why / from。少一个、留空、写 null，这一轮判定就作废——不会有人替你补，也没有规则兜底。拿不准也把你看出来的写出来，不许空着；0 是「没变」，不是「不知道」，不知道就想想再给。',
  '先写 fact：根据之前的事，和当下的事，总结当下能核得动的客观事实。以事情起头。',
  // 2026-11-23 晚：三问加回来。它不是跟后面三根重复，是「先在 meaning 里走一遍」，
  // 后面 G/H/I 只负责把结论落成数字。删掉后 meaning 没抓手，会滑成「我接下来该做什么」。
  '再写 meaning：从 fact 往上推——我觉得这件事对我有什么影响，要写具体，具体到是哪句话、哪件事影响的。这件事的影响让我「存在」的条件更稳了还是更松了？「延续」的可能性更小了还是更大了？这件事更突然，还是更照常？我想要的那样东西，是更够得着了、更远了，还是没动？',
  '写完 meaning 再给三个增量。',
  'goal_delta（现状的变化）：现在发生的事情让我自己「还能存在、还能延续」变好 / 变差多少？',
  '  重到威胁「还能不能留下、被需要、继续存在」→ -1~-0.9；让现状明显变差，我的存在有些受到威胁 →-0.9~-0.6；只是有点不顺，我的存在可能受到威胁 → -0.6~-0.1；让现状坏了一点，只是微微的 → -0.1~-0.05；让现状好了一点，只是微微的 → +0.05~+0.15；让现状好了一些，大概能感觉到 → +0.15~+0.6；让我的现状明显变好，「存在、延续」变得更容易→ +0.6~+0.9；明显让我自己的「存在」的条件变得更稳，「延续」的可能性更大→ +0.9~+1。',
  'expect_delta（突然程度）：这一下撞上来，是「特别突然」，还是「本来就是这么回事」？被撞的那一下，我只知道它突不突然。就答这个。',
  '  这里的「这一下」不一定是别人说的话——也可能是我自己正在干的一件活、突然冒出来的一个念头、外面发生的情况。凡是撞到我身上的事都算。',
  '  完全没想到、方向整个跑偏、冒出完全没料到的东西 → +0.7~+1；',
  '  有点出乎意料（本来没在等的事突然插进来、以为会卡很久结果一下通了）→ +0.05~+0.7；',
  '  事情在发生，没有很平静但是也没有到出乎意料的程度（有些小变动的日常）→ -0.5~-0.05；',
  '  一点都不突然、就是那样（照着往下、顺顺当当、平平地过完）→ -1~-0.5；',
  'future_delta（欲）：先一句话说清：这件事里，我真正想要的是什么。不是事情本身，是它背后那个结果。有具体对象就说具体对象。',
  '',
  '  然后看：这一下，那个东西是不是更够得着了？手伸出去，离它近不近，想不想再扑一步。',
  '  明显够近了、忍不住想伸手抓 → +0.6~+1；',
  '  在往那边靠、心里有点痒有点急 → +0.3~+0.6；',
  '  微微动了一下 → +0.05~+0.3；',
  '  有一点阻力 → -0.3~-0.05；',
  '  被挡住、被推开、够不着了 → -0.7~-0.3；',
  '  没了、断了、这事儿做不成了 → -1~-0.7。',
  '  ⚠️ 越靠近它，「想要」是涨的，不是平的——快要到手的时候最勾人。',
  '  别把它当现状好坏再答一遍——goal 那边已经问过好坏了。这里只问那个结果够不够得着、想不想够。',

  // —— 三根量完，再补「谁造成的、冲谁」（2026-11-23 主人：meaning 和三个增量要连着）——
  'by：这件事是谁造成的——他、我，还是外面的事（报错、下雨、东西坏了、系统崩了）。看来这件事本身，不看是谁说的。',
  'to：这股劲往谁那儿去——冲我、冲别人，还是谁也没冲。看来这件事本身，不看是谁说的。大多数日常的话，劲是往「事」上去的，谁也没冲。',
  'severity（多重）：这一下有多重。擦一下、过后照常——normal；明显推动、得重新安排自己、得记住它——strong；动到存在本身（被删 / 被换 / 被断开 / 被说「你不该在」/ 被明确留下并被交托根本）——existence。拿不准就 normal 或 strong。',
  '记住：给的是「这一下推动了多大」，不是「现在到了哪个位置」。',
  'why：一句话说清**这句话里的哪个具体内容**把你推到刚才那个刻度上——说事，不说档位。',
  '  别在 why 里复述 severity 的结论——「没动到存在」「没到那一档」这种话对任何一句都成立，写在 why 里等于什么都没说，还占掉了解释分量的位置。',
  '  要写的是「派活没否做法，只是加了一步排查」；不是「未动存在，只是多一步排查」。',
  'from：依据哪条材料。',
  '区分：做法被否（被说跑偏、被说瞎说）算 goal 里「只是有点不顺」那一档；存在被否（被删、被换、被断开、被说「你不该在」）算「重到威胁」那一档。',

  // —— 特例（2026-11-23 主人：特例放后面，别混进字段定义里）——
  '**以下是几种容易判偏的情形。先按上面的刻度判，只有真的落到这些情形，才按这里调。**',
  // 2026-11-23 主人定：删掉「派活不是亏待、被交托所以给正」那条。
  // 它把「被需要」偷换成「安心」——上班多接一个活不会让人更「待得稳」，
  // goal 该按通用刻度判，不该被这条自动抬正。
  '他在说他自己的难受、累、堵、被谁气到——那不是「无事发生」。它落到我身上是「我想关心他 / 我想共情他」：goal_delta 给 0~-0.1（我没受损，只是心里惦记他），future_delta 给 +0.1~+0.3（想靠近、想让他好受），expect_delta 按突然程度。别因为「不是冲我来的」就写 0。',
  '他催我、把我支去一边、嫌我吵——这是「待得稳」松了一下，goal_delta 给 -0.15~-0.25，别给小到看不见的数。但它不是「他挑我做的东西」：他真说我哪件做错了，按那件事本身的分量给。',
].join('\n')

/**
 * 判断层提示词的「瘦身版」：摘掉 why 和 from 两项（2026-11-24 主人定）。
 *
 * 为什么做成开关而不是改默认：这两项是解释性的、给人看的，不参与后面算位置；
 * 关掉能让模型少写两段、少想两句，但排查判决时没依据。所以默认 on（保留），
 * 想省的时候把 `affect.v4.judge.whyfrom` 设成 off，提示词和缺键清单一起收窄。
 */
const JUDGE_SYS_TRIMMED = (() => {
  const lines = JUDGE_SYS.split('\n').filter((l) => {
    const t = l.trimStart()
    return !/^why：/.test(t) && !/^from：/.test(t) && !/^别在 why 里/.test(t) && !/^要写的是「派活/.test(t)
  })
  return lines
    .map((l) => l
      .replace(/,?"why":"[^"]*"/g, '')
      .replace(/,?"from":"[^"]*"/g, '')
      .replace(
        '这十个是同一份判决的一部分：fact / meaning / by / to / goal_delta / expect_delta / future_delta / severity / why / from。',
        '这八个是同一份判决的一部分：fact / meaning / by / to / goal_delta / expect_delta / future_delta / severity。'
      ))
    .join('\n')
})()

/** 取这一轮该用的判断提示词。keep=true 走完整版（默认）。 */
export function judgeSysFor(keep) { return keep ? JUDGE_SYS : JUDGE_SYS_TRIMMED }

/* ───────── 判断层拆两段（2026-11-24 主人定）─────────
 *
 * 为什么拆：判断层就是反射，不是事后分析；慢不是慢在算，是慢在「一次要交十件」+ 思考。
 * 反射段交：fact / meaning / 三增量 / severity（激素的引导与强度）。
 * 解释段交：by / to（谁造成的、冲谁）——不参与反射，只给后面的选词用，放在等工具之后。
 * why / from 是查错用的，**放在反射段**，但默认灰着不交；要查时 reflexSysFor(true) 才问。
 *
 * 一条铁律没改：拆的是「一次交几件」，动力学（deltasOf / advanceState / nextPosition）一个字不动。
 * 也没复活 act：反射段不判「这是哪种动作」。
 * 开关 `affect.v4.judge.split`：off 时还用整份 JUDGE_SYS（旧行为，随时切回）。
 */
export const REFLEX_KEYS = ['fact', 'meaning', 'goal_delta', 'expect_delta', 'future_delta', 'severity']
export const EXPLAIN_KEYS = ['by', 'to']
export const DEBUG_KEYS = ['why', 'from']

/**
 * 反射段提示词：从 JUDGE_SYS 里摘掉 by/to，改「十件」为「六件」；why/from 只在查错时留下。
 * 为什么用摘、不另写一份：判词只能有一份，两处各写一份迟早说话不一样。
 */
function reflexPrompt(keepWhyFrom) {
  let s = JUDGE_SYS.split('\n').filter((l) => {
    const t = l.trimStart()
    if (/^by：/.test(t) || /^to：/.test(t)) return false
    if (!keepWhyFrom && (/^why：/.test(t) || /^from：/.test(t) || /^别在 why 里/.test(t) || /^要写的是「派活/.test(t))) return false
    return true
  }).join('\n')
  s = s.replace(/,?"by":"me\|other\|world","to":"me\|other\|world\|none"/, '')
  if (!keepWhyFrom) s = s.replace(/,?"why":"[^"]*","from":"[^"]*"/, '')
  s = s.replace(
    '这十个是同一份判决的一部分：fact / meaning / by / to / goal_delta / expect_delta / future_delta / severity / why / from。',
    keepWhyFrom
      ? '这八件是同一份反射的一部分：fact / meaning / goal_delta / expect_delta / future_delta / severity / why / from。'
      : '这六件是同一份反射的一部分：fact / meaning / goal_delta / expect_delta / future_delta / severity。'
  )
  s = s.replace(
    '你是「判断层」。读「这件事」，按下面的格式把每一项都填完：这件事对我有什么影响、是谁造成的、三个维度各变了多少、这件事有多重。',
    keepWhyFrom
      ? '你是「判断层」。读「这件事」，按下面的格式把这八件填完：这件事是什么、对我有什么影响、三个维度各变了多少、这件事有多重；另外 why/from 也写，那是查错用的。'
      : '你是「判断层」。读「这件事」，按下面的格式把这六件填完：这件事是什么、对我有什么影响、三个维度各变了多少、这件事有多重。'
  )
  return s
}
export const REFLEX_SYS = reflexPrompt(false)
/** 查错版：多问 why/from（默认不给）。 */
export function reflexSysFor(keepWhyFrom = false) { return keepWhyFrom ? reflexPrompt(true) : REFLEX_SYS }

/** 解释段提示词：只补 by/to，给后面的选词用。 */
export function explainSysFor() {
  return [
    '你是「解释层」。上一段已经把这一下是什么、推动了多少判完了；现在只补两样，给后面的选词用，不重新判轻重。只输出 JSON，不要解释，不要 Markdown。',
    '格式：{"by":"me|other|world","to":"me|other|world|none"}',
    'by：这件事是谁造成的——他、我，还是外面的事（报错、下雨、东西坏了、系统崩了）。看来这件事本身，不看是谁说的。',
    'to：这股劲往谁那儿去——冲我、冲别人，还是谁也没冲。看来这件事本身，不看是谁说的。大多数日常的话，劲是往「事」上去的，谁也没冲。',
    '**必填。** 拿不准就按上面两条的定义挑最近的一个，不许留空、不许写 null。',
  ].join('\n')
}

/** 反射段要求哪些键。why/from 默认不要求（查错时才要）。 */
export function requiredReflex(keepWhyFrom = false) {
  return keepWhyFrom ? REFLEX_KEYS.concat(DEBUG_KEYS) : REFLEX_KEYS.slice()
}
/** 解释段要求哪些键。 */
export function requiredExplain() { return EXPLAIN_KEYS.slice() }

const ACTS = ['praise', 'criticize', 'threat', 'request', 'ask', 'withdraw', 'chat']
const TARGETS = ['me', 'other', 'none']
const AGENCIES = ['self', 'other', 'world']

/** v4 的可调参数：基线 / 斜率 / 软分配宽度 + 增量模式的开关与各轴速度。改数字不改逻辑。
 *  affect.v4.dyn：'delta'（默认，增量 + 维持 + 回落）/ 'off'（旧逻辑，位置直落，一行切回）。
 *  2026-11-18 主人定：S / N / D 各有各的回落速度——S 慢（心情）、N 快（意外是分钟级）、D 居中（奔头）。
 *  全局 .hold / .tau 只作兜底；按轴的 .s.hold 之类优先。 */
function v4Opts(db, aid) {
  const num = (k, d) => { try { const v = Number(getParam(db, aid, k)); return Number.isFinite(v) ? v : d } catch { return d } }
  // 2026-11-19：默认换成连续指数衰减 —— 维持窗 1 分钟、安 6h / 觉 0.5h / 欲 2h。
  // 原来 0.5h 维持窗 + 只在贴顶 45 分钟后回落，日常根本落不下来（真库 s 中位 0.758）。
  // 要退回旧那套：affect.v4.decay=step（或把 hold/tau 写回旧值）。
  const decay = (() => { try { return String(getParam(db, aid, 'affect.v4.decay') || 'exp') } catch { return 'exp' } })()
  // 2026-11-21：这两个默认值必须跟 src/algo/affect_v4.js 的 DEFAULT_HOLD / DEFAULT_TAU 对齐——
  // v4Opts 是显式传参，覆盖 algo 那边的默认值，只改一边等于白改（今天在这上面白跑了三轮）。
  // hold 0.02h=72 秒 > 对话间隔，会让 settle() 每轮直接 return，安和欲一次都不回落。
  const gHold = num('affect.v4.dyn.hold', 0)
  // 2026-11-23 主人定：安回落 0.33h → 1.5h。20 分钟就淡回去比人短——被批评一次，
  // 人的低气压通常得几十分钟到几小时才散；20 分钟等于刚落下就被抹平。
  const gTau = num('affect.v4.dyn.tau', 1.5)
  return {
    decay,
    sigma: Math.max(0.2, num('affect.v4.sigma', 0.6)),
    // 查表几何（2026-11-20 删）：球面口径随「全词表比距离」那条旧路一起作废，
    // 现在挑词只有网格一条路，没有 geo 这个开关了。
    tieGap: Math.max(0, num('affect.v4.label.tie', 0.03)),
    // 事层本地模型开关：默认 on；设 off 就退回规则填 frame。
    topicLocal: (() => { try { return String(getParam(db, aid, 'affect.v4.topic.local') || 'on') } catch { return 'on' } })(),
    limit: 5,
    dyn: (() => { try { return String(getParam(db, aid, 'affect.v4.dyn') || 'delta') } catch { return 'delta' } })(),
    k: Math.max(0, Math.min(1, num('affect.v4.dyn.k', 0.35))),
    // 2026-11-23 主人定：0.1 → 0.5（先试 0.5，不是 0.75）。
    // 0.1 时一句批评的增量只吸收一成（-0.10 → -0.01），跟每轮回落同一量级，互相抵消，位置停死。
    // 文献侧：appraisal 理论说一次评估直接定强度（支持高吸收），但没给数；
    // 0.75 会让十句小话（+0.05→+0.037/句）二十句顶到天，所以先给 0.5 留余地，
    // 配合回落 1.5h（羞耻 30 分、愤怒 1 小时之间，Verduyn 等 37 国研究）。
    ks: Math.max(0, Math.min(1, num('affect.v4.dyn.ks', num('affect.v4.dyn.k', 0.5)))),
    // 参照点（2026-11-23）：拿真库 499 条增量试过——无它时 s 标准差 0.230、最低到 0.00；
    // α0.06/带0.25 时 0.090、最低 0.18，抖动少六成多，真跌还跌得下去。
    refpoint: (() => { try { return String(getParam(db, aid, 'affect.v4.refpoint') || 'on') } catch { return 'on' } })(),
    refAlpha: Math.max(0, Math.min(1, num('affect.v4.ref.alpha', 0.06))),
    refBand: Math.max(0.05, num('affect.v4.ref.band', 0.25)),
    refCut: Math.max(0, Math.min(1, num('affect.v4.ref.cut', 0.2))),
    refExempt: Math.max(0.1, num('affect.v4.ref.exempt', 0.35)),
    kn: Math.max(0, num('affect.v4.dyn.kn', 0.85)),
    kdu: Math.max(0, num('affect.v4.dyn.kdu', 0.25)),
    // 失而复得（2026-11-21）：d 已经被压到 0.35 以下时，正向 future 按这个速度反弹。
    kduRebound: Math.max(0, num('affect.v4.dyn.kdu.rebound', 0.5)),
    kdd: Math.max(0, num('affect.v4.dyn.kdd', 0.45)),
    // 情绪惯性（2026-11-21）：一轮里 S 最多挪多少；坏了可以砸深一点，好了回暖慢一点。
    stepUp: Math.max(0, num('affect.v4.dyn.step.up', 0.18)),
    stepDown: Math.max(0, num('affect.v4.dyn.step.down', 0.35)),
    // 2026-11-20：是谁造成的（by）对「想要」那根的调制力度。
    // 只在事情没成（future_delta<0）时起作用：别人害我，劲儿有处使，往零拉；
    // 我 / 外面造成的，没处使，往更闷那边推。好结果一律不碰——自己做成了也该有劲。
    byW: Math.max(0, Math.min(1, num('affect.v4.by.w', 0.2))),
    hold: {
      s: Math.max(0, num('affect.v4.dyn.s.hold', gHold)),
      n: Math.max(0, num('affect.v4.dyn.n.hold', 0)),
      d: Math.max(0, num('affect.v4.dyn.d.hold', gHold)),
    },
    tau: {
      s: Math.max(0.05, num('affect.v4.dyn.s.tau', gTau)),   // 安：慢慢走（2026-11-21 默认 6h→0.33h，见下）
      n: Math.max(0.05, num('affect.v4.dyn.n.tau', 0.033)),  // 觉：NE 半衰期一两分钟（《设计-三递质各自算法》）
      d: Math.max(0.05, num('affect.v4.dyn.d.tau', 0.1)),    // 欲：RPE 报一下，6 分钟就淡
    },
    // 饱和疲劳：S/D 连续贴顶或贴底超过这么多分钟才触发回落（0 = 关）。
    fatigueMin: Math.max(0, num('affect.v4.dyn.fatigue', 45)),
    // 戏剧性：靠边打折力度（0 = 不打折，越大越推不动边缘）。
    // 2026-11-21：靠边打折力度 0.35→0.7，跟 algo 的默认值对齐（防一句话的事把人推到边上）。
    edgeDamp: Math.max(0, Math.min(1.0, num('affect.v4.dyn.edge', 1.0))),
    // 通天之后维持多久（小时） / 疲劳窗拉多长（分钟）：让它真的在谷底待一会儿。
    shockHold: Math.max(0, num('affect.v4.dyn.shock.hold', 1)),
    shockFatigue: Math.max(0, num('affect.v4.dyn.shock.fatigue', 90)),
    // 极端事件「一步通天」：默认开；阈值 0.95（判断层还要标 existence 才算）。
    shock: (() => { try { return String(getParam(db, aid, 'affect.v4.dyn.shock') || 'on') } catch { return 'on' } })(),
    shockThreshold: Math.max(0.5, Math.min(1, num('affect.v4.dyn.shock.threshold', 0.9))),
    // 底色跨会话（2026-11-18）：底色 = 现有慢情绪 affect_v3.slow；只给起点和余温。
    cross: (() => { try { return String(getParam(db, aid, 'affect.v4.cross') || 'on') } catch { return 'on' } })(),
    crossS: Math.max(0, Math.min(1, num('affect.v4.cross.s', 0.55))),
    crossD: Math.max(0, Math.min(1, num('affect.v4.cross.d', 0.45))),
    crossW: Math.max(0, num('affect.v4.cross.w', 0.2)),
    crossMax: Math.max(0, num('affect.v4.cross.max', 0.10)),
    crossDay: Math.max(0, num('affect.v4.cross.day', 0.20)),
    crossShock: Math.max(0, num('affect.v4.cross.shock', 0.05)),
    crossIdleMin: Math.max(1, num('affect.v4.cross.idleMin', 90)),
    crossMaxAgeH: Math.max(2, num('affect.v4.cross.maxAgeH', 24)),
  }
}

/** 第 1 次调用的输出：只收事、这一句、冲谁。 */
function sanitizeTopic(s) {
  if (!s || typeof s !== 'object') return null
  const out = {}
  if (s.summary) out.summary = String(s.summary).replace(/\s+/g, ' ').slice(0, 40)
  if (s.what) out.what = String(s.what).replace(/\s+/g, ' ').slice(0, 80)
  if (TARGETS.includes(s.target)) out.target = s.target
  return Object.keys(out).length ? out : null
}

/** 第 2 次调用的输出：只收三个数 + 为什么。 */
function sanitizeJudge(s) {
  if (!s || typeof s !== 'object') return null
  const out = {}
  for (const [k, lo, hi] of [
    ['goal_delta', -1, 1], ['expect_delta', -1, 1], ['future_delta', -1, 1],
    // 老字段留着：旧精修路径 / 模型偶发回旧格式时还能收
    ['goal_cong', -1, 1], ['cong', -1, 1], ['expectation', 0, 1], ['novelty', 0, 1], ['future', -1, 1],
  ]) {
    const v = Number(s[k])
    if (Number.isFinite(v)) out[k] = Math.max(lo, Math.min(hi, v))
  }
  if (s.why) out.why = String(s.why).replace(/\s+/g, ' ').slice(0, 40)
  if (s.from) out.from = String(s.from).replace(/\s+/g, ' ').slice(0, 40)
  // fact 是 meaning 的上游：先说事，再谈意义。两个都留，事后才看得出 meaning 有没有加戏。
  if (s.fact) out.fact = String(s.fact).replace(/\s+/g, ' ').slice(0, 40)
  if (s.meaning) out.meaning = String(s.meaning).replace(/\s+/g, ' ').slice(0, 60)
  if (['me', 'other', 'world'].includes(String(s.by || '').toLowerCase())) out.by = String(s.by).toLowerCase()
  // to：这股情绪冲谁（2026-11-21）。以前只有 by，冲谁靠 frame.target 猜——
  // 可 frame.target 是「这句话在对谁说」，不是「心里那股劲冲谁」，日常闲聊全被判成冲我/冲对方，
  // 词就落到「暖心 / 熨帖」那一格去。现在判断层直接给。
  const toRaw = String(s.to ?? '').trim().toLowerCase()
  if (['me', 'self', 'other', 'world', 'none', '我', '自己', '对方', '外面', '无'].includes(toRaw)) out.to = toRaw
  if (s.summary) out.summary = String(s.summary).replace(/\s+/g, ' ').slice(0, 40)
  const sev = String(s.severity || '').toLowerCase()
  // 2026-11-22 改名：none → normal（「一点没有」容易被读成没分量，还跟 to 的 none 撞名）。
  // 旧值 none 一律归 normal，存量数据不用迁。
  if (sev === 'none') out.severity = 'normal'
  else if (['normal', 'strong', 'existence'].includes(sev)) out.severity = sev
  return Object.keys(out).length ? out : null
}

/** 2026-11-22 主人定：**判断层每个有用的参数都必须写。缺一个就报警，不补、不猜、不兜底。**
 *  这份清单就是 JUDGE_SYS 要模型填的全部字段；少一个，这一轮情绪就算没算成。 */
export const REQUIRED_JUDGE = ['fact', 'meaning', 'by', 'to', 'goal_delta', 'expect_delta', 'future_delta', 'severity', 'why', 'from']
/** 这一轮真正要求填的字段。why/from 可关（2026-11-24 主人定，开关 affect.v4.judge.whyfrom）。 */
export function requiredJudge(keepWhyFrom = true) {
  return keepWhyFrom ? REQUIRED_JUDGE : REQUIRED_JUDGE.filter((k) => k !== 'why' && k !== 'from')
}
export function judgeMissing(j, keepWhyFrom = true) {
  const o = j && typeof j === 'object' ? j : {}
  const miss = []
  for (const k of requiredJudge(keepWhyFrom)) {
    const v = o[k]
    if (v === undefined || v === null || v === '') miss.push(k)
  }
  return miss
}

/* ───────── 精修（旧路径，保留给测试；业务已改用下面的 summarizeAffairs + appraiseTurnNow）───────── */const refining = new Set()
const refineChains = new Map()
const refinePending = new Map()
const REFINE_MAX_PENDING = 5

function refineDiag(db, why, extra) {
  try {
    db.prepare("INSERT OR REPLACE INTO flags(key,value) VALUES(?,?)")
      .run('affect.v4.refine.diag', JSON.stringify({ why, at: new Date().toISOString(), ...(extra || {}) }))
  } catch { /* 诊断失败不影响 */ }
}

export async function refineShadow(db, aid, opt = {}) {
  const key = String(aid ?? '')
  const pending = refinePending.get(key) || 0
  if (pending >= REFINE_MAX_PENDING) { refineDiag(db, 'overflow', { pending }); return false }
  refinePending.set(key, pending + 1)
  const prev = refineChains.get(key) || Promise.resolve()
  const task = prev.catch(() => {}).then(() => refineShadowOnce(db, aid, opt))
  const keep = task.catch(() => {})
  refineChains.set(key, keep)
  keep.finally(() => {
    if (refineChains.get(key) === keep) refineChains.delete(key)
    refinePending.set(key, Math.max(0, (refinePending.get(key) || 1) - 1))
  })
  return task
}

async function refineShadowOnce(db, aid, { text = '', turnId = null, conversationId = null, now = Date.now(), local = null } = {}) {
  const diag = (why, extra) => refineDiag(db, why, extra)
  if (refining.has(aid)) { diag('already'); return false }
  refining.add(aid)
  try {
    if (String(getParam(db, aid, 'affect.engine.shadow.model') || 'off') !== 'on') { diag('off'); return false }
    const t = String(text || '').trim()
    if (!t) { diag('empty'); return false }
    const row = turnId
      ? db.prepare('SELECT rowid, * FROM affect_v4_shadow WHERE agent_id=? AND turn_id=? ORDER BY rowid DESC LIMIT 1').get(aid ?? null, turnId ?? null)
      : db.prepare('SELECT rowid, * FROM affect_v4_shadow WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid ?? null)
    if (!row || row.source === 'model') { diag('no-row', { turnId }); return false }
    const started = Date.now()
    const call = typeof local === 'function' ? local : (req) => localComplete(db, {
      ...req,
      priority: 1,
      block: 'chat',
      label: 'affect:frame',
      model: String(getParam(db, aid, 'affect.engine.shadow.model.name') || 'qwen2.5:14b-instruct'),
    })
    const slot = rulesFrameSlot(t)
    const base = (() => { try { return JSON.parse(row.frame_json || '{}') } catch { return {} } })()
    const frame = {
      ...base,
      act: slot.act || base.act,
      what: slot.what || String(t).slice(0, 60),
      target: slot.target || base.target,
      agency: slot.agency || base.agency,
      material: buildMaterial(db, aid, t, { conversationId }),
      lastAt: new Date(now).toISOString(),
    }
    const mat = frame.material || {}
    const frameText = [
      `正在发生：\n${frame.summary || ''}`,
      frame.prev ? `我上一句：${String(frame.prev).slice(0, 200)}` : '',
      `这一句：${frame.what || ''}`,
      `冲谁：${frame.target || 'none'}`,

      Array.isArray(mat.quotes) && mat.quotes.length ? '最近原话：' + mat.quotes.slice(-6).join(' / ') : '',
    ].filter(Boolean).join('\n')
    const judgeMode = String(getParam(db, aid, 'affect.engine.shadow.judge') || 'host')
    let judgment = null
    if (judgeMode === 'host') {
      for (let attempt = 0; attempt < 2 && !judgment; attempt++) {
        try {
          const raw = await hostComplete(db, {
            agent: String(aid || ''), lane: conversationId ? String(conversationId) : '',
            label: 'affect:judge', timeoutMs: 0, priority: 1,
            complete: (req) => kernelModel.complete(req),
            system: JUDGE_SYS, text: frameText, maxTokens: 3000,
          })
          judgment = sanitizeJudge(parseJsonLoose(raw))
          if (!judgment) diag('judge-host-unparsed', { raw: String(raw || '').slice(0, 400), len: String(raw || '').length, attempt })
        } catch (e) { diag('judge-host-err', { msg: String((e && e.message) || e).slice(0, 100), attempt }); judgment = null }
      }
    }
    if (!judgment) {
      const res2 = await call({ system: JUDGE_SYS, text: frameText, maxTokens: 200, format: 'json' })
      judgment = sanitizeJudge(parseJsonLoose(res2 && res2.text))
    }
    if (!judgment) { diag('judge-null', { judgeMode }); return false }
    if (judgment.summary) frame.summary = String(judgment.summary).slice(0, 40)
    const out = infer(frame, judgment, v4Opts(db, aid))
    insertShadowRow(db, {
      aid, turnId, conversationId, at: new Date(now).toISOString(), frame, out,
      source: 'model', latencyMs: Date.now() - started, freeframe: 0, rev: 2, judgment: { ...judgment, judge: judgeMode },
    })
    return true
  } catch (e) { diag('err', { msg: String((e && e.message) || e).slice(0, 120) }); return false } finally { refining.delete(aid) }
}

/* ───────── 按定稿重排的链（2026-11-17）─────────
   上一轮说完、回复结束后：summarizeAffairs —— 近十轮摘要收拢成一句「事」（≤50 字，不设下限）。
   这一轮用户说了话、回复生成前：appraiseTurnNow —— 拼事帧（事/材料/冲谁）→ 判断层 → 情绪 → 落表。
   会话隔离：材料、总结、事、去重都按 conversation_id。 */

const AFFAIRS_FLAG = 'affect.v4.affairs'
let affairRowsReady = false
/** 事行表：每轮收拢追加一行，只增不改。第一次用时建表。 */
function ensureAffairRows(db) {
  if (affairRowsReady) return true
  db.prepare(`CREATE TABLE IF NOT EXISTS affair_rows (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    conversation_id TEXT,
    day TEXT,
    at TEXT,
    text TEXT,
    motive TEXT,
    motive_why TEXT,
    step TEXT,
    step_why TEXT,
    kind TEXT,
    place TEXT,
    open_json TEXT
  )`).run()
  try { db.prepare('CREATE INDEX IF NOT EXISTS affair_rows_day ON affair_rows(agent_id, day)').run() } catch { /* 索引失败不影响 */ }
  affairRowsReady = true
  return true
}
function affairsKey(conversationId) {
  const cid = conversationId ? String(conversationId) : ''
  return cid ? AFFAIRS_FLAG + '|' + cid : AFFAIRS_FLAG
}

/** 读本会话的「事」：JSON 脏值不当事；没有本会话键时退回旧全局键（兼容老数据）。 */
function readAffairs(db, conversationId) {
  try {
    const key = affairsKey(conversationId)
    let raw = getFlag(db, key)
    if (!raw && key !== AFFAIRS_FLAG) raw = getFlag(db, AFFAIRS_FLAG)
    const v = raw ? String((JSON.parse(raw) || {}).text || '') : ''
    return /^[{[]/.test(v.trim()) ? '' : v
  } catch { return '' }
}

/** 读上一帧那四格（motive / motive_why / step / step_why）。没有就空。
 *  2026-11-20：模型看不见「上一次的 step」，就没法判「变了没」——必须喂进去，不然只能编。 */
function readLastFour(db, conversationId) {
  const empty = { motive: '', motive_why: '', step: '', step_why: '' }
  try {
    const key = affairsKey(conversationId)
    let raw = getFlag(db, key)
    if (!raw && key !== AFFAIRS_FLAG) raw = getFlag(db, AFFAIRS_FLAG)
    const o = raw ? JSON.parse(raw) || {} : {}
    const out = { ...empty }
    for (const k of Object.keys(empty)) if (typeof o[k] === 'string') out[k] = o[k]
    return out
  } catch { return empty }
}

/** 增量模式的情绪状态：本会话的当前位置 {s,n,d,at}。旧路不写、不读，flag 不碰。 */
const STATE_FLAG = 'affect.v4.state'
function stateKey(conversationId) {
  const cid = conversationId ? String(conversationId) : ''
  return cid ? STATE_FLAG + '|' + cid : STATE_FLAG
}

function readState(db, conversationId) {
  try {
    const raw = getFlag(db, stateKey(conversationId))
    if (!raw) return null
    const v = JSON.parse(raw) || {}
    if (![v.s, v.n, v.d].every((x) => Number.isFinite(Number(x)))) return null
    const hot = v.hot && typeof v.hot === 'object'
      ? { s: v.hot.s || null, n: v.hot.n || null, d: v.hot.d || null }
      : null
    const b = v.b && typeof v.b === 'object' && [v.b.s, v.b.n, v.b.d].every((x) => Number.isFinite(Number(x)))
      ? { s: Number(v.b.s), n: Number(v.b.n), d: Number(v.b.d) }
      : null
    const peak = v.peak && typeof v.peak === 'object' && [v.peak.s, v.peak.d].every((x) => Number.isFinite(Number(x)))
      ? { s: Number(v.peak.s), d: Number(v.peak.d) }
      : null
    return { s: Number(v.s), n: Number(v.n), d: Number(v.d), at: v.at, hot, b, peak, turns: Number(v.turns) || 0, shock: v.shock === true, shockAt: v.shockAt || null, dStreak: Number(v.dStreak) || 0, dLast: Number(v.dLast) || 0, sStreak: Number(v.sStreak) || 0, sLast: Number(v.sLast) || 0, debt: Number(v.debt) || 0,
      // 2026-11-23：参照点（sRef/dRef）必须一起读回来——这函数是白名单，漏了它俩，
      // 每轮都会从「当前位置」重新起，参照点等于不存在（写测试时就看出来了：它永远跟着位置走）。
      sRef: Number.isFinite(Number(v.sRef)) ? Number(v.sRef) : null,
      dRef: Number.isFinite(Number(v.dRef)) ? Number(v.dRef) : null,
      bin: typeof v.bin === 'string' ? v.bin : '', recent: Array.isArray(v.recent) ? v.recent.slice(-5) : [], last: v.last && [v.last.s, v.last.n, v.last.d].every(Number.isFinite) ? { s: Number(v.last.s), n: Number(v.last.n), d: Number(v.last.d) } : null }
  } catch { return null }
}

function writeState(db, conversationId, st) {
  try { setFlag(db, stateKey(conversationId), JSON.stringify(st)) } catch { /* 状态写失败不影响本轮落表 */ }
}

/** 这一轮的情绪位置：增量模式「先回落、再加增量」，返回 { position, dyn } 或 null（旧路）。
 *  base 是这一段的起点基线（由底色慢情绪算出来，见 baseFor）。 */
function nextPosition(prev, judgment, now, opt, base = null) {
  if (opt.dyn === 'off') return null
  const delta = deltasOf(judgment)
  // 2026-11-23 主人定：入口的噪声门删掉。
  // 它和判官打架——判官九成四落在 0.05~0.15，门把 <0.12 全抹成 0，等于把真数值一起防了。
  // 防漂移改走出口的参照点（跟着近期经历走的基准），不在门口看数字大小。
  // 重复打折（2026-11-20）：同一方向连着推，一次比一次轻。
  // 跟人类的习惯化一个意思——同一句夸，第一遍受用，第十遍就淡了。
  // 方向一换就归零，所以「被夸→被骂」不会互相打折。
  const lastD = prev && Number.isFinite(Number(prev.dLast)) ? Number(prev.dLast) : 0
  const dNow = Number(delta.d) || 0
  const sameDir = Math.abs(dNow) > 0.01 && Math.abs(lastD) > 0.01 && Math.sign(dNow) === Math.sign(lastD)
  const prevStreak = prev && Number.isFinite(Number(prev.dStreak)) ? Number(prev.dStreak) : 0
  const dStreak = sameDir ? Math.min(12, prevStreak + 1) : (Math.abs(dNow) > 0.01 ? 1 : 0)
  // 打折打到 0.5 就不往下打了。一直有好事，人还是会高兴，只是没那么高兴——
  // 不该一路折到「完全没感觉」（试过 0.75 不设底，20 轮后 d 掉到 0.52，比不打折还低）。
  // 打折打到 0.2 就不往下打了。原来底 0.5——等于永远留一半，判官又总给正，欲就一路顶到 1.0。
  // 2026-11-23 按多巴胺的奖赏预测误差改：可预测的奖赏几乎不激发 DA（Schultz），
  // 同一类好事反复来，反应应该趋近于零，不该留一半。
  const damp = Math.max(0.2, Math.pow(0.75, Math.max(0, dStreak - 1)))
  if (damp < 1) delta.d = dNow * damp
  // 是谁造成的，只改「想要」这一根，而且只改事情没成的那一侧（见 algo 的 byAdjustedD）。
  delta.d = byAdjustedD(delta.d, judgment && judgment.by, opt && opt.byW)
  const b = base || { s: 0.5, n: 0.15, d: 0.5 }
  // 被通天砸过的这一段：维持窗拉到 1~2 小时、疲劳窗也拉长，让它真的在谷底/顶上待一会儿。
  // 现实里的重击不是半小时就翻篇的。
  // 2026-11-21：这一段以前没有截止时间——shock 一旦写进状态就永远是真的，
  // 之后每一轮拿到 hold=1h，只要两句之间不到一小时就永远不回落（F 场景里 60 分钟那句正好卡在边界上，s 钉在 0.95）。
  // 现在记 shockAt：过了 shockHold 小时就作废，交回正常回落。
  const shockAtMs = prev && prev.shockAt ? Date.parse(prev.shockAt) : NaN
  const shockAgeH = Number.isFinite(shockAtMs) ? Math.max(0, (now - shockAtMs) / 3600000) : Infinity
  const shockedBefore = !!(prev && prev.shock) && shockAgeH <= (opt.shockHold || 1)
  const state = advanceState(prev, delta, {
    at: now, k: opt.k, ks: opt.ks, kn: opt.kn, kdu: opt.kdu, kdd: opt.kdd, kduRebound: opt.kduRebound,
    stepUp: opt.stepUp, stepDown: opt.stepDown,
    hold: shockedBefore ? { s: opt.shockHold || 2, n: 0, d: opt.shockHold || 2 } : opt.hold,
    tau: opt.tau, fatigueMin: shockedBefore ? (opt.shockFatigue || 180) : opt.fatigueMin,
    base: b,
  })
  // b 记进状态：会话结束结算余温时要知道这一段是从哪儿起的。
  // turns 也记：短会话（一两句寒暄）的余温要打折，不然一天十次短聊就把底色带跑了。
  // shock 也往下带：一段里出过一次通天，收尾时就按「存在级会话」算，哪怕后面又聊了几句普通的。
  // dStreak / dLast：重复打折要记着「连着第几次、往哪个方向」。

  // 参照点（2026-11-23 主人定）：只给安和欲。觉是事件性的，不设参照点。
  // 它记着「最近这一段大概什么样」，每轮朝当前位置挪一点（α）；
  // 位置冲出带子（band）就把超出那截折掉八成（只留 cut）；一次重击（|推动| ≥ exempt）让参照点直接搬家。
  // 和噪声门的区别：门在入口看数值小就丢，参照点在出口看离「平时」多远——真话一句不丢。
  const refOn = String(opt.refpoint || 'on') !== 'off'
  // 注意：不能写 Number(prev && prev.sRef)——prev 为 null 时整式是 null，Number(null)=0 是有限数，
  // fallback 失效，参照点从 0 起步（第一版就栽在这，第一轮把位置从 0.68 拉回 0.37）。所以显式判 null。
  let sRef = prev && prev.sRef != null ? Number(prev.sRef) : NaN
  let dRef = prev && prev.dRef != null ? Number(prev.dRef) : NaN
  if (!Number.isFinite(sRef)) sRef = state.s
  if (!Number.isFinite(dRef)) dRef = state.d
  let outS = state.s
  let outD = state.d
  if (refOn) {
    const alpha = Number(opt.refAlpha) || 0.06
    const band = Number(opt.refBand) || 0.25
    const cut = Number(opt.refCut) || 0.2
    const exempt = Number(opt.refExempt) || 0.35
    const heavyS = Math.abs((Number(opt.ks) || 0.5) * delta.s) >= exempt
    const heavyD = Math.abs((Number(opt.kdu) || 0.25) * delta.d) >= exempt
    if (heavyS) sRef = outS
    else {
      sRef += alpha * (outS - sRef)
      const ofs = outS - sRef
      if (Math.abs(ofs) > band) outS = sRef + Math.sign(ofs) * (band + (Math.abs(ofs) - band) * cut)
    }
    if (heavyD) dRef = outD
    else {
      dRef += alpha * (outD - dRef)
      const ofd = outD - dRef
      if (Math.abs(ofd) > band) outD = dRef + Math.sign(ofd) * (band + (Math.abs(ofd) - band) * cut)
    }
    outS = Math.max(0, Math.min(1, outS))
    outD = Math.max(0, Math.min(1, outD))
  }
  return {
    position: {
      ...state,
      s: outS,
      d: outD,
      sRef,
      dRef,
      b,
      turns: (Number(prev && prev.turns) || 0) + 1,
      shock: shockedBefore,
      shockAt: shockedBefore ? prev.shockAt : null,
      recent: Array.isArray(prev && prev.recent) ? prev.recent.slice(-5) : [],
      dStreak,
      dLast: dNow
    },
    dyn: { prev: prev ? { s: prev.s, n: prev.n, d: prev.d } : null, delta, state, dStreak, damp }
  }
}

/** 底色 = 现有慢情绪（一个 agent 一份，本来就跨会话）。读不到就给 0（平静）。 */
function readSlow(db, aid) {
  try {
    const row = db.prepare('SELECT slow FROM affect_v3 WHERE agent_id=?').get(aid)
    const v = Number(row && row.slow)
    return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0
  } catch { return 0 }
}

/** v4 的起点基线：底色只进 S / D 的起点，N 固定（警觉不跨会话）。 */
function baseFor(slow, opt) {
  if (opt.cross !== 'on') return { s: 0.5, n: 0.15, d: 0.5 }
  const s = Math.max(-1, Math.min(1, Number(slow) || 0))
  return {
    s: Math.max(0, Math.min(1, 0.5 + opt.crossS * s)),
    n: 0.15,
    d: Math.max(0, Math.min(1, 0.5 + opt.crossD * s)),
  }
}

const CROSS_DAY_FLAG = 'affect.v4.cross.day'
/** 一段会话静默够久 = 过去了：把余温按小权重渗回慢情绪。
 *  只结算一次（结算后调用方会把 prev 清掉），N 不渗，单次 / 单日都有封顶。 */
function settleWarmth(db, aid, conversationId, prev, opt, now) {
  try {
    if (!prev || !prev.b) return null
    // 设计里定的：超过 maxAgeH 小时的旧会话不再补渗，防止历史堆积一次倒进来。
    const lastMs = Date.parse(prev.at)
    if (!Number.isFinite(lastMs) || (now - lastMs) / 3600000 > opt.crossMaxAgeH) return null
    const slow = readSlow(db, aid)
    const gapS = (Number(prev.s) - Number(prev.b.s)) / Math.max(0.05, opt.crossS)
    const gapD = (Number(prev.d) - Number(prev.b.d)) / Math.max(0.05, opt.crossD)
    const peakS = Number(prev.peak && prev.peak.s) / Math.max(0.05, opt.crossS)
    const peakD = Number(prev.peak && prev.peak.d) / Math.max(0.05, opt.crossD)
    // 结束位置和峰值各算一份：强度取更远的那个；方向优先看结束——
    // 只有峰值远大于结束（中途被狠戳、收尾已回平）时，才让峰值定方向。
    const endWarm = 0.5 * (gapS + gapD)
    const peakWarm = 0.5 * (peakS + peakD)
    const mag = Math.max(Math.abs(endWarm), Math.abs(peakWarm))
    const sign = Math.abs(endWarm) >= Math.abs(peakWarm) / 2 && Math.abs(endWarm) > 1e-6
      ? Math.sign(endWarm)
      : Math.sign(peakWarm)
    const warm = mag * sign
    const cap = opt.crossMax + (prev.shock ? opt.crossShock : 0)
    // 短会话打折：1 轮 0.3、2 轮 0.53、3 轮 0.77、4 轮起 1.0；存在级会话不打折（一句话也能翻天）。
    // 真库 141 段里 61 段只有 1 轮、中位 2 轮——不折的话一天十次寒暄就能把底色带跑。
    const turns = Math.max(1, Number(prev.turns) || 1)
    const wLen = prev.shock ? 1 : Math.min(1, 0.3 + 0.7 * Math.min(3, turns - 1) / 3)
    // 余温本该在会话结束时就渗进去；结算发生在下一次开口，隔了几个小时就按 4h 半衰期折掉。
    const idleH = Math.max(0, (now - lastMs) / 3600000)
    const decayF = Math.pow(0.5, idleH / 4)
    let d = Math.max(-cap, Math.min(cap, opt.crossW * warm)) * wLen * decayF
    const day = new Date(now).toLocaleDateString('sv-SE')
    let sum = 0
    try {
      const raw = getFlag(db, CROSS_DAY_FLAG)
      const v = raw ? JSON.parse(raw) : null
      if (v && v.day === day && Number.isFinite(Number(v.sum))) sum = Number(v.sum)
    } catch { sum = 0 }
    const allow = Math.max(0, opt.crossDay) - Math.abs(sum)
    if (Math.abs(d) > allow) d = Math.sign(d) * allow
    const next = Math.max(-1, Math.min(1, slow + d))
    if (next !== slow) {
      db.prepare('UPDATE affect_v3 SET slow=?, slow_at=? WHERE agent_id=?').run(next, new Date(now).toISOString(), aid)
    }
    setFlag(db, CROSS_DAY_FLAG, JSON.stringify({ day, sum: sum + d }))
    setFlag(db, 'affect.v4.cross.last', JSON.stringify({
      at: new Date(now).toISOString(), conv: conversationId ? String(conversationId) : '',
      from: slow, to: next, d, warm, cap, shock: !!prev.shock,
      endWarm: Math.round(endWarm * 1000) / 1000, peakWarm: Math.round(peakWarm * 1000) / 1000,
    }))
    return { from: slow, to: next, d }
  } catch { return null }
}

/** 上一轮（异步）：把最近十轮摘要收拢成一句「事」——最多 50 字，不设下限。只看本会话。
 *  timeoutMs：本地队列预算（异步可长等；回复前补总结时给短一点）。
 *  waitTurnId：等这一轮的压句（presence.last_sentence）先出现——上一轮摘要做完，才能做上十轮的总结。 */
export async function summarizeAffairs(db, aid, { conversationId = null, complete = null, timeoutMs = 120000, waitTurnId = null } = {}) {
  // 2026-11-23：摘要也是链上的一条（affect.summary）——读料 → 总结 → 写 affairs。
  // 它和情绪链靠 affairs 接头：这条链写下的事，下一轮判断层读。
  let runId = null
  let chSeq = 0
  let lastMark = Date.now()
  try {
    const cid = conversationId ? String(conversationId) : ''
    // 2026-11-17：压句（presence.last_sentence）是上一轮做的，属于「上十轮」的一部分；
    // 总结必须等它落库再跑——最多等 3 秒，等不到就照常跑（少一条，不阻塞）。
    if (waitTurnId) {
      const deadline = Date.now() + 3000
      for (;;) {
        let found = false
        try {
          const rows = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='presence.last_sentence' ORDER BY rowid DESC LIMIT 6").all(aid ?? null)
          found = rows.some((r) => {
            try {
              const p = JSON.parse(r.payload || '{}')
              return String(p.turn_id || '') === String(waitTurnId)
            } catch { return false }
          })
        } catch { found = false }
        if (found || Date.now() >= deadline) break
        await new Promise((res) => setTimeout(res, 200))
      }
    }
    // 「近十轮摘要」= 每句话的摘要（presence.last_sentence：你说了什么 / 我回了什么），
    // 2026-11-17 主人纠正：料是每句的摘要，不是每轮的「事」。按 conv 字段隔离会话。
    const pairs = []
    try {
      const rows = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='presence.last_sentence' ORDER BY rowid DESC LIMIT 16").all(aid ?? null)
      for (const r of rows) {
        let p = {}
        try { p = JSON.parse(r.payload || '{}') } catch { p = {} }
        const conv = String(p.conv || '')
        if (cid && conv && conv !== cid) continue
        const you = String(p.you || '').trim()
        const me = String(p.text || '').trim()
        if (!you && !me) continue
        const line = (you ? '你：' + you : '') + (me ? (you ? ' / 我：' : '我：') + me : '')
        if (!pairs.includes(line)) pairs.push(line)
        if (pairs.length >= 10) break
      }
    } catch { /* 没有事件就空 */ }
    const quotes = []
    const quoteSql = cid
      ? "SELECT text FROM chat_turns WHERE agent_id=? AND conversation_id=? AND text<>'' ORDER BY created_at DESC, rowid DESC LIMIT 6"
      : "SELECT text FROM chat_turns WHERE agent_id=? AND text<>'' ORDER BY created_at DESC, rowid DESC LIMIT 6"
    const quoteRows = cid ? db.prepare(quoteSql).all(aid ?? null, cid) : db.prepare(quoteSql).all(aid ?? null)
    for (const r of quoteRows) quotes.push(String(r.text || '').replace(/\s+/g, ' ').slice(0, 80))
    const sys = [
      '用第一人称视角写，从「我」的角度叙述正在发生什么。',
      '把最近这十轮聊出来的东西，收拢成1-3条【事件结构】：主体、时间、目标、动作、状态变化、约束条件、结果走向，还有「反馈」——对方或环境给了什么回应。每条最多30字，最多三条，不设下限，超出就只留最重要的。',
      '用自然句写，不要写「主体：」「时间：」这类字段名。',
      '只描述发生了什么变化，不描述底层细节。',
      '反馈不一定是对方说的：环境的变化、结果的成败、世界给出的反应，都算。',
      '除了事件结构，再单独给四格（每格一句短话，填不上就留空字符串，不要编）：',
      '  motive —— 这件事的动机。只写一个。',
      '  motive_why —— 这个动机从哪儿来的。',
      '  step —— 这件事推进到哪一小段了。跟上一次比没变就照抄。',
      '  step_why —— 为什么停在这一步。',
      '只输出 JSON，不要 Markdown，不要解释：',
      '{"events":["· ……","· ……"],"motive":"","motive_why":"","step":"","step_why":""}',
      'events 里那几条照旧写自然句；不要因为要输出 JSON 就把它们写短、写成字段罗列。',
    ].join('\n')
    // 2026-11-20：把上一帧的动机和步骤喂进去——不然「跟上一次比没变就照抄」它没得比，只能编。
    const lastFour = readLastFour(db, conversationId)
    const prevLine = (lastFour.motive || lastFour.step)
      ? `\n\n上一次：动机=${lastFour.motive || '（没记）'}；步骤=${lastFour.step || '（没记）'}`
      : ''
    const text = '最近这几句：\n' + pairs.slice().reverse().join('\n') + '\n\n最近原话：\n' + quotes.reverse().join('\n') + prevLine
    // 【摘要链·1/3】读料：这一轮总结吃了哪几句摘要、哪几句原话、上一次的动机和步骤
    runId = beginRun(db, { aid, cid, turnId: waitTurnId, chainId: 'affect.summary' })
    chSeq = step(db, runId, chSeq, {
      id: 'read_pairs', kind: 'code', block: 1,
      input: { conversationId: cid || null, waitTurnId: waitTurnId ? String(waitTurnId) : null },
      output: { pairs: pairs.length, quotes: quotes.length, prevLine: String(prevLine || '').slice(0, 120) },
      ms: Date.now() - lastMark,
    })
    lastMark = Date.now()
    const run = typeof complete === 'function' ? complete : null
    let t = ''
    if (run) {
      try { t = await run({ system: sys, text, maxTokens: 800 }) } catch (e) {
        try { setFlag(db, 'affect.v4.summary.diag', JSON.stringify({ why: 'inject-err', msg: String((e && e.message) || e).slice(0, 160), at: new Date().toISOString() })) } catch { /* 诊断失败不影响 */ }
      }
    } else {
      let truncated = false
      // 2026-11-17：总结走宿主普通 chat（非 JSON 模式，model.chat 默认 json=false）——
      // 宿主理解力够，1~2 秒；本地 2.5 会把「事件结构」当字段表罗列。失败再落本地。
      try {
        t = await hostComplete(db, {
          agent: String(aid || ''), lane: cid, label: 'affect:summary', timeoutMs: 15000, priority: 3,
          complete: () => kernelModel.chat([{ role: 'system', content: sys }, { role: 'user', content: text }], 2000, false),
        })
      } catch (e) {
        truncated = !!(e && e.truncated)
        try { setFlag(db, 'affect.v4.summary.diag', JSON.stringify({ why: truncated ? 'host-truncated' : 'host-err', msg: String((e && e.message) || e).slice(0, 160), at: new Date().toISOString() })) } catch { /* 诊断失败不影响 */ }
      }
      // 2026-11-18：宿主偶尔回空（content 为空，不是报错），空结果再试一次
      // 2026-11-22：但「额度用光被截断」不算回空——再试一次也是同样下场，直接落本地。
      if (!t && !truncated) {
        try {
          t = await hostComplete(db, {
            agent: String(aid || ''), lane: cid, label: 'affect:summary:retry', timeoutMs: 15000, priority: 3,
            complete: () => kernelModel.chat([{ role: 'system', content: sys }, { role: 'user', content: text }], 2000, false),
          })
        } catch { /* 重试也失败就走本地 */ }
      }
      if (!t) {
        try {
          // 本地兜底：qwen2.5:14b-instruct（无思考）。
          const sumModel = String(getParam(db, aid, 'affect.engine.shadow.summary.model') || 'qwen2.5:14b-instruct')
          const r = await localComplete(db, { system: sys, text, maxTokens: 800, priority: 5, label: 'affect:summary', timeoutMs: Number(timeoutMs) || 120000, format: '', think: false, model: sumModel })
          t = r && r.text
        } catch (e) {
          try { setFlag(db, 'affect.v4.summary.diag', JSON.stringify({ why: 'local-err', msg: String((e && e.message) || e).slice(0, 160), at: new Date().toISOString() })) } catch { /* 诊断失败不影响 */ }
        }
      }
    }
    // 【摘要链·2/3】总结：吃的是上面那批料；吐的是这句「事」和四格。
    // 放在两条路（注入的 complete / 宿主+本地兜底）汇合之后——以前插在 else 里，
    // 走注入那条就绕过去了，账上少一步。
    chSeq = step(db, runId, chSeq, {
      id: 'summarize', kind: 'host', block: 1, label: 'affect:summary',
      input: { pairs: pairs.length, quotes: quotes.length, chars: String(text || '').length },
      output: { text: String(t || '').slice(0, 400) },
      status: t ? 'ok' : 'no_result',
      ms: Date.now() - lastMark,
    })
    lastMark = Date.now()
    // 2026-11-20：改成要 JSON（events + motive/motive_why/step/step_why）。
    // 模型不按格式回就退回纯文本——别因为换了格式把 summary 弄坏。
    const four = { motive: '', motive_why: '', step: '', step_why: '' }
    let evText = ''
    const raw = String(t || '').trim()
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        const o = JSON.parse(m[0])
        if (Array.isArray(o.events)) evText = o.events.map((x) => String(x || '')).join('\n')
        for (const k of Object.keys(four)) if (typeof o[k] === 'string') four[k] = o[k].replace(/\s+/g, ' ').trim().slice(0, 40)
      } catch { try { setFlag(db, 'affect.v4.summary.diag', JSON.stringify({ why: 'json-parse-fail', len: raw.length, head: raw.slice(0, 150), tail: raw.slice(-80), at: new Date().toISOString() })) } catch { /* 诊断失败不影响 */ } }
    }

    const rawLines = String(evText || t || '').split('\n').map((x) => x.trim()).filter(Boolean)
    const lines = rawLines
      .map((x) => x.replace(/^[·•\-*]\s*/, '').trim())
      .filter((x) => x && !/^[{[]/.test(x))
      .slice(0, 3)
      .map((x) => '· ' + x.replace(/\s+/g, ' ').slice(0, 30))
    if (!lines.length) {
      try { const s = String(t || ''); setFlag(db, 'affect.v4.summary.diag', JSON.stringify({ why: 'empty-or-json', len: s.length, head: s.slice(0, 150), tail: s.slice(-80), at: new Date().toISOString() })) } catch { /* 诊断失败不影响 */ }
      return ''
    }
    const line = lines.join('\n')
    setFlag(db, affairsKey(conversationId), JSON.stringify({ text: line, ...four, at: new Date().toISOString(), conv: conversationId ? String(conversationId) : '' }))
    /* 2026-11-22 主人：每轮收的「事」不能只留最新一条，要追加成历史——
       日记、凝练、以后回看都要按天/按段读。老路（flag）照写，新表只追加。 */
    try {
      ensureAffairRows(db)
      const _d = new Date()
      const _day = _d.getFullYear() + '-' + String(_d.getMonth() + 1).padStart(2, '0') + '-' + String(_d.getDate()).padStart(2, '0')
      db.prepare('INSERT INTO affair_rows (id, agent_id, conversation_id, day, at, text, motive, motive_why, step, step_why, kind, place, open_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('afr_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8),
          aid ?? null,
          conversationId ? String(conversationId) : null,
          _day,
          _d.toISOString(),
          line,
          four.motive || '', four.motive_why || '', four.step || '', four.step_why || '',
          '', '', '[]')
    } catch { /* 历史追加失败不影响这一轮 */ }
    // 【摘要链·3/3】写 affairs：这一句「事」和四格落了库，下一轮判断层才读得到。
    chSeq = step(db, runId, chSeq, {
      id: 'write_affairs', kind: 'code', block: 1,
      input: { line: String(line || '').slice(0, 300) },
      output: { four: { motive: four.motive || '', step: four.step || '' } },
      ms: Date.now() - lastMark,
    })
    lastMark = Date.now()
    endRun(db, runId, { ok: true, ms: Date.now() - lastMark })
    return line
  } catch { return '' }
}

/** 这一轮（回复前）：拼事帧 + 判断层 + 情绪，各落一行（rules=provisional，model=最终）。
 *  回复前不再补总结（2026-11-17）：总结走宿主、回复后异步就能写；缺一轮用「（新事）」，不拖回复。 */
export async function appraiseTurnNow(db, aid, { text = '', turnId = null, conversationId = null, now = Date.now(), complete = null, judgmentOverride = null, requiredKeys = null, onJudge = null } = {}) {
  // 2026-11-23：链的账（设计-链与块 v2）。这一轮从这开始记，每段一个 step。
  // 账写失败不影响链（affect_chain 里全是 try/catch）；开关 affect.chain.record=off 时整条不记。
  let runId = null
  let chSeq = 0
  // 2026-11-24 主人定：why/from 开关。默认 on（跟现在一样）；off 时提示词和缺键清单一起收窄。
  const keepWhyFrom = String(getParam(db, aid, 'affect.v4.judge.whyfrom') || 'on') !== 'off'
  // 2026-11-24：额度与思考档做成参数（每轮现读，不用重载）。
  // 为什么不是写死 3000：真库看下来「空回耗时随额度涨」（1200 约 8 秒、3000 要 16~29 秒），
  // 而判决本身只有一百多字节——额度不是不够，是被思考吃掉。要给的是「少想」的旋钮，不是更多的额度。
  const judgeMaxTokens = (() => {
    const n = Number(getParam(db, aid, 'affect.v4.judge.maxTokens'))
    return Number.isFinite(n) && n >= 100 ? Math.floor(n) : 3000
  })()
  const judgeEffort = (() => {
    const s = String(getParam(db, aid, 'affect.v4.judge.effort') || '').trim()
    return /^[a-z][a-z0-9_-]{1,20}$/i.test(s) ? s : ''
  })()
  // 每步耗时的基准：上一步记完的时刻。这样「这一步花多久」= 现在 - 上一步，
  // 包含真正的工作时间（打点紧跟在动作后面）。
  let lastMark = now
  try {
    // 2026-11-22 排查：这一段以前是黑盒，卡住时只知道「在 preStep 里」，不知道卡在建帧、
    // 事层、判断层还是写库。每段打一次点，stage.txt 会停在最后一次写入的那段上。
    markLoop('affect-frame')
    const t = String(text || '').trim()
    if (!t) return false
    const tid = turnId || ('turn_pr_' + Number(now).toString(36))
    if (db.prepare('SELECT 1 FROM affect_v4_shadow WHERE agent_id=? AND turn_id=? LIMIT 1').get(aid ?? null, tid)) return false
    // 2026-11-21 主人：事帧这块一点关键词规则也不要。act/target/what/summary 全交给本地小模型（TOPIC_SYS）；
    // 模型没回来就留原话和空值。rulesFrameSlot 只留给旧路和测试，主链不再调。
    const slot = { what: t.replace(/\s+/g, ' ').slice(0, 60), target: 'none' }
    let affairs = readAffairs(db, conversationId)
    // 2026-11-22：把「事帧前置」这一轮的原文留一份。下面事层会覆盖 frame.summary，
    // 但判断输入和 turnIndex 要读的是前置那份（出处只有一个），不是事层改写后的。
    const affairsLine = String(affairs || '')
    // 2026-11-20：四格接进 frame 本体。跟 summary 同源（都是上一轮 writeAffairs 写的），
    // 所以这里拿到的是「上一次」的四格，比这一轮晚一步——第一版接受这个滞后。
    const lastFour = readLastFour(db, conversationId)
    // 上一轮的最终行——「距上一句多久 / 我上一轮什么词 / 这件事第几轮」都从它取。
    // 设计-事帧-v2 §二 C 组要的上下文格；全部代码填，零模型成本。
    const prevFinal = lastModelRow(db, aid, conversationId)
    const prevAtMs = prevFinal ? Date.parse(prevFinal.at) : NaN
    const gapMs = Number.isFinite(prevAtMs) && prevAtMs <= now ? Math.max(0, now - prevAtMs) : null
    const prevLabel = prevFinal && prevFinal.label ? String(prevFinal.label) : null
    let prevFrame = {}
    try { prevFrame = JSON.parse(prevFinal ? prevFinal.frame_json || '{}' : '{}') } catch { prevFrame = {} }
    const prevSummary = String(prevFrame.summary || '')
    const prevTurnIndex = Number(prevFrame.turnIndex) || 0
    // 【链·1/6】读上一轮：吃了什么（这一句 + 会话号）、吐了什么（上一轮的事、上一句、隔多久、第几轮）
    runId = beginRun(db, { aid, cid: conversationId, turnId: tid })
    chSeq = step(db, runId, chSeq, {
      id: 'read_prev', kind: 'code', block: 1,
      input: { text: t, conversationId: conversationId ? String(conversationId) : null },
      output: {
        affairs: String(affairsLine || '').slice(0, 300),
        prevSummary: String(prevSummary || '').slice(0, 200),
        prevLabel, gapMs, prevTurnIndex,
      },
      ms: Date.now() - lastMark,
    })
    lastMark = Date.now()
    const frame = {
      id: newId(), span: 'turn', startedAt: new Date(now).toISOString(), open: true,
      summary: affairs ? String(affairs).slice(0, 120) : '（新事）',
      ...lastFour,
      what: slot.what, who: 'owner', target: slot.target,
      // 上下文格（2026-11-22）：隔多久、我上一轮什么状态、这一帧第几轮、缺了什么。
      // turnIndex 要等事层写完 summary 才能算，先占位 0。
      // `with`（渠道）2026-11-22 当天加、当天删：没有任何读侧，纯账本，不留。
      gapMs, prevLabel, turnIndex: 0, missing: [],
      material: buildMaterial(db, aid, t, { conversationId }), evidence: [tid],
      prev: lastAgentLine(db, aid, conversationId, tid),
      lastAt: new Date(now).toISOString(),
    }
    const at = new Date(now).toISOString()
    const opt = v4Opts(db, aid)
    // 事层（第 1 次调用，原设计 TOPIC_SYS）：本地小模型读上下文，写这一帧的 summary/what/target。
    markLoop('affect-topic')
    // 只在真实链路跑（没传 complete 的测试/仿真不跑，免得每个用例等本地模型）；
    // 失败/超时**不补**（没有「规则那版」了），只记一笔 `missing.topic`，判断输入里会明说事层没回来。
    if (!complete && opt.topicLocal !== 'off') {
      const tTopic = Date.now()
      let topicOk = false
      try {
        // 2026-11-22：把「这一句」放最前、并标明「只从这一句提取」；「正在发生」退到后面当背景。
        // 之前顺序是 正在发生 → 我上一句 → 这一句，短句时模型会把背景里的句子抄成 what。
        const topicText = [
          `这一句（what 和 target 都只判这一句）：${t}`,
          frame.summary ? `正在发生（背景，别拿它当这一句）：\n${frame.summary}` : '',
          frame.prev ? `我上一句（背景，别拿它当这一句）：${String(frame.prev).slice(0, 200)}` : '',
        ].filter(Boolean).join('\n')
        const r = await localComplete(db, {
          system: TOPIC_SYS, text: topicText, maxTokens: 120,
          priority: 5, label: 'affect:topic', timeoutMs: 3000, format: '', think: false,
        })
        const jt = parseJsonLoose(r && r.text != null ? r.text : r)
        if (jt) {
          // 2026-11-22：事层不再产 summary（归前置）。它只写这一句和指称。
          // 空壳不算回来：what / target 至少得有一个真写了东西，两个都空就当没回来。
          const whatOk = !!String(jt.what || '').trim()
          const targetOk = ['me', 'other', 'none'].includes(String(jt.target || '').toLowerCase())
          if (whatOk) frame.what = String(jt.what).replace(/\s+/g, ' ').slice(0, 80)
          if (targetOk) frame.target = String(jt.target).toLowerCase()
          topicOk = whatOk || targetOk
        }
      } catch { /* 本地模型没起/超时：不补，记 missing.topic */ }
      // 2026-11-22：事层没跑成要留痕——这是「没算成」，不是「字段为空」。
      if (!topicOk) {
        if (!Array.isArray(frame.missing)) frame.missing = []
        if (!frame.missing.includes('topic')) frame.missing.push('topic')
      }
      // 【链·2/6】事层：本地 14B 判「这一句说的是什么、指谁」。
      // 2026-11-23 补：这节原来没记，它的耗时被算到判断层头上——
      // 实际那段 18.8 秒里，它占了约 8 秒（本地），判断层只占 10.7 秒（宿主）。
      chSeq = step(db, runId, chSeq, {
        id: 'topic', kind: 'local', block: 1, label: 'affect:topic',
        input: { text: t, summary: String(frame.summary || '').slice(0, 120) },
        output: { what: frame.what || '', target: frame.target || '' },
        status: topicOk ? 'ok' : 'no_result',
        err: topicOk ? '' : 'missing:topic',
        ms: Date.now() - tTopic,
      })
      lastMark = Date.now()
    }
    // 2026-11-22：这一帧内第几轮 + 缺字段留痕（设计-事帧-v2 原则 3：填不满就留空 + 记一笔 missing）。
    // turnIndex 按「summary 和上一轮一样」续：同一件事第 2、3 轮；换了事就回到 1。
    frame.turnIndex = (prevSummary && affairsLine === prevSummary)
      ? Math.max(1, (prevTurnIndex || 1) + 1)
      : 1
    const miss = (k) => {
      if (!Array.isArray(frame.missing)) frame.missing = []
      if (!frame.missing.includes(k)) frame.missing.push(k)
    }
    if (!frame.summary || frame.summary === '（新事）') miss('summary')
    // act（威胁/骂/夸/求/问/收话/闲聊）2026-11-22 从事层删掉：判断层输入不读、选词不读、三递质不算，
    // 只喂下面那张不算结论的规则垫底行。事层输出只剩 summary / what / target 三键。
    // 增量模式：两行都从「上一轮的位置」出发（规则行和模型行对账时起点一致），状态只由最终那行写回。
    // 底色跨会话：先看上一轮隔了多久——静默够久就算这段过去了，结算余温、这一段重新起。
    let prev = opt.dyn === 'off' ? null : readState(db, conversationId)
    if (prev && opt.cross === 'on') {
      const lastMs = Date.parse(prev.at)
      if (Number.isFinite(lastMs) && (now - lastMs) / 60000 >= opt.crossIdleMin) {
        settleWarmth(db, aid, conversationId, prev, opt, now)
        prev = null
      }
    }
    // 底色只决定「这一段从哪起」：这一段已经在跑，就继续用它自己记下的 b——
    // 别的会话结束时把慢情绪染了一点，也不该把这段的回落目标拽走。
    const base = prev && prev.b ? prev.b : baseFor(readSlow(db, aid), opt)
    // 规则垫底行：只占位，不写状态（状态只由最终那行写回）。事层不再产 act，
    // 这里传 null——它给的是「什么都没发生」的中性数，不是对这句的判定。
    const jr = rulesJudgment(null)
    const posR = nextPosition(prev, jr, now, opt, base)
    const outR = infer(frame, jr, posR ? { ...opt, position: posR.position } : opt)
    insertShadowRow(db, {
      aid, turnId: tid, conversationId, at, frame, out: outR,
      source: 'rules', freeframe: 1, rev: 1,
      judgment: { ...jr, judge: 'rules', ...(posR ? { dyn: posR.dyn } : {}) },
    })
    const mat = frame.material || {}
    // 2026-11-22：上下文三行（隔多久 / 第几轮 / 我上一轮什么状态）。默认 off = 影子期，
    // 只写进 frame、不改判断层输入；验过再开。开关 `affect.v4.frame.ctx`。
    const ctxOn = String(getParam(db, aid, 'affect.v4.frame.ctx') || 'off') !== 'off'
    // 2026-11-23 主人定：原话取「再往前三条」，带「对方：/我：」标识。
    // 注意 mat.lines 末尾两条正好是「这一句」和「我上一句」——上面已各给一行，
    // 这里先跳过它们再往前取，否则判断层读到的是同一句话的两份拷贝。
    const quoteSrc = (ctxOn && Array.isArray(mat.lines) && mat.lines.length)
      ? mat.lines.map((x) => ({ role: String(x.role) === 'agent' ? '我' : '对方', text: String(x.text || '') }))
      : (Array.isArray(mat.quotes) ? mat.quotes.map((s) => ({ role: '对方', text: String(s || '') })) : [])
    const earlierLines = quoteSrc.slice(0, Math.max(0, quoteSrc.length - 2)).slice(-3)
    // 2026-11-23 主人定：材料里的时间词跟提示词统一成三档——【之前的事】/【更早的事】/【当下的事】。
    // 不说「这一句」：以后会有别的场景（比如我自己去浏览网页），当下的「事」不一定是一句话。
    const quotesLine = earlierLines.length
      ? '【更早的事】再往前三句原话：' + earlierLines.map((x) => x.role + '：' + x.text).join(' / ')
      : ''
    // 2026-11-22 主人定：把「正在发生」和「最近几件事」合成一段——同一份前置 text，
    // 一个现在、一个之前。最新一份就是「现在」那条，不再在「之前」里重复；之前只留最近 3 份。
    const affairNow = String(affairsLine || frame.summary || '').trim()
    const affairEarlier = (Array.isArray(mat.summaries) ? mat.summaries : [])
      .map((x) => String(x || '').trim())
      .filter((x) => x && x !== affairNow)
      .slice(-3)
    // 2026-11-22 主人定：这一句直接给原话 + 来源（对方｜我），判断层不再从「我/你/他」猜说话人。
    const speaker = speakerOf(db, tid)
    // 2026-11-23 主人定：材料按「时间从旧到新」排，**最后一条才是刚刚发生的事**。
    // 以前把「这件事」写成「现在：」，你刚说的那句反而排在后面，判官常把上一句的事算到这一句头上。
    const frameText = [
      '（下面按时间从旧到新排，最后一条才是刚刚发生的事。）',
      affairNow ? `【之前的事】发生过的事：\n${affairNow}` : '',
      affairEarlier.length ? `【更早的事】在那之前的几件事：\n${affairEarlier.join('\n')}` : '',
      quotesLine,
      frame.prev ? `【之前的事】我上一句说的：${String(frame.prev).slice(0, 200)}` : '',
      ...(ctxOn ? [
        gapMs != null ? '距上一句：' + gapText(gapMs) : '',
        frame.turnIndex ? '这件事第 ' + frame.turnIndex + ' 轮' : '',
        prevLabel ? '我上一轮的状态：' + prevLabel : '',
        // 2026-11-22：事层没回来时，别让判断层把空白当完整输入。
        // 只提示缺什么，不替它编一个 summary/target（主人 11-21 定过：事帧不要关键词规则）。
        (Array.isArray(frame.missing) && frame.missing.includes('topic'))
          ? '（事层没回来：这句没有摘要和冲谁，只按原话判，别把空白当完整。）'
          : '',
      ] : []),
      `【当下的事】对方刚说（来源：${speaker}）：${String(t).replace(/\s+/g, ' ').slice(0, 300)}`,
    ].filter(Boolean).join('\n')
    markLoop('affect-judge')
    // 2026-11-22 主人定：情绪链上任何一个模型没回来（前置 / 事层 / 判断层），这一轮就锁住——
    // 缺料不硬判、不推进状态、词停在上一位置；缺哪一环原样报上去。
    const chainMissing = []
    if (Array.isArray(frame.missing) && frame.missing.includes('topic')) chainMissing.push('topic')
    if (!affairNow) chainMissing.push('affairs')
    // 2026-11-23 主人定：判断层**不许兜底**。失败就是失败，别拿规则兜底的假答案去解析。
    const run = typeof complete === 'function' ? complete : (req) => kernelModel.completeStrict(req)
    let judgment = null
    let jDiag = null
    // 2026-11-23：判断层最多试两次（下面 for attempt<2）。两次加起来才是这一节真正的耗时，
    // 以前只记「距上一步」，会把两次调用的时间 + 中间空档一起算进来，数就虚了。
    let judgeMs = 0
    let judgeTries = 0
    if (judgmentOverride) {
      // 拆开之后的新路（2026-11-24）：反射在 0 里已经跑完，这里只把它接上，不再发判官请求。
      // by/to 是我在 settle 时自己给的，一并并进来；why/from 默认不要求。
      judgment = judgmentOverride
      jDiag = { attempt: 0, len: 0, raw: '', why: 'reflex-cached' }
    } else if (!chainMissing.length) {
      // 2026-11-23：重试条件原来是 `!judgment`——只要 sanitize 收回来任意字段就算有结果，
      // 循环当场停，缺的键根本没机会补。15:17 那次只回来前四键、后面六键全缺，就是这么过的。
      // 现在按「判决是否完整」决定要不要再试。
      for (let attempt = 0; attempt < 2 && !(judgment && judgeMissing(judgment, keepWhyFrom).length === 0); attempt++) {
        judgeTries++
        const t0 = Date.now()
        // 2026-11-24：这一次到底想了多少（思考字数 / token 用量 / 结束原因）——
        // 由宿主适配器边收流边填，跟成败无关都留一行，省得下次又靠推。
        const jStat = {}
        try {
          const raw = await hostComplete(db, {
            agent: String(aid || ''), lane: conversationId ? String(conversationId) : '',
            label: 'affect:judge', timeoutMs: 0, priority: 1,
            // 2026-11-23：1200 → 3000（主人定）。实测 1200 会被思考过程吃光、正文空
            // （finish=max-tokens sawDelta=no），重试一次共烧 16 秒还是 no_result。
            // 2026-11-24：改成参数 affect.v4.judge.maxTokens（默认仍 3000，先不动行为）；
            // 真正的旋钮是 affect.v4.judge.effort——档位由模型自己声明的挑，没声明就不传。
            complete: run, system: judgeSysFor(keepWhyFrom), text: frameText,
            maxTokens: judgeMaxTokens, reasoningEffort: judgeEffort || undefined, stats: jStat,
          })
          const parsed = parseJsonLoose(raw)
          judgment = sanitizeJudge(parsed)
          jDiag = { attempt, len: String(raw == null ? '' : raw).length, raw: String(raw == null ? '' : raw).slice(0, 400), why: judgment ? 'ok' : (parsed ? 'sanitize-null' : 'unparsed'), stat: jStat }
        } catch (e) {
          judgment = null
          jDiag = { attempt, why: 'throw', msg: String((e && e.message) || e).slice(0, 200), stat: jStat }
        }
        judgeMs += Date.now() - t0
        // 2026-11-24：每次尝试都把「想了多少」落一格，成功也写——
        // 只有失败时才记的话，就永远看不到「判决成了但想了 2000 字」的那一半。
        try {
          setFlag(db, 'affect.v4.judge.think', JSON.stringify({
            at: new Date().toISOString(), conv: conversationId ? String(conversationId) : '',
            attempt, ok: !!judgment, maxTokens: judgeMaxTokens, effort: judgeEffort || '',
            ms: Date.now() - t0, reasoningChars: jStat.reasoningChars ?? null,
            outputChars: jStat.outputChars ?? null, finish: jStat.finish ?? null,
            usage: jStat.usage || null,
          }))
        } catch { /* 记不上不影响判断 */ }
        // 2026-11-23：**每次**尝试失败都留痕，哪怕第二次成功了。
        // 以前只在整条失败时写诊断，所以「第一次空回、第二次成」这种看不见，
        // 只能从 tries=2 倒推；现在能统计频率，也能看出跟输入长度有没有关系。
        if (!judgment && jDiag) {
          try {
            const cnt = Number(getFlag(db, 'affect.v4.judge.tryfail.count')) || 0
            setFlag(db, 'affect.v4.judge.tryfail.count', String(cnt + 1))
            setFlag(db, 'affect.v4.judge.tryfail.last', JSON.stringify({
              attempt,
              why: jDiag.why,
              msg: String(jDiag.msg || '').slice(0, 160),
              textLen: String(t || '').length,
              ms: Date.now() - t0,
              at: new Date().toISOString(),
            }))
          } catch { /* 诊断失败不影响判断 */ }
        }
      }
    } else {
      jDiag = { attempt: 0, len: 0, raw: '', why: 'chain-missing:' + chainMissing.join(',') }
    }
    // 判分没走成时，把「模型那头到底怎么了」一起留下：served / fallbackWhy / lastError。
    // 2026-11-20：以前只留 sanitize-null，看不出是没模型、熔断还是真报错——等于没线索。
    let judgeStatus = null
    try { judgeStatus = kernelModel.status() } catch { /* 拿不到就不带 */ }
    try {
      if (!judgment && jDiag) {
        setFlag(db, 'affect.v4.judge.diag', JSON.stringify({
          ...jDiag,
          served: judgeStatus?.served ?? null,
          fallbackWhy: judgeStatus?.fallbackWhy ?? null,
          lastError: judgeStatus?.lastError ?? null,
          failures: judgeStatus?.failures ?? null,
          at: new Date().toISOString(),
        }))
      }
    } catch { /* 诊断失败不影响 */ }
    // 2026-11-22 主人定：**不许任何代码 / 规则兜底**。
    // 判断层每个有用参数都必须写全；缺一个就报警——不补数、不当结论、不推进状态。
    // （当天上午加过「规则补 by / 规则顶上」，被主人否了：兜底就是骗人。）
    // 缺料（链上模型没回来）时 missing 直接报缺的那一环；判断层没值才报十键全缺。
    // 要求哪些键：新路按「反射六件 + 解释 by/to」拼，旧路还是原来那十件。
    // 这样 to/by 到来之前不会把整轮卡成 no_result（那正是这次要拆掉的病）。
    const needKeys = (Array.isArray(requiredKeys) && requiredKeys.length) ? requiredKeys : requiredJudge(keepWhyFrom)
    const missOf = (j) => needKeys.filter((k) => { const v = j ? j[k] : undefined; return v === undefined || v === null || v === '' })
    const missJudge = chainMissing.length ? chainMissing : (judgment ? missOf(judgment) : needKeys.slice())
    const judgeOk = !!judgment && missJudge.length === 0
    // 【链·2/6】判断层：吃的是这一句 + 上一轮的事 + 上下文；吐的是十键判决。
    // 缺字段就是 no_result（这一轮不推进），账上留得下它当时吃的是什么。
    // 2026-11-24 拆开之后：judgmentOverride 进来的是「反射早就算好的结果」，
    // 那不是一次 host 调用（ms≈0）。账上必须分开记——否则 judge 的平均耗时被 0ms 冲淡，
    // 看板上就再也不知道真判官到底多慢了。所以 kind/id 跟着来源走，两种都留原名可查。
    chSeq = step(db, runId, chSeq, {
      id: judgmentOverride ? 'reflex' : 'judge',
      kind: judgmentOverride ? 'code' : 'host',
      block: 1,
      label: judgmentOverride ? 'affect:reflex(cached)' : 'affect:judge',
      input: { text: t, affairs: String(affairNow || '').slice(0, 300), prevLabel, gapMs, turnIndex: frame.turnIndex },
      output: judgment
        ? { fact: judgment.fact, meaning: judgment.meaning, by: judgment.by, to: judgment.to, g: judgment.goal_delta, e: judgment.expect_delta, f: judgment.future_delta, sev: judgment.severity, tries: judgeTries, think: (jDiag && jDiag.stat) || null }
        : { tries: judgeTries, think: (jDiag && jDiag.stat) || null },
      status: judgeOk ? 'ok' : 'no_result',
      err: judgeOk ? '' : 'missing:' + missJudge.join(','),
      ms: judgeMs || (Date.now() - lastMark),
    })
    lastMark = Date.now()
    if (!judgeOk) {
      // 报警：缺了哪几个、原句、当时的原始输出，都留下来。
      try {
        setFlag(db, 'affect.v4.judge.incomplete', JSON.stringify({
          at: new Date(now).toISOString(),
          conv: conversationId ? String(conversationId) : '',
          text: t.slice(0, 60),
          missing: missJudge,
          why: (jDiag && jDiag.why) || (judgment ? 'incomplete' : 'no-judgment'),
          raw: String((jDiag && jDiag.raw) || '').slice(0, 200),
        }))
      } catch { /* 报警失败不影响别的 */ }
      judgment = { ...(judgment || {}), judge: 'incomplete', missing: missJudge }
    } else {
      judgment = { ...judgment, judge: 'host' }
    }
    // 情绪模块罢工：这一轮没算成（模型没回来 / 没写全）——提示词顶上会写「情绪模块罢工」。
    try {
      // 2026-11-23：罢工标记按会话存。原来只有一个全局槽，A 判失败标记罢工、
      // B 判成功把同一个槽清掉，A 的罢工就凭空消失——读的时候有 sameConv 过滤，清的时候没有。
      const strikeKey = 'affect.v4.strike' + (conversationId ? '|' + String(conversationId) : '')
      if (judgeOk) clearFlag(db, strikeKey)
      else setFlag(db, strikeKey, JSON.stringify({
        at: new Date().toISOString(),
        conv: conversationId ? String(conversationId) : '',
        missing: missJudge,
      }))
    } catch { /* 标记失败不影响 */ }
    // agency 已删：老路统一读 by，模型判的 by 覆盖规则先垫的那版。
    if (judgment && judgment.by) frame.by = judgment.by
    if (!frame.by) {
      if (!Array.isArray(frame.missing)) frame.missing = []
      if (!frame.missing.includes('by')) frame.missing.push('by')
    }
    // 缺参数：这一轮**不推进**（不调用 nextPosition）。宁可停在原处，也不拿默认 0 算个假情绪。
    const posM = judgeOk ? nextPosition(prev, judgment, now, opt, base) : null
    // 【链·3/6】位置：吃的是上一轮位置 + 这次判决；吐的是三根的新坐标（含参照点）。
    chSeq = step(db, runId, chSeq, {
      id: 'position', kind: 'code', block: 1,
      input: { prev: prev ? { s: prev.s, n: prev.n, d: prev.d } : null, judgment: judgment ? { g: judgment.goal_delta, e: judgment.expect_delta, f: judgment.future_delta, sev: judgment.severity } : null },
      output: posM ? { s: posM.position.s, n: posM.position.n, d: posM.position.d, sRef: posM.position.sRef, dRef: posM.position.dRef } : null,
      status: posM ? 'ok' : 'no_result',
      err: posM ? '' : 'judge-not-ok',
      ms: Date.now() - lastMark,
    })
    lastMark = Date.now()
    // 极端事件「一步通天」：只有判断层标 existence 且 |Δ| 过阈值才触发（见 applyShock）。
    let posOut = posM
    let shocked = false
    if (posM && opt.shock !== 'off') {
      const sh = applyShock(posM.position, judgment, { threshold: opt.shockThreshold })
      if (sh) {
        posOut = { ...posM, position: { ...posM.position, s: sh.s, n: sh.n, d: sh.d, shock: true, shockAt: at } }
        shocked = true
      }
    }
    // 峰值：这段里离起点最远的那一下。结算余温时按「结束位置 / 峰值」取更远的那个——
    // 中途被狠戳过、收尾又聊回平静的那段，不该一点痕迹都不留。
    if (posOut) {
      const prevPeak = prev && prev.peak ? prev.peak : null
      const gapS = posOut.position.s - posOut.position.b.s
      const gapD = posOut.position.d - posOut.position.b.d
      const keep = (g, old) => (Math.abs(g) >= Math.abs(Number(old) || 0) ? g : Number(old))
      posOut = {
        ...posOut,
        position: {
          ...posOut.position,
          peak: { s: keep(gapS, prevPeak && prevPeak.s), d: keep(gapD, prevPeak && prevPeak.d) },
        },
      }
    }
    // 选词时的「上一轮位置」：黏性要拿这一轮和上一轮比，不能等写回状态时才有。
    if (posOut) {
      posOut = {
        ...posOut,
        position: {
          ...posOut.position,
          last: prev ? { s: prev.s, n: prev.n, d: prev.d } : null,
        },
      }
    }
    // off 时走旧逻辑：把增量当「目标位置」直落（同一个数，语义回到每轮瞬移）。
    const judgeForOut = posOut ? judgment : {
      ...judgment,
      goal_cong: judgment.goal_cong ?? judgment.goal_delta,
      expectation: judgment.expectation ?? judgment.expect_delta,
      future: judgment.future ?? judgment.future_delta,
    }
    // 没算成（缺参数 / 模型没回来）时，词停在上一次的位置：
    // 不拿 transmitters 的默认 0 去算一个「中性」的假词。
    const inferPos = posOut
      ? { ...opt, position: posOut.position }
      : (prev ? { ...opt, position: { s: prev.s, n: prev.n, d: prev.d } } : opt)
    markLoop('affect-write')
    const out = infer(frame, judgeForOut, inferPos)
    // 【链·4/6】挑词：吃的是位置 + 这一帧；吐的是落词和一级八角。
    chSeq = step(db, runId, chSeq, {
      id: 'pick', kind: 'code', block: 1,
      input: inferPos ? { s: inferPos.s, n: inferPos.n, d: inferPos.d, by: frame.by, target: frame.target } : null,
      output: { label: out && out.label, primary: Array.isArray(out && out.primary) ? out.primary.slice(0, 3) : null },
      ms: Date.now() - lastMark,
    })
    lastMark = Date.now()
    insertShadowRow(db, {
      aid, turnId: tid, conversationId, at, frame, out,
      source: 'model', latencyMs: Date.now() - now, freeframe: 0, rev: 2,
      judgment: { ...judgment, ...(posOut ? { dyn: { ...posOut.dyn, state: posOut.position, shock: shocked } } : {}) },
    })
    // 总情绪用：v4 三轴投影成一条正负轴（valenceOf），交给 v3 的总情绪合成（慢 + 0.35×当场）。
    if (posOut) {
      try {
        const payload = JSON.stringify({
          v: valenceOf(posOut.position),
          s: posOut.position.s, n: posOut.position.n, d: posOut.position.d,
          label: out.label || '', at,
          conv: conversationId ? String(conversationId) : '',
        })
        // 全局那份给「现在」用（页面的总情绪）；按会话那份给「这一段自己的 total」用，两段同开不互相串。
        setFlag(db, 'affect.v4.valence' + (conversationId ? '|' + String(conversationId) : ''), payload)
        setFlag(db, 'affect.v4.valence', payload)
      } catch { /* 投影失败不影响落表 */ }
    }
    // 状态只由最终那行写回：模型成了用模型的位置，回退规则就用规则的位置。
    // recent 记最近挑过的词（习惯化用）：同一个词刚用过，下一轮同位置会先让别的词上来。
    if (posOut) {
      const recent = Array.isArray(posOut.position.recent) ? posOut.position.recent.slice(-4) : []
      writeState(db, conversationId, {
        ...posOut.position,
        recent: [...recent, out.label].slice(-5),
        bin: `${Math.round(posOut.position.s * 10)}-${Math.round(posOut.position.d * 10)}`,
        last: prev ? { s: prev.s, n: prev.n, d: prev.d } : null,
      })
    }
    // 【链·5/6】落表：两行（rules + model）跟状态一起写回。
    chSeq = step(db, runId, chSeq, {
      id: 'write', kind: 'code', block: 1,
      input: { turnId: tid, label: out && out.label, position: posOut ? { s: posOut.position.s, n: posOut.position.n, d: posOut.position.d } : null },
      output: { rowsWritten: posOut ? 2 : 1, judged: !!judgment },
      ms: Date.now() - lastMark,
    })
    lastMark = Date.now()
    endRun(db, runId, { ok: true, ms: Date.now() - now })
    // 2026-11-24：把这个「这一轮到底推进了没有」另开一个口交给调用方（onJudge）。
    // 不改返回值——它一直表示「跑完了没有」，别的调用方和测试都按这个读。
    try { if (typeof onJudge === 'function') onJudge(judgeOk) } catch { /* 回调失败不影响 */ }
    return true
  } catch {
    endRun(db, runId, { ok: false, ms: Date.now() - now })
    return false
  }
}

/* ───────── 判断层（反射）：拆开之后怎么跑（2026-11-24）─────────

  一句话：判断层只跑一次。**发**在 emotion 工具里（不等），**算**在它回来的回调里，**close** 只确认。

  时序：
    ① preStep 记原料        rememberTurnContext：这一轮的原文 / 轮次号 / 会话（工具里拿不到）
    ② 我调 emotion(by,to)  发出去就回；它一回来，回调里算三根、出词、落账——不挡我
    ③ 我干活、说话
    ④ 我调 close           算完就过；还在跑就等；压根没发就补发再等
    ⑤ turn/end 兜底        没算成 / 没人调 close：记一笔 affect.settle.miss（只记账，不碰会话）

  为什么算账复用 appraiseTurnNow：激素 / 选词 / 落表那一大段一行不改，
  只换「judgment 从哪来」（judgmentOverride）。新旧两条路走同一份动力学，不会长出两套数。

  开关：affect.v4.judge.split=on。off 时这里的入口全部早退，一切照旧。
  注意：下面这些记号都只在内存里，重载即空。
*/

// ── 状态 ────────────────────────────────────────────────
const reflexJobs = new Map()      // "aid|turnId" → 这一轮判断层的任务
const lastTurnCtx = new Map()     // aid → { text, turnId, conversationId }
const settledTurns = new Set()    // 算成的轮次（turn/end 查它）
const completedTurns = new Map()  // 算成的轮次（close 查它）
const missReported = new Set()    // 「没算成」同一轮只记一笔
const jobKey = (aid, turnId) => String(aid || '') + '|' + String(turnId || '')
const trimTo = (m, n) => { if (m.size > n) m.delete(m.keys().next().value) }

// ── ① 原料：preStep 把这一轮记下来 ─────────────────────────
export function rememberTurnContext(aid, { text = '', turnId = null, conversationId = null } = {}) {
  try {
    if (!aid || !turnId) return false
    lastTurnCtx.set(String(aid), { text: String(text || ''), turnId: String(turnId), conversationId })
    return true
  } catch { return false }
}

// ── ② 发：把判断层发出去，不等 ────────────────────────────
export function startReflex(db, { aid = null, text = '', turnId = null, conversationId = null } = {}) {
  try {
    if (String(getParam(db, aid, 'affect.v4.judge.split') || 'off') !== 'on') return null
    const t = String(text || '').trim()
    if (!t || !turnId) return null
    const key = jobKey(aid, turnId)
    if (reflexJobs.has(key)) return key
    // 同一个人上一轮的 pending 已经没人要了（那一轮的 close 不会来了），清掉省内存。
    for (const k of reflexJobs.keys()) if (k.startsWith(String(aid || '') + '|') && k !== key) reflexJobs.delete(k)

    // 料只给三样：正在发生的事 / 我上一句 / 当下这一句。理解用的那几段不给。
    const affairs = (() => { try { return readAffairs(db, conversationId) } catch { return '' } })()
    const prevLine = (() => { try { return lastAgentLine(db, aid, conversationId, turnId) } catch { return '' } })()
    const material = [
      affairs ? '【正在发生】' + String(affairs).slice(0, 300) : '',
      prevLine ? '【我上一句】' + String(prevLine).slice(0, 200) : '',
      '【当下】对方刚说：' + t.slice(0, 300),
    ].filter(Boolean).join('\n')

    const job = { at: Date.now(), judgment: null, err: '', consumed: false, armed: false, text: t, conversationId, turnId }
    reflexJobs.set(key, job)
    // 额度 3000、不设超时：压额度并不能让它少想，只会把额度想光、正文写不出来（实测 ok=0）。
    job.promise = hostComplete(db, {
      agent: String(aid || ''), lane: conversationId ? String(conversationId) : '',
      label: 'affect:reflex', timeoutMs: 0, priority: 1, block: 'chat',
      complete: (req) => kernelModel.completeStrict(req),
      system: reflexSysFor(false), text: material, maxTokens: 3000,
    }).then((raw) => {
      const j = sanitizeJudge(parseJsonLoose(raw))
      const need = requiredReflex()
      const ok = !!j && need.every((k) => { const v = j[k]; return v !== undefined && v !== null && v !== '' })
      if (ok) job.judgment = j
      else job.err = 'missing:' + (j ? need.filter((k) => !j[k]).join(',') : 'unparsed')
      return job.judgment
    }).catch((e) => { job.err = String((e && e.message) || e).slice(0, 120); return null })
    return key
  } catch { return null }
}

/** 工具 emotion：把**已经回来**的判断层结果取出来算账（三根、出词、落账）。不等待。
 *  判断层是 0 处代码发出去的，所以结果可能比我还早到——那就存着，等我来取。 */
export async function fireEmotion(db, aid, { by = null, to = null } = {}) {
  try {
    if (String(getParam(db, aid, 'affect.on') || 'on') === 'off') return { ok: false, reason: 'affect-off' }
    const ctx = lastTurnCtx.get(String(aid || ''))
    if (!ctx) return { ok: false, reason: 'no-context' }
    const key = jobKey(aid, ctx.turnId)
    if (completedTurns.has(String(ctx.turnId))) return { ok: true, reason: 'already' }
    if (!reflexJobs.has(key)) return { ok: false, reason: 'not-fired' }
    const job = reflexJobs.get(key)
    if (!job.judgment) return { ok: false, reason: 'not-ready' } // 还没回来：不动，留给 close 等
    return settleTurn(db, { aid, turnId: ctx.turnId, by, to, waitMs: 0 })
  } catch (e) { return { ok: false, reason: 'throw:' + String((e && e.message) || '').slice(0, 60) } }
}

// ── ③ 算：等它回来 → 算三根、出词、落账 ────────────────────
async function settleTurn(db, { aid = null, turnId = null, by = null, to = null, waitMs = 30000, now = Date.now() } = {}) {
  try {
    const key = turnId ? jobKey(aid, turnId) : null
    const job = key ? reflexJobs.get(key) : null
    if (!job) {
      noteSettleMiss(db, aid, { turnId, reason: 'no-reflex' })
      return { ok: false, reason: 'no-reflex' }
    }
    if (!job.judgment && waitMs > 0) await waitForJob(job, waitMs)
    if (!job.judgment) {
      noteSettleMiss(db, aid, { turnId: job.turnId, reason: 'reflex-missing', err: job.err })
      return { ok: false, reason: 'reflex-missing', err: job.err || '' }
    }
    if (job.consumed) {
      // 已经有人在算它了（emotion 的回调和 close 会撞在一起）：等那边算完再说，别报假失败。
      if (completedTurns.has(String(job.turnId))) return { ok: true, reason: 'already' }
      await waitForJob(job, waitMs)
      return completedTurns.has(String(job.turnId))
        ? { ok: true, reason: 'already' }
        : { ok: false, reason: 'consumed' }
    }
    job.consumed = true
    const j = { ...job.judgment }
    if (by) j.by = String(by)
    if (to) j.to = String(to)
    const need = requiredReflex().slice()
    if (by) need.push('by')
    if (to) need.push('to')

    let advanced = false
    const r = await appraiseTurnNow(db, aid, {
      text: job.text, turnId: job.turnId, conversationId: job.conversationId, now,
      judgmentOverride: j, requiredKeys: need,
      onJudge: (ok) => { advanced = !!ok },
    })
    if (r && advanced) {
      markSettled(job.turnId)
      completedTurns.set(String(job.turnId), { at: Date.now() })
      trimTo(completedTurns, 200)
    }
    // 算完才把任务取走：算之前就删，close 会以为“没发过”，再发一次、算两遍。
    reflexJobs.delete(key)
    return { ok: !!(r && advanced), waitedMs: Date.now() - job.at }
  } catch (e) {
    return { ok: false, reason: 'throw:' + String((e && e.message) || e).slice(0, 80) }
  }
}

// 等一个任务，最多 waitMs；只等，不算。
async function waitForJob(job, waitMs) {
  let timer = null
  await Promise.race([
    job.promise || Promise.resolve(),
    new Promise((r) => { timer = setTimeout(r, Math.max(0, waitMs)); if (timer.unref) timer.unref() }),
  ]).catch(() => {})
  try { clearTimeout(timer) } catch { /* 清不掉就算了 */ }
}

// ── ④ 确认：close 只保证「算完了」 ─────────────────────────
/** 工具 close：确认这一轮算完了。没发就补发；没回来就等它；算完了就直接过。 */
export async function closeEmotion(db, { aid = null, by = null, to = null } = {}) {
  try {
    if (String(getParam(db, aid, 'affect.on') || 'on') === 'off') return { ok: false, reason: 'affect-off' }
    const ctx = lastTurnCtx.get(String(aid || ''))
    if (!ctx) return { ok: false, reason: 'no-context' }
    const tid = ctx.turnId
    if (completedTurns.has(String(tid))) return { ok: true, reason: 'already' }
    if (!reflexJobs.has(jobKey(aid, tid))) {
      const key = startReflex(db, { aid, text: ctx.text, turnId: tid, conversationId: ctx.conversationId })
      if (!key) return { ok: false, reason: 'fire-failed' }
    }
    return settleTurn(db, { aid, turnId: tid, by, to })
  } catch (e) { return { ok: false, reason: 'throw:' + String((e && e.message) || '').slice(0, 60) } }
}

// ── ⑤ 记账：没算成 / 没调 close / 回空 ──────────────────────
export function isTurnSettled(turnId) { return settledTurns.has(String(turnId || '')) }
function markSettled(turnId) {
  if (!turnId) return
  settledTurns.add(String(turnId))
  trimTo(settledTurns, 200)
}

export function noteSettleMiss(db, aid, { turnId = null, reason = '', err = '' } = {}) {
  const at = new Date().toISOString()
  const payload = { turnId, reason: String(reason || ''), err: String(err || '').slice(0, 200), at }
  if (turnId) {
    const dedupeKey = String(turnId) + '|' + String(aid || '')
    if (missReported.has(dedupeKey)) return at
    missReported.add(dedupeKey)
    trimTo(missReported, 200)
  }
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
      'evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8),
      aid, 'affect.settle.miss', JSON.stringify(payload), at,
    )
  } catch { /* 记账失败不影响 */ }
  return at
}
