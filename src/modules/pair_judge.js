/**
 * 记忆对判定（窄门）：两条记忆是「同一件事的后续」还是「只是词撞车」。
 *
 * 为什么单独一个模块：
 *   写入门控（gate.js）和夜间整理（nightly.js）都要问同一个问题，但都**不该**
 *   直接依赖模型层；这里只接受一个注入的 complete 函数，其余全是纯逻辑。
 *
 * 四条硬约束（对应 docs/记忆时态-模型窄门-修改计划-2026-11-04.md）：
 *   D1 候选来自结构（同 key / 同主题 / 同轮 / 同段），相似度不决定「问不问」
 *   D3 四档：supersede / supplement / unrelated / uncertain
 *   D5 判过就缓存，同一对只判一次
 *   D6 失败永不冒充：模型不可用、超时、返回形状不对，一律 uncertain
 */

import crypto from 'node:crypto'
import { topicOfFactKey } from './passport.js'

export const VERDICTS = Object.freeze(['supersede', 'supplement', 'unrelated', 'uncertain'])

/** 模型提示词：只输出一个词。测试里直接断言它的内容。 */
export const JUDGE_SYS = [
  '你在判断两条记忆的关系。只输出四个词之一，不要解释，不要标点，不要 JSON：',
  '取代 —— 后一条让前一条不再是现状（值变了、做完了、改口了、否定了）',
  '补充 —— 还是同一个问题，后一条只是加了细节或进展，前一条不算错',
  '无关 —— 只是共用了一些词，说的不是同一个问题',
  '不确定 —— 拿不准',
  '',
  '注意：两条里出现同一个专有名词（库名、文件名、型号、功能名）不代表在说同一件事，看主语和动作。',
].join('\n')

// ── 专名抽取（D7 的输入）────────────────────────────────────

/** 这些词太常见，当专名只会误伤。 */
const STOP = new Set([
  'the', 'this', 'that', 'and', 'for', 'with', 'from', 'http', 'https', 'www', 'com',
  'json', 'mjs', 'cjs', 'js', 'ts', 'md', 'db', 'log', 'png', 'vue', 'css', 'html',
  'api', 'token', 'url', 'user', 'agent', 'memory', 'recall', 'retrieve', 'gate',
  'prompt', 'embed', 'cosine', 'key', 'text', 'date', 'time', 'node', 'test', 'index',
])

function addPropers(out, s) {
  const t = String(s || '').trim()
  if (!t || t.length < 2 || t.length > 60) return
  if (STOP.has(t.toLowerCase())) return
  out.add(t)
}

/**
 * 抽「显式专名」：反引号里的、英文标识符/驼峰、文件名、中文引号里的短词。
 * 刻意不抽普通中文词——那会把「用户」「记忆」也当专名，闸门就废了。
 */
export function propers(text) {
  const out = new Set()
  const s = String(text || '')
  for (const m of s.matchAll(/`([^`\n]{1,60})`/g)) addPropers(out, m[1])
  for (const m of s.matchAll(/[「『]([^」』\n]{1,16})[」』]/g)) addPropers(out, m[1])
  for (const m of s.matchAll(/《([^》\n]{1,16})》/g)) addPropers(out, m[1])
  for (const m of s.matchAll(/\b[A-Za-z][A-Za-z0-9_.-]{2,60}\b/g)) {
    const t = m[0]
    const lower = t.toLowerCase()
    if (STOP.has(lower)) continue
    // 纯小写普通英文词（不带 . _ - /、不是驼峰、不是已知技术词）不算专名
    const techy = /[_.\-\/]/.test(t) || /[a-z][A-Z]/.test(t) ||
      /(json|mjs|cjs|sqlite|sql|ollama|gemma|deepseek|qq|wechat|dsh|memory|recall|retrieve|gate|prompt|embed|cosine|token|api|url)/i.test(t)
    if (!techy) continue
    addPropers(out, t)
  }
  for (const m of s.matchAll(/\b[\w.-]+\.(json|mjs|cjs|js|md|db|log|png|ts|vue|py)\b/gi)) addPropers(out, m[0])
  return [...out].slice(0, 12)
}

export function sharedPropers(a, b) {
  const B = new Set(propers(b).map((x) => x.toLowerCase()))
  return propers(a).filter((x) => B.has(x.toLowerCase()))
}

function subjectOf(row) {
  const parts = String((row && row.fact_key) || '').split('.').map((s) => s.trim()).filter(Boolean)
  return parts[0] || ''
}

/**
 * 规则闸：共享专名、但主语/主题不同 → 直接「无关」，不花模型。
 * 兜的是实验里两回明确错误：同一个库名 / 同一个文件名被当成同一件事。
 */
export function ruleGate(oldRow, newerRow) {
  const shared = sharedPropers(oldRow && oldRow.text, newerRow && newerRow.text)
  if (!shared.length) return null
  const s1 = subjectOf(oldRow)
  const s2 = subjectOf(newerRow)
  if (s1 && s2 && s1 !== s2) return { verdict: 'unrelated', reason: 'subject:' + shared[0], confidence: 0.6 }
  const t1 = topicOfFactKey(oldRow && oldRow.fact_key)
  const t2 = topicOfFactKey(newerRow && newerRow.fact_key)
  if (t1 && t2 && t1 !== t2) return { verdict: 'unrelated', reason: 'topic:' + shared[0], confidence: 0.6 }
  return null
}

// ── 候选生成（D1）────────────────────────────────────────

/**
 * 给一条（通常是刚写入的）记忆找结构候选。
 * @returns {Array<{row:object, reason:'same_key'|'same_topic'|'same_turn'|'same_episode'}>}
 */
export function structureCandidates(db, aid, { newRow, limit = 8 } = {}) {
  if (!db || !newRow || !newRow.id) return []
  const out = new Map()
  const push = (row, reason) => {
    if (!row || row.id === newRow.id) return
    if (!out.has(row.id)) out.set(row.id, { row, reason })
  }
  const key = String(newRow.fact_key || '').trim()

  if (key) {
    // ① 同一个 fact_key（完全相等）
    try {
      const same = db.prepare(`SELECT * FROM memory_items
        WHERE agent_id=? AND fact_key=? AND id<>? AND status='active' AND invalid_at IS NULL
        ORDER BY created_at DESC LIMIT ?`).all(aid, key, newRow.id, Math.max(1, limit))
      for (const r of same) push(r, 'same_key')
    } catch { /* 老库异常不拦 */ }
    // ② 同一主题段（不是 LIKE 子串——LIKE 只是粗筛，JS 里再比 topicOfFactKey）
    const topic = topicOfFactKey(key)
    if (topic) {
      try {
        const rows = db.prepare(`SELECT * FROM memory_items
          WHERE agent_id=? AND id<>? AND status='active' AND invalid_at IS NULL
            AND fact_key IS NOT NULL AND fact_key LIKE ?
          ORDER BY created_at DESC LIMIT 40`).all(aid, newRow.id, '%' + topic + '%')
        for (const r of rows) if (topicOfFactKey(r.fact_key) === topic) push(r, 'same_topic')
      } catch { /* ignore */ }
    }
  }

  // ③ 同一轮说的（同一件事被拆成两条时，多半是补充）
  if (newRow.source_turn_id) {
    try {
      const rows = db.prepare(`SELECT * FROM memory_items
        WHERE agent_id=? AND source_turn_id=? AND id<>? AND status='active' AND invalid_at IS NULL
        ORDER BY created_at DESC LIMIT ?`).all(aid, newRow.source_turn_id, newRow.id, Math.max(1, limit))
      for (const r of rows) push(r, 'same_turn')
    } catch { /* ignore */ }
  }

  // ④ 同一段对话（fact_archive.payload.episode_id）
  try {
    const fa = db.prepare('SELECT payload FROM fact_archive WHERE agent_id=? AND memory_id=?').get(aid, newRow.id)
    if (fa && fa.payload) {
      const ep = JSON.parse(fa.payload).episode_id
      if (ep) {
        const rows = db.prepare(`SELECT m.* FROM memory_items m
          JOIN fact_archive f ON f.memory_id=m.id AND f.agent_id=m.agent_id
          WHERE m.agent_id=? AND m.id<>? AND m.status='active' AND m.invalid_at IS NULL
            AND f.payload LIKE ?
          ORDER BY m.created_at DESC LIMIT ?`).all(aid, newRow.id, '%' + String(ep).slice(0, 60) + '%', Math.max(1, limit))
        for (const r of rows) push(r, 'same_episode')
      }
    }
  } catch { /* 没这张表 / payload 坏了都不拦 */ }

  return [...out.values()]
    .sort((a, b) => String(b.row.created_at || '').localeCompare(String(a.row.created_at || '')))
    .slice(0, Math.max(1, limit))
}

// ── 缓存（D5）────────────────────────────────────────────

export function pairKey(aid, oldRow, newerRow) {
  const v = (r) => String((r && r.version) || 0)
  const raw = [aid, oldRow && oldRow.id, v(oldRow), newerRow && newerRow.id, v(newerRow)].join('\u0001')
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 32)
}

/** 读缓存。表不存在 / 坏行都返回 null。uncertain 默认 7 天后作废。 */
export function readJudgement(db, aid, key, { uncertainDays = 7, now = Date.now() } = {}) {
  try {
    const r = db.prepare('SELECT * FROM memory_pair_judge WHERE pair_key=?').get(key)
    if (!r) return null
    if (r.verdict === 'uncertain') {
      const t = Date.parse(String(r.judged_at || ''))
      if (!Number.isFinite(t) || now - t > Math.max(1, uncertainDays) * 86400000) return null
    }
    return r
  } catch { return null }
}

/** 写缓存。只写新表；表不存在就安静跳过（P1 阶段还没建表）。 */
export function writeJudgement(db, aid, rec = {}) {
  try {
    db.prepare(`INSERT OR REPLACE INTO memory_pair_judge
      (pair_key, agent_id, old_id, new_id, verdict, confidence, model, reason, judged_at, via, applied)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      rec.pair_key, aid, rec.old_id || '', rec.new_id || '',
      rec.verdict, rec.confidence == null ? null : Number(rec.confidence),
      rec.model == null ? null : String(rec.model).slice(0, 80),
      rec.reason == null ? null : String(rec.reason).slice(0, 200),
      rec.judged_at || new Date().toISOString(),
      rec.via || 'script', rec.applied ? 1 : 0,
    )
    return true
  } catch { return false }
}

// ── 判定（D3/D6）────────────────────────────────────────

function withTimeout(promise, ms) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('judge timeout'), { code: 'timeout' })), Math.max(1, Number(ms) || 3000))
    // 不 unref：unref 的定时器在事件循环里不算「还有事要做」，
    // 没有其它句柄时进程会直接退出，超时永远等不到（测试里真踩到了）。
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

/** 返回值是不是「像一句判断」——不是就说明模型没真跑（规则兜底假 JSON）。 */
export function looksLikeJudgement(raw) {
  if (typeof raw !== 'string') return false
  const t = raw.trim()
  if (!t || t.length > 160) return false
  if (/^[{[]/.test(t)) return false
  if (t.includes('overlap')) return false
  return /取代|补充|无关|不确定/.test(t)
}

/** 严格四档。出现两种以上（或一种都没有）都算不确定。 */
export function parseVerdict(raw) {
  const t = String(raw || '')
  const hit = []
  if (t.includes('不确定')) return 'uncertain'
  if (t.includes('取代')) hit.push('supersede')
  if (t.includes('补充')) hit.push('supplement')
  if (t.includes('无关')) hit.push('unrelated')
  return hit.length === 1 ? hit[0] : 'uncertain'
}

export function verdictAction(verdict) {
  if (verdict === 'supersede') return 'invalidate'
  if (verdict === 'supplement') return 'note'
  return 'none'
}

function dayOf(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? m[1] + '-' + m[2] + '-' + m[3] : ''
}

function buildUser(oldRow, newerRow) {
  const o = String(oldRow.text || '').replace(/\s+/g, ' ').slice(0, 200)
  const n = String(newerRow.text || '').replace(/\s+/g, ' ').slice(0, 200)
  return '旧（' + (dayOf(oldRow.created_at) || '未知日期') + '）：' + o
    + '\n新（' + (dayOf(newerRow.created_at) || '未知日期') + '）：' + n
}

export { dayOf as dayLabel, subjectOf }

/**
 * 判一对。永远 resolve，不抛。
 * @returns {Promise<{verdict:string, reason:string, cached:boolean, ms:number, model:string|null, confidence:number|null}>}
 */
export async function judgePair(opt = {}) {
  const { db, aid, oldRow, newerRow, complete, timeoutMs = 6000, via = 'script', skipRules = false, useCache = true, uncertainDays = 7 } = opt
  const t0 = Date.now()
  const fail = (reason, extra = {}) => ({ verdict: 'uncertain', reason, cached: false, ms: Date.now() - t0, model: null, confidence: null, ...extra })
  if (!oldRow || !newerRow || !oldRow.id || !newerRow.id) return fail('bad-input')

  // 时间顺序：早的是旧、晚的是新（调用方传反了也不怕）
  const ot = Date.parse(String(oldRow.created_at || '')) || 0
  const nt = Date.parse(String(newerRow.created_at || '')) || 0
  const old = nt < ot ? newerRow : oldRow
  const newer = nt < ot ? oldRow : newerRow

  const key = pairKey(aid, old, newer)
  const hit = useCache ? readJudgement(db, aid, key, { uncertainDays }) : null
  if (hit) return { verdict: hit.verdict, reason: hit.reason, cached: true, ms: 0, model: hit.model, confidence: hit.confidence }

  const save = (rec, cacheable = true) => {
    if (useCache && cacheable) {
      try {
        writeJudgement(db, aid, { pair_key: key, old_id: old.id, new_id: newer.id, ...rec, judged_at: new Date().toISOString(), via })
      } catch { /* 缓存失败不影响判定 */ }
    }
    return { ...rec, cached: false, ms: Date.now() - t0 }
  }

  // 以前这里「同 fact_key 直接判 supersede」。真数据打脸：同 key 只说明是同一个槽，
  // 不说明值变了（「允许我决定怎么称呼他」vs「我更习惯被叫小汐」被硬判成取代，4/4 全错）。
  // 现在同 key 也只当候选，交给下面的模型判。

  // 太短的对没有上下文，模型也容易乱判（「嗯嗯很好了」被判成取代）。
  // 直接标 uncertain 并缓存：不值得花模型，7 天内也不再问。
  if (String(old.text || '').trim().length < 12 || String(newer.text || '').trim().length < 12) {
    return save({ verdict: 'uncertain', reason: 'too-short', model: 'rule', confidence: 0.3 })
  }

  // 规则闸（专名撞车）
  if (!skipRules) {
    const g = ruleGate(old, newer)
    if (g) return save({ verdict: g.verdict, reason: g.reason, model: 'rule', confidence: g.confidence })
  }

  if (typeof complete !== 'function') return fail('no-model')
  let raw
  try {
    raw = await withTimeout(complete({ system: JUDGE_SYS, text: buildUser(old, newer) }), timeoutMs)
  } catch (e) {
    const code = String((e && e.code) || '')
    return fail(code === 'timeout' ? 'timeout' : 'error:' + String((e && e.message) || e).slice(0, 60))
  }
  if (!looksLikeJudgement(raw)) return fail('bad-shape')
  const verdict = parseVerdict(raw)
  // supersede 是唯一会真改记忆的档：判一次不够，再问一次，两次一致才认。
  // 不一致 / 复核失败 → uncertain，不缓存（下次重判）。宁可不改，也不误改。
  if (verdict === 'supersede') {
    let raw2 = ''
    try { raw2 = await withTimeout(complete({ system: JUDGE_SYS, text: buildUser(old, newer) }), timeoutMs) }
    catch { return save({ verdict: 'uncertain', reason: 'verify-failed', model: 'host', confidence: 0.3 }) }
    if (parseVerdict(raw2) !== 'supersede') {
      return save({ verdict: 'uncertain', reason: 'supersede-unconfirmed', model: 'host', confidence: 0.3 })
    }
  }
  // 模型自己说「不确定」才允许缓存 7 天；解析不出/格式坏的不缓存（下次还要问）
  const cacheable = verdict !== 'uncertain' || /不确定/.test(String(raw))
  return save({
    verdict, reason: 'model:' + String(raw).replace(/\s+/g, ' ').slice(0, 40),
    model: 'host', confidence: verdict === 'uncertain' ? 0.2 : 0.7,
  }, cacheable)
}

export default { judgePair, structureCandidates, propers, ruleGate, pairKey, verdictAction, judgeDay, readJudgement, writeJudgement }

// ── 夜间批量（P3）────────────────────────────────────────

const REASON_WEIGHT = { same_key: 4, same_topic: 3, same_turn: 2, same_episode: 1 }

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)))

/**
 * 判某一天新增记忆里的候选对。只写缓存与统计，**不改任何记忆**。
 *
 * @param {{db:object, aid:string, day:string, complete?:Function,
 *          limit?:number, timeoutMs?:number, minIntervalMs?:number,
 *          via?:string, sleep?:Function}} opt
 * @returns {Promise<{rows:number, pairs:number, judged:number, cached:number,
 *                    byVerdict:object, errors:number, ms:number}>}
 */
export async function judgeDay(opt = {}) {
  const { db, aid, day, complete, limit = 40, timeoutMs = 6000, minIntervalMs = 800, via = 'nightly' } = opt
  const sleep = typeof opt.sleep === 'function' ? opt.sleep : defaultSleep
  const t0 = Date.now()
  const out = { rows: 0, pairs: 0, judged: 0, cached: 0, byVerdict: {}, errors: 0, ms: 0 }
  if (!db || !aid || !day) return { ...out, ms: 0 }

  const start = new Date(String(day) + 'T00:00:00')
  if (!Number.isFinite(start.getTime())) return { ...out, ms: 0 }
  const end = new Date(start.getTime() + 86400000)
  let rows = []
  try {
    rows = db.prepare(`SELECT * FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL
        AND created_at>=? AND created_at<?
      ORDER BY created_at ASC`).all(aid, start.toISOString(), end.toISOString())
  } catch { return { ...out, ms: Date.now() - t0 } }
  out.rows = rows.length

  // 候选 → 去重 → 排序（同 key 优先，其次同主题/同轮/同段）
  const pairs = new Map()
  for (const row of rows) {
    let cands = []
    try { cands = structureCandidates(db, aid, { newRow: row, limit: 4 }) } catch { cands = [] }
    for (const c of cands) {
      const old = c.row
      // 只判「旧 → 新」；同一刻算不清就不判
      if (String(old.created_at || '') >= String(row.created_at || '')) continue
      const key = pairKey(aid, old, row)
      if (!pairs.has(key)) pairs.set(key, { old, newer: row, reason: c.reason, weight: REASON_WEIGHT[c.reason] || 0 })
    }
  }
  const sorted = [...pairs.values()]
    .sort((a, b) => (b.weight - a.weight) || String(b.newer.created_at || '').localeCompare(String(a.newer.created_at || '')))
    .slice(0, Math.max(1, Number(limit) || 40))
  out.pairs = sorted.length

  let lastCall = 0
  for (const p of sorted) {
    const gap = minIntervalMs - (Date.now() - lastCall)
    if (lastCall && gap > 0) { try { await sleep(gap) } catch { /* 睡失败就照跑 */ } }
    const r = await judgePair({ db, aid, oldRow: p.old, newerRow: p.newer, complete, timeoutMs, via })
    lastCall = Date.now()
    if (r.cached) out.cached++
    else out.judged++
    out.byVerdict[r.verdict] = (out.byVerdict[r.verdict] || 0) + 1
    if (/^(timeout|error:)/.test(String(r.reason || ''))) out.errors++
  }
  out.ms = Date.now() - t0
  return out
}
