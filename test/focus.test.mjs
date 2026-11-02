/**
 * 焦点测试：欠账类开环（答应过 / 提醒）在注入里抬成「你现在最在意的其实是这件事」，
 * 普通开环保持旧措辞；focus 关掉时逐字回到旧版。
 * 运行：node test/focus.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addLoop, loopLineFor, loopPrefixOf } from '../src/modules/loops.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-focus-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_focus_' + Math.random().toString(36).slice(2, 8)
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '焦点', 'daily', 'active', now())
const at = Date.now() + 3600000

// ---- 空数据 ----
const empty = loopLineFor(db, aid, { at })
check('空开环：text 为空', empty.text === '', empty)
check('空开环：kinds 是空数组', Array.isArray(empty.kinds) && empty.kinds.length === 0, empty)

// ---- 普通待办：不抬成焦点 ----
addLoop(db, aid, { text: '把测试报告补完', kind: 'task', due_at: new Date(at - 60000).toISOString(), at })
const normal = loopLineFor(db, aid, { at, throttleHours: 6 })
check('普通开环：kinds[0]=task', normal.kinds[0] === 'task', normal.kinds)
check('普通开环：前缀还是「还挂着」', loopPrefixOf(normal.kinds).includes('还挂着'), loopPrefixOf(normal.kinds))
check('普通开环：不出现「最在意」', !(loopPrefixOf(normal.kinds) + normal.text).includes('最在意'), normal)

// ---- 欠账：抬成焦点 ----
const aid2 = 'agt_focus2_' + Math.random().toString(36).slice(2, 8)
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid2, '欠账', 'daily', 'active', now())
addLoop(db, aid2, { text: '答应周末重画记忆面板的图', kind: 'promise', due_at: new Date(at - 60000).toISOString(), at })
const owed = loopLineFor(db, aid2, { at, throttleHours: 6 })
check('欠账开环：kinds[0]=promise', owed.kinds[0] === 'promise', owed.kinds)
check('欠账开环：前缀是「最在意的其实是」', loopPrefixOf(owed.kinds).includes('最在意的其实是'), loopPrefixOf(owed.kinds))
check('欠账开环：焦点句只出现一次', (loopPrefixOf(owed.kinds) + owed.text).split('最在意').length === 2, owed)
check('focus 关掉：回旧措辞', loopPrefixOf(owed.kinds, { focusOn: false }).includes('还挂着'), loopPrefixOf(owed.kinds, { focusOn: false }))

// ---- 混合：欠账排前面（pendingLoops 的 half_said / 到期排序保证） ----
addLoop(db, aid2, { text: '顺手把桌子收拾了', kind: 'task', due_at: new Date(at - 70000).toISOString(), at })
const mixed = loopLineFor(db, aid2, { at, limit: 3, throttleHours: 6 })
check('混合：第一条仍是欠账', mixed.kinds[0] === 'promise', mixed.kinds)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
