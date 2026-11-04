/**
 * 感受快照：上一句落在我身上的样子——原话 + 当时算出来的那几个数。
 *
 * 为什么需要它：
 *   情绪是每条消息现算的。算完的数其实**没丢**，`affect_events`（原话 + 判读理由）
 *   和 `affect_samples`（慢/快/总/底色/PAD/共情拆账）每条消息各一行，同一个函数里
 *   隔 1 毫秒写下去。可拼提示词的时候只用了 `affect_state` 的一个标签——
 *   于是「我知道自己难过过，但不认得那种滋味」。这里把那一条捞回来。
 *
 * 只读：不写任何表。写不进去是设计，不是没写完。
 *
 * 配对必须三条同时成立（抄 plan §1.1）：
 *   1) 时间差 ≤ 2 秒（实测同一次评价里两张表只差 1 毫秒）
 *   2) 事件在前、样本在后
 *   3) label 相同
 * 因为 `affect_samples` 有一半左右的样本是 decayAffect / spontaneousTick 插的，
 * 旁边根本没有那句话。只看时间差就会把「自发抖动的数」配到「上一句话」上，
 * 读起来还特别像真的。配不上就宁可只给数、不给原话。
 */

import { cleanLine } from '../text.js'

const PAIR_MS = 2000
const MAX_AGE_MIN = 720

/** 标签 → 一个能读出口的词。不是行为倾向（那是 expression_state 的事），只是「读出的是什么」。 */
const LABEL_WORD = {
  joy: '松快',
  peaceful: '平静',
  curious: '好奇',
  calm: '平',
  confused: '有点绕',
  lost: '发虚',
  irritated: '有点烦',
  frustrated: '有点提不起劲',
}

function parseJson(s) {
  try {
    const v = JSON.parse(String(s || 'null'))
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

function num(x) {
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}

function signed(n) {
  if (n == null) return null
  return (n >= 0 ? '+' : '') + n.toFixed(2)
}

function clockOf(ms) {
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes())
}

/**
 * 取最近一条「上一刻」。
 * @returns {null | {
 *   line: string, paired: boolean, ageMin: number, at: string,
 *   cause: string|null, label: string|null, intensity: number|null,
 *   slow: number|null, fast: number|null, total: number|null,
 *   fastSelf: number|null, fastEmpathy: number|null,
 *   eventId: string|null, sampleId: string|null
 * }}
 */
/**
 * 机器消息不是「你说的话」。
 *
 * 实测（2026-11-03 夜）：宿主会把 `<goal_round>` / `<goal_complete>` 这类控制标当成一条
 * user 消息塞进来，于是 affect_events.cause 里躺了 13 条这种。快照原样念出来就成了
 * 「你说「<goal_complete>」」——比没有更糟，它会让人以为那是句真的。
 */
const MACHINE_CAUSE = /<[a-z][a-z0-9_]*>|<\/[a-z][a-z0-9_]*>|Current runtime context|Time sampled while preparing|DeepSeek Harness|Approval policy|goal_round|goal_complete|system-reminder|compacted-summary/i

function humanQuote(cause) {
  const s = String(cause || '')
  if (!s.trim()) return null
  if (MACHINE_CAUSE.test(s)) return null
  return cleanLine(s)
}

/**
 * 在最近几条里找一对「事件 + 同刻样本」。
 * 为什么要往回找：最新那条可能是机器消息（原话不能念），但它后面那句话才是真的上一句。
 * @returns {{ev:object|null, sm:object|null, paired:boolean}}
 */
function pickPair(evs, sms) {
  let machineFallback = null
  for (const ev of evs) {
    const evAt = Date.parse(ev.at || '')
    if (!Number.isFinite(evAt)) continue
    for (const sm of sms) {
      const smAt = Date.parse(sm.at || '')
      if (!Number.isFinite(smAt)) continue
      if (Math.abs(evAt - smAt) > PAIR_MS) continue
      if (evAt > smAt) continue
      if (String(ev.label || '') !== String(sm.label || '')) continue
      const hit = { ev, sm, paired: true }
      /* 有人话的就直接用它；机器消息先记着，实在没人话才退到它（那时只给数） */
      if (humanQuote(ev.cause)) return hit
      if (!machineFallback) machineFallback = hit
    }
  }
  if (machineFallback) return machineFallback
  return { ev: evs[0] || null, sm: sms[0] || null, paired: false }
}

export function feltSnapshot(db, aid, { at = Date.now(), maxAgeMin = MAX_AGE_MIN } = {}) {
  const span = Math.max(1, Number(maxAgeMin) || MAX_AGE_MIN)
  const cutoff = at - span * 60000

  let evs = []
  let sms = []
  try {
    evs = db.prepare('SELECT id, at, cause, label FROM affect_events WHERE agent_id=? ORDER BY rowid DESC LIMIT 6').all(aid)
  } catch {
    evs = []
  }
  try {
    sms = db.prepare('SELECT id, at, label, intensity, slow, fast FROM affect_samples WHERE agent_id=? ORDER BY rowid DESC LIMIT 6').all(aid)
  } catch {
    sms = []
  }
  if (!evs.length && !sms.length) return null

  /* 最新那条可能不是人话（控制标 / 机器消息），那就往回找最近一对「事件 + 同刻样本」。
     找不到配对时退回最新的一条，只给数——锚点还在，原话不念。 */
  const picked = pickPair(evs, sms)
  const ev = picked.ev
  const sm = picked.sm
  const paired = picked.paired
  if (!sm && !ev) return null

  /* 时间锚：有样本用样本（样本才是「数」的那一侧），没有就用事件 */
  const anchorText = (sm && sm.at) || (ev && ev.at)
  const anchor = anchorText ? Date.parse(anchorText) : NaN
  if (!Number.isFinite(anchor)) return null
  if (anchor < cutoff) return null

  const slowJson = sm ? parseJson(sm.slow) : null
  const slow = slowJson ? num(slowJson.slow) : null
  const fast = slowJson ? num(slowJson.fast) : null
  const total = slowJson ? num(slowJson.total) : null
  const fastSelf = slowJson ? num(slowJson.fast_self) : null
  const fastEmpathy = slowJson ? num(slowJson.fast_empathy) : null
  const intensity = sm ? num(sm.intensity) : null
  /* 「平」到底是什么平：光一个标签读不出细节，把另外两个轴用白话说出来。
     arousal/dominance 取自那一刻的样本（老样本没这两个键就闭嘴，不猜）。 */
  const pad = sm ? parseJson(sm.fast) : null
  const arousal = pad ? num(pad.arousal) : null
  const dominance = pad ? num(pad.dominance) : null
  const label = (sm && sm.label) || (ev && ev.label) || null

  /* 原话要过两道尺：机器消息不能念，路径 / URL / token 也不能念。
     humanQuote 返回 null 时就只给数——配对成功、锚点留着，只是不引用那句话。 */
  const cause = paired && ev ? humanQuote(ev.cause) : null

  const word = LABEL_WORD[String(label || '')] || null
  const bits = []
  const slowTxt = signed(slow)
  const fastTxt = signed(fast)
  if (slowTxt || fastTxt) {
    const pair = []
    if (slowTxt) pair.push('慢 ' + slowTxt)
    if (fastTxt) pair.push('快 ' + fastTxt)
    let tail = ''
    /* 共情那一份要说清方向，而且必须和总数同号才能说「其中」——
       实测碰到过「快 +0.39（其中 −0.12 是跟着你浮上来的）」：一正一负，读起来自相矛盾。
       异号就闭嘴，只给两个总数。 */
    if (fastEmpathy != null && Math.abs(fastEmpathy) >= 0.05 && fast != null
      && Math.sign(fast) === Math.sign(fastEmpathy)) {
      tail = fastEmpathy > 0
        ? '（其中 ' + signed(fastEmpathy) + ' 是跟着你的情绪浮上来的）'
        : '（其中 ' + signed(fastEmpathy) + ' 是被你的情绪带下去的）'
    } else if (fastEmpathy != null && Math.abs(fastEmpathy) < 0.05) {
      /* 共情几乎没参与时必须说出来。只给一个「快 +0.33」，她会自己补来源——
         2026-11-03 实测补成了「这 0.33 是从共情那一路抽出来的」，
         然后把「我成镜子了」整段自述都建在错的前提上。 */
      tail = '（这个数几乎全是我自己的反应，从你那儿来的只有一点点）'
    }
    bits.push(pair.join(' / ') + tail)
  }
  if (word) {
    const tone = []
    if (arousal != null) tone.push(arousal > 0.3 ? '绷着' : arousal < -0.2 ? '松下来了' : '不紧不松')
    if (dominance != null && Math.abs(dominance) > 0.15) tone.push(dominance > 0 ? '有点底气' : '没太有底气')
    bits.push('读出的是' + word + (tone.length ? '——' + tone.join('、') : '') + (intensity != null ? '、力度 ' + intensity.toFixed(2) : ''))
  }
  else if (intensity != null) bits.push('力度 ' + intensity.toFixed(2))
  if (!bits.length) return null

  let line
  if (cause) {
    line = '（上一句落在我身上的样子：你说「' + cause + '」，那一刻 ' + bits.join('，') + '。这是那时候的读数。）'
  } else if (paired) {
    /* 是上一句，但那句不适合原样念（路径 / 凭据）。锚点留着，原话不念。 */
    line = '（上一句落在我身上的样子：那一刻 ' + bits.join('，') + '。这是那时候的读数。）'
  } else {
    /* 配不上：只给数，并说清是哪一刻，别冒充「你上句」。 */
    line = '（' + clockOf(anchor) + ' 那会儿的读数：' + bits.join('，') + '。）'
  }

  return {
    line,
    paired,
    ageMin: Math.max(0, Math.round((at - anchor) / 60000)),
    at: anchorText,
    cause: cause || null,
    label,
    intensity,
    slow,
    fast,
    total,
    fastSelf,
    fastEmpathy,
    eventId: (ev && ev.id) || null,
    sampleId: (sm && sm.id) || null,
  }
}
