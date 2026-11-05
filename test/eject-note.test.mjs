/**
 * 阶段 D：跨层指针。
 *
 * 要保证：
 *   1) 有旧条被挤出 → 注入末尾留一句「还有 N 条在账本里」；
 *   2) 没挤出 → 不留（不制造噪音）；
 *   3) 参数 off → 不留；
 *   4) 跨层提醒不再查 episodes.topics（2-gram 碎片）；
 *   5) 但 title / summary 命中仍然正常（别把正路也切了）。
 *
 * 运行：node test/eject-note.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { packMemoryBlock } from '../index.js'
import { crossLayerNote } from '../src/modules/passport.js'

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

function rows(w) {
  w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
  const old = addMemory(w.db, w.aid, { text: '已经作废的一条：情绪快照还没做完', type: 'fact', fact_key: '用户.情绪快照.待完成' })
  const fresh = addMemory(w.db, w.aid, { text: '在用的那条：情绪快照已经做好了', type: 'fact', fact_key: '用户.情绪快照.完成' })
  w.db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(back(30), old.id)
  return { oldRow: rowOf(w, old.id), freshRow: rowOf(w, fresh.id) }
}

// ① 有挤出 → 留一行
{
  const w = makeWorld()
  try {
    const { oldRow, freshRow } = rows(w)
    const packed = packMemoryBlock(w.db, w.aid, [oldRow, freshRow], 400)
    check('挤出后留一句账本提示', /还有 1 条旧说法/.test(packed.text), packed.text)
    check('提示说的是「翻旧账」', packed.text.includes('翻旧账'), packed.text)
    check('被挤出的正文没混进来', !packed.text.includes('已经作废的一条'), packed.text)
  } finally { w.close() }
}

// ② 没挤出 → 不留
{
  const w = makeWorld()
  try {
    const { freshRow } = rows(w)
    const packed = packMemoryBlock(w.db, w.aid, [freshRow], 400)
    check('无挤出不留提示', !packed.text.includes('旧说法收在账本里'), packed.text)
  } finally { w.close() }
}

// ③ 参数 off → 不留
{
  const w = makeWorld()
  try {
    const { oldRow, freshRow } = rows(w)
    setParam(w.db, w.aid, 'memory.inject.ejected_note', 'off')
    const packed = packMemoryBlock(w.db, w.aid, [oldRow, freshRow], 400)
    check('关掉后不留提示', !packed.text.includes('旧说法收在账本里'), packed.text)
  } finally { w.close() }
}

// ④ topics-only 不该命中
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    const old = addMemory(w.db, w.aid, { text: '情绪快照这件事还没做完', type: 'fact', fact_key: '用户.情绪快照.待完成' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(back(300), old.id)
    const today = new Date().toISOString().slice(0, 10)
    const at = new Date().toISOString()
    w.db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ep_topic_only', w.aid, 's_d', today, back(200), back(100), 4, '别的标题', '聊的是完全不相干的事', '["情绪快照"]', '[]', 'rules', at)
    const row = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id)
    const note = crossLayerNote(w.db, w.aid, row)
    check('只命中 topics 不提醒', note === '', note)
  } finally { w.close() }
}

// ⑤ title 命中仍然有效（别把正路也切了）
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    const old = addMemory(w.db, w.aid, { text: '情绪快照这件事还没做完', type: 'fact', fact_key: '用户.情绪快照.待完成' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(back(300), old.id)
    const today = new Date().toISOString().slice(0, 10)
    const at = new Date().toISOString()
    w.db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ep_title_hit', w.aid, 's_d2', today, back(200), back(100), 4, '情绪快照做好了', '这件事已经弄完了，情绪快照能用了', '[]', '[]', 'rules', at)
    const row = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id)
    const note = crossLayerNote(w.db, w.aid, row)
    check('title/summary 命中仍提醒', note.includes('纪要里聊到'), note)
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exitCode = 1
