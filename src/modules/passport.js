/**
 * 注入行护照（S1）：一条记忆的「四时间 + 来源」。
 *
 * 只读：不动记忆、不 touch、不加热。
 * T1 先行：occurred / recorded / valid_until 从 memory_items + memory_timeline 取；
 * derived 从 fact_archive.payload 的 episode/turn 回链。
 * 同主题更晚的说法（fact_key 主题段命中）先算作「有更新」——S1 只标注，S3 才挤出去。
 */
import { now } from '../db.js'
import { isStalePair } from './stale_pair.js'

const EXCLUDE = new Set(['用户', '助手', '我', '你', '他', '她', '主人', '小汐', '对方', '自己'])
const STATE_WORDS = new Set(['待完成', '完成', '已完成', '已', '未', '进行中', '待办', '已做', '没做', '还没做'])

/** fact_key → 主题段（去掉主体段和状态段，取最长的一段）。 */
export function topicOfFactKey(fk) {
  const parts = String(fk || '').split('.').map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return ''
  const mid = parts.slice(1, parts.length > 2 ? -1 : undefined)
    .filter((s) => s.length >= 2 && !EXCLUDE.has(s) && !STATE_WORDS.has(s))
  mid.sort((a, b) => b.length - a.length)
  return mid[0] || ''
}

/**
 * 只有「事实 / 评价」的 key 才算槽位。
 *
 * 为什么：跑过真库，844 条带 key 的记忆里 fact 只有 275 条，其余 569 条是
 * 反思 / 情景被硬贴的 key（`用户.反应.哇塞`、`用户.指标回落.偏好`）。那不是
 * 「主语.关系」的槽位，是摘要句的编号——拿它判「值变了」只会误伤。
 *
 * 检索照旧用这个 key（search_text 需要它），只是不让它参与时态判定。
 */
const SLOT_TYPES = new Set(['fact', 'appraisal'])
export function isSlotKeyRow(row) {
  return !!row && SLOT_TYPES.has(String(row.type || '')) && !!String(row.fact_key || '').trim()
}

/** 中文 2-gram：用来确认「同一件事」，不是只看主题词。 */
function bigrams(text) {
  const chars = Array.from(String(text || '').replace(/[^\u4e00-\u9fff a-zA-Z0-9]/g, ''))
  const out = new Set()
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1])
  return out
}

/** 两段文本共享的 2-gram 是否够多（默认 3 个）：同主题词还不够，得是同一件事。 */
function related(a, b, min = 3) {
  const A = bigrams(a)
  const B = bigrams(b)
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return n >= min
}

const md = (iso) => {
  const s = String(iso || '')
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? m[2] + '-' + m[3] : ''
}

function derivedOf(db, aid, row) {
  try {
    if (row.source_turn_id) return 'turn:' + String(row.source_turn_id).slice(0, 24)
    const fa = db.prepare('SELECT payload FROM fact_archive WHERE agent_id=? AND memory_id=?').get(aid, row.id)
    if (!fa || !fa.payload) return null
    const p = JSON.parse(fa.payload)
    return p.episode_id ? 'episode:' + String(p.episode_id).slice(0, 24) : (p.source_turn_id ? 'turn:' + String(p.source_turn_id).slice(0, 24) : null)
  } catch { return null }
}

/**
 * 给一条记忆算护照。
 * @returns {{id:string, occurred:string|null, recorded:string|null, validUntil:string|null, derived:string|null, topic:string}}
 */
export function stampRow(db, aid, row) {
  const out = { id: row && row.id, occurred: null, recorded: (row && row.created_at) || null, validUntil: null, weakLater: null, derived: null, topic: '', source: null, slot: false }
  if (!row || !row.id) return out
  try {
    const events = db.prepare('SELECT op, at, valid_from, cause_id FROM memory_timeline WHERE agent_id=? AND memory_id=? ORDER BY seq').all(aid, row.id)
    const add = events.find((e) => e.op === 'ADD')
    out.occurred = (add && add.valid_from) || row.created_at || null
    out.validUntil = row.invalid_at || null
    out.source = row.invalid_at ? 'invalid' : null
    out.topic = topicOfFactKey(row.fact_key)
    out.slot = isSlotKeyRow(row)
    if (!out.validUntil && out.topic) {
      const later = db.prepare(`SELECT text, fact_key, created_at FROM memory_items
        WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND id<>?
          AND fact_key IS NOT NULL AND fact_key LIKE ? AND created_at>?
        ORDER BY created_at DESC LIMIT 1`).get(aid, row.id, '%' + out.topic + '%', row.created_at)
      // 同主题词还不够：两段正文得共享足够多的 2-gram，才认定是「同一件事的更新」。
      // 只有两种来源算「旧了」：
      //   topic_key   —— 同一个 fact_key（确定：槽位取值变了）
      //   topic_state —— 「还没做完 → 做好了」的状态词对（半确定：只标不挤）
      // 只是同主题的（weakLater）**不判旧**：跑过回放，「oneLine」这种词能撞出五条
      // 互不相干的结论，相似度不足以判新旧。它只留成弱标候选，默认不进注入。
      if (later && later.created_at && related(row.text, later.text)) {
        const sameKey = !!row.fact_key && String(row.fact_key) === String(later.fact_key)
        const statePair = isStalePair(row.text, later.text)
        if (sameKey || statePair) {
          out.validUntil = later.created_at
          out.source = sameKey ? 'topic_key' : 'topic_state'
        } else {
          out.weakLater = later.created_at
        }
      }
    }
    out.derived = derivedOf(db, aid, row)
  } catch { /* 老库缺表就少几项，不抛 */ }
  return out
}

/** 是否该从正桌挤出：只认「明确作废」和「同一个 key 的确定更新」；状态词对、弱标都只标不挤。 */
export function isStale(db, aid, row) {
  if (!row) return false
  const s = stampRow(db, aid, row)
  // 明确作废：不论什么类型都不该再当现状讲。
  if (s.source === 'invalid') return true
  // 状态词对（topic_state）：只标，不挤。
  if (s.source !== 'topic_key') return false
  // 同 key 更新：只有真槽位（fact/appraisal）才允许把旧条挤出正桌。
  // 反思 / 情景被硬贴的 key 不算槽位——它们没有「值」，谈不上被取代。
  return !!s.slot
}

function diaryNote(db, aid, row, topic) {
  const day = String((row && row.created_at) || '').slice(0, 10)
  try {
    const d = db.prepare(`SELECT day, text FROM diaries
      WHERE agent_id=? AND day>=? AND text LIKE ? ORDER BY day DESC LIMIT 1`).get(aid, day, '%' + topic + '%')
    if (!d || !d.text || !related(row.text, d.text, 2)) return ''
    const body = String(d.text).replace(/\s+/g, ' ').trim()
    return '（后来在 ' + md(d.day) + ' 的日记里写到：' + (body.length > 36 ? body.slice(0, 36) + '…' : body) + '）'
  } catch { return '' }
}

function turnNote(db, aid, row, topic) {
  if (topic.length < 3) return ''
  try {
    const t = db.prepare(`SELECT created_at, text FROM fragments
      WHERE agent_id=? AND role='user' AND created_at>? AND text LIKE ?
      ORDER BY created_at DESC LIMIT 1`).get(aid, (row && row.created_at) || '', '%' + topic + '%')
    if (!t || !t.text || !related(row.text, t.text, 2)) return ''
    const body = String(t.text).replace(/\s+/g, ' ').trim()
    return '（后来你提过：' + (body.length > 30 ? body.slice(0, 30) + '…' : body) + '）'
  } catch { return '' }
}

/**
 * 跨库：T2 纪要 → T3 日记 → T4 原话，找更晚的同主题记录（S2）。
 * 只标注，不挤出；误报由 S3 的挤出前抽查兜住。
 * 收紧：主题词至少 3 字，且正文要真的相关（2-gram 命中）——「标签」这种 2 字泛词不查。
 * @returns {string} 空串或「（后来在 … 里聊到：…）」
 */
export function crossLayerNote(db, aid, row, opt = {}) {
  const topic = topicOfFactKey(row && row.fact_key)
  if (!topic || topic.length < 3) return ''
  const since = (row && row.created_at) || ''
  try {
    // 阶段 D：不再查 topics 列——跑过真库，它是正文的 2-gram 切片（「你还」「还挺」「文咋」），
    // 拿它当主题标签只会撞出一堆噪音；标题是人写的，比它靠谱。
    let ep = db.prepare(`SELECT day, title, summary, end_at FROM episodes
      WHERE agent_id=? AND end_at>? AND summary IS NOT NULL AND summary<>''
        AND (summary LIKE ? OR title LIKE ?)
      ORDER BY end_at DESC LIMIT 1`).get(aid, since, '%' + topic + '%', '%' + topic + '%')
    if (ep && !related(row.text, String(ep.summary || '') + ' ' + String(ep.title || ''), 2)) ep = null
    if (ep) {
      const body = String(ep.summary || '').replace(/\s+/g, ' ').trim()
      return '（后来在 ' + md(ep.day) + ' 的纪要里聊到：' + (body.length > 40 ? body.slice(0, 40) + '…' : body) + '）'
    }
  } catch { /* 少一路不影响 */ }
  const d = diaryNote(db, aid, row, topic)
  if (d) return d
  return turnNote(db, aid, row, topic)
}

/**
 * 非槽位旧条目的「陈述时态」（阶段 C）。
 *
 * 反思 / 情景 / 评价没有「值」，谈不上被取代；但过几天还按原话讲，
 * 就会变成「把当时的判断当现在」。这一句只补时间，不改内容。
 * 三天以内不贴：刚说完的事本来就还新鲜，贴了只是噪音。
 */
const STATEMENT_DAYS = 3
function statementNote(s, opt) {
  if (String(opt && opt.statement) === 'off') return ''
  const t = Date.parse(String(s.occurred || ''))
  if (!Number.isFinite(t)) return ''
  if (Date.now() - t < STATEMENT_DAYS * 86400000) return ''
  const from = md(s.occurred)
  if (!from) return ''
  return '（' + from + ' 的旧判断）'
}

/**
 * 注入用的一小句护照；只有「旧了 / 有更新」才显示，新条不占地方。
 * 例：（10-03 说的；10-27 起有更新的说法） 或 （后来在 10-27 的纪要里聊到：…）
 * @returns {string}
 */
export function passportLine(db, aid, row, opt = {}) {
  if (String(opt && opt.on) === 'off') return ''
  const s = stampRow(db, aid, row)
  if (s.validUntil) {
    const from = md(s.occurred)
    const until = md(s.validUntil)
    if (until) {
      // 状态词对：说得出「当时还在等、后来做完了」，但这条本身还在桌上（不挤）。
      if (s.source === 'topic_state') {
        return '（' + (from ? from + ' 说的，当时还没做完' : '当时还没做完') + '；后来看到它已经做完了）'
      }
      return '（' + (from ? from + ' 说的；' : '') + until + ' 起有更新的说法）'
    }
  }
  // 弱标视图（默认不看）：同主题后面还有一条更晚的说法。
  // 它不参与 validUntil——「同主题」不足以判旧，只有开这个视图时才当参考。
  // 弱标视图：已证伪（同主题大量是词撞车），默认关、冻结。只给回放对照用。
  if (s.weakLater && String(opt && opt.weak) === 'on') {
    const from = md(s.occurred)
    return '（' + (from ? from + ' 说的；' : '') + '同主题后面还有一条更晚的说法）'
  }
  // 阶段 C：没有「值」的旧条目，至少把「这是哪天的判断」说出来。
  if (!s.slot) {
    const note = statementNote(s, opt)
    if (note) return note
  }
  return crossLayerNote(db, aid, row, opt)
}

// 导出给体检脚本用：口径只在这里写一次，别让审计脚本自己复制一套 2-gram。
export { now, related, bigrams }
