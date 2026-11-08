// 听见 · 个人基线：一个人「平时怎么说」。
//
// 绝对音高没意义——男声 120Hz 和女声 220Hz 都是正常。有意义的是「他今天比
// 自己平时高了多少」。所以这里只做一件事：滚动地记住这个人的常态，
// 然后把这一句跟他自己的常态比。
//
// 只描述相对变化，不解释原因。「比平时高」「比平时快」是能量出来的；
// 「紧张了」「高兴了」不是——那交给上层和模型。
//
// 一行一个人。先只分 default，认人（rel_person）接上之后再按 speaker 拆。
import { now } from '../db.js'

/** 可调的四个旋钮。改这里就够，别在调用点写魔法数。 */
export const VOICE_BASELINE_TUNING = {
  // 冷启动：前 12 次只记不判（样本太少，平均值一抖就离谱）。
  // 一开始定的 5 太少了——而且开头那几句往往是最不像平常的（兴奋、凑近麦克风、
  // 话说不完整），拿它们当「平时」等于把最特别的几句当成了常态。
  warmupSamples: 12,
  // 过了冷启动之后，每次跟多少：0.15 ≈ 七次语音跟上一半
  alpha: 0.15,
  // 判「比平时」的门槛。低于这些一律不提，免得每句都在说「差不多」。
  pitchSt: 3,        // 3 个半音
  loudRatio: 0.35,   // 响度差 35%
  periodicityDelta: 0.15, // 周期性掉 0.15（更虚）
  cpsRatio: 0.3,     // 语速差 30%
}

/**
 * 读这个人的常态。没有就是 null。
 * @param {object} db
 * @param {string} agentId
 * @param {string} [speaker]
 */
export function readBaseline(db, agentId, speaker = 'default') {
  if (!db || !agentId) return null
  try {
    return db.prepare('SELECT * FROM voice_baseline WHERE agent_id=? AND speaker=?').get(agentId, speaker) || null
  } catch {
    return null // 老库还没这张表
  }
}

/**
 * 把这一段语音量进基线，并跟「之前」比一下。
 * 顺序很重要：先拿旧基线算 drift，再更新基线——不然这一句会跟自己比。
 * @param {object} db
 * @param {object} options
 * @param {string} options.agentId
 * @param {string} [options.speaker]
 * @param {object} options.shape pcmShape 的结果
 * @param {string} [options.text] 转写文字，用来估语速
 * @param {string} [options.at]
 * @returns {{ samples: number, warmed: boolean, drift: object|null }}
 */
export function applyBaseline(db, { agentId, speaker = 'default', shape, text = '', at } = {}) {
  if (!db || !agentId) return { samples: 0, warmed: false, drift: null }
  const before = readBaseline(db, agentId, speaker)
  const n = before && Number.isFinite(before.samples) ? before.samples : 0
  // 这一段不进基线：样本数照实报回去，别让对方以为基线被清零了。
  const idle = { samples: n, warmed: n > VOICE_BASELINE_TUNING.warmupSamples, drift: null }
  if (!shape || !shape.seconds) return idle
  // 太短的语音量不准（一句「嗯」也能算音高，但没有代表性），不进基线也不判。
  if (!(shape.voicedRatio >= 0.15) || !shape.pitchHz) return idle

  const cps = speechRateOf(text, shape.seconds)
  const alpha = n === 0 ? 1 : (n < VOICE_BASELINE_TUNING.warmupSamples ? 1 / (n + 1) : VOICE_BASELINE_TUNING.alpha)

  // drift 只在「已经有常态」时才算，而且拿的是更新前的旧值。
  let drift = null
  if (before) {
    drift = {
      pitchSt: ratioToSemitones(shape.pitchHz, before.pitch_hz),
      loudRatio: ratio(shape.loudness, before.loudness),
      periodicityDelta: delta(shape.periodicity, before.periodicity),
      cpsRatio: ratio(cps, before.cps),
    }
  }

  const next = {
    pitch_hz: blend(before && before.pitch_hz, shape.pitchHz, alpha),
    loudness: blend(before && before.loudness, shape.loudness, alpha),
    periodicity: blend(before && before.periodicity, shape.periodicity, alpha),
    cps: blend(before && before.cps, cps, alpha),
    samples: n + 1,
    at: at || now(),
  }

  try {
    db.prepare(`INSERT INTO voice_baseline(agent_id, speaker, pitch_hz, loudness, periodicity, cps, samples, updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id, speaker) DO UPDATE SET
        pitch_hz=excluded.pitch_hz, loudness=excluded.loudness, periodicity=excluded.periodicity,
        cps=excluded.cps, samples=excluded.samples, updated_at=excluded.updated_at`).run(
      agentId, speaker, next.pitch_hz, next.loudness, next.periodicity, next.cps, next.samples, next.at,
    )
  } catch {
    return { samples: n, warmed: false, drift: null } // 写不进去就别硬报
  }

  return {
    samples: next.samples,
    warmed: next.samples > VOICE_BASELINE_TUNING.warmupSamples,
    drift,
  }
}

/**
 * 把漂移翻成一句人话。最多说两件——说多了又变成念读数。
 * @param {object|null} drift applyBaseline 的 drift
 * @param {boolean} warmed 样本够不够
 * @returns {string} 形如「比平时高一点、比平时快」；不够格就是空串
 */
export function describeDrift(drift, warmed = true) {
  if (!drift || !warmed) return ''
  const T = VOICE_BASELINE_TUNING
  const parts = []
  if (Number.isFinite(drift.pitchSt) && Math.abs(drift.pitchSt) >= T.pitchSt) {
    parts.push(drift.pitchSt > 0 ? '比平时高' : '比平时低')
  }
  if (Number.isFinite(drift.loudRatio) && (drift.loudRatio >= 1 + T.loudRatio || drift.loudRatio <= 1 - T.loudRatio)) {
    parts.push(drift.loudRatio > 1 ? '比平时响' : '比平时轻')
  }
  if (Number.isFinite(drift.periodicityDelta) && drift.periodicityDelta <= -T.periodicityDelta) {
    parts.push('比平时虚')
  }
  if (Number.isFinite(drift.cpsRatio) && (drift.cpsRatio >= 1 + T.cpsRatio || drift.cpsRatio <= 1 - T.cpsRatio)) {
    parts.push(drift.cpsRatio > 1 ? '比平时快' : '比平时慢')
  }
  return parts.slice(0, 2).join('、')
}

/** 字/秒。标点和空白不算字。 */
export function speechRateOf(text, seconds) {
  const chars = String(text || '').replace(/[\s，。！？、,.!?…—~～]/g, '').length
  if (!(seconds > 0) || chars < 2) return null
  return chars / Math.max(0.3, seconds)
}

function blend(prev, next, alpha) {
  if (next == null || !Number.isFinite(next)) return prev == null ? null : prev
  if (prev == null || !Number.isFinite(prev)) return next
  return prev + (next - prev) * alpha
}

function ratio(next, prev) {
  if (!Number.isFinite(next) || !Number.isFinite(prev) || prev === 0) return null
  return next / prev
}

function delta(next, prev) {
  if (!Number.isFinite(next) || !Number.isFinite(prev)) return null
  return next - prev
}

/** 频率比换成半音：12·log2(now/base)。用对数是因为「高 20Hz」在男女声上不是一回事。 */
function ratioToSemitones(next, base) {
  if (!Number.isFinite(next) || !Number.isFinite(base) || base <= 0) return null
  return 12 * Math.log2(next / base)
}
