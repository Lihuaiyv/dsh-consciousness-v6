/**
 * S6：开闸门槛——claim.enable=on 才真作废；shadow 永不动记忆。
 * 运行：node test/claim-on.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'
import { setClaimState, claimOf } from '../src/modules/claim_state.js'
import { runNightly } from '../src/modules/nightly.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString()
const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)
const answer = (obj) => async () => JSON.stringify(obj)

function seed(w) {
  const old = addMemory(w.db, w.aid, { text: '躯干还没收尾，等通知', type: 'episode', fact_key: '用户.躯干Z.计划' })
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(5), old.id)
  setClaimState(w.db, w.aid, old.id, 'pending', { via: 'test' })
  const newer = addMemory(w.db, w.aid, { text: '躯干已经拆成零件体系了', type: 'episode', fact_key: '用户.躯干Z.完成' })
  return { old: old.id, newer: newer.id }
}

// ① shadow：只写 claim，不动记忆
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.enable', 'shadow')
    const { old } = seed(w)
    const out = await runNightly(w.db, w.aid, { day: '2026-02-01', force: true, merge: false, model: { capabilities: () => ({ complete: true }), complete: answer({ state: 'done', evidence: 1 }) } })
    const step = out.steps.find((s) => s.step === 'claim_reconcile')
    check('shadow：步骤判出 done', step && (step.byState.done || 0) >= 1, step)
    check('shadow：claim 变 done', claimOf(w.db, w.aid, old).state === 'done')
    check('shadow：记忆不作废', rowOf(w, old).invalid_at === null)
  } finally { w.close() }
}

// ② on：真作废
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.enable', 'on')
    const { old } = seed(w)
    const out = await runNightly(w.db, w.aid, { day: '2026-02-02', force: true, merge: false, model: { capabilities: () => ({ complete: true }), complete: answer({ state: 'done', evidence: 1 }) } })
    const step = out.steps.find((s) => s.step === 'claim_reconcile')
    check('on：步骤判出 done', step && (step.byState.done || 0) >= 1, step)
    check('on：记忆被作废', rowOf(w, old).invalid_at !== null, rowOf(w, old).invalid_at)
    check('on：claim 仍是 done', claimOf(w.db, w.aid, old).state === 'done')
  } finally { w.close() }
}

// ③ on 但模型说 still：不动
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.enable', 'on')
    const { old } = seed(w)
    await runNightly(w.db, w.aid, { day: '2026-02-03', force: true, merge: false, model: { capabilities: () => ({ complete: true }), complete: answer({ state: 'still' }) } })
    check('still：记忆不作废', rowOf(w, old).invalid_at === null)
    check('still：claim 仍 pending', claimOf(w.db, w.aid, old).state === 'pending')
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
