/**
 * P3 生活流扩容：一天多次、间隔缩短、夜里只「想」、空转保护、候选池不再排掉技术日常、注入轮换。
 * 运行：node test/life-expand.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { lifeTick, lifeLine, pickLifeSubject, LIFE } from '../src/modules/life.js'
import { getParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const iso = (ms) => new Date(ms).toISOString()
const atHour = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime() }
const modelOk = { chat: async () => '嗯，我想了想，还是先把手里这件事弄明白。' }

function pin(w, key, value) {
  w.db.prepare(`INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value`).run(w.aid, key, JSON.stringify(value), new Date().toISOString())
}
function seedAgent(w) {
  w.db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date().toISOString(), w.aid)
  // 一条「在意的事」当素材
  w.db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,last_decay_at,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('mem_life_subj', w.aid, 'appraisal', 'normal', '有点好奇，好感度到底是怎么慢慢涨上去的', 'manual',
    0.5, 0.5, 1, 5, new Date().toISOString(), 'active', new Date().toISOString())
}
function insEvent(w, type, payload, at) {
  w.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
    .run('evt_' + Math.random().toString(36).slice(2), w.aid, type, JSON.stringify(payload), iso(at))
}

// ---- 默认值：已经开大 ----
{
  const w = makeWorld()
  try {
    check('per_day 默认 4', Number(getParam(w.db, w.aid, 'life.per_day')) === 4, getParam(w.db, w.aid, 'life.per_day'))
    check('间隔默认 1.5 小时', Number(getParam(w.db, w.aid, 'life.min_gap_hours')) === 1.5)
    check('夜里想一想的开关默认 on', String(getParam(w.db, w.aid, 'life.night_think')) === 'on')
    check('全局预算默认 24', Number(getParam(w.db, w.aid, 'life.global_per_day')) === 24)
    check('LIFE 常量同步', LIFE.perDay === 4 && LIFE.minGapHours === 1.5)
  } finally { w.close() }
}

// ---- 一天能跑多次；到上限后 done_today ----
{
  const w = makeWorld()
  try {
    seedAgent(w)
    pin(w, 'life.per_day', 2)
    pin(w, 'life.min_gap_hours', 0.25)
    const t0 = Date.now() + 3600000
    const r1 = await lifeTick(w.db, w.aid, { at: t0, model: modelOk })
    check('第一次跑起来', r1.ok === true, r1)
    const r2 = await lifeTick(w.db, w.aid, { at: t0 + 1800000, model: modelOk })
    check('第二次也能跑（不再一天一次）', r2.ok === true, r2)
    const r3 = await lifeTick(w.db, w.aid, { at: t0 + 3600000, model: modelOk })
    check('到上限 done_today', r3.ok === false && r3.skipped === 'done_today', r3)
  } finally { w.close() }
}

// ---- 间隔：太近 too_soon，够久就放行 ----
{
  const w = makeWorld()
  try {
    seedAgent(w)
    pin(w, 'life.per_day', 8)
    pin(w, 'life.min_gap_hours', 1.5)
    const now = Date.now()
    insEvent(w, 'life.done', { id: 'lf_a', kind: 'think', subject: '潮汐', summary: '想了想', share: false }, now - 20 * 60000)
    const soon = await lifeTick(w.db, w.aid, { at: now, model: modelOk })
    check('10 分钟前刚跑过 → too_soon', soon.ok === false && soon.skipped === 'too_soon', soon)
    pin(w, 'life.min_gap_hours', 0.1)
    const ok = await lifeTick(w.db, w.aid, { at: now, model: modelOk })
    check('把间隔调小后放行', ok.skipped !== 'too_soon', ok)
  } finally { w.close() }
}

// ---- 夜里只「想」，不调 browse ----
{
  const w = makeWorld()
  try {
    seedAgent(w)
    let browsed = 0
    const out = await lifeTick(w.db, w.aid, {
      at: atHour(3),
      browse: async () => { browsed++; return { items: [{ title: 'x', url: 'https://e.com', snippet: 'y' }] } },
      model: modelOk,
    })
    check('夜里能跑（不再整段停）', out.ok === true, out)
    check('夜里 kind=think', out.kind === 'think', out)
    check('夜里不出去浏览', browsed === 0, browsed)
  } finally { w.close() }
}
{
  const w = makeWorld()
  try {
    seedAgent(w)
    pin(w, 'life.night_think', 'off')
    const out = await lifeTick(w.db, w.aid, { at: atHour(3), model: modelOk })
    check('关掉夜想 → 恢复 night 跳过', out.ok === false && out.skipped === 'night', out)
  } finally { w.close() }
}

// ---- 空转保护：今天连着失败两次就歇着 ----
{
  const w = makeWorld()
  try {
    seedAgent(w)
    const now = Date.now()
    insEvent(w, 'life.fail', { reason: 'browse_failed' }, now - 3 * 3600000)
    insEvent(w, 'life.fail', { reason: 'browse_failed' }, now - 2 * 3600000)
    const out = await lifeTick(w.db, w.aid, { at: now, model: modelOk })
    check('连败两次 → paused', out.ok === false && out.skipped === 'paused', out)
  } finally { w.close() }
}

// ---- 候选池：不再把「代码/函数/测试」当噪音排掉 ----
{
  const w = makeWorld()
  try {
    seedAgent(w)
    w.db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,last_decay_at,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('mem_tech', w.aid, 'appraisal', 'normal', '我想了解记忆检索的函数到底是怎么挑条目的', 'manual',
      0.5, 0.5, 1, 5, new Date().toISOString(), 'active', new Date().toISOString())
    const subj = pickLifeSubject(w.db, w.aid)
    check('含「函数」的日常也能当候选', !!subj, subj)
  } finally { w.close() }
}
{
  const w = makeWorld()
  try {
    seedAgent(w)
    w.db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,last_decay_at,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('mem_self_subj', w.aid, 'episode', 'normal', '我把召回名额留给了自己的事，心里踏实一点', 'self',
      0.5, 0.5, 1, 5, new Date().toISOString(), 'active', new Date().toISOString())
    const subj = pickLifeSubject(w.db, w.aid)
    check('她自己的事优先当候选', !!subj && String(subj.text).includes('召回名额'), subj)
  } finally { w.close() }
}

// ---- 注入轮换：两条生活轮着出现，不会永远是同一条 ----
{
  const w = makeWorld()
  try {
    seedAgent(w)
    const now = Date.now()
    insEvent(w, 'life.done', { id: 'lf_old', kind: 'think', subject: '旧的那件', summary: '想了一下旧的', share: false }, now - 3 * 3600000)
    insEvent(w, 'life.done', { id: 'lf_new', kind: 'interest', subject: '新的那件', summary: '看了一眼新的', share: false }, now - 60000)
    const l1 = lifeLine(w.db, w.aid, now)
    check('第一次注入取最新那条', l1.includes('新的那件'), l1)
    const l2 = lifeLine(w.db, w.aid, now)
    check('第二次轮到另一条', l2.includes('旧的那件'), l2)
    const l3 = lifeLine(w.db, w.aid, now)
    check('都放过了退回最新', l3.includes('新的那件'), l3)
  } finally { w.close() }
}

// ---- 不编经历：想一想这条路只能写念头 ----
{
  const w = makeWorld()
  try {
    seedAgent(w)
    const countLife = () => Number(w.db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='life'").get(w.aid).n)
    const before = countLife()
    const fake = { chat: async () => '我把阳台那盆薄荷浇透了，土还是干的。' }
    const r = await lifeTick(w.db, w.aid, { at: Date.now() + 3600000, model: fake, force: true })
    check('编出来的经历不写进记忆', r.ok === false && countLife() === before, r)
    const fakeOk = { chat: async () => '那件事我一直惦记着，可就是没动手去查。' }
    const r2 = await lifeTick(w.db, w.aid, { at: Date.now() + 7200000, model: fakeOk, force: true })
    check('真的只是念头就照写', r2.ok === true, r2)
  } finally { w.close() }
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
