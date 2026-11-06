/**
 * P4：写入门控里的模型窄门（shadow / on）。
 *
 * 要保证：
 *   1) 总闸关 → 一次模型都不调、一条事件都不写；
 *   2) shadow → 有判定事件，但记忆一条都不改；
 *   3) on → supersede 才真作废旧条，且留可追溯事件；
 *   4) 超时 / 规则兜底假 JSON → uncertain、不改记忆、不冒充；
 *   5) 没有结构候选 → 根本不调度。
 *
 * 运行：node test/write-gate-judge.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'
import { applyWrite, flushJudges, resetJudgeState } from '../src/modules/gate.js'
import { readJudgement, pairKey } from '../src/modules/pair_judge.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString()
const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)

function setup(w, { enable = 'on', gate = 'shadow', dailyMax = 40, timeout = 3000 } = {}) {
  resetJudgeState()
  writeParam(w.db, w.aid, 'memory.judge.enable', enable)
  writeParam(w.db, w.aid, 'memory.judge.gate', gate)
  writeParam(w.db, w.aid, 'memory.judge.min_interval_ms', 0)
  writeParam(w.db, w.aid, 'memory.judge.daily_max', dailyMax)
  writeParam(w.db, w.aid, 'memory.judge.timeout_ms', timeout)
}

function seedOld(w, { text = '检索算法效果，有没有更好的方案', key = '用户.检索.方案', min = 60 } = {}) {
  const r = addMemory(w.db, w.aid, { text, type: 'appraisal', fact_key: key })
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(min), r.id)
  return r
}

function gw(w, { text, key, complete }) {
  return applyWrite(w.db, w.aid, { text, fact_key: key }, (c) => addMemory(w.db, w.aid, {
    text: c.text, type: 'appraisal', fact_key: c.fact_key || c.key || '',
  }), complete ? { complete } : {})
}

const judgeEvents = (w) => w.db.prepare("SELECT * FROM events WHERE agent_id=? AND type='memory.judge.gate'").all(w.aid)

// ── ① 总闸关：一次都不调、不写事件 ────────────────────────
{
  const w = makeWorld()
  try {
    setup(w, { enable: 'off' })
    seedOld(w)
    let calls = 0
    gw(w, { text: '关注检索算法表现，问能否升级', key: '用户.检索.升级', complete: async () => { calls++; return '取代' } })
    await flushJudges()
    check('关闸：不调模型', calls === 0, calls)
    check('关闸：不写判定事件', judgeEvents(w).length === 0)
    check('关闸：无缓存', w.db.prepare('SELECT COUNT(*) n FROM memory_pair_judge').get().n === 0)
  } finally { w.close() }
}

// ── ② shadow：只记事件，不动记忆 ──────────────────────────
{
  const w = makeWorld()
  try {
    setup(w, { enable: 'on', gate: 'shadow' })
    const old = seedOld(w)
    let calls = 0
    const out = gw(w, { text: '关注检索算法表现，问能否升级', key: '用户.检索.升级', complete: async () => { calls++; return '取代' } })
    check('shadow：写入动作是 new', out.action === 'new', out)
    await flushJudges()
    const evs = judgeEvents(w)
    check('shadow：supersede 判了两次（判 + 复核）', calls === 2, calls)
    check('shadow：写了判定事件', evs.length === 1, evs)
    const p = evs[0] ? JSON.parse(evs[0].payload) : {}
    check('shadow：事件判决是 supersede', p.verdict === 'supersede', p)
    check('shadow：模式记成 shadow', p.mode === 'shadow', p)
    check('shadow：旧条没被作废', rowOf(w, old.id).invalid_at === null, rowOf(w, old.id).invalid_at)
    const cached = readJudgement(w.db, w.aid, pairKey(w.aid, rowOf(w, old.id), rowOf(w, out.id)))
    check('shadow：缓存里有这一对', !!cached && cached.verdict === 'supersede', cached)
    check('shadow：applied=0', cached && Number(cached.applied) === 0, cached && cached.applied)
  } finally { w.close() }
}

// ── ③ on：supersede 真作废，留事件 ────────────────────────
{
  const w = makeWorld()
  try {
    setup(w, { enable: 'on', gate: 'on' })
    const old = seedOld(w)
    const out = gw(w, { text: '关注检索算法表现，问能否升级', key: '用户.检索.升级', complete: async () => '取代' })
    await flushJudges()
    const r = rowOf(w, old.id)
    check('on：旧条被作废', r.invalid_at !== null, r.invalid_at)
    const evs = w.db.prepare("SELECT * FROM events WHERE agent_id=? AND type='memory.judge.superseded'").all(w.aid)
    check('on：写了取代事件', evs.length === 1, evs.length)
    const cached = readJudgement(w.db, w.aid, pairKey(w.aid, rowOf(w, old.id), rowOf(w, out.id)))
    check('on：缓存 applied=1', cached && Number(cached.applied) === 1, cached && cached.applied)
  } finally { w.close() }
}

// ── ④ 超时：不改记忆、不冒充 ──────────────────────────────
{
  const w = makeWorld()
  try {
    setup(w, { enable: 'on', gate: 'on', timeout: 60 })
    const old = seedOld(w)
    gw(w, { text: '关注检索算法表现，问能否升级', key: '用户.检索.升级', complete: () => new Promise(() => {}) })
    await flushJudges()
    check('超时：旧条没被作废', rowOf(w, old.id).invalid_at === null)
    const evs = judgeEvents(w)
    const p = evs[0] ? JSON.parse(evs[0].payload) : {}
    check('超时：判决是 uncertain', p.verdict === 'uncertain', p)
    check('超时：原因带 timeout', /timeout/.test(String(p.reason || '')), p)
  } finally { w.close() }
}

// ── ⑤ 规则兜底假 JSON：不写缓存、不冒充 ──────────────────
{
  const w = makeWorld()
  try {
    setup(w, { enable: 'on', gate: 'on' })
    seedOld(w)
    gw(w, {
      text: '关注检索算法表现，问能否升级', key: '用户.检索.升级',
      complete: async () => '{"overlap":"unknown","key":"","name":"","definition":""}',
    })
    await flushJudges()
    const evs = judgeEvents(w)
    const p = evs[0] ? JSON.parse(evs[0].payload) : {}
    check('假 JSON：判决 uncertain', p.verdict === 'uncertain', p)
    check('假 JSON：原因 bad-shape', p.reason === 'bad-shape', p)
    check('假 JSON：不写缓存', w.db.prepare('SELECT COUNT(*) n FROM memory_pair_judge').get().n === 0)
  } finally { w.close() }
}

// ── ⑥ 没有结构候选：根本不调度 ────────────────────────────
{
  const w = makeWorld()
  try {
    setup(w, { enable: 'on', gate: 'on' })
    seedOld(w, { text: '用户喜欢冰美式', key: '用户.咖啡.偏好' })
    let calls = 0
    gw(w, { text: '部署脚本换成了新的入口文件', key: '用户.部署.入口', complete: async () => { calls++; return '取代' } })
    await flushJudges()
    check('无候选：不调模型', calls === 0, calls)
    check('无候选：不写判定事件', judgeEvents(w).length === 0)
  } finally { w.close() }
}

// ── ⑦ 修复验证：提取路径传 fact_key 后，同 key 走 update 而不是新增 ──
{
  const w = makeWorld()
  try {
    setup(w, { enable: 'off' })
    const old = seedOld(w, { text: '用户咖啡偏好是冰美式', key: '用户.咖啡.偏好' })
    const out = gw(w, { text: '用户咖啡偏好改成手冲', key: '用户.咖啡.偏好', complete: async () => '取代' })
    check('同 key：门控判成 update', out.action === 'update', out)
    check('同 key：旧条原地改写成新句', rowOf(w, old.id).text === '用户咖啡偏好改成手冲', rowOf(w, old.id).text)
    check('同 key：旧句留了底', w.db.prepare("SELECT COUNT(*) n FROM fact_archive WHERE memory_id LIKE ?").get(old.id + ':hist:%').n === 1)
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)

