// 影子帧进提示词（2026-11-17）：shadowFrameLine 从 affect_v4_shadow 取最近一帧，优先 model 行；
// 格式和旧帧一致（## 上一帧 / 停在 / 锚是），空表返回空。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { shadowFrameLine } from '../src/modules/frame_line.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-line-'))
const db = openDb(path.join(dir, 'a.db'))
const aid = 'agt_frame_test'
const t = new Date().toISOString()
const ins = db.prepare(`INSERT INTO affect_v4_shadow
  (id, agent_id, turn_id, conversation_id, at, frame_json, s, n, d, label,
   primary_json, secondary_json, confidence, source, latency_ms, freeframe, rev, judgment_json)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const add = (id, source, frame, turn) => ins.run(id, aid, turn, 'c', t, JSON.stringify(frame), 0.5, 0.3, 0.5, '安', '{}', '{}', 0.2, source, 1, 0, source === 'model' ? 2 : 1, null)

let passed = 0
function check(name, ok, detail) {
  if (!ok) { console.error('FAIL', name, detail === undefined ? '' : detail); process.exit(1) }
  passed++
  console.log('ok', name)
}

check('空表返回空', shadowFrameLine(db, aid) === '', JSON.stringify(shadowFrameLine(db, aid)))

add('r1', 'rules', { summary: '规则事', what: '规则这句' }, 't1')
const onlyRules = shadowFrameLine(db, aid)
check('只有规则帧也能出', onlyRules.includes('停在「规则事」') && onlyRules.includes('锚是「规则这句」'), JSON.stringify(onlyRules))
check('格式带标题', onlyRules.startsWith('## 上一帧'), JSON.stringify(onlyRules.slice(0, 10)))

add('m1', 'model', { summary: '模型事', what: '模型这句' }, 't1')
const preferModel = shadowFrameLine(db, aid)
check('优先用 model 行', preferModel.includes('停在「模型事」') && !preferModel.includes('规则事'), JSON.stringify(preferModel))

const long = shadowFrameLine(db, aid, { max: 8 })
check('max 收得住（有下限 40，不爆）', long.length <= 60, 'len=' + long.length)

check('没有 agent 返回空', shadowFrameLine(db, '') === '')

db.close()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
console.log(`\n${passed} 项全过`)
