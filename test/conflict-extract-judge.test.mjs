/**
 * 先判后动（第二步）：抽取路径（addMemory 自己判出来的冲突）也走判官。
 *
 * 取代 → 旧条收起来；补充/无关 → 两条都留；不确定 → 留 pending（面板挂着，不打扰）。
 * 开关 memory.conflict.judge=off 时退回老路（开卡 + 作废旧条 + 排问句）。
 *
 * 运行：node test/conflict-extract-judge.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory, flushConflictJudges } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const OLD = '用户的生日是十月三日'
const NEW = '用户的生日不是十月三日吧'

function pair(judge, extra = {}) {
  const w = makeWorld()
  if (extra.judgeOff) writeParam(w.db, w.aid, 'memory.conflict.judge', 'off')
  const a = addMemory(w.db, w.aid, { text: OLD, type: 'fact', importance: 0.9 })
  const b = addMemory(w.db, w.aid, { text: NEW, type: 'fact', importance: 0.9, complete: judge })
  return { w, a, b }
}

const rows = (w) => w.db.prepare('SELECT * FROM conflicts WHERE agent_id=? ORDER BY rowid').all(w.aid)
const asks = (w) => w.db.prepare("SELECT * FROM proactive WHERE agent_id=? AND reason LIKE 'conflict:%'").all(w.aid)
const alerts = (w) => w.db.prepare("SELECT * FROM alerts WHERE agent_id=? AND kind='data'").all(w.aid)
const invalid = (w, id) => w.db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(id).invalid_at

// ---- 1. 判「补充」：两条都留，不开卡、不问
{
  const { w, a, b } = pair(async () => '补充')
  try {
    await flushConflictJudges()
    check('抽取判出冲突', b.conflict === true, b)
    const r = rows(w)
    check('只留一条记录', r.length === 1, r.length)
    check('结论是补充 → 结案', r[0].state === 'resolved' && r[0].resolution === 'supplement', r[0])
    check('旧条没被作废', invalid(w, a.id) === null)
    check('没排问句、没挂告警', asks(w).length === 0 && alerts(w).length === 0)
  } finally { w.close() }
}

// ---- 2. 判「取代」：旧条收起来，也不开卡
{
  const { w, a, b } = pair(async () => '取代')
  try {
    await flushConflictJudges()
    const r = rows(w)
    check('结论是取代 → 结案', r[0].state === 'resolved' && r[0].resolution === 'supersede', r[0])
    check('旧条被收起来', !!invalid(w, a.id))
    check('没排问句', asks(w).length === 0)
  } finally { w.close() }
}

// ---- 3. 判不出来：留 pending，不冒泡、不开口
{
  const { w } = pair(async () => '嗯……')
  try {
    await flushConflictJudges()
    const r = rows(w)
    check('判不出来 → 留在 pending', r[0].state === 'pending', r[0].state)
    check('pending 不排问句', asks(w).length === 0)
    check('pending 不挂告警', alerts(w).length === 0)
  } finally { w.close() }
}

// ---- 4. 关掉判官：走回老路（开卡 + 作废旧条 + 排问句）
{
  const { w, a } = pair(async () => '补充', { judgeOff: true })
  try {
    await flushConflictJudges()
    const r = rows(w)
    check('关掉判官 → 照旧开卡', r[0].state === 'open', r[0].state)
    check('关掉判官 → 照旧作废旧条', !!invalid(w, a.id))
    check('关掉判官 → 照旧排问句', asks(w).length === 1, asks(w).length)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
