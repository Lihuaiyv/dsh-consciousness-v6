/**
 * U6：改口（极性翻转）→ 冲突黄灯，不被 UPDATE/merge/consolidate 吃掉。
 * 运行：node test/u6-flip.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { writeParam } from '../src/kernel.js'
import { addMemory } from '../src/modules/memory.js'
import { applyWrite, decideWrite, polarityFlip } from '../src/modules/gate.js'
import { consolidateFactsRule } from '../src/modules/consolidate.js'
import { conflictStats } from '../src/modules/conflict.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-u6-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_u6'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'u6', 'daily', 'active', new Date().toISOString())

const write = (cand) => addMemory(db, aid, {
  text: cand.text, type: 'fact', tier: 'core', entity_id: cand.entity_id || null,
  fact_key: cand.fact_key || cand.key || null, source: 'extract',
})

// ---- 纯函数
{
  check('喜欢↔不喜欢判翻转', polarityFlip('我喜欢喝美式咖啡，不加糖', '我现在不喜欢喝美式咖啡了，改喝手冲'))
  check('同极性不翻转', !polarityFlip('我喜欢喝美式咖啡，不加糖', '我喜欢美式咖啡不加糖'))
  check('不加糖不干扰极性', !polarityFlip('我喜欢喝美式咖啡，不加糖', '美式咖啡我喜欢，不加糖'))
}

// ---- 默认：改口 → conflict + 开案
{
  writeParam(db, aid, 'memory.write.reconcile', 'on')
  writeParam(db, aid, 'memory.write.flip_policy', 'conflict')
  const a = addMemory(db, aid, { text: '我喜欢喝美式咖啡，不加糖', type: 'fact', entity_id: 'ent_coffee', source: 'extract' })
  const d = decideWrite(db, aid, { text: '我现在不喜欢喝美式咖啡了，改喝手冲', entity_id: 'ent_coffee' })
  check('decideWrite 改口=conflict', d.action === 'conflict', d)
  const out = applyWrite(db, aid, { text: '我现在不喜欢喝美式咖啡了，改喝手冲', entity_id: 'ent_coffee' }, write)
  check('applyWrite 改口=conflict', out.action === 'conflict' && !!out.conflict_id, out)
  const conf = conflictStats(db, aid)
  check('冲突表开案 ≥1', conf.total >= 1 && conf.open >= 1, conf)
  const both = db.prepare("SELECT id,text,invalid_at FROM memory_items WHERE agent_id=? AND status='active'").all(aid)
  check('冲突后新旧都还在（旧条可失效）', both.some((r) => r.id === a.id) && both.some((r) => /不喜欢/.test(r.text)), both.map((r) => r.text))
}

// ---- 同 fact_key 翻转也不走 UPDATE
{
  const aid2 = 'agt_u6b'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid2, 'u6b', 'daily', 'active', new Date().toISOString())
  writeParam(db, aid2, 'memory.write.reconcile', 'on')
  writeParam(db, aid2, 'memory.write.flip_policy', 'conflict')
  addMemory(db, aid2, { text: '喜欢周末爬山', type: 'fact', fact_key: 'habit.hik', source: 'extract' })
  const d = decideWrite(db, aid2, { text: '不喜欢周末爬山了', fact_key: 'habit.hik' })
  check('同 key 翻转=conflict 不是 update', d.action === 'conflict', d)
  const samePolar = decideWrite(db, aid2, { text: '周末喜欢去爬山', fact_key: 'habit.hik' })
  check('同 key 同极性=update', samePolar.action === 'update', samePolar)
}

// ---- flip_policy=update 才允许静默改写
{
  const aid3 = 'agt_u6c'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid3, 'u6c', 'daily', 'active', new Date().toISOString())
  writeParam(db, aid3, 'memory.write.reconcile', 'on')
  writeParam(db, aid3, 'memory.write.flip_policy', 'update')
  addMemory(db, aid3, { text: '我喜欢喝茶', type: 'fact', entity_id: 'ent_tea', source: 'extract' })
  const d = decideWrite(db, aid3, { text: '我不喜欢喝茶了', entity_id: 'ent_tea' })
  check('flip_policy=update 时改口可 update', d.action === 'update', d)
}

// ---- consolidate 不吞极性对
{
  const aid4 = 'agt_u6d'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid4, 'u6d', 'daily', 'active', new Date().toISOString())
  writeParam(db, aid4, 'memory.consolidate.facts', 'on')
  // 不用同一 fact_key：addMemory 会按 key 自动 invalid 旧条；这里测同实体高相似 + 极性相反
  addMemory(db, aid4, { text: '喜欢养金鱼', type: 'fact', entity_id: 'ent_fish', source: 'extract' })
  addMemory(db, aid4, { text: '不喜欢养金鱼', type: 'fact', entity_id: 'ent_fish', source: 'extract' })
  const before = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid4).n
  const r = consolidateFactsRule(db, aid4, { limit: 10 })
  const after = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid4).n
  check('consolidate 遇极性跳过', (r.results || []).some((x) => x.reason === 'polarity'), r)
  check('consolidate 不减少极性对', after === before, { before, after, r })
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
