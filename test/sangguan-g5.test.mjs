/**
 * 三观 G5：读口与旧仪表逐字一致；空仪表不种；偏离够了才种；同义对话 DUP；
 * 空种子不替换注入；撤回只增账本；占用中的种子 409；别的 agent 不受影响；
 * 新核心确立时空种子核心变成 superseded。
 * 运行：node test/sangguan-g5.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, readEvents, newId } from '../src/modules/sangguan/ledger.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { readViews } from '../src/modules/sangguan/bridge.js'
import { seedFromMeters, withdrawSeed } from '../src/modules/sangguan/seed.js'
import { promptHook } from '../src/modules/sangguan/inject.js'
import { runFast } from '../src/modules/sangguan/fast.js'
import { SangguanError } from '../src/modules/sangguan/errors.js'
import { DIMS } from '../src/modules/values.js'
import { worldviewPromptLine, listWorldviewRich, INIT as WV_INIT } from '../src/modules/worldview.js'
import { lifeviewPromptLine, listLifeviewRich, explainLifeview } from '../src/modules/lifeview.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg5-'))
const db = openDb(path.join(dir, 'app.db'))
// 旧库模拟：v6 之前有 persona_values 表；生产代码不再建它，测试自己造一份来验迁移/兼容
db.exec(`CREATE TABLE IF NOT EXISTS persona_values(agent_id TEXT NOT NULL, key TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.1, evidence TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(agent_id,key))`)
const T0 = '2026-11-01T12:00:00.000Z'
const addAgent = (id) => db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, id, 'daily', 'active', T0)
const putVal = (aid, key, weight) => db.prepare('INSERT INTO persona_values VALUES(?,?,?,?,?)').run(aid, key, weight, '[]', T0)

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

const putW = (aid, key, weight) => db.prepare('INSERT INTO persona_worldview VALUES(?,?,?,?,?)').run(aid, key, weight, '[]', T0)
const putL = (aid, key, weight) => db.prepare('INSERT INTO persona_lifeview VALUES(?,?,?,?,?)').run(aid, key, weight, '[]', T0)

function legacyLines(aid) {
  const vals = db.prepare('SELECT key,weight FROM persona_values WHERE agent_id=? ORDER BY weight DESC').all(aid)
  const ws = vals.map((v) => Number(v.weight) || 0)
  const spread = ws.length > 1 ? Math.max(...ws) - Math.min(...ws) : 0
  const valLine = vals.length && spread >= 0.03
    ? '你看重：' + vals.slice(0, 3).map((v) => ((DIMS.find((d) => d[0] === v.key) || [0, v.key])[1])).join('、') + '。'
    : ''
  let worldLine = ''
  const wrows = listWorldviewRich(db, aid)
  const wLean = (wrows || []).filter((x) => Math.abs(Number(x.weight) - WV_INIT) >= 0.08)
  if (wLean.length) worldLine = worldviewPromptLine(wrows)
  const lrows = listLifeviewRich(db, aid)
  const lex = explainLifeview(db, aid)
  const lifeLine = lifeviewPromptLine(lrows, lex && lex.derived && lex.derived.stance)
  return { worldLine, lifeLine, valLine }
}

addAgent('agt_meter')
for (const [k] of DIMS) putVal('agt_meter', k, k === 'benevolence' ? 0.42 : 0.064)
seedFromLegacy(db, 'agt_meter', T0)
putW('agt_meter', 'safe', 0.72)
for (const k of ['coherence', 'purpose', 'mattering', 'search', 'growth', 'communion', 'horizon']) putL('agt_meter', k, k === 'purpose' ? 0.7 : 0.5)
{
  const view = readViews(db, 'agt_meter')
  const old = legacyLines('agt_meter')
  check('世界观和人生观仍与旧算法逐字相同', view.W.line === old.worldLine && view.L.line === old.lifeLine, { view, old })
  check('价值观默认折算，不再等于旧表原值', view.source.V === 'engine' && view.V.line.startsWith('你看重：仁善') && view.V.weights.benevolence > 0.3 && view.V.weights.benevolence !== 0.42, view.V)
}

addAgent('agt_empty')
setSangguanConfig(db, 'agt_empty', { enabled: true })
{
  const r = seedFromMeters(db, 'agt_empty', T0)
  check('极差为 0、没有偏离：一条种子都不种', r.seeded.length === 0 && loadState(db, 'agt_empty').claims && Object.keys(loadState(db, 'agt_empty').claims).length === 0, r)
}

addAgent('agt_seed')
setSangguanConfig(db, 'agt_seed', { enabled: true })
for (const [k] of DIMS) putVal('agt_seed', k, k === 'benevolence' ? 0.4 : 0.06)
putW('agt_seed', 'safe', 0.2)
for (const k of ['coherence', 'purpose', 'mattering', 'search', 'growth', 'communion', 'horizon']) putL('agt_seed', k, k === 'communion' ? 0.7 : 0.5)
{
  const r = seedFromMeters(db, 'agt_seed', T0)
  check('偏离够了才种世界观和人生观', r.seeded.slice().sort().join('') === 'LW', r)
  const s = loadState(db, 'agt_seed')
  const claims = Object.values(s.claims)
  check('种子 π=0 且种类对', claims.length === 2 && claims.every((c) => c.origin === 'seed' && c.pi === 0 && c.n === 0)
    && claims.some((c) => c.layer === 'W' && c.kind === 'belt')
    && claims.some((c) => c.layer === 'L' && c.kind === 'telos')
    && !claims.some((c) => c.layer === 'V'), claims.map((c) => c.layer + c.kind))
  const texts = db.prepare('SELECT text FROM persona_claims WHERE agent_id=?').all('agt_seed').map((r) => r.text)
  check('种子不引用记忆原文', texts.every((t) => t.startsWith('我倾向认为') || t.startsWith('我更想') || t.startsWith('我更看重')) && !texts.some((t) => /记忆|用户/.test(t)), texts)
  const again = seedFromMeters(db, 'agt_seed', T0)
  check('种过不再种', again.seeded.length === 0 && Object.keys(loadState(db, 'agt_seed').claims).length === 2, again)
}

addAgent('agt_other')
setSangguanConfig(db, 'agt_other', { enabled: true })
check('别的 agent 不受影响', Object.keys(loadState(db, 'agt_other').claims).length === 0)

{
  setSangguanConfig(db, 'agt_seed', { inject: 'live' })
  const legacy = { worldLine: '你对世界的基本看法：旧仪表一句。', lifeLine: '你的人生观底色：旧志向。', valLine: '你看重：自由、成长、安全。' }
  const hooked = promptHook(db, 'agt_seed', legacy, { now: T0 })
  check('空种子不替换注入', hooked.worldLine === legacy.worldLine && hooked.lifeLine === legacy.lifeLine && hooked.valLine === legacy.valLine, hooked)
}

{
  seedFromLegacy(db, 'agt_seed', T0)
  const v = Object.values(loadState(db, 'agt_seed').claims).find((c) => c.layer === 'V')
  const text = db.prepare('SELECT text FROM persona_claims WHERE id=?').get(v.id).text
  const j2 = (input) => ({ pairs: input.neighbors.map((n) => ({ c_id: n.id, rel: 'dup', reason: '同义' })) })
  const j1 = () => ({ candidates: [{ layer: 'V', kind: 'norm', text }], evidence: [], tradeoffs: [], answers: [] })
  const chat = fakeChat({ J1: j1, J2: j2 })
  const at = '2026-11-02T12:00:00.000Z'
  const ran = await runFast({ db, aid: 'agt_seed', at, day: at.slice(0, 10), chat, embed: async () => null }, [{ role: 'user', text }])
  const dup = readEvents(db, 'agt_seed', { types: ['DUP'] })
  check('同一句再抽得到 DUP', dup.length === 1 && dup[0].payload.claim_id === v.id, { dup: dup.length, items: ran.items, errors: ran.errors })
  check('同义句不另起链头', Object.values(loadState(db, 'agt_seed').claims).filter((c) => c.layer === 'V').length === 1)
}

{
  const before = db.prepare('SELECT COUNT(*) n FROM claim_events').get().n
  const w = Object.values(loadState(db, 'agt_seed').claims).find((c) => c.layer === 'W')
  const out = withdrawSeed(db, 'agt_seed', w.id, '2026-11-03T00:00:00.000Z')
  const after = loadState(db, 'agt_seed').claims[w.id]
  check('撤回后状态是 withdrawn，账本只增', out.ok && after.status === 'withdrawn' && db.prepare('SELECT COUNT(*) n FROM claim_events').get().n === before + 1, after.status)
}

{
  const l = Object.values(loadState(db, 'agt_seed').claims).find((c) => c.layer === 'L')
  append(db, 'agt_seed', [{
    type: 'CLAIM_EXP', layer: 'L', actor: 'sys', at: '2026-11-03T01:00:00.000Z',
    payload: { claims: [{ layer: 'L', kind: 'chapter', text: '先把这一程走完', origin: 'extract', pred: [l.id] }] },
  }])
  let msg = ''
  try { withdrawSeed(db, 'agt_seed', l.id, '2026-11-03T02:00:00.000Z') } catch (e) { msg = e.message }
  check('已经长出后续不能撤回', msg === '已经长出后续，不能撤回')
  check('占用中的种子仍是 active', loadState(db, 'agt_seed').claims[l.id].status === 'active')
}

{
  append(db, 'agt_seed', [{
    type: 'EVIDENCE', actor: 'user', at: '2026-11-03T03:00:00.000Z',
    payload: { evidence: [{ kind: 'verdict', target_type: 'claim', target_id: Object.values(loadState(db, 'agt_seed').claims).find((c) => c.layer === 'V').id, sign: 1, weight: 1, ref: 't' }] },
  }])
  const v = Object.values(loadState(db, 'agt_seed').claims).find((c) => c.layer === 'V')
  let msg = ''
  try { withdrawSeed(db, 'agt_seed', v.id, '2026-11-03T04:00:00.000Z') } catch (e) { msg = e instanceof SangguanError ? e.message : String(e) }
  check('有证据的种子不能撤回', msg === '已经长出后续，不能撤回', msg)
}

addAgent('agt_core')
setSangguanConfig(db, 'agt_core', { enabled: true })
{
  const belt = append(db, 'agt_core', [{ type: 'CLAIM_EXP', layer: 'L', actor: 'sys', at: T0, payload: { claims: [{ layer: 'L', kind: 'chapter', text: '把认定的方向做成', origin: 'extract' }] } }]).entities.claims[0]
  const seed = append(db, 'agt_core', [{ type: 'CLAIM_EXP', layer: 'L', actor: 'sys', at: T0, payload: { claims: [{ layer: 'L', kind: 'telos', text: '我更想有在追的方向', origin: 'seed' }] } }]).entities.claims[0]
  const neu = append(db, 'agt_core', [{
    type: 'CORE_ESTABLISH', layer: 'L', actor: 'judge', at: '2026-11-04T00:00:00.000Z',
    payload: { from_id: belt, claims: [{ layer: 'L', kind: 'telos', text: '把认定的方向一点点做成', origin: 'extract', pred: [belt] }] },
  }])
  const s = loadState(db, 'agt_core')
  check('空种子核心被新核心标成 superseded', s.claims[seed].status === 'superseded' && s.claims[seed].pred.length === 0, s.claims[seed])
  check('新核心是 active', s.claims[neu.entities.claims[0]].status === 'active')
}

console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
