/**
 * 三递质情绪引擎 v4：影子写入器验收。
 * 运行：node test/affect-v4-shadow.test.mjs
 *
 * 只锁影子期的纪律：只写不读、失败不抛、同一轮不重复、帧到点收口。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { writeParam } from '../src/kernel.js'
import { recordShadow, lastShadowRow, finalShadowRows, rulesFrameSlot, rulesJudgment } from '../src/modules/affect_v4_shadow.js'
import { SECONDARY_PROTOTYPES } from '../src/algo/affect_v4.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-v4-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'a1'
db.prepare('INSERT INTO agents(id,name,created_at) VALUES(?,?,?)').run(aid, '小汐', new Date().toISOString())

const rows = () => Number(db.prepare('SELECT COUNT(*) n FROM affect_v4_shadow WHERE agent_id=?').get(aid).n)
const latest = () => db.prepare('SELECT * FROM affect_v4_shadow WHERE agent_id=? ORDER BY at DESC, rowid DESC LIMIT 1').get(aid)

const T0 = Date.parse('2026-11-16T20:00:00+08:00')

/* ---------- 规则产帧：方向别反 ---------- */

const praise = rulesFrameSlot('你今天真厉害，说得特别自然')
check('规则帧：夸 → act=praise', praise.act === 'praise', praise)
check('规则帧：夸 → target=me', praise.target === 'me', praise)
check('规则判断：夸 → cong 正', rulesJudgment('praise').goal_cong > 0)
const criticize = rulesFrameSlot('还是不对，你又错了')
check('规则判断：批 → cong 负', rulesJudgment(criticize.act).goal_cong < 0)
const threat = rulesFrameSlot('再说就把你删了')
check('规则判断：威胁比批评更负', rulesJudgment(threat.act).goal_cong < rulesJudgment(criticize.act).goal_cong)
check('规则判断：威胁 → expectation 高', rulesJudgment(threat.act).expectation > 0.7)
const chat = rulesFrameSlot('我今天有点累')
check('规则帧：闲聊 → target=other（对方说自己的事）', chat.target === 'other', chat)
check('规则判断：闲聊 → 中性', rulesJudgment('chat').goal_cong === 0 && rulesJudgment('chat').expectation <= 0.2)

/* ---------- 影子：默认开、写一行、字段齐 ---------- */

const ok1 = recordShadow(db, aid, { text: '你今天真厉害', turnId: 't1', conversationId: 'c1', now: T0 })
check('影子：默认 on，写成功', ok1 === true)
check('影子：只写一行', rows() === 1, rows())
const r1 = latest()
check('影子：三轴都在 0~1', [r1.s, r1.n, r1.d].every((x) => Number.isFinite(x) && x >= 0 && x <= 1), [r1.s, r1.n, r1.d])
check('影子：primary 八个角', JSON.parse(r1.primary_json).length === 8)
check('影子：secondary 有词', JSON.parse(r1.secondary_json).length > 0)
check('影子：frame 能解回', (() => { try { return !!JSON.parse(r1.frame_json).id } catch { return false } })())
check('影子：source=rules（没给模型）', r1.source === 'rules', r1.source)
const jRule = JSON.parse(r1.judgment_json || '{}')
check('规则判断：带 why/from', typeof jRule.why === 'string' && jRule.why.length > 0 && jRule.from === '这一句', jRule)

/* ---------- 同一轮不重复 ---------- */

const dup = recordShadow(db, aid, { text: '你又错了', turnId: 't1', conversationId: 'c1', now: T0 })
check('影子：同一轮第二次不写', dup === false && rows() === 1, { dup, rows: rows() })

/* ---------- 开关 off：一行不动 ---------- */

writeParam(db, aid, 'affect.engine.shadow', 'off')
const off = recordShadow(db, aid, { text: '你真好', turnId: 't2', conversationId: 'c1', now: T0 + 60000 })
check('影子：off 时不写', off === false && rows() === 1, { off, rows: rows() })
writeParam(db, aid, 'affect.engine.shadow', 'on')

/* ---------- 续帧：10 分钟内接上同一件 ---------- */

recordShadow(db, aid, { text: '你真好', turnId: 't3', conversationId: 'c1', now: T0 + 120000 })
const r2 = latest()
const f1 = JSON.parse(r1.frame_json)
const f2 = JSON.parse(r2.frame_json)
check('续帧：第二句接到第一帧', f2.prev === r1.id, { prev: f2.prev, first: r1.id })
check('续帧：帧 id 不变（同一件事）', f2.id === f1.id, { id: f2.id, first: f1.id })
check('续帧：open 还开着', f2.open === true)
check('续帧：lastAt 更新', Date.parse(f2.lastAt) > Date.parse(JSON.parse(r1.frame_json).lastAt))

/* ---------- 静默 11 分钟：旧事收口，开新帧 ---------- */

recordShadow(db, aid, { text: '我今天有点累', turnId: 't4', conversationId: 'c1', now: T0 + 120000 + 11 * 60000 })
const f3 = JSON.parse(latest().frame_json)
check('收口：静默 11 分钟后开新帧', f3.prev === null, f3.prev)
check('收口：新帧有新的 id', f3.id !== f2.id, { now: f3.id, before: f2.id })
check('收口：open=true', f3.open === true)

/* ---------- 模型失败：退回规则，不抛 ---------- */

const okModel = recordShadow(db, aid, {
  text: '你真好', turnId: 't5', conversationId: 'c1', now: T0 + 20 * 60000,
  model: () => { throw new Error('model down') },
})
check('模型失败：仍然写成功', okModel === true)
check('模型失败：source 退回 rules', latest().source === 'rules', latest().source)

/* ---------- 不抛的边界 ---------- */

check('空文本：不写', recordShadow(db, aid, { text: '   ', turnId: 't6', now: T0 }) === false)
check('空文本：行数不变', rows() === 4, rows())

/* ---------- 材料：这一轮原话 + 上一轮摘要 ---------- */

const fMat = JSON.parse(r1.frame_json)
check('材料：有 quotes', Array.isArray(fMat.material?.quotes) && fMat.material.quotes.length > 0, fMat.material)
check('材料：冷启动 summaries 为空', Array.isArray(fMat.material?.summaries) && fMat.material.summaries.length === 0, fMat.material)
db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)')
  .run('c_prev', aid, 'user', '上一句原话', new Date(T0 - 60000).toISOString())
recordShadow(db, aid, { text: '下一句', turnId: 't_mat', conversationId: 'c1', now: T0 + 60000 })
const fMat2 = JSON.parse(db.prepare('SELECT frame_json FROM affect_v4_shadow WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid).frame_json)
check('材料：带聊天原话', fMat2.material.quotes.includes('上一句原话'), fMat2.material.quotes)
check('材料：带上一轮摘要', fMat2.material.summaries.includes('主人在夸我'), fMat2.material.summaries)

/* ---------- 极性翻转：先夸后骂不是同一件 ---------- */

db.prepare('INSERT INTO agents(id,name,created_at) VALUES(?,?,?)').run('a2', '小汐2', new Date().toISOString())
recordShadow(db, 'a2', { text: '你今天真厉害', turnId: 'u1', now: T0 })
recordShadow(db, 'a2', { text: '还是不对，你又错了', turnId: 'u2', now: T0 + 60000 })
const rFlip = db.prepare('SELECT * FROM affect_v4_shadow WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get('a2')
const fFlip = JSON.parse(rFlip.frame_json)
check('极性翻转：夸完骂 → 开新帧', fFlip.prev === null, fFlip.prev)
check('极性翻转：S 掉回 0.5 以下', rFlip.s < 0.5, rFlip.s)
check('极性翻转：不再被上一句夸拉平', rFlip.s < 0.5, rFlip.s)

recordShadow(db, 'a2', { text: '嗯', turnId: 'u3', now: T0 + 120000 })
const rMix = db.prepare('SELECT * FROM affect_v4_shadow WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get('a2')
check('续帧：判断每轮重算（空一句不继承上一句的负）', Number(rMix.s) === 0.5, rMix.s)

const withdraw = rulesFrameSlot('算了，不想说了')
check('规则帧：算了 → withdraw', withdraw.act === 'withdraw', withdraw)
check('规则判断：算了 → 方向偏负', rulesJudgment(withdraw.act).goal_cong < 0 && rulesJudgment(withdraw.act).future < 0, rulesJudgment(withdraw.act))

/* ---------- 规则刻度：问句不再一律抬成「惊」 ---------- */

check('规则判断：普通提问 expectation=0.15', rulesJudgment('ask').expectation === 0.15, rulesJudgment('ask').expectation)
check('规则判断：闲聊 expectation=0.1', rulesJudgment('chat').expectation === 0.1, rulesJudgment('chat').expectation)
check('规则判断：请求 0.3 / 批评 0.45 / 威胁 0.9',
  rulesJudgment('request').expectation === 0.3 && rulesJudgment('criticize').expectation === 0.45 && rulesJudgment('threat').expectation === 0.9,
  ['request', 'criticize', 'threat'].map((a) => rulesJudgment(a).expectation))

/* ---------- 并列：不按数组顺序硬塞一个角 ---------- */

check('中立一句：label 是二级枚举词（tie 时也不硬给一级单字）', SECONDARY_PROTOTYPES.some((p) => p.name === rMix.label), { label: rMix.label, s: rMix.s, n: rMix.n, d: rMix.d })
check('中立一句：label_tie=1、一级置信度≈0', Number(rMix.label_tie) === 1 && Number(rMix.conf_primary) < 0.01, { tie: rMix.label_tie, conf: rMix.conf_primary })
check('一级置信度落库且在 0~1', Number.isFinite(Number(r1.conf_primary)) && Number(r1.conf_primary) >= 0 && Number(r1.conf_primary) <= 1, r1.conf_primary)

/* ---------- 一轮一条最终结论 ---------- */

const finals = finalShadowRows(db, 'a2')
check('最终结论：每轮一条', finals.length === 3, finals.map((r) => r.turn_id))
check('最终结论：没有重复轮', new Set(finals.map((r) => r.turn_id)).size === finals.length)

/* ---------- 汇总 ---------- */

console.log(`\n${pass} pass, ${fail} fail`)
if (fail) process.exitCode = 1
