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

/** 现算热度需要的列：缺 hits / last_hit_at / salience / mark，算出来的热度就是错的。 */
const HEAT_COLS = `id,text,type,importance,weight,heat,band,temp_state,created_at,source_turn_id,mark,hits,last_hit_at,salience`

function dayOf(iso) { return String(iso || '').slice(0, 10) }

/** 最近 N 天，每天记住了什么（只列活跃事实）。 */
export function timeline(db, aid, opt = {}) {
  const days = Math.max(1, Math.min(90, Number(opt.days) || 14))
  const at = Date.now()
  const since = new Date(at - days * 86400000).toISOString()
  let rows = []
  try {
    rows = db.prepare(`SELECT ${HEAT_COLS}
      FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND created_at>=?
      ORDER BY created_at DESC LIMIT 400`).all(aid, since)
  } catch { rows = [] }
  const byDay = new Map()
  for (const r of rows) {
    const m = nowRow(r, at)
    const d = dayOf(m.created_at)
    const arr = byDay.get(d) || []
    arr.push(m)
    byDay.set(d, arr)
  }
  const out = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, items]) => ({ day, count: items.length, items }))
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
 * 事实层里热度最高的 N 条：按「此刻」的热度排，只列活着的事实。
 *
 * 先取全量（活跃事实通常几千条以内，纯 JS 算一遍是毫秒级），现算再排序，
 * 这样不会因为库里存的是昨天的快照而把今天刚被想起来的那条排到后面。
 */
export function topMemory(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(300, Number(opt.limit) || 99))
  const at = Date.now()
  let rows = []
  try {
    rows = db.prepare(`SELECT ${HEAT_COLS}
      FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL`).all(aid)
  } catch { rows = [] }
  const items = rows
    .map((r) => nowRow(r, at))
    .sort((a, b) => (b.heat - a.heat) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, limit)
  return { limit, at: new Date(at).toISOString(), total: rows.length, items }
}

