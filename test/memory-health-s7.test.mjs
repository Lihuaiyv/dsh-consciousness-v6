/**
 * S7 观测测试：记忆体检里能看到护照回链、取代数、三类事件（阶段 E 补了挤出行）。
 * 运行：node test/memory-health-s7.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { memoryHealth } from '../src/modules/retrieval_log.js'
import { addMemory } from '../src/modules/memory.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const w = makeWorld()
try {
  const h = memoryHealth(w.db, w.aid)
  check('有护照回链字段', h.passport && typeof h.passport.derived === 'number', h.passport)
  check('有过时字段', h.stale && typeof h.stale.superseded === 'number', h.stale)
  check('三类事件字段在', typeof h.stale.pair_seen_7d === 'number' && typeof h.stale.reflect_merged_7d === 'number', h.stale)

  const now = new Date().toISOString()
  for (const type of ['memory.stale_pair_seen', 'memory.reflect_merged']) {
    w.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('evt_s7_' + type.replace(/\W/g, '') + Math.random(), w.aid, type, '{}', now)
  }
  const h2 = memoryHealth(w.db, w.aid)
  check('事件数进体检', h2.stale.pair_seen_7d >= 1 && h2.stale.reflect_merged_7d >= 1, h2.stale)

  // 阶段 E：挤出行 + key 分身份
  check('有 ejected 字段', typeof h.stale.ejected === 'number', h.stale)
  check('有 statement_eligible 字段', typeof h.stale.statement_eligible === 'number', h.stale)
  check('有 keys 分组', !!(h.keys && h.keys.by_type), h.keys)
  check('passport.slot 与 keys.slot 一致', h.passport.slot === h.keys.slot, { p: h.passport, k: h.keys })

  // 造一条作废 + 一条十天前的自省
  const dead = addMemory(w.db, w.aid, { text: '一条已经作废的记忆', type: 'fact', fact_key: '用户.测试.作废' })
  w.db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(now, dead.id)
  const oldReflect = addMemory(w.db, w.aid, { text: '十天前的一条自省', type: 'reflection' })
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?')
    .run(new Date(Date.now() - 10 * 86400000).toISOString(), oldReflect.id)
  const h3 = memoryHealth(w.db, w.aid)
  check('作废条进 ejected', h3.stale.ejected >= 1, h3.stale)
  check('十天前的自省算 statement_eligible', h3.stale.statement_eligible >= 1, h3.stale)
} finally { w.close() }

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
