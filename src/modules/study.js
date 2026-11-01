/**
 * 记忆时间线 / 原话定位（前端「都补」那几件）
 *
 * 时间线：按天把「它这几天记住了什么」排出来，比平铺列表像人。
 * 原话：一条记忆来自哪一轮，点开能看那句原话与前后两句。
 *
 * 热度榜：库里存的 heat 是上次巡检的快照，这里按请求时刻现算再排序返回，
 * 页面上看到的是「此刻」的账（写库仍归夜巡 / 召回强化 / 手动重算管）。
 */

import { nowRow } from './tiers.js'
import { localDay } from './nightly.js'

/** 现算热度需要的列：缺 hits / last_hit_at / salience / mark，算出来的热度就是错的。 */
const HEAT_COLS = `id,text,type,importance,weight,heat,band,temp_state,created_at,source_turn_id,mark,hits,last_hit_at,salience`

/** ISO → 本地历日（不要 slice(0,10)：那是 UTC，中国凌晨会掉到昨天）。 */
function dayOf(iso) {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? localDay(new Date(t)) : ''
}

/**
 * 最近 N 个本地历日，每天记住了什么（只列活跃事实）。
 * 从「今天 0 点」往回 N−1 天起算，空天也占位，保证 groups 真有 N 天。
 */
export function timeline(db, aid, opt = {}) {
  const days = Math.max(1, Math.min(90, Number(opt.days) || 14))
  const at = Date.now()
  const start = new Date(at)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const since = start.toISOString()
  let rows = []
  try {
    // 不按全局 LIMIT 截断：否则近两天写得多时，更早的天会被挤出窗口，五天凑不齐。
    rows = db.prepare(`SELECT ${HEAT_COLS}
      FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND created_at>=?
      ORDER BY created_at DESC`).all(aid, since)
  } catch { rows = [] }
  const byDay = new Map()
  for (const r of rows) {
    const m = nowRow(r, at)
    const d = dayOf(m.created_at)
    if (!d) continue
    const arr = byDay.get(d) || []
    arr.push(m)
    byDay.set(d, arr)
  }
  const out = []
  for (let i = 0; i < days; i++) {
    const d = new Date(at)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const day = localDay(d)
    const items = byDay.get(day) || []
    out.push({ day, count: items.length, items })
  }
  return { days, at: new Date(at).toISOString(), total: rows.length, groups: out }
}

/** 某条记忆的原话 + 前后各两句。 */
export function turnDetail(db, aid, turnId) {
  const id = String(turnId || '')
  if (!id) return null
  const turn = db.prepare('SELECT * FROM raw_turns WHERE id=? AND agent_id=?').get(id, aid)
  if (!turn) return null
  let around = []
  try {
    around = db.prepare(`SELECT id,role,text,created_at FROM raw_turns
      WHERE agent_id=? AND session_id=? AND seq BETWEEN ? AND ? ORDER BY seq`).all(aid, turn.session_id, Number(turn.seq) - 2, Number(turn.seq) + 2)
  } catch { around = [turn] }
  return { turn, around }
}

/**
 * 事实层热度榜：按「此刻」现算，只列活着的事实。
 *
 * 先取全量现算再排；按档位配额各取一段（默认每档 limit/3），避免「总榜前 N 全是短期」
 * ——短期本该是桌面上那一小撮，中期 / 长期也要看得见。
 */
export function topMemory(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(300, Number(opt.limit) || 99))
  const perBand = Math.max(1, Math.min(limit, Number(opt.per_band) || Math.ceil(limit / 3)))
  const at = Date.now()
  let rows = []
  try {
    rows = db.prepare(`SELECT ${HEAT_COLS}
      FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL`).all(aid)
  } catch { rows = [] }
  const scored = rows
    .map((r) => nowRow(r, at))
    .sort((a, b) => (b.heat - a.heat) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
  const counts = { short: 0, mid: 0, long: 0 }
  const picked = { short: [], mid: [], long: [] }
  for (const m of scored) {
    const b = picked[m.band] ? m.band : 'mid'
    counts[b]++
    if (picked[b].length < perBand) picked[b].push(m)
  }
  // 有货的档至少留 1 条（避免 limit 截断后「计数有、列表空」），再按短→中→长填配额，最后总榜补满
  const items = []
  const seen = new Set()
  for (const b of ['short', 'mid', 'long']) {
    if (!picked[b].length || items.length >= limit) continue
    items.push(picked[b][0])
    seen.add(picked[b][0].id)
  }
  for (const m of [...picked.short, ...picked.mid, ...picked.long]) {
    if (items.length >= limit) break
    if (seen.has(m.id)) continue
    items.push(m)
    seen.add(m.id)
  }
  if (items.length < limit) {
    for (const m of scored) {
      if (seen.has(m.id)) continue
      items.push(m)
      seen.add(m.id)
      if (items.length >= limit) break
    }
  }
  return {
    limit,
    per_band: perBand,
    at: new Date(at).toISOString(),
    total: rows.length,
    counts,
    items,
  }
}

