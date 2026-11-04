/**
 * P0 止血：停写第三人称旁白 + 旁白落冷层 + 历史旁白不进常规注入。
 * 运行：node test/memory-narration.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve } from '../src/modules/retrieve.js'
import { narrationOnly, selfTextOk } from '../src/modules/memory_source.js'
import { getParam, setParam } from '../src/kernel.js'
import { writeExtractedItem } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

// ---- 旁白判定 ----
check('「用户正在…」判旁白', narrationOnly('用户正在推进一个分步骤实现任务') === true)
check('「用户要求…」判旁白', narrationOnly('用户要求按七步逐步实现') === true)
check('「用户偏好…」判旁白', narrationOnly('用户偏好先规划后执行') === true)
check('「对话中没有…」判旁白', narrationOnly('对话中没有明显情绪，需求偏实用') === true)
check('「事实层面…」判旁白', narrationOnly('事实层面可确认的是用户正在跟进排查') === true)
check('真事实不判旁白', narrationOnly('用户提供了交付组和集成组人员名单') === false, narrationOnly('用户提供了交付组和集成组人员名单'))
check('技术结论不判旁白', narrationOnly('多选题少选给半分，填空题忽略大小写') === false)
check('空串不判旁白', narrationOnly('') === false)
check('纯用户原话不判旁白（无谓语触发）', narrationOnly('手写的草稿要不要也过五闸') === false)

// ---- 她自己的句子（P1 闸门）----
check('第一人称通过', selfTextOk('我把回滚按钮接上了，刷新就能看见') === true)
check('旁白不通过', selfTextOk('用户要求把回滚按钮接上') === false)
check('太短不通过', selfTextOk('我') === false)
check('太长不通过', selfTextOk('我' + '啊'.repeat(200)) === false)
check('运行时报错不通过', selfTextOk('我把日志贴出来：Error: boom') === false)

// ---- 参数默认值 ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-narr-'))
  const db = openDb(path.join(dir, 'app.db'))
  attachDb(db)
  const aid = 'agt_narr'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '旁白', 'daily', 'active', new Date().toISOString())

  check('摘要写 T1 默认 off', getParam(db, aid, 'memory.write.summary_to_t1') === 'off', getParam(db, aid, 'memory.write.summary_to_t1'))
  check('历史旁白注入默认 off', getParam(db, aid, 'memory.inject.user_summary') === 'off')

  // ---- 旁白落冷层 ----
  const narr = writeExtractedItem(db, aid, { text: '用户正在推进一个分步骤实现任务', type: 'fact' })
  const narrRow = db.prepare('SELECT * FROM memory_items WHERE id=?').get(narr.id)
  check('旁白仍落库（不丢）', !!narrRow, narr)
  check('旁白进冷层', narrRow && narrRow.temp_state === 'cold', narrRow && narrRow.temp_state)
  check('旁白置信度压低', narrRow && Number(narrRow.confidence) === 0.5, narrRow && narrRow.confidence)
  check('旁白来源仍是 extract', narrRow && narrRow.source === 'extract')

  const real = writeExtractedItem(db, aid, { text: '多选题少选给半分', type: 'fact' })
  const realRow = db.prepare('SELECT * FROM memory_items WHERE id=?').get(real.id)
  check('真事实不落冷层', realRow && realRow.temp_state !== 'cold', realRow && realRow.temp_state)
  check('真事实置信度 0.7', realRow && Number(realRow.confidence) === 0.7)

  const empty = writeExtractedItem(db, aid, { text: '   ' })
  check('空条直接丢', empty.action === 'drop', empty)

  // ---- 历史旁白不进 S1 注入 ----
  addMemory(db, aid, { text: '用户正在整理潮汐表的顺序，希望按风险排序', type: 'reflection', source: 'summary' })
  addMemory(db, aid, { text: '潮汐表还差一列没有排序', type: 'fact', source: 'manual' })
  const off = retrieve(db, aid, '潮汐表 排序', { k: 6 })
  check('默认注入不含 summary', !off.items.some((x) => x.source === 'summary'), off.items.map((x) => x.source))
  check('默认注入仍含普通条目', off.items.some((x) => String(x.text).includes('潮汐表还差一列')), off.items.map((x) => x.text))

  const on = retrieve(db, aid, '潮汐表 排序', { k: 6, summaryInjected: true })
  check('开关打开后 summary 回来', on.items.some((x) => x.source === 'summary'), on.items.map((x) => x.source))

  db.close()
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
