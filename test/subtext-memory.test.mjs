/**
 * 没说出口的事：同一类潜台词反复出现，要落成记忆，不能每轮重算一遍就没了。
 * 运行：node test/subtext-memory.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { recordSubtextMemory } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-submem-'))
const db = openDb(path.join(dir, 'app.db'))
const at = now()
db.prepare("INSERT INTO agents(id,name,created_at) VALUES('agt_s','测试',?)").run(at)

const show = (n) => {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run('evt_s' + i + '_' + Math.random().toString(36).slice(2, 6), 'agt_s', 'subtext.shown', JSON.stringify({ text: 'x', cls: 'holdfire' }), at)
  }
}

show(2)
check('两次还不到门槛', recordSubtextMemory(db, 'agt_s', 'holdfire') === null, null)

show(1)
const text = recordSubtextMemory(db, 'agt_s', 'holdfire')
check('第三次落成记忆', typeof text === 'string' && text.includes('没说出口'), text)
const n1 = db.prepare("SELECT COUNT(*) c FROM memory_items WHERE agent_id='agt_s' AND source='subtext'").get().c
check('记忆只有一条', n1 === 1, n1)
check('再调不重复写', recordSubtextMemory(db, 'agt_s', 'holdfire') === null, null)
const n2 = db.prepare("SELECT COUNT(*) c FROM memory_items WHERE agent_id='agt_s' AND source='subtext'").get().c
check('重复调用后仍是一条', n2 === 1, n2)

// 老库没有 events 表：不抛
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-submem2-'))
const db2 = openDb(path.join(dir2, 'app.db'))
db2.exec('DROP TABLE IF EXISTS events')
db2.prepare("INSERT INTO agents(id,name,created_at) VALUES('agt_x','老库',?)").run(now())
let okOld = false
try { okOld = recordSubtextMemory(db2, 'agt_x', 'conflict') === null } catch { okOld = false }
check('没有事件表时不抛', okOld, null)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
