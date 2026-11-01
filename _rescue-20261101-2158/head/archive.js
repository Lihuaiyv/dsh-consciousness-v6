/**
 * 分层记忆 · 冷/温层
 *
 * T4 raw_turns  原文：只追加，一行一句，永不改写。写入是同步的，失败就抛。
 * T4 fact_archive 事实存根：每条事实第一次被蒸馏出来的样子，留一句原文，永不改写。
 * T2 episodes   纪要：一次会话 + 一天一压缩，给日记当原料。
 * T3 diaries    日记：一天一篇，第一人称；可重建，旧版本号保留。
 *
 * 原则：
 *   - 原文是真相，纪要和日记都是投影，坏了能重算；
 *   - 热路径（每轮对话）**不读原文**，只在用户明确要“原话/时间线”时查；
 *   - 模型可用就让模型写，不可用就用确定的模板，绝不编。
 */

import crypto from 'node:crypto'
import { now, dayKey } from '../db.js'
import { nid, getParam, getFlag, setFlag } from '../kernel.js'
import { llmBudgetAllow, llmBudgetBump } from './llm_budget.js'
import { readViews } from './sangguan/bridge.js'

const DAY_MS = 86400000

const STOP = new Set([
  '什么', '怎么', '怎样', '如何', '这个', '那个', '我们', '你们', '他们', '自己',
  '现在', '今天', '昨天', '明天', '可以', '应该', '需要', '因为', '所以', '但是',
  '不过', '如果', '还是', '就是', '不是', '已经', '正在', '一起', '一下', '一个',
  '觉得', '知道', '记得', '告诉', '帮忙', '事情', '东西', '问题', '地方', '这样',
  '那样', '真的', '一直', '最近', '其实', '然后', '而且', '或者', '虽然', '另外',
  '还有', '只是', '以及', '对于', '关于', '通过', '等等', '之类', '而已', '好的',
])

/** 本地日历日（与夜巡 / 日记对齐；禁止用 ISO UTC 的前 10 位）。 */
function dayOf(iso) { return dayKey(iso || now()) }

function grams(text, n = 2) {
  const out = new Map()
  const runs = String(text || '').match(/[\u4e00-\u9fff]+|[a-zA-Z0-9]{2,}/g) || []
  for (const run of runs) {
    if (/^[a-zA-Z0-9]+$/.test(run)) { out.set(run.toLowerCase(), (out.get(run.toLowerCase()) || 0) + 1); continue }
    for (let i = 0; i + n <= run.length; i++) {
      const g = run.slice(i, i + n)
      if (STOP.has(g)) continue
      out.set(g, (out.get(g) || 0) + 1)
    }
  }
  return out
}

/** 从一串用户话里挑几个能当索引的词（不追求准，只求可读）。 */
function topicsOf(texts, k = 6) {
  const total = new Map()
  for (const t of texts) for (const [g, n] of grams(t)) total.set(g, (total.get(g) || 0) + n)
  return [...total.entries()]
    .filter(([g, n]) => n >= 2 || g.length >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([g]) => g)
}

function trim(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

// ---------------------------------------------------------------- T4 原文

/**
 * 追加一句原文。调用方拿到的是稳定 id，重复调用同一条不会重复写。
 * @returns {{id:string, seq:number, duplicate:boolean}}
 */
export function appendTurn(db, aid, input = {}) {
  const sessionId = String(input.sessionId || input.session_id || 'local')
  const role = String(input.role || 'user')
  const text = String(input.text || '')
  if (!text.trim()) return { id: null, seq: 0, duplicate: false }
  const at = String(input.at || now())
  const turnId = input.turnId || null
  const fingerprint = [aid, sessionId, role, turnId || '', text, at].join('\u0001')
  const id = 'raw_' + crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 20)
  // 同一句在 3 秒内重复到达（重放 / 重复事件）只算一次；隔了很久的同一句话是真说过两次，要留。
  const since = new Date(Date.parse(at) - 3000).toISOString()
  const near = db.prepare(`SELECT id,seq FROM raw_turns WHERE session_id=? AND role=? AND text=? AND created_at>=?
    ORDER BY created_at DESC LIMIT 1`).get(sessionId, role, text, since)
  if (near) return { id: near.id, seq: Number(near.seq), duplicate: true }
  const old = db.prepare('SELECT id,seq FROM raw_turns WHERE id=?').get(id)
  if (old) return { id, seq: Number(old.seq), duplicate: true }
  const seq = Number(db.prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM raw_turns WHERE session_id=?').get(sessionId).n)
  db.prepare(`INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, aid, sessionId, turnId, seq, role, text,
    input.tool || null, input.meta ? JSON.stringify(input.meta) : null, at, dayOf(at),
  )
  try { db.prepare('INSERT INTO raw_fts(id,text) VALUES(?,?)').run(id, text) } catch { /* 索引失败不挡原文 */ }
  return { id, seq, duplicate: false }
}

/** 把旧的 chat_turns 补进原文层（一次性）。旧表没有会话 id，统一归到 legacy。 */
export function migrateChatTurns(db, aid) {
  let rows = []
  try { rows = db.prepare('SELECT role,text,created_at FROM chat_turns WHERE agent_id=? ORDER BY created_at').all(aid) } catch { return 0 }
  let n = 0
  for (const r of rows) {
    try {
      const res = appendTurn(db, aid, { sessionId: 'legacy', role: r.role, text: r.text, at: r.created_at })
      if (!res.duplicate) n++
    } catch { /* 单条失败跳过 */ }
  }
  return n
}

/** 一次性迁移：旧 chat_turns → 原文层，并把每一天压成纪要。 */
export function migrateArchive(db, aid) {
  const key = 'archive.migrated:' + aid
  try { if (db.prepare('SELECT value FROM flags WHERE key=?').get(key)) return 0 } catch { return 0 }
  const n = migrateChatTurns(db, aid)
  try {
    const days = db.prepare("SELECT DISTINCT day FROM raw_turns WHERE agent_id=? AND session_id='legacy'").all(aid)
    for (const d of days) buildEpisodes(db, aid, { session: 'legacy', day: d.day })
  } catch { /* 纪要失败不影响原文 */ }
  try {
    db.prepare("INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, now())
  } catch { /* ignore */ }
  return n
}

/**
 * 把 raw_turns.day 从「UTC 前 10 位」纠正为本地日历日（一次性；幂等）。
 * 返回改写行数。
 */
export function recomputeRawDays(db, aid) {
  const flag = 'archive.day_local:' + aid
  try { if (db.prepare('SELECT value FROM flags WHERE key=?').get(flag)) return 0 } catch { /* 继续 */ }
  let n = 0
  try {
    const rows = db.prepare('SELECT id, created_at, day FROM raw_turns WHERE agent_id=?').all(aid)
    const upd = db.prepare('UPDATE raw_turns SET day=? WHERE id=?')
    for (const r of rows) {
      const d = dayKey(r.created_at)
      if (d && d !== r.day) { upd.run(d, r.id); n++ }
    }
    db.prepare("INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(flag, now())
  } catch { /* 老库没有原文层 */ }
  return n
}

/** 原文索引重建（导入 / 修复后用）。fts5 非 external content，只能清空重灌。 */
export function rebuildRawFts(db) {
  try {
    db.exec('DELETE FROM raw_fts')
    db.prepare('INSERT INTO raw_fts(id,text) SELECT id,text FROM raw_turns').run()
    return true
  } catch { return false }
}

/** 原文时间线：按天/会话翻，不搜索。 */
export function listRaw(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(500, Number(opt.limit) || 100))
  const offset = Math.max(0, Number(opt.offset) || 0)
  const where = ['agent_id=?']
  const args = [aid]
  if (opt.day) { where.push('day=?'); args.push(String(opt.day)) }
  if (opt.session) { where.push('session_id=?'); args.push(String(opt.session)) }
  args.push(limit, offset)
  const rows = db.prepare(`SELECT id,session_id,seq,role,text,tool,created_at,day FROM raw_turns
    WHERE ${where.join(' AND ')} ORDER BY created_at DESC, seq DESC LIMIT ? OFFSET ?`).all(...args)
  return rows.reverse().map((r) => ({ ...r, seq: Number(r.seq) }))
}

/** 原文全文检索：只在用户明确说“翻原话”时用。
 *  opt.since（ISO 时间）给「只翻最近 N 天」用；不传就是全时间。 */
export function searchRaw(db, aid, query, k = 8, opt = {}) {
  const q = String(query || '').trim()
  const limit = Math.max(1, Math.min(50, Number(k) || 8))
  if (!q) return []
  const since = opt.since ? String(opt.since) : null
  const sinceSql = since ? ' AND r.created_at >= ?' : ''
  const sinceSqlBare = since ? ' AND created_at >= ?' : ''
  const terms = [...grams(q, 3).keys()].slice(0, 12)
  if (terms.length) {
    try {
      const fts = terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
      const args = since ? [fts, aid, since, limit] : [fts, aid, limit]
      const rows = db.prepare(`SELECT r.*, bm25(raw_fts) AS rank FROM raw_fts
        JOIN raw_turns r ON r.id=raw_fts.id
        WHERE raw_fts MATCH ? AND r.agent_id=?${sinceSql} ORDER BY rank LIMIT ?`).all(...args)
      if (rows.length) return rows.map((r) => ({ ...r, seq: Number(r.seq) }))
    } catch { /* 回退 LIKE */ }
  }
  const short = String(q).replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, '')
  if (!short) return []
  const like = '%' + short.slice(0, 8) + '%'
  const args = since ? [aid, like, since, limit] : [aid, like, limit]
  return db.prepare(`SELECT * FROM raw_turns WHERE agent_id=? AND text LIKE ?${sinceSqlBare} ORDER BY created_at DESC LIMIT ?`)
    .all(...args).map((r) => ({ ...r, seq: Number(r.seq) }))
}

/** 会话目录：每个会话从哪到哪、多少句。 */
export function listSessions(db, aid, limit = 50) {
  return db.prepare(`SELECT session_id, MIN(created_at) start_at, MAX(created_at) end_at,
      COUNT(*) turns, MIN(day) day
    FROM raw_turns WHERE agent_id=? GROUP BY session_id ORDER BY end_at DESC LIMIT ?`)
    .all(aid, Math.max(1, Math.min(200, Number(limit) || 50)))
}

// ---------------------------------------------------------------- T4 事实存根

/**
 * 事实的「出生照」：这条事实**第一次被蒸馏出来**时的样子。
 * 只追加、永不改写——之后在 memory_items 里被衰减、被推翻、被合并、被删，这一份都不动。
 * 同一条记忆只留第一次，后面再调直接返回已有 id。
 * @returns {{id:string|null, duplicate:boolean}}
 */
export function archiveFact(db, aid, fact = {}) {
  const mid = String(fact.memory_id || fact.id || '')
  const text = String(fact.text || '')
  if (!mid || !text.trim()) return { id: null, duplicate: false }
  const old = db.prepare('SELECT id FROM fact_archive WHERE agent_id=? AND memory_id=?').get(aid, mid)
  if (old) return { id: old.id, duplicate: true }
  const id = 'far_' + crypto.createHash('sha1').update(aid + '\u0001' + mid).digest('hex').slice(0, 20)
  let payload = null
  try {
    const extra = fact.payload && typeof fact.payload === 'object' ? fact.payload : null
    if (extra && Object.keys(extra).length) payload = JSON.stringify(extra).slice(0, 2000)
  } catch { payload = null }
  const at = String(fact.created_at || now())
  const r = db.prepare(`INSERT OR IGNORE INTO fact_archive(id,agent_id,memory_id,text,type,mark,
      importance,salience,confidence,fact_key,source_turn_id,source,payload,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, aid, mid, text, fact.type || 'fact', fact.mark || null,
    fact.importance != null ? Number(fact.importance) : null,
    fact.salience != null ? Number(fact.salience) : null,
    fact.confidence != null ? Number(fact.confidence) : null,
    fact.fact_key || null, fact.source_turn_id || null, String(fact.source || 'model'), payload, at,
  )
  if (!Number(r.changes)) return { id: null, duplicate: true }
  try { db.prepare('INSERT INTO fact_fts(id,text) VALUES(?,?)').run(id, text) } catch { /* 索引失败不挡存根 */ }
  return { id, duplicate: false }
}

/** 事实存根时间线：最新在前。 */
export function listFactArchive(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(500, Number(opt.limit) || 50))
  const offset = Math.max(0, Number(opt.offset) || 0)
  return db.prepare(`SELECT id,memory_id,text,type,importance,salience,confidence,
      source_turn_id,source,payload,created_at FROM fact_archive
    WHERE agent_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(aid, limit, offset)
    .map((r) => {
      let payload = null
      try { payload = r.payload ? JSON.parse(r.payload) : null } catch { payload = null }
      return { ...r, payload }
    })
}

/** 事实存根检索：回答「我当初是怎么记这件事的」。 */
export function searchFactArchive(db, aid, query, k = 8) {
  const q = String(query || '').trim()
  const limit = Math.max(1, Math.min(50, Number(k) || 8))
  if (!q) return []
  const terms = [...grams(q, 3).keys()].slice(0, 12)
  if (terms.length) {
    try {
      const fts = terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
      const rows = db.prepare(`SELECT f.*, bm25(fact_fts) AS rank FROM fact_fts
        JOIN fact_archive f ON f.id=fact_fts.id
        WHERE fact_fts MATCH ? AND f.agent_id=? ORDER BY rank LIMIT ?`).all(fts, aid, limit)
      if (rows.length) return rows
    } catch { /* 回退 LIKE */ }
  }
  const short = String(q).replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, '')
  if (!short) return []
  const like = '%' + short.slice(0, 8) + '%'
  return db.prepare('SELECT * FROM fact_archive WHERE agent_id=? AND text LIKE ? ORDER BY created_at DESC LIMIT ?')
    .all(aid, like, limit)
}

/**
 * 事实存根的全文索引重建（导入 / 修复后用）。
 * fts5 表不是 external content，`INSERT ... VALUES('rebuild')` 在这种表上用不了，
 * 只能自己清空重灌——原来的写法永远静默失败。
 */
export function rebuildFactFts(db) {
  try {
    db.exec('DELETE FROM fact_fts')
    db.prepare('INSERT INTO fact_fts(id,text) SELECT id,text FROM fact_archive').run()
    return true
  } catch { return false }
}

/**
 * 记忆抽屉的全文索引重建。索引可能因为写入中断 / 外部导入而漏行
 * （这次体检查到 5 条 active 记忆不在 FTS 里，等于永远搜不到）。
 */
export function rebuildMemoryFts(db) {
  try {
    db.exec('DELETE FROM memory_fts')
    // 与写入侧一致：索引 search_text（含 key/同义词），没有才回落原文
    db.prepare(`INSERT INTO memory_fts(id,text)
      SELECT id, COALESCE(NULLIF(search_text,''), text) FROM memory_items WHERE status='active'`).run()
    return true
  } catch { return false }
}

/**
 * 老库补存根：已经存在但还没有出生照的事实，用「现在这一版」补一张，source 标 backfill。
 * 一次 LEFT JOIN 就能判断缺哪些，没缺的库上等于空跑。
 */
export function backfillFactArchive(db, aid = null) {
  const where = aid ? 'WHERE m.agent_id=?' : ''
  const args = aid ? [aid] : []
  const rows = db.prepare(`SELECT m.* FROM memory_items m
    LEFT JOIN fact_archive f ON f.memory_id=m.id AND f.agent_id=m.agent_id
    ${where ? where + ' AND f.id IS NULL' : 'WHERE f.id IS NULL'}`).all(...args)
  let n = 0
  for (const r of rows) {
    try {
      const out = archiveFact(db, r.agent_id, {
        memory_id: r.id, text: r.text, type: r.type, mark: r.mark,
        importance: r.importance, salience: r.salience, confidence: r.confidence,
        fact_key: r.fact_key, source_turn_id: r.source_turn_id,
        source: 'backfill', created_at: r.created_at,
      })
      if (out.id) n++
    } catch { /* 单条失败跳过 */ }
  }
  return n
}

// ---------------------------------------------------------------- T2 纪要 · E0 L0
// 滤噪 → 切段 → 多信号打分抽样 → 结构化字段 → importance。
// 同会话可多段（seg）；默认不调模型（L1/L2 另批）。

/** 静默间隔（ms）或轮次上限 → 切段 */
export const EP_GAP_MS = 20 * 60 * 1000
export const EP_MAX_TURNS = 40

/** 运行时 / 工具 / 粘贴噪声：不当纪要原料。 */
export function isEpisodeNoise(text) {
  const s = String(text || '').trim()
  if (!s || s.length < 2) return true
  if (/^(Time sampled|Approval prompts)\b/i.test(s)) return true
  if (/^The approval policy changed\b/i.test(s)) return true
  if (/^(system|assistant|user|developer)\s*[:：]/i.test(s)) return true
  if (/^你是研究助理/.test(s)) return true
  if (/^(请|你要|作为).{0,20}(助手|助理|AI)/.test(s) && s.length > 80) return true
  if (/^```/.test(s)) return true
  if (/^Request URL\s/i.test(s)) return true
  if (/^(##|<)/.test(s)) return true
  if (/^\{[\s\S]*\}$/.test(s) && s.length > 80) return true
  if (/^(ok|OK|嗯+|哈+|呵呵|哈哈|好的|谢谢|在的?|你好呀?|嗨)[\s!！。.~]*$/i.test(s) && s.length <= 6) return true
  // 纯表情 / 符号，没有可读汉字或拉丁词
  if (![...s].some((ch) => /[\u4e00-\u9fffA-Za-z0-9]/.test(ch))) return true
  if (s.length > 400) {
    const lines = (s.match(/\n/g) || []).length
    if (/https?:\/\//.test(s) || /[{}]/.test(s) || lines >= 3) return true
  }
  return false
}

export function isGreetingOnly(text) {
  const s = String(text || '').trim()
  return /^(你好|您好|嗨|哈喽|在吗|早上好|晚上好|午安)[\s!！。.~吗？?]*$/i.test(s)
}

function firstClause(text, max = 24) {
  const s = String(text || '').trim()
  if (!s) return ''
  const cut = s.split(/[。！？!?\n]/)[0] || s
  return trim(cut, max)
}

function parseAt(iso) {
  const t = Date.parse(String(iso || ''))
  return Number.isFinite(t) ? t : 0
}

/**
 * 把有序原文切成多段：静默 ≥20min，或单段满 40 轮。
 * @returns {Array<Array<object>>}
 */
export function segmentTurns(rows, opt = {}) {
  const gapMs = Math.max(60_000, Number(opt.gapMs) || EP_GAP_MS)
  const maxTurns = Math.max(8, Math.min(200, Number(opt.maxTurns) || EP_MAX_TURNS))
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return []
  const segs = []
  let cur = []
  for (const row of list) {
    if (cur.length) {
      const gap = parseAt(row.created_at) - parseAt(cur[cur.length - 1].created_at)
      if (gap >= gapMs || cur.length >= maxTurns) {
        segs.push(cur)
        cur = []
      }
    }
    cur.push(row)
  }
  if (cur.length) segs.push(cur)
  return segs
}

/**
 * 单句信息量打分（越高越该进要点）。噪声句直接 0。
 */
export function scoreTurn(text, role = 'user', index = 0, total = 1) {
  const s = String(text || '').trim()
  if (isEpisodeNoise(s)) return 0
  if (isGreetingOnly(s)) return 0.2
  let score = 1
  if (/[?？]|(吗|呢|怎么办|要不要|为何|为什么)$/.test(s) || /[?？]/.test(s)) score += 3
  if (/(决定|答应|记住|不要|别再|以后|下次一定|我去|我会|我想要|打算)/.test(s)) score += 2
  if (/(喜欢|讨厌|爱|烦|怕|希望|偏好)/.test(s)) score += 2
  if (/[\u4e00-\u9fff]{2,4}(说|让|叫|是)/.test(s) || /\b[A-Z][a-z]{2,}\b/.test(s)) score += 1
  const len = [...s].length
  if (len >= 8 && len <= 80) score += 1.2
  else if (len >= 4 && len <= 120) score += 0.5
  else if (len > 200) score -= 0.5
  const t = Math.max(1, total)
  const pos = index / t
  if (pos <= 0.2 || pos >= 0.8) score += 0.5
  if (role !== 'user') score *= 0.85
  return Math.max(0, score)
}

function pickTopByScore(items, n) {
  const ranked = [...items].filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i)
  const top = ranked.slice(0, Math.max(0, n))
  top.sort((a, b) => a.i - b.i)
  return top
}

/**
 * 从一段原文压出纪要字段（纯函数）。
 * @returns {{title,summary,beats,reply,topics,open_loops,importance,kept,dropped}}
 */
export function composeEpisodeFields(rows, opt = {}) {
  const list = Array.isArray(rows) ? rows : []
  const total = list.length
  const scored = list.map((r, i) => ({
    i,
    role: r.role,
    text: String(r.text || ''),
    score: scoreTurn(r.text, r.role, i, total),
  }))
  const userScored = scored.filter((x) => x.role === 'user')
  const agentScored = scored.filter((x) => x.role !== 'user')
  const meaningful = userScored.filter((x) => x.score > 0).map((x) => x.text)
  const dropped = scored.filter((x) => x.score <= 0).length
  const kept = scored.length - dropped

  const userPicks = pickTopByScore(userScored, Math.min(3, meaningful.length || 0))
  const agentPicks = pickTopByScore(agentScored, 1)
  const beats = userPicks.map((x) => trim(x.text, 60)).filter(Boolean)
  const reply = agentPicks.length ? trim(agentPicks[0].text, 80) : ''

  // 只从有效句抽主题；全噪声时不要把 Approval / URL 碎片拼成标题
  const topics = topicsOf(meaningful)
  const open = meaningful
    .filter((t) => /[?？]|(吗|呢|怎么办|要不要)$/.test(String(t).trim()))
    .slice(-3)
    .map((t) => trim(t, 40))

  // 标题：最高分短句 → 最高分首分句 → 主题 → 我的回复（有效句才回落）
  const titleCand = [...userPicks].sort((a, b) => b.score - a.score)[0]
  let title = '（无正文）'
  if (titleCand) {
    const s = titleCand.text.trim()
    title = (s.length >= 4 && s.length <= 40 ? trim(s, 24) : firstClause(s, 24)) || title
  }
  if (title === '（无正文）' && meaningful.length) {
    title = trim(topics.slice(0, 2).join('·'), 24) || firstClause(reply, 24) || '（无正文）'
  }

  const parts = []
  if (beats.length) parts.push('对方：' + beats.join('；'))
  if (reply) parts.push('我：' + reply)
  if (open[0]) parts.push('未了：' + open[0])
  const summary = parts.length
    ? trim(parts.join('。') + '。', 220)
    : '（几乎是噪声，没什么可记）'

  // importance：寒暄低、未闭环+有效长对话高
  let importance = 0.28
  const greetN = meaningful.filter((t) => isGreetingOnly(t)).length
  const signalN = meaningful.length - greetN
  importance += Math.min(0.28, signalN * 0.035)
  importance += Math.min(0.18, open.length * 0.06)
  importance += Math.min(0.12, beats.length * 0.04)
  if (signalN >= 5) importance += 0.06
  if (!meaningful.length) importance = 0.12
  else if (signalN === 0 && greetN > 0) importance = Math.min(importance, 0.22)
  if (opt.importance != null && Number.isFinite(Number(opt.importance))) importance = Number(opt.importance)
  importance = Math.max(0.1, Math.min(0.92, Math.round(importance * 100) / 100))

  return {
    title,
    summary,
    beats,
    reply,
    topics,
    open_loops: open,
    importance,
    kept,
    dropped,
  }
}

function upsertEpisodeRow(db, aid, row) {
  const old = db.prepare(
    'SELECT id,importance,summary,source FROM episodes WHERE agent_id=? AND session_id IS ? AND day=? AND seg=?',
  ).get(aid, row.session_id, row.day, row.seg)
  if (old) {
    // L0 重算可刷结构字段；若已有 L1 精修稿（source=model），保留 summary/source，避免夜巡/force 把金标打回规则稿
    const keepModel = String(old.source || '') === 'model' && String(row.source || 'rules') === 'rules'
      && String(old.summary || '').trim().length >= 24
    const summary = keepModel ? old.summary : row.summary
    const source = keepModel ? old.source : row.source
    db.prepare(`UPDATE episodes SET start_at=?, end_at=?, turns=?, title=?, summary=?, topics=?, beats=?,
        open_loops=?, importance=?, source=? WHERE id=?`).run(
      row.start_at, row.end_at, row.turns, row.title, summary, row.topics, row.beats,
      row.open_loops, Math.max(Number(old.importance || 0), row.importance), source, old.id,
    )
    return { ...row, id: old.id, summary, source, updated: true, kept_model: keepModel }
  }
  const id = nid('ep_')
  db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,seg,start_at,end_at,turns,title,summary,topics,beats,open_loops,importance,source,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, aid, row.session_id, row.day, row.seg, row.start_at, row.end_at, row.turns,
    row.title, row.summary, row.topics, row.beats, row.open_loops, row.importance, row.source, now(),
  )
  return { ...row, id, updated: false }
}

/**
 * 按会话（+天）重算全部切段纪要。会删掉多余的旧 seg。
 * @returns {object[]}
 */
export function buildEpisodes(db, aid, opt = {}) {
  const day = opt.day ? String(opt.day) : null
  const sessionId = opt.session != null ? String(opt.session) : null
  if (!day && sessionId == null) throw new Error('buildEpisode 需要 day 或 session')
  const where = ['agent_id=?']
  const args = [aid]
  if (day) { where.push('day=?'); args.push(day) }
  if (sessionId != null) { where.push('session_id=?'); args.push(sessionId) }
  const rows = db.prepare(`SELECT * FROM raw_turns WHERE ${where.join(' AND ')} ORDER BY created_at, seq`).all(...args)
  if (!rows.length) return []

  const dayKey = day || dayOf(rows[rows.length - 1].created_at)
  const segs = segmentTurns(rows, opt)
  const out = []
  for (let i = 0; i < segs.length; i++) {
    const segRows = segs[i]
    const fields = composeEpisodeFields(segRows, opt)
    const ep = upsertEpisodeRow(db, aid, {
      session_id: sessionId != null ? sessionId : segRows[0].session_id,
      day: dayKey,
      seg: i,
      start_at: segRows[0].created_at,
      end_at: segRows[segRows.length - 1].created_at,
      turns: segRows.length,
      title: fields.title,
      summary: fields.summary,
      topics: JSON.stringify(fields.topics),
      beats: JSON.stringify(fields.beats),
      open_loops: JSON.stringify(fields.open_loops),
      importance: fields.importance,
      source: opt.source || 'rules',
      kept: fields.kept,
      dropped: fields.dropped,
      beats_list: fields.beats,
      reply: fields.reply,
    })
    out.push(ep)
  }
  // 砍掉本会话本日多出来的旧段
  try {
    db.prepare('DELETE FROM episodes WHERE agent_id=? AND session_id IS ? AND day=? AND seg>=?')
      .run(aid, sessionId != null ? sessionId : rows[0].session_id, dayKey, segs.length)
  } catch { /* 老库无 seg 时上面迁移应已补 */ }
  return out
}

/** 兼容旧调用：返回第一段，并挂 all/count。 */
export function buildEpisode(db, aid, opt = {}) {
  const all = buildEpisodes(db, aid, opt)
  if (!all.length) return null
  return {
    ...all[0],
    all,
    count: all.length,
    updated: all.some((x) => x.updated),
    kept: all.reduce((n, x) => n + (x.kept || 0), 0),
    dropped: all.reduce((n, x) => n + (x.dropped || 0), 0),
  }
}

export function listEpisodes(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(200, Number(opt.limit) || 30))
  const where = ['agent_id=?']
  const args = [aid]
  if (opt.day) { where.push('day=?'); args.push(String(opt.day)) }
  args.push(limit)
  return db.prepare(`SELECT * FROM episodes WHERE ${where.join(' AND ')} ORDER BY day DESC, end_at DESC, seg ASC LIMIT ?`)
    .all(...args).map((r) => ({
      ...r,
      topics: safeJson(r.topics, []),
      open_loops: safeJson(r.open_loops, []),
      beats: safeJson(r.beats, []),
    }))
}

function safeJson(text, fallback) {
  try { const v = JSON.parse(text || 'null'); return v ?? fallback } catch { return fallback }
}

// ---------------- E2 L1 金标精修 / E3 L2 簇修 ----------------

export function shouldRefineEpisode(ep, opt = {}) {
  const theta = opt.theta != null ? Number(opt.theta) : 0.55
  const minTurns = opt.minTurns != null ? Number(opt.minTurns) : 8
  const imp = Number(ep?.importance || 0)
  const turns = Number(ep?.turns || 0)
  const opens = Array.isArray(ep?.open_loops) ? ep.open_loops : safeJson(ep?.open_loops, [])
  if (imp >= theta) return true
  if (turns >= minTurns) return true
  if (opens.length && turns >= Math.max(4, Math.floor(minTurns / 2))) return true
  return false
}

function refineCapKey(aid, day) {
  return 'ep.refine.cap:' + aid + ':' + String(day || '').slice(0, 10)
}

function readRefineCount(db, aid, day) {
  try { return Math.max(0, Number(getFlag(db, refineCapKey(aid, day)) || 0) || 0) } catch { return 0 }
}

function bumpRefineCount(db, aid, day) {
  const n = readRefineCount(db, aid, day) + 1
  try { setFlag(db, refineCapKey(aid, day), String(n)) } catch { /* ignore */ }
  return n
}

export function sampleRawForRefine(db, aid, ep, limit = 12) {
  let rows = []
  try {
    rows = db.prepare(`SELECT role,text,created_at,seq FROM raw_turns
      WHERE agent_id=? AND day=? AND session_id IS ?
        AND created_at>=? AND created_at<=?
      ORDER BY created_at, seq`).all(
      aid, ep.day, ep.session_id, ep.start_at || '1970', ep.end_at || '9999',
    )
  } catch { rows = [] }
  if (!rows.length) {
    try {
      rows = db.prepare(`SELECT role,text,created_at,seq FROM raw_turns
        WHERE agent_id=? AND day=? AND session_id IS ? ORDER BY created_at, seq LIMIT 80`)
        .all(aid, ep.day, ep.session_id)
    } catch { rows = [] }
  }
  const scored = rows.map((r, i) => ({
    ...r, i, score: scoreTurn(r.text, r.role, i, rows.length),
  })).filter((r) => r.score > 0)
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  const top = scored.slice(0, limit).sort((a, b) => a.i - b.i)
  return top.map((r) => ({
    who: r.role === 'user' ? '对方' : '我',
    text: trim(r.text, 100),
  }))
}

function normalizeRefineText(raw) {
  let t = String(raw || '').trim()
  if (!t) return ''
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  if (/^\{[\s\S]*\}$/.test(t)) {
    try {
      const o = JSON.parse(t)
      const v = o.summary || o.text || o.episode
      if (typeof v === 'string') t = v.trim()
    } catch { /* keep */ }
  }
  t = t.replace(/^(?:纪要|摘要|正文)\s*[:：]\s*/, '')
  t = t.replace(/\n{3,}/g, '\n\n').trim()
  if (isPromptEcho(t)) return ''
  if ([...t].length < 24) return ''
  return trim(t.replace(/\s+/g, ' '), 220)
}

/**
 * 精修一条纪要。失败不改库（保留 L0）。
 * @returns {Promise<{ok:boolean, reason?:string, episode?:object}>}
 */
export async function refineEpisode(db, aid, ep, summarize, opt = {}) {
  if (typeof summarize !== 'function') return { ok: false, reason: 'no_model' }
  if (!ep || !ep.id) return { ok: false, reason: 'no_episode' }
  const row = typeof ep.open_loops === 'string' || typeof ep.beats === 'string'
    ? {
      ...ep,
      open_loops: safeJson(ep.open_loops, []),
      beats: safeJson(ep.beats, []),
      topics: safeJson(ep.topics, []),
    }
    : ep
  if (!shouldRefineEpisode(row, opt)) return { ok: false, reason: 'not_eligible' }

  const day = String(row.day || '').slice(0, 10)
  const cap = Math.max(0, Number(opt.dailyCap != null ? opt.dailyCap : 8) || 0)
  if (cap > 0 && readRefineCount(db, aid, day) >= cap) return { ok: false, reason: 'cap' }
  if (!llmBudgetAllow(db, aid, day, 1).ok) return { ok: false, reason: 'llm_budget' }

  const samples = sampleRawForRefine(db, aid, row, 12)
  const material = {
    title: row.title,
    beats: row.beats || [],
    reply: row.reply || null,
    open_loops: row.open_loops || [],
    samples,
  }
  let out = ''
  try {
    out = await summarize([
      {
        role: 'system',
        text: [
          '你在整理一段对话纪要。只写 2 到 3 句中文，说清这段在谈什么、对方要什么、还有没有没了结的事。',
          '只根据材料，不编造；不要 Markdown、不要标题、不要「用户/材料/system」字样。',
        ].join('\n'),
      },
      { role: 'user', text: '材料：\n' + JSON.stringify(material) },
    ])
  } catch (e) {
    return { ok: false, reason: 'thrown:' + String((e && e.message) || e).slice(0, 60) }
  }
  const clean = normalizeRefineText(out)
  if (!clean) return { ok: false, reason: 'rejected' }

  db.prepare(`UPDATE episodes SET summary=?, source=? WHERE id=? AND agent_id=?`)
    .run(clean, 'model', row.id, aid)
  if (cap > 0) bumpRefineCount(db, aid, day)
  try { llmBudgetBump(db, aid, 'refine', day, 1) } catch { /* ignore */ }
  const updated = db.prepare('SELECT * FROM episodes WHERE id=?').get(row.id)
  return {
    ok: true,
    episode: updated
      ? { ...updated, topics: safeJson(updated.topics, []), open_loops: safeJson(updated.open_loops, []), beats: safeJson(updated.beats, []) }
      : { ...row, summary: clean, source: 'model' },
  }
}

/**
 * 巩固日：按 importance 挑候选精修，受日限额约束。
 */
export async function refineEpisodesForDay(db, aid, day, summarize, opt = {}) {
  const d = String(day || '').slice(0, 10)
  let enabled = true
  try {
    enabled = String(getParam(db, aid, 'memory.episode.refine') || 'on') !== 'off'
  } catch { enabled = true }
  if (opt.enabled === false || opt.enabled === 'off') enabled = false
  if (opt.enabled === true || opt.enabled === 'on') enabled = true
  if (!enabled) return { ok: true, skipped: true, reason: 'off', refined: 0, failed: 0 }
  if (typeof summarize !== 'function') return { ok: true, skipped: true, reason: 'no_model', refined: 0, failed: 0 }

  const theta = Number(opt.theta != null ? opt.theta : (getParam(db, aid, 'memory.episode.refine.theta') ?? 0.55))
  const minTurns = Number(opt.minTurns != null ? opt.minTurns : (getParam(db, aid, 'memory.episode.refine.min_turns') ?? 8))
  const dailyCap = Number(opt.dailyCap != null ? opt.dailyCap : (getParam(db, aid, 'memory.episode.refine.daily_cap') ?? 8))
  const refineOpt = { theta, minTurns, dailyCap }

  const eps = listEpisodes(db, aid, { day: d, limit: 80 })
    .filter((e) => shouldRefineEpisode(e, refineOpt))
    .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))

  let refined = 0
  let failed = 0
  const reasons = []
  for (const ep of eps) {
    if (dailyCap > 0 && readRefineCount(db, aid, d) >= dailyCap) {
      reasons.push('cap')
      break
    }
    const r = await refineEpisode(db, aid, ep, summarize, refineOpt)
    if (r.ok) refined++
    else {
      failed++
      if (r.reason) reasons.push(r.reason)
    }
  }
  return { ok: true, refined, failed, candidates: eps.length, reasons: reasons.slice(0, 8) }
}

function splitClusters(eps, k) {
  const n = eps.length
  const clusters = Array.from({ length: k }, () => [])
  const sorted = [...eps].sort((a, b) => String(a.end_at || a.start_at || '').localeCompare(String(b.end_at || b.start_at || '')))
  for (let i = 0; i < n; i++) clusters[Math.min(k - 1, Math.floor((i * k) / n))].push(sorted[i])
  return clusters.filter((c) => c.length)
}

/**
 * L2：忙天把多条纪要收成 3～5 个时段要点（一天最多一次模型）。
 * @returns {Promise<{ok:boolean, chapters?:object[], skipped?:boolean, reason?:string}>}
 */
export async function clusterRefineForDay(db, aid, day, summarize, opt = {}) {
  const d = String(day || '').slice(0, 10)
  let threshold = 12
  try {
    const v = getParam(db, aid, 'memory.episode.cluster_at')
    if (v != null && Number.isFinite(Number(v))) threshold = Math.max(0, Number(v))
  } catch { /* default */ }
  if (opt.clusterAt != null && Number.isFinite(Number(opt.clusterAt))) threshold = Math.max(0, Number(opt.clusterAt))
  if (threshold <= 0) return { ok: true, skipped: true, reason: 'off' }

  const eps = listEpisodes(db, aid, { day: d, limit: 80 })
    .filter((e) => String(e.session_id || '') !== '__day_cluster__')
  if (eps.length <= threshold) return { ok: true, skipped: true, reason: 'few', count: eps.length }

  if (typeof summarize !== 'function') return { ok: true, skipped: true, reason: 'no_model', count: eps.length }
  if (!llmBudgetAllow(db, aid, d, 1).ok) return { ok: true, skipped: true, reason: 'llm_budget', count: eps.length }

  const k = Math.min(5, Math.max(3, Math.ceil(eps.length / 4)))
  const clusters = splitClusters(eps, k)
  const material = clusters.map((c, i) => ({
    i: i + 1,
    n: c.length,
    titles: c.slice(0, 6).map((e) => e.title).filter(Boolean),
    notes: c.slice(0, 4).map((e) => trim(e.summary, 80)).filter(Boolean),
  }))

  let out = ''
  try {
    out = await summarize([
      {
        role: 'system',
        text: [
          '你把一天的多段纪要收成若干「时段要点」。',
          '只输出 JSON 数组，每项 {"title":"短标题","summary":"一两句"}，条数与材料段数一致。',
          '只根据材料，不编造；不要 Markdown。',
        ].join('\n'),
      },
      { role: 'user', text: '材料：\n' + JSON.stringify({ day: d, clusters: material }) },
    ])
  } catch (e) {
    return { ok: false, reason: 'thrown:' + String((e && e.message) || e).slice(0, 60) }
  }

  let parsed = null
  const raw = String(out || '').trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  try { parsed = JSON.parse(raw) } catch {
    const m = raw.match(/\[[\s\S]*\]/)
    if (m) try { parsed = JSON.parse(m[0]) } catch { parsed = null }
  }
  if (!Array.isArray(parsed) || !parsed.length) return { ok: false, reason: 'bad_json' }

  const chapters = parsed.slice(0, clusters.length).map((p, i) => ({
    title: trim(p.title || ('时段' + (i + 1)), 28),
    summary: trim(p.summary || p.text || '', 160),
    importance: 0.78,
    beats: [],
    open_loops: [],
    source: 'model',
    end_at: (clusters[i] && clusters[i][clusters[i].length - 1]?.end_at) || null,
  })).filter((c) => c.summary && !isPromptEcho(c.summary))

  if (!chapters.length) return { ok: false, reason: 'empty' }

  // 落库为特殊 session，方便列表看见；日记打包会优先吃它们
  try {
    db.prepare(`DELETE FROM episodes WHERE agent_id=? AND day=? AND session_id='__day_cluster__'`).run(aid, d)
  } catch { /* ignore */ }
  const at = now()
  chapters.forEach((ch, i) => {
    const id = nid('ep_')
    db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,seg,start_at,end_at,turns,title,summary,topics,beats,open_loops,importance,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, aid, '__day_cluster__', d, i, at, ch.end_at || at, 0,
      ch.title, ch.summary, '[]', '[]', '[]', ch.importance, 'model', at,
    )
  })
  try { llmBudgetBump(db, aid, 'cluster', d, 1) } catch { /* ignore */ }
  return { ok: true, chapters, clusters: clusters.length }
}

// ---------------------------------------------------------------- T3 日记

function weekday(day) {
  const t = Date.parse(day + 'T12:00:00Z')
  if (!Number.isFinite(t)) return ''
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(t).getUTCDay()]
}

/**
 * 写一天的日记。
 * 有模型就用模型写（summarize 回调），没有就按纪要和事实拼，**不编细节**。
 * @returns {Promise<object>} 落库的那一行
 */
/** 写日记那一刻，它是什么状态：性格五轴 / 价值观 / 情绪 / 驱力 / 关系。 */
export function diaryContext(db, aid) {
  const out = { axes: {}, values: [], affect: null, drive: null, relation: null }
  try {
    const persona = db.prepare('SELECT path,value FROM persona WHERE agent_id=?').all(aid)
    for (const p of persona) {
      if (p.path.startsWith('axis.')) out.axes[p.path.slice(5)] = Number(p.value)
    }
  } catch { /* 老库没有 persona */ }
  try {
    out.values = (readViews(db, aid).V.items || []).slice(0, 3).map((v) => ({ key: v.key, weight: Number(v.weight) }))
  } catch { out.values = [] }
  try {
    const a = db.prepare('SELECT primary_label,intensity,mood FROM affect_state WHERE agent_id=?').get(aid)
    if (a) out.affect = { label: a.primary_label, intensity: Number(a.intensity), mood: Number(a.mood) }
  } catch { out.affect = null }
  try {
    const d = db.prepare('SELECT band FROM drive_state WHERE agent_id=?').get(aid)
    if (d) out.drive = { band: d.band }
  } catch { out.drive = null }
  try {
    const r = db.prepare('SELECT name,closeness FROM relations WHERE agent_id=? ORDER BY root DESC, closeness DESC LIMIT 1').get(aid)
    if (r) out.relation = { name: r.name, closeness: Number(r.closeness) }
  } catch { out.relation = null }
  return out
}

/** 由状态推出「这一天的口吻」，模板与模型都用它。 */
export function diaryTone(ctx = {}) {
  const b = ctx.axes || {}
  const parts = []
  if (Number(b.sn) >= 0.6) parts.push('爱联想、会打比方')
  if (Number(b.ei) >= 0.6) parts.push('语气外放一点')
  if (Number(b.ei) < 0.4) parts.push('话少、克制')
  if (Number(b.tf) < 0.4) parts.push('语气温和')
  if (Number(b.sensitivity) >= 0.6) parts.push('情绪写得具体些')
  if (ctx.affect && Number(ctx.affect.intensity) >= 0.6) parts.push('情绪偏浓')
  if (ctx.drive && /D[01]/.test(String(ctx.drive.band))) parts.push('不铺开、收着写')
  return parts.length ? parts.join('、') : '平实、不夸张'
}

function diaryOpening(ctx) {
  const b = (ctx && ctx.axes) || {}
  if (Number(b.ei) < 0.4) return '今天没什么特别想说的，还是记两句。'
  if (Number(b.sensitivity) >= 0.6) return '今天心里有点乱，写下来会好受一点。'
  if (Number(b.sn) >= 0.6) return '今天脑子里飘过不少东西，挑几件记下。'
  return '今天过得还行，记几件。'
}

function sampleList(list, n) {
  const arr = Array.isArray(list) ? list : []
  if (arr.length <= n) return arr
  const out = []
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * (arr.length - 1) / (n - 1))])
  return out.filter((v, i) => i === 0 || v !== out[i - 1])
}

const AFFECT_ZH = {
  joy: '愉悦', peaceful: '安心', curious: '好奇', calm: '平静',
  confused: '困惑', lost: '失落', irritated: '烦躁', frustrated: '挫败',
  sad: '难过', angry: '生气', anxious: '紧张', tired: '疲惫',
  lonely: '孤单', hopeful: '期待', tender: '柔软', neutral: '平淡',
}

function affectLabelZh(label) {
  const k = String(label || '').trim()
  if (!k) return '说不上来'
  return AFFECT_ZH[k] || AFFECT_ZH[k.toLowerCase()] || k
}

/**
 * 日记日的心情：优先当天 affect_episodes，没有再退当前 affect_state。
 * @returns {{label:string, intensity:number, moodZh:string, mood_source:'day'|'live'|'none'}}
 */
export function diaryMoodForDay(db, aid, day) {
  const d = String(day || '').slice(0, 10)
  try {
    const row = db.prepare(`SELECT label, intensity FROM affect_episodes
      WHERE agent_id=? AND substr(started_at,1,10)=? AND label IS NOT NULL AND label<>''
      ORDER BY intensity DESC, started_at DESC LIMIT 1`).get(aid, d)
    if (row && row.label) {
      const intensity = Number(row.intensity)
      const safe = Number.isFinite(intensity) ? intensity : 0.5
      return {
        label: row.label,
        intensity: safe,
        moodZh: `${affectLabelZh(row.label)}，强度 ${safe.toFixed(2)}`,
        mood_source: 'day',
      }
    }
  } catch { /* 老库 */ }
  try {
    const a = db.prepare('SELECT primary_label,intensity FROM affect_state WHERE agent_id=?').get(aid)
    if (a && a.primary_label) {
      const intensity = Number(a.intensity)
      const safe = Number.isFinite(intensity) ? intensity : 0.5
      return {
        label: a.primary_label,
        intensity: safe,
        moodZh: `${affectLabelZh(a.primary_label)}，强度 ${safe.toFixed(2)}`,
        mood_source: 'live',
      }
    }
  } catch { /* ignore */ }
  return { label: '', intensity: 0, moodZh: '说不上来', mood_source: 'none' }
}

/** 超长正文尽量在句号/问叹号处截断，避免半句。 */
export function clipDiaryBody(text, max = 1600) {
  const s = String(text || '')
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const m = cut.match(/^[\s\S]*[。！？!?\n]/)
  if (m && m[0].length >= Math.floor(max * 0.55)) return m[0].replace(/\s+$/g, '')
  return cut
}

/** 模型偶尔会把提示词、JSON 材料整段抄回来；这种不算日记。 */
export function isPromptEcho(text) {
  const s = String(text || '').trim()
  if (!s) return true
  if (/^(system|user|assistant|developer)\s*[:：]/i.test(s)) return true
  if (/"(episodes|conversation|day|summary)"\s*:/.test(s)) return true
  if (/你在写这一天的日记|只写材料里出现|不要用 Markdown/.test(s)) return true
  return false
}

/**
 * 把模型输出整理成「日期头 + 正文」。
 * 日期头统一由我们补，模型写没写都不影响；正文去掉 Markdown 痕迹。
 */
export function normalizeDiaryText(text, day) {
  let t = String(text ?? '').trim()
  if (!t) return ''
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  if (/^\{[\s\S]*\}$/.test(t)) {
    try {
      const o = JSON.parse(t)
      const v = o.text ?? o.diary ?? o.content
      if (typeof v === 'string') t = v.trim()
    } catch { /* 不是 JSON，按正文处理 */ }
  }
  t = t.replace(/^(?:日记正文|日记|正文|标题)\s*[:：]\s*/, '')
  const lines = t.split(/\r?\n/)
  while (lines.length) {
    const first = lines[0].trim()
    if (!first) { lines.shift(); continue }
    if (/^#{1,6}\s*/.test(first)) { lines.shift(); continue }
    if (/^\d{4}\s*[年\-/.]\s*\d{1,2}/.test(first)) { lines.shift(); break }
    break
  }
  const body = lines.join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[*\-+]\s+/gm, '')
    .trim()
  if (!body) return ''
  const d = String(day || '')
  return (d ? `${d} ${weekday(d)}\n\n` : '') + body
}

function bodyLength(text) {
  return String(text || '').replace(/^\d{4}-\d{2}-\d{2}[^\n]*\n+/, '').trim().length
}

/** 日记材料字符预算：低于宿主模型 summarize 的 slice(8000)，留余量给 system。 */
export const DIARY_MATERIAL_BUDGET = 5500

function jsonSize(obj) {
  return JSON.stringify(obj).length
}

/** 日记默认不吃的纪要下限（与 PARAM 默认对齐；打包纯函数可显式传入）。 */
export const DIARY_MIN_EPISODE_IMPORTANCE = 0.25

/**
 * 预算打包：只装完整块，永不砍半截 JSON。
 * 优先级：口吻骨架 →（有簇时）簇+精修 → 按比例补 L0 → 事实 → 原文点缀。
 * minImportance：低于此分的纪要默认跳过；若全被跳过则回退 Top3，避免日记空壳。
 * preferCluster：有 __day_cluster__ 时主吃簇+model；L0 最多占 l0FillRatio 预算。
 */
export function packDiaryMaterial(input = {}, budget = DIARY_MATERIAL_BUDGET) {
  const d = String(input.day || '')
  const otherName = input.otherName || '你'
  const moodZh = input.moodZh || '说不上来'
  const tone = input.tone || '平实、不夸张'
  const minImp = input.minImportance == null
    ? DIARY_MIN_EPISODE_IMPORTANCE
    : Math.max(0, Math.min(1, Number(input.minImportance) || 0))
  const preferCluster = !(input.preferCluster === false || input.preferCluster === 'off' || input.preferCluster === 0)
  const l0FillRatio = Math.max(0, Math.min(1, Number(input.l0FillRatio != null ? input.l0FillRatio : 0.45) || 0))
  const epsIn = Array.isArray(input.episodes) ? [...input.episodes] : []
  const factsIn = Array.isArray(input.facts) ? [...input.facts] : []
  const rawIn = Array.isArray(input.raw) ? input.raw : []

  const isCluster = (e) => String(e.session_id || '') === '__day_cluster__'
  const isModelEp = (e) => e.source === 'model' || isCluster(e)
  const rankEp = (e) => {
    const cluster = isCluster(e) ? 2 : 0
    const model = e.source === 'model' ? 1 : 0
    return cluster * 10 + model + Number(e.importance || 0)
  }
  epsIn.sort((a, b) => rankEp(b) - rankEp(a)
    || String(b.end_at || '').localeCompare(String(a.end_at || '')))
  factsIn.sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))

  let pool = minImp > 0
    ? epsIn.filter((e) => Number(e.importance || 0) >= minImp || isCluster(e) || e.source === 'model')
    : epsIn
  const skippedLow = epsIn.length - pool.length
  let fallbackLow = false
  if (!pool.length && epsIn.length) {
    pool = epsIn.slice(0, 3)
    fallbackLow = true
  }

  const hasCluster = pool.some(isCluster)
  const usePrefer = preferCluster && hasCluster && !fallbackLow
  const primary = usePrefer ? pool.filter(isModelEp) : pool
  const secondary = usePrefer ? pool.filter((e) => !isModelEp(e)) : []

  const base = {
    day: d,
    date: input.date || d,
    episodes: [],
    facts: [],
    conversation: [],
    mood: moodZh,
    self: input.self || {},
    tone,
  }
  let size = jsonSize(base)
  const meta = {
    budget,
    min_importance: minImp,
    skipped_low: skippedLow,
    fallback_low: fallbackLow,
    prefer_cluster: usePrefer,
    l0_fill_ratio: l0FillRatio,
    dropped_episodes: 0,
    dropped_facts: 0,
    raw_used: 0,
    n_cluster: 0,
    n_model: 0,
    n_rules: 0,
    chars: 0,
  }

  const tryAdd = (key, item) => {
    const next = { ...base, [key]: [...base[key], item] }
    const n = jsonSize(next)
    if (n > budget) return false
    base[key].push(item)
    size = n
    return true
  }

  const epItem = (e) => {
    const beats = Array.isArray(e.beats) ? e.beats : safeJson(e.beats, [])
    const fromModel = isModelEp(e)
    return {
      title: trim(e.title, 28),
      summary: fromModel
        ? trim(e.summary, 160)
        : (beats.length
          ? trim('对方：' + beats.slice(0, 3).map((b) => trim(b, 40)).join('；'), 120)
          : trim(e.summary, 120)),
      open_loops: (e.open_loops || []).slice(0, 2).map((x) => trim(x, 36)),
      _kind: isCluster(e) ? 'cluster' : (e.source === 'model' ? 'model' : 'rules'),
    }
  }

  const addEp = (e) => {
    const item = epItem(e)
    const kind = item._kind
    delete item._kind
    if (!tryAdd('episodes', item)) { meta.dropped_episodes++; return false }
    if (kind === 'cluster') meta.n_cluster++
    else if (kind === 'model') meta.n_model++
    else meta.n_rules++
    return true
  }

  for (const e of primary) addEp(e)

  if (secondary.length) {
    const sizeAfterPrimary = size
    const l0Budget = Math.floor(budget * l0FillRatio)
    // 主料已经很满（≥55% 预算）时少补 L0；否则按 l0_fill_ratio 限额补
    const allowL0 = sizeAfterPrimary < Math.floor(budget * 0.55)
    if (allowL0 && l0Budget > 0) {
      let l0Used = 0
      for (const e of secondary) {
        if (l0Used >= l0Budget) { meta.dropped_episodes++; continue }
        const before = size
        if (!addEp(e)) continue
        l0Used += Math.max(0, size - before)
      }
    } else {
      meta.dropped_episodes += secondary.length
    }
  }

  for (const f of factsIn.slice(0, 8)) {
    const item = trim(f.text, 60)
    if (!item) continue
    if (!tryAdd('facts', item)) { meta.dropped_facts++; break }
  }

  if (base.episodes.length < 4) {
    const cleanRaw = rawIn.filter((r) => {
      const t = String(r.text || '').trim()
      return t.length >= 2 && !isEpisodeNoise(t)
    })
    const picked = sampleList(cleanRaw, Math.min(10, cleanRaw.length))
      .map((r) => ({ who: r.role === 'user' ? otherName : '我', text: trim(r.text, 80) }))
    for (const c of picked) {
      if (!tryAdd('conversation', c)) break
      meta.raw_used++
    }
  }

  meta.chars = size
  return { material: base, meta }
}

function diarySelfLine(self = {}) {
  const parts = []
  const vals = Array.isArray(self.values) ? self.values.slice(0, 2).map((v) => v.key).filter(Boolean) : []
  if (vals.length) parts.push('最近看重：' + vals.join('、'))
  if (self.relation && self.relation.name) parts.push('主要在跟「' + self.relation.name + '」说话')
  if (self.drive && self.drive.band) parts.push('驱力档 ' + self.drive.band)
  return parts.length ? parts.join('；') : ''
}

function diarySystemPrompt(name, material, tone, moodZh) {
  const selfLine = diarySelfLine(material.self || {})
  return [
    `你是「${name}」，一个有记忆、有情绪的意识体。现在你在写 ${material.date} 这一天的日记。`,
    '',
    '写法：',
    '1. 第一行只写日期，格式「2026年10月28日 周三」，空一行，然后写 3 到 5 段连续的中文散文，全文 200-400 字。',
    '2. 像一个普通人晚上随手记日记：写今天具体发生了什么、当时心里怎么想、有什么感觉。可以有细节、有一两句自嘲或判断，但不要写成工作汇报、总结或流水账。',
    '3. 只写材料里出现的人和事，不要编造天气、地点、对话或数字；材料没提的就略过。',
    '4. 不要用 Markdown：不要 #、*、-、编号、列表、加粗，也不要小标题。不要出现「用户」「对方」「材料」「system」「assistant」这些词；称呼材料里的另一个人时，用材料里的名字或直接说「你」。不要解释你是怎么写的。',
    '5. 不要每段都用「今天」开头，不要用「总的来说」「由此可见」这种总结腔；句子长短错开，像在说话。',
    `6. 你的口吻：${tone}。写的时候你的心情是「${moodZh}」，这会决定你挑哪些事写、写多深。`,
    selfLine ? `7. 轻带一点自己的状态（不要展开成说明书）：${selfLine}。` : '7. 不要扩写材料里没有的自我设定。',
    '8. 结尾停在一个具体的念头、画面或一句轻的话上，不要总结全文，不要喊口号。',
  ].join('\n')
}

async function tryModelDiary(summarize, name, material, tone, moodZh, day) {
  const out = await summarize([
    { role: 'system', text: diarySystemPrompt(name, material, tone, moodZh) },
    { role: 'user', text: '材料：\n' + JSON.stringify(material) },
  ])
  const clean = normalizeDiaryText(out, day)
  if (!clean) return { ok: false, reason: 'empty' }
  if (isPromptEcho(clean)) return { ok: false, reason: 'echo' }
  if (bodyLength(clean) < 80) return { ok: false, reason: 'too_short' }
  return { ok: true, text: clipDiaryBody(clean, 1600) }
}

export async function buildDiary(db, aid, day, opt = {}) {
  const d = String(day || dayOf(now()))
  // 多取一些；簇修(__day_cluster__)与精修稿优先进入打包排序
  let eps = listEpisodes(db, aid, { day: d, limit: 80 })
  if (Array.isArray(opt.chapters) && opt.chapters.length) {
    eps = [
      ...opt.chapters.map((c, i) => ({
        title: c.title, summary: c.summary, importance: Number(c.importance) || 0.78,
        beats: c.beats || [], open_loops: c.open_loops || [], source: 'model',
        session_id: '__day_cluster__', end_at: c.end_at || null, seg: i,
      })),
      ...eps.filter((e) => String(e.session_id || '') !== '__day_cluster__'),
    ]
  }
  const facts = db.prepare(`SELECT id,text,type,importance FROM memory_items
    WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND substr(created_at,1,10)=?
    ORDER BY importance DESC, created_at LIMIT 12`).all(aid, d)
  let raw = []
  try {
    raw = db.prepare(`SELECT role,text FROM raw_turns
      WHERE agent_id=? AND day=? AND role IN ('user','assistant')
      ORDER BY created_at, seq`).all(aid, d)
  } catch { raw = [] }
  const rawCount = raw.length || Number(db.prepare('SELECT COUNT(*) n FROM raw_turns WHERE agent_id=? AND day=?').get(aid, d).n)
  if (!eps.length && !facts.length && !rawCount) return null

  const ctx = diaryContext(db, aid)
  const tone = diaryTone(ctx)
  const name = (db.prepare('SELECT name FROM agents WHERE id=?').get(aid) || {}).name || '我'

  const moodInfo = diaryMoodForDay(db, aid, d)
  const mood = moodInfo.label ? `${moodInfo.label} ${Number(moodInfo.intensity).toFixed(2)}` : null
  const moodZh = moodInfo.moodZh || '说不上来'
  if (moodInfo.mood_source === 'day' && moodInfo.label) {
    ctx.affect = { label: moodInfo.label, intensity: moodInfo.intensity, mood: ctx.affect?.mood }
  }

  let minImp = DIARY_MIN_EPISODE_IMPORTANCE
  try {
    const v = getParam(db, aid, 'memory.episode.min_diary_importance')
    if (v != null && Number.isFinite(Number(v))) minImp = Math.max(0, Math.min(1, Number(v)))
  } catch { /* 参数目录未挂时用默认 */ }
  if (opt.minImportance != null && Number.isFinite(Number(opt.minImportance))) {
    minImp = Math.max(0, Math.min(1, Number(opt.minImportance)))
  }

  let preferCluster = true
  try {
    preferCluster = String(getParam(db, aid, 'memory.diary.prefer_cluster') || 'on') !== 'off'
  } catch { preferCluster = true }
  if (opt.preferCluster === false || opt.preferCluster === 'off') preferCluster = false
  if (opt.preferCluster === true || opt.preferCluster === 'on') preferCluster = true

  let l0FillRatio = 0.45
  try {
    const v = getParam(db, aid, 'memory.diary.l0_fill_ratio')
    if (v != null && Number.isFinite(Number(v))) l0FillRatio = Math.max(0, Math.min(1, Number(v)))
  } catch { /* default */ }
  if (opt.l0FillRatio != null && Number.isFinite(Number(opt.l0FillRatio))) {
    l0FillRatio = Math.max(0, Math.min(1, Number(opt.l0FillRatio)))
  }

  const dateStr = `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日 ${weekday(d)}`
  const packInput = {
    day: d,
    date: dateStr,
    episodes: eps,
    facts,
    raw,
    otherName: ctx.relation?.name || '你',
    moodZh,
    tone,
    self: { values: ctx.values, drive: ctx.drive, relation: ctx.relation },
    minImportance: minImp,
    preferCluster,
    l0FillRatio,
  }
  const packed = packDiaryMaterial(packInput, Number(opt.budget) || DIARY_MATERIAL_BUDGET)
  const highlights = []
  for (const e of packed.material.episodes) if (e.title) highlights.push(e.title)
  for (const f of packed.material.facts) if (!highlights.includes(f)) highlights.push(trim(f, 40))

  let text = ''
  let source = 'rules'
  let failReason = null
  let packMeta = packed.meta

  if (typeof opt.summarize === 'function' && (eps.length || facts.length || raw.length)) {
    if (!llmBudgetAllow(db, aid, d, 1).ok) {
      failReason = 'llm_budget'
    } else {
      try {
        let attempt = await tryModelDiary(opt.summarize, name, packed.material, tone, moodZh, d)
        try { llmBudgetBump(db, aid, 'diary', d, 1) } catch { /* ignore */ }
        if (!attempt.ok) {
          // 缩包再试一次（半预算），对标行业：失败不丢、降载重试
          if (llmBudgetAllow(db, aid, d, 1).ok) {
            const half = packDiaryMaterial(packInput, Math.floor((Number(opt.budget) || DIARY_MATERIAL_BUDGET) / 2))
            packMeta = { ...half.meta, retry_of: attempt.reason }
            attempt = await tryModelDiary(opt.summarize, name, half.material, tone, moodZh, d)
            try { llmBudgetBump(db, aid, 'diary', d, 1) } catch { /* ignore */ }
            if (attempt.ok) {
              highlights.length = 0
              for (const e of half.material.episodes) if (e.title) highlights.push(e.title)
              for (const f of half.material.facts) if (!highlights.includes(f)) highlights.push(trim(f, 40))
            }
          }
        }
        if (attempt.ok) {
          text = attempt.text
          source = 'model'
        } else {
          failReason = attempt.reason || 'rejected'
        }
      } catch (e) {
        failReason = 'thrown:' + String((e && e.message) || e).slice(0, 80)
      }
    }
  } else if (typeof opt.summarize !== 'function') {
    failReason = 'no_model'
  }

  if (!text) {
    // 模板：优先用打包后的纪要标题，不编。
    const who = ctx.relation?.name || '你'
    const titles = packed.material.episodes.map((e) => trim(e.title, 26)).filter(Boolean)
    const paragraphs = []
    if (titles.length) {
      paragraphs.push(`今天和${who}聊了很多，一开始在说「${titles[0]}」${titles[1] ? `，后来话题又拐到「${titles[1]}」` : ''}。`)
    } else if (rawCount) {
      paragraphs.push(`今天和${who}说了 ${rawCount} 句话，零零碎碎的。`)
    } else {
      paragraphs.push(`今天没什么人说话，我把记得的事翻了翻。`)
    }
    const hs = highlights.map((h) => trim(h, 30)).filter(Boolean).slice(0, 4)
    if (hs.length) paragraphs.push(`中间有几件事我记得比较清楚：${hs.join('；')}。`)
    const open = packed.material.episodes.flatMap((e) => e.open_loops || []).filter(Boolean).slice(0, 2)
    if (open.length) paragraphs.push(`还有「${trim(open[0], 30)}」没弄完，先记在这儿。`)
    paragraphs.push(moodInfo.label
      ? `到收尾的时候，心里是${moodZh}。`
      : diaryOpening(ctx))
    text = [`${d} ${weekday(d)}`, '', paragraphs.filter(Boolean).join('\n\n')].join('\n').trim()
  }

  const refs = JSON.stringify({
    episodes: eps.map((e) => e.id).filter(Boolean),
    facts: facts.map((f) => f.id),
    raw_turns: rawCount,
    pack: packMeta,
  })
  const at = now()
  const late = Number(opt.late) === 1 ? 1 : 0
  const old = db.prepare('SELECT id,version FROM diaries WHERE agent_id=? AND day=?').get(aid, d)
  if (old && !opt.force) return { ...old, skipped: true }
  const version = old ? Number(old.version) + 1 : 1
  const id = old ? old.id : nid('dry_')
  const ctxOut = {
    ...ctx,
    write: {
      fail_reason: failReason,
      pack: packMeta,
      source,
      mood_source: moodInfo.mood_source,
    },
  }
  const ctxJson = JSON.stringify(ctxOut)
  db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,context,late,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,day) DO UPDATE SET text=excluded.text, mood=excluded.mood,
      highlights=excluded.highlights, refs=excluded.refs, source=excluded.source,
      version=excluded.version, context=excluded.context, late=excluded.late, updated_at=excluded.updated_at`)
    .run(id, aid, d, text, mood, JSON.stringify(highlights), refs, source, version, ctxJson, late, at, at)
  return {
    id, day: d, text, mood, source, version, late, highlights, context: ctxOut, tone,
    fail_reason: failReason, pack: packMeta, mood_source: moodInfo.mood_source,
  }
}

export function getDiary(db, aid, day) {
  const row = db.prepare('SELECT * FROM diaries WHERE agent_id=? AND day=?').get(aid, String(day))
  if (!row) return null
  return { ...row, highlights: safeJson(row.highlights, []), refs: safeJson(row.refs, {}), context: safeJson(row.context, null) }
}

/** 注入用：最近几天的日记，压成几行。 */
export function recentDiaryLines(db, aid, days = 3, maxChars = 200) {
  const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)
  const rows = db.prepare("SELECT day,text FROM diaries WHERE agent_id=? AND day>=? ORDER BY day DESC LIMIT ?")
    .all(aid, since, days)
  return rows.map((r) => `- ${r.day}：${trim(r.text.split('\n').slice(1).join(' '), maxChars)}`)
}
