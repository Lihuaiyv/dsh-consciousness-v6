/**
 * 锚点名额冷却（2026-11-15）
 *
 * 守三件事：
 *   1) 同一条记忆在冷却窗口内不再被名额选中（第二、三轮换人）；
 *   2) `cooldownHours = 0` 时行为与改动前逐字一致（仍选同一条）；
 *   3) 候选全在冷却里时返回空，不退回老几条。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { importanceAnchors } from '../src/modules/retrieve.js'

let pass = 0
const fails = []
function check(name, ok, got) {
  if (ok) { pass++; return }
  fails.push(name + (got === undefined ? '' : '｜' + JSON.stringify(got).slice(0, 200)))
}

const file = path.join(os.tmpdir(), 'dsh-anchor-cd-' + Date.now() + '.db')
const db = openDb(file)
const AID = 'agt_test_anchor'
const nowIso = new Date().toISOString()

const ins = db.prepare(`INSERT INTO memory_items(id,agent_id,type,text,source,last_decay_at,created_at,hits,last_hit_at,importance,mark)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
// A：钉住的、最重要的 → 旧行为里永远占第一个名额
ins.run('a1', AID, 'fact', '我是谁的那句话。', 'manual', nowIso, nowIso, 0, nowIso, 1.0, 'locked')
ins.run('b1', AID, 'fact', '第二条重要的事。', 'manual', nowIso, nowIso, 0, nowIso, 0.95, 'normal')
ins.run('c1', AID, 'fact', '第三条重要的事。', 'manual', nowIso, nowIso, 0, nowIso, 0.95, 'normal')

// 1) 没有冷却记录 → 旧的最高优先（locked 的那条）
const first = importanceAnchors(db, AID, { limit: 1, cooldownHours: 24 })
check('第一次没冷却记录：选中最重的（a1）', first.length === 1 && first[0].id === 'a1', first.map((x) => x.id))

// 把 a1 记成「这一轮通过名额被拉过」
db.prepare('INSERT INTO surfaced_items(id,agent_id,memory_id,kind,text,at) VALUES(?,?,?,?,?,?)')
  .run('sf_test_1', AID, 'a1', 'anchor', '我是谁的那句话。', nowIso)

// 2) 冷却开着 → 换人
const second = importanceAnchors(db, AID, { limit: 1, cooldownHours: 24 })
check('冷却中：不再选 a1，换下一个', second.length === 1 && second[0].id !== 'a1', second.map((x) => x.id))

// 3) cooldownHours=0 → 回到旧行为
const third = importanceAnchors(db, AID, { limit: 1, cooldownHours: 0 })
check('cooldown=0：仍选 a1（旧行为不变）', third.length === 1 && third[0].id === 'a1', third.map((x) => x.id))

// 4) 候选全在冷却里 → 返回空，不退回老的
for (const id of ['a1', 'b1', 'c1']) {
  db.prepare('INSERT INTO surfaced_items(id,agent_id,memory_id,kind,text,at) VALUES(?,?,?,?,?,?)')
    .run('sf_' + id + '_2', AID, id, 'anchor', 'x', nowIso)
}
const fourth = importanceAnchors(db, AID, { limit: 1, cooldownHours: 24 })
check('全在冷却里：这一轮不占名额（返回空）', fourth.length === 0, fourth.map((x) => x.id))

db.close()
try { fs.unlinkSync(file) } catch { /* 删不掉不影响结论 */ }

if (fails.length) {
  console.log('失败 ' + fails.length + ' 条：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
console.log('锚点名额冷却：通过 ' + pass + ' / ' + pass)
