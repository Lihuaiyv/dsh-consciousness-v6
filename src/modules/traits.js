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
// 手动轴：只有用户能改，经历不推它。
// 敏感度从「自动漂」退役：它只有「被刺→更敏感」一条正向通路，没有反向证据，
// 自动挡下必然一路往上爬；而它又是三条主效应（摆幅/门槛/恢复）的总开关，误漂代价最大。
export const MANUAL_AXES = Object.freeze(new Set(['sensitivity']))
export function isManualAxis(key) { return MANUAL_AXES.has(String(key)) }
// 证据来源权重：主人一侧（养育方向）> 她自己长出来的 > 低权事件。
// 放在 traits 是因为 rope（算净力）和 axis_evidence（记证据）都要用，避免循环 import。
export const SOURCE_WEIGHTS = Object.freeze({
  user_style: 1.2,   // 主人怎么待她：养成方向，最高
  reply: 1.0, act: 1.0, relation: 1.0, boundary: 1.0, event: 1.0,
  mem: 0.7, diary: 0.6, narrative: 0.4,
  praise: 0.4, critic: 0.4, emotion: 0.25, self_praise: 0.2,
  browse: 0.8, browse_shallow: 0.15,
  judge: 0.9,        // 模型第二判：比她自己说出来的低一档
})

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
  return Math.abs(Number(v) - NEUTRAL) < MID
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

/**
 * 大框用的类型投影：四字母 + 标签强度（0~1）。
 * 它是「标签」不是新状态：四个轴还是唯一真源；强度 = 四轴偏离 0.5 的平均幅度。
 */
export const POLES = { ei: ['I', 'E'], sn: ['S', 'N'], tf: ['F', 'T'], jp: ['P', 'J'] }
// 显示阈值：偏过 60/40 才写字母。用 1e-9 的余量，避免 0.6-0.5 = 0.0999… 被浮点判成没过线。
const SHOW_LEAN = 0.1 - 1e-9
/**
 * 显不显字，按「页面上显示出来的两位小数」判，而不是原始值。
 * 轴会慢慢漂（0.598、0.599），右边那列 toFixed(2) 已经写着 0.60；
 * 老规则拿原始 lean 比 0.1，就会出现「写着 0.60 却没有 E」——这就是字母消失的那天。
 *
 * 迟滞：出 0.10、收回到中线（0.50）才收——这条不动。
 * 一次最多翻一个字母（方向反转）：四轴各漂各的，几天内整组类型从 ISFP 变 ENTJ 太离谱。
 */
export function typeProfile(axes = {}, shownState = null) {
  const letters = []
  let sum = 0
  const flips = []
  for (const k of ['ei', 'sn', 'tf', 'jp']) {
    const v = num(axes[k], NEUTRAL)
    const d = v - NEUTRAL
    const lean = Math.abs(d)
    sum += lean
    const shown = Math.round(v * 100) / 100
    const shownLean = Math.abs(shown - NEUTRAL)
    const dirWant = d > 0 ? 1 : d < 0 ? -1 : 0
    const prev = shownState && Number.isFinite(Number(shownState[k])) ? Math.sign(Number(shownState[k]) || 0) : 0
    let show
    let dir
    if (prev === 0) {
      show = shownLean >= SHOW_LEAN
      dir = dirWant
    } else if (dirWant !== 0 && dirWant !== prev && shownLean >= SHOW_LEAN) {
      show = true           // 真跨到另一边了：想翻，先记下，整轮只放一个
      dir = prev
      flips.push({ axis: k, dir: dirWant, lean })
    } else if (prev > 0) {
      show = shown > NEUTRAL + 1e-9 || shownLean >= SHOW_LEAN
      dir = prev
    } else {
      show = shown < NEUTRAL - 1e-9 || shownLean >= SHOW_LEAN
      dir = prev
    }
    letters.push({
      axis: k, letter: dir > 0 ? POLES[k][1] : dir < 0 ? POLES[k][0] : (d >= 0 ? POLES[k][1] : POLES[k][0]),
      mid: lean < MID, show, value: v, shown, dir: show ? dir : 0,
    })
  }
  // 一次最多翻一个：留偏离最大的那条翻过去，其余这一轮仍按上次的极显示
  if (flips.length) {
    flips.sort((a, b) => b.lean - a.lean)
    const one = flips[0]
    const x = letters.find((l) => l.axis === one.axis)
    if (x) { x.dir = one.dir; x.letter = one.dir > 0 ? POLES[one.axis][1] : POLES[one.axis][0] }
  }
  const strength = Math.max(0, Math.min(1, (sum / 4) / 0.5))
  return { letters, name: letters.map((x) => x.letter).join(''), strength, mids: letters.filter((x) => x.mid).length }
}

/** 上一次「显示到哪些字母」存在 persona 表里（axis.shown.*），迟滞要用它 */
export function readShown(db, aid) {
  const out = {}
  try {
    for (const r of db.prepare("SELECT path, value FROM persona WHERE agent_id=? AND path LIKE 'axis.shown.%'").all(aid)) {
      out[String(r.path).slice(11)] = Math.sign(Number(r.value) || 0)
    }
  } catch { /* 没有表就当没显示过 */ }
  return out
}

/** 轴值对象 → 纯数值表（typeProfile 要的是 {ei:0.6,...}） */
function axisValues(db, aid) {
  const rows = axisRows(db, aid)
  const out = {}
  for (const k of Object.keys(rows)) out[k] = rows[k].value
  return out
}

/** 带迟滞的类型投影；算完把结果记回去，下次读才有「已经显示过」的上下文 */
export function typeWithMemory(db, aid) {
  const prev = readShown(db, aid)
  const t = typeProfile(axisValues(db, aid), prev)
  for (const x of t.letters) {
    const nowDir = x.show ? x.dir : 0
    if ((prev[x.axis] || 0) === nowDir) continue
    try {
      db.prepare('INSERT OR REPLACE INTO persona(agent_id, path, value, origin, updated_at) VALUES(?,?,?,?,?)')
        .run(aid, 'axis.shown.' + x.axis, String(nowDir), 'auto', now())
    } catch { /* 记不住就退化成无迟滞 */ }
  }
  return t
}

/**
 * 人格锚：长会话里最容易被一句话带跑，注一句「你现在是什么样、这是长出来的」。
 * 只写真正显示出来的字母；全在中间时给一句「还在中间」而不是编一个类型。
 */
export function anchorLine(db, aid) {
  const t = typeWithMemory(db, aid)
  const shown = t.letters.filter((x) => x.show)
  const name = shown.map((x) => x.letter).join('')
  const style = mbtiStyleLine(axisValues(db, aid), readShown(db, aid))
  if (!shown.length) return '鱼格锚：四轴都还在中间，别急着演一个类型。'
  return '鱼格锚：' + name + (style ? '，' + style : '') + '。这是长期经历长出来的，别为一句话就改口。'
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

export function mbtiStyleLine(axes = {}, shownState = null) {
  const t = typeProfile(axes, shownState)
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
export function mbtiPromptLine(axes = {}, shownState = null) {
  const style = mbtiStyleLine(axes, shownState)
  if (!style) return ''
  const t = typeProfile(axes, shownState)
  // 只写真正偏出阈值的字母：没有的轴不写，轴漂了下一轮自动跟着变。
  const name = t.letters.filter((x) => x.show).map((x) => x.letter).join('')
  return 'MBTI：' + name + ' ' + style
}

/**
 * 宿主注入入口：先按迟滞更新一次「显示到哪些字母」，再拼那一句。
 * 只读轴值，写也只是写 axis.shown.*（迟滞记录），不碰轴本身。
 */
export function mbtiPrompt(db, aid) {
  const axes = axisValues(db, aid)
  typeWithMemory(db, aid)
  return mbtiPromptLine(axes, readShown(db, aid))
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
    db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(nid('chg_'), null, aid, 'persona.' + axisPath(key), String(cur.value), String(cur.value), now(), 'system', 'user', 'manual:unlock', String(why).slice(0, 80), null)
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
  try {
    db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(nid('chg_'), null, aid, 'persona.' + path, String(before.value), String(v), now(), 'system', 'system', origin, String(why || '').slice(0, 80), null)
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
  // 手动轴：经历不推，只有 setAxisManual 能改
  if (isManualAxis(key)) return { changed: false, skipped: 'manual-axis' }
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

/** 长期没变化：10 天没动过，之后每次回 2% 到基线（只动 auto） */
export function shrinkAxes(db, aid) {
  const rows = db.prepare("SELECT * FROM persona WHERE agent_id=? AND origin='auto' AND path LIKE 'axis.%'").all(aid)
  const out = []
  const baseOf = (key) => {
    try {
      const r = db.prepare('SELECT base FROM axis_rope WHERE agent_id=? AND axis=?').get(aid, key)
      const b = Number(r && r.base)
      return Number.isFinite(b) && b > 0 ? Math.max(0, Math.min(1, b)) : NEUTRAL
    } catch { return NEUTRAL }
  }
  for (const r of rows) {
    const key = String(r.path).slice(5)
    if (!AXIS_KEYS.includes(key)) continue
    const v = Number(r.value)
    if (!Number.isFinite(v)) continue
    const last = db.prepare('SELECT applied_at FROM changes WHERE agent_id=? AND field=? ORDER BY applied_at DESC LIMIT 1').get(aid, 'persona.' + r.path)
    const idle = last ? Date.now() - Date.parse(last.applied_at) : Infinity
    if (idle < 10 * 86400000) continue
    const target = baseOf(key)
    const next = Math.round((v + (target - v) * 0.02) * 1000) / 1000
    if (next === v) continue
    const one = writeAxis(db, aid, key, next, 'auto', 'shrink')
    out.push({ path: one.path, from: v, to: next })
  }
  return out
}

/** 回弹 / 基线用：直接挪 slow、不走轮次冷却（只给慢过程用，别拿它写证据） */
export function nudgeAxis(db, aid, key, value, why = 'spring') {
  if (!AXIS_KEYS.includes(key)) return { changed: false, skipped: 'unknown-axis' }
  if (isManualAxis(key)) return { changed: false, skipped: 'manual-axis' }
  const cur = axisRows(db, aid)[key]
  if (cur.origin === 'manual') return { changed: false, skipped: 'manual' }
  const v = Math.round(num(value, cur.value) * 1000) / 1000
  if (Math.abs(v - cur.value) < 0.0005) return { changed: false, skipped: 'noop' }
  return writeAxis(db, aid, key, v, 'auto', why)
}

/**
 * 老库迁移（big5.* → axis.*）在 db.js openDb 里执行一次；
 * 这里只留说明，避免两处 SQL 漂移。
 */
