/**
 * 回读自己刚才那句话（P0 的第三小步）。
 *
 * 宿主只在 session/event 里旁听，不能改出站文本，所以退一步做**回读**：
 * 她说完之后，看这句话本身的温度，跟自己当时的情绪对一对。
 *
 * 但「语气」不是「情绪」。2016 年 17 个实验室的注册重复实验没能复现
 * 「摆出表情 → 改变情绪」这条路（Perspectives on Psychological Science），
 * 而之前这里把「说得多暖」直接灌进慢情绪，结果是：她越会哄人，长期情绪越高，
 * 最后卡在「语气温度 − 死区」那条线上，怎么都不回水位。
 *
 * 现在的分工：
 *   - 语气只碰**快情绪**（当下这一下，≤0.02/轮），因为那本来就是此刻的脸；
 *   - 慢情绪只认事件、共情和水位，不认「她刚才把话说得多好听」；
 *   - 慢情绪和 slow_at 一概不写——写了就会把回弹的时间窗口切碎。
 *
 * 纯读文本 + 最多一处写库；不调模型。
 */

import { getParam } from '../kernel.js'

const CLAMP = (x, lo, hi) => Math.max(lo, Math.min(hi, Number(x) || 0))
const r3 = (x) => Math.round(CLAMP(x, -1, 1) * 1000) / 1000

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
 * 回读一次回复：只碰快情绪，不碰慢情绪。
 * @returns {{observed:number|null, warmth:number|null, delta:number, applied:boolean, reason?:string}}
 */
export function applySelfRead(db, aid, text, { at = Date.now() } = {}) {
  let on = 'on'
  try { on = String(getParam(db, aid, 'affect.selfread') ?? 'on') } catch { on = 'on' }
  if (on === 'off') return { observed: null, warmth: null, delta: 0, applied: false, reason: 'off' }
  const r = readReplyTone(text)
  if (!r) return { observed: null, warmth: null, delta: 0, applied: false, reason: 'empty' }
  // 太短的一句读不出东西（「嗯」「好」），不据此改任何东西
  if (r.flat) return { observed: r.warmth, warmth: r.warmth, delta: 0, applied: false, reason: 'flat' }
  let cur = null
  try { cur = db.prepare('SELECT slow, fast FROM affect_v3 WHERE agent_id=?').get(aid) } catch { cur = null }
  if (!cur) return { observed: r.warmth, warmth: r.warmth, delta: 0, applied: false, reason: 'no_state' }
  const fast = CLAMP(cur.fast, -1, 1)
  const slow = CLAMP(cur.slow, -1, 1)
  if (Math.abs(r.warmth - fast) < 0.35) return { observed: r.warmth, warmth: r.warmth, delta: 0, applied: false, reason: 'close' }
  let delta = 0.05 * (r.warmth - fast)
  // 向下修正只取一半：防「说得冷淡 → 更低落 → 更冷淡」的自锁
  if (r.warmth < fast) delta *= 0.5
  delta = Math.round(CLAMP(delta, -0.02, 0.02) * 1000) / 1000
  const nextFast = r3(fast + delta)
  const total = r3(slow + 0.35 * nextFast)
  try {
    /* 只写快情绪：慢情绪和 slow_at 一概不碰 */
    db.prepare('UPDATE affect_v3 SET fast=?, total=?, fast_at=? WHERE agent_id=?')
      .run(nextFast, total, new Date(at).toISOString(), aid)
  } catch { return { observed: r.warmth, warmth: r.warmth, delta: 0, applied: false, reason: 'write_failed' } }
  return { observed: r.warmth, warmth: r.warmth, delta, applied: true, fast: nextFast }
}
