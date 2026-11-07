/**
 * 时间距离（P6）：她现在离上一句话有多远。
 *
 * 为什么单独一个模块：以前注入里只有「下午」这种时段，她不知道你是刚才说的，
 * 还是三天前说的。同一句「我回来了」，落在十分钟后和三周后，该是两种回答。
 * 2026-11-07 补：时段词旁边带上钟点和日子（14:53（11-07））——光给「下午」，
 * 过了六点换一个字，她没别处可对，就会自己编一个「晚上了」。
 *
 * 硬规则：
 *   - 只读，不写。不 touch 会话、不拨时间戳。
 *   - 措辞按真实间隔给，宁可粗一点，不要编精确数字（「三天前」比「71 小时前」像人话）。
 */

/** 本地自然日（YYYY-MM-DD），用于「今天 / 昨天」判断。不用 UTC，否则早上八点前会被算成昨天。 */
function localDay(d) {
  const t = d instanceof Date ? d : new Date(d)
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/** 一天里的时段。 */
export function partOfDay(d = new Date()) {
  const t = d instanceof Date ? d : new Date(d)
  const h = t.getHours()
  if (h < 6) return '还在夜里'
  if (h < 11) return '早上'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  if (h < 23) return '晚上'
  return '快到半夜'
}

/**
 * 钟点 + 日子：14:53（11-07）。
 *
 * 为什么只补这一行：时段词（下午 / 晚上）太粗，过了六点就换一个字，她没别处可对，
 * 就会自己编一个「晚上了」。秒不写：每轮差几秒，写进去只会让提示词一直抖。
 */
export function clockOf(d = new Date()) {
  const t = d instanceof Date ? d : new Date(d)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(t.getHours())}:${p(t.getMinutes())}（${p(t.getMonth() + 1)}-${p(t.getDate())}）`
}

/** 天数的中文说法：三天前比 3 天前像人话。 */
const CN = ['', '一', '两', '三', '四', '五', '六']

/**
 * 间隔 → 一句话。纯函数，方便单测。
 * @param {number} ms 距上一句话的毫秒数（可以为负，视为「刚刚」）
 * @param {Date|number} [at] 现在（用来判断是不是同一天）
 */
export function describeGap(ms, at = Date.now()) {
  const now = at instanceof Date ? at : new Date(at)
  const gap = Math.max(0, Number(ms) || 0)
  // 0 / 负数：时间戳在未来或同一刻，按「刚刚」算，别报「几秒前」
  if (gap <= 0) return '上次说话就在刚才'
  const mins = gap / 60000
  const last = new Date(now.getTime() - gap)
  if (mins < 0.5) return '上一次说话是几秒前'
  if (mins < 2) return '上一次说话是一两分钟前'
  if (mins < 10) return '上次说话就在刚才'
  if (mins < 60) return '上次说话是不到一小时前'
  const days = Math.round((Date.parse(localDay(now)) - Date.parse(localDay(last))) / 86400000)
  if (days <= 0) return '上次说话是今天早些时候'
  if (days === 1) return '上次说话是昨天'
  if (days <= 6) return '上次说话是' + CN[days] + '天前'
  if (days <= 13) return '上次说话是一个多星期前'
  if (days <= 31) return '上次说话是半个多月前'
  if (days <= 90) return '上次说话是一两个月前'
  return '上次说话是好久以前了'
}

/** 网页会话在 chat_turns.conversation_id 里的键。QQ 用 qq:… 自己的键，两边别混。 */
export function webConversationId(sessionId) {
  const s = sessionId == null ? '' : String(sessionId).trim()
  return s ? 'dsh:' + s : null
}

/** 最近一条对话（用户或她自己）。给 opt.conversationId 时只在这一段里找。 */
export function lastTurnOf(db, aid, opt = {}) {
  try {
    const conv = opt.conversationId == null ? null : String(opt.conversationId)
    const row = conv
      ? db.prepare(`SELECT role, text, created_at, conversation_id FROM chat_turns
        WHERE agent_id=? AND conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(aid, conv)
      : db.prepare(`SELECT role, text, created_at, conversation_id FROM chat_turns
        WHERE agent_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(aid)
    if (!row || !row.created_at) return null
    const at = Date.parse(row.created_at)
    if (!Number.isFinite(at)) return null
    return { at, role: row.role, text: String(row.text || ''), raw: row.created_at, conversationId: row.conversation_id || null }
  } catch { return null }
}

const clip = (s, n) => {
  const a = Array.from(String(s || '').replace(/\s+/g, ' ').trim())
  return a.length > n ? a.slice(0, n).join('') + '…' : a.join('')
}

/**
 * 拼出注入里那一段「现在」。
 * @returns {{line:string, gapMs:number|null, phrase:string, last:object|null}}
 */
export function presenceLine(db, aid, opt = {}) {
  const at = opt.at != null ? new Date(opt.at) : new Date()
  const part = partOfDay(at)
  const clock = clockOf(at)
  const conv = opt.conversationId == null ? null : String(opt.conversationId)
  const last = opt.last !== undefined ? opt.last : lastTurnOf(db, aid)
  if (!last) return { line: '现在：' + part + ' ' + clock + '。还没跟他说过话。', gapMs: null, phrase: '', last: null, here: null }
  const gapMs = Math.max(0, at.getTime() - last.at)
  const phrase = describeGap(gapMs, at)
  // 引用只认这一段：本段没有上一句就只留时间距离，不拿别段的话冒充。
  const here = conv ? lastTurnOf(db, aid, { conversationId: conv }) : last
  const mine = here && here.role === 'agent'
  const tail = here && here.text ? '；' + (mine ? '我' : '你') + '上一句说的是「' + clip(here.text, 36) + '」' : ''
  return { line: '现在：' + part + ' ' + clock + '；' + phrase + tail + '。', gapMs, phrase, last, here: here || null }
}
