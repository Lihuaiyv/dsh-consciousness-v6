/**
 * 整体模拟：焦点 / 潜台词 / 收尾 三条新注入在同一个 consciousnessBlock 里能不能各就各位，
 * 以及 stranger 是否被隔离。临时脚本，不进正式测试。
 * 运行：node scripts/__sim_morehuman.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addLoop } from '../src/modules/loops.js'
import { consciousnessBlock } from '../index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-morehuman-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}
function mkAgent(name) {
  const id = 'agt_sim_' + Math.random().toString(36).slice(2, 8)
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, name, 'daily', 'active', now())
  return id
}

// 场景 C：欠账开环 → 焦点
{
  const aid = mkAgent('焦点')
  const at = Date.now()
  addLoop(db, aid, { text: '答应周末把记忆面板的图重画', kind: 'promise', due_at: new Date(at - 3600000).toISOString(), at })
  const block = consciousnessBlock(db, aid, {})
  check('焦点：欠账抬成「最在意的其实是」', block.includes('最在意的其实是这件事'), block.slice(0, 300))
  check('焦点：只出现一次', block.split('最在意').length === 2, block.split('最在意').length)
}

// 场景 A：冲突 → 潜台词（不聊够，所以不会触发收尾）
{
  const aid = mkAgent('潜台词')
  db.prepare('INSERT INTO conflicts(id,agent_id,a_id,b_id,state,evidence,opened_at) VALUES(?,?,?,?,?,?,?)')
    .run('cf1', aid, 'a1', 'b1', 'open', JSON.stringify({ attribute: { sentence_a: '主人说咖啡不喝', sentence_b: '主人说咖啡要喝' } }), now())
  const block = consciousnessBlock(db, aid, {})
  check('潜台词：冲突时出一句', block.includes('心里其实想说但没说出口'), block.slice(0, 300))
  check('潜台词：不会替她直接说出来', block.includes('这句不用讲出来'), block.slice(0, 300))
}

// 场景 B：深夜聊够 → 收尾，且不再叠潜台词
{
  const aid = mkAgent('收尾')
  db.prepare('INSERT INTO conflicts(id,agent_id,a_id,b_id,state,evidence,opened_at) VALUES(?,?,?,?,?,?,?)')
    .run('cf2', aid, 'a1', 'b1', 'open', JSON.stringify({ attribute: { sentence_a: '主人说咖啡不喝', sentence_b: '主人说咖啡要喝' } }), now())
  const ins = db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)')
  for (let i = 0; i < 4; i++) {
    ins.run('ct_u' + i, aid, 'user', i === 3 ? '今天这堆东西总算改完了' : '在吗 ' + i, new Date(Date.now() - (8 - i * 2) * 60000).toISOString())
    ins.run('ct_a' + i, aid, 'agent', '嗯。', new Date(Date.now() - (7 - i * 2) * 60000).toISOString())
  }
  const block = consciousnessBlock(db, aid, {})
  check('收尾：深夜聊够给念头', block.includes('你有点想收尾了'), block.slice(0, 300))
  check('收尾：不同时叠潜台词', !block.includes('心里其实想说但没说出口'), block.slice(0, 300))
}

// 场景 D：stranger 隔离
{
  const aid = mkAgent('陌生人')
  const ins = db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)')
  for (let i = 0; i < 8; i++) ins.run('ct_s' + i, aid, i % 2 ? 'agent' : 'user', '嗯', new Date(Date.now() - i * 60000).toISOString())
  const block = consciousnessBlock(db, aid, { audience: 'stranger' })
  check('stranger：不含潜台词', !block.includes('心里其实想说但没说出口'))
  check('stranger：不含收尾', !block.includes('你有点想收尾了'))
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
