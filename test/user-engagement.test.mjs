/**
 * 参与度信号：用户这句话多长、距上一句多久。只记不读，先攒数据。
 * 运行：node test/user-engagement.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { recordEngagement } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-eng-'))
const db = openDb(path.join(dir, 'app.db'))
const at = now()

const p1 = recordEngagement(db, 'agt_e', '在吗？', null, at)
check('记了字数', p1 && p1.len === 3, p1)
check('第一句没有间隔', p1 && p1.gap_min === null, p1)
check('不是主动消息', p1 && p1.pushed === false, p1)

recordEngagement(db, 'agt_e', '嗯', 0.5, at)
const rows = db.prepare("SELECT payload FROM events WHERE agent_id='agt_e' AND type='user.engagement' ORDER BY rowid").all()
check('两句都落库', rows.length === 2, rows.length)
const p2 = JSON.parse(rows[1].payload)
check('间隔保留一位小数', p2.gap_min === 0.5, p2)

const p3 = recordEngagement(db, 'agt_e', '（它主动来找你）主人，在吗', 2, at)
check('主动消息被标出来', p3 && p3.pushed === true, p3)

check('空文本不记', recordEngagement(db, 'agt_e', '', null, at) === null, null)

// 老库没有 events 表：不抛
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-eng2-'))
const db2 = openDb(path.join(dir2, 'app.db'))
db2.exec('DROP TABLE IF EXISTS events')
let okOld = false
try { okOld = recordEngagement(db2, 'agt_x', '在吗', null) === null } catch { okOld = false }
check('没有事件表时不抛', okOld, null)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
