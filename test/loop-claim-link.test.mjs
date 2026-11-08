/**
 * S4：open_loop 关闭联动记忆状态。
 * 运行：node test/loop-claim-link.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'
import { addLoop, closeLoops } from '../src/parts/loops/index.js'
import { claimOf } from '../src/modules/claim_state.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)

function seedLoop(w, { text = '先找躯干，看看整体怎么拆' } = {}) {
  const mem = addMemory(w.db, w.aid, { text: '躯干还没收尾，等通知', type: 'episode' })
  const lp = addLoop(w.db, w.aid, { text, kind: 'task', memory_id: mem.id })
  return { mem: mem.id, loop: lp.id }
}

// ① shadow（默认）：只写 claim，不作废
{
  const w = makeWorld()
  try {
    const { mem, loop } = seedLoop(w)
    const n = closeLoops(w.db, w.aid, [loop], 'user_done')
    check('关掉了 1 条 loop', n === 1, n)
    const c = claimOf(w.db, w.aid, mem)
    check('shadow：claim 变 done', c && c.state === 'done', c)
    check('shadow：记忆不作废', rowOf(w, mem).invalid_at === null)
    const ev = w.db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='loop.closed_memory'").get(w.aid).n
    check('shadow：写了联动事件', ev === 1, ev)
  } finally { w.close() }
}

// ② expired：标 stale，不当作完成
{
  const w = makeWorld()
  try {
    const { mem, loop } = seedLoop(w)
    closeLoops(w.db, w.aid, [loop], 'expired')
    const c = claimOf(w.db, w.aid, mem)
    check('expired：claim 变 stale', c && c.state === 'stale', c)
    check('expired：记忆不作废', rowOf(w, mem).invalid_at === null)
  } finally { w.close() }
}

// ③ on：真的作废
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.loop_link', 'on')
    const { mem, loop } = seedLoop(w)
    closeLoops(w.db, w.aid, [loop], 'manual')
    const c = claimOf(w.db, w.aid, mem)
    check('on：claim 变 done', c && c.state === 'done', c)
    check('on：记忆被作废', rowOf(w, mem).invalid_at !== null, rowOf(w, mem).invalid_at)
  } finally { w.close() }
}

// ④ off：不联动
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.loop_link', 'off')
    const { mem, loop } = seedLoop(w)
    closeLoops(w.db, w.aid, [loop], 'user_done')
    check('off：claim 不写', claimOf(w.db, w.aid, mem) === null)
    check('off：记忆不作废', rowOf(w, mem).invalid_at === null)
  } finally { w.close() }
}

// ⑤ 没有 memory_id 的 loop：不炸
{
  const w = makeWorld()
  try {
    const lp = addLoop(w.db, w.aid, { text: '过两天要检查一下', kind: 'task' })
    const n = closeLoops(w.db, w.aid, [lp.id], 'manual')
    check('无 memory_id：照常关', n === 1, n)
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
