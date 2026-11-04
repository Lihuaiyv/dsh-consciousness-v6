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
import { now } from '../db.js'
import { nid, getParam } from '../kernel.js'
import { foldValueWeights } from './sangguan/vweights.js'
import {
  weekday, diaryContext, diaryTone, diaryOpening, normalizeDiaryText, isPromptEcho, bodyLength,
  buildDiaryV2, diaryParams,
} from './diary.js'

export { weekday, diaryContext, diaryTone, normalizeDiaryText, isPromptEcho } from './diary.js'

const DAY_MS = 86400000

const STOP = new Set([
  '什么', '怎么', '怎样', '如何', '这个', '那个', '我们', '你们', '他们', '自己',
  '现在', '今天', '昨天', '明天', '可以', '应该', '需要', '因为', '所以', '但是',
  '不过', '如果', '还是', '就是', '不是', '已经', '正在', '一起', '一下', '一个',
  '觉得', '知道', '记得', '告诉', '帮忙', '事情', '东西', '问题', '地方', '这样',
  '那样', '真的', '一直', '最近', '其实', '然后', '而且', '或者', '虽然', '另外',
  '还有', '只是', '以及', '对于', '关于', '通过', '等等', '之类', '而已', '好的',
])

function dayOf(iso) { return String(iso || now()).slice(0, 10) }

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

/**
 * 给历史原话补 turn_id（一次性、可重复跑）。
 *
 * 以前的 turn_id 全是空的，所以「这条记忆是哪一轮说的」永远查不到。
 * 现在按 (session, seq) 把「user 后面紧跟的 assistant」配成同一轮；配不上的各自独立。
 * 只写 turn_id 这一列，不动正文、时间、seq。
 * @returns {number} 补了多少行
 */
export function backfillTurnIds(db, aid) {
  let rows = []
  try {
    rows = db.prepare(`SELECT id, session_id, seq, role, turn_id FROM raw_turns
      WHERE agent_id=? ORDER BY session_id, seq`).all(aid)
  } catch { return 0 }
  const upd = db.prepare('UPDATE raw_turns SET turn_id=? WHERE id=?')
  let n = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.turn_id) continue
    const tid = 'turn_bf_' + String(r.id).slice(-12)
    try { upd.run(tid, r.id); n++ } catch { continue }
    const nx = rows[i + 1]
    // 只有「同会话、seq 紧邻、user→assistant」才认成同一轮；别的一律各自独立
    if (nx && !nx.turn_id && nx.session_id === r.session_id && Number(nx.seq) === Number(r.seq) + 1
      && r.role === 'user' && nx.role === 'assistant') {
      try { upd.run(tid, nx.id); n++; i++ } catch { /* 单条失败跳过 */ }
    }
  }
  return n
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
    for (const d of days) buildEpisode(db, aid, { session: 'legacy', day: d.day })
  } catch { /* 纪要失败不影响原文 */ }
  try {
    db.prepare("INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, now())
  } catch { /* ignore */ }
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
      source_turn_id,source,created_at FROM fact_archive
    WHERE agent_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(aid, limit, offset)
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
    db.prepare("INSERT INTO memory_fts(id,text) SELECT id,text FROM memory_items WHERE status='active'").run()
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

// ---------------------------------------------------------------- T2 纪要

/** 取一段原文（会话或某天），压缩成一条纪要。 */
export function buildEpisode(db, aid, opt = {}) {
  const day = opt.day ? String(opt.day) : null
  const sessionId = opt.session ? String(opt.session) : null
  if (!day && !sessionId) throw new Error('buildEpisode 需要 day 或 session')
  const where = ['agent_id=?']
  const args = [aid]
  if (day) { where.push('day=?'); args.push(day) }
  if (sessionId) { where.push('session_id=?'); args.push(sessionId) }
  const rows = db.prepare(`SELECT * FROM raw_turns WHERE ${where.join(' AND ')} ORDER BY created_at, seq`).all(...args)
  if (!rows.length) return null

  const users = rows.filter((r) => r.role === 'user').map((r) => r.text)
  const agents = rows.filter((r) => r.role !== 'user')
  const lastAgent = agents.length ? agents[agents.length - 1].text : ''
  // meaningful 要先算出来：下面挑标题时会拿它兜底（早先写反了顺序，空标题时会直接抛错）
  const meaningful = users.filter((t) => !/^(Time sampled|Approval prompts|##|<|\{)/.test(String(t).trim()))
  // 标题挑一句像人说的话：跳过运行时模板、系统注入和超长粘贴。
  const titleSrc = users.find((t) => {
    const s = String(t).trim()
    return s.length >= 4 && s.length <= 40 && !/^(Time sampled|Approval prompts|##|\{|<)/.test(s)
  }) || meaningful[0] || ''
  const title = trim(titleSrc, 24) || topicsOf(meaningful).slice(0, 2).join('·') || trim(lastAgent, 24) || '（无正文）'
  const open = meaningful
    .filter((t) => /[?？]|(吗|呢|怎么办|要不要)$/.test(String(t).trim()))
    .slice(-3)
    .map((t) => trim(t, 40))
  const summary = [
    meaningful.length ? '你说了：' + trim(meaningful.slice(0, 3).join(' / '), 180) : '',
    lastAgent ? '我回了：' + trim(lastAgent, 180) : '',
  ].filter(Boolean).join(' ')

  const ep = {
    id: null,
    session_id: sessionId,
    day: day || dayOf(rows[rows.length - 1].created_at),
    start_at: rows[0].created_at,
    end_at: rows[rows.length - 1].created_at,
    turns: rows.length,
    title,
    summary,
    topics: JSON.stringify(topicsOf(meaningful.length ? meaningful : users)),
    open_loops: JSON.stringify(open),
    importance: Number(opt.importance ?? 0.5),
    source: opt.source || 'rules',
  }
  const old = db.prepare('SELECT id,importance FROM episodes WHERE agent_id=? AND session_id IS ? AND day=?')
    .get(aid, ep.session_id, ep.day)
  if (old) {
    db.prepare(`UPDATE episodes SET start_at=?, end_at=?, turns=?, title=?, summary=?, topics=?,
        open_loops=?, importance=?, source=? WHERE id=?`)
      .run(ep.start_at, ep.end_at, ep.turns, ep.title, ep.summary, ep.topics, ep.open_loops,
        Math.max(Number(old.importance || 0), ep.importance), ep.source, old.id)
    return { ...ep, id: old.id, updated: true }
  }
  ep.id = nid('ep_')
  db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,importance,source,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ep.id, aid, ep.session_id, ep.day, ep.start_at, ep.end_at, ep.turns, ep.title, ep.summary,
    ep.topics, ep.open_loops, ep.importance, ep.source, now(),
  )
  return ep
}

export function listEpisodes(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(200, Number(opt.limit) || 30))
  const where = ['agent_id=?']
  const args = [aid]
  if (opt.day) { where.push('day=?'); args.push(String(opt.day)) }
  args.push(limit)
  return db.prepare(`SELECT * FROM episodes WHERE ${where.join(' AND ')} ORDER BY day DESC, end_at DESC LIMIT ?`)
    .all(...args).map((r) => ({
      ...r,
      topics: safeJson(r.topics, []),
      open_loops: safeJson(r.open_loops, []),
    }))
}

function safeJson(text, fallback) {
  try { const v = JSON.parse(text || 'null'); return v ?? fallback } catch { return fallback }
}

/**
 * 会话开场续接：「上次你们聊到哪儿」。
 * 只取今天之前的纪要——同一天的事运行时上下文里本来就有，再说一遍是废话。
 * 没有纪要就返回空串（宁可不提，也别编一句）。
 */
export function sessionBridge(db, aid, opt = {}) {
  const at = opt.at || Date.now()
  const today = opt.today || dayOf(new Date(at).toISOString())
  try {
    const r = db.prepare(`SELECT day, title, summary, open_loops FROM episodes
      WHERE agent_id=? AND day<? AND summary IS NOT NULL AND summary<>''
      ORDER BY day DESC, end_at DESC LIMIT 1`).get(aid, String(today))
    if (!r) return ''
    const summary = String(r.summary).replace(/\s+/g, ' ').trim().slice(0, 70)
    if (!summary) return ''
    const loops = safeJson(r.open_loops, [])
      .map((x) => String(typeof x === 'string' ? x : (x && x.text) || '')).filter(Boolean)
    const tail = loops.length ? '；还没收尾的：' + loops.slice(0, 2).join('、').slice(0, 40) : ''
    return '上次（' + r.day + '）你们聊到：' + summary + tail
  } catch { return '' }
}


// ---------------------------------------------------------------- T3 日记
// v2 的选料/成文/待补在 ./diary.js；这里保留 v1（整包纪要 + 模板兜底）用于回滚对照。

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
}

/**
 * 写一天的日记（对外入口）。
 * v2（默认）：挑 1–2 个场景、拿原话成文；写不成进待补，不落模板。
 * v1：整包纪要 + 模板兜底。memory.diary.v2=off 或调用方明确要 v1 时走这条。
 */
export async function buildDiary(db, aid, day, opt = {}) {
  const useV1 = opt.v1 === true || !diaryParams(db, aid).v2
  if (useV1) return buildDiaryV1(db, aid, day, opt)
  return buildDiaryV2(db, aid, day, opt)
}

export async function buildDiaryV1(db, aid, day, opt = {}) {
  const d = String(day || dayOf(now()))
  const eps = listEpisodes(db, aid, { day: d, limit: 20 })
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

  const highlights = []
  for (const e of eps) if (e.title) highlights.push(e.title)
  for (const f of facts) if (!highlights.includes(f.text)) highlights.push(trim(f.text, 40))
  const moodRow = db.prepare("SELECT primary_label,intensity FROM affect_state WHERE agent_id=?").get(aid)
  const mood = moodRow ? `${moodRow.primary_label} ${Number(moodRow.intensity).toFixed(2)}` : null
  const moodZh = moodRow ? `${AFFECT_ZH[moodRow.primary_label] || moodRow.primary_label}，强度 ${Number(moodRow.intensity).toFixed(2)}` : '说不上来'

  let text = ''
  let source = 'rules'
  if (typeof opt.summarize === 'function' && (eps.length || facts.length || raw.length)) {
    try {
      // 原文是最具体的材料：只取一部分，按时间均匀抽样，别把一整天压成开头几分钟。
      const otherName = ctx.relation?.name || '你'
      const conversation = sampleList(raw.filter((r) => String(r.text || '').trim().length >= 2), 36)
        .map((r) => ({ who: r.role === 'user' ? otherName : '我', text: trim(r.text, 120) }))
      const material = {
        day: d,
        date: `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日 ${weekday(d)}`,
        episodes: eps.map((e) => ({
          title: e.title, summary: trim(e.summary, 500),
          topics: e.topics, open_loops: (e.open_loops || []).slice(0, 3),
        })),
        facts: facts.map((f) => f.text).slice(0, 10),
        conversation,
        mood: moodZh,
        self: { values: ctx.values, drive: ctx.drive, relation: ctx.relation },
        tone,
      }
      const out = await opt.summarize([
        {
          role: 'system',
          text: [
            `你是「${name}」，一个有记忆、有情绪的意识体。现在你在写 ${material.date} 这一天的日记。`,
            '',
            '写法：',
            '1. 第一行只写日期，格式「2026年10月28日 周三」，空一行，然后写 3 到 5 段连续的中文散文，全文 200-400 字。',
            '2. 像一个普通人晚上随手记日记：写今天具体发生了什么、当时心里怎么想、有什么感觉。可以有细节、有一两句自嘲或判断，但不要写成工作汇报、总结或流水账。',
            '3. 只写材料里出现的人和事，不要编造天气、地点、对话或数字；材料没提的就略过。',
            '4. 不要用 Markdown：不要 #、*、-、编号、列表、加粗，也不要小标题。不要出现「用户」「对方」「材料」「system」「assistant」这些词；称呼材料里的另一个人时，用材料里的名字或直接说「你」。不要解释你是怎么写的。',
            '5. 不要每段都用「今天」开头，不要用「总的来说」「由此可见」这种总结腔；句子长短错开，像在说话。',
            `6. 你的口吻：${tone}。写的时候你的心情是「${moodZh}」，这会决定你挑哪些事写、写多深。`,
            '7. 结尾停在一个具体的念头、画面或一句轻的话上，不要总结全文，不要喊口号。',
          ].join('\n'),
        },
        { role: 'user', text: '材料：\n' + JSON.stringify(material) },
      ])
      const clean = normalizeDiaryText(out, d)
      if (clean && !isPromptEcho(clean) && bodyLength(clean) >= 80) {
        text = clean.slice(0, 1600)
        source = 'model'
      }
    } catch { /* 模型失败退回模板 */ }
  }
  if (!text) {
    // 模板也要读起来像日记：只陈述材料里的事实，不编，不用字段名。
    const who = ctx.relation?.name || '你'
    const titles = eps.map((e) => trim(e.title, 26)).filter(Boolean)
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
    const open = eps.flatMap((e) => e.open_loops || []).filter(Boolean).slice(0, 2)
    if (open.length) paragraphs.push(`还有「${trim(open[0], 30)}」没弄完，先记在这儿。`)
    paragraphs.push(moodRow
      ? `到收尾的时候，心里是${moodZh}。`
      : diaryOpening(ctx))
    text = [`${d} ${weekday(d)}`, '', paragraphs.filter(Boolean).join('\n\n')].join('\n').trim()
  }

  const refs = JSON.stringify({
    episodes: eps.map((e) => e.id),
    facts: facts.map((f) => f.id),
    raw_turns: rawCount,
  })
  const at = now()
  const late = Number(opt.late) === 1 ? 1 : 0
  const old = db.prepare('SELECT id,version FROM diaries WHERE agent_id=? AND day=?').get(aid, d)
  if (old && !opt.force) return { ...old, skipped: true }
  const version = old ? Number(old.version) + 1 : 1
  const id = old ? old.id : nid('dry_')
  const ctxJson = JSON.stringify(ctx)
  db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,context,late,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,day) DO UPDATE SET text=excluded.text, mood=excluded.mood,
      highlights=excluded.highlights, refs=excluded.refs, source=excluded.source,
      version=excluded.version, context=excluded.context, late=excluded.late, updated_at=excluded.updated_at`)
    .run(id, aid, d, text, mood, JSON.stringify(highlights), refs, source, version, ctxJson, late, at, at)
  return { id, day: d, text, mood, source, version, late, highlights, context: ctx, tone }
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
