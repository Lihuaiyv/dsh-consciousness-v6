/**
 * 三观 S3：模型调用层与独立预算。
 * 模板注册、手写校验器、1 次修复重试、判定缓存、判定健康度；预算池、降级阶梯、保底、月顶、结转；与记忆预算互不挤占。
 * 全部离线：模型由假 LLM 按模板 id 回放。
 * 运行：node test/sangguan-s3.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { llmBudgetBump, llmBudgetAllow, llmBudgetSnapshot } from '../src/modules/llm_budget.js'
import { sangguanConfig, setSangguanConfig } from '../src/modules/sangguan/config.js'
import { UNITS, grant, noteTokens, budgetSnapshot, isoWeek } from '../src/modules/sangguan/budget.js'
import {
  registerTemplate, getTemplate, validate, parseLoose, pairKey, cacheGet, cachePut, call,
  recordJudge, judgeHealth, routeOf,
} from '../src/modules/sangguan/llm.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg3-'))
const db = openDb(path.join(dir, 'app.db'))
const D1 = '2026-11-02'
const D2 = '2026-11-03'
const D3 = '2026-11-04'

// ======================= 配置 =======================
{
  const aid = 'agt_cfg'
  const c = sangguanConfig(db, aid)
  check('配置默认：开关关、预算池按 §3.2', c.enabled === false && c.budget.fast === 20 && c.budget.mid === 30 && c.budget.reserve === 6
    && c.budget.slow_week === 40 && c.budget.floor === 2 && c.budget.carry === 1.5 && c.budget.monthly_tokens > 0, c)
  check('配置默认：两档模型都走宿主', c.model.light === null && c.model.heavy === null)
  setSangguanConfig(db, aid, { budget: { fast: 10, mid: -3, bogus: 9 } })
  const c2 = sangguanConfig(db, aid)
  check('预算配置：合法值生效、非法值忽略、未知键丢弃', c2.budget.fast === 10 && c2.budget.mid === 30 && c2.budget.bogus === undefined, c2.budget)
  setSangguanConfig(db, aid, { model: { light: { url: 'http://127.0.0.1:1234/v1', model: 'small' } } })
  check('模型配置：轻档可指向独立端点', sangguanConfig(db, aid).model.light.url === 'http://127.0.0.1:1234/v1')
  setSangguanConfig(db, aid, { model: { heavy: { url: 'ftp://x' } } })
  check('模型配置：非 http 端点被忽略', sangguanConfig(db, aid).model.heavy === null)
  setSangguanConfig(db, aid, { enabled: true })
  check('改开关不丢预算与模型配置', sangguanConfig(db, aid).budget.fast === 10 && sangguanConfig(db, aid).model.light !== null)
  const cfg = sangguanConfig(db, aid)
  check('路由：T1 走轻档端点', routeOf(cfg, 'T1').url === 'http://127.0.0.1:1234/v1')
  check('路由：T2 未配重档 → 宿主', routeOf(cfg, 'T2') === 'host')
  check('路由：辩证会按重档', routeOf(cfg, 'DIAL') === 'host')
}

// ======================= 校验器 =======================
const SCHEMA = {
  type: 'object',
  required: ['answer', 'score'],
  props: {
    answer: { type: 'string', max: 20 },
    score: { type: 'number', min: 0, max: 1 },
    sign: { type: 'number', enum: [1, -1] },
    tags: { type: 'array', items: { type: 'string' }, max: 3, default: [] },
    note: { type: 'string', nullable: true },
    sub: { type: 'object', props: { ok: { type: 'boolean' } }, required: ['ok'] },
  },
}
{
  const r = validate(SCHEMA, { answer: ' 好 ', score: 0.5, extra: 1 })
  check('校验：合法 → 清洗（去空白、补默认、丢多余字段）', r.ok && same(r.value, { answer: '好', score: 0.5, tags: [] }), r)
  check('校验：缺必填字段', !validate(SCHEMA, { answer: 'a' }).ok)
  check('校验：类型错误', !validate(SCHEMA, { answer: 1, score: 0.5 }).ok)
  check('校验：数值越界', !validate(SCHEMA, { answer: 'a', score: 1.5 }).ok)
  check('校验：枚举', !validate(SCHEMA, { answer: 'a', score: 0.5, sign: 0 }).ok && validate(SCHEMA, { answer: 'a', score: 0.5, sign: -1 }).ok)
  check('校验：数组超长', !validate(SCHEMA, { answer: 'a', score: 0.5, tags: ['1', '2', '3', '4'] }).ok)
  check('校验：字符串超长', !validate(SCHEMA, { answer: 'x'.repeat(21), score: 0.5 }).ok)
  check('校验：nullable', validate(SCHEMA, { answer: 'a', score: 0.5, note: null }).ok && !validate(SCHEMA, { answer: 'a', score: 0.5, answer2: 1, tags: null }).ok)
  check('校验：嵌套对象缺字段', !validate(SCHEMA, { answer: 'a', score: 0.5, sub: {} }).ok)
  check('校验：NaN / Infinity 不算数', !validate(SCHEMA, { answer: 'a', score: NaN }).ok && !validate(SCHEMA, { answer: 'a', score: Infinity }).ok)
  const e = validate(SCHEMA, { score: 'x' })
  check('校验：错误带字段路径', e.errors.some((m) => m.includes('answer')) && e.errors.some((m) => m.includes('score')), e.errors)
  check('宽松解析：代码块 / 前后有字', same(parseLoose('```json\n{"a":1}\n```'), { a: 1 }) && same(parseLoose('好的：{"a":2} 完'), { a: 2 }) && parseLoose('不是 json') === null)
}

// ======================= 模板注册 =======================
registerTemplate({
  id: 'T_ECHO', version: 1, tier: 'T1', pool: 'fast', temperature: 0, max_tokens: 200, judge: true,
  system: '测试模板', build: (input) => '输入：' + JSON.stringify(input), schema: SCHEMA,
  cacheKey: (input) => [input.q],
})
registerTemplate({
  id: 'T_DRAFT', version: 1, tier: 'T2', pool: 'mid', temperature: 0.4, max_tokens: 400,
  system: '起草', build: (input) => String(input.text), schema: SCHEMA,
})
{
  let threw = false
  try { registerTemplate({ id: 'T_ECHO', version: 1, tier: 'T1', system: 'x', build: () => '', schema: SCHEMA }) } catch { threw = true }
  check('模板：同 id@版本 不能重复注册', threw)
  let bad = false
  try { registerTemplate({ id: 'T_BAD', version: 1, tier: 'T9', system: 'x', build: () => '', schema: SCHEMA }) } catch { bad = true }
  check('模板：非法档位拒绝注册', bad)
  check('模板：可按 id 取到', getTemplate('T_ECHO').version === 1 && getTemplate('NOPE') === undefined)
  check('成对缓存 key 与顺序无关', pairKey('J2@1', 'a', 'b') === pairKey('J2@1', 'b', 'a'))
  check('成对缓存 key 随模板版本变化', pairKey('J2@1', 'a', 'b') !== pairKey('J2@2', 'a', 'b'))
  cachePut(db, 'k1', 'T@1', { x: 1 }, '2026-11-02T00:00:00.000Z')
  cachePut(db, 'k1', 'T@1', { x: 2 }, '2026-11-02T00:00:00.000Z')
  check('缓存：先写者为准，读回一致', same(cacheGet(db, 'k1'), { x: 1 }) && cacheGet(db, 'k_none') === null)
}

// ======================= llm.call =======================
const ctxOf = (aid, chat, extra = {}) => ({ db, aid, day: D1, at: D1 + 'T10:00:00.000Z', chat, ...extra })
{
  const aid = 'agt_call'
  const chat = fakeChat({ T_ECHO: { answer: '好', score: 0.5, extra: 1 } })
  const r = await call(ctxOf(aid, chat), 'T_ECHO', { q: '一' })
  check('call：合法输出 → ok 且已清洗', r.ok && same(r.out, { answer: '好', score: 0.5, tags: [] }) && !r.cached, r)
  check('call：按模板档位扣预算', r.units === 1 && budgetSnapshot(db, aid, D1).pools.fast.used === 1)
  check('call：记 token 估算', budgetSnapshot(db, aid, D1).tokens.day > 0)
  check('call：温度与 json 模式按模板传入', chat.calls[0].temperature === 0 && chat.calls[0].json === true && chat.calls[0].tier === 'T1')
  const r2 = await call(ctxOf(aid, chat), 'T_ECHO', { q: '一' })
  check('call：同输入命中缓存，不调模型、不扣预算', r2.ok && r2.cached && chat.count() === 1 && budgetSnapshot(db, aid, D1).pools.fast.used === 1, r2)
  const r3 = await call(ctxOf(aid, chat), 'T_ECHO', { q: '一' }, { cache: false })
  check('call：可显式绕过缓存', r3.ok && !r3.cached && chat.count() === 2)
}
{
  const aid = 'agt_repair'
  const chat = fakeChat({ T_ECHO: ['这不是 JSON', { answer: '修好了', score: 0.2 }] })
  const r = await call(ctxOf(aid, chat), 'T_ECHO', { q: '二' })
  check('修复重试：第一次坏、第二次好 → ok', r.ok && r.repaired && r.out.answer === '修好了', r)
  check('修复重试：第二次请求带上错误说明', chat.calls[1].repair && JSON.stringify(chat.calls[1].messages).includes('不符合'))
  check('修复重试：第二次调用另扣一份预算', budgetSnapshot(db, aid, D1).pools.fast.used === 2 && r.units === 2)
}
{
  const aid = 'agt_schema'
  const chat = fakeChat({ T_ECHO: ['坏', '{"answer":1}'] })
  const r = await call(ctxOf(aid, chat), 'T_ECHO', { q: '三' })
  check('两次都不合格 → SCHEMA 失败（保守失败）', !r.ok && r.code === 'SCHEMA' && chat.count() === 2, r)
  check('失败结果不进缓存', (await call(ctxOf(aid, fakeChat({ T_ECHO: { answer: 'ok', score: 1 } })), 'T_ECHO', { q: '三' })).cached === false)
  check('判定失败计入健康度', judgeHealth(db, aid, Date.parse(D1 + 'T10:00:00.000Z')).calls === 2)
}
{
  const aid = 'agt_throw'
  const r = await call(ctxOf(aid, fakeChat({ T_ECHO: new Error('超时') })), 'T_ECHO', { q: '四' })
  check('模型抛错 → CALL 失败，不抛出', !r.ok && r.code === 'CALL' && /超时/.test(r.error), r)
  const r2 = await call(ctxOf(aid, null), 'T_ECHO', { q: '五' })
  check('没有可用模型 → CALL 失败，不抛出', !r2.ok && r2.code === 'CALL', r2)
  const r3 = await call(ctxOf(aid, fakeChat({})), 'NOPE', {})
  check('未知模板 → TEMPLATE 失败', !r3.ok && r3.code === 'TEMPLATE')
}
{
  const aid = 'agt_nobudget'
  setSangguanConfig(db, aid, { budget: { fast: 0 } })
  const chat = fakeChat({ T_ECHO: { answer: 'x', score: 1 } })
  const r = await call(ctxOf(aid, chat), 'T_ECHO', { q: '六' })
  check('没预算 → BUDGET（推迟，不是失败），不调模型', !r.ok && r.code === 'BUDGET' && chat.count() === 0, r)
  check('没预算不计入判定健康度', judgeHealth(db, aid, Date.parse(D1 + 'T10:00:00.000Z')).calls === 0)
}

// ======================= 判定健康度（§12 判定不可用） =======================
{
  const aid = 'agt_health'
  const t0 = Date.parse(D1 + 'T00:00:00.000Z')
  for (let i = 0; i < 3; i++) recordJudge(db, aid, t0 + i * 1000, false)
  check('健康度：3 次失败不足 4 次 → 不降级', !judgeHealth(db, aid, t0 + 5000).degraded)
  recordJudge(db, aid, t0 + 4000, false)
  check('健康度：24h 内 ≥4 次且失败率 >50% → 降级', judgeHealth(db, aid, t0 + 5000).degraded)
  check('健康度：超过 24h 的记录不算', !judgeHealth(db, aid, t0 + 25 * 3600000).degraded)
  const aid2 = 'agt_health2'
  recordJudge(db, aid2, t0, true); recordJudge(db, aid2, t0, true); recordJudge(db, aid2, t0, false); recordJudge(db, aid2, t0, false)
  check('健康度：失败率恰为 50% 不降级', !judgeHealth(db, aid2, t0).degraded)
  recordJudge(db, aid2, t0, false)
  check('健康度：失败率超过 50% 降级', judgeHealth(db, aid2, t0).degraded)
}

// ======================= 预算池与降级阶梯（§3.2） =======================
check('档位单位：T1=1、T2=4、辩证会=8', UNITS.T1 === 1 && UNITS.T2 === 4 && UNITS.DIAL === 8)
check('ISO 周：周日归上一周', isoWeek('2026-11-01') === '2026-W44' && isoWeek('2026-11-02') === '2026-W45' && isoWeek('2027-01-01') === '2026-W53')
{
  const aid = 'agt_fast'
  let n = 0
  while (grant(db, aid, { tier: 'T1', pool: 'fast', day: D1 }).ok) n++
  check('快环池：日额 20，用完即拒', n === 20, n)
  const s = budgetSnapshot(db, aid, D1)
  check('快环池：快照一致', s.pools.fast.used === 20 && s.pools.fast.left === 0)
  check('快环池：用尽不影响其他池', grant(db, aid, { tier: 'T1', pool: 'mid', day: D1 }).ok)
}
{
  const aid = 'agt_ladder'
  const g = (tier, extra = {}) => grant(db, aid, { tier, pool: 'mid', day: D1, ...extra })
  const a = g('T2')
  check('阶梯 r≥0.5：按请求档位', a.ok && a.tier === 'T2' && a.units === 4)
  g('T2'); g('T2'); g('T2') // 用 16 / 28
  const b = g('T2')
  check('阶梯 0.2≤r<0.5：起草降一级（T2→T1）', b.ok && b.tier === 'T1' && b.units === 1, b)
  const c = g('DIAL')
  check('阶梯 0.2≤r<0.5：辩证会降为 T2', c.ok && c.tier === 'T2' && c.units === 4, c)
  const j = g('T1', { judge: true })
  check('阶梯：判官调用不降档', j.ok && j.tier === 'T1')
  g('T1') // 23 / 28，r < 0.2
  const d = g('T1')
  check('阶梯 r<0.2：中环非保底请求被拒', !d.ok && d.reason === 'low', d)
  const f1 = g('T1', { floor: true })
  const f2 = g('T1', { floor: true })
  const f3 = g('T1', { floor: true })
  check('保底：每日 2 单位给最高优先级审议', f1.ok && f1.via === 'floor' && f2.ok && !f3.ok, [f1, f2, f3])
  const fa = 'agt_floor_fast'
  while (grant(db, fa, { tier: 'T1', pool: 'fast', day: D1 }).ok) { /* 用尽快环池 */ }
  check('保底：只给中环', !grant(db, fa, { tier: 'T1', pool: 'fast', day: D1, floor: true }).ok)
}
{
  const aid = 'agt_low_fast'
  for (let i = 0; i < 17; i++) grant(db, aid, { tier: 'T1', pool: 'fast', day: D1 })
  check('阶梯 r<0.2：快环分类（T1）仍可做', grant(db, aid, { tier: 'T1', pool: 'fast', day: D1 }).ok)
  check('阶梯 r<0.2：快环 T2 被拒', !grant(db, aid, { tier: 'T2', pool: 'fast', day: D1 }).ok)
}
{
  const aid = 'agt_month'
  setSangguanConfig(db, aid, { budget: { monthly_tokens: 1000 } })
  noteTokens(db, aid, D1, 1000)
  const r = grant(db, aid, { tier: 'T1', pool: 'fast', day: D2 })
  check('月度硬顶：达到后普通请求被拒', !r.ok && r.reason === 'monthly', r)
  check('月度硬顶：保底不受限', grant(db, aid, { tier: 'T1', pool: 'mid', day: D2, floor: true }).ok)
  check('月度硬顶：下个月恢复', grant(db, aid, { tier: 'T1', pool: 'fast', day: '2026-12-01' }).ok)
}
{
  const a = 'agt_carry_a'
  for (let i = 0; i < 5; i++) grant(db, a, { tier: 'T1', pool: 'fast', day: D1 })
  check('结转：剩余 15 → 次日上限 1.5 倍 = 30', budgetSnapshot(db, a, D2).pools.fast.avail === 30, budgetSnapshot(db, a, D2).pools.fast)
  const b = 'agt_carry_b'
  for (let i = 0; i < 18; i++) grant(db, b, { tier: 'T1', pool: 'fast', day: D1 })
  check('结转：剩余 2 → 次日 22', budgetSnapshot(db, b, D2).pools.fast.avail === 22)
  check('结转：只看前一日，隔日未用继续滚到上限', budgetSnapshot(db, b, D3).pools.fast.avail === 30)
}
{
  const aid = 'agt_slow'
  let n = 0
  while (grant(db, aid, { tier: 'T1', pool: 'slow', day: D1 }).ok) n++
  check('慢环池：按周计，r<0.2 后停', n === 33, n)
  check('慢环池：同周换日仍不可用', !grant(db, aid, { tier: 'T1', pool: 'slow', day: '2026-11-08' }).ok)
  check('慢环池：下周恢复', grant(db, aid, { tier: 'T1', pool: 'slow', day: '2026-11-09' }).ok)
}
{
  const aid = 'agt_reserve'
  let n = 0
  while (grant(db, aid, { tier: 'T1', pool: 'reserve', day: D1 }).ok) n++
  check('保留池：日额 6（按阶梯 r<0.2 前可用）', n >= 4 && n <= 6, n)
  check('未知池 / 未知档位拒绝', !grant(db, aid, { tier: 'T1', pool: 'nope', day: D1 }).ok && !grant(db, aid, { tier: 'T9', pool: 'fast', day: D1 }).ok)
}

// ======================= 与记忆预算互不挤占 =======================
{
  const aid = 'agt_indep'
  llmBudgetBump(db, aid, 'extract', D1, 64)
  check('记忆预算用尽', !llmBudgetAllow(db, aid, D1, 1).ok || llmBudgetSnapshot(db, aid, D1).cap === 0)
  check('三观预算不受记忆预算影响', grant(db, aid, { tier: 'T1', pool: 'fast', day: D1 }).ok)
  const before = llmBudgetSnapshot(db, aid, D1).used
  for (let i = 0; i < 5; i++) grant(db, aid, { tier: 'T1', pool: 'fast', day: D1 })
  noteTokens(db, aid, D1, 5000)
  check('三观调用不计入记忆预算', llmBudgetSnapshot(db, aid, D1).used === before)
}

// ======================= 模糊模拟：随机申请下预算不变式 =======================
{
  const SEED = Number(process.env.SG_SEED || 7)
  let s = SEED >>> 0
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const aid = 'agt_fuzz'
  setSangguanConfig(db, aid, { budget: { monthly_tokens: 40000 } })
  const bad = []
  let day = Date.parse('2026-11-02T00:00:00.000Z')
  let granted = 0
  let floorHits = 0
  for (let i = 0; i < 3000; i++) {
    if (rnd() < 0.02) day += (1 + Math.floor(rnd() * 3)) * 86400000
    const d = new Date(day).toISOString().slice(0, 10)
    const g = grant(db, aid, { tier: pick(['T1', 'T1', 'T2', 'DIAL']), pool: pick(['fast', 'mid', 'reserve', 'slow']), day: d, judge: rnd() < 0.3, floor: rnd() < 0.3 })
    if (g.ok) { granted++; if (g.via === 'floor') floorHits++; noteTokens(db, aid, d, 200 + Math.floor(rnd() * 800)) }
    const snap = budgetSnapshot(db, aid, d)
    for (const [p, v] of Object.entries(snap.pools)) {
      if (v.used > v.cap) bad.push({ i, d, p, msg: '超额', v })
      if (p !== 'slow' && v.avail > { fast: 20, mid: 30, reserve: 6 }[p] * 1.5 + 1e-9) bad.push({ i, d, p, msg: '结转超 1.5 倍', v })
    }
    if (snap.floor.used > snap.floor.cap) bad.push({ i, d, msg: '保底超额', f: snap.floor })
    if (g.ok && g.via === 'pool' && snap.tokens.month > 40000 + 1000) bad.push({ i, d, msg: '月顶后仍放行普通请求' })
  }
  check('模糊模拟（种子 ' + SEED + '）：3000 次随机申请无超额 / 结转越界 / 月顶穿透', bad.length === 0, bad.slice(0, 3))
  check('模糊模拟：既有放行也走到保底', granted > 50 && floorHits > 0, { granted, floorHits })
}

// ======================= I15：fold 仍不碰模型 / 预算 =======================
{
  const src = fs.readFileSync(new URL('../src/modules/sangguan/fold.js', import.meta.url), 'utf8')
  check('I15：fold 不 import llm / budget / http', !/from '\.\/(llm|budget|http_chat)\.js'/.test(src))
  const llmSrc = fs.readFileSync(new URL('../src/modules/sangguan/llm.js', import.meta.url), 'utf8')
  check('llm 不读系统时钟（时间从 ctx 传入）', !/Date\.now\(|new Date\(\)/.test(llmSrc))
  const bSrc = fs.readFileSync(new URL('../src/modules/sangguan/budget.js', import.meta.url), 'utf8')
  check('budget 不读系统时钟（日期从参数传入）', !/Date\.now\(|new Date\(\)/.test(bSrc))
  check('budget 不引用记忆预算模块', !/llm_budget/.test(bSrc))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
