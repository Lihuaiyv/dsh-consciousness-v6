/**
 * 阶段 A：key 分身份测试。
 *
 * 要保证：
 *   1) 只有 fact / appraisal 的 key 算「槽位」，reflection / episode 不算；
 *   2) 非槽位的同 key 更新 → 只标（source=topic），不挤（isStale=false）；
 *   3) 真槽位的同 key 更新 → 仍能挤出（回归：别把该挤的也放了）；
 *   4) 明确作废（invalid_at）不论类型都挤；
 *   5) memoryHealth 能报出「按 type 分的 key」。
 *
 * 运行：node test/passport-slot.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { stampRow, isStale, isSlotKeyRow, passportLine } from '../src/modules/passport.js'
import { memoryHealth } from '../src/modules/retrieval_log.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString()
const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)

// ① 槽位判定只认 fact / appraisal
{
  check('fact 带 key → 槽位', isSlotKeyRow({ type: 'fact', fact_key: '用户.咖啡.偏好' }) === true)
  check('appraisal 带 key → 槽位', isSlotKeyRow({ type: 'appraisal', fact_key: '用户.咖啡.偏好' }) === true)
  check('reflection 带 key → 非槽位', isSlotKeyRow({ type: 'reflection', fact_key: '用户.反应.哇塞' }) === false)
  check('episode 带 key → 非槽位', isSlotKeyRow({ type: 'episode', fact_key: '用户.聊天.记录' }) === false)
  check('fact 无 key → 非槽位', isSlotKeyRow({ type: 'fact', fact_key: '' }) === false)
  check('空行 → 非槽位', isSlotKeyRow(null) === false)
}

// ② 非槽位（reflection）同 key 更新：标，但不挤
{
  const w = makeWorld()
  try {
    const old = addMemory(w.db, w.aid, {
      text: '情绪快照还没做好，我先记一笔', type: 'reflection', fact_key: '用户.情绪快照.思考',
    })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(30), old.id)
    addMemory(w.db, w.aid, {
      text: '情绪快照做好了，先记一笔', type: 'reflection', fact_key: '用户.情绪快照.思考',
    })
    const r = rowOf(w, old.id)
    const s = stampRow(w.db, w.aid, r)
    check('reflection 同 key 更新：source=topic_key', s.source === 'topic_key', s)
    check('reflection 同 key 更新：slot=false', s.slot === false, s)
    check('reflection 不被挤出', isStale(w.db, w.aid, r) === false, s)
  } finally { w.close() }
}

// ③ 真槽位（fact）同 key 更新：仍要挤（回归）
{
  const w = makeWorld()
  try {
    const old = addMemory(w.db, w.aid, {
      text: '咖啡的偏好还没定下来，等之后再说', type: 'fact', fact_key: '用户.咖啡.偏好',
    })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(40), old.id)
    addMemory(w.db, w.aid, {
      text: '咖啡的偏好已经定下来了', type: 'fact', fact_key: '用户.咖啡.偏好',
    })
    // addMemory 写入时已把 old 作废；复活它，测「同 key 并存」的判定
    w.db.prepare('UPDATE memory_items SET invalid_at=NULL, superseded_by=NULL WHERE id=?').run(old.id)
    const r = rowOf(w, old.id)
    const s = stampRow(w.db, w.aid, r)
    check('fact 同 key 更新：source=topic_key', s.source === 'topic_key', s)
    check('fact 同 key 更新：slot=true', s.slot === true, s)
    check('fact 同 key 更新：仍会被挤出', isStale(w.db, w.aid, r) === true, s)
  } finally { w.close() }
}

// ④ 同 key 两条都活着（绕过写侧退休）：只有槽位能挤
{
  const w = makeWorld()
  try {
    const a = addMemory(w.db, w.aid, { text: '咖啡的偏好还没定下来，等之后再说', type: 'fact', fact_key: '用户.咖啡.待完成' })
    const b = addMemory(w.db, w.aid, { text: '咖啡的偏好已经定下来了', type: 'fact', fact_key: '用户.咖啡.待完成' })
    // addMemory 写入时会把 a 作废；这里手工复活，模拟「历史遗留 / 外部导入」的并存状态
    w.db.prepare('UPDATE memory_items SET invalid_at=NULL, superseded_by=NULL WHERE id=?').run(a.id)
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(60), a.id)
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(5), b.id)
    const s = stampRow(w.db, w.aid, rowOf(w, a.id))
    check('同 key 并存：source=topic_key', s.source === 'topic_key', s)
    check('同 key 并存：fact 被挤出', isStale(w.db, w.aid, rowOf(w, a.id)) === true, s)
  } finally { w.close() }
}

// ⑤ 明确作废：不论类型都挤，且护照说得出「旧」
{
  const w = makeWorld()
  try {
    const r1 = addMemory(w.db, w.aid, { text: '一段自省：这件事我还没想清楚', type: 'reflection', fact_key: '用户.自省.记录' })
    w.db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(ago(1), r1.id)
    const row = rowOf(w, r1.id)
    check('作废条：isStale=true（非槽位也挤）', isStale(w.db, w.aid, row) === true)
    check('作废条：护照非空', passportLine(w.db, w.aid, row).length > 0, passportLine(w.db, w.aid, row))
  } finally { w.close() }
}

// ⑥ memoryHealth 报出按 type 分的 key
{
  const w = makeWorld()
  try {
    addMemory(w.db, w.aid, { text: '用户喜欢冰美式，不加糖', type: 'fact', fact_key: '用户.咖啡.偏好' })
    addMemory(w.db, w.aid, { text: '一段反思：今天他说话有点急', type: 'reflection', fact_key: '用户.反应.急躁' })
    const h = memoryHealth(w.db, w.aid)
    check('memoryHealth 有 keys.by_type', !!(h.keys && h.keys.by_type && h.keys.by_type.fact), h.keys)
    check('fact 的 key 计入 slot', Number(h.keys.slot) >= 1, h.keys)
    check('reflection 的 key 不计入 slot', h.keys.by_type.reflection && h.keys.by_type.reflection.key >= 1 && Number(h.keys.with_key) > Number(h.keys.slot), h.keys)
    check('passport.slot 与 keys.slot 一致', h.passport.slot === h.keys.slot, { p: h.passport, k: h.keys })
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
