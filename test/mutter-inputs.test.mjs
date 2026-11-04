/**
 * 第 4 步：嘀咕的输入材料——真实的 feel 和咽回去的半句。
 * 只读、按窗口取，取不到就空，不编。
 * 运行：node test/mutter-inputs.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { mutterMaterials, latestUnsaidFor } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-mutterinputs-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_mutterin'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '嘀咕材料', 'daily', 'active', new Date().toISOString())

function feel(agoMin, text) {
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('afe_' + Math.random().toString(36).slice(2, 8), aid, new Date(Date.now() - agoMin * 60000).toISOString(), text, 'curious', 0.1, 0.2, 0.3, null, 'tool')
}
function unsaid(cause, text, agoMin = 1) {
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
    .run('evt_' + Math.random().toString(36).slice(2, 8), aid, 'unsaid.moment', JSON.stringify({ text, event_id: null, cause }), new Date(Date.now() - agoMin * 60000).toISOString())
}
const turns = [{ role: 'user', text: '你最近还好吗' }, { role: 'assistant', text: '还行。' }]

// 1) 什么都没有 → 空数组，不编
{
  const out = mutterMaterials(db, aid, turns)
  check('没有材料时返回空数组', Array.isArray(out) && out.length === 0, out)
}

// 2) 有 feel → 第一条是 feel
{
  feel(3, '有点想被问一句')
  const out = mutterMaterials(db, aid, turns)
  check('feel 进了材料', out.some((x) => x.includes('有点想被问一句')), out)
  check('feel 标了来源', out.some((x) => x.startsWith('（我自己之前写下的：')), out)
}

// 3) 有 unsaid（cause 匹配这一轮 user）→ 带上
{
  unsaid('你最近还好吗', '其实不太好')
  const out = mutterMaterials(db, aid, turns)
  check('咽回去的半句进了材料', out.some((x) => x.includes('其实不太好')), out)
  check('unsaid 标了来源', out.some((x) => x.startsWith('（这一轮咽回去的半句：')), out)
}

// 4) cause 对不上 → 不硬塞
{
  unsaid('完全无关的一句话', '别带这条')
  const hit = latestUnsaidFor(db, aid, '你最近还好吗')
  check('cause 对不上就不取', hit !== '别带这条', hit)
}

// 5) feel 太旧（4 小时前）→ 不放（窗口 180 分钟）
{
  const aid2 = 'agt_mutterin_old'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid2, aid2, 'daily', 'active', new Date().toISOString())
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('afe_old', aid2, new Date(Date.now() - 4 * 3600000).toISOString(), '四小时前的感觉', 'calm', null, null, null, null, 'tool')
  const out = mutterMaterials(db, aid2, turns)
  check('太旧的 feel 不进嘀咕', !out.some((x) => x.includes('四小时前的感觉')), out)
}

// 6) 只认本轮：上一轮的 unsaid 不该被这一轮拿走（cause 不同即隔离）
{
  const out = mutterMaterials(db, aid, [{ role: 'user', text: '今天星期几' }, { role: 'assistant', text: '周四。' }])
  check('换了话题就不带上一句的 unsaid', !out.some((x) => x.includes('其实不太好')), out)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
