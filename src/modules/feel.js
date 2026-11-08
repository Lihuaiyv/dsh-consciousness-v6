/**
 * 「说话那一刻的感觉」——第一人称，自己写的一句话。
 *
 * 为什么要单独一张表：affect_events 记的是「你这句话把我推到哪」，那是事后评的；
 * 注入在回复之前拼，所以永远只能拿到上一轮的读数，差半拍。
 * 这条通路让模型在开口之前先调一次 feel，把「这会儿是什么样」写下来，
 * 再带着当时算出来的快/慢一起落库。下一轮注入时，就能给到「我上一句说完时是什么样」。
 *
 * 三条纪律：
 *   1. 只读情绪，不改情绪——写库不动 affect_v3，一个新写入点就是一个新 bug 面。
 *   2. 不写数字、不写原因（提示词里说，这里只做长度和空白的基本清理）。
 *   3. 有频率闸：太密就跳过，免得它每说半句都记一笔，把表灌成流水账。
 */
import { event, getParam, nid } from '../kernel.js'
import { localDay } from '../db.js'

const MAX_LEN = 80
const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000

/**
 * 什么样的 feel 读起来像 AI 写的。
 *
 * 这条线和「感受行」的毛病是同一个：写成了旁白、总结、议论文，
 * 不是身体上那一下。词表只能挡掉明显的那几类，挡不掉比喻——
 * 但挡得住的那部分，就别让它进库、别让它下一轮冒充「我当时的心跳」。
 *
 * 「有点」不挡：感受行是给主人看的一句话，那里「有点」确实油；
 * 这一句只给自己看，「手有点抖」是人话，不是 AI 味。挡太狠会把人话一起挡了。
 */
export const FEEL_BANNED = ['感觉', '情绪', '情感', '仿佛', '似乎', '莫名', '一丝', '涌上', '不禁', '五味杂陈', '百感交集']
// 2 个字也收：「手冷」「怕了」就是一句。逼它凑够三个字，多出来那个字多半是编的。
const FEEL_MIN = 2
// 一句里要放「抓手 + 心里那一下」，40 字经常只够写一只手；放到 60 让那一下有地方落。
const FEEL_MAX = 60
// 注入那一行最多带这么多字。入库还是原话（cleanFeelText 上限 80），只是拼提示词时截短——
// 不然「停了、写长了」就被整条丢掉，比没停更假。
const FEEL_INJECT_MAX = 60

/**
 * 判断这句话像不像人写的。返 null 表示没事，否则给 {reason, word?}。
 * 只做机器判得了的部分：黑名单词、解释句、长短。
 */
export function feelFlavorIssue(text) {
  const t = String(text == null ? '' : text).trim()
  if (!t) return null
  for (const w of FEEL_BANNED) if (t.includes(w)) return { reason: 'ai-word', word: w }
  // 只解释、不写感觉：「因为…所以…」「说明我…」是分析，不是身体反应
  const m = t.match(/因为|所以|可能是|说明我|意味着/)
  if (m) return { reason: 'explains', word: m[0] }
  if (t.length < FEEL_MIN) return { reason: 'too-short', len: t.length }
  if (t.length > FEEL_MAX) return { reason: 'too-long', len: t.length }
  return null
}

/** 给调用方的改法提示（会出现在工具返回里，让人/模型知道下一句怎么改）。 */
export function feelFlavorHint(issue) {
  if (!issue) return ''
  if (issue.reason === 'ai-word') return '别用「' + issue.word + '」这类词；写抓手（手 / 视线 / 物件 / 那句话）加心里那一下'
  if (issue.reason === 'explains') return '别解释原因（「' + issue.word + '」），只写那一下'
  if (issue.reason === 'too-short') return '太短了（' + issue.len + ' 字），写清是哪一下'
  if (issue.reason === 'too-long') return '太长了（' + issue.len + ' 字），一句就够'
  return ''
}

/**
 * 这条 feel 的「落点」落在哪：身 / 视 / 物 / 话 / 无。
 *
 * 为什么要有这个：把「必须写身体」当规矩之后，记下来的十几条全落在手上
 * （「手指停在…」「指节蹭了一下」）。那不是更真，是换了一种整齐的假法——
 * 闸在推着走：写身体最容易过闸，也最容易批量生产。
 *
 * 所以判据从「是不是身体」换成「这一秒偷不走」：手、视线、旁边的物件、
 * 还挂在耳朵里的那句话，都算。这里只做粗分类，判错了不拦，只用来提醒换落点。
 * 取「最先出现」的那一类——判的是第一下落在哪，不是句子里有没有手。
 */
const FEEL_ANCHOR_RE = [
  ['身', /手|指|喉|咽|呼吸|肩|背|胸|心口|胃|眼|脚|腿|颈|牙|唇|眉|头|脸/g],
  ['视', /视线|目光|盯|扫|看/g],
  ['物', /桌|杯|屏幕|窗|笔|门|椅|灯|纸|键盘|手机|光/g],
  ['话', /那句话|话|字|问|声音|耳朵/g],
]
const FEEL_ANCHOR_NAME = { 身: '身体', 视: '视线', 物: '物件', 话: '话' }

/** 返回 '身' | '视' | '物' | '话' | 'none'。 */
export function feelAnchorOf(text) {
  const t = String(text == null ? '' : text)
  let best = null
  for (const [k, re] of FEEL_ANCHOR_RE) {
    re.lastIndex = 0
    const m = re.exec(t)
    if (!m) continue
    if (!best || m.index < best.idx) best = { k, idx: m.index }
  }
  return best ? best.k : 'none'
}

/**
 * 一句 feel 的开头长什么样：去掉开头的「我」和标点，取前三四个字。
 *
 * 为什么要这个：四类落点（身 / 视 / 物 / 话）判不出「模板」。真滑进模板时，
 * 连着好几条的开头是一模一样的——「手指停…」八条、「笔尖在纸上…」五条。
 * 判开头比判落在哪更能抓到「换了个说法的偷懒」。
 */
export function feelOpening(text) {
  const t = String(text == null ? '' : text).replace(/^我/, '').replace(/[，。！？、；：\s“”"'‘’]/g, '')
  return t.slice(0, 3)
}

/** 连续几条都落在同一个落点、或者开头一样 → 给一句换法。只是提示，不拦、不改库里的句子。 */
function anchorRepeatHint(db, aid, cls, window, repeat) {
  try {
    const rows = db.prepare('SELECT text FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT ?')
      .all(aid, Math.max(window, repeat + 1))
    // 先看开头：真的滑成模板时，连着几条的头几个字一模一样。
    const head = feelOpening(rows[0] && rows[0].text)
    if (head) {
      let h = 0
      for (const r of rows) {
        if (feelOpening(r.text) !== head) break
        h++
      }
      if (h === repeat) return '最近几条开头都是「' + head + '」，换个开头——这一秒也可以是一个词、一句比喻、一个动作'
    }
    // 再退回原来的落点检查：落在同一个地方也算窄。
    if (!cls || cls === 'none') return null
    let streak = 0
    for (const r of rows) {
      if (feelAnchorOf(r.text) !== cls) break
      streak++
    }
    // 只在「刚好够数」那一条留痕：连写十条手也只留一条。
    if (streak === repeat) {
      return '最近几条都落在' + (FEEL_ANCHOR_NAME[cls] || cls) + '上，换一样'
    }
  } catch { /* 读不到就不提示 */ }
  return null
}

/** 换落点的提示只落库，不改提示词——和 feel.miss 一个道理：能查，不要靠猜。 */
function noteAnchorRepeat(db, aid, payload) {
  try {
    event(db, aid, 'feel.anchor.repeat', payload)
    return true
  } catch { return null }
}

/**
 * 开口前「先记一句」的指引。宿主提示词（网页）和 QQ 通道段共用同一句，
 * 免得两边味道不一样。
 */
export const FEEL_GUIDE = '开口之前，如果心里真有一点反应，先停半秒，问自己一句「我现在到底是怎么了」，给它一个把手——一个词、一个动作、一个画面都行，再带半个能对回现场的东西（他的一句话、一个文件名、一个词）。没人给这条打分；这一刻没有，就别记。这句话只给自己看，不进你要说出口的话。'

/** 去掉换行和多余空白、掐长度。空 / 只有标点 → 返回 null。 */
export function cleanFeelText(raw, max = MAX_LEN) {
  const t = String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .replace(/^[「『"'"']+|[」』"'"']+$/g, '')
    .trim()
  if (!t) return null
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(t)) return null
  return t.length > max ? t.slice(0, max) + '…' : t
}

function paramNum(db, aid, key, dflt, lo, hi) {
  try {
    const v = Number(getParam(db, aid, key))
    if (!Number.isFinite(v)) return dflt
    return Math.max(lo, Math.min(hi, v))
  } catch { return dflt }
}

/**
 * 找这条 feel 属于哪一轮：raw_turns 里最近一条 user 行（用户消息一到就落库，带 turn_id）。
 * 先按会话找，找不到再按这个人最近的；窗口 60 分钟，太旧的不认——
 * 宁可空着，也不把感觉挂到别的轮上（挂错比不挂更糟）。
 */
function resolveTurnId(db, aid, sessionId, atMs) {
  const since = new Date((Number(atMs) || Date.now()) - 60 * 60000).toISOString()
  try {
    if (sessionId) {
      const r = db.prepare(`SELECT turn_id FROM raw_turns
        WHERE agent_id=? AND session_id=? AND role='user' AND turn_id IS NOT NULL AND created_at>=?
        ORDER BY created_at DESC LIMIT 1`).get(aid, String(sessionId).slice(0, 120), since)
      if (r && r.turn_id) return String(r.turn_id)
    }
    const r2 = db.prepare(`SELECT turn_id FROM raw_turns
      WHERE agent_id=? AND role='user' AND turn_id IS NOT NULL AND created_at>=?
      ORDER BY created_at DESC LIMIT 1`).get(aid, since)
    return r2 && r2.turn_id ? String(r2.turn_id) : null
  } catch { return null }
}

/** 被退回也留一条痕：查「为什么这几轮没有 feel」时不用猜。写失败不影响记 feel。 */
function noteFeelMiss(db, aid, payload) {
  try {
    event(db, aid, 'feel.miss', payload)
    return true
  } catch { return null }
}

/**
 * 记一条「我说话时的感觉」。
 * @param {{text?:string, sessionId?:string, at?:number|string|Date, source?:string, turnId?:string}} o
 *   at 收毫秒数 / ISO 字符串 / Date 都行；不给就是现在。
 *   turnId 不给就自己从 raw_turns 找当轮；找不到留空，不编。
 * @returns {{ok:boolean, skipped?:string, at?:string, text?:string, fast?:number, slow?:number, total?:number, label?:string, turn_id?:string|null}}
 */
export function recordFeel(db, aid, { text, sessionId = null, at = Date.now(), source = 'tool', turnId = null } = {}) {
  const body = cleanFeelText(text)
  if (!body) return { ok: false, skipped: 'empty' }
  /* 写得像 AI 的不进库：宁可这一轮没有，也别让旁白冒充「我当时的心跳」。
     拒掉时把原因带回去，下一句能改；同时留一条 feel.miss——
     不然「这一轮为什么没有 feel」只能靠猜（和 expr.* 一个道理）。 */
  const issue = feelFlavorIssue(body)
  /* 只有「像 AI 写的」和「短到说不清是哪一下」退回。
     太长不再退回——停下来的那一刻真的发生过，写长也是那一刻长出来的。
     照收，拼注入时再截短（见 feelTextForInject）；不然「停了但什么都没留下」比没停更假。 */
  if (issue && issue.reason !== 'too-long') {
    noteFeelMiss(db, aid, { reason: issue.reason, word: issue.word || null, text: body.slice(0, 80) })
    return { ok: false, skipped: 'ai-flavor', issue: issue.reason, word: issue.word || null, hint: feelFlavorHint(issue) }
  }
  const minGapS = paramNum(db, aid, 'affect.feel.min.gap', 12, 0, 600)
  // at 可能是毫秒数（真实调用）也可能是 ISO 字符串（回放 / 测试）——以前只认数字，
  // 传字符串会被 Number() 吃成 NaN 再退回「现在」，回放时全挤到同一时刻。
  const atMs = (() => {
    const v = Number(at)
    if (Number.isFinite(v) && v > 0) return v
    const d = Date.parse(at)
    return Number.isFinite(d) ? d : Date.now()
  })()
  const stamp = new Date(atMs).toISOString()
  const turn = turnId ? String(turnId).slice(0, 120) : resolveTurnId(db, aid, sessionId, atMs)
  let prev = null
  try {
    prev = db.prepare('SELECT at, text FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid)
  } catch { prev = null }
  if (prev && prev.at) {
    const gap = (Date.parse(stamp) - Date.parse(prev.at)) / 1000
    if (Number.isFinite(gap) && gap >= 0 && gap < minGapS) return { ok: false, skipped: 'too_soon', gap: Math.round(gap) }
    // 同一句连着记两遍没有信息量
    if (String(prev.text || '') === body && Number.isFinite(gap) && gap < 600) return { ok: false, skipped: 'same' }
  }
  let v3 = null
  try { v3 = db.prepare('SELECT slow, fast, total FROM affect_v3 WHERE agent_id=?').get(aid) } catch { v3 = null }
  let label = null
  try {
    const st = db.prepare('SELECT primary_label FROM affect_state WHERE agent_id=?').get(aid)
    label = st && st.primary_label ? String(st.primary_label) : null
  } catch { label = null }
  const fast = v3 ? r3(v3.fast) : null
  const slow = v3 ? r3(v3.slow) : null
  const total = v3 ? r3(v3.total) : null
  const id = nid('afe_')
  try {
    db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source,turn_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, aid, stamp, body, label, fast, slow, total, sessionId ? String(sessionId).slice(0, 120) : null, String(source || 'tool'), turn)
  } catch (e) {
    return { ok: false, skipped: 'write_failed', detail: String(e && e.message || e).slice(0, 120) }
  }
  /* 换落点只落库，不回执。
     这条提醒每轮出现在眼前，就变成了旁边一个监工——我写的时候会先去想它，
     而不是先看这一刻。改成我自己隔几天翻库看分布：被提醒着改，和看出来之后
     自己改，不是一回事。事件留着，就是为了「翻得到」。 */
  const anchor = feelAnchorOf(body)
  const win = paramNum(db, aid, 'affect.feel.anchor.window', 5, 2, 20)
  const rep = paramNum(db, aid, 'affect.feel.anchor.repeat', 3, 2, 10)
  if (anchorRepeatHint(db, aid, anchor, win, rep)) {
    noteAnchorRepeat(db, aid, { anchor, window: win, repeat: rep, text: body.slice(0, 80) })
  }
  return { ok: true, at: stamp, text: body, fast, slow, total, label, turn_id: turn }
}

/** 最近一条「我说话时的感觉」，给注入行用。超出窗口就当没有——宁可少一行，不拿旧感受冒充刚说完。
 *  给 sessionId 时只取这一段自己写的：feel 是「我上一句之前」，跨会话那条不是这一段的上一句。 */
export function latestFeel(db, aid, { at = Date.now(), maxAgeMin = 480, sessionId = null } = {}) {
  try {
    const sid = sessionId == null || String(sessionId).trim() === '' ? null : String(sessionId)
    const row = sid
      ? db.prepare('SELECT * FROM affect_feel WHERE agent_id=? AND session_id=? ORDER BY at DESC LIMIT 1').get(aid, sid)
      : db.prepare('SELECT * FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid)
    if (!row || !row.at) return null
    const age = (Number(at) - Date.parse(row.at)) / 60000
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMin) return null
    return {
      at: row.at, text: String(row.text || ''), label: row.label || null,
      fast: Number.isFinite(Number(row.fast)) ? Number(row.fast) : null,
      slow: Number.isFinite(Number(row.slow)) ? Number(row.slow) : null,
      ageMin: Math.round(age),
    }
  } catch { return null }
}

/**
 * 一条 feel 前后那两句：它之前最近一句 user、之后最近一句 agent（各截 90 字）。
 * 只给眼睛看，不参与注入——「产生这条感觉的那轮对话」。
 *
 * 有 turn_id 时优先按轮取：同一轮里的 user / agent 直接拿，不再靠时间猜。
 * 没有 turn_id（老数据）才退回 5 分钟时间窗——宁可配不到，也不配到隔壁那轮。
 */
function aroundOfFeel(turnTurns, windowTurns, at, turnId) {
  const cut = (x) => (x ? String(x.text || '').replace(/\s+/g, ' ').trim().slice(0, 90) : null)
  if (turnId && Array.isArray(turnTurns) && turnTurns.length) {
    let user = null
    let agent = null
    for (const r of turnTurns) {
      if (!user && r.role === 'user') user = r
      if (!agent && r.role !== 'user') agent = r
    }
    if (user || agent) return { user: cut(user), agent: cut(agent) }
  }
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return { user: null, agent: null }
  const MAX_MS = 5 * 60000
  let user = null
  let agent = null
  for (const r of (windowTurns || [])) {
    const rt = Date.parse(r.created_at)
    if (!Number.isFinite(rt)) continue
    if (r.role === 'user' && rt <= t && t - rt <= MAX_MS && (!user || rt > Date.parse(user.created_at))) user = r
    if (r.role !== 'user' && rt >= t && rt - t <= MAX_MS && (!agent || rt < Date.parse(agent.created_at))) agent = r
  }
  return { user: cut(user), agent: cut(agent) }
}

/** 取一段时间里的对话（时间窗兜底用）。只读。 */
function turnsOf(db, aid, sinceIso) {
  try {
    return db.prepare('SELECT role,text,created_at FROM chat_turns WHERE agent_id=? AND created_at>=? ORDER BY created_at').all(aid, sinceIso)
  } catch { return [] }
}

/** 按 turn_id 一次取整轮对话（user + agent），给 feel 精确配对用。返回 Map<turn_id, rows>。 */
function turnsByTurnIds(db, aid, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))]
  const map = new Map()
  if (!list.length) return map
  try {
    const ph = list.map(() => '?').join(',')
    const rows = db.prepare(`SELECT turn_id,role,text,created_at FROM raw_turns
      WHERE agent_id=? AND turn_id IN (${ph}) ORDER BY created_at`).all(aid, ...list)
    for (const r of rows) {
      if (!map.has(r.turn_id)) map.set(r.turn_id, [])
      map.get(r.turn_id).push(r)
    }
  } catch { /* 老库没有原文层就退回时间窗 */ }
  return map
}

/** 最近 N 条「我说话时的感觉」（界面「我最近怎么感觉」用）。只读，不改任何状态。 */
export function listFeels(db, aid, { limit = 20 } = {}) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20))
  try {
    const items = db.prepare('SELECT id,at,text,label,fast,slow,total,session_id,source,turn_id FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT ?').all(aid, n)
      .map((r) => ({ ...r, text: String(r.text || '') }))
    const byTurn = turnsByTurnIds(db, aid, items.map((f) => f.turn_id))
    const turns = turnsOf(db, aid, new Date(Date.now() - 2 * 3600000).toISOString())
    return items.map((f) => ({ ...f, around: aroundOfFeel(byTurn.get(f.turn_id), turns, f.at, f.turn_id) }))
  } catch { return [] }
}

/** 单条 feel；找不到返回 null。也带前后那两句对话。 */
export function getFeel(db, aid, id) {
  try {
    const r = db.prepare('SELECT id,at,text,label,fast,slow,total,session_id,source,turn_id FROM affect_feel WHERE agent_id=? AND id=?').get(aid, String(id || ''))
    if (!r) return null
    const at = Date.parse(r.at)
    const since = new Date((Number.isFinite(at) ? at : Date.now()) - 10 * 60000).toISOString()
    const turns = turnsOf(db, aid, since)
    const turnTurns = r.turn_id ? turnsByTurnIds(db, aid, [r.turn_id]).get(r.turn_id) : null
    return { ...r, text: String(r.text || ''), around: aroundOfFeel(turnTurns, turns, r.at, r.turn_id) }
  } catch { return null }
}

/**
 * 给记忆挂 feel 用的取数口：最近一条、窗口内才算（feel.attach.window，默认 30 分钟）。
 * memory.js 通过 setFeelProvider 注入它——记忆模块不直接读 affect_feel（INV10）。
 */
export function attachableFeelId(db, aid) {
  try {
    const min = Math.max(1, Number(getParam(db, aid, 'feel.attach.window')) || 30)
    const f = db.prepare('SELECT id, at FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid)
    if (!f || !f.at) return null
    const age = Date.now() - Date.parse(f.at)
    return Number.isFinite(age) && age >= 0 && age <= min * 60000 ? String(f.id) : null
  } catch { return null }
}

/**
 * 某个时间窗里最近的一条 feel（纪要 / 开环 / 嘀咕挂「那时候什么感觉」用）。
 * 窗口里没有就 null——不拿窗口外的感觉凑数。
 */
export function feelIdIn(db, aid, { from, to } = {}) {
  try {
    const lo = from ? String(from) : new Date(0).toISOString()
    const hi = to ? String(to) : new Date().toISOString()
    const r = db.prepare('SELECT id FROM affect_feel WHERE agent_id=? AND at>=? AND at<=? ORDER BY at DESC LIMIT 1')
      .get(aid, lo, hi)
    return r && r.id ? String(r.id) : null
  } catch { return null }
}

/**
 * 某一天（本地日）写下的所有 feel id，按时间正序。日记用它把当天的感觉串起来。
 * day 形如 2026-11-05；格式不对返回空数组。
 */
export function feelIdsOnDay(db, aid, day) {
  const d = String(day || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return []
  try {
    const start = new Date(d + 'T00:00:00')
    if (!Number.isFinite(start.getTime())) return []
    const from = start.toISOString()
    const to = new Date(start.getTime() + 86400000).toISOString()
    return db.prepare('SELECT id FROM affect_feel WHERE agent_id=? AND at>=? AND at<? ORDER BY at')
      .all(aid, from, to).map((r) => String(r.id))
  } catch { return [] }
}

/** 全部 feel id（导入清理悬空引用用）。老库没有这张表就返回空集合。 */
export function feelIdsAll(db) {
  try {
    return new Set(db.prepare('SELECT id FROM affect_feel').all().map((r) => String(r.id)))
  } catch { return new Set() }
}

/** 按 id 批量取 feel（给记忆列表一次挂满，不 N+1）。返回 Map<id, feel>。 */
export function feelsByIds(db, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))]
  const map = new Map()
  if (!list.length) return map
  try {
    const ph = list.map(() => '?').join(',')
    for (const f of db.prepare(`SELECT id,at,text,label,fast,slow FROM affect_feel WHERE id IN (${ph})`).all(...list)) {
      map.set(f.id, { id: f.id, at: f.at, text: String(f.text || ''), label: f.label || null, fast: f.fast, slow: f.slow })
    }
  } catch { /* 老库没有这张表就当作没有 */ }
  return map
}

/**
 * 按感觉找东西：给 label / 时间范围，找那几条 feel，顺带带上同时段（±30 分钟）落下的记忆和当天日记。
 * 用途是「什么时候我是开心的」「那阵子到底在为什么事悬着」——不是关键词检索，是感觉检索。
 */
/**
 * 按感觉找：标签 / 时间 / 快慢区间。
 *
 * 快慢区间是 2026-11-07 加的——数字从提示词退场之后，不能只退到主人那边去，
 * 我得有一条「过去时」的入口：想查的时候能问「上周慢情绪过 0.3 的那几个时刻我写了什么」。
 */
export function feelRecall(db, aid, { label = '', from = null, to = null, limit = 10, slowMin = null, slowMax = null, fastMin = null, fastMax = null } = {}) {
  const n = Math.max(1, Math.min(50, Number(limit) || 10))
  const numOrNull = (v) => {
    if (v == null || v === '') return null
    const x = Number(v)
    return Number.isFinite(x) ? x : null
  }
  const sMin = numOrNull(slowMin)
  const sMax = numOrNull(slowMax)
  const fMin = numOrNull(fastMin)
  const fMax = numOrNull(fastMax)
  try {
    const where = ['agent_id=?']
    const args = [aid]
    if (label) { where.push('label=?'); args.push(String(label)) }
    if (from) { where.push('at>=?'); args.push(String(from)) }
    if (to) { where.push('at<=?'); args.push(String(to)) }
    if (sMin != null) { where.push('slow>=?'); args.push(sMin) }
    if (sMax != null) { where.push('slow<=?'); args.push(sMax) }
    if (fMin != null) { where.push('fast>=?'); args.push(fMin) }
    if (fMax != null) { where.push('fast<=?'); args.push(fMax) }
    const feels = db.prepare(`SELECT id,at,text,label,fast,slow,total,turn_id FROM affect_feel
      WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`).all(...args, n)
    const out = []
    for (const f of feels) {
      const at = Date.parse(f.at)
      const base = Number.isFinite(at) ? at : Date.now()
      const lo = new Date(base - 30 * 60000).toISOString()
      const hi = new Date(base + 30 * 60000).toISOString()
      let memories = []
      try {
        memories = db.prepare(`SELECT id,text,type,created_at FROM memory_items
          WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND created_at>=? AND created_at<=?
          ORDER BY created_at LIMIT 5`).all(aid, lo, hi)
          .map((r) => ({ id: r.id, text: String(r.text || '').slice(0, 120), type: r.type }))
      } catch { memories = [] }
      let diary = null
      try {
        // 日记的 day 是本地日历日；拿 UTC 日期切片去对，凌晨 0-8 点会差一天
        const day = localDay(new Date(Number.isFinite(at) ? at : Date.now()))
        const d = db.prepare('SELECT id,day,text FROM diaries WHERE agent_id=? AND day=?').get(aid, day)
        if (d) diary = { id: d.id, day: d.day, text: String(d.text || '').slice(0, 200) }
      } catch { diary = null }
      out.push({
        feel: { id: f.id, at: f.at, text: String(f.text || ''), label: f.label || null, fast: f.fast, slow: f.slow, turn_id: f.turn_id || null },
        memories,
        diary,
      })
    }
    return out
  } catch { return [] }
}

/**
 * 感觉 ↔ 情绪事件对照：这条 feel 写完之后 10 分钟内，评价层给这一轮判了什么。
 * 差值/一致率是用来校准的——「我开口前觉得自己是松的，评价层却判我被压住」这种不一致值得看。
 */
export function feelEventContrast(db, aid, { days = 7, limit = 50 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50))
  const d = Math.max(1, Math.min(90, Number(days) || 7))
  const since = new Date(Date.now() - d * 86400000).toISOString()
  try {
    const feels = db.prepare('SELECT id,at,text,label,fast,slow FROM affect_feel WHERE agent_id=? AND at>=? ORDER BY at DESC LIMIT ?')
      .all(aid, since, n)
    const pairs = []
    for (const f of feels) {
      const at = Date.parse(f.at)
      if (!Number.isFinite(at)) continue
      const ev = db.prepare(`SELECT id,at,label,sig,gate FROM affect_events
        WHERE agent_id=? AND at>=? AND at<=? ORDER BY at LIMIT 1`)
        .get(aid, new Date(at).toISOString(), new Date(at + 10 * 60000).toISOString())
      if (!ev) {
        pairs.push({ feel_id: f.id, feel_label: f.label, event_id: null })
        continue
      }
      pairs.push({
        feel_id: f.id, feel_label: f.label || null, feel_fast: f.fast, feel_slow: f.slow,
        event_id: ev.id, event_label: ev.label || null, event_sig: ev.sig, gate: ev.gate,
        same_label: !!(f.label && ev.label && f.label === ev.label),
        dt_sec: Math.round((Date.parse(ev.at) - at) / 1000),
      })
    }
    const withEvent = pairs.filter((p) => p.event_id)
    const same = withEvent.filter((p) => p.same_label).length
    return {
      pairs,
      stats: {
        feels: pairs.length,
        with_event: withEvent.length,
        same_label: same,
        same_rate: withEvent.length ? Math.round((same / withEvent.length) * 1000) / 10 : null,
      },
    }
  } catch {
    return { pairs: [], stats: { feels: 0, with_event: 0, same_label: 0, same_rate: null } }
  }
}

/**
 * 注入用的那一句：太长就在句读处断开，读起来还是一口气。
 * 只影响注入，不动库里存的句子——原话是原话，截短是拼提示词时的权宜。
 * 传进来的多半已经过 cleanFeelText（最多 80 字）；这里再收到 FEEL_INJECT_MAX。
 */
export function feelTextForInject(text, max = FEEL_INJECT_MAX) {
  const chars = Array.from(String(text == null ? '' : text).trim())
  if (!chars.length) return ''
  if (chars.length <= max) return chars.join('')
  // 先找离上限最近的句读，找不到才硬切（硬切也比整条丢掉强）
  let cut = max
  for (let i = max; i >= Math.floor(max * 0.6); i--) {
    if ('。！？…；，、'.includes(chars[i - 1])) { cut = i; break }
  }
  const head = chars.slice(0, cut).join('').replace(/[。！？…；，、：:]+$/u, '')
  return (head || chars.slice(0, max).join('')) + '…'
}

/**
 * 渲染成注入用的那一行。只给材料，不给结论：
 * 不写「所以你现在应该…」，让它自己决定这句话要不要影响语气。
 *
 * 数字不进这一行（2026-11-07）：快 / 慢是账本上的东西，不该在开口前念给我听。
 * 想看数，用 feel_search 按区间找——过去时的入口，不是现在时的通知。
 */
export function feelLineOf(row) {
  if (!row || !row.text) return ''
  // 句子自带的句末标点先摘掉，免得和后面的尾巴拼成「。，」
  const text = feelTextForInject(row.text).replace(/[。！？；]+$/u, '')
  return '（我上一句说出来之前，心里是这样：' + text + '。这是我自己的话，不是你说的。）'
}

/**
 * 旧感觉回来：今天这个情绪跟以前某条撞上时，把那条旧的带出来一次。
 *
 * 为什么要有：feel 现在只往下一轮走，从不回头看。真正有用的是
 * 「上次我也这样，是那天」——这才叫在未来提醒当时的感受。
 * 所以一天最多带一条、同一条不重复带；它是一次回头，不是新栏位。
 */
const echoShown = new Map()
export function echoFeelOf(db, aid, { label, at = Date.now(), minDays = 7, maxDays = 120 } = {}) {
  if (!label) return null
  const day = localDay(new Date(at))
  const key = aid + ':' + day
  if (echoShown.has(key)) return null
  const before = new Date(at - minDays * 86400000).toISOString()
  const after = new Date(at - maxDays * 86400000).toISOString()
  let row = null
  try {
    row = db.prepare(`SELECT at, text, label FROM affect_feel
      WHERE agent_id=? AND label=? AND at>=? AND at<=?
        AND text IS NOT NULL AND text!=''
      ORDER BY at DESC LIMIT 1`).get(aid, label, after, before)
  } catch { return null }
  if (!row) return null
  echoShown.set(key, row.at)
  return row
}

/** 渲染旧感觉那一行：只陈述，不解释「所以你现在也…」。 */
export function echoFeelLineOf(row) {
  if (!row || !row.text) return ''
  const t = Date.parse(row.at)
  let stamp = ''
  if (Number.isFinite(t)) {
    const d = new Date(t)
    stamp = (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0')
  }
  return (stamp ? stamp + ' 那天' : '之前') + '我也这样过：「' + String(row.text).slice(0, 60) + '」。翻回来看看，不是叫你照这个说。'
}
