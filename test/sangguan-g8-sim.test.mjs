/**
 * 三观 G8：200 天并排折算、切换条件、退回旧表、清理后关闭读冻结快照。
 * 运行：node test/sangguan-g8-sim.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, newId } from '../src/modules/sangguan/ledger.js'
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
// 旧库模拟：v6 之前有 persona_values 表；生产代码不再建它，测试自己造一份来验迁移/兼容
db.exec(`CREATE TABLE IF NOT EXISTS persona_values(agent_id TEXT NOT NULL, key TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.1, evidence TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(agent_id,key))`)
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

// 测试里的「旧库 → 命题」小工具：生产迁移器已删，但测试仍要模拟旧库能迁出意思
const HINT_V = Object.fromEntries(DIMS.map(([k, , h]) => [k, h]))
function seedFromLegacy(db2, aid, at) {
  const rows = db2.prepare('SELECT key,weight FROM persona_values WHERE agent_id=? ORDER BY weight DESC').all(aid)
  const up = rows.filter((r) => Number(r.weight) >= 0.104).slice(0, 2)
  if (!up.length) return
  const evs = []
  up.forEach((r, i) => {
    const tt = new Date(Date.parse(at) + i * 1000).toISOString()
    const id = newId('claims', tt)
    evs.push({ type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: tt, payload: { claims: [{ id, layer: 'V', kind: 'norm', text: '我更看重' + (HINT_V[r.key] || r.key), origin: 'seed' }] } })
    evs.push({ type: 'EVIDENCE', actor: 'sys', at: new Date(Date.parse(tt) + 10).toISOString(), payload: { evidence: [{ kind: 'verdict', target_type: 'claim', target_id: id, sign: 1, weight: 1, ref: 'legacy:' + r.key }] } })
  })
  append(db2, aid, evs)
}

db.prepare('INSERT INTO persona_worldview VALUES(?,?,?,?,?)').run('agt_live', 'safe', 0.2, '[]', T0)
for (const k of ['coherence', 'purpose', 'mattering', 'search', 'growth', 'communion', 'horizon']) {
  db.prepare('INSERT INTO persona_lifeview VALUES(?,?,?,?,?)').run('agt_live', k, k === 'purpose' ? 0.7 : 0.5, '[]', T0)
}
seedFromLegacy(db, 'agt_live', T0)
const vSeeded = Object.values(loadState(db, 'agt_live').claims).filter((c) => c.layer === 'V')
check('旧库的意思迁成价值命题', vSeeded.length >= 1, vSeeded.map((c) => c.kind))
const seeded = seedFromMeters(db, 'agt_live', T0)
check('世界观和人生观从仪表种', seeded.seeded.slice().sort().join('') === 'LW', seeded)
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
check('价值观不再等核心才算数', ready.ok === false && ready.reasons.includes('core') && ready.shadow.ok === true, ready)
setSangguanConfig(db, 'agt_live', { replace: { V: 'engine' } })
const after = readViews(db, 'agt_live', { at: dayAt(199) })
const sum = Object.values(after.V.weights).reduce((a, b) => a + b, 0)
let moved = 0
for (const [k] of DIMS) moved = Math.max(moved, Math.abs((after.V.weights[k] || 0) - (prev[k] || 0)))
check('切到引擎后十维总和接近 1', after.source.V === 'engine' && Math.abs(sum - 1) < 0.02, { sum, source: after.source.V })
check('切换当天驱力移动不超过 0.02', moved <= 0.02 + 1e-9, moved)

setSangguanConfig(db, 'agt_live', { replace: { V: 'meter' } })
const back = readViews(db, 'agt_live')
check('退回替换开关后价值观仍是折算', back.source.V === 'engine' && back.V.weights.benevolence !== 0.42 && back.V.weights.benevolence > 0.2, back.V.weights.benevolence)

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
check('清理后夜巡不再重算价值观', !!(valuesStep && valuesStep.skipped && valuesStep.reason === 'removed'), valuesStep)

console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
