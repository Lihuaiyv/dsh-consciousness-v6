/**
 * 三观 S8：三层差异。COEX / TRADEOFF / VException / 跨层半权 / KAPPA_OBSOLETE / REVIEW_FLAG。
 * P6、P9、P21、P22、P23；场景④。
 * 运行：node test/sangguan-s8.test.mjs（可设 SG_SEED）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, newId, readEvents, lastSeq, SangguanError } from '../src/modules/sangguan/ledger.js'
import { emptyState, fold, checkInvariants } from '../src/modules/sangguan/fold.js'
import { loadState, rebuild, snapshot, stateToSnapshot } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { plan, execute, runNight } from '../src/modules/sangguan/deliberate.js'
import { deriveCross, vExceptionOf, flagsForTerminal } from '../src/modules/sangguan/practice.js'
import { runFast } from '../src/modules/sangguan/fast.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg8-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sg8'
setSangguanConfig(db, aid, { enabled: true })

let clock = Date.parse('2026-11-01T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const DAY = 86400000
const put = (evs, a = aid) => append(db, a, evs)
const mk = (layer, kind, text, origin = 'extract') => put([{
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(),
  payload: { claims: [{ layer, kind, text, origin }] },
}]).entities.claims[0]
function openK(layer, pos, neg, qtext) {
  const at = tick()
  const q = newId('questions', at)
  return put([{
    type: 'KAPPA_OPEN', layer, actor: 'judge', at,
    payload: { questions: [{ id: q, layer, text: qtext }], kappas: [{ layer, q_id: q, pos_id: pos, neg_id: neg, dep: 'd', excl: 'e' }] },
  }]).entities.kappas[0]
}
const passJ5 = { s1: { pass: true }, s3: { pass: true }, s4: { pass: true }, s5_hint: { pass: true } }
const j6ok = { incommensurable: true, parallel_ok: true, loss: { lean_pole: 'pos', cost: '这次先顾这一边' } }

// W 不能 COEX
{
  const a = mk('W', 'belt', '努力通常有用')
  const b = mk('W', 'belt', '运气更关键')
  const k = openK('W', a, b, '成败看什么')
  const p = plan(db, aid, k, tick(), { allowCoex: true })
  check('W 层不试 COEX', p.try_coex !== true && !(p.calls || []).some((c) => c.id === 'J6'), p)
}

// 场景④：V 并存 + 多次取舍
const vPos = mk('V', 'norm', '诚实比圆滑更重要')
const vNeg = mk('V', 'norm', '有时圆滑比诚实更重要')
const kV = openK('V', vPos, vNeg, '该不该永远说实话')
{
  const chat = fakeChat({ J6: j6ok })
  const r = await execute(db, aid, plan(db, aid, kV, tick(), { allowCoex: true }), tick(), { chat })
  check('场景④：V 层写出 COEX', r.ok && r.branch === 'COEX' && loadState(db, aid).kappas[kV].sigma === 'coexist', r)
  const loss = readEvents(db, aid).filter((e) => e.type === 'COEX' && e.payload.kappa_id === kV).pop()
  check('COEX 带 loss', !!(loss && loss.payload.loss && loss.payload.loss.cost), loss && loss.payload)
  for (let i = 0; i < 2; i++) {
    put([{ type: 'TRADEOFF', layer: 'V', actor: 'sys', at: tick(), payload: { kappa_id: kV, lean_pole: i ? 'neg' : 'pos', cost: '场合' + i, ref: 't' + i } }])
  }
  check('TRADEOFF 绑定并存 κ', readEvents(db, aid).filter((e) => e.type === 'TRADEOFF' && e.payload.kappa_id === kV).length === 2)
  clock += 15 * DAY
  const trades = readEvents(db, aid).filter((e) => e.type === 'TRADEOFF' && e.payload.kappa_id === kV)
  const reopen = readEvents(db, aid).some((e) => e.type === 'REOPEN' && e.payload.kappa_id === kV)
  check('P22：并存后有取舍且 T_mature 内未重开 → o ≠ 0', trades.length >= 1 && !reopen && loadState(db, aid).kappas[kV].sigma === 'coexist', { trades: trades.length, reopen })
}

// L 层两极 π≥0 才能 COEX
{
  const a = mk('L', 'chapter', '这阵子先养身体')
  const b = mk('L', 'chapter', '这阵子先把项目做完')
  const k = openK('L', a, b, '这阵子怎么过')
  const chat = fakeChat({ J6: { incommensurable: false, parallel_ok: true, loss: { lean_pole: 'neg', cost: '项目会慢一点' } } })
  const r = await execute(db, aid, plan(db, aid, k, tick(), { allowCoex: true }), tick(), { chat })
  check('L 层 π≥0 且 J6 可并行 → COEX', r.ok && r.branch === 'COEX', r)
}

// VException + P6
{
  const prin = mk('V', 'norm', '扩展对方的能动')
  const other = mk('V', 'norm', '先保全自己的边界')
  const k = openK('V', prin, other, '陪伴以谁为先')
  const life = mk('L', 'chapter', '这周把对方的事排在第一')
  put([{ type: 'EDGE_ADD', actor: 'sys', at: tick(), payload: { edges: [{ type: 'CONSTRAINS', from_id: prin, to_id: life }] } }])
  for (let i = 0; i < 3; i++) {
    put([{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind: 'act', target_type: 'claim', target_id: life, sign: -1, weight: 0.6, ref: 'miss' + i }] } }])
  }
  const s = loadState(db, aid)
  const vx = vExceptionOf(s, s.kappas[k], readEvents(db, aid), tick())
  check('VException：T_v 内 ≥ D_v 条下层负证据', vx.ok && vx.ids.length >= 3, vx)
  const chat = fakeChat({
    J4: (input) => ({
      text: '先守住自己才能持续扩展对方',
      kept_pos: [input.pos.text.slice(0, 2)], kept_neg: [input.neg.text.slice(0, 2)],
      dropped: ['只'],
      boundary: [{ text: '连续两周自己没有崩溃', testable: true }],
      nu: [{ expect: '对方的主动选择变多', observe: '对话', p: 0.6, due_days: 10 }],
    }),
    J5: passJ5,
  })
  const r = await execute(db, aid, plan(db, aid, k, tick(), { allowSub: true, vException: vx }), tick(), { chat })
  const acc = readEvents(db, aid).filter((e) => e.type === 'SUB_ACCEPT' && e.payload.kappa_id === k).pop()
  check('V 层在 VException 下可以 SUB', r.ok && r.branch === 'SUB', r)
  check('P6：V 的 SUB_ACCEPT 附 VException 证据 id', acc && (acc.payload.v_exception_ids || (acc.gate_report && acc.gate_report.v_exception_ids) || []).length >= 3, acc)
}

// 跨层半权
{
  const a = mk('V', 'norm', '不透支身体')
  const c = mk('W', 'obs', '连续加班三天')
  put([{ type: 'EDGE_ADD', actor: 'sys', at: tick(), payload: { edges: [{ type: 'CONSTRAINS', from_id: a, to_id: c }] } }])
  put([{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind: 'act', target_type: 'claim', target_id: c, sign: -1, weight: 0.6, ref: 'overwork' }] } }])
  const before = loadState(db, aid).claims[a].n
  const d = deriveCross(db, aid, tick())
  const st = loadState(db, aid)
  const x = readEvents(db, aid).filter((e) => e.type === 'EVIDENCE').pop()
  const derived = (x.payload.evidence || []).find((e) => e.derived_from)
  check('跨层派生一条半权证据', d.did.length >= 1 && st.claims[a].n === before + 1, d)
  check('派生权重 = 0.5·w', derived && Math.abs(derived.weight - 0.3) < 1e-9, derived)
}

// P9
{
  const a = mk('W', 'belt', '甲依赖乙')
  const b = mk('W', 'belt', '乙依赖甲')
  put([{ type: 'EDGE_ADD', actor: 'sys', at: tick(), payload: { edges: [{ type: 'DEPENDS', from_id: a, to_id: b }] } }])
  try {
    put([{ type: 'EDGE_ADD', actor: 'sys', at: tick(), payload: { edges: [{ type: 'DEPENDS', from_id: b, to_id: a }] } }])
    check('P9：DEPENDS 成环拒绝', false)
  } catch (e) {
    check('P9：DEPENDS 成环拒绝', e instanceof SangguanError && /环/.test(e.message), e.message)
  }
}

// P21 + REVIEW_FLAG：CON 挂起 κ 的一极，同批 OBSOLETE；1 跳 DEPENDS 打标
{
  const a = mk('W', 'belt', '规则总被遵守')
  const b = mk('W', 'obs', '规则常被绕开')
  const dep = mk('W', 'belt', '所以不必自己立法')
  put([{ type: 'EDGE_ADD', actor: 'sys', at: tick(), payload: { edges: [{ type: 'DEPENDS', from_id: dep, to_id: a }] } }])
  const k = openK('W', a, b, '规则靠得住吗')
  put([{ type: 'SUSPEND', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: k } }])
  for (let i = 0; i < 3; i++) {
    put([{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind: 'check', target_type: 'claim', target_id: a, sign: -1, weight: 1, ref: 'c' + i }] } }])
  }
  const { conCheck } = await import('../src/modules/sangguan/practice.js')
  const before = lastSeq(db, aid)
  const r = conCheck(db, aid, tick())
  const batch = readEvents(db, aid).filter((e) => e.seq > before)
  check('P21：CON 与 KAPPA_OBSOLETE 同批', r.did.some((d) => d.id === a) && batch.some((e) => e.type === 'CON') && batch.some((e) => e.type === 'KAPPA_OBSOLETE' && e.payload.kappa_id === k), batch.map((e) => e.type))
  check('REVIEW_FLAG 打到 1 跳 DEPENDS 上游', batch.some((e) => e.type === 'REVIEW_FLAG' && e.payload.claim_id === dep) && loadState(db, aid).claims[dep].review >= 1, batch.map((e) => e.type))
  check('P21 不变式：未结 κ 无终态极', checkInvariants(loadState(db, aid)).filter((x) => x.code === 'P21').length === 0)
}

// P23：V 层仅凭 verdict 不能 REV
{
  const P = 'agt_p23'
  setSangguanConfig(db, P, { enabled: true })
  const old = append(db, P, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'V', kind: 'norm', text: '诚实比圆滑更重要', origin: 'extract' }] } }]).entities.claims[0]
  const embed = async (text) => {
    if (text.includes('诚实')) return [1, 0, 0]
    if (text.includes('圆滑优先')) return [0.95, 0.1, 0]
    return [0, 1, 0]
  }
  const chat = fakeChat({
    J1: {
      candidates: [{ layer: 'V', kind: 'norm', text: '圆滑优先于诚实' }],
      evidence: [{ target_id: old, sign: -1, kind: 'verdict', ref_turn: 0 }],
      tradeoffs: [], answers: [],
    },
    J2: { pairs: [{ c_id: old, rel: 'contradict', reason: '对立' }] },
  })
  await runFast({ db, aid: P, at: tick(), chat, embed }, [
    { role: 'user', text: '我觉得不该总说实话' },
    { role: 'assistant', text: '有时圆滑更重要' },
  ])
  const types = readEvents(db, P).map((e) => e.type)
  check('P23：V 层没有仅凭 verdict 的 REV', !types.includes('REV') && (types.includes('KAPPA_CANDIDATE') || types.includes('CLAIM_EXP')), types)
}

// 纯函数 flags
{
  const s = { edges: { e1: { active: 1, type: 'DEPENDS', from_id: 'a', to_id: 'b' } }, claims: { a: { status: 'active' }, b: { status: 'active' } } }
  check('flagsForTerminal 只打 1 跳', flagsForTerminal(s, ['b'], 't').length === 1 && flagsForTerminal(s, ['b'], 't')[0].payload.claim_id === 'a')
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
  const F = 'agt_fuzz8'
  setSangguanConfig(db, F, { enabled: true })
  const bugs = []
  const tally = { night: 0, coex: 0, rej: {} }
  for (let i = 0; i < 45; i++) {
    const s = loadState(db, F)
    const live = Object.values(s.claims).filter((c) => c.layer === 'L' && c.status === 'active')
    const at = tick(12)
    try {
      if (rnd() < 0.4 || live.length < 2) {
        append(db, F, [{ type: 'CLAIM_EXP', layer: 'L', actor: 'sys', at, payload: { claims: [{ layer: 'L', kind: pick(['chapter', 'role']), text: 'fz8-' + i, origin: 'extract' }] } }])
      } else if (rnd() < 0.55) {
        const [x, y] = [pick(live), pick(live)].sort((p, q) => p.born_seq - q.born_seq)
        if (x.id === y.id) continue
        const q = newId('questions', at)
        append(db, F, [{ type: 'KAPPA_OPEN', layer: 'L', actor: 'judge', at, payload: { questions: [{ id: q, layer: 'L', text: 'q' + i }], kappas: [{ layer: 'L', q_id: q, pos_id: x.id, neg_id: y.id, dep: 'd', excl: 'e' }] } }])
      } else if (live.length) {
        append(db, F, [{ type: 'EVIDENCE', actor: 'user', at, payload: { evidence: [{ kind: 'act', target_type: 'claim', target_id: pick(live).id, sign: 1, weight: 0.6, ref: 'f' + i }] } }])
      }
    } catch (e) {
      tally.rej[(e.code || 'X')] = (tally.rej[(e.code || 'X')] || 0) + 1
    }
    if (rnd() < 0.4) {
      const chat = fakeChat({
        J6: { incommensurable: false, parallel_ok: true, loss: { lean_pole: 'pos', cost: '慢一点' } },
        J4: '坏',
      })
      try {
        const r = await runNight(db, F, tick(), { chat, allowCoex: true, allowSub: true })
        tally.night++
        tally.coex += r.did.filter((d) => d.branch === 'COEX').length
      } catch (e) { bugs.push({ i, msg: String(e && e.message) }) }
    }
    const inv = checkInvariants(loadState(db, F))
    if (inv.length) bugs.push({ i, inv: inv.slice(0, 2) })
  }
  check('模糊（种子 ' + SEED + '）：无非预期异常、不变式成立', bugs.length === 0, bugs.slice(0, 3))
  check('模糊：夜间跑过', tally.night > 2, tally)
  const before = JSON.stringify(snapshot(db, F))
  rebuild(db, F)
  check('模糊：P1 重放一致', JSON.stringify(snapshot(db, F)) === before)
  console.log('  模糊覆盖：', JSON.stringify(tally))
}

{
  const src = (f) => fs.readFileSync(new URL('../src/modules/sangguan/' + f, import.meta.url), 'utf8')
  check('I15 gates 仍不读时钟', !/Date\.now\(/.test(src('gates.js')))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
