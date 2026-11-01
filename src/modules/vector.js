/**
 * 向量通道（P3）：语义召回的最后一块。
 *
 * 分工：
 *   - 记忆向量在写入后 / 回填时算好，落 memory_vec（Float32Array 字节）；
 *   - 查询向量在收到用户消息时预取（和扩词共用一套「先发出去、pre-step 只等一小会儿」）；
 *   - 检索本身是同步的：读已存向量、算余弦，不在这里调网络。
 *
 * 没有 embedding 能力时整条通道自动关闭（available=false），不影响词法召回。
 */

import { model } from '../kernel.js'
import { now } from '../db.js'

export const EMBED_TIMEOUT_MS = 800
export const EMBED_WAIT_MS = 150

const CACHE = new Map()
const CACHE_TTL = 30 * 60 * 1000
const CACHE_MAX = 500
const INFLIGHT = new Map()

function keyOf(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 300)
}

function withTimeout(promise, ms) {
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(30, Number(ms) || EMBED_TIMEOUT_MS))
    if (timer.unref) timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer) })
}

/** 模型能不能算向量。业务只问这一句，不关心是哪个适配器。 */
export function canEmbed() {
  try { return !!(model.capabilities() || {}).embed } catch { return false }
}

function toF32(vec) {
  if (vec instanceof Float32Array) return vec
  if (Array.isArray(vec)) return Float32Array.from(vec.map((x) => Number(x) || 0))
  return null
}

/** 真正调 embedding。命中缓存 / 并发同句只发一次。 */
export function embedText(text, timeout = EMBED_TIMEOUT_MS) {
  const q = String(text || '').trim()
  const k = keyOf(q)
  if (!k || !canEmbed()) return Promise.resolve(null)
  const hit = CACHE.get(k)
  if (hit && Date.now() - hit.at < CACHE_TTL) return Promise.resolve(hit.vec)
  const running = INFLIGHT.get(k)
  if (running) return running
  const task = withTimeout(Promise.resolve().then(() => model.embed([q])), timeout)
    .then((out) => {
      const vec = toF32(Array.isArray(out) ? out[0] : out)
      if (vec && vec.length) {
        CACHE.set(k, { vec, at: Date.now() })
        while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value)
        return vec
      }
      return null
    })
    .catch(() => null)
    .finally(() => { INFLIGHT.delete(k) })
  INFLIGHT.set(k, task)
  return task
}

export function prefetchEmbedding(text) {
  const q = String(text || '').trim()
  if (!q) return
  const k = keyOf(q)
  if (CACHE.has(k) || INFLIGHT.has(k)) return
  embedText(q).catch(() => { /* 预取失败静默 */ })
}

export async function takeEmbedding(text, waitMs = EMBED_WAIT_MS) {
  const q = String(text || '').trim()
  const k = keyOf(q)
  if (!k) return null
  const hit = CACHE.get(k)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.vec
  const running = INFLIGHT.get(k)
  if (!running) return null
  return withTimeout(running, waitMs)
}

/** 写一条向量（覆盖）。 */
export function writeVector(db, aid, memoryId, vec, modelName = 'default') {
  const v = toF32(vec)
  if (!v || !v.length) return false
  try {
    db.prepare(`INSERT INTO memory_vec(memory_id,agent_id,dim,model,vec,at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(memory_id) DO UPDATE SET dim=excluded.dim, model=excluded.model, vec=excluded.vec, at=excluded.at`)
      .run(memoryId, aid, v.length, String(modelName || 'default').slice(0, 60), Buffer.from(v.buffer, v.byteOffset, v.byteLength), now())
    return true
  } catch { return false }
}

/** 批量回填：只补还没有向量的（或 force 全部重算）。返回计数。 */
export async function backfillVectors(db, aid, opt = {}) {
  if (!canEmbed()) return { ok: false, reason: 'no embedding capability', done: 0, total: 0 }
  const limit = Math.max(1, Math.min(500, Number(opt.limit) || 100))
  const batch = Math.max(1, Math.min(32, Number(opt.batch) || 16))
  const force = !!opt.force
  const sql = `SELECT id, text FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL`
    + (force ? '' : ' AND id NOT IN (SELECT memory_id FROM memory_vec)')
    + ' ORDER BY created_at DESC LIMIT ?'
  let rows = []
  try { rows = db.prepare(sql).all(aid, limit) } catch { rows = [] }
  let done = 0
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch)
    try {
      const out = await model.embed(part.map((r) => String(r.text || '').slice(0, 1200)))
      const list = Array.isArray(out) ? out : []
      for (let j = 0; j < part.length; j++) {
        if (list[j] && writeVector(db, aid, part[j].id, list[j], opt.model)) done++
      }
    } catch { /* 这一批失败，下一轮再补 */ }
  }
  return { ok: true, done, total: rows.length }
}

export function vectorStats(db, aid) {
  try {
    const r = db.prepare('SELECT COUNT(*) n FROM memory_vec WHERE agent_id=?').get(aid)
    const total = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid)
    return { vectors: Number(r.n), memories: Number(total.n), canEmbed: canEmbed() }
  } catch { return { vectors: 0, memories: 0, canEmbed: false } }
}

