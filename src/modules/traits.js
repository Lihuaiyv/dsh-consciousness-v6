/**
 * 性格五轴：E/I、S/N、T/F、J/P、敏感 ↔ 钝感。
 *
 * 存的是 0~1 连续值，0.5 = 中间；「敏感 / 钝感」只是界面投影，不是二值。
 * 依据 4-性格统筹-v2：四轴借 MBTI 的名字，不借它的二分类；敏感是第五条轴，
 * 自己有幅度 / 恢复 / 门槛三条主效应，而不是只当放大器。
 *
 * 所有写入都走这里：一次 ≤ min(学习速率, 单次步幅上限)、同轴 6 轮冷却、回中要连续两次（迟滞）。
 * 手写（origin='manual'）的值不自动漂，交回给经历才能恢复 auto。
 */
import { now } from '../db.js'
import { nid, getFlag, setFlag, getParam } from '../kernel.js'
import { ampFor, AMP_BASE, AMP_SPAN, AMP_GAIN } from '../algo/baseline.js'

export const AXES = [
  ['ei', 'E/I', '偏外向', '偏内向'],
  ['sn', 'S/N', '偏实感', '偏直觉'],
  ['tf', 'T/F', '偏思考', '偏情感'],
  ['jp', 'J/P', '偏判断', '偏知觉'],
  ['sensitivity', '敏感', '敏感', '钝感'],
]

export const AXIS_KEYS = AXES.map((a) => a[0])
export const NEUTRAL = 0.5
// 出生初值：E/I 站在 0.60（刚过 60/40，演示与默认都写得出一个 E）；
// 敏感度站在 0.80（偏高：同一件事更响、小事更容易算数、恢复更慢，情绪起伏看得出戏剧性）；
// 其余 0.50。0.50 仍是「中间」带；0.60 / 0.80 只是轻轻偏出，不是二值。
export const AXIS_DEFAULTS = { ei: 0.6, sn: 0.5, tf: 0.5, jp: 0.5, sensitivity: 0.8 }
export const STEP = 0.05
export const COOLDOWN_ROUNDS = 6
export const MID = 0.05

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d
}
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

export function axisPath(key) {
  return 'axis.' + key
}

export function isAxisPath(p) {
  return /^axis\.(ei|sn|tf|jp|sensitivity)$/.test(String(p || ''))
}

/**
 * 缺口维 → 哪条轴在推它（gate 11 用）。
 * 只算单轴表达度、不要求「被戳中」——想要本身就算触发。返回 tanh 后的小幅偏置。
 */
export function driveAmp(axes = {}, dim) {
  const d = (k) => num(axes[k], NEUTRAL) - NEUTRAL
  const m = { R: -d('tf'), E: d('sn'), C: -d('tf'), A: -d('jp'), S: d('sensitivity') }[dim]
  if (!m) return 0
  return Math.tanh(1.2 * 0.6 * m)
}

/** 五条轴 + 来源，缺省用出生初值 / auto */
export function axisRows(db, aid) {
  const out = {}
  for (const k of AXIS_KEYS) out[k] = { key: k, value: AXIS_DEFAULTS[k] ?? NEUTRAL, origin: 'auto' }
  let rows = []
  try { rows = db.prepare("SELECT path,value,origin FROM persona WHERE agent_id=? AND path LIKE 'axis.%'").all(aid) } catch { rows = [] }
  for (const r of rows) {
    const k = String(r.path).slice(5)
    if (!out[k]) continue
    out[k].value = num(r.value, NEUTRAL)
    out[k].origin = r.origin || 'auto'
  }
  return out
}

/** { ei, sn, tf, jp, sensitivity } */
export function readAxes(db, aid) {
  const rows = axisRows(db, aid)
  const out = {}
  for (const k of AXIS_KEYS) out[k] = rows[k].value
  return out
}

export function isMid(v) {
  // 按「百分位整数」比，避免 0.45 在 IEEE 下变成 0.4499… 被判成中间
  const cents = Math.round(Number(v) * 100)
  if (!Number.isFinite(cents)) return true
  return Math.abs(cents - Math.round(NEUTRAL * 100)) < Math.round(MID * 100)
}

/** 只写「偏」的那几条；全中间时给一句兜底 */
export function axisWords(axes = {}) {
  const words = []
  for (const [k, , hi, lo] of AXES) {
    const v = num(axes[k], NEUTRAL)
    if (isMid(v)) continue
    words.push(v > NEUTRAL ? hi : lo)
  }
  return words.length ? words.join(' · ') : '中间'
}

/** 展示用字母（只读投影，永远不写库） */
export function axisLetters(axes = {}) {
  const pick = (k, hi, lo) => (num(axes[k], NEUTRAL) > NEUTRAL + MID ? hi : num(axes[k], NEUTRAL) < NEUTRAL - MID ? lo : 'X')
  return pick('ei', 'E', 'I') + pick('sn', 'S', 'N') + pick('tf', 'T', 'F') + pick('jp', 'J', 'P')
}

/**
 * 大框用的类型投影：四字母 + 标签强度（0~1）。
 * 它是「标签」不是新状态：四个轴还是唯一真源；强度 = 四轴偏离 0.5 的平均幅度。
 */
const POLES = { ei: ['I', 'E'], sn: ['S', 'N'], tf: ['F', 'T'], jp: ['P', 'J'] }
// 显示阈值：偏过 60/40 才写字母。用 1e-9 的余量，避免 0.6-0.5 = 0.0999… 被浮点判成没过线。
const SHOW_LEAN = 0.1 - 1e-9
/**
 * 显不显字，按「页面上显示出来的两位小数」判，而不是原始值。
 * 轴会慢慢漂（0.598、0.599），右边那列 toFixed(2) 已经写着 0.60；
 * 老规则拿原始 lean 比 0.1，就会出现「写着 0.60 却没有 E」——这就是字母消失的那天。
 */
export function typeProfile(axes = {}) {
  const letters = []
  let sum = 0
  for (const k of ['ei', 'sn', 'tf', 'jp']) {
    const v = num(axes[k], NEUTRAL)
    const d = v - NEUTRAL
    const lean = Math.abs(d)
    sum += lean
    const shown = Math.round(v * 100) / 100
    const shownLean = Math.abs(shown - NEUTRAL)
    letters.push({
      axis: k, letter: d >= 0 ? POLES[k][1] : POLES[k][0], mid: lean < MID,
      show: shownLean >= SHOW_LEAN, value: v, shown,
    })
  }
  const strength = Math.max(0, Math.min(1, (sum / 4) / 0.5))
  return { letters, name: letters.map((x) => x.letter).join(''), strength, mids: letters.filter((x) => x.mid).length }
}

/**
 * MBTI 效应的一句话表达倾向：只取偏出显示阈值的轴，拼成「怎么说」。
 * 它不新增状态，四轴仍是唯一真源；设置里 on 时由宿主注入系统提示。
 */
const MBTI_STYLE = {
  ei: { hi: '多说一点、带点热度', lo: '收着说、先听' },
  sn: { hi: '多给联想和比喻', lo: '说具体的事' },
  tf: { hi: '先讲道理和结论', lo: '先接住感受' },
  jp: { hi: '给结论和下一步', lo: '留一点弹性' },
}

export function mbtiStyleLine(axes = {}) {
  const t = typeProfile(axes)
  const words = []
  for (const x of t.letters) {
    const pair = MBTI_STYLE[x.axis]
    if (!x.show || !pair) continue
    words.push(x.letter === POLES[x.axis][1] ? pair.hi : pair.lo)
  }
  return words.join('、')
}

/**
 * 注入用的一整句：MBTI：ENTJ 多说一点、带点热度。
 * 四字母给模型一个整体印象，后面的短语只来自真正偏出的轴；
 * 四轴全在中间时不注入，避免拿一个假类型去演。
 */
export function mbtiPromptLine(axes = {}) {
  const style = mbtiStyleLine(axes)
  if (!style) return ''
  const t = typeProfile(axes)
  // 只写真正偏出阈值的字母：没有的轴不写，轴漂了下一轮自动跟着变。
  const name = t.letters.filter((x) => x.show).map((x) => x.letter).join('')
  return 'MBTI：' + name + ' ' + style
}

/**
 * 敏感度 → 三条主效应的系数。
 * 这里的数字是「刻度」，也是设置页滑杆旁边那几行预告的唯一真源：
 *   摆幅 = ampFor(σ) × AMP_GAIN（情绪底色每段摆多大）
 *   门槛 = 0.55 − 0.25σ（多小的事才算事；越低越容易被戳到）
 *   恢复 = 1 + 0.60σ（乘在情绪半衰期上；越大越难散）
 * σ=0.5 是中性点：摆幅 0.30 / 门槛 0.425 / 恢复 ×1.30。
 */
export const SENS_CURVE = Object.freeze({
  base: AMP_BASE, span: AMP_SPAN, gain: AMP_GAIN,
  thBase: 0.55, thSlope: 0.25,
  halfBase: 1, halfSlope: 0.6,
  mulBase: 0.85, mulSlope: 0.30,
})

export function sensitivityOf(axes = {}) {
  const s = num(axes.sensitivity, NEUTRAL)
  const c = SENS_CURVE
  return {
    sigma: s,
    amp: c.mulBase + c.mulSlope * s,       // 幅度：同一件事多响
    halfLife: c.halfBase + c.halfSlope * s, // 恢复：乘在情绪半衰期上
    threshold: c.thBase - c.thSlope * s,    // 门槛：小事算不算
  }
}

const r3 = (x) => Math.round(Number(x) * 1000) / 1000

/** 设置页用：某个 σ 实际会带来什么（摆幅 / 门槛 / 恢复） */
export function sensitivityEffects(sensitivity) {
  const s = num(sensitivity, NEUTRAL)
  const e = sensitivityOf({ sensitivity: s })
  return {
    sigma: r3(s),
    swing: r3(ampFor(s) * AMP_GAIN),
    threshold: r3(e.threshold),
    halfLife: r3(e.halfLife),
    intensity: r3(e.amp),
  }
}

/** 设置页的「情绪设置 · 敏感度」整块数据；曲线也带上，前端拖滑杆时能立刻算预告 */
export function axesView(db, aid) {
  const rows = axisRows(db, aid)
  return {
    default: AXIS_DEFAULTS.sensitivity,
    curve: { ...SENS_CURVE },
    effects: sensitivityEffects(rows.sensitivity.value),
    axes: AXES.map(([key, label, hi, lo]) => ({
      key, label, hi, lo,
      value: rows[key].value,
      origin: rows[key].origin,
    })),
  }
}

/** 手调一条轴：写 manual，之后不再自动漂（要恢复交给 releaseAxis） */
export function setAxisManual(db, aid, key, value, why = '手调') {
  if (!AXIS_KEYS.includes(key)) return null
  return writeAxis(db, aid, key, value, 'manual', why)
}

/** 交回给经历：保留当前值，把 origin 改回 auto，让它重新能自己漂 */
export function releaseAxis(db, aid, key, why = '交回经历') {
  if (!AXIS_KEYS.includes(key)) return null
  const cur = axisRows(db, aid)[key]
  db.prepare('UPDATE persona SET origin=?, updated_at=? WHERE agent_id=? AND path=?')
    .run('auto', now(), aid, axisPath(key))
  try {
    const cid = nid('chg_')
    db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(cid, null, aid, 'persona.' + axisPath(key), String(cur.value), String(cur.value), now(), 'system', 'user', 'manual:unlock', null, null)
    const w = String(why || '').slice(0, 80)
    if (w) db.prepare('INSERT OR REPLACE INTO change_reasons VALUES(?,?,?,?)').run(cid, aid, w, now())
  } catch { /* changes 表不可用时不影响解锁 */ }
  return { key, path: axisPath(key), value: cur.value, origin: 'auto' }
}

/** 意图的存活时长（天）：过了就失效，避免一句「你该更外向」管一辈子 */
export const INTENT_DAYS = 7

/**
 * 自陈意图：用户直说「你该更外向点」。
 * 它不写 persona 轴（不锁死），只当一阵子的牵引方向，由证据来兑现。
 */
export function setAxisIntent(db, aid, key, target, days = INTENT_DAYS) {
  if (!AXIS_KEYS.includes(key)) return { changed: false, skipped: 'unknown-axis' }
  const t = Number(target)
  if (!Number.isFinite(t) || t < 0 || t > 1) return { changed: false, skipped: 'bad-target' }
  const span = Math.max(1, Math.min(30, Number(days) || INTENT_DAYS))
  try {
    setFlag(db, 'axis.intent:' + key + ':' + aid, JSON.stringify({ target: Math.round(t * 1000) / 1000, at: now(), days: span }))
  } catch {
    return { changed: false, skipped: 'no-flag' }
  }
  return { changed: true, key, target: t, days: span }
}

/** 读意图；过期 / 不存在都返回 null */
export function getAxisIntent(db, aid, key) {
  let raw = null
  try { raw = getFlag(db, 'axis.intent:' + key + ':' + aid) } catch { return null }
  if (!raw) return null
  let o = null
  try { o = JSON.parse(raw) } catch { return null }
  const at = Date.parse(o && o.at)
  const days = Number(o && o.days) || INTENT_DAYS
  if (!Number.isFinite(at) || Date.now() - at > days * 86400000) return null
  const t = Number(o.target)
  return Number.isFinite(t) ? t : null
}

export function clearAxisIntent(db, aid, key) {
  try { setFlag(db, 'axis.intent:' + key + ':' + aid, '') } catch { /* ignore */ }
  return { cleared: true, key }
}

/** 刺激强度 S：全部取自 appraisal 现成字段，零 LLM */
export function stimulusStrength(appraisal = {}, ownerCloseness = 0.5) {
  const gc = Math.abs(Number(appraisal.goal_congruence) || 0)
  const nov = Number(appraisal.novelty) || 0
  const cert = Number.isFinite(Number(appraisal.certainty)) ? Number(appraisal.certainty) : 0.5
  const rel = Number(appraisal.goal_relevance) || 0
  return clamp01(0.30 * gc + 0.25 * nov + 0.20 * (1 - cert) + 0.15 * rel + 0.10 * Number(ownerCloseness || 0))
}

/** 这句在戳哪条轴（0/1）；只认字面，不认「感觉」 */
const TRIG = {
  ei: /你在吗|在不在|冷场|没人|一起|聊聊|我走了|别走/,
  sn: /为什么|比如|打个比方|新|没试过|好像|感觉|细节/,
  tf: /你|对我|喜欢|讨厌|抱歉|对不起|过分|应该|委屈/,
  jp: /计划|安排|改|来不及|随便|都行|必须|今天|之后/,
}

export function triggerTable(text) {
  const t = String(text || '')
  const out = { ei: 0, sn: 0, tf: 0, jp: 0 }
  for (const k of Object.keys(TRIG)) if (TRIG[k].test(t)) out[k] = 1
  return out
}

/**
 * 四轴的表达度 A：被戳中的轴才加，没戳到贡献 0。
 * S < 门槛 时直接 A=0——「敏感只给幅度，不给 valence」。
 */
export function traitAmp(axes = {}, trig = {}, S = 0) {
  const { sigma, threshold } = sensitivityOf(axes)
  if (S < threshold) return { A: 0, why: [], sigma, threshold }
  const d = {}
  for (const k of ['ei', 'sn', 'tf', 'jp']) d[k] = num(axes[k], NEUTRAL) - NEUTRAL
  const a = { ei: 0.9, sn: 0.7, tf: 1.3, jp: 1.0 }
  const w = { ei: 0.30, sn: 0.30, tf: 0.20, jp: 0.20 }
  const why = []
  let A = 0
  for (const k of ['ei', 'sn', 'tf', 'jp']) {
    if (!trig[k] || Math.abs(d[k]) < 0.02) continue
    // 用 |d|：往哪一极偏都算「这个人格响起来」，方向交给标签 / 措辞，不给强度
    const e = Math.abs(d[k]) * (0.4 + 1.2 * Math.pow(sigma, a[k]))
    A += w[k] * e
    why.push(k)
  }
  return { A: 2.0 * A, why, sigma, threshold }
}

export function turnRounds(db, aid) {
  try { return Number(db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE agent_id=? AND role='user'").get(aid).n || 0) } catch { return 0 }
}

/**
 * 一次自动漂移的实际步幅：学习速率与单次步幅上限取小。
 * 两个参数都走 getParam（默认 0.05 / 0.15），所以默认行为和写死 STEP 时一致；
 * 调小学习速率会真的变慢，调大也只到大上限为止。
 */
function moveStep(db, aid) {
  let learn = STEP
  let cap = STEP
  try {
    const v = Number(getParam(db, aid, 'persona.learn_rate'))
    if (Number.isFinite(v) && v > 0) learn = v
  } catch { /* 老库没有参数表 */ }
  try {
    const v = Number(getParam(db, aid, 'persona.step_cap'))
    if (Number.isFinite(v) && v > 0) cap = v
  } catch { /* 老库没有参数表 */ }
  return Math.max(0.002, Math.min(learn, cap, 0.5))
}

function writeAxis(db, aid, key, value, origin, why) {
  const path = axisPath(key)
  const before = axisRows(db, aid)[key]
  const v = Math.round(num(value, NEUTRAL) * 1000) / 1000
  db.prepare('INSERT OR REPLACE INTO persona VALUES(?,?,?,?,?)').run(aid, path, String(v), origin, now())
  // 原因进 change_reasons，不进 rolled_back_at：那一列是「什么时候被撤销的」，
  // 写说明文字会让统计误判成回滚（曾经就是这么坏的）。
  const cid = nid('chg_')
  try {
    db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(cid, null, aid, 'persona.' + path, String(before.value), String(v), now(), 'system', 'system', origin, null, null)
    const w = String(why || '').slice(0, 80)
    if (w) db.prepare('INSERT OR REPLACE INTO change_reasons VALUES(?,?,?,?)').run(cid, aid, w, now())
  } catch { /* changes 表不可用时不影响写入 */ }
  return { path, key, before: before.value, after: v, origin, why: why || '' }
}

/**
 * 自动漂移：一次 ≤ 学习速率（受单次步幅上限封顶）、同轴 6 轮冷却、回中要连续两次。
 * 两个上限都是实例参数（设置 → 鱼格），默认 0.05 / 0.15，所以默认行为和以前一样。
 * 返回 { changed, skipped? }
 */
export function setAxisAuto(db, aid, key, delta, why) {
  if (!AXIS_KEYS.includes(key)) return { changed: false, skipped: 'unknown-axis' }
  const rows = axisRows(db, aid)
  const cur = rows[key]
  if (cur.origin === 'manual') return { changed: false, skipped: 'manual' }
  const rounds = turnRounds(db, aid)
  try {
    const last = Number(getFlag(db, 'axis.round:' + key + ':' + aid) || 0)
    if (rounds - last < COOLDOWN_ROUNDS) return { changed: false, skipped: 'cooldown' }
  } catch { /* ignore */ }
  let d = Number(delta) || 0
  // 有意图时方向听意图的（幅度仍沿用这次证据，步幅照旧受上限约束）
  const intent = getAxisIntent(db, aid, key)
  if (intent != null) {
    const gap = intent - cur.value
    if (Math.abs(gap) >= 1e-6) d = Math.sign(gap) * Math.min(Math.abs(d) || moveStep(db, aid), Math.abs(gap))
  }
  const step = moveStep(db, aid)
  const clamped = Math.max(-step, Math.min(step, d))
  const next = num(cur.value + clamped, cur.value)
  if (Math.abs(next - cur.value) < 1e-6) return { changed: false, skipped: 'noop' }
  // 迟滞：往中间回要连续两次
  const toMid = Math.abs(next - NEUTRAL) < Math.abs(cur.value - NEUTRAL)
  if (toMid) {
    let n = 0
    try { n = Number(getFlag(db, 'axis.hyst:' + key + ':' + aid) || 0) } catch { n = 0 }
    if (n < 1) {
      try { setFlag(db, 'axis.hyst:' + key + ':' + aid, String(n + 1)) } catch { /* ignore */ }
      return { changed: false, skipped: 'hysteresis' }
    }
    try { setFlag(db, 'axis.hyst:' + key + ':' + aid, '0') } catch { /* ignore */ }
  }
  const out = writeAxis(db, aid, key, next, 'auto', why)
  try { setFlag(db, 'axis.round:' + key + ':' + aid, String(rounds)) } catch { /* ignore */ }
  return { changed: out.before !== out.after, ...out }
}

/** 长期没变化：10 天没动过，之后每次回 2% 到 0.5（只动 auto） */
export function shrinkAxes(db, aid) {
  const rows = db.prepare("SELECT * FROM persona WHERE agent_id=? AND origin='auto' AND path LIKE 'axis.%'").all(aid)
  const out = []
  for (const r of rows) {
    const key = String(r.path).slice(5)
    if (!AXIS_KEYS.includes(key)) continue
    const v = Number(r.value)
    if (!Number.isFinite(v)) continue
    const last = db.prepare('SELECT applied_at FROM changes WHERE agent_id=? AND field=? ORDER BY applied_at DESC LIMIT 1').get(aid, 'persona.' + r.path)
    const idle = last ? Date.now() - Date.parse(last.applied_at) : Infinity
    if (idle < 10 * 86400000) continue
    const next = Math.round((v + (NEUTRAL - v) * 0.02) * 1000) / 1000
    if (next === v) continue
    const one = writeAxis(db, aid, key, next, 'auto', 'shrink')
    out.push({ path: one.path, from: v, to: next })
  }
  return out
}

/**
 * 老库迁移（big5.* → axis.*）在 db.js openDb 里执行一次；
 * 这里只留说明，避免两处 SQL 漂移。
 */
