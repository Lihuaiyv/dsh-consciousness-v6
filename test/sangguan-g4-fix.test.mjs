/**
 * 三观第四组遗留收尾：TRADEOFF → PRESSURE 边、种核心（冷启动）、导出带三观账本、清除后的孤儿补清。全部离线。
 * 运行：node test/sangguan-g4-fix.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg4fix-'))
process.env.DSH_HOME = home
process.env.DSHC_TEST_NO_LIMIT = '1'
const { openDb } = await import('../src/db.js')
const { getFlag } = await import('../src/kernel.js')
const { append, newId, readEvents, lastSeq } = await import('../src/modules/sangguan/ledger.js')
const { loadState, rebuild, snapshot } = await import('../src/modules/sangguan/projection.js')
const { checkInvariants } = await import('../src/modules/sangguan/fold.js')
const { setSangguanConfig } = await import('../src/modules/sangguan/config.js')
const { runFast } = await import('../src/modules/sangguan/fast.js')
const { balanceOf } = await import('../src/modules/sangguan/liveness.js')
const { purgeOrphans } = await import('../src/modules/sangguan/purge.js')
const { L0_TABLES, PROJ_TABLES } = await import('../src/modules/sangguan/schema.js')
const { exportZip, importZip, purgeExpired } = await import('../src/modules/ops.js')
const { unzipStore } = await import('../src/zip.js')
const { fakeChat } = await import('./sangguan-fake-llm.mjs')
const api = await import('../src/api.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 900)) }
}
const db = openDb(path.join(home, 'app.db'))
let clock = Date.parse('2026-11-03T08:00:00.000Z')
const DAY = 86400000
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const put = (aid, evs) => append(db, aid, evs)
const mk = (aid, layer, kind, text) => put(aid, [{ type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(), payload: { claims: [{ layer, kind, text, origin: 'extract' }] } }]).entities.claims[0]
const addAgent = (id, status = 'active') => db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, id, 'daily', status, new Date().toISOString())
function coexK(aid, layer, pos, neg) {
  const at = tick()
  const q = newId('questions', at)
  const k = put(aid, [{ type: 'KAPPA_OPEN', layer, actor: 'judge', at, payload: { questions: [{ id: q, layer, text: '取哪边' }], kappas: [{ layer, q_id: q, pos_id: pos, neg_id: neg, dep: 'd', excl: 'e' }] } }]).entities.kappas[0]
  put(aid, [
    { type: 'DELIBERATE', layer, actor: 'judge', at: tick(), payload: { kappa_id: k, branch: 'COEX' } },
    { type: 'COEX', layer, actor: 'judge', at: tick(), payload: { kappa_id: k, loss: { lean_pole: 'pos', cost: '慢一点' } } },
  ])
  return k
}
let kseq = 0
const H = (method, p, body, token = 'user') => api.handle(db, { method, path: '/v1/agents/' + p, token, body: method === 'GET' ? {} : { __idempotencyKey: 'f' + (++kseq), ...(body || {}) } })
const tradeoff = (aid, k, lean, day) => runFast(
  { db, aid, at: day + 'T09:00:00.000Z', embed: async () => null, chat: fakeChat({ J1: () => ({ candidates: [], evidence: [], tradeoffs: [{ kappa_id: k, lean_pole: lean, cost: '这次让了一步', ref_turn: 0 }], answers: [] }) }) },
  [{ role: 'user', text: '这次我选了' + lean }, { role: 'assistant', text: '好' }],
)
const pressures = (aid) => Object.values(loadState(db, aid).edges).filter((e) => e.type === 'PRESSURE' && e.active)

// ---------- 种核心（冷启动） ----------
const A = 'agt_fix_a'
addAgent(A)
{
  const off = await H('POST', A + '/sangguan/seed', { layer: 'L', text: '把日子过成自己想要的样子' })
  check('关闭时种核心：409', off.status === 409, off)
  setSangguanConfig(db, A, { enabled: true })
  const viewer = await H('POST', A + '/sangguan/seed', { layer: 'L', text: '把日子过成自己想要的样子' }, 'viewer')
  check('viewer 种核心：403', viewer.status === 403, viewer.status)
  const bad = await H('POST', A + '/sangguan/seed', { layer: 'X', text: '把日子过成自己想要的样子' })
  const short = await H('POST', A + '/sangguan/seed', { layer: 'L', text: '活' })
  check('层不对 / 太短：400', bad.status === 400 && short.status === 400, [bad.status, short.status])
  const n0 = lastSeq(db, A)
  const ok = await H('POST', A + '/sangguan/seed', { layer: 'L', text: '把日子过成自己想要的样子' })
  const c = loadState(db, A).claims[ok.body.claim_id]
  const ev = readEvents(db, A).pop()
  check('种下：L 层 telos、origin seed、actor user', ok.status === 200 && c && c.kind === 'telos' && c.origin === 'seed' && ev.actor === 'user' && lastSeq(db, A) === n0 + 1, { ok, c })
  const again = await H('POST', A + '/sangguan/seed', { layer: 'L', text: '另一句志向志向' })
  check('同层已有核心：409 HAS_CORE，不写', again.status === 409 && again.body.error.code === 'HAS_CORE' && lastSeq(db, A) === n0 + 1, again)
  const replay1 = await api.handle(db, { method: 'POST', path: '/v1/agents/' + A + '/sangguan/seed', token: 'user', body: { __idempotencyKey: 'seed-fixed', layer: 'W', text: '世界大体上可以被理解' } })
  const replay2 = await api.handle(db, { method: 'POST', path: '/v1/agents/' + A + '/sangguan/seed', token: 'user', body: { __idempotencyKey: 'seed-fixed', layer: 'W', text: '世界大体上可以被理解' } })
  check('同一幂等键重放：只种一次', replay1.status === 200 && JSON.stringify(replay1.body) === JSON.stringify(replay2.body) && Object.values(loadState(db, A).claims).filter((x) => x.layer === 'W').length === 1)
  const hd = await H('GET', A + '/sangguan/heads?layer=L')
  check('链头里看得到它', hd.status === 200 && hd.body.layers.L.some((x) => x.id === ok.body.claim_id && x.kind === 'telos'), hd.body)
}

// ---------- TRADEOFF → PRESSURE ----------
{
  const telos = Object.values(loadState(db, A).claims).find((c) => c.kind === 'telos').id
  mk(A, 'L', 'chapter', '这几年在学着慢下来')
  const p = mk(A, 'V', 'norm', '说话要直接')
  const n = mk(A, 'V', 'norm', '说话要留余地')
  const kV = coexK(A, 'V', p, n)
  const r1 = await tradeoff(A, kV, 'pos', '2026-11-05')
  const e1 = pressures(A)
  check('V 层取舍：TRADEOFF 同批连一条 PRESSURE（偏向极 → L 的 telos）', r1.tradeoffs.written === 1 && r1.tradeoffs.pressure === 1 && e1.length === 1 && e1[0].from_id === p && e1[0].to_id === telos, { r1: r1.tradeoffs, e1, errors: r1.errors })
  const r2 = await tradeoff(A, kV, 'pos', '2026-11-06')
  check('同一对再取舍：TRADEOFF 照记，边不重复', r2.tradeoffs.written === 1 && r2.tradeoffs.pressure === 0 && pressures(A).length === 1, r2.tradeoffs)
  const r3 = await tradeoff(A, kV, 'neg', '2026-11-07')
  check('偏向另一极：再连一条', r3.tradeoffs.pressure === 1 && pressures(A).some((e) => e.from_id === n && e.to_id === telos), r3.tradeoffs)
  check('L 层「生」计入 PRESSURE', balanceOf(loadState(db, A), 'L').sheng >= 2, balanceOf(loadState(db, A), 'L'))
  const w1 = mk(A, 'W', 'belt', '人多数时候讲道理')
  const w2 = mk(A, 'W', 'belt', '人多数时候只顾自己')
  const kW = coexK(A, 'W', w1, w2)
  const before = pressures(A).length
  const r4 = await tradeoff(A, kW, 'pos', '2026-11-08')
  check('W 层取舍不产 PRESSURE', r4.tradeoffs.written === 1 && r4.tradeoffs.pressure === 0 && pressures(A).length === before, r4.tradeoffs)
}
{
  const B = 'agt_fix_b'
  addAgent(B)
  setSangguanConfig(db, B, { enabled: true })
  const kV = coexK(B, 'V', mk(B, 'V', 'norm', '守时'), mk(B, 'V', 'norm', '随性'))
  const r = await tradeoff(B, kV, 'pos', '2026-11-05')
  check('L 层还没有看法：只记 TRADEOFF，不连边', r.tradeoffs.written === 1 && r.tradeoffs.pressure === 0 && pressures(B).length === 0, r.tradeoffs)
}
for (const aid of ['agt_fix_a', 'agt_fix_b']) {
  const bad = checkInvariants(loadState(db, aid))
  const s0 = JSON.stringify(snapshot(db, aid))
  rebuild(db, aid)
  check('不变式 + P1 重放一致（' + aid + '）', (!bad || !bad.length) && JSON.stringify(snapshot(db, aid)) === s0, bad)
}

// ---------- 导出带三观账本 ----------
{
  const files = unzipStore(exportZip(db, A))
  const lines = String(files['sangguan.ndjson'] || '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const evs = readEvents(db, A)
  check('导出：sangguan.ndjson 与账本逐条一致（按 seq）', lines.length === evs.length && lines.every((e, i) => e.seq === evs[i].seq && e.type === evs[i].type && e.id === evs[i].id), { n: lines.length, m: evs.length })
  check('导出：命题原文在事件里（可离线重放）', lines.some((e) => (e.payload.claims || []).some((c) => c.text === '把日子过成自己想要的样子')))
  const C = 'agt_fix_c'
  addAgent(C)
  const plain = unzipStore(exportZip(db, C))
  check('没有三观账本的 agent：不出这个文件', !('sangguan.ndjson' in plain) && 'memory.ndjson' in plain, Object.keys(plain))
  const n0 = lastSeq(db, C)
  const r = importZip(db, C, exportZip(db, A))
  check('导入：三观账本不回放（只存档）', r.imported && lastSeq(db, C) === n0 && readEvents(db, C).length === 0, r)
}

// ---------- 孤儿补清 ----------
{
  const O = 'agt_fix_orphan'
  setSangguanConfig(db, O, { enabled: true })
  mk(O, 'W', 'belt', '没人认领的看法')
  const F = 'agt_fix_flagonly'
  setSangguanConfig(db, F, { enabled: true })
  const keepA = JSON.stringify(snapshot(db, A))
  const out = purgeExpired(db)
  const left = [...L0_TABLES, ...PROJ_TABLES].reduce((n, t) => n + db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE agent_id=?`).get(O).n, 0)
  check('purgeExpired：agents 里没有的三观数据被补清（含只剩开关的）', out && left === 0 && getFlag(db, 'sangguan:' + O) === null && getFlag(db, 'sangguan:' + F) === null, { left })
  check('在册 agent 不受影响', JSON.stringify(snapshot(db, A)) === keepA && readEvents(db, A).length > 0)
  check('再跑一次：没有可清的', purgeOrphans(db).length === 0)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
