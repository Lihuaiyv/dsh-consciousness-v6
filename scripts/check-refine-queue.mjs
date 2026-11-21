// 精修排队（2026-11-17）：同一个 agent 两个精修同时来，要把后一个排在前一个后面，而不是丢掉。
// 验：两个都返回 true、都写 model 行、调用次数 = 4（每个精修 topic+judge 各一次）、诊断不是 already。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { refineShadow } from '../src/modules/affect_v4_shadow.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refine-queue-'))
const db = openDb(path.join(dir, 'a.db'))
const aid = 'agt_test_refine'
const now = new Date().toISOString()

const frame = JSON.stringify({
  summary: '规则事', what: '规则句', target: 'me',
  material: { summaries: ['摘要一', '摘要二', '摘要三'], quotes: ['原话一', '原话二'] },
})
db.prepare('INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
  .run(aid, 'affect.engine.shadow.model', JSON.stringify('on'), now)
const mkRow = (turnId) => db.prepare(`INSERT INTO affect_v4_shadow
  (id, agent_id, turn_id, conversation_id, at, frame_json, s, n, d, label,
   primary_json, secondary_json, confidence, source, latency_ms, freeframe, rev, judgment_json)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('row_' + turnId, aid, turnId, 'conv_t', now, frame, 0.5, 0.3, 0.5, '安', '{}', '{}', 0.2, 'rules', 1, 0, 1, null)
mkRow('turnA')
mkRow('turnB')

// 一个回复同时带事层和判断层字段（sanitize 各取各的）
const reply = JSON.stringify({ summary: '他在问排队', what: '问为什么丢', target: 'me', goal_cong: -0.5, cong: 0.4, expectation: 0.6, novelty: 0.3, future: 0.2, why: '测试' })
let calls = 0
const reqs = []
const local = async (req) => { calls++; reqs.push(req); await new Promise((r) => setTimeout(r, 20)); return { text: reply } }

const [a, b] = await Promise.all([
  refineShadow(db, aid, { text: '第一句', turnId: 'turnA', conversationId: 'conv_t', local }),
  refineShadow(db, aid, { text: '第二句', turnId: 'turnB', conversationId: 'conv_t', local }),
])
const rows = db.prepare("SELECT turn_id FROM affect_v4_shadow WHERE agent_id=? AND source='model' ORDER BY rowid").all(aid)
const diagRaw = db.prepare("SELECT value FROM flags WHERE key='affect.v4.refine.diag'").get()
const diag = diagRaw ? JSON.parse(diagRaw.value) : null

let passed = 0
function check(name, ok, detail) {
  if (!ok) { console.error('FAIL', name, detail === undefined ? '' : detail); process.exit(1) }
  passed++
  console.log('ok', name)
}
check('并发两轮都跑完（不丢）', a === true && b === true, JSON.stringify({ a, b }))
check('两行 model 帧都写了', rows.length === 2 && rows[0].turn_id === 'turnA' && rows[1].turn_id === 'turnB', JSON.stringify(rows))
check('顺序没乱（先 turnA 后 turnB）', rows.map((r) => r.turn_id).join(',') === 'turnA,turnB', rows.map((r) => r.turn_id).join(','))
check('两次精修两次模型调用（塞句是代码，只判一次）', calls === 2, 'calls=' + calls)
check('诊断不是 already/overflow', !diag || !['already', 'overflow'].includes(diag.why), JSON.stringify(diag))
check('判断层吃到整帧（六轮摘要/原话）', reqs.some((r) => String(r.system || '').includes('判断层') && /最近几件事|最近原话/.test(String(r.text || ''))), JSON.stringify(reqs.map((r) => String(r.text || '').slice(0, 40))))
const f1 = JSON.parse(rows[0] ? db.prepare("SELECT frame_json FROM affect_v4_shadow WHERE agent_id=? AND source='model' ORDER BY rowid LIMIT 1").get(aid).frame_json : '{}')
check('判断顺带把总结写回帧（下一轮继承）', f1.summary === '他在问排队', JSON.stringify(f1.summary))

db.close()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
console.log(`\n${passed} 项全过`)
