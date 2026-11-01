/**
 * U1 · 进程内 IVF 近似向量索引（不依赖 sqlite-vec 扩展）
 *
 * - auto：覆盖率够时用 IVF 候选剪枝，不够则回退全量余弦
 * - bruteforce：始终全量（与旧行为一致）
 * - off：不走向量通道（由调用方决定）
 *
 * 写入 dirty 后下次检索重建；夜巡也可主动 rebuild。
 */

import { getParam } from '../kernel.js'

const INDEX = new Map() // aid -> { dirty, at, dim, nlist, centroids, lists, coverage, memories }

export function markVectorIndexDirty(aid) {
  const cur = INDEX.get(aid)
  if (cur) cur.dirty = true
  else INDEX.set(aid, { dirty: true, at: 0, dim: 0, nlist: 0, centroids: [], lists: [], coverage: 0, memories: 0 })
}

function toF32(vec) {
  if (vec instanceof Float32Array) return vec
  if (ArrayBuffer.isView(vec)) return new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength / 4)
  if (Buffer.isBuffer(vec)) return new Float32Array(vec.buffer, vec.byteOffset, Math.floor(vec.byteLength / 4))
  if (Array.isArray(vec)) return Float32Array.from(vec.map((x) => Number(x) || 0))
  return null
}

function l2norm(v) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s) || 1
}

function cos(a, b, an, bn) {
  let d = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) d += a[i] * b[i]
  return d / ((an || l2norm(a)) * (bn || l2norm(b)))
}

function loadRows(db, aid, includeCold) {
  const cold = includeCold
    ? ''
    : " AND (m.temp_state IS NULL OR m.temp_state IN ('hot','warm'))"
  try {
    return db.prepare(`SELECT v.memory_id AS id, v.dim, v.vec, m.text, m.type, m.temp_state
      FROM memory_vec v JOIN memory_items m ON m.id=v.memory_id
      WHERE v.agent_id=? AND m.agent_id=? AND m.status='active' AND m.invalid_at IS NULL${cold}`).all(aid, aid)
  } catch { return [] }
}

function buildIvf(items, nlist) {
  if (!items.length) return { centroids: [], lists: [] }
  const k = Math.max(1, Math.min(nlist, Math.ceil(Math.sqrt(items.length))))
  const centroids = []
  const step = Math.max(1, Math.floor(items.length / k))
  for (let i = 0; i < k; i++) {
    const src = items[Math.min(items.length - 1, i * step)]
    centroids.push({ vec: src.vec, norm: src.norm })
  }
  const lists = Array.from({ length: centroids.length }, () => [])
  for (const it of items) {
    let best = 0
    let bestS = -Infinity
    for (let c = 0; c < centroids.length; c++) {
      const s = cos(it.vec, centroids[c].vec, it.norm, centroids[c].norm)
      if (s > bestS) { bestS = s; best = c }
    }
    lists[best].push(it)
  }
  return { centroids, lists }
}

export function rebuildVectorIndex(db, aid, opt = {}) {
  const includeCold = !!opt.includeCold
  const rows = loadRows(db, aid, includeCold)
  let memories = 0
  try {
    memories = Number(db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid).n) || 0
  } catch { memories = rows.length }
  const items = []
  let dim = 0
  for (const r of rows) {
    const vec = toF32(r.vec)
    if (!vec || !vec.length) continue
    if (!dim) dim = vec.length
    if (vec.length !== dim) continue
    items.push({
      id: r.id, text: r.text, type: r.type, vec, norm: l2norm(vec),
    })
  }
  const nlist = Math.max(4, Math.min(64, Math.ceil(Math.sqrt(Math.max(1, items.length)))))
  const { centroids, lists } = buildIvf(items, nlist)
  const coverage = memories > 0 ? items.length / memories : 0
  const entry = {
    dirty: false,
    at: Date.now(),
    dim,
    nlist: centroids.length,
    centroids,
    lists,
    flat: items,
    coverage,
    memories,
    includeCold,
  }
  INDEX.set(aid, entry)
  return { n: items.length, coverage, nlist: centroids.length }
}

function ensureIndex(db, aid, opt = {}) {
  const cur = INDEX.get(aid)
  if (cur && !cur.dirty && cur.flat && (!!opt.includeCold === !!cur.includeCold)) return cur
  rebuildVectorIndex(db, aid, opt)
  return INDEX.get(aid)
}

export function vectorIndexMode(db, aid) {
  try {
    const v = String(getParam(db, aid, 'memory.retrieve.vector.index') || 'auto')
    if (v === 'off' || v === 'bruteforce' || v === 'auto') return v
  } catch { /* default */ }
  return 'auto'
}

/**
 * @returns {Array<{id,text,type,cos,_vecE,via}>}
 */
export function searchVectorAnn(db, aid, queryVec, opt = {}) {
  const q = toF32(queryVec)
  if (!q || !q.length) return []
  const mode = opt.mode || vectorIndexMode(db, aid)
  if (mode === 'off') return []
  const limit = Math.max(1, Math.min(50, Number(opt.limit) || 20))
  const qn = l2norm(q)
  const idx = ensureIndex(db, aid, { includeCold: !!opt.includeCold })
  if (!idx || !idx.flat.length) return []
  if (idx.dim && q.length !== idx.dim) return []

  // 覆盖率不足：S1 不依赖向量（调用方可再决定）；这里仍可搜，但标 coverage
  const minCov = opt.minCoverage != null ? Number(opt.minCoverage) : 0.3
  const lowCoverage = idx.coverage < minCov

  let candidates = idx.flat
  // 小库全扫更稳；大库再 IVF。nprobe 至少扫半数列表，降低假阴性。
  if (mode === 'auto' && idx.centroids.length >= 2 && idx.flat.length >= 80) {
    const nprobe = Math.min(idx.centroids.length, Math.max(4, Math.ceil(idx.centroids.length * 0.5)))
    const scores = idx.centroids.map((c, i) => ({ i, s: cos(q, c.vec, qn, c.norm) }))
    scores.sort((a, b) => b.s - a.s)
    const bag = []
    const seen = new Set()
    for (let p = 0; p < nprobe; p++) {
      for (const it of idx.lists[scores[p].i] || []) {
        if (seen.has(it.id)) continue
        seen.add(it.id)
        bag.push(it)
      }
    }
    if (bag.length) candidates = bag
  }

  const out = []
  for (const it of candidates) {
    const c = cos(q, it.vec, qn, it.norm)
    if (c < 0.35) continue
    const e = Math.round(Math.min(0.95, Math.max(0, (c - 0.25) / 0.65)) * 0.95 * 1e4) / 1e4
    out.push({
      partition: 'T1', id: it.id, via: 'vec', text: it.text, type: it.type,
      fts: 0, _vecE: e, cos: Math.round(c * 1e4) / 1e4,
      _vecCoverage: idx.coverage, _vecLowCoverage: lowCoverage,
    })
  }
  return out.sort((a, b) => b._vecE - a._vecE).slice(0, limit)
}

export function vectorIndexStats(aid) {
  const cur = INDEX.get(aid)
  if (!cur) return { ready: false }
  return {
    ready: !cur.dirty && !!cur.flat,
    n: cur.flat ? cur.flat.length : 0,
    coverage: cur.coverage,
    nlist: cur.nlist,
    dim: cur.dim,
  }
}

// 写入向量时作废索引（由 retrieve 侧 onVectorWrite 链式注册，避免单钩子互踩）
export function attachVectorIndexInvalidation(onVectorWrite) {
  if (typeof onVectorWrite !== 'function') return
  onVectorWrite((aid) => {
    if (aid) markVectorIndexDirty(aid)
    else for (const id of INDEX.keys()) markVectorIndexDirty(id)
  })
}
