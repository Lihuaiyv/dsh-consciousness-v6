/**
 * Phase 4：关系事件带感觉。
 * 运行：node test/feel-rel-event.test.mjs
 *
 * 验证：
 *   1. rel_event 有 feel_id 列；
 *   2. 入账时带事件前 30 分钟内最近一条 feel；
 *   3. 窗口外的旧感觉不认（null）；
 *   4. 重复入账（同 fingerprint）不报错。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { observe } from '../src/modules/relations.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelrel-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_feelrel'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '账', 'daily', 'active', new Date().toISOString())

const cols = db.prepare("SELECT name FROM pragma_table_info('rel_event')").all().map((r) => r.name)
check('rel_event 有 feel_id 列', cols.includes('feel_id'), cols)

function feel(aid2, text, offsetMin = 0) {
  const id = 'afe_rel' + Math.random().toString(36).slice(2, 8)
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid2, new Date(Date.now() + offsetMin * 60000).toISOString(), text, 'calm', 0.1, 0.2, 0.3, null, 'tool')
  return id
}

// ---------- 1. 窗口内 ----------
{
  const fid = feel(aid, '说这句话的时候心里有点软', -5)
  const r = observe(db, aid, { text: '小周说晚上一起吃饭', source: 'chat' })
  const row = db.prepare('SELECT feel_id FROM rel_event WHERE id=?').get(r.id)
  check('关系事件带窗口内最近的 feel_id', row && row.feel_id === fid, row)
}

// ---------- 2. 窗口外不认 ----------
{
  const other = 'agt_feelrel_old'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(other, other, 'daily', 'active', new Date().toISOString())
  feel(other, '两个小时前的旧感觉', -120)
  const r = observe(db, other, { text: '很久以后才被提到的一件旧事', source: 'chat' })
  const row = db.prepare('SELECT feel_id FROM rel_event WHERE id=?').get(r.id)
  check('窗口外的旧感觉不认（null）', row && row.feel_id === null, row)
}

// ---------- 3. 重复入账不报错 ----------
{
  const r1 = observe(db, aid, { text: '同一句话再记一次', source: 'chat' })
  const r2 = observe(db, aid, { text: '同一句话再记一次', source: 'chat' })
  check('重复入账返回同一笔（dup）', r2.dup === true && r2.id === r1.id, { r1, r2 })
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
