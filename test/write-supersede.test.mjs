/**
 * S4 写侧分工集成测试：
 *   默认 off：只观测（旧条不失效，冲突照开）；
 *   打开后：时间顺序明确的「没做完 → 做好了」走取代，不开冲突卡。
 * 运行：node test/write-supersede.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { decideWrite, applyWrite } from '../src/modules/gate.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
function setParam(db, aid, key, value) {
  db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
    .run(aid, key, JSON.stringify(value), new Date().toISOString())
}
const writeFn = (db, aid) => (c) => addMemory(db, aid, { text: c.text, type: 'fact', source: 'extract' })

// ① 默认 off：只观测，旧条不失效
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    const old = addMemory(w.db, w.aid, { text: '情绪快照这个功能还没做完', type: 'fact', source: 'manual' })
    const cand = { text: '情绪快照这个功能已经做好了', type: 'fact', source: 'extract' }
    const d = decideWrite(w.db, w.aid, cand)
    check('门控能看到旧条', d.target && d.target.id === old.id, d)
    const r = applyWrite(w.db, w.aid, cand, writeFn(w.db, w.aid))
    const oldRow = w.db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(old.id)
    check('默认不取代（旧条仍有效）', oldRow.invalid_at == null, { r, old: oldRow })
    check('默认走正常新增', r.action === 'new', r.action)
    const seen = w.db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.stale_pair_seen'").get(w.aid).n
    check('默认留下观测事件', seen >= 1, seen)
  } finally { w.close() }
}

// ② 打开开关：走取代，不再开冲突
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    const old = addMemory(w.db, w.aid, { text: '情绪快照这个功能还没做完', type: 'fact', source: 'manual' })
    setParam(w.db, w.aid, 'memory.write.stale_supersede', 'on')
    const cand = { text: '情绪快照这个功能已经做好了', type: 'fact', source: 'extract' }
    const d = decideWrite(w.db, w.aid, cand)
    check('门控能看到旧条', d.target && d.target.id === old.id, d)
    const r = applyWrite(w.db, w.aid, cand, writeFn(w.db, w.aid))
    const oldRow = w.db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(old.id)
    check('旧条被取代', oldRow.invalid_at != null, { r, old: oldRow })
    check('返回 supersede', r.action === 'supersede', r)
    const open = w.db.prepare("SELECT COUNT(*) n FROM conflicts WHERE agent_id=? AND state='open'").get(w.aid).n
    check('不再开冲突卡', open === 0, open)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
