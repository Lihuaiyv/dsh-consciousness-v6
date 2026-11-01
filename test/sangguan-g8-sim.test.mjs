/**
 * 三观 G8：200 天并排折算、切换条件、退回旧表、清理后关闭读冻结快照。
 * 运行：node test/sangguan-g8-sim.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append } from '../src/modules/sangguan/ledger.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { readViews, replaceReady, freezeViews, markCleaned } from '../src/modules/sangguan/bridge.js'
import { seedFromMeters, withdrawSeed } from '../src/modules/sangguan/seed.js'
import { promptHook } from '../src/modules/sangguan/inject.js'
import { getFlag } from '../src/kernel.js'
import { DIMS } from '../src/modules/values.js'
import { runNightly } from '../src/modules/nightly.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg8-'))
const db = openDb(path.join(dir, 'app.db'))
const T0 = '2026-01-01T12:00:00.000Z'
const add = (id) => db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, id, 'daily', 'active', T0)
const dayAt = (i) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 86400000).toISOString()

add('agt_empty')
setSangguanConfig(db, 'agt_empty', { enabled: true })
{
  const r = seedFromMeters(db, 'agt_empty', T0)
  check('空仪表一条种子都没有', r.seeded.length === 0 && Object.keys(loadState(db, 'agt_empty').claims).length === 0, r)
}

add('agt_live')
setSangguanConfig(db, 'agt_live', { enabled: true, inject: 'live' })
for (const [k] of DIMS) db.prepare('INSERT INTO persona_values VALUES(?,?,?,?,?)').run('agt_live', k, k === 'benevolence' ? 0.42 : 0.064, '[]', T0)
db.prepare('INSERT INTO persona_worldview VALUES(?,?,?,?,?)').run('agt_live', 'safe', 0.2, '[]', T0)
for (const k of ['coherence', 'purpose', 'mattering', 'search', 'growth', 'communion', 'horizon']) {
  db.prepare('INSERT INTO persona_lifeview VALUES(?,?,?,?,?)').run('agt_live', k, k === 'purpose' ? 0.7 : 0.5, '[]', T0)
}
const seeded = seedFromMeters(db, 'agt_live', T0)
check('偏离的仪表种出三层', seeded.seeded.length === 3, seeded)
const vClaim = Object.values(loadState(db, 'agt_live').claims).find((c) => c.layer === 'V')
append(db, 'agt_live', [{ type: 'DUP', layer: 'V', actor: 'sys', at: T0, payload: { claim_id: vClaim.id } }])
check('种子能被同义对话 DUP', loadState(db, 'agt_live').claims[vClaim.id].mentions === 1)

const belt = append(db, 'agt_live', [{
  type: 'CLAIM_EXP', layer: 'L', actor: 'sys', at: T0,
  payload: { claims: [{ layer: 'L', kind: 'chapter', text: '把认定的方向做成', origin: 'extract' }] },
}]).entities.claims[0]
const hollow = Object.values(loadState(db, 'agt_live').claims).find((c) => c.layer === 'L' && c.kind === 'telos')
append(db, 'agt_live', [{
  type: 'CORE_ESTABLISH', layer: 'L', actor: 'judge', at: '2026-01-02T00:00:00.000Z',
  payload: { from_id: belt, claims: [{ layer: 'L', kind: 'telos', text: '把认定的方向一点点做成', origin: 'extract', pred: [belt] }] },
}])
check('空种子核心被新核心标成 superseded', loadState(db, 'agt_live').claims[hollow.id].status === 'superseded')

append(db, 'agt_live', [{
  type: 'EVIDENCE', actor: 'user', at: '2026-01-02T01:00:00.000Z',
  payload: { evidence: [{ kind: 'verdict', target_type: 'claim', target_id: vClaim.id, sign: 1, weight: 1, ref: 't' }] },
}])
check('证据还没并排满 7 天不能切', replaceReady(db, 'agt_live', 'V', dayAt(2)).ok === false)

let prev = null
let jump = 0
for (let i = 0; i < 200; i++) {
  readViews(db, 'agt_live', { at: dayAt(i) })
  const log = JSON.parse(getFlag(db, 'sangguan.shadow:agt_live') || '[]')
  const w = log.length ? log[log.length - 1].weights : null
  if (prev && w) {
    for (const [k] of DIMS) jump = Math.max(jump, Math.abs((w[k] || 0) - (prev[k] || 0)))
  }
  prev = w
}
const ready = replaceReady(db, 'agt_live', 'V', dayAt(199))
check('并排 200 天单日移动不超过 0.02', jump <= 0.02 + 1e-9, jump)
check('价值观可以切', ready.ok === true, ready)
setSangguanConfig(db, 'agt_live', { replace: { V: 'engine' } })
const after = readViews(db, 'agt_live', { at: dayAt(199) })
const sum = Object.values(after.V.weights).reduce((a, b) => a + b, 0)
let moved = 0
for (const [k] of DIMS) moved = Math.max(moved, Math.abs((after.V.weights[k] || 0) - (prev[k] || 0)))
check('切到引擎后十维总和接近 1', after.source.V === 'engine' && Math.abs(sum - 1) < 0.02, { sum, source: after.source.V })
check('切换当天驱力移动不超过 0.02', moved <= 0.02 + 1e-9, moved)

setSangguanConfig(db, 'agt_live', { replace: { V: 'meter' } })
const back = readViews(db, 'agt_live')
check('退回旧表后与仪表一致', back.source.V === 'meter' && back.V.weights.benevolence === 0.42, back.V.weights.benevolence)

const wClaim = Object.values(loadState(db, 'agt_live').claims).find((c) => c.layer === 'W' && c.origin === 'seed')
const legacy = { worldLine: '你对世界的基本看法：旧仪表一句。', lifeLine: '你的人生观底色：旧志向。', valLine: '你看重：仁善。' }
withdrawSeed(db, 'agt_live', wClaim.id, '2026-01-03T00:00:00.000Z')
const hooked = promptHook(db, 'agt_live', legacy, { now: '2026-01-03T01:00:00.000Z' })
check('撤回世界观种子后注入回到旧行', hooked.worldLine === legacy.worldLine, hooked.worldLine)

setSangguanConfig(db, 'agt_live', { replace: { V: 'engine' } })
const snap = freezeViews(db, 'agt_live', dayAt(199))
setSangguanConfig(db, 'agt_live', { enabled: false })
markCleaned(db)
db.prepare('UPDATE persona_values SET weight=? WHERE agent_id=? AND key=?').run(0.99, 'agt_live', 'power')
const frozen = readViews(db, 'agt_live')
check('清理后关闭读冻结快照，不跟旧表走', frozen.source.V === 'frozen' && frozen.V.weights.power === snap.V.weights.power && frozen.V.weights.power !== 0.99, frozen.V.weights.power)

const night = await runNightly(db, 'agt_live', { day: '2026-01-03' })
const valuesStep = (night.steps || []).find((s) => s.step === 'values')
check('清理后夜巡不再重算价值观', !!(valuesStep && valuesStep.skipped && valuesStep.reason === 'cleaned'), valuesStep)

console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
