/**
 * 三观 S7：实践回流。π、J7、CON、m(ℓ)、Rev/Bad/Degen、J8、N1–N3、P5/P12/P18。
 * 运行：node test/sangguan-s7.test.mjs（可设 SG_SEED）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, newId, readEvents, SangguanError } from '../src/modules/sangguan/ledger.js'
import { emptyState, fold, checkInvariants } from '../src/modules/sangguan/fold.js'
import { loadState, rebuild, snapshot, stateToSnapshot } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { checkDue, conCheck, degenCheck, tryRepair, mOf, degenOf, e1Ready } from '../src/modules/sangguan/practice.js'
import { runMid } from '../src/modules/sangguan/night.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg7-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sg7'
setSangguanConfig(db, aid, { enabled: true })

let clock = Date.parse('2026-11-01T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const DAY = 86400000
const put = (evs, a = aid) => append(db, a, evs)
const mk = (layer, kind, text, origin = 'extract') => put([{
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(),
  payload: { claims: [{ layer, kind, text, origin }] },
}]).entities.claims[0]
const evid = (id, sign, kind = 'act') => ({
  type: 'EVIDENCE', actor: kind === 'verdict' ? 'user' : 'sys', at: tick(),
  payload: { evidence: [{ kind, target_type: 'claim', target_id: id, sign, weight: kind === 'act' ? 0.6 : 1, ref: 't:' + clock }] },
})

// Eq.3 π
{
  const c = mk('W', 'belt', '练习会留下痕迹')
  put([evid(c, 1, 'check')])
  const pi1 = loadState(db, aid).claims[c].pi
  check('π 上移：0 + α·1·(1−0) = 0.2', Math.abs(pi1 - 0.2) < 1e-9, pi1)
  put([evid(c, -1, 'check')])
  const pi2 = loadState(db, aid).claims[c].pi
  check('π 下移：0.2 − β·1·(1.2) = −0.1', Math.abs(pi2 - (0.2 - 0.25 * 1 * 1.2)) < 1e-9, pi2)
}

// P5：指向 ν 的证据必须晚于登记
{
  const c = mk('W', 'belt', '早起的人更稳')
  const at = tick()
  const nid = newId('nus', at)
  put([{ type: 'NU_REGISTER', actor: 'judge', at, payload: { nus: [{ id: nid, claim_id: c, expect: '一周内会早起四天', observe: '作息', p: 0.6, due_at: new Date(Date.parse(at) + 10 * DAY).toISOString() }] } }])
  try {
    put([{ type: 'EVIDENCE', actor: 'sys', at, payload: { evidence: [{ kind: 'check', target_type: 'nu', target_id: nid, sign: 1, weight: 1, ref: 'too-early' }] } }])
    check('P5：与登记同时的证据拒绝', false)
  } catch (e) {
    check('P5：与登记同时的证据拒绝', e instanceof SangguanError && /P5/.test(e.message), e.message)
  }
  put([{ type: 'EVIDENCE', actor: 'sys', at: tick(), payload: { evidence: [{ kind: 'check', target_type: 'nu', target_id: nid, sign: 1, weight: 1, ref: 'ok' }] } }])
  check('P5：晚于登记的 hit 证据可入账', loadState(db, aid).claims[c].n >= 1)
}

// J7：到期 hit / miss / void
{
  const c = mk('W', 'obs', '这周会下雨')
  const at = tick()
  const nHit = newId('nus', at)
  const nMiss = newId('nus', at)
  const nVoid = newId('nus', at)
  const due = new Date(Date.parse(at) + 2 * DAY).toISOString()
  put([{ type: 'NU_REGISTER', actor: 'judge', at, payload: { nus: [
    { id: nHit, claim_id: c, expect: '下雨', observe: '天气', p: 0.5, due_at: due },
    { id: nMiss, claim_id: c, expect: '打雷', observe: '天气', p: 0.4, due_at: due },
    { id: nVoid, claim_id: c, expect: '出虹', observe: '天气', p: 0.2, due_at: due },
  ] } }])
  // (t_reg, t_due] 内要有真实外部记录，J7 只能引用它们
  clock = Date.parse(at) + DAY
  const other = mk('W', 'obs', '天气记录本')
  put([evid(other, 1, 'act')])
  clock = Date.parse(due) + 60000
  const fabricated = []
  const chat = fakeChat({
    J7: (input) => {
      const rec = input.items[0].records[0].id
      fabricated.push(input.items.every((x) => x.records.some((r) => r.id === rec)))
      return {
        items: [
          { nu_id: nHit, outcome: 'hit', refs: [rec] },
          { nu_id: nMiss, outcome: 'miss', refs: [rec, 'rec-made-up'] },
          { nu_id: nVoid, outcome: 'hit', refs: ['rec-made-up'] },
        ],
      }
    },
  })
  const r = await checkDue(db, aid, new Date(clock).toISOString(), { chat, force: true })
  const s = loadState(db, aid)
  check('J7 hit/miss/void 都结算', r.did.length === 3 && s.nus[nHit].outcome === 'hit' && s.nus[nMiss].outcome === 'miss' && s.nus[nVoid].outcome === 'void', r)
  check('只引用编造记录的 hit 判为 void；输入里给了真实记录', fabricated[0] === true && s.nus[nVoid].outcome === 'void')
  check('void 不改 π（只有 hit/miss 两条 check）', s.claims[c].n === 2, s.claims[c].n)
  const types = readEvents(db, aid).filter((e) => e.type === 'NU_RESOLVE' && [nHit, nMiss, nVoid].includes(e.payload.nu_id))
  check('P5：hit/miss 的结算时间晚于登记', types.every((e) => Date.parse(e.at) > Date.parse(at)))
}

// P12：核心不能 CON
{
  const core = mk('W', 'core', '世界可以被认识', 'seed')
  try {
    put([{ type: 'CON', layer: 'W', actor: 'sys', at: tick(), payload: { claim_id: core } }])
    check('P12：核心不能 CON', false)
  } catch (e) {
    check('P12：核心不能 CON', /核心/.test(e.message) || e.code === 'TRANSITION', e.message)
  }
}

// CON：保护带 π 跌破
{
  const c = mk('W', 'belt', '所有乌鸦都是白的')
  for (let i = 0; i < 3; i++) put([evid(c, -1, 'check')])
  const r = conCheck(db, aid, tick())
  check('π≤π_fals 且 n≥n_min → CON', r.did.some((d) => d.id === c) && loadState(db, aid).claims[c].status === 'falsified', r)
}

// 场景③前半 + P18：核心受挫 → REPAIR_FAILED ×K → Degen → E1 就绪
{
  const P = 'agt_p18'
  setSangguanConfig(db, P, { enabled: true })
  const core = append(db, P, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'core', text: '努力是可靠的', origin: 'seed' }] } }]).entities.claims[0]
  for (let i = 0; i < 5; i++) {
    append(db, P, [{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind: 'verdict', target_type: 'claim', target_id: core, sign: -1, weight: 1, ref: 'hurt' + i }] } }])
  }
  const chat = fakeChat({ J8: '坏' })
  const fails = []
  for (let i = 0; i < 3; i++) {
    const r = await tryRepair(db, P, core, tick(), { chat })
    fails.push(r)
  }
  check('J8 失败写 REPAIR_FAILED', fails.every((r) => r.failed) && readEvents(db, P).filter((e) => e.type === 'REPAIR_FAILED').length >= 3, fails)
  const evs = readEvents(db, P)
  const st = loadState(db, P)
  check('m(ℓ) 计入核心负证据', mOf(st, 'W', evs) >= 5, mOf(st, 'W', evs))
  check('最近 K 条修订都 Bad → Degenerate', degenOf(st, evs, 'W').degenerate === true, degenOf(st, evs, 'W'))
  for (let i = 0; i < 14; i++) {
    clock += DAY
    degenCheck(db, P, new Date(clock).toISOString())
  }
  const evs2 = readEvents(db, P)
  const e1 = e1Ready(loadState(db, P), evs2, 'W', new Date(clock).toISOString())
  check('P18：有限夜数内 REPAIR_FAILED → Degen → E1 就绪', e1.ready && e1.byDegen && e1.m >= 5, e1)
}

// 修补成功：保护带 + DEPENDS + ν
{
  const core = mk('L', 'telos', '先把身体养好', 'seed')
  put([evid(core, -1, 'act')])
  const chat = fakeChat({
    J8: { text: '连续两周睡眠不低于六小时', depends_core_id: core, nu: [{ expect: '两周后精神更好', observe: '作息', p: 0.6, due_days: 14 }] },
  })
  const r = await tryRepair(db, aid, core, tick(), { chat })
  const s = loadState(db, aid)
  check('J8 成功：新保护带 DEPENDS 指向核心', r.ok && s.claims[r.claim_id] && Object.values(s.edges).some((e) => e.type === 'DEPENDS' && e.from_id === r.claim_id && e.to_id === core), r)
  check('成功修补登记了新 ν（暂不算 Bad）', Object.values(s.nus).some((n) => n.claim_id === r.claim_id && n.outcome === 'pending'))
}

// runMid：N1–N3 能跑完
{
  const M = 'agt_mid'
  setSangguanConfig(db, M, { enabled: true })
  const c = append(db, M, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'belt', text: '水往低处流', origin: 'extract' }] } }]).entities.claims[0]
  const at = tick()
  const nid = newId('nus', at)
  append(db, M, [{ type: 'NU_REGISTER', actor: 'judge', at, payload: { nus: [{ id: nid, claim_id: c, expect: '还能流', observe: '日常', p: 0.8, due_at: new Date(Date.parse(at) + DAY).toISOString() }] } }])
  clock += 2 * DAY
  const chat = fakeChat({ J7: { items: [{ nu_id: nid, outcome: 'void', refs: [] }] }, J8: '坏' })
  const r = await runMid(db, M, new Date(clock).toISOString(), { chat, deliberate: false })
  // 没有核心的层不写 DEGEN_CHECK（不可能升维）
  check('runMid 开关开：N1+N3 跑完（无核心层不写检查点）', r.status === 'done' && r.n1.did.some((d) => d.id === nid) && r.degen.length === 0, r)
  check('夜间后不变式成立', checkInvariants(loadState(db, M)).length === 0)
}

{
  const off = 'agt_off7'
  const r = await runMid(db, off, tick(), { force: false, deliberate: false })
  check('开关默认关：runMid 直接 off', r.status === 'off')
}

// P1
{
  const live = snapshot(db, aid)
  check('P1 纯折叠 = 增量投影', same(stateToSnapshot(fold(emptyState(), readEvents(db, aid)), aid), live))
  rebuild(db, aid)
  check('P1 rebuild 后相等', same(snapshot(db, aid), live))
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
{
  const SEED = Number(process.env.SG_SEED) || 20261101
  const rnd = mulberry32(SEED)
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
  const F = 'agt_fuzz7'
  setSangguanConfig(db, F, { enabled: true })
  const chat = fakeChat({
    J7: (input) => ({ items: (input.items || []).map((n) => ({ nu_id: n.nu_id, outcome: rnd() < 0.4 ? 'void' : (rnd() < 0.5 ? 'hit' : 'miss'), refs: rnd() < 0.4 ? [] : ['r'] })) }),
    J8: () => (rnd() < 0.5 ? '坏' : { text: '补丁' + Math.floor(rnd() * 1e5), depends_core_id: 'will-fix', nu: [] }),
  })
  const bugs = []
  const tally = { mid: 0, con: 0, repair: 0, rej: {} }
  for (let i = 0; i < 50; i++) {
    const s = loadState(db, F)
    const live = Object.values(s.claims).filter((c) => c.status === 'active')
    const at = tick(15)
    try {
      if (rnd() < 0.35 || live.length < 1) {
        const kind = rnd() < 0.1 && !Object.values(s.claims).some((c) => c.kind === 'core') ? 'core' : pick(['belt', 'obs'])
        append(db, F, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at, payload: { claims: [{ layer: 'W', kind, text: 'fz7-' + i, origin: kind === 'core' ? 'seed' : 'extract' }] } }])
      } else if (rnd() < 0.6 && live.length) {
        append(db, F, [{ type: 'EVIDENCE', actor: 'user', at, payload: { evidence: [{ kind: pick(['act', 'verdict']), target_type: 'claim', target_id: pick(live).id, sign: pick([1, -1]), weight: pick([0.6, 1]), ref: 'f' + i }] } }])
      } else if (live.length) {
        append(db, F, [{ type: 'NU_REGISTER', actor: 'judge', at, payload: { nus: [{ claim_id: pick(live).id, expect: 'e', observe: 'o', p: 0.5, due_at: new Date(Date.parse(at) + 2 * DAY).toISOString() }] } }])
      }
    } catch (e) {
      tally.rej[(e.code || 'X') + ' ' + String(e.message).slice(0, 40)] = (tally.rej[(e.code || 'X') + ' ' + String(e.message).slice(0, 40)] || 0) + 1
    }
    if (rnd() < 0.45) {
      clock += (rnd() < 0.4 ? 3 : 1) * DAY
      try {
        const j8core = Object.values(loadState(db, F).claims).find((c) => c.kind === 'core')
        const chatI = fakeChat({
          J7: (input) => ({ items: (input.items || []).map((n) => ({ nu_id: n.nu_id, outcome: rnd() < 0.5 ? 'void' : 'miss', refs: ['r'] })) }),
          J8: j8core ? { text: '护' + i, depends_core_id: j8core.id, nu: rnd() < 0.3 ? [{ expect: 'e', observe: 'o', p: 0.5, due_days: 5 }] : [] } : '坏',
        })
        const r = await runMid(db, F, new Date(clock).toISOString(), { chat: chatI, deliberate: false })
        tally.mid++
        tally.con += (r.con || []).length
        tally.repair += (r.repair || []).length
      } catch (e) { bugs.push({ i, msg: String(e && e.message) }) }
    }
    const inv = checkInvariants(loadState(db, F))
    if (inv.length) bugs.push({ i, inv: inv.slice(0, 2) })
  }
  check('模糊（种子 ' + SEED + '）：无非预期异常、不变式成立', bugs.length === 0, bugs.slice(0, 3))
  check('模糊：中环跑过', tally.mid > 3, tally)
  const before = JSON.stringify(snapshot(db, F))
  rebuild(db, F)
  check('模糊：P1 重放一致', JSON.stringify(snapshot(db, F)) === before)
  console.log('  模糊覆盖：', JSON.stringify(tally))
}

{
  const src = (f) => fs.readFileSync(new URL('../src/modules/sangguan/' + f, import.meta.url), 'utf8')
  check('I15 practice 不读 Date.now', !/Date\.now\(/.test(src('practice.js')))
  check('I15 fold 不依赖 practice / night', !/from '\.\/(practice|night|trial|deliberate)\.js'/.test(src('fold.js')))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
