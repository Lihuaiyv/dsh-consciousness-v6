/**
 * 热度按「用上」记（2026-11-14）· 单元测试
 *
 * 守三件事：
 *   1) markSurfacedUsed 返回的是「命中的 memory_id 列表」，不是条数——调用方要拿它去加热。
 *   2) 只 touch 这几条 → 只有它们 hits+1、last_hit_at 拨到现在；没被说出口的一个字不动。
 *   3) 反证：旧路（注入就把所有条目 touch 一遍）会把每一条都拨到现在——正是要拆的那个环。
 *
 * 不碰真库：临时文件 + openDb 建全新库，跑完删。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { touch } from '../src/modules/tiers.js'
import { recordSurfaced, markSurfacedUsed } from '../src/modules/surfacing.js'

let pass = 0
const fails = []
function check(name, ok, got) {
  if (ok) { pass++; return }
  fails.push(name + (got === undefined ? '' : '｜' + JSON.stringify(got).slice(0, 200)))
}

const file = path.join(os.tmpdir(), 'dsh-heat-on-use-' + Date.now() + '.db')
const db = openDb(file)
const AID = 'agt_test_heat'

const nowIso = new Date().toISOString()
const oldIso = new Date(Date.now() - 5 * 86400000).toISOString()

const ins = db.prepare(`INSERT INTO memory_items(id,agent_id,type,text,source,last_decay_at,created_at,hits,last_hit_at,importance,mark)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`)

const rows = [
  { id: 'm1', text: '汐是夜里涨落的潮水，退得再远也会再回来一次。', hits: 100, at: oldIso },
  { id: 'm2', text: '用户不喜欢被恭维，明确要求不要恭维。', hits: 3, at: oldIso },
  { id: 'm3', text: '桌上那份没提交的还没收起来。', hits: 0, at: oldIso },
]
for (const r of rows) ins.run(r.id, AID, 'reflection', r.text, 'manual', r.at, r.at, r.hits, r.at, 0.5, 'normal')

// 这一轮注入了三条
recordSurfaced(db, AID, rows.map((r) => ({ id: r.id, text: r.text, via: 'related' })))

// 回复只引用了 m2 的话（换个说法也算：2-gram 覆盖 ≥0.3）
const used = markSurfacedUsed(db, AID, '你说过不喜欢被恭维，明确要求我不要恭维你——这条我记着。')
check('markSurfacedUsed 返回命中的 id 列表（不是条数）', Array.isArray(used) && used.length === 1 && used[0] === 'm2', used)

const getRow = (id) => db.prepare('SELECT hits,last_hit_at FROM memory_items WHERE id=?').get(id)
const before = Object.fromEntries(rows.map((r) => [r.id, getRow(r.id)]))

touch(db, used)
const after = Object.fromEntries(rows.map((r) => [r.id, getRow(r.id)]))

check('说出口那条 hits+1', after.m2.hits === before.m2.hits + 1, after.m2)
check('说出口那条 last_hit_at 拨到现在', after.m2.last_hit_at !== before.m2.last_hit_at, after.m2)
check('没说出口的一条不动（m1）', after.m1.hits === before.m1.hits && after.m1.last_hit_at === before.m1.last_hit_at, after.m1)
check('没说出口的一条不动（m3）', after.m3.hits === before.m3.hits && after.m3.last_hit_at === before.m3.last_hit_at, after.m3)

// 反证：旧路 = 注入就把三条全 touch 一遍 → 三条全被拨到现在（这就是要拆的环）
touch(db, rows.map((r) => r.id))
const legacy = Object.fromEntries(rows.map((r) => [r.id, getRow(r.id)]))
check('旧路会把每一条都加热（这正是要拆的环）',
  legacy.m1.last_hit_at !== before.m1.last_hit_at && legacy.m3.last_hit_at !== before.m3.last_hit_at, legacy)

db.close()
try { fs.unlinkSync(file) } catch { /* 临时文件删不掉也不影响结论 */ }

if (fails.length) {
  console.log('失败 ' + fails.length + ' 条：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
console.log('热度按用上记：通过 ' + pass + ' / ' + pass)
