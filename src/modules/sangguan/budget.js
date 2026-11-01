/**
 * 三观模型预算（code-guide §3.2）：自管日额，与 memory.llm.daily_cap 互不挤占。
 * 日池 fast / mid / reserve，周池 slow，月度 token 硬顶；中环另留 floor 单位保底（不受月顶限制，§12.1 无饥饿的前提）。
 * 未用额度只结转到下一日，且至多 carry 倍日额。日期一律由调用方传入（本地日 YYYY-MM-DD）。
 */
import { getFlag, setFlag } from '../../kernel.js'
import { sangguanConfig } from './config.js'

export const UNITS = Object.freeze({ T1: 1, T2: 4, DIAL: 8 })
const DOWN = { DIAL: 'T2', T2: 'T1', T1: 'T1' }
const DAY_POOLS = ['fast', 'mid', 'reserve']
export const POOLS = Object.freeze([...DAY_POOLS, 'slow'])

const DAY = 86400000
const dayMs = (d) => Date.parse(String(d).slice(0, 10) + 'T00:00:00.000Z')
export const prevDay = (d) => new Date(dayMs(d) - DAY).toISOString().slice(0, 10)

/** ISO 周：周一为一周之始，年份按该周周四所在年。 */
export function isoWeek(day) {
  const t = new Date(dayMs(day))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const y = t.getUTCFullYear()
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7)
  return y + '-W' + String(w).padStart(2, '0')
}

const base = (aid) => 'sangguan.budget:' + aid + ':'
const dayKey = (aid, d) => base(aid) + String(d).slice(0, 10)
const weekKey = (aid, d) => base(aid) + 'w:' + isoWeek(d)
const monthKey = (aid, d) => base(aid) + 'm:' + String(d).slice(0, 7)
const lastKey = (aid) => base(aid) + 'last'

function readJson(db, key) {
  try {
    const s = getFlag(db, key)
    return s ? JSON.parse(s) : null
  } catch { return null }
}
const writeJson = (db, key, v) => setFlag(db, key, JSON.stringify(v))

/** 中环的 floor 单位不进普通配额。 */
const normalCap = (pool, avail, b) => (pool === 'mid' ? Math.max(0, avail - b.floor) : avail)

function dayState(db, aid, day, b) {
  const hit = readJson(db, dayKey(aid, day))
  if (hit) return hit
  const prev = readJson(db, dayKey(aid, prevDay(day)))
  const last = getFlag(db, lastKey(aid))
  const avail = {}
  for (const p of DAY_POOLS) {
    const q = b[p]
    let carry = 0
    if (prev) carry = Math.max(0, normalCap(p, prev.avail[p], b) - prev.used[p])
    else if (last && last < prevDay(day)) carry = normalCap(p, q, b) // 中间整日未动用
    avail[p] = Math.min(b.carry * q, q + carry)
  }
  return { avail, used: { fast: 0, mid: 0, reserve: 0 }, floor: 0, tokens: 0 }
}

function saveDay(db, aid, day, st) {
  writeJson(db, dayKey(aid, day), st)
  const last = getFlag(db, lastKey(aid))
  if (!last || last < day) setFlag(db, lastKey(aid), String(day).slice(0, 10))
}

function poolView(pool, st, wk, b) {
  if (pool === 'slow') {
    const cap = b.slow_week
    const used = wk.used || 0
    return { avail: cap, cap, used, left: Math.max(0, cap - used) }
  }
  const avail = st.avail[pool]
  const cap = normalCap(pool, avail, b)
  const used = st.used[pool]
  return { avail, cap, used, left: Math.max(0, cap - used) }
}

const ratio = (v) => (v.cap > 0 ? v.left / v.cap : 0)
const monthTokens = (db, aid, day) => (readJson(db, monthKey(aid, day)) || {}).tokens || 0

export function budgetSnapshot(db, aid, day) {
  const b = sangguanConfig(db, aid).budget
  const st = dayState(db, aid, day, b)
  const wk = readJson(db, weekKey(aid, day)) || {}
  const pools = {}
  for (const p of POOLS) {
    const v = poolView(p, st, wk, b)
    pools[p] = { ...v, r: ratio(v) }
  }
  return {
    day: String(day).slice(0, 10), week: isoWeek(day), month: String(day).slice(0, 7), pools,
    floor: { cap: b.floor, used: st.floor },
    tokens: { day: st.tokens, month: monthTokens(db, aid, day), cap: b.monthly_tokens },
  }
}

/**
 * 申请一次调用的额度（立即扣减）。降级阶梯按池剩余比例 r：
 * r≥0.5 照请求；0.2≤r<0.5 起草降一级（判官不降）；0<r<0.2 只放行快环 T1；耗尽则拒。
 * floor=true 且普通额度不够时，中环可动用保底（按常规档 T1）。
 */
export function grant(db, aid, { tier, pool, day, judge = false, floor = false } = {}) {
  if (!UNITS[tier] || !POOLS.includes(pool)) return { ok: false, reason: 'invalid' }
  const b = sangguanConfig(db, aid).budget
  const st = dayState(db, aid, day, b)
  const wk = readJson(db, weekKey(aid, day)) || { used: 0 }
  const v = poolView(pool, st, wk, b)
  const r = ratio(v)
  let res
  if (b.monthly_tokens > 0 && monthTokens(db, aid, day) >= b.monthly_tokens) res = { ok: false, reason: 'monthly', r }
  else {
    let t = tier
    if (r >= 0.5) { /* 照请求 */ } else if (r >= 0.2) { if (!judge) t = DOWN[t] } else if (r > 0) {
      if (!(pool === 'fast' && t === 'T1')) res = { ok: false, reason: 'low', r }
    } else res = { ok: false, reason: 'empty', r }
    if (!res) {
      if (UNITS[t] > v.left) res = { ok: false, reason: 'empty', r }
      else {
        if (pool === 'slow') { wk.used = (wk.used || 0) + UNITS[t]; writeJson(db, weekKey(aid, day), wk) } else st.used[pool] += UNITS[t]
        saveDay(db, aid, day, st)
        return { ok: true, tier: t, units: UNITS[t], via: 'pool', r }
      }
    }
  }
  if (floor && pool === 'mid' && st.floor + UNITS.T1 <= b.floor) {
    st.floor += UNITS.T1
    saveDay(db, aid, day, st)
    return { ok: true, tier: 'T1', units: UNITS.T1, via: 'floor', r }
  }
  return res
}

/** 不扣减地按 grant 的降级阶梯走一遍调用链 [{ tier, pool, judge }]，全部放得下才为 true（不算 floor 与缓存命中）。 */
export function canAfford(db, aid, day, chain) {
  const b = sangguanConfig(db, aid).budget
  if (b.monthly_tokens > 0 && monthTokens(db, aid, day) >= b.monthly_tokens) return false
  const st = dayState(db, aid, day, b)
  const wk = readJson(db, weekKey(aid, day)) || { used: 0 }
  const left = {}
  const cap = {}
  for (const p of POOLS) { const v = poolView(p, st, wk, b); left[p] = v.left; cap[p] = v.cap }
  for (const c of chain) {
    if (!UNITS[c.tier] || !POOLS.includes(c.pool)) return false
    const r = cap[c.pool] > 0 ? left[c.pool] / cap[c.pool] : 0
    let t = c.tier
    if (r >= 0.5) { /* 照请求 */ } else if (r >= 0.2) { if (!c.judge) t = DOWN[t] } else if (!(r > 0 && c.pool === 'fast' && t === 'T1')) return false
    if (UNITS[t] > left[c.pool]) return false
    left[c.pool] -= UNITS[t]
  }
  return true
}

/** 记一次调用实际消耗的 token（估算值），计入日与月。 */
export function noteTokens(db, aid, day, tokens) {
  const n = Math.max(0, Math.round(Number(tokens) || 0))
  if (!n) return
  const b = sangguanConfig(db, aid).budget
  const st = dayState(db, aid, day, b)
  st.tokens += n
  saveDay(db, aid, day, st)
  const m = readJson(db, monthKey(aid, day)) || { tokens: 0 }
  m.tokens += n
  writeJson(db, monthKey(aid, day), m)
}
