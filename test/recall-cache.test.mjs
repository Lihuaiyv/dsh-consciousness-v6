/**
 * 召回缓存（B4）：新的一句到了就作废，不能拿上一句的记忆冒充这一句。
 *
 * 以前 recentRecall 只按 60 秒过期：连问两句，第二句根本没重新检索，
 * 只是把第一句的结果又贴了一遍。对话里看不出错，但那不是「记得」，是答非所问。
 *
 * 运行：node test/recall-cache.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { seedTiers } from '../src/modules/relations.js'
import { consciousnessBlock, recentRecall, invalidateRecallCache } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const now = () => new Date().toISOString()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-cache-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_cache_1'

db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())
seedTiers(db)
db.prepare(`INSERT INTO rel_person(id,agent_id,name,tier,closeness,trust,dependence,salience,status,
  first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('rp_c1', aid, '主人', 'owner', 0.9, 0.7, 0.2, 1, 'active', now(), now(), now(), now())
addMemory(db, aid, { text: '主人说过想去看海。', type: 'fact' })
addMemory(db, aid, { text: '主人喜欢先给结论再解释。', type: 'fact' })

const STALE = '- 这是上一句话召回来的记忆'

// 1) 缓存里有上一句的召回 → 直接被用上
recentRecall.set(aid, { at: Date.now(), q: '上一句', text: STALE })
const b1 = consciousnessBlock(db, aid)
check('新鲜的缓存会被复用', b1.includes(STALE), b1.slice(0, 200))

// 2) 新的一句到了 → 必须作废
const removed = invalidateRecallCache(aid)
check('作废时确实删掉了', removed === true && recentRecall.has(aid) === false, { removed, still: recentRecall.has(aid) })

const b2 = consciousnessBlock(db, aid)
check('作废后不再复用上一句', !b2.includes(STALE), b2.slice(0, 200))
check('作废后退回热度兜底，仍记得真实的事', b2.includes('看海') || b2.includes('先给结论'), b2.slice(0, 300))

// 3) 重复作废不该炸
check('重复作废是安全的', invalidateRecallCache(aid) === false && invalidateRecallCache('不存在') === false)

// 4) 两个实例互不串台
recentRecall.set('other', { at: Date.now(), q: 'x', text: '- 另一只的事' })
invalidateRecallCache(aid)
check('只清自己的那条', recentRecall.has('other') === true && recentRecall.has(aid) === false)

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
