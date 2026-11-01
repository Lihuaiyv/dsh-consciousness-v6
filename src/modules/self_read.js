/**
 * 回读自己刚才那句话（P0 的第三小步）。
 *
 * 计划里原本想让模型「先说一行 feel，再正文」，但插件拿不到出站文本的改写接缝
 * （宿主只在 session/event 里旁听，不能改回复），所以退一步做**回读**：
 * 她说完之后，看这句话本身的温度，跟自己当时的慢情绪对一对；
 * 差得远就以说出来的为准，往那边挪一点点（最多 ±0.03/轮）。
 *
 * 为什么不是「一句话决定情绪」：慢情绪半衰期 6 小时，单句权重必须很小；
 * 而且向下修正只取一半——不然一句冷淡的回复会把低落越锁越死。
 *
 * 纯读文本 + 一处写库；不调模型。
 */

import { now } from '../db.js'
import { getParam } from '../kernel.js'

const CLAMP = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

/** 语气词 / 收尾标点 → 粗略温度。只认字面，不做语义判断。 */
const WARM_WORDS = /[哈嘿呀啦呢嘛哦嗯呜哇哎哟~～♪❤]/g
const COOL_WORDS = /(算了|随便|不知道|没什么)/g

/**
 * 读一句话的温度。
 * @returns {{len:number, warmth:number, flat:boolean, warm:number, cool:number}|null}
 */
export function readReplyTone(text) {
  const t = String(text || '').trim()
  if (!t) return null
  const len = [...t].length
  const warm = (t.match(WARM_WORDS) || []).length
  const cool = (t.match(COOL_WORDS) || []).length
  const excl = (t.match(/[!！]/g) || []).length
  const endFlat = /[。.]$/.test(t) && len <= 10
  // 基准 0；长一点、热一点往上，短促冷淡往下
  let score = 0
  score += Math.min(0.45, len / 120)
  score += Math.min(0.35, warm * 0.12)
  score += Math.min(0.15, excl * 0.05)
  score -= Math.min(0.5, cool * 0.25)
  if (endFlat) score -= 0.2
  const warmth = Math.round(CLAMP(score, -1, 1) * 100) / 100
  return { len, warmth, flat: len <= 6, warm, cool }
}

/**
 * 回读并入慢情绪。差得不多就不动（避免每轮都抖）。
 * @returns {{observed:number|null, delta:number, applied:boolean, reason?:string}}
 */
export function applySelfRead(db, aid, text, { at = Date.now() } = {}) {
  let on = 'on'
  try { on = String(getParam(db, aid, 'affect.selfread') ?? 'on') } catch { on = 'on' }
  if (on === 'off') return { observed: null, delta: 0, applied: false, reason: 'off' }
  const r = readReplyTone(text)
  if (!r) return { observed: null, delta: 0, applied: false, reason: 'empty' }
  // 太短的一句读不出东西（「嗯」「好」），不据此改情绪
  if (r.flat) return { observed: r.warmth, delta: 0, applied: false, reason: 'flat' }
  let cur = null
  try { cur = db.prepare('SELECT slow, fast FROM affect_v3 WHERE agent_id=?').get(aid) } catch { cur = null }
  if (!cur) return { observed: r.warmth, delta: 0, applied: false, reason: 'no_state' }
  const slow = CLAMP(Number(cur.slow) || 0, -1, 1)
  if (Math.abs(r.warmth - slow) < 0.25) return { observed: r.warmth, delta: 0, applied: false, reason: 'close' }
  let delta = 0.06 * (r.warmth - slow)
  // 向下修正只取一半：防「冷淡 → 更低落 → 更冷淡」的自锁
  if (r.warmth < slow) delta *= 0.5
  delta = Math.round(CLAMP(delta, -0.03, 0.03) * 1000) / 1000
  const nextSlow = Math.round(CLAMP(slow + delta, -1, 1) * 1000) / 1000
  const fast = Number(cur.fast) || 0
  const total = Math.round(CLAMP(nextSlow + 0.35 * fast, -1, 1) * 1000) / 1000
  try {
    db.prepare('UPDATE affect_v3 SET slow=?, total=?, slow_at=? WHERE agent_id=?')
      .run(nextSlow, total, new Date(at).toISOString(), aid)
  } catch { return { observed: r.warmth, delta: 0, applied: false, reason: 'write_failed' } }
  return { observed: r.warmth, delta, applied: true, slow: nextSlow }
}
