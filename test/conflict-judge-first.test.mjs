/**
 * 先判后动（11-10）：字面规则挑出来的「冲突」，先交给判官，判之前什么都不动。
 *
 * 取代 → 旧条收起来；补充/无关 → 两条都留；不确定 → 留 pending（面板挂着，不冒泡、不开口）。
 * 开关：memory.conflict.judge=off 时走回老路（开卡 + 排问句）。
 *
 * 运行：node test/conflict-judge-first.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { applyWrite, flushJudges } from '../src/modules/gate.js'
import { addMemory } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// 同一对「看起来像矛盾」的句子：旧条留底，新条走门控
const OLD = '用户喜欢喝美式咖啡，不加糖'
const NEW = '用户不喜欢喝美式咖啡了，改成手冲'

function setup(opt = {}) {
  const w = makeWorld()
  const judgeMode = opt.judgeMode
  if (judgeMode) writeParam(w.db, w.aid, 'memory.conflict.judge', judgeMode)
  const old = addMemory(w.db, w.aid, { text: OLD, type: 'fact', source: 'test', skipConflict: true })
  const write = (cand) => addMemory(w.db, w.aid, { text: cand.text, type: 'fact', source: 'test', skipConflict: true })
  return { w, old, write }
}

const conflictsOf = (w) => w.db.prepare('SELECT * FROM conflicts WHERE agent_id=? ORDER BY rowid').all(w.aid)
const asksOf = (w) => w.db.prepare("SELECT * FROM proactive WHERE agent_id=? AND reason LIKE 'conflict:%'").all(w.aid)
const invalidOf = (w, id) => w.db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(id).invalid_at

// ---- 1. 判「补充」：两条都留，不开卡、不问
{
  const { w, old, write } = setup()
  try {
    const out = applyWrite(w.db, w.aid, { text: NEW }, write, { complete: async () => '补充' })
    await flushJudges()
    check('门控判出冲突', out.action === 'conflict', out)
    const rows = conflictsOf(w)
    check('只留一条记录', rows.length === 1, rows.length)
    check('结论是补充 → 结案', rows[0].state === 'resolved' && rows[0].resolution === 'supplement', rows[0])
    check('旧条没被作废', invalidOf(w, old.id) === null)
    check('没排问句', asksOf(w).length === 0, asksOf(w).length)
  } finally { w.close() }
}

// ---- 2. 判「取代」：旧条收起来，也不开卡
{
  const { w, old, write } = setup()
  try {
    applyWrite(w.db, w.aid, { text: NEW }, write, { complete: async () => '取代' })
    await flushJudges()
    const rows = conflictsOf(w)
    check('结论是取代 → 结案', rows[0].state === 'resolved' && rows[0].resolution === 'supersede', rows[0])
    check('旧条被收起来', !!invalidOf(w, old.id))
    check('没排问句', asksOf(w).length === 0, asksOf(w).length)
  } finally { w.close() }
}

// ---- 3. 判不出来：留 pending，不冒泡、不开口
{
  const { w, write } = setup()
  try {
    applyWrite(w.db, w.aid, { text: NEW }, write, { complete: async () => '嗯……' })
    await flushJudges()
    const rows = conflictsOf(w)
    check('判不出来 → 留在 pending', rows[0].state === 'pending', rows[0].state)
    check('pending 不排问句', asksOf(w).length === 0)
  } finally { w.close() }
}

// ---- 4. 关掉判官：走回老路（开卡 + 排问句）
{
  const { w, write } = setup({ judgeMode: 'off' })
  try {
    applyWrite(w.db, w.aid, { text: NEW }, write, {})
    await flushJudges()
    const rows = conflictsOf(w)
    check('关掉判官 → 照旧开卡', rows[0].state === 'open', rows[0].state)
    check('关掉判官 → 照旧排问句', asksOf(w).length === 1, asksOf(w).length)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
