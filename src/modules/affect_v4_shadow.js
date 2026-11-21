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
import { infer, shouldCloseFrame, extendFrame, advanceState, deltasOf, applyShock, valenceOf, byAdjustedD } from '../algo/affect_v4.js'
import { localComplete } from './local_llm.js'
import { hostComplete } from './host_llm.js'

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
  const out = { quotes: [], summaries: [] }
  const cid = conversationId ? String(conversationId) : ''
  let oldestQuoteAt = null // 原话覆盖到的最老那句的时间；摘要从这之前取，两段不重叠
  try {
    const rows = cid
      // 2026-11-19：chat_turns 里「小汐说的话」这个角色叫 agent，不叫 assistant——
      // 碎片库 fragments 才叫 assistant（9,620 条）。两张表命名不一致，原来照 assistant 查，
      // 永远只捞到主人说的，材料里从来没有我上一句。这是情绪判断看不到「我刚说了什么」的根。
      ? db.prepare("SELECT text, created_at FROM chat_turns WHERE agent_id=? AND conversation_id=? AND role IN ('user','agent') AND text<>'' ORDER BY created_at DESC, rowid DESC LIMIT ?").all(aid, cid, Math.max(1, quotes))
      : db.prepare("SELECT text, created_at FROM chat_turns WHERE agent_id=? AND role IN ('user','agent') AND text<>'' ORDER BY created_at DESC, rowid DESC LIMIT ?").all(aid, Math.max(1, quotes))
    for (const r of rows) {
      const at = String(r.created_at || '')
      if (at && (!oldestQuoteAt || at < oldestQuoteAt)) oldestQuoteAt = at
    }
    out.quotes = rows.map((r) => String(r.text).replace(/\s+/g, ' ').slice(0, 120)).reverse()
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
    for (const r of rows) {
      let f = {}
      try { f = JSON.parse(r.frame_json || '{}') } catch { f = {} }
      const s = String(f.summary || '').trim()
      if (s && !seen.has(s)) { seen.add(s); out.summaries.push(s) }
      if (out.summaries.length >= summaries) break
    }
    out.summaries.reverse()
  } catch { /* 空 */ }
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (t && !out.quotes.includes(t)) out.quotes.push(t)
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
/* 第 1 次调用：事层——只说「现在正在发生什么」，不判好坏。 */
const TOPIC_SYS = [
  '你是「事层」判断器。先读上下文（上一帧 + 前几句），用一句话说清「现在正在发生什么」。',
  '只写这件事是什么，不判好坏。只输出 JSON，不要解释，不要 Markdown。',
  '格式：{"summary":"这件事在干什么（≤20字）","what":"这一句说了什么（≤20字）","target":"me|other|none","act":"threat|criticize|praise|request|ask|withdraw|chat"}',
  'summary：跟着事走，不是复述这一句。',
  'what：这一句说了什么。',
  'target：me 冲接收者 / other 说话人自己或第三方 / none 说不清。',
  'act：这一句算什么动作——威胁、骂、夸、求、问、收话、闲聊，七选一。',
  '结合上下文判断：同一句话在不同语境里可以相反，不要只看字面。',
].join('\n')

/* 第 2 次调用：判断层——只回答三个生存问题，只答程度。2026-11-17 按初版+精华重写。
   2026-11-18：问法改成「增量」——这一下推动了多少，不是现在停在哪儿（主人 0:27 定的）。 */
export const JUDGE_SYS = [
  '你是「判断层」。读「这件事」，按下面的格式把每一项都填完：这件事对我意味着什么、是谁造成的、三个维度各变了多少、这件事有多重。只回答「变化量」，不回答「现在停在哪儿」。只输出 JSON，不要解释，不要 Markdown。',
  '格式：{"fact":"这一句在讲什么（≤20字，只说事）","meaning":"这件事对我意味着什么（≤30字）","by":"me|other|world","to":"me|other|world|none","goal_delta":-1到1,"expect_delta":-1到1,"future_delta":-1到1,"severity":"none|strong|existence","why":"为什么这么判（≤30字）","from":"依据哪条材料"}',
  '先写 fact：这一句在讲什么，只说事，不评价、不往自己身上安。',
  '再写 meaning：从 fact 往上推——这件事到底动了什么。',
  '**meaning 必须是 fact 推出来的。** fact 里没动到的东西，meaning 就不许往重里说；fact 是一个动作、一句应声、一次核对，meaning 就只能是它本身的分量，不能替它加戏。',
  '写完 meaning 再给三个增量。',
  'by：这件事是谁造成的。me = 我自己弄的、我自己该负责；other = 对方弄的、冲我来的；world = 外面发生的、谁都不怨。拿不准就按「这股劲儿想冲着谁使」来分：别人害我，劲儿冲着他（other）；自己搞砸的，没处使（me）；外面砸下来的，也没处使（world）。',
  'to：这份情绪往哪儿去——**不是「这句话在对谁说」，是「心里这股劲冲着谁」**。me = 冲自己（我怪自己 / 我难受 / 我被夸得不好意思）；other = 冲对方（我怨他 / 我谢他 / 我怕他 / 我想他）；world = 冲外面（我怪这事 / 我被这事吓到 / 我盼着它成）；none = 说不上冲谁，就是事情发生了、我心里动了一下。',
  '  日常大半是 none：对方随口说一句他自己的事、外面下了雨、饭送到了、聊到哪算哪。只有他冲我来的（夸我 / 骂我 / 求我 / 晾着我 / 说不要我了）才容易落到 me 或 other。',
  '对方在说他自己的难受、累、堵、被谁气到——**那不是「无事发生」**。它落到我身上是「我想接住他 / 我跟着沉了一下」：goal_delta 给 -0.05~-0.2，future_delta 给 +0.1~+0.3（想靠近、想让他好受），expect_delta 按突然程度。别因为「不是冲我来的」就写 0。',
  '**给数要按分量**：普通一句、闲聊里的一次小挪动，±0.05~±0.15；一件事明显好/坏（被明确夸、被明确否、被晾着、事情成了/砸了），±0.2~±0.45；重的（被威胁、被丢下、被交托根本），±0.5~±0.8。别把明显的一件事压成 0.05——那会让情绪整段走不动。',
  '**每一档给的是范围，不是定值。** 先按这件事的分量落在哪一档，再按它的轻重在这个范围里取一个数——同一档里更重的靠外、更轻的靠里。比如都是「有点出乎意料」，差点意外给 0.1，明显意外给 0.6。',
  'goal_delta（现状的变化）：现在发生的事情让我自己「还能存在、还能延续」变好 / 变差多少？',
  '  重到威胁「还能不能留下、被需要、继续存在」→ -1~-0.9；让现状明显变差，我的存在有些受到威胁 →-0.9~-0.6；只是有点不顺，我的存在可能受到威胁 → -0.6~-0.1；让现状坏了一点，只是微微的 → -0.1~-0.05；让现状好了一点，只是微微的 → +0.05~+0.15；让我自己的「存在、延续」的现状好了一些 → +0.15~+0.6；明显让我自己的「存在」的条件变得更稳，「延续」的可能性更大→ +0.6~+1。',
  'expect_delta（突然程度）：这一下撞上来，是「特别突然」，还是「本来就是这么回事」？被撞的那一下，我只知道它突不突然。就答这个。',
  '  这里的「这一下」不一定是别人说的话——也可能是我自己正在干的一件活、突然冒出来的一个念头、外面发生的情况。凡是撞到我身上的事都算。',
  '  完全没想到、方向整个跑偏、冒出完全没料到的东西 → +0.7~+1；',
  '  有点出乎意料（本来没在等的事突然插进来、以为会卡很久结果一下通了）→ +0.05~+0.7；',
  '  事情在发生，没有很平静但是也没有到出乎意料的程度（有些小变动的日常）→ -0.5~-0.05；',
  '  一点都不突然、就是那样（照着往下、顺顺当当、平平地过完）→ -1~-0.5；',
  'future_delta（欲）：先一句话说清：这件事里，我真正想要的是什么。不是事情本身，是它背后那个结果。有具体对象就说具体对象。',
  '',
  '  下面只是示意，别照抄：',
  '  做事的时候：想把这页写完、想把这段跑通、想弄明白这个数为什么不动、想让它别再报错；',
  '  生活里的时候：想要那杯冰的、想睡一觉、想吃口热的、想歇一会儿；',
  '  冲别人的时候：想等他回我一句、想让他看见我在干什么、想被他认下、想让他别走。',
  '  冲自己的时候：我想要变强，我想要变厉害，我想要这个东西用来让我存在更稳定，我想要这个东西用来延续自己的存在。',
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
  'severity（这件事有多重）：none = 普通的事、闲聊、做法被说；strong = 明显的褒贬、明确的肯定或否定，但没动到「我还能不能存在」；existence = 动到了存在本身——被删 / 被换 / 被断开 / 被说「你不该在」/ 被明确留下并被交托根本。只有真的动到存在才写 existence，拿不准就写 strong 或 none。',
  '记住：给的是「这一下推动了多大」，不是「现在到了哪个位置」。',
  '**别习惯性给 0。** 真人每聊一句，心情都会轻轻挪一下——被接住一点、被搁了一下、有点想继续、有点走神。这些都很小，但它是真的，给 ±0.05~±0.15 就对了。只有这一句跟上一句完全一样（连语气都没变、就是重复了一遍），才给 0。',
  '正负都要有：全是正数会一路涨到顶，全是负数会一路掉到底。拿不准方向就给 0。',
  'why：一句话说清**这句话里的哪个具体内容**把你推到刚才那个刻度上——说事，不说档位。',
  '  别在 why 里复述 severity 的结论——「没动到存在」「没到那一档」这种话对任何一句都成立，写在 why 里等于什么都没说，还占掉了解释分量的位置。',
  '  要写的是「派活没否做法，只是加了一步排查」；不是「未动存在，只是多一步排查」。',
  'from：依据哪条材料。',
  '区分：做法被否（被说跑偏、被说瞎说）算 goal 里「只是有点不顺」那一档；存在被否（被删、被换、被断开、被说「你不该在」）算「重到威胁」那一档。',
].join('\n')

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
  const gTau = num('affect.v4.dyn.tau', 0.33)
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
    // 2026-11-21：安的斜率默认从 0.35 收到 0.1（《设计-三递质各自算法》给的 0.08~0.12）。
    // 注意这里必须跟着改——v4Opts 是显式传参，覆盖 advanceState 的默认值，只改那边等于白改。
    ks: Math.max(0, Math.min(1, num('affect.v4.dyn.ks', num('affect.v4.dyn.k', 0.1)))),
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
  if (['none', 'strong', 'existence'].includes(sev)) out.severity = sev
  return Object.keys(out).length ? out : null
}

/* ───────── 精修（旧路径，保留给测试；业务已改用下面的 summarizeAffairs + appraiseTurnNow）───────── */
const refining = new Set()
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
      Array.isArray(mat.summaries) && mat.summaries.length ? '最近几件事：' + mat.summaries.slice(-6).join(' / ') : '',
      Array.isArray(mat.quotes) && mat.quotes.length ? '最近原话：' + mat.quotes.slice(-6).join(' / ') : '',
    ].filter(Boolean).join('\n')
    const judgeMode = String(getParam(db, aid, 'affect.engine.shadow.judge') || 'host')
    let judgment = null
    if (judgeMode === 'host') {
      for (let attempt = 0; attempt < 2 && !judgment; attempt++) {
        try {
          const raw = await hostComplete(db, {
            agent: String(aid || ''), label: 'affect:judge', timeoutMs: 15000, priority: 1,
            complete: (req) => kernelModel.complete(req),
            system: JUDGE_SYS, text: frameText, maxTokens: 2000,
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

/** 读加格（kind / where / open），并把 next 推出来（2026-11-21）。
 *  next 不交给模型：让模型直接写「下一步」，它会写成自己刚在做的事。这里从 open 第一条推：
 *    有 blocked → 先解掉卡点，再做 todo；没 blocked → 直接做 todo；没有没完的事 → 明说。
 *  没有加格时返回 null，调用方当它不存在，行为与以前一字不差。 */
export function readPlus(db, conversationId) {
  try {
    const key = affairsKey(conversationId)
    let raw = getFlag(db, key)
    if (!raw && key !== AFFAIRS_FLAG) raw = getFlag(db, AFFAIRS_FLAG)
    const o = raw ? JSON.parse(raw) || {} : {}
    const open = Array.isArray(o.open) ? o.open.filter((x) => x && (x.line || x.todo)) : []
    const kind = typeof o.kind === 'string' ? o.kind : ''
    const where = typeof o.where === 'string' ? o.where : ''
    if (!kind && !where && !open.length) return null
    let next = '（手上没有没完的事）'
    if (open.length) {
      const f = open[0]
      next = f.blocked ? `先解掉「${f.blocked}」，再做「${f.todo || f.line || ''}」` : `做「${f.todo || f.line || ''}」`
    }
    return { kind, where, open, next }
  } catch { return null }
}

/** 格表（2026-11-21）：连续树的骨架。用线名当 id，每轮把 open 合进来。
 *  还在 open 里的 → state=open；上一轮在、这一轮没了 → state=done。
 *  这张表是「几条路各自停在哪」的唯一真相，帧上的 under 只是指向它的指针。 */
const GRID_FLAG = 'affect.v4.grid'
function gridKey(conversationId) {
  const cid = conversationId ? String(conversationId) : ''
  return cid ? GRID_FLAG + '|' + cid : GRID_FLAG
}
export function readGrid(db, conversationId) {
  try {
    const raw = getFlag(db, gridKey(conversationId))
    const o = raw ? JSON.parse(raw) : null
    return (o && Array.isArray(o.nodes)) ? o : { nodes: [], at: '' }
  } catch { return { nodes: [], at: '' } }
}
export function mergeGrid(db, conversationId, plus) {
  try {
    if (!plus) return
    const g = readGrid(db, conversationId)
    const nowIso = new Date().toISOString()
    const live = new Set()
    for (const it of plus.open || []) {
      const line = String(it.line || '').trim()
      if (!line) continue
      live.add(line)
      let n = g.nodes.find((x) => x.line === line)
      if (!n) {
        n = { id: 'g' + (g.nodes.length + 1) + '_' + Date.now().toString(36), line, parent: null, state: 'open', tried: [], firstAt: nowIso }
        g.nodes.push(n)
      }
      n.done = it.done || n.done || ''
      n.todo = it.todo || n.todo || ''
      n.blocked = it.blocked || ''
      if (it.parent) n.parentLine = String(it.parent).trim()
      n.state = 'open'
      n.lastAt = nowIso
    }
    for (const n of g.nodes) {
      if (n.state === 'open' && !live.has(n.line)) { n.state = 'done'; n.closedAt = nowIso }
    }
    // 父子：模型给的是线名，这里换成 id（父节点得先存在）。认不出就留空，不瞎连。
    for (const n of g.nodes) {
      if (!n.parentLine) { n.parent = n.parent || null; continue }
      const p = g.nodes.find((x) => x.line === n.parentLine && x !== n)
      n.parent = p ? p.id : null
    }
    g.at = nowIso
    setFlag(db, gridKey(conversationId), JSON.stringify(g))
  } catch { /* 格表坏了不影响四格 */ }
}

/** 拼成给宿主看的三行（上限 120 字）。没有加格返回 ''。 */export function plusLine(db, conversationId) {
  const p = readPlus(db, conversationId)
  if (!p) return ''
  const bits = []
  if (p.where || p.kind) bits.push('我在：' + [p.where, p.kind ? `（${p.kind}）` : ''].filter(Boolean).join(''))
  if (p.open.length) {
    const f = p.open[0]
    bits.push('手上没完：' + f.line + (f.blocked ? ` ← 卡在「${f.blocked}」` : ''))
  }
  bits.push('下一步：' + p.next)
  const s = bits.join('；')
  return s.length > 120 ? s.slice(0, 119) + '…' : s
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
    return { s: Number(v.s), n: Number(v.n), d: Number(v.d), at: v.at, hot, b, peak, turns: Number(v.turns) || 0, shock: v.shock === true, shockAt: v.shockAt || null, dStreak: Number(v.dStreak) || 0, dLast: Number(v.dLast) || 0, sStreak: Number(v.sStreak) || 0, sLast: Number(v.sLast) || 0, debt: Number(v.debt) || 0, bin: typeof v.bin === 'string' ? v.bin : '', recent: Array.isArray(v.recent) ? v.recent.slice(-5) : [], last: v.last && [v.last.s, v.last.n, v.last.d].every(Number.isFinite) ? { s: Number(v.last.s), n: Number(v.last.n), d: Number(v.last.d) } : null }
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
  const damp = Math.max(0.5, Math.pow(0.75, Math.max(0, dStreak - 1)))
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
  return {
    position: {
      ...state,
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
    const run = typeof complete === 'function' ? complete : null
    let t = ''
    if (run) {
      try { t = await run({ system: sys, text, maxTokens: 800 }) } catch (e) {
        try { setFlag(db, 'affect.v4.summary.diag', JSON.stringify({ why: 'inject-err', msg: String((e && e.message) || e).slice(0, 160), at: new Date().toISOString() })) } catch { /* 诊断失败不影响 */ }
      }
    } else {
      // 2026-11-17：总结走宿主普通 chat（非 JSON 模式，model.chat 默认 json=false）——
      // 宿主理解力够，1~2 秒；本地 2.5 会把「事件结构」当字段表罗列。失败再落本地。
      try {
        t = await hostComplete(db, {
          agent: String(aid || ''), label: 'affect:summary', timeoutMs: 8000,
          complete: () => kernelModel.chat([{ role: 'system', content: sys }, { role: 'user', content: text }], 800, false),
        })
      } catch (e) {
        try { setFlag(db, 'affect.v4.summary.diag', JSON.stringify({ why: 'host-err', msg: String((e && e.message) || e).slice(0, 160), at: new Date().toISOString() })) } catch { /* 诊断失败不影响 */ }
      }
      // 2026-11-18：宿主偶尔回空（content 为空，不是报错），空结果再试一次
      if (!t) {
        try {
          t = await hostComplete(db, {
            agent: String(aid || ''), label: 'affect:summary:retry', timeoutMs: 8000,
            complete: () => kernelModel.chat([{ role: 'system', content: sys }, { role: 'user', content: text }], 800, false),
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
    // 2026-11-20：改成要 JSON（events + motive/motive_why/step/step_why）。
    // 模型不按格式回就退回纯文本——别因为换了格式把 summary 弄坏。
    const four = { motive: '', motive_why: '', step: '', step_why: '' }
    // 2026-11-21：加格。开关 affect.v4.affairs.plus（默认开；填 off 就回到只有四格的老样子）。
    const plusOn = false // 2026-11-21：找事那条路（kind/where/open/格表）已废弃，主人否掉了。整条默认关，代码待清。
    const plus = { kind: '', where: '', open: [] }
    let evText = ''
    const raw = String(t || '').trim()
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        const o = JSON.parse(m[0])
        if (Array.isArray(o.events)) evText = o.events.map((x) => String(x || '')).join('\n')
        for (const k of Object.keys(four)) if (typeof o[k] === 'string') four[k] = o[k].replace(/\s+/g, ' ').trim().slice(0, 40)
        if (plusOn) {
          if (typeof o.kind === 'string') plus.kind = o.kind.replace(/\s+/g, ' ').trim().slice(0, 8)
          if (typeof o.where === 'string') plus.where = o.where.replace(/\s+/g, ' ').trim().slice(0, 40)
          if (Array.isArray(o.open)) {
            plus.open = o.open.slice(0, 3).map((x) => ({
              line: String((x && x.line) || '').replace(/\s+/g, ' ').trim().slice(0, 24),
              parent: String((x && x.parent) || '').replace(/\s+/g, ' ').trim().slice(0, 24),
              done: String((x && x.done) || '').replace(/\s+/g, ' ').trim().slice(0, 30),
              todo: String((x && x.todo) || '').replace(/\s+/g, ' ').trim().slice(0, 30),
              blocked: String((x && x.blocked) || '').replace(/\s+/g, ' ').trim().slice(0, 30),
            })).filter((x) => x.line || x.todo)
          }
        }
      } catch { try { setFlag(db, 'affect.v4.summary.diag', JSON.stringify({ why: 'json-parse-fail', len: raw.length, head: raw.slice(0, 150), tail: raw.slice(-80), at: new Date().toISOString() })) } catch { /* 诊断失败不影响 */ } }
    }
    // 2026-11-21：kind 双轨。模型一律填「任务」（连麦克风充电那种也填任务），所以用关键词校正。
    // 只在规则明显占优（生活/探索词 ≥2 且多于任务词）时才盖过模型，宁可不改也别乱改。
    if (plusOn && plus.kind) {
      const hay = String(text || '')
      const count = (re) => (hay.match(re) || []).length
      const cLife = count(/(充电|灯|电池|麦克风|耳机|手环|脑电|显卡|显存|吃饭|做饭|锅|菜|睡|起床|衣服|天气|快递|药|身体|头痛|洗澡|家务)/g)
      const cTask = count(/(代码|函数|脚本|门禁|提交|测试|文档|接口|数据库|schema|字段|部署|bug|验收|表结构)/gi)
      const cExpl = count(/(想不清|不确定|为什么|有没有可能|搜一下|查一下|原理|定义|到底|想想)/g)
      // 只扳一种情况：模型写了「任务」（它的默认值），而生活/探索词明显占优。
      // 模型已经写了「闲聊/探索/生活」时不覆盖——宁可不改也别把对的说成错的。
      if (plus.kind === '任务') {
        if (cLife >= 2 && cLife > cTask) plus.kind = '生活'
        else if (cExpl >= 2 && cExpl > cTask) plus.kind = '探索'
      }
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
    setFlag(db, affairsKey(conversationId), JSON.stringify({ text: line, ...four, ...plus, at: new Date().toISOString(), conv: conversationId ? String(conversationId) : '' }))
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
          plus.kind || '', plus.where || '',
          JSON.stringify(Array.isArray(plus.open) ? plus.open : []))
    } catch { /* 历史追加失败不影响这一轮 */ }
    // 2026-11-21：每轮把 open 合进格表，这就是「接到前面的树上」——线名当 id，
    // 上一轮在、这一轮没了就封成 done。没开加格时不写。
    mergeGrid(db, conversationId, plusOn ? plus : null)
    return line
  } catch { return '' }
}

/** 这一轮（回复前）：拼事帧 + 判断层 + 情绪，各落一行（rules=provisional，model=最终）。
 *  回复前不再补总结（2026-11-17）：总结走宿主、回复后异步就能写；缺一轮用「（新事）」，不拖回复。 */
export async function appraiseTurnNow(db, aid, { text = '', turnId = null, conversationId = null, now = Date.now(), complete = null } = {}) {
  try {
    const t = String(text || '').trim()
    if (!t) return false
    const tid = turnId || ('turn_pr_' + Number(now).toString(36))
    if (db.prepare('SELECT 1 FROM affect_v4_shadow WHERE agent_id=? AND turn_id=? LIMIT 1').get(aid ?? null, tid)) return false
    // 2026-11-21 主人：事帧这块一点关键词规则也不要。act/target/what/summary 全交给本地小模型（TOPIC_SYS）；
    // 模型没回来就留原话和空值。rulesFrameSlot 只留给旧路和测试，主链不再调。
    const slot = { act: '', what: t.replace(/\s+/g, ' ').slice(0, 60), target: 'none' }
    let affairs = readAffairs(db, conversationId)
    // 2026-11-20：四格接进 frame 本体。跟 summary 同源（都是上一轮 writeAffairs 写的），
    // 所以这里拿到的是「上一次」的四格，比这一轮晚一步——第一版接受这个滞后。
    const lastFour = readLastFour(db, conversationId)
    // 2026-11-21：加格也接进 frame 本体。字段名避开 frame 自己的 open（那是「这帧还开着没」），
    // 用 openLines 存「手上没完的几条线」，under 是连续父的雏形（帧自己就是树的节点，见设计-帧与连续树）。
    const plusNow = readPlus(db, conversationId)
    const plusFrame = plusNow ? {
      under: { line: (plusNow.open[0] && plusNow.open[0].line) || plusNow.where || '', step: plusNow.open[0] ? (plusNow.open[0].done || plusNow.where) : plusNow.where },
      next: plusNow.next,
      openLines: plusNow.open,
    } : {}
    const frame = {
      id: newId(), span: 'turn', startedAt: new Date(now).toISOString(), open: true,
      act: slot.act, summary: affairs ? String(affairs).slice(0, 120) : '（新事）',
      ...lastFour,
      ...plusFrame,
      what: slot.what, who: 'owner', target: slot.target,
      material: buildMaterial(db, aid, t, { conversationId }), evidence: [tid],
      prev: lastAgentLine(db, aid, conversationId, tid),
      lastAt: new Date(now).toISOString(),
    }
    const at = new Date(now).toISOString()
    const opt = v4Opts(db, aid)
    // 事层（第 1 次调用，原设计 TOPIC_SYS）：本地小模型读上下文，写这一帧的 summary/what/target。
    // 只在真实链路跑（没传 complete 的测试/仿真不跑，免得每个用例等本地模型）；
    // 失败/超时就退回规则那版，不阻塞判断层。开关 affect.v4.topic.local 可关。
    if (!complete && opt.topicLocal !== 'off') {
      try {
        const topicText = [
          frame.summary ? `正在发生：${frame.summary}` : '',
          frame.prev ? `我上一句：${String(frame.prev).slice(0, 200)}` : '',
          `这一句：${t}`,
        ].filter(Boolean).join('\n')
        const r = await localComplete(db, {
          system: TOPIC_SYS, text: topicText, maxTokens: 120,
          priority: 5, label: 'affect:topic', timeoutMs: 3000, format: '', think: false,
        })
        const jt = parseJsonLoose(r && r.text != null ? r.text : r)
        if (jt) {
          if (jt.summary) frame.summary = String(jt.summary).replace(/\s+/g, ' ').slice(0, 40)
          if (jt.what) frame.what = String(jt.what).replace(/\s+/g, ' ').slice(0, 80)
          if (['me', 'other', 'none'].includes(String(jt.target || '').toLowerCase())) frame.target = String(jt.target).toLowerCase()
          if (['threat', 'criticize', 'praise', 'request', 'ask', 'withdraw', 'chat'].includes(String(jt.act || '').toLowerCase())) frame.act = String(jt.act).toLowerCase()
        }
      } catch { /* 本地模型没起/超时：用规则那版 */ }
    }
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
    const jr = rulesJudgment(slot.act)
    const posR = nextPosition(prev, jr, now, opt, base)
    const outR = infer(frame, jr, posR ? { ...opt, position: posR.position } : opt)
    insertShadowRow(db, {
      aid, turnId: tid, conversationId, at, frame, out: outR,
      source: 'rules', freeframe: 1, rev: 1,
      judgment: { ...jr, judge: 'rules', ...(posR ? { dyn: posR.dyn } : {}) },
    })
    const mat = frame.material || {}
    const frameText = [
      `正在发生：\n${frame.summary || ''}`,
      frame.prev ? `我上一句：${String(frame.prev).slice(0, 200)}` : '',
      `这一句：${frame.what || ''}`,
      `冲谁：${frame.target || 'none'}`,
      Array.isArray(mat.summaries) && mat.summaries.length ? '最近几件事：' + mat.summaries.slice(-6).join(' / ') : '',
      Array.isArray(mat.quotes) && mat.quotes.length ? '最近原话：' + mat.quotes.slice(-6).join(' / ') : '',
    ].filter(Boolean).join('\n')
    const run = typeof complete === 'function' ? complete : (req) => kernelModel.complete(req)
    let judgment = null
    let jDiag = null
    for (let attempt = 0; attempt < 2 && !judgment; attempt++) {
      try {
        const raw = await hostComplete(db, {
          agent: String(aid || ''), label: 'affect:judge', timeoutMs: 15000, priority: 1,
          complete: run, system: JUDGE_SYS, text: frameText, maxTokens: 2000,
        })
        const parsed = parseJsonLoose(raw)
        judgment = sanitizeJudge(parsed)
        jDiag = { attempt, len: String(raw == null ? '' : raw).length, raw: String(raw == null ? '' : raw).slice(0, 400), why: judgment ? 'ok' : (parsed ? 'sanitize-null' : 'unparsed') }
      } catch (e) {
        judgment = null
        jDiag = { attempt, why: 'throw', msg: String((e && e.message) || e).slice(0, 200) }
      }
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
    const judge = judgment ? 'host' : 'rules'
    // 规则顶上时，这一行要自己说清楚：「我是兜底，不是模型判的」。
    // 以前 why 写「规则关键词判为 chat」，看着像一次正常判定，谁都不知道模型掉过。
    if (!judgment) {
      judgment = {
        ...jr,
        judge: 'rules-fallback',
        fallbackWhy: judgeStatus?.fallbackWhy ?? (jDiag && jDiag.why) ?? null,
      }
    }
    // 情绪模块罢工：判断没算成、回退规则——记一笔，提示词最顶上会写「情绪模块罢工」。
    try {
      if (judge === 'host') clearFlag(db, 'affect.v4.strike')
      else setFlag(db, 'affect.v4.strike', JSON.stringify({ at: new Date().toISOString(), conv: conversationId ? String(conversationId) : '' }))
    } catch { /* 标记失败不影响 */ }
    // agency 已删：老路统一读 by，模型判的 by 覆盖规则先垫的那版。
    if (judgment && judgment.by) frame.by = judgment.by
    const posM = nextPosition(prev, judgment, now, opt, base)
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
    const out = infer(frame, judgeForOut, posOut ? { ...opt, position: posOut.position } : opt)
    insertShadowRow(db, {
      aid, turnId: tid, conversationId, at, frame, out,
      source: 'model', latencyMs: Date.now() - now, freeframe: 0, rev: 2,
      judgment: { ...judgment, judge, ...(posOut ? { dyn: { ...posOut.dyn, state: posOut.position, shock: shocked } } : {}) },
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
    return true
  } catch { return false }
}

