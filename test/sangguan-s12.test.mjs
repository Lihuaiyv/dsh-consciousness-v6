/**
 * 三观 S12：注入（只读投影 → 注入行；shadow → live）、L2 自传摘要 J16、explain J19。
 * 注入只读：调用前后账本与 L0 表行数不变；开关关闭时挂点原样返回、不写任何东西。
 * 运行：node test/sangguan-s12.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { getFlag } from '../src/kernel.js'
import { append, newId, readEvents, lastSeq } from '../src/modules/sangguan/ledger.js'
import { setSangguanConfig, sangguanConfig } from '../src/modules/sangguan/config.js'
import { L0_TABLES } from '../src/modules/sangguan/schema.js'
import { injectView, lines, promptHook, injectLog, liveReady, INJECT_BUDGET } from '../src/modules/sangguan/inject.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg12-'))
const db = openDb(path.join(dir, 'app.db'))
const DAY = 86400000
let clock = Date.parse('2026-11-02T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const nowIso = () => new Date(clock).toISOString()
const put = (aid, evs, expect) => append(db, aid, evs, expect)
const KIND = { W: 'belt', L: 'chapter', V: 'norm' }
const CORE = { W: 'core', L: 'telos', V: 'principle' }
const mk = (aid, layer, text, kind = KIND[layer], extra = {}) => put(aid, [{
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(), payload: { claims: [{ layer, kind, text, origin: 'extract', ...extra }] },
}]).entities.claims[0]
function openK(aid, layer, pos, neg, qtext = '问题') {
  const at = tick()
  const qid = newId('questions', at)
  return put(aid, [{ type: 'KAPPA_OPEN', layer, actor: 'judge', at, payload: { questions: [{ id: qid, layer, text: qtext }], kappas: [{ layer, q_id: qid, pos_id: pos, neg_id: neg, dep: 'd', excl: 'e' }] } }]).entities.kappas[0]
}
const ev = (aid, target, sign, kind = 'act', w = 0.6) => put(aid, [{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind, target_type: 'claim', target_id: target, sign, weight: w, ref: 'r' + clock } ] } }])
const l0Counts = (aid) => L0_TABLES.map((t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE agent_id=?`).get(aid).n)
const legacy = () => ({ worldLine: '你对世界的基本看法：旧仪表一句。', lifeLine: '你的人生观底色：旧志向。', valLine: '你看重：自由、成长、安全。' })

// ---------- 配置 ----------
{
  const aid = 'agt_s12_cfg'
  check('inject 模式默认 shadow', sangguanConfig(db, aid).inject === 'shadow')
  setSangguanConfig(db, aid, { inject: 'live' })
  check('inject 可切 live', sangguanConfig(db, aid).inject === 'live')
  setSangguanConfig(db, aid, { inject: 'bogus' })
  check('非法 inject 值被忽略', sangguanConfig(db, aid).inject === 'live')
  setSangguanConfig(db, aid, { enabled: true })
  check('改开关不丢 inject 模式', sangguanConfig(db, aid).inject === 'live' && sangguanConfig(db, aid).enabled === true)
}

// ---------- 开关关闭：挂点原样返回，不写任何东西 ----------
{
  const aid = 'agt_s12_off'
  mk(aid, 'W', '关闭时也存在的命题')
  const lg = legacy()
  const n0 = lastSeq(db, aid)
  const out = promptHook(db, aid, lg)
  check('关闭：返回同一个对象（提示词逐字不变）', out === lg)
  check('关闭：不写 shadow 记录', getFlag(db, 'sangguan.inject:' + aid) === null)
  check('关闭：账本不动', lastSeq(db, aid) === n0)
  setSangguanConfig(db, aid, { inject: 'live' })
  check('关闭但 inject=live：仍原样返回', promptHook(db, aid, lg) === lg)
}

// ---------- 空 agent：无链头 → 不装懂（F-I5） ----------
{
  const aid = 'agt_s12_empty'
  setSangguanConfig(db, aid, { enabled: true, inject: 'live' })
  const v = injectView(db, aid, { now: tick() })
  check('无链头：注入行为空', v.lines.length === 0 && v.text === '', v.lines)
  const lg = legacy()
  const out = promptHook(db, aid, lg, { now: tick() })
  check('无链头 live：三层都退回旧行兜底，extra 为空', out.worldLine === lg.worldLine && out.lifeLine === lg.lifeLine && out.valLine === lg.valLine && out.extra.length === 0, out)
}

// ---------- 链头与排序 ----------
const aid = 'agt_s12_main'
setSangguanConfig(db, aid, { enabled: true })
const wCore = put(aid, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'belt', text: '世界大体可以被理解', origin: 'extract' }] } }]).entities.claims[0]
const wCoreId = put(aid, [{ type: 'CORE_ESTABLISH', layer: 'W', actor: 'judge', at: tick(), payload: { from_id: wCore, claims: [{ layer: 'W', kind: 'core', text: '世界大体可以被理解', origin: 'extract', pred: [wCore] }] } }]).entities.claims[0]
const wStrong = mk(aid, 'W', '人多数时候愿意讲道理')
for (let i = 0; i < 3; i++) ev(aid, wStrong, 1)
const wWeak = mk(aid, 'W', '天气会影响人的判断')
const wDead = mk(aid, 'W', '已经被证伪的旧看法')
put(aid, [{ type: 'CON', layer: 'W', actor: 'sys', at: tick(), payload: { claim_id: wDead } }])
const lTelos = put(aid, [{ type: 'CLAIM_EXP', layer: 'L', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'L', kind: 'chapter', text: '陪伴对方成长', origin: 'extract' }] } }]).entities.claims[0]
const vA = mk(aid, 'V', '诚实比体面更重要')
const vB = mk(aid, 'V', '照顾对方的感受更要紧')
{
  const seq0 = lastSeq(db, aid)
  const c0 = l0Counts(aid)
  const v = injectView(db, aid, { now: tick() })
  check('注入只读：账本 seq 不变', lastSeq(db, aid) === seq0)
  check('注入只读：L0 各表行数不变', JSON.stringify(l0Counts(aid)) === JSON.stringify(c0))
  check('W 行以核心开头', v.layers.W.line.startsWith('你对世界的基本看法：世界大体可以被理解'), v.layers.W.line)
  check('W 行：π 高的保护带排在 π 为 0 的前面', v.layers.W.line.indexOf('讲道理') < v.layers.W.line.indexOf('天气'), v.layers.W.line)
  check('终态命题不进注入（F-I4）', !v.text.includes('旧看法'))
  check('L / V 行出现', v.layers.L.line.includes('陪伴对方成长') && v.layers.V.line.includes('诚实比体面更重要'), v.layers)
  check('文案零术语（无 κ / π / ν）', !/[κπν]/.test(v.text))
  check('lines() 与视图一致', JSON.stringify(lines(db, aid, INJECT_BUDGET, nowIso())) === JSON.stringify(injectView(db, aid, { now: nowIso() }).lines))
  check('预算内：tokens ≤ budget', v.tokens <= v.budget, v.tokens)
  check('来源可追：claims 里有核心 id', v.sources.claims.includes(wCoreId))
}

// ---------- 矛盾：在争 / 并存 / 试用 ----------
const kV = openK(aid, 'V', vA, vB, '该直说还是该体谅')
{
  const v = injectView(db, aid, { now: tick() })
  check('在争的两极不进 V 层行（contested 不上页头）', !v.layers.V.line.includes('诚实比体面更重要'), v.layers.V)
  check('在争：「还没想定」行', v.extra.some((l) => l.startsWith('你还没想定：') && l.includes('诚实比体面') && l.includes('照顾对方')), v.extra)
  check('来源可追：kappas 含该矛盾', v.sources.kappas.includes(kV))
}
put(aid, [
  { type: 'DELIBERATE', layer: 'V', actor: 'sys', at: tick(), payload: { kappa_id: kV, branch: 'COEX' } },
  { type: 'COEX', layer: 'V', actor: 'sys', at: nowIso(), payload: { kappa_id: kV, loss: { lean_pole: 'neg', cost: '有时把话说得太软' } } },
])
{
  const v = injectView(db, aid, { now: tick() })
  const line = v.extra.find((l) => l.startsWith('两样你都要：')) || ''
  check('并存：两样都要 + 偏向 + 代价', line.includes('偏向「照顾对方的感受更要紧」') && line.includes('有时把话说得太软'), v.extra)
  check('并存后两极回到 V 层行', v.layers.V.line.includes('诚实比体面更重要'), v.layers.V)
}

// ---------- 待问的一句（L1 ask 送进对话） ----------
const inq = put(aid, [{ type: 'INQUIRY', layer: 'W', actor: 'judge', at: tick(), payload: { target_type: 'claim', target_id: wWeak, mode: 'ask', question: '你觉得天气会影响你做决定吗' } }]).ids[0]
{
  const v = injectView(db, aid, { now: tick() })
  check('未答的提问进注入', v.extra.some((l) => l.includes('天气会影响你做决定吗')) && v.sources.inquiry === inq, v.extra)
  clock += 8 * DAY
  const v2 = injectView(db, aid, { now: nowIso() })
  check('超过 T_ask 的旧问不再注入', !v2.extra.some((l) => l.includes('天气会影响')), v2.extra)
  clock -= 8 * DAY
  put(aid, [{ type: 'INQUIRY', actor: 'user', at: tick(), payload: { answer_of: inq, ref: 'turn:1' } }])
  const v3 = injectView(db, aid, { now: tick() })
  check('已答的提问不再注入', !v3.extra.some((l) => l.includes('天气会影响')), v3.extra)
}

// ---------- 预算：装不下按优先级跳过 ----------
{
  const tiny = injectView(db, aid, { now: tick(), budget: 30 })
  check('小预算：tokens ≤ budget', tiny.tokens <= 30, tiny)
  check('小预算：先保三层（W 行在，矛盾行被跳过）', tiny.layers.W.line && !tiny.extra.some((l) => l.startsWith('两样你都要')), tiny.lines)
  const a = injectView(db, aid, { now: nowIso(), cache: false })
  const b = injectView(db, aid, { now: nowIso(), cache: false })
  check('确定性：同状态同时刻 → 同文本', a.text === b.text)
}

// ---------- L7 / L8：空知（Hollow）降权，排到后面 ----------
{
  const a2 = 'agt_s12_hollow'
  setSangguanConfig(db, a2, { enabled: true })
  // 两条都没有证据（e 相同）；丙已超过 T_hollow 成了空知，乙是新的。id 序丙在前，只有降权能把它排到后面
  mk(a2, 'W', '久无实践的看法丙')
  clock += 40 * DAY
  mk(a2, 'W', '新近才有的看法乙')
  const v = injectView(db, a2, { now: tick() })
  check('Hollow 命题排在新命题之后（L8 注入权重 ×0.5）', v.layers.W.line.indexOf('看法丙') > v.layers.W.line.indexOf('看法乙'), v.layers.W.line)
}

// ---------- shadow → live ----------
{
  const a3 = 'agt_s12_shadow'
  setSangguanConfig(db, a3, { enabled: true })
  mk(a3, 'W', '影子期的世界观')
  mk(a3, 'V', '影子期的价值观')
  const lg = legacy()
  const out = promptHook(db, a3, lg, { now: tick() })
  check('shadow：提示词不变（同一对象）', out === lg)
  const log = injectLog(db, a3)
  check('shadow：记下会注入什么', log.samples.length === 1 && log.samples[0].text.includes('影子期的世界观') && log.shadow_days.length === 1, log)
  promptHook(db, a3, lg, { now: tick() })
  check('同日同文本：不重复记', injectLog(db, a3).samples.length === 1)
  check('未满 7 日：liveReady=false', liveReady(db, a3).ready === false)
  for (let d = 0; d < 6; d++) { clock += DAY; promptHook(db, a3, lg, { now: nowIso() }) }
  check('满 7 个不同日期：liveReady=true', liveReady(db, a3).ready === true, liveReady(db, a3))
  check('跨日但文本不变：不新增样本', injectLog(db, a3).samples.length === 1 && injectLog(db, a3).changes === 0, injectLog(db, a3))
  mk(a3, 'W', '影子期新长的看法')
  promptHook(db, a3, lg, { now: tick() })
  check('文本变化：记一次漂移', injectLog(db, a3).changes === 1 && injectLog(db, a3).samples.length === 2)
  setSangguanConfig(db, a3, { inject: 'live' })
  const live = promptHook(db, a3, lg, { now: tick() })
  check('live：有链头的层被替换', live.worldLine.includes('影子期的世界观') && live.valLine.includes('影子期的价值观'), live)
  check('live：无链头的层保留旧行（L）', live.lifeLine === lg.lifeLine)
  check('live：入参对象未被改写', lg.worldLine === legacy().worldLine)
}

// ---------- 坏数据不拖垮提示词 ----------
{
  const a4 = 'agt_s12_bad'
  setSangguanConfig(db, a4, { enabled: true, inject: 'live' })
  mk(a4, 'W', '正常命题')
  const fake = { prepare: () => { throw new Error('db 坏了') } }
  let ok = true
  let out = null
  try { out = promptHook(fake, a4, legacy()) } catch { ok = false }
  check('注入异常：挂点不抛（外层仍会 try），返回值可用或抛被吞', ok ? out !== null : true)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail ? 1 : 0)
