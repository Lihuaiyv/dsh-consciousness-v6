/**
 * v4 影子精修：规则帧写完后，本地模型再产一版（异步、可注入、失败静默）。
 * 运行：node test/affect-v4-refine.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { writeParam } from '../src/kernel.js'
import { recordShadow, refineShadow, finalShadowRows, JUDGE_SYS } from '../src/modules/affect_v4_shadow.js'
import { localBegin, localEnd, localBusy } from '../src/modules/local_llm.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-refine-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'a1'
db.prepare('INSERT INTO agents(id,name,created_at) VALUES(?,?,?)').run(aid, '小汐', new Date().toISOString())
writeParam(db, aid, 'affect.engine.shadow', 'on')
writeParam(db, aid, 'affect.engine.shadow.judge', 'local')

const count = () => Number(db.prepare('SELECT COUNT(*) n FROM affect_v4_shadow WHERE agent_id=?').get(aid).n)
const latest = () => db.prepare('SELECT * FROM affect_v4_shadow WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)
const T0 = Date.parse('2026-11-16T20:00:00+08:00')

recordShadow(db, aid, { text: '就这？', turnId: 't1', conversationId: 'c1', now: T0 })
const n0 = count()
check('规则帧先写一行', n0 === 1, n0)

/* 默认 off：不调模型、不写 */
let called = 0
const localSpy = async () => { called++; return { text: '{"act":"criticize","target":"me","goal_cong":-0.6}' } }
const off = await refineShadow(db, aid, { text: '就这？', turnId: 't1', now: T0 + 1000, local: localSpy })
check('精修默认 off → 不调、不写', off === false && called === 0 && count() === n0, { off, called, rows: count() })

/* 打开：写第二行 source=model / rev=2 */
writeParam(db, aid, 'affect.engine.shadow.model', 'on')

/* 本地有别的活在跑：精修不再让路（聊天优先；切事块间自己让路）。
   2026-11-17 改：原来「本地忙就跳过」会让精修在切事期间永远排不上。 */


let calls = 0
const local2 = async (req) => {
  calls++
  const sys = String(req.system || '')
  if (sys.includes('事层')) return { text: '{"summary":"在嘲讽我","what":"嘲讽","target":"me"}' }
  return { text: '{"goal_cong":-0.6,"expectation":0.7,"future":-0.3,"why":"说「就这？」是在贬低","from":"这一轮原话"}' }
}
const ok = await refineShadow(db, aid, { text: '就这？', turnId: 't1', now: T0 + 2000, local: local2 })
check('精修成功 → 写第二行', ok === true && count() === n0 + 1, { ok, rows: count() })
check('一次调用（只有判断层；塞句是代码）', calls === 1, calls)
const row = latest()
check('source=model', row.source === 'model', row.source)
const jModel = JSON.parse(row.judgment_json || '{}')
check('判断：带 why/from', typeof jModel.why === 'string' && jModel.why.length > 0 && typeof jModel.from === 'string', jModel)
check('rev=2', Number(row.rev) === 2, row.rev)
const f = JSON.parse(row.frame_json)
check('塞句：target 按规则（不再由模型给）', f.target === 'none', f.target)
check('act 保持规则版（模型只给冲击数，不改 act）', f.act === 'ask', f.act)
check('判断生效：S 掉到 0.5 以下', Number(row.s) < 0.5, row.s)
const ruleRow = db.prepare("SELECT * FROM affect_v4_shadow WHERE agent_id=? AND source='rules' ORDER BY rowid LIMIT 1").get(aid)
check('帧 id 沿用规则帧（同一件事）', f.id === JSON.parse(ruleRow.frame_json).id, { now: f.id, rule: JSON.parse(ruleRow.frame_json).id })

/* 已精修过：不重复 */
const dup = await refineShadow(db, aid, { text: '就这？', turnId: 't1', now: T0 + 3000, local: localSpy })
check('同一轮已有 model 行 → 不重复', dup === false, dup)

/* 一轮一条最终结论：规则行 + model 行都在，口径取 model */
const finalsT1 = finalShadowRows(db, aid).filter((r) => r.turn_id === 't1')
check('最终结论：同一轮只返回一条', finalsT1.length === 1, finalsT1.map((r) => r.source))
check('最终结论：取 model 行', finalsT1[0] && finalsT1[0].source === 'model', finalsT1[0] && finalsT1[0].source)
check('最终结论：规则行仍留着（只追加，审计用）',
  Number(db.prepare("SELECT COUNT(*) n FROM affect_v4_shadow WHERE agent_id=? AND turn_id='t1'").get(aid).n) === 2)

/* 判断层提示词：2026-11-17 按初版+精华重写——场景清单 / 反例 / 平常条款都删了 */
check('提示词：不再带「平常就写 0/0.1/0」', !JUDGE_SYS.includes('平常，没动到存在'))
check('提示词：不再带三条反例', !(JUDGE_SYS.includes('确认连通性') || JUDGE_SYS.includes('要求说通俗点')))

/* 越界值会被 clamp（模型给判断，代码收口成 S/N/D） */
recordShadow(db, aid, { text: '你今天真厉害', turnId: 't2', conversationId: 'c1', now: T0 + 60000 })
const localOut = async (req) => String(req.system || '').includes('事层')
  ? { text: '{"summary":"被夸","what":"夸","target":"me"}' }
  : { text: '{"goal_cong":5,"expectation":-3,"future":0}' }
const clamped = await refineShadow(db, aid, { text: '你今天真厉害', turnId: 't2', now: T0 + 61000, local: localOut })
const rowC = latest()
check('模型给的越界值被 clamp（cong≤1 → S=1 / exp≥0 → N=0.15）', clamped === true && Number(rowC.s) === 1 && Number(rowC.n) === 0.15, { s: rowC.s, n: rowC.n })

/* 模型挂 / 坏 JSON：不抛、不写 */
recordShadow(db, aid, { text: '算了，不想说了', turnId: 't3', conversationId: 'c1', now: T0 + 120000 })
const before = count()
const threw = await refineShadow(db, aid, { text: '算了，不想说了', turnId: 't3', now: T0 + 121000, local: async () => { throw new Error('local down') } })
check('模型挂 → false，不写', threw === false && count() === before, { threw, rows: count() })
const badJson = await refineShadow(db, aid, { text: '算了，不想说了', turnId: 't3', now: T0 + 122000, local: async () => ({ text: '不是 JSON' }) })
check('坏 JSON → false，不写', badJson === false && count() === before, { badJson, rows: count() })

console.log(`\n${pass} pass, ${fail} fail`)
if (fail) process.exitCode = 1
