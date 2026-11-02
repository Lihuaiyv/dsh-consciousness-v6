/**
 * 时间距离（P6）：她现在离上一句话有多远。
 *
 * 为什么单独一个模块：以前注入里只有「下午」这种时段，她不知道你是刚才说的，
 * 还是三天前说的。同一句「我回来了」，落在十分钟后和三周后，该是两种回答。
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

/** 最近一条对话（用户或她自己）。 */
export function lastTurnOf(db, aid, opt = {}) {
  try {
    const row = db.prepare(`SELECT role, text, created_at FROM chat_turns
      WHERE agent_id=? ORDER BY created_at DESC LIMIT 1`).get(aid)
    if (!row || !row.created_at) return null
    const at = Date.parse(row.created_at)
    if (!Number.isFinite(at)) return null
    return { at, role: row.role, text: String(row.text || ''), raw: row.created_at }
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
  let last = opt.last !== undefined ? opt.last : lastTurnOf(db, aid)
  if (!last) return { line: '现在：' + part + '。还没跟他说过话。', gapMs: null, phrase: '', last: null }
  const gapMs = Math.max(0, at.getTime() - last.at)
  const phrase = describeGap(gapMs, at)
  const mine = last.role === 'agent'
  const tail = last.text ? '；' + (mine ? '我' : '你') + '上一句说的是「' + clip(last.text, 36) + '」' : ''
  return { line: '现在：' + part + '；' + phrase + tail + '。', gapMs, phrase, last }
}
