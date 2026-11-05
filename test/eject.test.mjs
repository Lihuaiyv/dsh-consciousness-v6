/**
 * S3 旧条挤出测试（阶段 B 之后的口径）：
 *   1) 状态词对（还没做完→做好了）：只标不挤，旧条留在正桌并带一句「当时还没做完」；
 *   2) 同一个 key 的真槽位更新：仍然挤（别把该挤的也放了）；
 *   3) 明确作废（invalid_at）：挤；
 *   4) 开关 off：旧条回来；
 *   5) 跨库命中（纪要）只标不挤；
 *   6) 全被剔除时保底留 1 条。
 *
 * 运行：node test/eject.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { packMemoryBlock, consciousnessBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

function setParam(db, aid, key, value) {
  db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
    .run(aid, key, JSON.stringify(value), new Date().toISOString())
}
const rowOf = (w, id) => ({ ...w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id), partition: 'T1' })
const back = (min) => new Date(Date.now() - min * 60000).toISOString()

/** 状态词对：不同 key、只在正文里说「还没做完 → 做好了」 */
function statePairRows(w) {
  w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
  const old = addMemory(w.db, w.aid, { text: '旧结论：情绪快照还没做完，先挂着', type: 'fact', fact_key: '用户.情绪快照.待完成' })
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(back(180), old.id)
  const fresh = addMemory(w.db, w.aid, { text: '新结论：情绪快照已经做好了', type: 'fact', fact_key: '助手.情绪快照.完成' })
  return { oldRow: rowOf(w, old.id), freshRow: rowOf(w, fresh.id) }
}

/** 同 key 并存：真槽位的确定更新 */
function sameKeyRows(w) {
  w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
  const a = addMemory(w.db, w.aid, { text: '咖啡的偏好还没定下来，等之后再说', type: 'fact', fact_key: '用户.咖啡.偏好' })
  const b = addMemory(w.db, w.aid, { text: '咖啡的偏好已经定下来了', type: 'fact', fact_key: '用户.咖啡.偏好' })
  // 写入时 a 会被退休；复活它，模拟「历史遗留 / 外部导入」的并存
  w.db.prepare('UPDATE memory_items SET invalid_at=NULL, superseded_by=NULL WHERE id=?').run(a.id)
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(back(120), a.id)
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(back(60), b.id)
  return { oldRow: rowOf(w, a.id), freshRow: rowOf(w, b.id) }
}

/** 明确作废 */
function invalidRows(w) {
  w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
  const old = addMemory(w.db, w.aid, { text: '已经作废的一条：情绪快照还没做完', type: 'fact', fact_key: '用户.情绪快照.待完成' })
  const fresh = addMemory(w.db, w.aid, { text: '在用的那条：情绪快照已经做好了', type: 'fact', fact_key: '用户.情绪快照.完成' })
  w.db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(back(30), old.id)
  return { oldRow: rowOf(w, old.id), freshRow: rowOf(w, fresh.id) }
}

// ① 状态词对：只标不挤
{
  const w = makeWorld()
  try {
    const { oldRow, freshRow } = statePairRows(w)
    const packed = packMemoryBlock(w.db, w.aid, [oldRow, freshRow], 400)
    check('状态词对：旧条仍在正桌', packed.text.includes('还没做完'), packed.text)
    check('状态词对：带上「当时还没做完」', packed.text.includes('当时还没做完'), packed.text)
    check('状态词对：新条还在', packed.text.includes('已经做好了'), packed.text)
  } finally { w.close() }
}

// ② 同 key 真槽位：仍然挤
{
  const w = makeWorld()
  try {
    const { oldRow, freshRow } = sameKeyRows(w)
    const packed = packMemoryBlock(w.db, w.aid, [oldRow, freshRow], 400)
    check('同 key 更新：旧条被挤出', !packed.text.includes('还没定下来'), packed.text)
    check('同 key 更新：新条还在', packed.text.includes('已经定下来了'), packed.text)
  } finally { w.close() }
}

// ③ 明确作废：挤
{
  const w = makeWorld()
  try {
    const { oldRow, freshRow } = invalidRows(w)
    const packed = packMemoryBlock(w.db, w.aid, [oldRow, freshRow], 400)
    check('作废条被挤出', !packed.text.includes('已经作废的一条'), packed.text)
    check('在用的那条还在', packed.text.includes('在用的那条'), packed.text)
  } finally { w.close() }
}

// ④ 开关 off：旧条回来
{
  const w = makeWorld()
  try {
    const { oldRow, freshRow } = invalidRows(w)
    setParam(w.db, w.aid, 'memory.stale.eject', 'off')
    const packed = packMemoryBlock(w.db, w.aid, [oldRow, freshRow], 400)
    check('关掉挤出后旧条回来', packed.text.includes('已经作废的一条'), packed.text)
    check('且带护照', packed.text.includes('说的'), packed.text)
  } finally { w.close() }
}

// ⑤ 跨库命中只标不挤
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    const old = addMemory(w.db, w.aid, { text: '旧结论：情绪快照还没做完', type: 'fact', fact_key: '用户.情绪快照.待完成' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(back(180), old.id)
    const today = new Date().toISOString().slice(0, 10)
    w.db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ep_eject', w.aid, 's_eject', today, new Date(Date.now() - 2 * 3600000).toISOString(), new Date(Date.now() - 1 * 3600000).toISOString(), 4, '情绪快照', '情绪快照已经弄好了', '[]', '[]', 'rules', new Date().toISOString())
    const packed = packMemoryBlock(w.db, w.aid, [rowOf(w, old.id)], 400)
    check('跨库命中不挤出', packed.text.includes('还没做完'), packed.text)
    check('跨库命中带标注', packed.text.includes('纪要里聊到'), packed.text)
  } finally { w.close() }
}

// ⑥ 全被剔除时保底 1 条
{
  const w = makeWorld()
  try {
    const { oldRow } = invalidRows(w)
    // 只传作废那条：它一定被判 stale，但 items 只有它，必须保底留下
    const packed = packMemoryBlock(w.db, w.aid, [oldRow], 400)
    check('全剔除时保底一条', packed.text.length > 0 && packed.text.includes('已经作废的一条'), packed.text)
  } finally { w.close() }
}

// ⑦ QQ 召回入口也过挤出/护照
{
  const w = makeWorld()
  try {
    const { oldRow, freshRow } = invalidRows(w)
    const block = consciousnessBlock(w.db, w.aid, { recall: [oldRow, freshRow] })
    check('QQ 入口作废条被挤出', !block.includes('已经作废的一条'), block.slice(-260))
    check('QQ 入口新条还在', block.includes('在用的那条'), block.slice(-260))
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
