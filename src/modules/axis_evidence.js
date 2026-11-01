/**
 * 性格五轴的「证据账本」——现在只是「拔河拉力池」的一层薄适配。
 *
 * 以前这里自己算密度/自己调 setAxisAuto；v2 把数学搬到了 rope.js：
 *   证据 → 左右两个拉力池（各自衰减）→ 一边明显领先才挪一步 → 挪完泄劲 → 回弹/基线。
 * 这个文件保留旧导出（addEvidence / pending / density / snapshot / flush），
 * 目的是让关系、日记这些老调用方一行都不用改，同时全部改走双池。
 */
import { now } from '../db.js'
import { getParam } from '../kernel.js'
import { AXIS_KEYS, SOURCE_WEIGHTS } from './traits.js'
import * as rope from './rope.js'

/** 来源权重：主人一侧（养育方向）> 她自己长出来的 > 低权事件。
 *  真源在 traits.js（rope 算净力也要用），这里只是保持旧导出名。 */
export const WEIGHTS = SOURCE_WEIGHTS

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

/** 记一条证据。dir=+1 往「高」一侧（偏外向 / 偏直觉 / 偏情感 / 偏判断 / 更敏感）。 */
export function addEvidence(db, aid, { axis, dir = 1, strength = 0.5, source = 'chat', refId = null, at = null, w = null, why = null, weak = false, noFlush = false } = {}) {
  if (!AXIS_KEYS.includes(axis)) return null
  // 两种权重分开放：
  //   w      = 这一条自己的折扣（复读打五折、低权事件），进池时折进力气；
  //   来源权重 = 按 source 在 flush 时统一乘（每个来源算一票）。
  // 以前两者混在一起，judge 的 0.9 会被乘两次；现在只认单条折扣，来源权重由 rope 负责。
  const singleW = w != null && Number.isFinite(Number(w)) ? Number(w) : 1
  const r = rope.add(db, aid, {
    axis,
    dir: Number(dir) < 0 ? -1 : 1,
    strength: clamp01(strength),
    source: String(source || 'chat'),
    refId,
    w: singleW,
    at: at || now(),
    why,
    weak,
  })
  if (!r) return null
  return { id: r.id, axis, dir: r.dir, strength: r.strength, w: r.w, why: why || null, weak: !!weak, at: at || now(), source, refId }
}

/** 未参与过漂移的证据（最近的 window 条） */
export function pending(db, aid, axis, window = 20) {
  try {
    return db.prepare(`SELECT id, dir, strength, source, ref_id, at, pole, w FROM axis_evidence
      WHERE agent_id=? AND axis=? AND used=0 ORDER BY at DESC LIMIT ?`)
      .all(aid, axis, Math.max(1, Math.min(200, Number(window) || 20)))
  } catch {
    return []
  }
}

/** 单轴密度：哪边证据多、平均强度多少（调试用，不参与判定） */
export function density(db, aid, axis, window = 20) {
  const rows = pending(db, aid, axis, window)
  const up = rows.filter((r) => Number(r.dir) > 0)
  const down = rows.filter((r) => Number(r.dir) < 0)
  const avg = (arr) => (arr.length ? arr.reduce((s, r) => s + num(r.strength, 0.5), 0) / arr.length : 0)
  const side = up.length >= down.length ? up : down
  return {
    axis, total: rows.length,
    up: up.length, down: down.length,
    dir: side.length ? (Number(side[0].dir) > 0 ? 1 : -1) : 0,
    count: side.length,
    avg: Math.round(avg(side) * 1000) / 1000,
    rows: side,
  }
}

/** 把所有轴过一遍（交给 rope.flush） */
export function flush(db, aid) {
  return rope.flush(db, aid)
}

/** 清理老证据（默认 60 天前），防止表无限长 */
export function prune(db, aid, days = 60) {
  const cutoff = new Date(Date.now() - Math.max(1, Number(days) || 60) * 86400000).toISOString()
  try {
    return db.prepare('DELETE FROM axis_evidence WHERE agent_id=? AND at<?').run(aid, cutoff).changes
  } catch {
    return 0
  }
}

/** 快照（UI / 调试用）：每根轴两边各有几条、多重、净力多少 */
export function snapshot(db, aid) {
  const roped = rope.snapshot(db, aid)
  const byAxis = Object.fromEntries(roped.map((r) => [r.axis, r]))
  const window = num(getParam(db, aid, 'persona.evidence.window'), 20)
  return AXIS_KEYS.map((axis) => {
    const d = density(db, aid, axis, window)
    const r = byAxis[axis] || {}
    return {
      axis,
      total: d.total, up: d.up, down: d.down, dir: d.dir, count: d.count, avg: d.avg,
      pos: r.pos, neg: r.neg, force: r.force, base: r.base, value: r.value,
    }
  })
}

