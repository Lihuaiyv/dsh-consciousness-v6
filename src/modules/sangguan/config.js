/**
 * 三观引擎开关与配置：按 agent 存在 flags 表（key = sangguan:<aid>）。
 * sangguan.enabled 默认关闭；关闭时任何挂点都不得进入三观代码路径。
 * budget：三观自己的模型预算（code-guide §3.2），与 memory.llm.daily_cap 互不挤占。
 * model：light = T1、heavy = T2 / 辩证会；null = 走宿主模型，否则 { url, key?, model? } 指向兼容 /chat/completions 的端点。
 * inject：shadow = 只记录会注入什么、提示词不变；live = 真注入。默认 shadow，攒够 7 日 shadow 记录再切 live。
 */
import { getFlag, setFlag } from '../../kernel.js'

export const BUDGET_DEFAULTS = Object.freeze({
  fast: 20, mid: 30, reserve: 6, slow_week: 40, floor: 2, carry: 1.5, monthly_tokens: 3000000,
})

export const INJECT_MODES = Object.freeze(['shadow', 'live'])
// 违背检测三档：off = 不查；shadow = 只记会判成什么，不落账；live = 真记违背
export const VIOLATE_MODES = Object.freeze(['off', 'shadow', 'live'])

export const SANGGUAN_DEFAULTS = Object.freeze({
  enabled: false,
  inject: 'shadow',
  violate: 'shadow',
  lanes: Object.freeze({ W: false, L: false, V: false }),
  model: Object.freeze({ light: null, heavy: null }),
  budget: BUDGET_DEFAULTS,
})

const flagKey = (aid) => 'sangguan:' + aid

function cleanBudget(src, base = BUDGET_DEFAULTS) {
  const out = { ...base }
  if (!src || typeof src !== 'object') return out
  for (const k of Object.keys(BUDGET_DEFAULTS)) {
    const v = Number(src[k])
    if (src[k] == null || !Number.isFinite(v) || v < 0) continue
    out[k] = k === 'carry' ? Math.max(1, v) : v
  }
  return out
}

function cleanEndpoint(v) {
  if (!v || typeof v !== 'object' || typeof v.url !== 'string' || !/^https?:\/\//i.test(v.url)) return null
  const out = { url: v.url.replace(/\/+$/, '') }
  if (typeof v.key === 'string' && v.key) out.key = v.key
  if (typeof v.model === 'string' && v.model) out.model = v.model
  return out
}

function cleanModel(src, base = SANGGUAN_DEFAULTS.model) {
  const out = { light: base.light, heavy: base.heavy }
  if (!src || typeof src !== 'object') return out
  for (const k of ['light', 'heavy']) if (k in src) out[k] = cleanEndpoint(src[k])
  return out
}

function cleanReplace(src) {
  const out = { W: 'meter', L: 'meter', V: 'meter' }
  if (!src || typeof src !== 'object') return out
  for (const k of ['W', 'L', 'V']) if (src[k] === 'meter' || src[k] === 'engine') out[k] = src[k]
  return out
}

/** 三列闸的开关，默认全关：关掉时行为与改造前逐字一致。 */
function cleanLanes(src, base = SANGGUAN_DEFAULTS.lanes) {
  const out = { ...base }
  if (!src || typeof src !== 'object') return out
  for (const k of ['W', 'L', 'V']) if (k in src) out[k] = src[k] === true
  return out
}

export function sangguanConfig(db, aid) {
  let raw = {}
  try {
    const s = getFlag(db, flagKey(aid))
    raw = s ? JSON.parse(s) : {}
  } catch { raw = {} }
  return {
    enabled: raw.enabled === true,
    inject: INJECT_MODES.includes(raw.inject) ? raw.inject : SANGGUAN_DEFAULTS.inject,
    violate: VIOLATE_MODES.includes(raw.violate) ? raw.violate : SANGGUAN_DEFAULTS.violate,
    model: cleanModel(raw.model),
    budget: cleanBudget(raw.budget),
    replace: cleanReplace(raw.replace),
    lanes: cleanLanes(raw.lanes),
  }
}

export function isEnabled(db, aid) {
  return sangguanConfig(db, aid).enabled === true
}

/** 某一列的闸是否打开（默认关）。 */
export function laneOn(db, aid, lane) {
  return sangguanConfig(db, aid).lanes[lane] === true
}

export function setSangguanConfig(db, aid, patch = {}) {
  const cur = sangguanConfig(db, aid)
  const next = { ...cur }
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true
  if (INJECT_MODES.includes(patch.inject)) next.inject = patch.inject
  if (VIOLATE_MODES.includes(patch.violate)) next.violate = patch.violate
  if (patch.budget !== undefined) next.budget = cleanBudget(patch.budget, cur.budget)
  if (patch.model !== undefined) next.model = cleanModel(patch.model, cur.model)
  if (patch.replace !== undefined) next.replace = cleanReplace(patch.replace)
  if (patch.lanes !== undefined) next.lanes = cleanLanes(patch.lanes, cur.lanes)
  setFlag(db, flagKey(aid), JSON.stringify(next))
  return next
}
