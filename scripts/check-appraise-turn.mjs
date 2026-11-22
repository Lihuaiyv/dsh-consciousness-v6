// 定稿链验收（2026-11-17）：上一轮总结 + 本轮拼事帧判断
// 验：事来自「近十轮总结」flag、≤50 字；本轮写 rules+model 两行；同一轮不重复；材料在；judge 走注入。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { getFlag, setFlag } from '../src/kernel.js'
import { appraiseTurnNow, summarizeAffairs, JUDGE_SYS } from '../src/modules/affect_v4_shadow.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affect-chain-'))
const db = openDb(path.join(dir, 'a.db'))
const aid = 'agt_chain'
const t = new Date().toISOString()

let passed = 0
function check(name, ok, detail) {
  if (!ok) { console.error('FAIL', name, detail === undefined ? '' : detail); process.exit(1) }
  passed++
  console.log('ok', name)
}

// 0) 判断层提示词：没有补丁清单
check('判断提示词不再带「工作事务一律 0 / 反例 / 平常就写」', !/工作 \/ 技术事务|反例|平常的事就写/.test(JUDGE_SYS), JUDGE_SYS.slice(0, 80))
check('判断提示词要 meaning + 三个增量（2026-11-18 改问法）', /meaning/.test(JUDGE_SYS) && /goal_delta/.test(JUDGE_SYS) && /expect_delta/.test(JUDGE_SYS) && /future_delta/.test(JUDGE_SYS) && !/goal_cong/.test(JUDGE_SYS))

// 1) 上一轮总结：1~3 条事件结构、每条 ≤30 字、进 flag
const longLine = '我们在一条一条地核情绪链的文档，把旧事帧和新定稿对起来，还没收尾。'.repeat(3)
const line = await summarizeAffairs(db, aid, { complete: async () => longLine })
const lineParts = line.split('\n')
check('总结 1~3 条、每条≤30字（带·前缀≤32）', lineParts.length >= 1 && lineParts.length <= 3 && lineParts.every((p) => p.length <= 32), JSON.stringify(lineParts))
const flag = JSON.parse(getFlag(db, 'affect.v4.affairs') || '{}')
check('总结落进 affect.v4.affairs', flag.text === line, JSON.stringify(flag).slice(0, 100))

// 1b) 会话隔离：A、B 两个会话的「事」各存各的；材料不串会话
const lineA = await summarizeAffairs(db, aid, { conversationId: 'convA', complete: async () => 'A 会话正在核对文档' })
const lineB = await summarizeAffairs(db, aid, { conversationId: 'convB', complete: async () => 'B 会话在聊别的' })
check('A 会话的总结单独存在自己的键', JSON.parse(getFlag(db, 'affect.v4.affairs|convA') || '{}').text === '· A 会话正在核对文档', JSON.stringify({ lineA, lineB }))
check('B 会话的总结没覆盖 A', JSON.parse(getFlag(db, 'affect.v4.affairs|convB') || '{}').text === '· B 会话在聊别的')
db.prepare('INSERT INTO chat_turns (id,agent_id,role,text,created_at,conversation_id) VALUES (?,?,?,?,?,?)').run('cA', aid, 'user', 'A 会话的原话', new Date().toISOString(), 'convA')
db.prepare('INSERT INTO chat_turns (id,agent_id,role,text,created_at,conversation_id) VALUES (?,?,?,?,?,?)').run('cB', aid, 'user', 'B 会话的原话', new Date().toISOString(), 'convB')
const judgeReply2 = JSON.stringify({ fact: '技术讨论', meaning: '技术讨论', by: 'other', to: 'me', goal_delta: 0, expect_delta: 0.2, future_delta: 0, severity: 'none', why: '技术讨论', from: '这一句' })
await appraiseTurnNow(db, aid, { text: 'B 的这一句', turnId: 'tB', conversationId: 'convB', complete: async () => judgeReply2 })
const fB = JSON.parse(db.prepare("SELECT frame_json FROM affect_v4_shadow WHERE agent_id=? AND turn_id='tB' AND source='model'").get(aid).frame_json)
check('B 会话的事取 B 的总结', fB.summary === '· B 会话在聊别的', fB.summary)
check('B 会话的材料不串 A 的原话', !(fB.material?.quotes || []).some((q) => String(q).includes('A 会话')), JSON.stringify(fB.material?.quotes))

// 2) 本轮：拼事帧 + 判断 + 情绪，写两行
const judgeReply = JSON.stringify({ fact: '技术讨论', meaning: '技术讨论，没动到存在', by: 'other', to: 'me', goal_delta: 0, expect_delta: 0.2, future_delta: 0, severity: 'none', why: '技术讨论', from: '这一句' })
let calls = 0
const complete = async () => { calls++; return judgeReply }
const ok = await appraiseTurnNow(db, aid, { text: '这一句话', turnId: 't1', conversationId: 'c', complete })
const rows = db.prepare("SELECT * FROM affect_v4_shadow WHERE agent_id=? AND turn_id='t1' ORDER BY rowid").all(aid)
check('本轮写了两行（rules + model）', ok === true && rows.length === 2 && rows[0].source === 'rules' && rows[1].source === 'model', JSON.stringify(rows.map((r) => r.source)))
const f0 = JSON.parse(rows[0].frame_json || '{}')
const f1 = JSON.parse(rows[1].frame_json || '{}')
check('事用的是上一轮总结（不是这一句）', f0.summary === line && f1.summary === line, JSON.stringify({ f0: f0.summary, f1: f1.summary }))
check('事每条不超过 30 字（带·前缀≤32）', f1.summary.split('\n').every((p) => p.length <= 32), f1.summary)
check('材料在（原话 + 摘要）', Array.isArray(f1.material?.quotes) && Array.isArray(f1.material?.summaries), JSON.stringify(f1.material))
check('模型行 judgment 标 host', JSON.parse(rows[1].judgment_json || '{}').judge === 'host', rows[1].judgment_json)
check('本轮只调一次判断', calls === 1, calls)

// 3) 同一轮不重复
const again = await appraiseTurnNow(db, aid, { text: '这一句话', turnId: 't1', conversationId: 'c', complete })
check('同一轮只跑一次', again === false && db.prepare('SELECT count(*) n FROM affect_v4_shadow WHERE agent_id=? AND turn_id=?').get(aid, 't1').n === 2)

// 4) 判断失败：仍写两行，标 incomplete 并报警；不补数、不假装判出来了
const ok2 = await appraiseTurnNow(db, aid, { text: '第二句话', turnId: 't2', conversationId: 'c', complete: async () => { throw new Error('host down') } })
const t2rows = db.prepare("SELECT source, judgment_json FROM affect_v4_shadow WHERE agent_id=? AND turn_id='t2' ORDER BY rowid").all(aid)
const j2 = JSON.parse(t2rows[1].judgment_json || '{}')
check('判断挂也写两行、标 incomplete', ok2 === true && t2rows.length === 2 && j2.judge === 'incomplete', JSON.stringify(t2rows))
check('报警记下缺哪几个（missing 非空）', Array.isArray(j2.missing) && j2.missing.length > 0, j2.missing)
check('缺参数时不补 by（永远不假装判出来了）', j2.by === undefined, j2.by)
const incFlag = JSON.parse(getFlag(db, 'affect.v4.judge.incomplete') || '{}')
check('报警落进 affect.v4.judge.incomplete', Array.isArray(incFlag.missing) && incFlag.missing.length > 0, incFlag)

db.close()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
console.log(`\n${passed} 项全过`)
