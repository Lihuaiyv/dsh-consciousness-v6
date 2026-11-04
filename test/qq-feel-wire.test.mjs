/**
 * 第 5 步：QQ 线的 feel。
 * QQ 会话回复也走宿主 agent + consciousnessBlock，所以 feel 注入对主人是有的；
 * 非主人那条路用 snap:'off' 关掉，不把「我上一句的感觉」漏给客人。
 * 运行：node test/qq-feel-wire.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { consciousnessBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-qqfeel-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_qqfeel'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'QQ线', 'daily', 'active', new Date().toISOString())

function feel(agoMin, text) {
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('afe_' + Math.random().toString(36).slice(2, 8), aid, new Date(Date.now() - agoMin * 60000).toISOString(), text, 'joy', 0.1, 0.2, 0.3, null, 'tool')
}

// 1) 主人 QQ：feel 行在
{
  feel(3, '刚被夸了一句，心里有点亮')
  const block = consciousnessBlock(db, aid, {})
  check('主人线上带 feel 行', block.includes('我上一句说出来之前，心里是这样') && block.includes('刚被夸了一句'), block.slice(0, 200))
}

// 2) 非主人 QQ（snap:'off'）：feel 行不出现
{
  const block = consciousnessBlock(db, aid, { snap: 'off' })
  check('非主人线不带 feel 行', !block.includes('我上一句说出来之前'), block.slice(0, 200))
}

// 3) 超过 affect.feel.hours（默认 2 小时）的 feel 不冒充「刚说完」
{
  const aid2 = 'agt_qqfeel_old'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid2, aid2, 'daily', 'active', new Date().toISOString())
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('afe_old', aid2, new Date(Date.now() - 3 * 3600000).toISOString(), '三小时前的感觉', 'calm', null, null, null, null, 'tool')
  const block = consciousnessBlock(db, aid2, {})
  check('太旧的 feel 不上线', !block.includes('三小时前的感觉'), block.slice(0, 200))
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
