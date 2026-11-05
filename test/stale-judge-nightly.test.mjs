/**
 * P3：夜间窄门步骤单测。
 *
 * 要保证：
 *   1) judgeDay 只写缓存/统计，不改任何记忆（invalid_at 不动）；
 *   2) 第二次跑命中缓存，不再调模型；
 *   3) 没开总闸 → 步骤 skipped=off，不碰模型；
 *   4) 开了但没模型 → skipped=no-model，夜巡不失败；
 *   5) 有模型 → 步骤 ok，rows/pairs 数字对得上。
 *
 * 运行：node test/stale-judge-nightly.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'
import { judgeDay } from '../src/modules/pair_judge.js'
import { runNightly, localDay } from '../src/modules/nightly.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString()
const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)

function seedPair(w, { oldText = '检索算法效果，有没有更好的方案', newText = '关注检索算法表现，问能否升级', gapMin = 30 } = {}) {
  const old = addMemory(w.db, w.aid, { text: oldText, type: 'appraisal', fact_key: '用户.检索.方案' })
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(gapMin), old.id)
  const newer = addMemory(w.db, w.aid, { text: newText, type: 'appraisal', fact_key: '用户.检索.升级' })
  return { old, newer }
}

// ── ① judgeDay：判一次、只写缓存、不改记忆 ────────────────
{
  const w = makeWorld()
  try {
    const { old, newer } = seedPair(w)
    let calls = 0
    const r = await judgeDay({ db: w.db, aid: w.aid,
      day: localDay(), complete: async () => { calls++; return '补充' },
      minIntervalMs: 0, sleep: async () => {}, via: 'test',
    })
    check('judgeDay 扫到了当天新增', r.rows >= 2, r)
    check('judgeDay 组出了候选对', r.pairs >= 1, r)
    check('judgeDay 调了一次模型', calls >= 1, { calls, r })
    check('判成补充', (r.byVerdict.supplement || 0) >= 1, r.byVerdict)
    check('旧条没有被作废', rowOf(w, old.id).invalid_at === null, rowOf(w, old.id).invalid_at)
    check('新条也没有被作废', rowOf(w, newer.id).invalid_at === null)
    const cached = w.db.prepare('SELECT * FROM memory_pair_judge WHERE agent_id=?').all(w.aid)
    check('缓存落了一行', cached.length >= 1, cached.length)
    check('缓存带 verdict 和 via', cached[0].verdict === 'supplement' && cached[0].via === 'test', cached[0])

    // ② 再跑一次：缓存命中，不调模型
    calls = 0
    const r2 = await judgeDay({ db: w.db, aid: w.aid,
      day: localDay(), complete: async () => { calls++; return '取代' },
      minIntervalMs: 0, sleep: async () => {}, via: 'test',
    })
    check('第二次不再调模型', calls === 0, calls)
    check('第二次全是缓存命中', r2.cached >= 1 && r2.judged === 0, r2)
    check('旧条仍然没有被作废', rowOf(w, old.id).invalid_at === null)
  } finally { w.close() }
}

// ── ③ 没开总闸：夜巡步骤 skipped=off ─────────────────────
{
  const w = makeWorld()
  try {
    const out = await runNightly(w.db, w.aid, { day: '2026-01-01', force: true, merge: false, model: { capabilities: () => ({ complete: true }), complete: async () => '补充' } })
    const step = out.steps.find((s) => s.step === 'stale_judge')
    check('夜巡有 stale_judge 步骤', !!step, out.steps.map((s) => s.step))
    check('默认关 → skipped=off', step && step.skipped === 'off' && step.ok === true, step)
    check('关闸时没有缓存', w.db.prepare('SELECT COUNT(*) n FROM memory_pair_judge').get().n === 0)
  } finally { w.close() }
}

// ── ④ 开了但没模型：skipped=no-model，夜巡不失败 ──────────
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.judge.enable', 'on')
    const out = await runNightly(w.db, w.aid, {
      day: '2026-01-02', force: true, merge: false,
      model: { capabilities: () => ({ complete: false }), complete: async () => '补充' },
    })
    const step = out.steps.find((s) => s.step === 'stale_judge')
    check('无模型 → skipped=no-model', step && step.skipped === 'no-model', step)
    check('无模型不算失败', step && step.ok === true, step)
  } finally { w.close() }
}

// ── ⑤ 开了且有模型：步骤 ok、数字对得上 ──────────────────
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.judge.enable', 'on')
    seedPair(w)
    const day = localDay()
    const out = await runNightly(w.db, w.aid, {
      day, force: true, merge: false,
      model: { capabilities: () => ({ complete: true }), complete: async () => '补充' },
    })
    const step = out.steps.find((s) => s.step === 'stale_judge')
    check('有模型 → 步骤 ok', step && step.ok === true && !step.skipped, step)
    check('有模型 → 扫到了行', step && step.rows >= 2, step)
    check('有模型 → 判出了补充', step && (step.byVerdict.supplement || 0) >= 1, step)
    check('夜巡整体没有因此失败', out.ok === true, out.steps.filter((s) => s.ok === false))
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)

