/**
 * 让「该跟还是该稳」由它自己判断，而不是写死的阈值。
 * 运行：node test/empathy-choice.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { empathyPartsOf } from '../src/algo/emotion.js'
import { finalizeAppraisal } from '../src/model.js'
import { seedAffect, appraise, selfStateLine } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// ---------- 一、它自己选的接法优先于阈值 ----------
const mild = { eUser: -0.2, ePrev: 0, closeness: 0.9, selfNow: 0 }
check('默认 auto：轻度不悦走同向', empathyPartsOf({ ...mild, mode: 'v2' }).mode === 'share')
check('它说 hold 就 hold（哪怕阈值没到）', empathyPartsOf({ ...mild, mode: 'v2', want: 'hold' }).mode === 'hold',
  { v: empathyPartsOf({ ...mild, mode: 'v2', want: 'hold' }) })
check('它说 dampen 就 dampen（哪怕两边都没多高）', empathyPartsOf({ ...mild, mode: 'v2', want: 'dampen' }).mode === 'dampen')

const deep = { eUser: -0.8, ePrev: 0, closeness: 0.9, selfNow: 0 }
check('默认 auto：你沉我站得住会 hold', empathyPartsOf({ ...deep, mode: 'v2' }).mode === 'hold')
check('它说 follow 就跟着（哪怕阈值到了）', empathyPartsOf({ ...deep, mode: 'v2', want: 'follow' }).mode === 'share',
  { v: empathyPartsOf({ ...deep, mode: 'v2', want: 'follow' }) })
check('它说 follow 时被带得比 auto 多',
  Math.abs(empathyPartsOf({ ...deep, mode: 'v2', want: 'follow' }).share)
  > Math.abs(empathyPartsOf({ ...deep, mode: 'v2' }).share))

check('v1 里它说什么都不影响', empathyPartsOf({ ...deep, mode: 'v1', want: 'hold' }).mode === 'share')

// ---------- 二、模型输出要清洗 ----------
const base = { kind: 'eval', polarity: -0.5 }
check('receive 照抄 hold', finalizeAppraisal({ ...base, receive: 'hold' }).receive === 'hold')
check('receive 照抄 follow', finalizeAppraisal({ ...base, receive: 'follow' }).receive === 'follow')
check('receive 照抄 dampen', finalizeAppraisal({ ...base, receive: 'dampen' }).receive === 'dampen')
check('大写也认', finalizeAppraisal({ ...base, receive: 'HOLD' }).receive === 'hold')
check('乱七八糟的值退回 auto', finalizeAppraisal({ ...base, receive: '乱写' }).receive === 'auto')
check('没给也退回 auto', finalizeAppraisal({ ...base }).receive === 'auto')
check('空串退回 auto', finalizeAppraisal({ ...base, receive: '' }).receive === 'auto')

// ---------- 三、全链路 ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-choice-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_choice'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '接法', 'daily', 'active', now())
seedAffect(db, aid)
setParam(db, aid, 'affect.empathy.mode', { value: 'v2' })

const st = selfStateLine(db, aid)
check('自身状态递得过去', st.includes('慢情绪') && st.includes('快情绪'), { st })

const LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
const hint = (receive) => ({
  label: 'irritated', kind: 'eval', polarity: -0.5,
  goal_relevance: 0.6, goal_congruence: -0.4,
  certainty: 0.8, novelty: 0.3, source: 'model',
  user_label: 'frustrated',
  user_scores: { joy: 0.01, peaceful: 0.02, curious: 0.02, calm: 0.05, confused: 0.1, lost: 0.2, irritated: 0.25, frustrated: 0.35 },
  why: '在纠错', target: 'me', receive,
})
const last = () => db.prepare('SELECT * FROM affect_events WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)

await appraise(db, aid, '这个地方还是不对', { labels: LABELS, hint: hint('hold') })
const r1 = last()
console.log('want=hold →', JSON.stringify({ want: r1.empathy_want, used: r1.empathy_mode, share: r1.empathy_share }))
check('want 落库了', r1.empathy_want === 'hold', { v: r1.empathy_want })
check('实际用的是 hold', r1.empathy_mode === 'hold', { v: r1.empathy_mode })

await appraise(db, aid, '这个地方还是不对（第二次）', { labels: LABELS, hint: hint('follow') })
const r2 = last()
console.log('want=follow →', JSON.stringify({ want: r2.empathy_want, used: r2.empathy_mode, share: r2.empathy_share }))
check('想要 follow 就是 follow', r2.empathy_want === 'follow' && r2.empathy_mode === 'share',
  { want: r2.empathy_want, used: r2.empathy_mode })
check('follow 时被带得比 hold 多', Math.abs(Number(r2.empathy_share)) > Math.abs(Number(r1.empathy_share)),
  { hold: r1.empathy_share, follow: r2.empathy_share })

await appraise(db, aid, '随便吧', { labels: LABELS, hint: hint(undefined) })
const r3 = last()
check('模型没给接法就 auto', r3.empathy_want === 'auto', { v: r3.empathy_want })
check('auto 也照常记下实际用了哪种', ['share', 'hold', 'dampen'].includes(r3.empathy_mode), { v: r3.empathy_mode })

try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
