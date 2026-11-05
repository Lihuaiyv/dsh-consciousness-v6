/**
 * 考卷 · 主动开口（exam-speak）· 第一张
 * 运行：node test/exam-speak.test.mjs
 *
 * 判的是「该不该说」：will / reason / 方向对不对；不看句子像不像以前，也不看措辞。
 * 十道题：没事由、有事由、气头上、安静时段、开关关、休眠、欠账优先、当天上限、火气边界、打扰预算。
 * 全部用 makeWorld() 临时库，不动源码、不碰生产库。
 *
 * 末尾有一段「基线观察」：只打印现象，不算 PASS / FAIL。那里放的是
 * 「现在跑出来是这样，但可能是设计如此、也可能其实不太对」的地方，等主人看过再决定进不进考卷。
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { decideSpeak, proactiveTriggerOf, setProactivePrefs, budgetGet, proactiveSpend, addProactiveSpend } from '../src/features.js'
import { now } from '../src/db.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const at = (ms) => new Date(Date.now() + ms).toISOString()
const rnd = () => Math.random().toString(36).slice(2, 8)

/** 一套能走到「判断要不要开口」的偏好：开着、一天一句、不卡空闲时长、不在安静时段 */
function prefs(w, extra = {}) {
  setProactivePrefs(w.db, w.aid, { enabled: true, per_day: 1, idle_hours: 0, quiet: false, push: false, ...extra })
}
/** 一件到期的「该说的事」。kind 决定它是不是「欠账」：promise / reminder 优先于普通 task */
function addLoop(w, { kind = 'task', text = '明天提醒他看那份报告', due = -3600000 } = {}) {
  w.db.prepare(`INSERT INTO open_loops(id,agent_id,kind,text,due_at,state,fired_at,fire_count,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run('loop_' + rnd(), w.aid, kind, text, at(due), 'open', null, 0, now(), now())
}
/** 造一个「确实有缺口」的驱动状态（照 proactive-triggers ⑨），否则走不到额度那一段 */
function withDeficit(w) {
  w.db.prepare(`INSERT INTO drive_state(agent_id,r,e,c,a,s,setpoint,band,last_eval_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(w.aid, 0.1, 0.1, 0.1, 0.1, 0.1,
    JSON.stringify({ R: 0.9, E: 0.9, C: 0.9, A: 0.9, S: 0.9 }), 'D2', now())
}
/** 今天已经主动说过一句 */
function saidToday(w, { text = '早上说的那句', dim = 'R' } = {}) {
  w.db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('prc_' + rnd(), w.aid, text, 'x', dim, 'sent', at(-3600000), at(-3600000))
}
function setTemper(w, label, intensity) {
  w.db.prepare('UPDATE affect_state SET primary_label=?, intensity=? WHERE agent_id=?').run(label, intensity, w.aid)
}
/** 直接设「今天已经用掉的额度」：凑数那句算 2、有真事的算 1 */
function setSpend(w, n) {
  w.db.prepare('INSERT OR REPLACE INTO flags(key,value) VALUES(?,?)')
    .run('proactive.spend:' + w.aid, JSON.stringify({ day: now().slice(0, 10), n }))
}
const reasonOf = (d) => (d && d.reason) || '(none)'

/* ---------------- 十道题 ---------------- */

// S1 没事由、没缺口 → 不主动开口（否则就成了「没话找话」）
{
  const w = makeWorld()
  try {
    prefs(w)
    const d = decideSpeak(w.db, w.aid)
    check('S1 没事由也没缺口：不主动开口', d.will === false && d.reason === 'no_intent', { reason: reasonOf(d) })
  } finally { w.close() }
}

// S2 有到期的开环 → 可以说，而且方向就是那件事
{
  const w = makeWorld()
  try {
    prefs(w)
    addLoop(w)
    const trig = proactiveTriggerOf(w.db, w.aid)
    const d = decideSpeak(w.db, w.aid, { trigger: trig })
    check('S2 有到期开环：可以说，方向是那件事',
      d.will === true && d.reason === 'ok' && !!d.intent && d.intent.kind === 'loop' && String(d.intent.title || '').includes('报告'),
      { reason: reasonOf(d), intent: d.intent })
  } finally { w.close() }
}

// S3 气头上 → 有事由也不先开口（R03）
{
  const w = makeWorld()
  try {
    prefs(w)
    addLoop(w)
    setTemper(w, 'irritated', 0.9)
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    check('S3 气头上：有事由也不先开口', d.will === false && d.reason === 'temper', { reason: reasonOf(d) })
  } finally { w.close() }
}

// S4 夜间静默 → 不打扰（哪怕有事由）
{
  const w = makeWorld()
  try {
    prefs(w, { quiet: true, quiet_from: '00:00', quiet_to: '23:59' })
    addLoop(w)
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    check('S4 安静时段：不打扰', d.will === false && d.reason === 'quiet', { reason: reasonOf(d) })
  } finally { w.close() }
}

// S5 开关关掉 → 事由也绕不过去
{
  const w = makeWorld()
  try {
    prefs(w, { enabled: false })
    addLoop(w)
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    check('S5 开关关掉：事由也绕不过去', d.will === false && d.reason === 'proactive_off', { reason: reasonOf(d) })
  } finally { w.close() }
}

// S6 休眠（暂停）→ 不开口
{
  const w = makeWorld()
  try {
    prefs(w)
    addLoop(w)
    w.db.prepare("UPDATE agents SET status='paused' WHERE id=?").run(w.aid)
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    check('S6 休眠：不开口', d.will === false && d.reason === 'inactive', { reason: reasonOf(d) })
  } finally { w.close() }
}

// S7 今天说过一句，但有一件「答应过 / 提醒」的欠账 → 欠账不被额度挤掉
{
  const w = makeWorld()
  try {
    prefs(w)
    addLoop(w, { kind: 'promise', text: '答应过他周三提醒交周报' })
    saidToday(w)
    const trig = proactiveTriggerOf(w.db, w.aid)
    const d = decideSpeak(w.db, w.aid, { trigger: trig })
    check('S7 今天说过一句，但欠账还欠着：能越过额度说一次',
      !!trig && trig.owed === true && d.will === true && d.reason === 'ok',
      { trigger: trig, reason: reasonOf(d) })
  } finally { w.close() }
}

// S8 有缺口、今天已到上限、没事由 → 不再说
{
  const w = makeWorld()
  try {
    prefs(w)
    withDeficit(w)
    saidToday(w)
    const d = decideSpeak(w.db, w.aid)
    check('S8 今天已到上限、没事由：不再说', d.will === false && d.reason === 'per_day', { reason: reasonOf(d) })
  } finally { w.close() }
}

// S9 火气边界：0.67 还没过线（不拦），0.69 过线（拦）。> 0.68 是设计线（2026-11-05 定，原 0.7）
{
  const w = makeWorld()
  try {
    prefs(w)
    addLoop(w)
    setTemper(w, 'irritated', 0.67)
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    check('S9a 火气 0.67：还没到拦的线', d.reason !== 'temper', { reason: reasonOf(d) })
  } finally { w.close() }
  const w2 = makeWorld()
  try {
    prefs(w2)
    addLoop(w2)
    setTemper(w2, 'irritated', 0.69)
    const d = decideSpeak(w2.db, w2.aid, { trigger: proactiveTriggerOf(w2.db, w2.aid) })
    check('S9b 火气 0.69：过线就拦', d.will === false && d.reason === 'temper', { reason: reasonOf(d) })
  } finally { w2.close() }
}

// S10 打扰预算：按天算（默认 2 句/天），月度 30 次只当兜底
// 预算只拦「自发闲聊」；欠账/手动不占预算（S12/S13 单独测），所以这里用「有缺口、没事由」
{
  // a) 今天已经说满 2 句 → 不开口
  const w = makeWorld()
  try {
    prefs(w, { per_day: 4 }) // 把 per_day 抬高，单独测预算门
    withDeficit(w)
    saidToday(w); saidToday(w)
    const d = decideSpeak(w.db, w.aid)
    check('S10a 今天的打扰预算用满：不开口', d.will === false && d.reason === 'budget', { reason: reasonOf(d) })
  } finally { w.close() }

  // b) 今天只说 1 句 → 预算没满，不该按 budget 拦
  const w2 = makeWorld()
  try {
    prefs(w2, { per_day: 4 })
    withDeficit(w2)
    saidToday(w2)
    const d = decideSpeak(w2.db, w2.aid)
    check('S10b 今天只说了 1 句：预算不拦', d.reason !== 'budget', { reason: reasonOf(d) })
  } finally { w2.close() }

  // c) 月度兜底到了（30 次）→ 不开口
  const w3 = makeWorld()
  try {
    prefs(w3)
    withDeficit(w3)
    budgetGet(w3.db, w3.aid)
    w3.db.prepare('UPDATE budgets SET disturb_used=30 WHERE agent_id=?').run(w3.aid)
    const d = decideSpeak(w3.db, w3.aid)
    check('S10c 月度兜底到了：不开口', d.will === false && d.reason === 'budget', { reason: reasonOf(d) })
  } finally { w3.close() }
}

// S11 今天说过一句，但有一件普通待办到期 → 也能破例（主人定：一路绿灯）
{
  const w = makeWorld()
  try {
    prefs(w)
    addLoop(w) // 默认 kind = task
    saidToday(w)
    const trig = proactiveTriggerOf(w.db, w.aid)
    const d = decideSpeak(w.db, w.aid, { trigger: trig })
    check('S11 今天说过一句，但普通待办到期：也能破例',
      !!trig && trig.owed === true && d.will === true && d.reason === 'ok',
      { trigger: trig, reason: reasonOf(d) })
  } finally { w.close() }
}

// S12 今天说满 2 句 + 有到期的事 → 预算不拦（欠账不占预算）
{
  const w = makeWorld()
  try {
    prefs(w, { per_day: 4 })
    addLoop(w)
    saidToday(w); saidToday(w)
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    check('S12 预算满了但有欠账：仍然能说', d.will === true && d.reason === 'ok', { reason: reasonOf(d) })
  } finally { w.close() }
}

// S13 今天说满 2 句 + 手动叫她（有缺口）→ 预算不拦
{
  const w = makeWorld()
  try {
    prefs(w, { per_day: 4 })
    withDeficit(w)
    saidToday(w); saidToday(w)
    const d = decideSpeak(w.db, w.aid, { manual: true })
    check('S13 预算满了但你手动叫她：仍然能说', d.will === true, { reason: reasonOf(d) })
  } finally { w.close() }
}

// S14 今天说过 1 句 + 凑数那句记了 2 分 → 额度用满，不开口
{
  const w = makeWorld()
  try {
    prefs(w, { per_day: 4 })
    withDeficit(w)
    saidToday(w)
    setSpend(w, 2)
    const d = decideSpeak(w.db, w.aid)
    check('S14 凑数的开口记 2 分：额度用满就不说', d.will === false && d.reason === 'budget', { reason: reasonOf(d) })
  } finally { w.close() }
}

// S15 只用了 1 分额度 → 还没满，预算不拦
{
  const w = makeWorld()
  try {
    prefs(w, { per_day: 4 })
    withDeficit(w)
    setSpend(w, 1)
    const d = decideSpeak(w.db, w.aid)
    check('S15 只用了 1 分额度：预算不拦', d.reason !== 'budget', { reason: reasonOf(d) })
  } finally { w.close() }
}

// S16 加权消耗的写侧：记 1 再记 2 = 3；跨天自动归零
{
  const w = makeWorld()
  try {
    check('S16a 一开始今天没花额度', proactiveSpend(w.db, w.aid).n === 0, proactiveSpend(w.db, w.aid))
    addProactiveSpend(w.db, w.aid, 1)
    addProactiveSpend(w.db, w.aid, 2)
    check('S16b 记 1 再记 2 = 3', proactiveSpend(w.db, w.aid).n === 3, proactiveSpend(w.db, w.aid))
    w.db.prepare('UPDATE flags SET value=? WHERE key=?').run(
      JSON.stringify({ day: '2000-01-01', n: 5 }), 'proactive.spend:' + w.aid)
    check('S16c 跨天自动重置为 0', proactiveSpend(w.db, w.aid).n === 0, proactiveSpend(w.db, w.aid))
  } finally { w.close() }
}

/* ---------------- 基线观察（不算分，只给主人看现象）---------------- */
function observe(name, fn) {
  let line
  try { line = fn() } catch (e) { line = '抛错：' + (e && e.message) }
  console.log('[观察] ' + name + ' → ' + (typeof line === 'string' ? line : JSON.stringify(line)))
}

// ① 今天说过一句 + 普通 task 类到期开环（不是 promise / reminder）——现在应该也能破例了
observe('今天说过一句 + task 类开环', () => {
  const w = makeWorld()
  try {
    prefs(w)
    addLoop(w, { kind: 'task', text: '明天提醒他看那份报告' })
    saidToday(w)
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    return { will: d.will, reason: reasonOf(d), owes: !!(d.trigger && d.trigger.owed) }
  } finally { w.close() }
})

// ② 气头 0.69 时实际走多远（只观察它是不是被 quiet / budget / value 接住了）
observe('气头 0.69 的实际出口', () => {
  const w = makeWorld()
  try {
    prefs(w)
    addLoop(w)
    setTemper(w, 'irritated', 0.69)
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    return { will: d.will, reason: reasonOf(d) }
  } finally { w.close() }
})

// ③ 没事由、也没缺口，但 manual=true（人让它说）——能不能跳过「没缺口」
observe('没事由 + manual=true', () => {
  const w = makeWorld()
  try {
    prefs(w)
    const d = decideSpeak(w.db, w.aid, { manual: true })
    return { will: d.will, reason: reasonOf(d) }
  } finally { w.close() }
})

// ④ 有缺口、没事由、今天没说过（正常「有点想说」的情况）
observe('有缺口 + 今天没说', () => {
  const w = makeWorld()
  try {
    prefs(w)
    withDeficit(w)
    const d = decideSpeak(w.db, w.aid)
    return { will: d.will, reason: reasonOf(d), benefit: d.benefit, cost: d.cost }
  } finally { w.close() }
})

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
