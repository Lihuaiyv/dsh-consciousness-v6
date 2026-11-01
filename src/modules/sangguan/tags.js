/**
 * 命题折成十维，只给驱力的重要度用。同一维取最高，不累加。
 * 张力沿用价值观那三对上限。嵌入缺失时返回 null，调用方继续读旧表。
 */
import { VALUE_DIMS as DIMS, VALUE_PAIRS as PAIRS, VALUE_FLOOR as FLOOR, VALUE_INIT as INIT } from '../persona_dims.js'
import { lexicalSim, cosine } from './sim.js'

const anchors = () => DIMS.map(([key, , hint]) => ({ key, hint }))
const embedCache = new WeakMap()

function vecOf(embed, text) {
  let box = embedCache.get(embed)
  if (!box) { box = new Map(); embedCache.set(embed, box) }
  if (box.has(text)) return box.get(text)
  let vec = null
  try { vec = embed(text) } catch { vec = null }
  if (!vec || !vec.length) return null
  box.set(text, vec)
  return vec
}

export function foldDims(scored) {
  const score = {}
  for (const [k] of DIMS) score[k] = INIT
  const best = {}
  for (const it of scored || []) {
    if (!score[it.dim] && score[it.dim] !== 0) continue
    if (!anchors().some((a) => a.key === it.dim)) continue
    const v = Number(it.score)
    if (!Number.isFinite(v) || v < 0) continue
    if (best[it.dim] == null || v > best[it.dim]) best[it.dim] = v
  }
  for (const [k, v] of Object.entries(best)) score[k] = INIT + v
  for (const [a, b] of PAIRS) {
    const win = score[a] >= score[b] ? a : b
    const lose = win === a ? b : a
    const w = score[win]
    if (w > 0.12) {
      const cap = Math.max(FLOOR, 0.12 - 0.4 * (w - 0.12))
      if (score[lose] > cap) score[lose] = cap
    }
  }
  const norm = () => {
    const total = Object.values(score).reduce((x, y) => x + y, 0) || 1
    for (const [k] of DIMS) score[k] = Math.max(FLOOR, score[k] / total)
  }
  norm()
  norm()
  const weights = {}
  for (const [k] of DIMS) weights[k] = +score[k].toFixed(4)
  const max = Math.max(...Object.values(weights))
  const sum = +Object.values(weights).reduce((x, y) => x + y, 0).toFixed(4)
  return { weights, sum, switchable: max < 0.8, max: +max.toFixed(4) }
}

/** 嵌入函数返回空则整批作废。不传嵌入时用含义句的字面相似。 */
export function assignDims(claims, embed) {
  const out = []
  for (const c of claims || []) {
    let vec = null
    if (embed) {
      vec = vecOf(embed, c.text)
      if (!vec || !vec.length) return null
    }
    let best = null
    for (const a of anchors()) {
      let sim = 0
      if (vec) {
        let av = vecOf(embed, a.hint)
        if (!av || av.length !== vec.length) return null
        sim = cosine(vec, av)
      } else sim = lexicalSim(c.text, a.hint)
      if (!best || sim > best.sim) best = { dim: a.key, sim }
    }
    if (!best || !(best.sim > 0)) return null
    const score = Math.max(0, Number(c.pi) || 0) * (1 + (Number(c.n) || 0))
    out.push({ dim: best.dim, score, id: c.id })
  }
  return out
}

export function shadowPush(prev, day, weights) {
  const list = Array.isArray(prev) ? prev.filter((x) => x && x.day !== day) : []
  list.push({ day, weights })
  return list.slice(-14)
}

export function shadowVerdict(list) {
  const rows = Array.isArray(list) ? list : []
  const days = []
  const seen = new Set()
  for (const r of rows) {
    if (!r || seen.has(r.day)) continue
    seen.add(r.day)
    days.push(r)
  }
  if (days.length < 7) return { ok: false, reason: 'days', days: days.length }
  const last = days.slice(-7)
  for (const r of last) {
    const max = Math.max(...Object.values(r.weights || {}))
    if (max >= 0.8) return { ok: false, reason: 'collapse', days: last.length }
  }
  for (let i = 1; i < last.length; i++) {
    const a = last[i - 1].weights || {}
    const b = last[i].weights || {}
    for (const [k] of DIMS) {
      if (Math.abs((Number(b[k]) || 0) - (Number(a[k]) || 0)) > 0.02 + 1e-9) {
        return { ok: false, reason: 'move', days: last.length, key: k }
      }
    }
  }
  return { ok: true, reason: 'ready', days: last.length }
}
