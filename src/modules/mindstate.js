/**
 * 心中的状态行：上下文水位 + 复盘欠债。
 *
 * 两个问题都只在「快来不及了」的时候才值得说一句：
 *   1) 眼前这段对话快塞满了，再不留就随压缩一起没了；
 *   2) 夜里的整理没跑成，攒下的对话没人收。
 *
 * 这里只管「算出那句话」，不碰宿主、不碰注入口——水位从 index.js 的
 * pre-step 喂进来（那里才认识 tokenMeter / requestContext），欠债直接读库。
 * 段落拼进 systemPrompt 末尾，压缩后水位自然回落，提醒自己消失，不用状态机。
 *
 * 契约：
 *   noteMeter(sessionId, { used, window })   存本轮水位（window=0 表示不知道窗口）
 *   meterFromUsage(sessionId, usage)         退路：从 assistant/message 的 usage 记
 *   mindLine(db, aid, opts)                  返回 '' 或一段「【状态】…」
 *   _resetMindState()                        测试用
 */

import { getParam, nid } from '../kernel.js'

const METER_TTL_MS = 30 * 60 * 1000
const DEFAULT_RATIO = 0.6
// DSH 原生压缩阈值默认 0.8：到了这里就不必再提醒，压缩马上自己动手。
const COMPACT_AT = 0.8

/** sessionId -> { used, window, at }。按会话存，QQ 和网页不会互相串水位。 */
const meters = new Map()
/** 最近一轮 pre-step 见到的会话：systemPrompt 组装时用它取对应的水位。 */
let lastSessionId = ''

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** pre-step 算好的水位：used 是这一会话当前的 token 量，window 是它的窗口。 */
export function noteMeter(sessionId, m) {
  const sid = String(sessionId || '')
  if (!sid || !m) return
  const used = toNum(m.used)
  const window = toNum(m.window)
  if (!used) return
  lastSessionId = sid
  meters.set(sid, { used, window, at: Date.now() })
  if (meters.size > 32) {
    // 只留最近的几条会话，别让 Map 长成内存里的旧账
    const rows = [...meters.entries()].sort((a, b) => b[1].at - a[1].at)
    for (const [k] of rows.slice(32)) meters.delete(k)
  }
}

/** 退路：宿主没给 tokenMeter 时，用上一次请求真实的输入量当水位近似。 */
export function meterFromUsage(sessionId, usage) {
  const sid = String(sessionId || '')
  if (!sid || !usage) return
  const used = toNum(usage.inputTokens) || toNum(usage.totalTokens)
  if (!used) return
  lastSessionId = sid
  const prev = meters.get(sid) || {}
  meters.set(sid, { used, window: prev.window || 0, at: Date.now() })
}

/** 测试/诊断：清空内存水位。 */
export function _resetMindState() {
  meters.clear()
  lastSessionId = ''
}

/** 当前会话的水位（供 ping/界面读，不参与注入）。 */
export function meterOf(sessionId) {
  const m = meters.get(String(sessionId || lastSessionId))
  if (!m) return null
  if (Date.now() - m.at > METER_TTL_MS) return null
  return { used: m.used, window: m.window, ratio: m.window ? m.used / m.window : 0, at: m.at }
}

function fmtHours(h) {
  const n = Math.round(Number(h) || 0)
  // 48 小时以内都说小时：26 小时和「1 天前」差得不是一点半点，欠债要的是精度。
  if (n < 48) return n + ' 个小时'
  const d = Math.round(n / 24)
  return d + ' 天'
}

/**
 * 水位那一句。拿不到窗口就不猜——宁可不提醒，也不拿一个可能错的数去催。
 */
function meterLine(db, aid, nowMs) {
  if (String(getParam(db, aid, 'mind.meter.enable') ?? 'on') === 'off') return ''
  const m = meterOf(lastSessionId)
  if (!m || !m.window) return ''
  if (nowMs - m.at > METER_TTL_MS) return ''
  const ratio = m.used / m.window
  const threshold = Math.min(COMPACT_AT, Math.max(0.05, Number(getParam(db, aid, 'mind.meter.ratio')) || DEFAULT_RATIO))
  if (ratio < threshold || ratio >= COMPACT_AT) return ''
  return '眼前的对话快到上限了，想留的就现在记一下。'
}

/**
 * 欠债那一句。
 * 只在「上次整理确实发生过、之后又攒够了料」时才说；从没整理过的新库不吭声，
 * 否则第一次装好就催账。同一句 N 小时内只说一次，靠 events 里的上次提示时间压着。
 */
function debtLine(db, aid, nowMs) {
  if (String(getParam(db, aid, 'mind.review.enable') ?? 'on') === 'off') return ''
  let last = null
  try {
    last = db.prepare('SELECT day, at FROM consolidation_log WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid) || null
  } catch { return '' }
  if (!last || !last.at) return ''
  const lastMs = Date.parse(last.at)
  if (!Number.isFinite(lastMs)) return ''
  const hours = (nowMs - lastMs) / 3600000
  const needHours = Math.max(1, Number(getParam(db, aid, 'mind.review.hours')) || 20)
  if (hours < needHours) return ''

  let pending = 0
  try {
    pending = Number(db.prepare('SELECT COUNT(*) AS n FROM raw_turns WHERE agent_id=? AND created_at>=?')
      .get(aid, last.at).n) || 0
  } catch { return '' }
  const needTurns = Math.max(1, Number(getParam(db, aid, 'mind.review.min_turns')) || 20)
  if (pending < needTurns) return ''

  // 冷却：上一次说这句话到现在，还没过 cooldown 就先闭嘴
  const cooldownH = Math.max(0, Number(getParam(db, aid, 'mind.review.cooldown_hours')) || 6)
  if (cooldownH > 0) {
    try {
      // events 表的列是 created_at（不是 at）；查错列名会被 catch 吞掉，冷却就永远不生效。
      const seen = db.prepare("SELECT created_at FROM events WHERE agent_id=? AND type='mind.review_hint' ORDER BY created_at DESC LIMIT 1").get(aid)
      const seenMs = seen ? Date.parse(seen.created_at) : NaN
      if (Number.isFinite(seenMs) && nowMs - seenMs < cooldownH * 3600000) return ''
    } catch { /* 读不到就当没说过 */ }
  }
  try {
    // 记的 created_at 必须跟着 nowMs 走，不能落真实时钟：冷却判断用的是同一个 nowMs，
    // 两套时间一混，测试里的假时钟和真时钟就会互相打架（真跑时 nowMs === Date.now()，等价）。
    const at = new Date(nowMs).toISOString()
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run(nid('evt_'), aid, 'mind.review_hint', JSON.stringify({ hours: Math.round(hours), pending, at }), at)
  } catch { /* 记账失败也照样提醒，宁可多提一次 */ }
  return '距上次整理 ' + fmtHours(hours) + '了，还攒着一些没归档的对话。'
}

/**
 * 拼成可以被注入的一段。两条都空就返回 ''（不占提示词）。
 * @param {object} opts.nowMs 测试里可注入时间
 */
export function mindLine(db, aid, opts = {}) {
  const nowMs = Number(opts.nowMs) || Date.now()
  const parts = []
  try { const a = meterLine(db, aid, nowMs); if (a) parts.push(a) } catch { /* 水位算不出来就不提 */ }
  try { const b = debtLine(db, aid, nowMs); if (b) parts.push(b) } catch { /* 欠债算不出来就不提 */ }
  if (!parts.length) return ''
  return '【状态】' + parts.join('') + ''
}
