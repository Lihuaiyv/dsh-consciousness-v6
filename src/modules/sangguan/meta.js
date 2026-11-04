/**
 * 命题的扩展字段（meta_json）。
 *
 * 为什么放在 persona_claims 的一列里而不是新表：命题不可变，这些字段在创建时写一次就够；
 * 扩成 JSON 列不用改表结构、不用迁移旧数据，读时缺省即可。
 *
 * 约定：所有字段都可有可无；没有就是默认值。这里只做清洗与默认，不碰库。
 */

export const META_KEYS = Object.freeze([
  'scene',        // 适用场景：什么时候会被碰到
  'expectation',  // 对世界/对方的可检验预期（W 必填）
  'observe',      // 怎么观察这条预期落没落
  'falsifier',    // 什么情况算它错了
  'direction',    // 方向（L 用）
  'foregone',     // 放弃的是什么（V 用）
  'investment',   // 投入证据 [{ref,kind,at}]
  'variants',     // 同一取舍的其他说法 [{text,claim_id,at}]
  'derives',      // 这条推出了哪些下条 id
  'lane_phase',   // W-nightly / L-weekly / V-draft / V-fast
])

export const DEFAULT_META = Object.freeze({
  scene: [], expectation: null, observe: null, falsifier: null, direction: null, foregone: null,
  investment: [], variants: [], derives: [], lane_phase: null,
})

const MAX_TEXT = 300
const MAX_LIST = 12

const s = (v, max = MAX_TEXT) => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? (t.length > max ? t.slice(0, max) : t) : null
}
const arr = (v) => (Array.isArray(v) ? v : [])

/**
 * 清洗：只保留白名单字段，去掉空值，超长截断。
 * 返回 null 表示形状完全不对（调用方据此拒收），返回 {} 表示「没有扩展字段」。
 */
export function normalizeMeta(raw) {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  const scene = arr(raw.scene).map((x) => s(x, 120)).filter(Boolean).slice(0, MAX_LIST)
  if (scene.length) out.scene = scene
  for (const k of ['expectation', 'observe', 'falsifier', 'direction', 'foregone']) {
    const v = s(raw[k])
    if (v) out[k] = v
  }
  const inv = arr(raw.investment).map((x) => {
    const ref = s(x && x.ref, 120)
    if (!ref) return null
    return { ref, kind: s(x.kind, 20) || 'invest', at: s(x.at, 40) || null }
  }).filter(Boolean).slice(0, MAX_LIST)
  if (inv.length) out.investment = inv
  const vars = arr(raw.variants).map((x) => {
    const text = s(x && x.text, 120)
    if (!text) return null
    return { text, claim_id: s(x.claim_id, 80) || null, at: s(x.at, 40) || null }
  }).filter(Boolean).slice(0, MAX_LIST)
  if (vars.length) out.variants = vars
  const der = arr(raw.derives).map((x) => s(x, 80)).filter(Boolean).slice(0, MAX_LIST)
  if (der.length) out.derives = der
  const phase = s(raw.lane_phase, 20)
  if (phase && ['W-nightly', 'L-weekly', 'V-fast', 'V-draft'].includes(phase)) out.lane_phase = phase
  return out
}

/** 读一条命题的 meta：缺省补全，坏 JSON 当作空。 */
export function metaOf(claim) {
  const m = claim && claim.meta
  if (!m || typeof m !== 'object') return { ...DEFAULT_META }
  return { ...DEFAULT_META, ...m }
}

export function sceneOf(claim) {
  return metaOf(claim).scene
}

/** 这条命题有没有「可检验预期」——W 的硬闸用它。 */
export function testableOf(claim) {
  const m = metaOf(claim)
  return !!(m.expectation && m.observe)
}
