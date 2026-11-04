/**
 * 原话层：值得留着的原话单独放一条，不压成结论。
 *
 * 为什么不是再写一条「记忆」：结论（memory_items 里的 fact / reflection）
 * 是方便贴，时间一长就变成规矩；原话会冷，但不会被改写。这里只干三件事：
 *   1) 一轮里如果情绪够、或者有笑/软的字眼，就把两个人的原话整段留下；
 *   2) 热度按天慢慢衰减，被回放一次就焐热一次（像复习）；
 *   3) 下一轮最多回放一句原话——原样放，不加解释，不写成命令。
 *
 * 存法沿用 events 表，不新表、不改 schema：
 *   quote.moment        {user, agent, turn_id, at, v, a}
 *   quote.moment.shown  {moment_id}
 */

const DAY = 86400000
/** 原话的热度按这个时间常数衰减：四天没被碰就凉一半多一点。 */
const TAU_DAYS = 4
/** 回放冷却：刚回放过一条，四十五分钟内不再放。 */
const COOLDOWN_MS = 45 * 60000
/** 同一条原话三天内不重复放。 */
const REPEAT_MS = 3 * DAY
/** 放太久的原话只在特别热的时候才冒头，别把一个月前的笑话翻出来。 */
const STALE_MS = 30 * DAY

const MAX_SIDE = 220

function rid(prefix) {
  return prefix + Math.random().toString(16).slice(2, 12)
}

function parse(text) {
  try { return JSON.parse(text || 'null') || {} } catch { return {} }
}

/**
 * 值不值得留这一轮的原话。
 * 太长的（工作汇报）不整句存；要么有笑/软的字眼，要么这一轮情绪够。
 */
export function worthKeeping(user, agent, intensity) {
  const u = String(user || '').trim()
  if (!u) return false
  if (Array.from(u).length > MAX_SIDE) return false
  const warm = /嘿嘿|哈哈|可爱|顺眼|笑|好玩|喜欢|谢谢|么么|抱抱/.test(u)
  return warm || Number(intensity) >= 0.35
}

/** 把这一轮的原话记下来。返回存下的条目；不值得留就返回 null。 */
export function captureQuote(db, aid, { user, agent, turnId = null, intensity = 0, at = Date.now() } = {}) {
  if (!worthKeeping(user, agent, intensity)) return null
  const payload = {
    user: String(user || '').trim().slice(0, MAX_SIDE),
    agent: String(agent || '').trim().slice(0, MAX_SIDE),
    turn_id: turnId || null,
    at: new Date(at).toISOString(),
  }
  const id = rid('qt_')
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run(id, aid, 'quote.moment', JSON.stringify(payload), new Date(at).toISOString())
  } catch { return null }
  return { id, ...payload }
}

/** 每条原话被回放过几次、最近一次是什么时候。 */
function shownIndex(db, aid, since) {
  const count = new Map()
  const last = new Map()
  let rows = []
  try {
    rows = db.prepare("SELECT payload,created_at FROM events WHERE agent_id=? AND type='quote.moment.shown' AND created_at>=?").all(aid, since)
  } catch { return { count, last } }
  for (const r of rows) {
    const p = parse(r.payload)
    const mid = String(p.moment_id || '')
    if (!mid) continue
    count.set(mid, (count.get(mid) || 0) + 1)
    const t = Date.parse(r.created_at)
    if (Number.isFinite(t) && (!last.has(mid) || t > last.get(mid))) last.set(mid, t)
  }
  return { count, last }
}

/** 一条原话此刻的热度：新鲜度 + 被焐热的次数。纯函数，方便单测。 */
export function heatOfQuote(row, hits = 0, at = Date.now()) {
  if (!row) return 0
  const born = Date.parse(row.created_at || row.at || '')
  const ageDays = Number.isFinite(born) ? Math.max(0, (at - born) / DAY) : 0
  const fresh = Math.exp(-ageDays / TAU_DAYS)
  const warm = Math.min(1, Math.max(0, Number(hits) || 0) / 5)
  return Math.round((0.7 * fresh + 0.3 * warm) * 1000) / 1000
}

/** 回放画面的那一行：原样放，不解释，不加「主人喜欢…」这种结论。 */
export function quoteLineOf(m) {
  const u = String(m.user || '').trim()
  const a = String(m.agent || '').trim()
  if (!u) return ''
  const left = u.length > 90 ? u.slice(0, 90) + '…' : u
  if (!a) return '（那会儿你：「' + left + '」。）'
  const right = a.length > 90 ? a.slice(0, 90) + '…' : a
  return '（那会儿你：「' + left + '」；我：「' + right + '」。）'
}

/**
 * 下一轮可以回放哪一条原话。
 * 冷却中、没有够热的、或者同一条三天内刚放过，都返回 null——宁可不提。
 */
export function quoteCandidate(db, aid, at = Date.now()) {
  const since = new Date(at - STALE_MS).toISOString()
  try {
    const lastShown = db.prepare("SELECT created_at FROM events WHERE agent_id=? AND type='quote.moment.shown' ORDER BY created_at DESC LIMIT 1").get(aid)
    if (lastShown && at - Date.parse(lastShown.created_at) < COOLDOWN_MS) return null
    const rows = db.prepare("SELECT id,payload,created_at FROM events WHERE agent_id=? AND type='quote.moment' AND created_at>=? ORDER BY created_at DESC LIMIT 60").all(aid, since)
    if (!rows.length) return null
    const idx = shownIndex(db, aid, since)
    let best = null
    for (const r of rows) {
      const p = parse(r.payload)
      if (!p.user) continue
      const lastAt = idx.last.get(r.id) || 0
      if (lastAt && at - lastAt < REPEAT_MS) continue
      const heat = heatOfQuote(r, idx.count.get(r.id) || 0, at)
      if (heat < 0.3) continue
      if (!best || heat > best.heat) best = { id: r.id, user: p.user, agent: p.agent, heat }
    }
    if (!best) return null
    return { id: best.id, line: quoteLineOf(best), heat: best.heat, committed: false }
  } catch { return null }
}

/** 真的进了这一轮的注入文本才记「回放过」。 */
export function commitQuote(db, aid, cand, at = Date.now()) {
  if (!cand || !cand.id || !cand.line || cand.committed) return false
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run(rid('evt_'), aid, 'quote.moment.shown', JSON.stringify({ moment_id: cand.id }), new Date(at).toISOString())
    cand.committed = true
    return true
  } catch { return false }
}

/** 面板用：最近几天留了几条、回放了几条。 */
export function quoteStats(db, aid, { days = 7, at = Date.now() } = {}) {
  const since = new Date(at - Math.max(1, days) * DAY).toISOString()
  const one = (type) => {
    try { return Number(db.prepare('SELECT COUNT(*) n FROM events WHERE agent_id=? AND type=? AND created_at>=?').get(aid, type, since).n || 0) } catch { return 0 }
  }
  let hot = []
  try {
    const rows = db.prepare("SELECT id,payload,created_at FROM events WHERE agent_id=? AND type='quote.moment' AND created_at>=? ORDER BY created_at DESC LIMIT 20").all(aid, since)
    const idx = shownIndex(db, aid, since)
    hot = rows.map((r) => {
      const p = parse(r.payload)
      return { id: r.id, at: r.created_at, heat: heatOfQuote(r, idx.count.get(r.id) || 0, at), user: String(p.user || '').slice(0, 40) }
    }).sort((a, b) => b.heat - a.heat).slice(0, 5)
  } catch { /* ignore */ }
  return { days, recorded: one('quote.moment'), shown: one('quote.moment.shown'), hot }
}
