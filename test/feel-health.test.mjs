/**
 * P7：存储体检要能看见「感觉引用悬空」。
 * 运行：node test/feel-health.test.mjs
 *
 * 验证：
 *   1. 没有悬空引用时 feel_refs.bad = 0；
 *   2. 记忆 / 收据 / 纪要 / 关系事件 / 开环 / 嘀咕指向不存在的 feel 时，计数正确；
 *   3. 巡检只报告，不自动改库（auditStore 默认不 repair）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { auditStore } from '../src/modules/ops.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelhealth-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_feelhealth'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '体检', 'daily', 'active', new Date().toISOString())
const nowIso = () => new Date().toISOString()

// 正常的 feel
db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .run('afe_ok', aid, nowIso(), '一条正常的', null, null, null, null, null, 'tool')

function mem(id, feelId) {
  db.prepare(`INSERT INTO memory_items(id,agent_id,type,text,source,last_decay_at,status,created_at,deleted_at,feel_id)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, aid, 'fact', '记忆 ' + id, 'test', nowIso(), 'active', nowIso(), null, feelId)
}

// ---------- 1. 干净时 0 ----------
mem('m_ok', 'afe_ok')
mem('m_null', null)
{
  const out = auditStore(db)
  const c = out.checks.find((x) => x.name === 'feel_refs')
  check('体检报告里有 feel_refs 这一项', !!c, out.checks.map((x) => x.name))
  check('干净时 feel_refs.bad = 0', c && c.bad === 0, c)
}

// ---------- 2. 各处悬空各一条 ----------
mem('m_bad', 'afe_missing')
db.prepare('INSERT INTO fact_archive(id,agent_id,memory_id,text,created_at,feel_id) VALUES(?,?,?,?,?,?)')
  .run('fa_bad', aid, 'm_bad', '存根', nowIso(), 'afe_missing')
db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,importance,source,feel_id,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ep_bad', aid, 's1', '2026-11-05', nowIso(), nowIso(), 1, 't', 's', '[]', '[]', 0.5, 'rules', 'afe_missing', nowIso())
db.prepare(`INSERT INTO rel_event(id,agent_id,kind,source,session_id,turn_id,speaker_id,text,payload,at,fingerprint,created_at,feel_id)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('rev_bad', aid, 'utterance', 'chat', 's1', 't1', null, 'x', '{}', nowIso(), 'fp_bad', nowIso(), 'afe_missing')
db.prepare(`INSERT INTO open_loops(id,agent_id,kind,text,memory_id,source_turn_id,due_at,stale_after,state,feel_id,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('lp_bad', aid, 'task', '待办', null, null, null, null, 'open', 'afe_missing', nowIso(), nowIso())
{
  const out = auditStore(db)
  const c = out.checks.find((x) => x.name === 'feel_refs')
  check('五处悬空各记一笔 = 5', c && c.bad === 5, c)
  check('体检不自动清引用', db.prepare('SELECT COUNT(*) c FROM memory_items WHERE feel_id=?').get('afe_missing').c === 1, null)
  check('ok 因悬空为 false', out.ok === false, out.ok)
}

// ---------- 3. 修好后回到 0 ----------
{
  db.prepare("UPDATE memory_items SET feel_id=NULL WHERE feel_id='afe_missing'").run()
  db.prepare("UPDATE fact_archive SET feel_id=NULL WHERE feel_id='afe_missing'").run()
  db.prepare("UPDATE episodes SET feel_id=NULL WHERE feel_id='afe_missing'").run()
  db.prepare("UPDATE rel_event SET feel_id=NULL WHERE feel_id='afe_missing'").run()
  db.prepare("UPDATE open_loops SET feel_id=NULL WHERE feel_id='afe_missing'").run()
  db.prepare("UPDATE thoughts SET feel_id=NULL WHERE feel_id='afe_missing'").run()
  const out = auditStore(db)
  const c = out.checks.find((x) => x.name === 'feel_refs')
  check('引用清掉后 feel_refs 回到 0', c && c.bad === 0, c)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
