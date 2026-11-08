/**
 * 整体模拟（v3）：跨时间状态机端到端。
 *
 * 场景：
 *   ① 一条「还没做完」的旧记忆，后来有记录证明做完了 → 夜间 on 核对 → 作废 → 注入里消失；
 *   ② shadow 对照：claim 判 done，但记忆仍在（只是标记，不动）；
 *   ③ open_loop 关闭 → 关联记忆联动 → 注入里不再「还挂着」；
 *   ④ 没有证据（still）→ 不动，注入里仍带年龄提示。
 *
 * 运行：node test/time-awareness-v3.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'
import { packMemoryBlock } from '../index.js'
import { setClaimState, claimOf } from '../src/modules/claim_state.js'
import { runNightly } from '../src/modules/nightly.js'
import { addLoop, closeLoops, loopLineFor } from '../src/parts/loops/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString()
const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)
const hit = (w, id) => ({ ...rowOf(w, id), partition: 'T1' })
const answer = (obj) => async () => JSON.stringify(obj)

function seedStalePair(w, { key = '用户.躯干V.计划' } = {}) {
  const old = addMemory(w.db, w.aid, { text: '躯干还没收尾，等对方通知再动', type: 'episode', fact_key: key })
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(6), old.id)
  setClaimState(w.db, w.aid, old.id, 'pending', { via: 'test' })
  const newer = addMemory(w.db, w.aid, { text: '躯干已经拆成零件体系了，昨天立到 13 个', type: 'episode', fact_key: key.replace('.计划', '.完成') })
  return { old: old.id, newer: newer.id }
}

// ① on：夜间核对 → 作废 → 注入消失
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.enable', 'on')
    const { old, newer } = seedStalePair(w)
    const out = await runNightly(w.db, w.aid, { day: '2026-03-01', force: true, merge: false, model: { capabilities: () => ({ complete: true }), complete: answer({ state: 'done', evidence: 1 }) } })
    const step = out.steps.find((s) => s.step === 'claim_reconcile')
    check('on：夜巡判出 done', step && (step.byState.done || 0) >= 1, step)
    check('on：旧条已作废', rowOf(w, old).invalid_at !== null)
    const block = packMemoryBlock(w.db, w.aid, [hit(w, old), hit(w, newer)], 400)
    check('on：注入里没有旧说法', !String(block.text).includes('还没收尾'), block.text)
    check('on：注入里有新说法', String(block.text).includes('零件体系'), block.text)
  } finally { w.close() }
}

// ② shadow：claim 变 done，但记忆仍在
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.enable', 'shadow')
    const { old } = seedStalePair(w, { key: '用户.躯干W.计划' })
    await runNightly(w.db, w.aid, { day: '2026-03-02', force: true, merge: false, model: { capabilities: () => ({ complete: true }), complete: answer({ state: 'done', evidence: 1 }) } })
    check('shadow：claim 变 done', claimOf(w.db, w.aid, old).state === 'done')
    check('shadow：记忆没被作废', rowOf(w, old).invalid_at === null)
  } finally { w.close() }
}

// ③ loop 关闭 → 联动 → 注入里不再挂着
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.loop_link', 'on')
    const mem = addMemory(w.db, w.aid, { text: '先找躯干，还没开始', type: 'episode' })
    const lp = addLoop(w.db, w.aid, { text: '先找躯干，看看整体怎么拆', kind: 'task', memory_id: mem.id, at: Date.now() - 3 * 86400000 })
    const before = loopLineFor(w.db, w.aid, {})
    check('loop 关闭前：注入里有「还挂着」', String(before.text).includes('还挂着'), before.text)
    closeLoops(w.db, w.aid, [lp.id], 'user_done')
    check('loop 关闭：记忆被作废', rowOf(w, mem.id).invalid_at !== null)
    const after = loopLineFor(w.db, w.aid, {})
    check('loop 关闭后：注入里没有它', !String(after.text).includes('先找躯干'), after.text)
  } finally { w.close() }
}

// ④ 没证据（still）：不动，注入里仍带年龄提示
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.enable', 'on')
    const old = addMemory(w.db, w.aid, { text: '这件事还没做完，先记一笔', type: 'episode', fact_key: '用户.待办U.计划' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(6), old.id)
    setClaimState(w.db, w.aid, old.id, 'pending', { via: 'test' })
    await runNightly(w.db, w.aid, { day: '2026-03-03', force: true, merge: false, model: { capabilities: () => ({ complete: true }), complete: answer({ state: 'still' }) } })
    check('still：记忆保留', rowOf(w, old.id).invalid_at === null)
    check('still：claim 仍 pending', claimOf(w.db, w.aid, old.id).state === 'pending')
    const block = packMemoryBlock(w.db, w.aid, [hit(w, old.id)], 400)
    check('still：注入里带年龄提示', /(天前|个月前|周前)/.test(String(block.text)), block.text)
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
