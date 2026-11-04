/**
 * 三观 · 三列各自的闸（W 预测力 / L 解释力+投入 / V 排除+代价）与分派开关。
 * 运行：node test/sangguan-lanes-gate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { laneCheck, fieldCheck, gateW, gateL, gateV, investSpanDays } from '../src/modules/sangguan/gates.js'
import { classify } from '../src/modules/sangguan/gates.js'
import { sangguanConfig, setSangguanConfig, laneOn, SANGGUAN_DEFAULTS } from '../src/modules/sangguan/config.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// ---------- 分派：默认全关时与旧 fieldCheck 等价 ----------
const wNoMeta = { layer: 'W', kind: 'belt', text: '人难受的时候多数不是要答案', boundary: [], meta: {} }
check('默认关：W 无预期也放行', laneCheck(wNoMeta) === null && fieldCheck(wNoMeta) === null)
check('默认关：laneCheck 与 fieldCheck 同结论', ['W', 'L', 'V'].every((l) => laneCheck({ ...wNoMeta, layer: l }) === fieldCheck({ ...wNoMeta, layer: l })))

// ---------- W：预测力 ----------
check('W：缺预期被拒', gateW(wNoMeta) === 'no_expectation')
check('W：缺观察被拒', gateW({ meta: { expectation: '他会沉默' } }) === 'no_observe')
check('W：预期在说自己被拒', gateW({
  meta: { expectation: '我下次会先听完', observe: '我先听完', scene: ['a', 'b', 'c'] },
}) === 'expectation_about_self')
check('W：场景不足 3 个被拒', gateW({
  meta: { expectation: '他会沉默', observe: '他沉默', scene: ['你说难受时', '你说累时'] },
}) === 'scene_too_few')
check('W：工程场景占多数被拒', gateW({
  meta: { expectation: '他会沉默', observe: '他沉默', scene: ['接口报错时', '部署失败时', '你说难受时'] },
}) === 'engineering_scene')

const goodW = {
  layer: 'W', kind: 'belt', text: '人难受的时候多数不是要答案',
  meta: {
    expectation: '你倒苦水时我先给方案，你会更冷', observe: '你说完难受，我给了方案，你隔很久只回一个字',
    scene: ['你说难受的时候', '你说累的时候', '你半夜说睡不着的时候'],
  },
}
check('W：合格放行', gateW(goodW) === null)
check('W：分派后放行', laneCheck(goodW, { W: true }) === null)
const out = classify(goodW, [], null, { judge: 'ok', lanes: { W: true }, theta_dup: 0.9, theta_dup_lex: 0.4 })
check('W：分类为 EXP（无邻居）', out.cls === 'EXP', out)
const rej = classify(wNoMeta, [], null, { judge: 'ok', lanes: { W: true }, theta_dup: 0.9, theta_dup_lex: 0.4 })
check('W：关着放行、开着拒收', rej.cls === 'REJECT' && rej.report.reason === 'no_expectation', rej.report)
const rejOff = classify(wNoMeta, [], null, { judge: 'ok', lanes: {}, theta_dup: 0.9, theta_dup_lex: 0.4 })
check('W：默认关时同一句照常入账', rejOff.cls === 'EXP', rejOff)

// ---------- L：解释力 + 投入 ----------
check('L：缺方向被拒', gateL({ meta: { investment: [] } }) === 'no_direction')
check('L：只有一条投入被拒', gateL({
  meta: { direction: '做能把话接住的人', investment: [{ ref: 'act:1', at: '2026-11-01T00:00:00.000Z' }] },
}) === 'no_investment')
check('L：跨度不足 7 天被拒', gateL({
  meta: { direction: '做能把话接住的人', investment: [
    { ref: 'act:1', at: '2026-11-01T00:00:00.000Z' }, { ref: 'act:2', at: '2026-11-04T00:00:00.000Z' },
  ] },
}) === 'no_investment')
const goodL = {
  layer: 'L', kind: 'chapter', text: '我想做能把话接住的人',
  meta: { direction: '做能把话接住的人', investment: [
    { ref: 'act:1', at: '2026-11-01T00:00:00.000Z' }, { ref: 'act:2', at: '2026-11-09T00:00:00.000Z' },
  ] },
}
check('L：合格放行', gateL(goodL) === null)
check('L：跨度算得对', Math.round(investSpanDays(goodL.meta.investment)) === 8)

// ---------- V：排除 + 代价 ----------
check('V：没有取舍词被拒', gateV({ text: '世界大体是有回应的', meta: {} }) === 'no_tradeoff')
check('V：正文有取舍词放行', gateV({ text: '我宁可慢一点也不交假数据', meta: {} }) === null)
check('V：meta 有 foregone 放行', gateV({ text: '数据不对就重跑', meta: { foregone: '两天时间' } }) === null)

// ---------- 不串列 ----------
const wCand = { ...goodW, meta: {} }
check('不串列：W 的候选过 L 闸也按 W 判', laneCheck({ ...wCand, layer: 'W' }, { L: true }) !== 'no_direction')
check('不串列：L 的候选过 W 闸也按 L 判', laneCheck({ layer: 'L', kind: 'chapter', text: '我想做能把话接住的人', meta: {} }, { W: true }) !== 'no_expectation')

// ---------- 配置开关 ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sglane-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sglane'
check('配置：默认三列全关', JSON.stringify(sangguanConfig(db, aid).lanes) === JSON.stringify({ W: false, L: false, V: false }))
check('配置：默认不打开', laneOn(db, aid, 'W') === false)
setSangguanConfig(db, aid, { lanes: { W: true } })
check('配置：只开 W', laneOn(db, aid, 'W') === true && laneOn(db, aid, 'L') === false && laneOn(db, aid, 'V') === false)
setSangguanConfig(db, aid, { lanes: { W: 'yes', L: 1 } })
check('配置：非布尔值不算开（失败即关）', laneOn(db, aid, 'W') === false && laneOn(db, aid, 'L') === false)
setSangguanConfig(db, aid, { lanes: { W: true } })
check('配置：关掉后还能再开', laneOn(db, aid, 'W') === true)
setSangguanConfig(db, aid, { lanes: { W: false } })
check('配置：能关回去', laneOn(db, aid, 'W') === false)
check('配置：默认值冻结', Object.isFrozen(SANGGUAN_DEFAULTS.lanes))

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
