/**
 * 实例级算法绑定：active / canary / ratio
 * 内存 Map + algo_bindings 表持久化（阶段 4）。
 */

import { has } from './registry.js'

const bindings = new Map()
/** @type {import('node:sqlite').DatabaseSync | null} */
let dbRef = null

function now() { return new Date().toISOString() }

function keyOf(aid, name) {
  return String(aid) + ':' + String(name)
}

export function attachDb(db) {
  dbRef = db
  hydrateAll(db)
}

export function hydrateAll(db = dbRef) {
  if (!db) return 0
  let n = 0
  try {
    const rows = db.prepare('SELECT * FROM algo_bindings').all()
    for (const r of rows) {
      bindings.set(keyOf(r.agent_id, r.name), {
        active: String(r.active),
        canary: r.canary == null || r.canary === '' ? null : String(r.canary),
        ratio: Number(r.ratio) || 0,
      })
      n++
    }
  } catch { /* 表尚未创建时跳过 */ }
  return n
}

function persist(aid, name, binding) {
  if (!dbRef) return
  dbRef.prepare(`INSERT INTO algo_bindings(agent_id,name,active,canary,ratio,updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(agent_id,name) DO UPDATE SET
      active=excluded.active, canary=excluded.canary, ratio=excluded.ratio, updated_at=excluded.updated_at`)
    .run(aid, name, binding.active, binding.canary, binding.ratio, now())
}

export function getBinding(aid, name) {
  return bindings.get(keyOf(aid, name)) || null
}

/**
 * @param {string} aid
 * @param {string} name
 * @param {{ active?: string, canary?: string|null, ratio?: number }} patch
 */
export function setBinding(aid, name, patch = {}) {
  const cur = getBinding(aid, name) || { active: 'v2', canary: null, ratio: 0 }
  const next = {
    active: patch.active != null ? String(patch.active) : cur.active,
    canary: patch.canary === undefined ? cur.canary : (patch.canary == null || patch.canary === '' ? null : String(patch.canary)),
    ratio: patch.ratio == null ? cur.ratio : Math.max(0, Math.min(1, Number(patch.ratio) || 0)),
  }
  if (!has(name, next.active)) throw new Error('active 版本未登记：' + name + '@' + next.active)
  if (next.canary && !has(name, next.canary)) throw new Error('canary 版本未登记：' + name + '@' + next.canary)
  bindings.set(keyOf(aid, name), next)
  persist(aid, name, next)
  return next
}

/**
 * 解析本轮应跑的版本。有 canary+ratio 时按比例抽样；否则用 active。
 */
export function resolveVersion(aid, name, fallback = 'v2') {
  const b = getBinding(aid, name)
  if (!b) {
    const fb = String(fallback || 'v2')
    return has(name, fb) ? fb : 'v2'
  }
  if (b.canary && b.ratio > 0 && Math.random() < b.ratio) return b.canary
  return b.active
}

export function listBindings(aid = null) {
  const out = []
  for (const [k, v] of bindings.entries()) {
    const idx = k.indexOf(':')
    const a = k.slice(0, idx)
    const name = k.slice(idx + 1)
    if (aid != null && a !== String(aid)) continue
    out.push({ agent_id: a, name, ...v })
  }
  return out
}

export function clearBindings() {
  bindings.clear()
}
