/**
 * 三观 G7：折算归一与地板、张力压输家、单维塌缩不可切换、嵌入缺失则没有折算、
 * 同一输入两次相同、并排 7 天且单日移动超过 0.02 不能切。
 * 运行：node test/sangguan-g7.test.mjs
 */
import { DIMS, FLOOR } from '../src/modules/values.js'
import { foldDims, assignDims, shadowPush, shadowVerdict } from '../src/modules/sangguan/tags.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const scored = [
  { dim: 'benevolence', score: 0.9 },
  { dim: 'benevolence', score: 0.2 },
  { dim: 'power', score: 0.8 },
]
const a = foldDims(scored)
const b = foldDims(scored)
check('同一批算两次相同', JSON.stringify(a) === JSON.stringify(b))
const sum = Object.values(a.weights).reduce((x, y) => x + y, 0)
check('十维都在地板之上', DIMS.every(([k]) => a.weights[k] >= FLOOR - 1e-9), a.weights)
check('总和接近 1', Math.abs(sum - 1) < 0.02, sum)
check('同一维取最高：仁善没有把 0.9 和 0.2 加在一起', a.weights.benevolence > a.weights.power)
check('两侧都高时输家被压', a.weights.power < a.weights.benevolence && a.weights.power < 0.2, a.weights)

const collapsed = foldDims([{ dim: 'security', score: 50 }])
check('单维塌缩不可切换', collapsed.switchable === false && collapsed.max >= 0.8, collapsed)

const mild = []
for (let i = 0; i < 7; i++) {
  const w = {}
  for (const [k] of DIMS) w[k] = 0.1
  mild.push({ day: '2026-11-0' + (i + 1), weights: w })
}
let log = []
for (const row of mild) log = shadowPush(log, row.day, row.weights)
check('并排满 7 天且没乱跳可以切', shadowVerdict(log).ok === true, shadowVerdict(log))
log = shadowPush(log, '2026-11-08', { ...mild[0].weights, security: 0.2 })
check('单日移动超过 0.02 不能切', shadowVerdict(log).reason === 'move', shadowVerdict(log))

check('嵌入缺失则不折算', assignDims([{ id: 'c', text: '我更看重照顾身边的人', pi: 0.4, n: 1 }], () => null) === null)
const assigned = assignDims([{ id: 'c', text: '照顾身边的人', pi: 0.5, n: 2 }])
check('含义句能归到仁善', assigned && assigned[0].dim === 'benevolence' && assigned[0].score === 1.5, assigned)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { claimUserValue } from '../src/modules/sangguan/values_intake.js'
import { append, newId } from '../src/modules/sangguan/ledger.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { readViews } from '../src/modules/sangguan/bridge.js'
import { injectView } from '../src/modules/sangguan/inject.js'
import { gather, prompt as thoughtPrompt } from '../src/modules/thoughts.js'
import { factsText } from '../src/modules/selfview.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg7-'))
const db = openDb(path.join(dir, 'app.db'))
const T = '2026-11-01T12:00:00.000Z'
const add = (id) => db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, id, 'daily', 'active', T)

add('agt_fold')
// 一条命题就能把仁善抬起来：不依赖任何旧表，也不照抄旧数字
claimUserValue(db, 'agt_fold', { key: 'benevolence', weight: 0.9 }, T)
setSangguanConfig(db, 'agt_fold', { enabled: true, replace: { V: 'engine' } })
{
  const v = readViews(db, 'agt_fold')
  check('有命题就折算，不照抄旧数字', v.source.V === 'engine' && v.V.weights.benevolence > 0.3 && v.V.weights.benevolence !== 0.42, v.V.weights)
}
const exp = append(db, 'agt_fold', [{
  type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: T,
  payload: { claims: [{ layer: 'V', kind: 'norm', text: '照顾身边的人', origin: 'extract' }] },
}])
const cid = exp.entities.claims[0]
append(db, 'agt_fold', [{
  type: 'EVIDENCE', actor: 'user', at: '2026-11-02T12:00:00.000Z',
  payload: { evidence: [{ kind: 'verdict', target_type: 'claim', target_id: cid, sign: 1, weight: 1, ref: 't' }] },
}])
{
  const v = readViews(db, 'agt_fold', { at: '2026-11-02T12:00:00.000Z' })
  const top = Object.entries(v.V.weights).sort((a, b) => b[1] - a[1])[0][0]
  check('引擎折算后仁善最高，来源是 engine', v.source.V === 'engine' && top === 'benevolence', { top, w: v.V.weights.benevolence })
  check('引擎权重不再等于旧表的 0.42', v.V.weights.benevolence !== 0.42, v.V.weights.benevolence)
}
setSangguanConfig(db, 'agt_fold', { replace: { V: 'meter' } })
const kept = readViews(db, 'agt_fold').V.weights.benevolence
check('关掉替换开关后价值观仍是折算', readViews(db, 'agt_fold').source.V === 'engine' && readViews(db, 'agt_fold').V.weights.benevolence === kept && kept !== 0.42)

const exp2 = append(db, 'agt_fold', [{
  type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: '2026-11-02T13:00:00.000Z',
  payload: { claims: [{ layer: 'V', kind: 'norm', text: '说了算、有地位', origin: 'extract' }] },
}])
const cid2 = exp2.entities.claims[0]
const qAt = '2026-11-02T14:00:00.000Z'
const qid = newId('questions', qAt)
append(db, 'agt_fold', [{
  type: 'KAPPA_OPEN', layer: 'V', actor: 'judge', at: qAt,
  payload: {
    questions: [{ id: qid, layer: 'V', text: '照顾人与说了算冲突时怎么办' }],
    kappas: [{ layer: 'V', q_id: qid, pos_id: cid, neg_id: cid2, dep: '去掉一方另一方失去参照', excl: '同一边界下不能同真' }],
  },
}])
setSangguanConfig(db, 'agt_fold', { replace: { V: 'engine' } })
{
  const g = gather(db, 'agt_fold')
  check('思绪素材带上未决矛盾', thoughtPrompt(g).text.includes('还没想完的') && g.unresolved.length === 1, g.unresolved)
  const v = readViews(db, 'agt_fold')
  const facts = factsText({
    name: 'a', days: 1, mode: 'daily', owner: null, lastSeenDays: null, affect: null,
    tone: { label: '平', desc: '口语' }, axes: [], values: v.V.items, worldview: [], lifeStance: null,
    style: {}, memTotal: 0, mems: [], taboos: [], drive: null, engineTensions: v.V.tensions,
  })
  check('自述张力改用未决矛盾', facts.includes('【张力】') && facts.includes('照顾身边的人'), { source: v.source, tensions: v.V.tensions, line: v.V.line })
}

add('agt_say')
setSangguanConfig(db, 'agt_say', { enabled: true, inject: 'live' })
const seeded = append(db, 'agt_say', [{
  type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: T,
  payload: { claims: [{ layer: 'W', kind: 'belt', text: '我倾向认为世界大体安全', origin: 'seed' }] },
}]).entities.claims[0]
db.prepare('INSERT INTO persona_views(id,agent_id,text,source,created_at) VALUES(?,?,?,?,?)').run('pv1', 'agt_say', '旧自述', 'rules', T)
append(db, 'agt_say', [{ type: 'CLAIM_WITHDRAW', layer: 'W', actor: 'user', at: '2026-11-03T00:00:00.000Z', payload: { claim_id: seeded } }])
{
  const tiny = injectView(db, 'agt_say', { budget: 1, now: '2026-11-03T01:00:00.000Z', cache: false })
  const left = db.prepare('SELECT COUNT(*) n FROM persona_views WHERE agent_id=?').get('agt_say').n
  check('装不下就不算说过，自述缓存已经清掉', !tiny.text.includes('我改了一个看法') && left === 0, tiny.text)
  const full = injectView(db, 'agt_say', { now: '2026-11-03T01:00:00.000Z', cache: false })
  check('撤回之后注入说一轮改了看法', full.text.includes('我改了一个看法'), full.text)
  const again = injectView(db, 'agt_say', { now: '2026-11-03T02:00:00.000Z', cache: false })
  check('改看法只说一轮', !again.text.includes('我改了一个看法'), again.text)
  check('撤回后命题是 withdrawn', loadState(db, 'agt_say').claims[seeded].status === 'withdrawn')
}

console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
