/**
 * 主动开口的「事由」：有到期开环时，允许说一次；但硬闸门一个都不松。
 * 运行：node test/proactive-triggers.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { decideSpeak, proactiveTriggerOf, setProactivePrefs, queueProactive } from '../src/features.js'
import { now } from '../src/db.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const DAY = 86400000
const at = (n) => new Date(Date.now() + n).toISOString()

function addLoop(w, { text = '明天提醒他看那份报告', due = -3600000, fired = null } = {}) {
  w.db.prepare(`INSERT INTO open_loops(id,agent_id,kind,text,due_at,state,fired_at,fire_count,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run('loop_' + Math.random().toString(36).slice(2, 8), w.aid, 'task', text, at(due), 'open', fired, 0, now(), now())
}

function basePrefs(w, extra = {}) {
  setProactivePrefs(w.db, w.aid, { enabled: true, per_day: 1, idle_hours: 0, quiet: false, push: false, ...extra })
}

// ① 没有开环 → 没有事由
{
  const w = makeWorld()
  try {
    basePrefs(w)
    check('没开环就没有事由', proactiveTriggerOf(w.db, w.aid) === null, proactiveTriggerOf(w.db, w.aid))
    check('没开环时 trigger 为空', decideSpeak(w.db, w.aid).trigger === null)
  } finally { w.close() }
}

// ② 有到期开环 → 事由成立，而且能过额度
{
  const w = makeWorld()
  try {
    basePrefs(w)
    addLoop(w)
    const trig = proactiveTriggerOf(w.db, w.aid)
    check('认得出到期开环', !!trig && trig.kind === 'loop' && trig.text.includes('报告'), trig)
    const d = decideSpeak(w.db, w.aid, { trigger: trig })
    check('有事由就能说', d.will === true && d.reason === 'ok', { reason: d.reason, gates: (d.gates || []).map((g) => [g.id, g.ok]) })
    check('方向是那件事', !!d.intent && d.intent.kind === 'loop' && d.intent.title.includes('报告'), d.intent)
    check('闸门里写了事由', (d.explain || '').includes('事由'), d.explain)
  } finally { w.close() }
}

// ③ 今天已经说过 → 不再因为开环多说
{
  const w = makeWorld()
  try {
    basePrefs(w)
    addLoop(w)
    w.db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('prc_old', w.aid, '早上说的那句', 'x', 'R', 'sent', at(-3600000), at(-3600000))
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    check('今天说过就按额度拦', d.will === false && ['per_day', 'no_intent'].includes(d.reason), { reason: d.reason })
  } finally { w.close() }
}

// ④ 夜里：有事由也不开口
{
  const w = makeWorld()
  try {
    basePrefs(w, { quiet: true, quiet_from: '00:00', quiet_to: '23:59' })
    addLoop(w)
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    check('安静时段优先', d.will === false && d.reason === 'quiet', { reason: d.reason })
  } finally { w.close() }
}

// ⑤ 气头上：有事由也不开口（R03）
{
  const w = makeWorld()
  try {
    basePrefs(w)
    addLoop(w)
    w.db.prepare("UPDATE affect_state SET primary_label='irritated', intensity=0.9 WHERE agent_id=?").run(w.aid)
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    check('气头上不先开口', d.will === false && d.reason === 'temper', { reason: d.reason })
  } finally { w.close() }
}

// ⑥ 开关关掉：事由也绕不过去
{
  const w = makeWorld()
  try {
    basePrefs(w, { enabled: false })
    addLoop(w)
    const d = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
    check('关掉主动开口就是关掉', d.will === false && d.reason === 'proactive_off', { reason: d.reason })
  } finally { w.close() }
}

// ⑦ 说完就把这事标掉（不重复念）
{
  const w = makeWorld()
  try {
    basePrefs(w)
    addLoop(w, { text: '提醒他交周报' })
    const trig = proactiveTriggerOf(w.db, w.aid)
    const out = await queueProactive(w.db, w.aid, { trigger: trig })
    if (out && out.queued) {
      const row = w.db.prepare('SELECT fire_count, fired_at FROM open_loops WHERE id=?').get(trig.id)
      check('说出口后开环记一次', Number(row.fire_count) === 1 && !!row.fired_at, row)
    } else {
      // 没有模型时句子可能拼不出来：那就不能标掉，下次还得能说
      const row = w.db.prepare('SELECT fire_count FROM open_loops WHERE id=?').get(trig.id)
      check('没说出来就不标掉', Number(row.fire_count) === 0 && !!trig, { out: out && out.reason, row })
    }
  } finally { w.close() }
}

// ⑧ 远期开环不算事由（还没到期）
{
  const w = makeWorld()
  try {
    basePrefs(w)
    addLoop(w, { due: 3 * DAY })
    check('没到期的不算事由', proactiveTriggerOf(w.db, w.aid) === null, proactiveTriggerOf(w.db, w.aid))
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
