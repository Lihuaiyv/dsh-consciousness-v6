import { topicOfFactKey } from './passport.js'
/**
 * 断言状态（claim）：这条记忆说的「还没做 / 做完了」，现在还算不算。
 *
 * 为什么单独一层：时态错不是「两条记忆谁新」的问题，是「一条旧状态被当现状读」。
 * 规则先标 pending / done；模型只在夜间核对（M2）时出场，判 done / stale / still。
 * 只写状态、不删记忆；真正的失效仍走 invalidateMemory（保留历史）。
 */
import { now } from '../db.js'

export const CLAIM_STATES = Object.freeze(['pending', 'done', 'stale', 'na'])

// 「还没做完」同时命中 pending 和 done，所以必须先判 pending。
const PENDING = /(还没|尚未|未完成|没做完|没弄|没提交|没做|没修|没上线|待办|还挂着|还没开始|没头绪|打算|计划要|计划做|要做|之后要|之后再|等.{0,8}再|明天要|下周要)/
// 转述句（「用户主张…『未完成陈述』…」）里的状态词是在引用别人，不是她自己的待办。
const REPORTED = /^(用户|他|她|对方)(说|主张|认为|表示|提到|反馈|问|提出)/
const DONE = /(做完了|完成了|已完成|做好了|修好了|搞定了|上线了|落地了|改好了|已经做完|已经完成|已经上线|已经修好|已经弄好|已经改好|可以了)/

/**
 * 规则标注。只在「明确说状态」时给 pending/done，其余 na。
 * @returns {{state:'pending'|'done'|'na', reason:string}}
 */
export function classifyClaim(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (s.length < 3) return { state: 'na', reason: 'too-short' }  // 「修好了」「没提交」这种 3 字也是合法状态

  if (PENDING.test(s)) {
    if (REPORTED.test(s)) return { state: 'na', reason: 'reported' }
    return { state: 'pending', reason: 'pending-words' }
  }
  if (DONE.test(s)) return { state: 'done', reason: 'done-words' }
  return { state: 'na', reason: 'none' }
}

function rowOf(db, aid, memoryId) {
  try { return db.prepare('SELECT * FROM memory_items WHERE agent_id=? AND id=?').get(aid, memoryId) || null } catch { return null }
}

/** 写/覆盖一条 claim。state=na 时删行（不存噪音）。 */
export function setClaimState(db, aid, memoryId, state, opt = {}) {
  const s = String(state || '').trim()
  if (!CLAIM_STATES.includes(s)) return false
  if (s === 'na') {
    try { db.prepare('DELETE FROM memory_claims WHERE agent_id=? AND memory_id=?').run(aid, memoryId); return true } catch { return false }
  }
  try {
    db.prepare(`INSERT INTO memory_claims(memory_id, agent_id, claim_key, state, since, evidence_id, checked_at, via)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(memory_id) DO UPDATE SET
        state=excluded.state, evidence_id=excluded.evidence_id, checked_at=excluded.checked_at, via=excluded.via`)
      .run(
        memoryId, aid, opt.claimKey == null ? null : String(opt.claimKey).slice(0, 80),
        s, opt.since || now(),
        opt.evidenceId == null ? null : String(opt.evidenceId),
        opt.checkedAt == null ? null : String(opt.checkedAt),
        String(opt.via || 'manual').slice(0, 20),
      )
    return true
  } catch { return false }
}

/** claim 总闸：off 时连规则标注都不写（行为与改造前一致）。 */
export function claimEnabled(db, aid) {
  try {
    const r = db.prepare('SELECT value FROM agent_params WHERE agent_id=? AND key=?').get(aid, 'memory.claim.enable')
    if (!r) return false
    return JSON.parse(r.value) !== 'off'
  } catch { return false }
}

export function claimOf(db, aid, memoryId) {
  try { return db.prepare('SELECT * FROM memory_claims WHERE agent_id=? AND memory_id=?').get(aid, memoryId) || null } catch { return null }
}

/** 对一条记忆跑规则标注并落库。返回 claim 行或 null（na 不落）。 */
export function syncClaims(db, aid, row, opt = {}) {
  if (!row || !row.id) return null
  const { state } = classifyClaim(row.text)
  if (state === 'na') return null
  setClaimState(db, aid, row.id, state, { via: opt.via || 'extract' })
  return claimOf(db, aid, row.id)
}

/**
 * 待核对的 pending 条：active、还没作废、标了 pending、且创建超过 minAgeDays。
 * @returns {Array<{claim:object, row:object}>}
 */
export function pendingClaims(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(200, Number(opt.limit) || 50))
  const minAgeDays = Math.max(0, Number(opt.minAgeDays) || 0)
  const cutoff = new Date((opt.nowMs || Date.now()) - minAgeDays * 86400000).toISOString()
  try {
    return db.prepare(`SELECT c.*, m.text, m.type, m.fact_key, m.created_at, m.source_turn_id
      FROM memory_claims c JOIN memory_items m ON m.id=c.memory_id AND m.agent_id=c.agent_id
      WHERE c.agent_id=? AND c.state='pending'
        AND m.status='active' AND m.invalid_at IS NULL AND m.created_at<=?
      ORDER BY m.created_at LIMIT ?`).all(aid, cutoff, limit)
  } catch { return [] }
}

/** 状态分布（报告用）。 */
// ── S2：夜间状态核对（M2）────────────────────────────────
//
// 只回答一件事：旧条说的「还没做」，现在被哪条记录证明做完了/放弃了/还是没做。
// shadow：只改 memory_claims.state，不动 invalid_at；开 on 才由调用方决定要不要作废。

export const CLAIM_SYS = [
  '你在核对一条旧记忆里说的「还没做」，现在还算不算。',
  '只输出一个 JSON，不要解释，不要 markdown：{"state":"done|stale|still","evidence":序号或null,"quote":"证据原文"}',
  'done —— 后面的记录证明已经做完了；quote 必须是那条记录里的原文，且不能是「还没做/没发」这类否定句。',
  'stale —— 后面的记录证明这件事不做了、作废了、或者换成别的了；quote 同上。',
  'still —— 没有证据，还是没做。quote 可为空。',
  '注意：只是提到同一件事不算证据；要能证明它完成或放弃。',
].join('\n')

function withTimeoutMs(promise, ms) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('claim timeout'), { code: 'timeout' })), Math.max(1, Number(ms) || 6000))
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

/** 之后的相关记录：同 fact_key / 同主题 / 同 turn / 同 episode，最多 limit 条。 */
export function laterRecords(db, aid, claimRow, limit = 5) {
  const out = []
  const seen = new Set()
  const push = (r) => { if (r && r.id !== claimRow.memory_id && !seen.has(r.id)) { seen.add(r.id); out.push(r) } }
  try {
    const key = String(claimRow.fact_key || '').trim()
    if (key) {
      for (const r of db.prepare(`SELECT * FROM memory_items WHERE agent_id=? AND id<>? AND status='active' AND invalid_at IS NULL
        AND fact_key=? AND created_at>? ORDER BY created_at ASC LIMIT ?`).all(aid, claimRow.memory_id, key, claimRow.created_at, limit)) push(r)
      const topic = topicOfFactKey(key)
      if (topic && topic.length >= 2) {
        for (const r of db.prepare(`SELECT * FROM memory_items WHERE agent_id=? AND id<>? AND status='active' AND invalid_at IS NULL
          AND fact_key IS NOT NULL AND fact_key LIKE ? AND created_at>? ORDER BY created_at ASC LIMIT 20`).all(aid, claimRow.memory_id, '%' + topic + '%', claimRow.created_at)) {
          if (topicOfFactKey(r.fact_key) === topic) push(r)
          if (out.length >= limit) break
        }
      }
    }
    if (claimRow.source_turn_id) {
      for (const r of db.prepare(`SELECT * FROM memory_items WHERE agent_id=? AND id<>? AND status='active' AND invalid_at IS NULL
        AND source_turn_id=? AND created_at>? ORDER BY created_at ASC LIMIT ?`).all(aid, claimRow.memory_id, claimRow.source_turn_id, claimRow.created_at, limit)) push(r)
    }
  } catch { /* 老库异常就少几路证据 */ }
  // 兜底：同主题找不到证据时，给之后最近的几条（不保证相关，让模型自己判断）。
  // 没有这一步，「躯干还没收尾 → 已经拆成零件」这种换了话题的证据永远看不到。
  if (!out.length) {
    try {
      for (const r of db.prepare(`SELECT * FROM memory_items WHERE agent_id=? AND id<>? AND status='active' AND invalid_at IS NULL AND created_at>? ORDER BY created_at ASC LIMIT ?`).all(aid, claimRow.memory_id, claimRow.created_at, limit)) push(r)
    } catch { /* 兜底也失败就只留空 */ }
  }
  return out.slice(0, limit)
}

function parseClaimAnswer(raw) {
  const t = String(raw || '')
  let obj = null
  try { obj = JSON.parse(t.trim()) } catch { /* 再试从花括号里抠 */ }
  if (!obj) {
    const m = t.match(/\{[^}]*\}/)
    if (m) { try { obj = JSON.parse(m[0]) } catch { obj = null } }
  }
  if (!obj || typeof obj !== 'object') return { state: null, evidence: null, quote: '' }
  const st = String(obj.state || '').toLowerCase()
  if (!['done', 'stale', 'still'].includes(st)) return { state: null, evidence: null, quote: '' }
  const ev = Number(obj.evidence)
  return { state: st, evidence: Number.isFinite(ev) && ev > 0 ? ev : null, quote: String(obj.quote || '') }
}

/**
 * 夜间批量核对。只写 claim 状态；不动 invalid_at。
 * 作废是调用方的事：nightly 在 claim.enable=on 时按返回的 doneIds/staleIds 调 invalidateMemory。
 * 别的地方直接调它时，记得自己补这一步——否则会出现「claim 说 done、记忆还活着」。
 * @returns {Promise<{candidates:number, judged:number, byState:object, errors:number, ms:number}>}
 */
export async function reconcileClaims(opt = {}) {
  const { db, aid, complete, limit = 40, minAgeDays = 3, timeoutMs = 6000, via = 'nightly' } = opt
  const t0 = Date.now()
  const out = { candidates: 0, judged: 0, byState: {}, errors: 0, ms: 0, doneIds: [], staleIds: [] }
  const rows = pendingClaims(db, aid, { limit, minAgeDays })
  out.candidates = rows.length
  for (const claimRow of rows) {
    const evid = laterRecords(db, aid, claimRow, 5)
    if (!evid.length) {
      // 没有后续记录：仍然是 pending，只更新 checked_at，不花模型
      setClaimState(db, aid, claimRow.memory_id, 'pending', { via, checkedAt: now() })
      continue
    }
    const text = '旧条：' + String(claimRow.text || '').replace(/\s+/g, ' ').slice(0, 160)
      + '\n之后的记录：\n' + evid.map((r, i) => (i + 1) + '. ' + String(r.text || '').replace(/\s+/g, ' ').slice(0, 120)).join('\n')
    let raw = ''
    try {
      if (typeof complete !== 'function') throw new Error('no-model')
      raw = await withTimeoutMs(complete({ system: CLAIM_SYS, text }), timeoutMs)
    } catch { out.errors++; continue }
    const ans = parseClaimAnswer(raw)
    if (!ans.state) { out.errors++; continue }
    const evidenceId = ans.evidence ? (evid[ans.evidence - 1] && evid[ans.evidence - 1].id) || null : null
    // done/stale 都必须有原文证据；引文要真的出现在某条后续记录里。
    // done 的引文如果是「还没发 / 没做」这种否定句，不算做完（图库那条就是这么误判的）。
    const NEG = /(还没|尚未|没有|没发|没做|没弄|没修|没提交|没上线)/
    const normText = (x) => String(x || '').replace(/[\s\p{P}]/gu, '')
    let state = ans.state
    if (state !== 'still') {
      const q = normText(ans.quote)
      const inEvid = q.length >= 2 && evid.some((e) => normText(e.text).includes(q))
      if (!q || !inEvid) { state = 'still'; out.noQuote = (out.noQuote || 0) + 1 }
      else if (state === 'done' && NEG.test(String(ans.quote))) { state = 'still'; out.negQuote = (out.negQuote || 0) + 1 }
    }
    if (state === 'still') {
      setClaimState(db, aid, claimRow.memory_id, 'pending', { via, evidenceId, checkedAt: now() })
    } else {
      setClaimState(db, aid, claimRow.memory_id, state, { via, evidenceId, checkedAt: now() })
    }
    out.judged++
    out.byState[state] = (out.byState[state] || 0) + 1
    if (state === 'done') out.doneIds.push(claimRow.memory_id)
    if (state === 'stale') out.staleIds.push(claimRow.memory_id)
  }
  out.ms = Date.now() - t0
  return out
}

export function claimStats(db, aid) {
  const out = { pending: 0, done: 0, stale: 0 }
  try {
    for (const r of db.prepare('SELECT state, COUNT(*) n FROM memory_claims WHERE agent_id=? GROUP BY state').all(aid)) {
      if (out[r.state] != null) out[r.state] = Number(r.n) || 0
    }
  } catch { /* 老库没表就全 0 */ }
  return out
}
