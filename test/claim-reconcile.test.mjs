/**
 * S2：夜间 claim 状态核对单测。
 * 运行：node test/claim-reconcile.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'
import { setClaimState, claimOf, reconcileClaims } from '../src/modules/claim_state.js'
import { runNightly } from '../src/modules/nightly.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString()
const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)

function seedPending(w, { text = '躯干还没收尾，等通知', key = '用户.躯干A.计划', days = 5 } = {}) {
  const r = addMemory(w.db, w.aid, { text, type: 'episode', fact_key: key })
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(days), r.id)
  setClaimState(w.db, w.aid, r.id, 'pending', { via: 'test' })
  return r.id
}

function seedLater(w, { text = '躯干已经拆成零件体系了', key = '用户.躯干A.完成' } = {}) {
  return addMemory(w.db, w.aid, { text, type: 'episode', fact_key: key })
}

const answer = (obj) => async () => JSON.stringify(obj)

// ① done：有后续证据 → claim 变 done，但不作废（shadow）
{
  const w = makeWorld()
  try {
    const id = seedPending(w)
    seedLater(w)
    const r = await reconcileClaims({ db: w.db, aid: w.aid, complete: answer({ state: 'done', evidence: 1 }), minAgeDays: 1, limit: 10, via: 'test' })
    check('done：核对了 1 条', r.judged === 1 && r.byState.done === 1, r)
    const c = claimOf(w.db, w.aid, id)
    check('done：claim 变 done', c && c.state === 'done', c)
    check('done：shadow 不作废记忆', rowOf(w, id).invalid_at === null, rowOf(w, id).invalid_at)
    check('done：带 evidence', c && c.evidence_id, c && c.evidence_id)
  } finally { w.close() }
}

// ② still：保持 pending，只更新 checked_at
{
  const w = makeWorld()
  try {
    const id = seedPending(w)
    seedLater(w)
    await reconcileClaims({ db: w.db, aid: w.aid, complete: answer({ state: 'still' }), minAgeDays: 1, limit: 10, via: 'test' })
    const c = claimOf(w.db, w.aid, id)
    check('still：仍 pending', c && c.state === 'pending', c)
    check('still：更新了 checked_at', c && c.checked_at, c && c.checked_at)
  } finally { w.close() }
}

// ③ stale：标 stale，不作废
{
  const w = makeWorld()
  try {
    const id = seedPending(w)
    seedLater(w)
    await reconcileClaims({ db: w.db, aid: w.aid, complete: answer({ state: 'stale' }), minAgeDays: 1, limit: 10, via: 'test' })
    const c = claimOf(w.db, w.aid, id)
    check('stale：claim 变 stale', c && c.state === 'stale', c)
    check('stale：不作废记忆', rowOf(w, id).invalid_at === null)
  } finally { w.close() }
}

// ④ 没模型：不改状态
{
  const w = makeWorld()
  try {
    const id = seedPending(w)
    seedLater(w)
    const r = await reconcileClaims({ db: w.db, aid: w.aid, complete: null, minAgeDays: 1, limit: 10, via: 'test' })
    check('无模型：记错误', r.errors >= 1, r)
    check('无模型：claim 不变', claimOf(w.db, w.aid, id).state === 'pending')
  } finally { w.close() }
}

// ⑤ 没有后续记录：不调模型
{
  const w = makeWorld()
  try {
    seedPending(w)
    let calls = 0
    await reconcileClaims({ db: w.db, aid: w.aid, complete: async () => { calls++; return '{}' }, minAgeDays: 1, limit: 10, via: 'test' })
    check('无后续记录：不调模型', calls === 0, calls)
  } finally { w.close() }
}

// ⑥ 夜巡步骤：off 跳过；on 有模型则跑
{
  const w = makeWorld()
  try {
    const off = await runNightly(w.db, w.aid, { day: '2026-01-01', force: true, merge: false, model: { capabilities: () => ({ complete: true }), complete: answer({ state: 'still' }) } })
    const s1 = off.steps.find((x) => x.step === 'claim_reconcile')
    check('夜巡有 claim_reconcile 步骤', !!s1, off.steps.map((x) => x.step))
    check('默认 off → skipped=off', s1 && s1.skipped === 'off', s1)

    writeParam(w.db, w.aid, 'memory.claim.enable', 'shadow')
    const id = seedPending(w)
    seedLater(w)
    const on = await runNightly(w.db, w.aid, { day: '2026-01-02', force: true, merge: false, model: { capabilities: () => ({ complete: true }), complete: answer({ state: 'done', evidence: 1 }) } })
    const s2 = on.steps.find((x) => x.step === 'claim_reconcile')
    check('开启后步骤 ok', s2 && s2.ok === true && !s2.skipped, s2)
    check('开启后判出 done', s2 && (s2.byState.done || 0) >= 1, s2)
    check('开启后仍不作废（shadow）', rowOf(w, id).invalid_at === null)
    check('夜巡整体 ok', on.ok === true)
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
