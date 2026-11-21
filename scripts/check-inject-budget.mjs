/**
 * 注入预算表锁（P3 第三刀，2026-11-15）
 *  1. 默认：memory 800 / event 400
 *  2. 参数覆盖生效
 *  3. budgetTable 一次拿全
 *  4. 乱值（0/负数/非数字）回落默认，不把注入打成 0
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { writeParam } from '../src/kernel.js'
import { budgetOf, budgetTable, DEFAULTS } from '../src/modules/inject_budget.js'

const P = path.join(os.tmpdir(), 'dsh-check-inject-budget-' + Date.now() + '.db')
let fails = 0
const ok = (name, cond, extra) => {
  if (cond) { console.log('PASS', name) } else { fails++; console.log('FAIL', name, extra ? JSON.stringify(extra) : '') }
}

try {
  const db = openDb(P)
  const aid = 'a1'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '小测', 'daily', 'active', new Date().toISOString())

  ok('默认：memory 800', budgetOf(db, aid, 'memory') === 800, budgetOf(db, aid, 'memory'))
  ok('默认：event 400', budgetOf(db, aid, 'event') === 400, budgetOf(db, aid, 'event'))

  writeParam(db, aid, 'memory.inject.budget', 700)
  writeParam(db, aid, 'event.inject.budget', 300)
  ok('覆盖：memory 700', budgetOf(db, aid, 'memory') === 700, budgetOf(db, aid, 'memory'))
  ok('覆盖：event 300', budgetOf(db, aid, 'event') === 300, budgetOf(db, aid, 'event'))

  const t = budgetTable(db, aid)
  ok('一张表拿全', t.memory === 700 && t.event === 300, t)

  writeParam(db, aid, 'event.inject.budget', 0)
  ok('乱值回落默认（不把注入打成 0）', budgetOf(db, aid, 'event') === DEFAULTS.event, budgetOf(db, aid, 'event'))

  db.close()
} catch (e) {
  fails++
  console.log('FAIL 预算表异常:', (e && e.stack) || e)
} finally {
  try { fs.rmSync(P) } catch { /* 清理失败不影响结论 */ }
}
process.exit(fails ? 1 : 0)
