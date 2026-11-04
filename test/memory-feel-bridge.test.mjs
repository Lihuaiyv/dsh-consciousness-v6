/**
 * 第 1 步：记忆出生时挂上当时自己写的 feel。
 * 只挂窗口内的（默认 30 分钟），窗口外/没有就留空，不追认。
 * 运行：node test/memory-feel-bridge.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory, setFeelProvider } from '../src/modules/memory.js'
import { attachableFeelId } from '../src/modules/feel.js'
import { setParam } from '../src/kernel.js'

// 装配层（index.js）平时做的就是这一行：把「窗口内最近一条 feel」的口交给记忆模块
setFeelProvider(attachableFeelId)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelbridge-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

const MIN = 60000
function makeAgent(id) {
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, id, 'daily', 'active', new Date().toISOString())
  return id
}
function feelAt(aid, agoMin, text = '有点想靠过去一点') {
  const id = 'afe_t' + Math.random().toString(36).slice(2, 8)
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid, new Date(Date.now() - agoMin * MIN).toISOString(), text, 'joy', 0.1, 0.2, 0.3, null, 'tool')
  return id
}
const feelOf = (id) => db.prepare('SELECT feel_id FROM memory_items WHERE id=?').get(id).feel_id

// 1) 窗口内（5 分钟前）→ 挂上
{
  const aid = makeAgent('agt_fb_in')
  const fid = feelAt(aid, 5)
  const m = addMemory(db, aid, { text: '主人今天夸了一句。', type: 'fact', source: 'extract' })
  check('窗口内的 feel 挂到了记忆上', feelOf(m.id) === fid, { got: feelOf(m.id), want: fid })
}

// 2) 窗口外（40 分钟前）→ 不挂
{
  const aid = makeAgent('agt_fb_out')
  feelAt(aid, 40)
  const m = addMemory(db, aid, { text: '窗户外的一条。', type: 'fact', source: 'extract' })
  check('窗口外的 feel 不挂（不追认）', feelOf(m.id) == null, feelOf(m.id))
}

// 3) 完全没有 feel → 不挂，也不炸
{
  const aid = makeAgent('agt_fb_none')
  const m = addMemory(db, aid, { text: '空白的一条。', type: 'fact', source: 'manual' })
  check('没有 feel 时 feel_id 为 null', feelOf(m.id) == null, feelOf(m.id))
}

// 4) 参数 feel.attach.window 生效：窗口缩到 1 分钟，2 分钟前的不挂
{
  const aid = makeAgent('agt_fb_win')
  feelAt(aid, 2)
  setParam(db, aid, 'feel.attach.window', { value: 1 })
  const m = addMemory(db, aid, { text: '窗口收到一分钟。', type: 'fact', source: 'extract' })
  check('窗口参数生效：2 分钟前不挂', feelOf(m.id) == null, feelOf(m.id))
  // 同一个人把窗口放回 30 分钟，新写的能挂
  const fid2 = feelAt(aid, 0.1)
  setParam(db, aid, 'feel.attach.window', { value: 30 })
  const m2 = addMemory(db, aid, { text: '窗口放回去以后的新一条。', type: 'fact', source: 'extract' })
  check('窗口放回去后能挂', feelOf(m2.id) === fid2, { got: feelOf(m2.id), want: fid2 })
}

// 5) 完全重复的写法不新建（原有行为不变）
{
  const aid = makeAgent('agt_fb_dup')
  feelAt(aid, 1)
  const m1 = addMemory(db, aid, { text: '一条会被判重复的话。', type: 'fact', source: 'extract' })
  const m2 = addMemory(db, aid, { text: '一条会被判重复的话。', type: 'fact', source: 'extract' })
  check('重复文本仍走 duplicate，不新建', m2.duplicate === true && m2.id === m1.id, m2)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
