/**
 * 关系事件可读文本测试：优先 rel_evidence；机器串（tier→ / link mention / 含 |）不用。
 * 运行：node test/relation-recall.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { remember, recentEventText } from '../src/modules/relations.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-relrecall-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_rel_' + Math.random().toString(36).slice(2, 8)
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '关系', 'daily', 'active', now())

const r = remember(db, aid, { name: '主人', tier: 'owner' })
const pid = r.id
check('建人成功', !!pid, r)

check('无证据：返回空', recentEventText(db, aid, pid) === '', recentEventText(db, aid, pid))
check('空 personId：返回空', recentEventText(db, aid, '') === '')

// 1) rel_evidence 的自然语言优先
db.prepare('INSERT INTO rel_evidence(id,agent_id,person_id,kind,text,weight,created_at) VALUES(?,?,?,?,?,?,?)')
  .run('rev1', aid, pid, 'chat', '主人说过想去看海', 1, now())
const ev1 = recentEventText(db, aid, pid)
check('优先取 evidence 的自然语言', ev1.text === '主人说过想去看海', ev1)

// 2) 只有机器串 rel_event：不返回
db.prepare('DELETE FROM rel_evidence WHERE agent_id=?').run(aid)
db.prepare('INSERT INTO rel_event(id,agent_id,kind,source,text,payload,at,fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('re1', aid, 'tier', 'ui', 'tier owner→owner', '{}', now(), 'fp1', now())
db.prepare('UPDATE rel_person SET last_event_id=? WHERE id=?').run('re1', pid)
check('机器串（tier→）：不返回', recentEventText(db, aid, pid) === '', recentEventText(db, aid, pid))

db.prepare('INSERT INTO rel_event(id,agent_id,kind,source,text,payload,at,fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('re2', aid, 'manual', 'ui', 'link mention', '{}', now(), 'fp2', now())
db.prepare('UPDATE rel_person SET last_event_id=? WHERE id=?').run('re2', pid)
check('机器串（link mention）：不返回', recentEventText(db, aid, pid) === '', recentEventText(db, aid, pid))

// 3) rel_event 里像人话的一句：可以返回
db.prepare('INSERT INTO rel_event(id,agent_id,kind,source,text,payload,at,fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('re3', aid, 'chat', 'chat', '主人说周五一起去海边', '{}', now(), 'fp3', now())
db.prepare('UPDATE rel_person SET last_event_id=? WHERE id=?').run('re3', pid)
const ev3 = recentEventText(db, aid, pid)
check('可读事件：返回正文', ev3.text.includes('周五一起去海边'), ev3)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
