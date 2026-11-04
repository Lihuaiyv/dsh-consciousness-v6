/**
 * 草稿收件箱（P1）：草稿还没进账本，所以可以改、可以丢；入库那一刻才走 draft.js commitDraft。
 * 与账本分开的另一个原因：账本只增，草稿要能反复改到五闸全过。
 *
 * 力度分档写在 draft.gatesOf 里（source=manual 时 G5 换成一证 + 人自己勾「我认」），
 * 这里只做落库、去重、字段规范化，不管判据。
 */
import { ulid } from './ulid.js'
import { SangguanError } from './errors.js'
import { gatesOf } from './draft.js'

const DAY = 86400000
export const DRAFT_STATUSES = Object.freeze(['draft', 'edited', 'committed', 'discarded'])
export const DRAFT_OPEN = Object.freeze(['draft', 'edited'])
const EDITABLE = Object.freeze(['text', 'alt', 'foregone', 'cost_to', 'exclusion', 'counterexample', 'boundary', 'evidence', 'vouch'])
const MAX_EVIDENCE = 6
const MAX_BOUNDARY = 4

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n)
const iso = (v) => {
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
const parseJson = (s, fallback) => {
  try {
    const v = JSON.parse(s)
    return v == null ? fallback : v
  } catch { return fallback }
}

/** 证据只收「有日期、有原话」的；日期精确到天就够，原话截 200 字。 */
export function normEvidence(list) {
  const out = []
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x !== 'object') continue
    const at = String(x.at || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at) || !Number.isFinite(Date.parse(at))) continue
    const quote = clip(x.quote, 200)
    if (!quote) continue
    out.push({ ref: x.ref ? clip(x.ref, 80) : null, at, quote })
    if (out.length >= MAX_EVIDENCE) break
  }
  return out
}

function normBoundary(list) {
  return (Array.isArray(list) ? list : []).map((b) => clip(b, 120)).filter(Boolean).slice(0, MAX_BOUNDARY)
}

/** 聚类现场只留重算 G5 需要的字段；手写稿没有这一层。 */
function normCluster(c) {
  if (!c || typeof c !== 'object') return null
  const items = (Array.isArray(c.items) ? c.items : []).slice(0, 12).map((x) => ({
    ref: x && x.ref ? clip(x.ref, 80) : null,
    at: x && x.at ? String(x.at).slice(0, 10) : null,
    trigger: x && x.trigger ? clip(x.trigger, 160) : null,
    alt: x && x.alt ? clip(x.alt, 200) : null,
    foregone: x && x.foregone ? clip(x.foregone, 200) : null,
    cost_to: x && x.cost_to ? clip(x.cost_to, 80) : null,
  }))
  return { kind: clip(c.kind, 12) || '其他', items }
}

function rowView(r) {
  if (!r) return null
  const boundary = parseJson(r.boundary_json, [])
  const evidence = parseJson(r.evidence_json, [])
  return {
    id: r.id, agent_id: r.agent_id, kind: r.kind, text: r.text,
    alt: r.alt, foregone: r.foregone, cost_to: r.cost_to,
    exclusion: r.exclusion, boundary: Array.isArray(boundary) ? boundary : [],
    counterexample: r.counterexample,
    evidence: Array.isArray(evidence) ? evidence : [],
    cluster: parseJson(r.cluster_json, null),
    gates: parseJson(r.gates_json, {}),
    status: r.status, source: r.source, vouch: !!r.vouch,
    batch_key: r.batch_key, claim_id: r.claim_id,
    created_at: r.created_at, updated_at: r.updated_at,
  }
}

function checkText(text, source) {
  if (!text) throw new SangguanError('INVALID', '草稿缺正文')
  if (source === 'manual' && text.length < 6) throw new SangguanError('INVALID', '手写的判断至少 6 个字', { len: text.length })
  if (source === 'manual' && text.length > 120) throw new SangguanError('INVALID', '手写的判断最多 120 字', { len: text.length })
  if (text.length > 300) throw new SangguanError('INVALID', '草稿正文过长', { len: text.length })
}

/**
 * 建一条草稿。30 天内正文相同的开口草稿视为同一条（duplicate=true），不重复插。
 * @returns 草稿视图（含 duplicate 标记）
 */
export function createDraft(db, aid, input = {}, opt = {}) {
  const at = opt.at || new Date().toISOString()
  const now = iso(at) || new Date().toISOString()
  const source = input.source === 'manual' ? 'manual' : 'llm'
  const text = clip(input.text, 300)
  checkText(text, source)
  const evidence = normEvidence(input.evidence)
  const cluster = normCluster(input.cluster)
  const boundary = normBoundary(input.boundary)
  const draft = {
    text, alt: clip(input.alt, 200) || null, foregone: clip(input.foregone, 200) || null,
    cost_to: clip(input.cost_to, 80) || null, exclusion: clip(input.exclusion, 200) || null,
    counterexample: clip(input.counterexample, 200) || null,
    boundary, evidence, vouch: input.vouch === true,
  }
  const gates = gatesOf(draft, cluster, { source })

  const since = new Date(Date.parse(now) - 30 * DAY).toISOString()
  const dup = db.prepare(
    'SELECT * FROM sangguan_drafts WHERE agent_id=? AND text=? AND created_at>=? AND status IN (?,?,?) ORDER BY created_at DESC LIMIT 1',
  ).get(aid, text, since, 'draft', 'edited', 'committed')
  if (dup) return { ...rowView(dup), duplicate: true }

  const id = 'dr_' + ulid(Date.parse(now))
  db.prepare(`INSERT INTO sangguan_drafts(
    id, agent_id, kind, text, alt, foregone, cost_to, exclusion, boundary_json, counterexample,
    evidence_json, cluster_json, gates_json, status, source, vouch, batch_key, claim_id, created_at, updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, aid, clip(input.kind, 12) || '其他', draft.text, draft.alt, draft.foregone, draft.cost_to,
    draft.exclusion, JSON.stringify(draft.boundary), draft.counterexample,
    JSON.stringify(draft.evidence), cluster ? JSON.stringify(cluster) : null, JSON.stringify(gates),
    'draft', source, draft.vouch ? 1 : 0, input.batch_key ? clip(input.batch_key, 80) : null, null, now, now,
  )
  return { ...getDraft(db, aid, id), duplicate: false }
}

/** 列表：默认只给还开着的（draft / edited），按新建时间倒序。 */
export function listDrafts(db, aid, opt = {}) {
  const want = (Array.isArray(opt.status) ? opt.status : []).filter((s) => DRAFT_STATUSES.includes(s))
  const statuses = want.length ? want : DRAFT_OPEN
  const limit = Math.max(1, Math.min(100, Number(opt.limit) || 50))
  const rows = db.prepare(
    'SELECT * FROM sangguan_drafts WHERE agent_id=? AND status IN (' + statuses.map(() => '?').join(',') + ') ORDER BY created_at DESC LIMIT ?',
  ).all(aid, ...statuses, limit)
  return rows.map(rowView)
}

export function getDraft(db, aid, id) {
  const r = db.prepare('SELECT * FROM sangguan_drafts WHERE agent_id=? AND id=?').get(aid, String(id))
  return rowView(r)
}

/**
 * 改草稿：可改正文 / 另一条路 / 代价 / 边界 / 反例 / 证据 / 我认；改完立刻重算五闸。
 * 已入库或已丢掉的不能再改。
 */
export function patchDraft(db, aid, id, patch = {}, opt = {}) {
  const cur = getDraft(db, aid, id)
  if (!cur) throw new SangguanError('NOT_FOUND', '没有这条草稿')
  if (!DRAFT_OPEN.includes(cur.status)) throw new SangguanError('TRANSITION', '这条草稿已经结束了')
  const now = iso(opt.at) || new Date().toISOString()
  const next = { ...cur }
  for (const f of EDITABLE) if (patch[f] !== undefined) next[f] = patch[f]
  next.text = clip(next.text, 300)
  checkText(next.text, cur.source)
  next.alt = clip(next.alt, 200) || null
  next.foregone = clip(next.foregone, 200) || null
  next.cost_to = clip(next.cost_to, 80) || null
  next.exclusion = clip(next.exclusion, 200) || null
  next.counterexample = clip(next.counterexample, 200) || null
  next.boundary = normBoundary(next.boundary)
  next.evidence = normEvidence(next.evidence)
  next.vouch = next.vouch === true
  const gates = gatesOf(next, next.cluster, { source: cur.source })
  db.prepare(`UPDATE sangguan_drafts SET text=?, alt=?, foregone=?, cost_to=?, exclusion=?, boundary_json=?,
    counterexample=?, evidence_json=?, gates_json=?, vouch=?, status=?, updated_at=? WHERE agent_id=? AND id=?`).run(
    next.text, next.alt, next.foregone, next.cost_to, next.exclusion, JSON.stringify(next.boundary),
    next.counterexample, JSON.stringify(next.evidence), JSON.stringify(gates), next.vouch ? 1 : 0,
    'edited', now, aid, String(id),
  )
  return getDraft(db, aid, id)
}

/** 入库成功后关闭这条草稿，记下写出的命题 id（可回溯）。 */
export function markCommitted(db, aid, id, claimId, opt = {}) {
  const now = iso(opt.at) || new Date().toISOString()
  const r = db.prepare("UPDATE sangguan_drafts SET status='committed', claim_id=?, updated_at=? WHERE agent_id=? AND id=? AND status IN (?,?)")
    .run(String(claimId), now, aid, String(id), DRAFT_OPEN[0], DRAFT_OPEN[1])
  if (!r.changes) throw new SangguanError('TRANSITION', '这条草稿不在可入库的状态')
  return getDraft(db, aid, id)
}

export function markDiscarded(db, aid, id, opt = {}) {
  const now = iso(opt.at) || new Date().toISOString()
  const r = db.prepare("UPDATE sangguan_drafts SET status='discarded', updated_at=? WHERE agent_id=? AND id=? AND status IN (?,?)")
    .run(now, aid, String(id), DRAFT_OPEN[0], DRAFT_OPEN[1])
  if (!r.changes) throw new SangguanError('TRANSITION', '这条草稿已经结束了')
  return getDraft(db, aid, id)
}

export function pendingCount(db, aid) {
  const r = db.prepare("SELECT COUNT(*) n FROM sangguan_drafts WHERE agent_id=? AND status IN (?,?)").get(aid, DRAFT_OPEN[0], DRAFT_OPEN[1])
  return Number(r && r.n) || 0
}

/** 收件箱三个数：还开着的 / 已入库 / 已丢掉。 */
export function draftCounts(db, aid) {
  const rows = db.prepare('SELECT status, COUNT(*) n FROM sangguan_drafts WHERE agent_id=? GROUP BY status').all(aid)
  const out = { draft: 0, edited: 0, committed: 0, discarded: 0 }
  for (const r of rows) if (r.status in out) out[r.status] = Number(r.n) || 0
  return { pending: out.draft + out.edited, committed: out.committed, discarded: out.discarded }
}
