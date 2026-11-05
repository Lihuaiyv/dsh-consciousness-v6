/**
 * Phase 1：清理口补洞。
 * 运行：node test/feel-purge.test.mjs
 *
 * 验证：
 *   1. 整实例清除时 affect_feel 跟着清，不再留孤儿；
 *   2. 门禁判删（status='deleted'）满 7 天也会被真正硬删，不再永远停在原地；
 *   3. 单条记忆硬删不动 feel 本体（感觉是独立的，删记忆不等于删感觉）；
 *   4. 未满 7 天的 soft_deleted 不动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { purgeExpired } from '../src/core.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelpurge-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const iso = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toISOString()
const now = new Date().toISOString()

function agent(id) {
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version,deleted_at) VALUES(?,?,?,?,?,1,?)')
    .run(id, id, 'daily', 'active', now, null)
}
function mem(id, aid, status, deletedAt) {
  db.prepare(`INSERT INTO memory_items(id,agent_id,type,text,source,last_decay_at,status,created_at,deleted_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, aid, 'fact', '记忆 ' + id, 'test', now, status, iso(30), deletedAt)
  db.prepare('INSERT INTO fact_archive(id,agent_id,memory_id,text,created_at) VALUES(?,?,?,?,?)')
    .run('fa_' + id, aid, id, '存根 ' + id, iso(30))
}
// 改写留下的历史存根（<id>:hist:<n>）——硬删时也要一起清
function histFact(id, aid, n) {
  db.prepare('INSERT INTO fact_archive(id,agent_id,memory_id,text,created_at) VALUES(?,?,?,?,?)')
    .run('fa_hist_' + id + '_' + n, aid, id + ':hist:' + n, '旧句 ' + n, iso(20))
}
function feel(id, aid, text) {
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source,turn_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid, now, text, null, null, null, null, null, 'tool', null)
}
function hasMem(id) { return !!db.prepare('SELECT 1 FROM memory_items WHERE id=?').get(id) }
function hasFeel(id) { return !!db.prepare('SELECT 1 FROM affect_feel WHERE id=?').get(id) }
function hasFact(id) { return !!db.prepare('SELECT 1 FROM fact_archive WHERE memory_id=?').get(id) }

// ---------- 场景 1：单条记忆的硬删 ----------
agent('agt_p1')
mem('m_active', 'agt_p1', 'active', null)
mem('m_soft_old', 'agt_p1', 'soft_deleted', iso(8))
mem('m_del_old', 'agt_p1', 'deleted', iso(8))
mem('m_soft_new', 'agt_p1', 'soft_deleted', iso(3))
histFact('m_soft_old', 'agt_p1', 1)
histFact('m_soft_old', 'agt_p1', 2)
feel('afe_1', 'agt_p1', '这会儿还挺稳')
feel('afe_2', 'agt_p1', '有点困了')

const r1 = purgeExpired(db)
check('purge 返回 memories=2（soft_old + deleted_old）', r1.memories === 2, r1)
check('active 记忆不动', hasMem('m_active'), r1)
check('未满 7 天的 soft_deleted 不动', hasMem('m_soft_new'), r1)
check('满 7 天的 soft_deleted 被硬删', !hasMem('m_soft_old'), r1)
check('满 7 天的门禁 deleted 也被硬删', !hasMem('m_del_old'), r1)
check('硬删连旧存根一起清（soft_old）', !hasFact('m_soft_old'), r1)
check('硬删连旧存根一起清（deleted_old）', !hasFact('m_del_old'), r1)
check('硬删连历史改写存根一起清', !db.prepare("SELECT 1 FROM fact_archive WHERE memory_id LIKE 'm_soft_old:hist:%'").get(), r1)
check('单条记忆硬删不动 feel 本体', hasFeel('afe_1') && hasFeel('afe_2'), r1)

// ---------- 场景 2：整实例清除 ----------
agent('agt_p2')
db.prepare("UPDATE agents SET status='soft_deleted', deleted_at=? WHERE id=?").run(iso(8), 'agt_p2')
feel('afe_p2', 'agt_p2', '这个实例最后一句感觉')
db.prepare('INSERT INTO memory_items(id,agent_id,type,text,source,last_decay_at,status,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('m_p2', 'agt_p2', 'fact', '要跟着实例走', 'test', now, 'active', iso(30), null)

const r2 = purgeExpired(db)
check('purge 返回 agents=1', r2.agents === 1, r2)
check('整实例清除时 affect_feel 跟着清（无孤儿）', !hasFeel('afe_p2'), r2)
check('整实例清除时记忆跟着清', !hasMem('m_p2'), r2)
check('agents 行已删', !db.prepare('SELECT 1 FROM agents WHERE id=?').get('agt_p2'), r2)
check('另一个实例的 feel 不受影响', hasFeel('afe_1') && hasFeel('afe_2'), r2)
check('另一个实例的记忆不受影响', hasMem('m_active'), r2)

// ---------- 场景 3：重复跑幂等 ----------
const r3 = purgeExpired(db)
check('再跑一次没有可清的', r3.agents === 0 && r3.memories === 0, r3)

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
