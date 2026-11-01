/**
 * 三观 S12b · L2 自传摘要（J16，中环 N7）与「为什么持有这个看法」（J19）。全部离线（假 LLM）。
 * 运行：node test/sangguan-s12b.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, newId, readEvents, lastSeq } from '../src/modules/sangguan/ledger.js'
import { emptyState, fold, checkInvariants } from '../src/modules/sangguan/fold.js'
import { loadState, rebuild, snapshot, stateToSnapshot } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { buildSummary, lastSummary, listSummaries, SUMMARY_MIN } from '../src/modules/sangguan/summary.js'
import { explain, factsOf, draftOf } from '../src/modules/sangguan/explain.js'
import { injectView } from '../src/modules/sangguan/inject.js'
import { runMid } from '../src/modules/sangguan/night.js'
import { budgetSnapshot } from '../src/modules/sangguan/budget.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg12b-'))
const db = openDb(path.join(dir, 'app.db'))
const DAY = 86400000
let clock = Date.parse('2026-11-02T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const nowIso = () => new Date(clock).toISOString()
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const put = (aid, evs, expect) => append(db, aid, evs, expect)
const KIND = { W: 'belt', L: 'chapter', V: 'norm' }
const mk = (aid, layer, text, extra = {}) => put(aid, [{
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(), payload: { claims: [{ layer, kind: KIND[layer], text, origin: 'extract', ...extra }] },
}]).entities.claims[0]
const ev = (aid, target, sign, kind = 'act') => put(aid, [{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind, target_type: 'claim', target_id: target, sign, weight: 0.6, ref: 'r' + clock }] } }])
function openK(aid, layer, pos, neg) {
  const at = tick()
  const qid = newId('questions', at)
  return put(aid, [{ type: 'KAPPA_OPEN', layer, actor: 'judge', at, payload: { questions: [{ id: qid, layer, text: '问' }], kappas: [{ layer, q_id: qid, pos_id: pos, neg_id: neg, dep: 'd', excl: 'e' }] } }]).entities.kappas[0]
}
const J16ok = (input) => ({ chapter: '学着把话说清楚', at_the_time: '我那时觉得直说最省事', hindsight: '现在看，直说也要看场合', turning_points: [input.events[0].id] })

// ---------- J16：新事件不够不跑 ----------
const aid = 'agt_s12b'
setSangguanConfig(db, aid, { enabled: true })
const a = mk(aid, 'W', '人多数时候愿意讲道理')
const b = mk(aid, 'V', '诚实比体面更重要')
const c = mk(aid, 'V', '照顾对方的感受更要紧')
{
  const chat = fakeChat({ J16: J16ok })
  const r = await buildSummary(db, aid, tick(), { chat })
  check('新事件 < 10：不跑、零调用', r.skipped === 'few' && chat.count() === 0, r)
}
for (let i = 0; i < 5; i++) ev(aid, a, 1)
const kV = openK(aid, 'V', b, c)
ev(aid, b, -1)
put(aid, [{ type: 'JOB_DONE', actor: 'sys', at: tick(), job_key: 'sg:night:x1', payload: {} }])
{
  const chat = fakeChat({ J16: J16ok })
  const seq0 = lastSeq(db, aid)
  const r = await buildSummary(db, aid, tick(), { chat })
  check('新事件 ≥ 10（JOB_DONE 不计）：跑一次 J16', r.did.length === 1 && chat.count('J16') === 1, r)
  const sm = lastSummary(db, aid)
  check('SUMMARY_BUILD 落账，携带来源区间', sm && sm.from_seq === 0 && sm.to_seq < lastSeq(db, aid) && sm.to_seq >= seq0 - 1, sm)
  check('摘要内容：章名 / 当时 / 回头看分开存', sm.chapter === '学着把话说清楚' && sm.at_the_time.includes('直说最省事') && sm.hindsight.includes('看场合'), sm)
  const row = db.prepare('SELECT * FROM claim_summaries WHERE agent_id=?').all(aid)
  check('claim_summaries 写入一行（L0 只增）', row.length === 1 && row[0].id.startsWith('sm_') && row[0].kind === 'chapter', row)
  const inp = chat.calls[0].input
  check('J16 输入：事件带事实原文、链头分层', inp.events.length >= SUMMARY_MIN && inp.events.some((e) => e.what.includes('讲道理')) && inp.heads.W.includes('人多数时候愿意讲道理'), inp)
  check('J16 输入不含运维事件', !inp.events.some((e) => e.type === 'JOB_DONE'))
  const s = readEvents(db, aid, { types: ['SUMMARY_BUILD'] }).pop()
  check('转折点 id 进 refs', same(s.refs, [inp.events[0].id]), s.refs)
  let threw = false
  try { db.prepare('UPDATE claim_summaries SET text=? WHERE agent_id=?').run('x', aid) } catch { threw = true }
  check('claim_summaries 拒绝 UPDATE', threw)
}
{
  const chat = fakeChat({ J16: J16ok })
  clock += 7 * DAY
  const r = await buildSummary(db, aid, tick(), { chat })
  check('隔了一周但新事不够 10 条：不调用', r.skipped === 'few' && chat.count() === 0, r)
}

// ---------- J16 失败 / 不合格：沿用旧版 ----------
for (let i = 0; i < 10; i++) ev(aid, a, i % 3 ? 1 : -1)
{
  const old = lastSummary(db, aid)
  const chat = fakeChat({ J16: new Error('网络断了') })
  const r = await buildSummary(db, aid, tick(), { chat })
  check('J16 调用失败：不写，沿用旧版', r.failed === 'CALL' && lastSummary(db, aid).id === old.id, r)
  const chat2 = fakeChat({ J16: { chapter: '编的', at_the_time: 'x', hindsight: 'y', turning_points: ['ev_不存在'] } })
  const r2 = await buildSummary(db, aid, tick(), { chat: chat2 })
  check('转折点编造 id：修复重试仍错 → 不写', r2.failed === 'SCHEMA' && chat2.count('J16') === 2 && lastSummary(db, aid).id === old.id, r2)
  const r3 = await buildSummary(db, aid, tick(), { chat: fakeChat({ J16: (input) => ({ chapter: '第二程', at_the_time: '那时摇摆', hindsight: '其实在长', turning_points: [] , extra: 1, _in: input.previous }) }) })
  const sm = lastSummary(db, aid)
  check('第二版：from_seq 接上一版 to_seq', r3.did.length === 1 && sm.chapter === '第二程' && sm.from_seq === old.to_seq, { r3, sm, old })
  check('listSummaries 新的在前，旧版保留', listSummaries(db, aid).map((x) => x.chapter).join('|') === '第二程|学着把话说清楚')
  for (let i = 0; i < 12; i++) ev(aid, c, 1)
  const chat4 = fakeChat({ J16: J16ok })
  const r4 = await buildSummary(db, aid, tick(), { chat: chat4 })
  check('不满一周：新事再多也不写下一章、不调用', r4.skipped === 'gap' && chat4.count() === 0, r4)
}
{
  const v = injectView(db, aid, { now: tick(), cache: false })
  check('注入：自传摘要一句', v.extra.some((l) => l.startsWith('你给自己这一程的说法：第二程')), v.extra)
}

// ---------- J19：事实只来自账本 ----------
{
  const f = factsOf(db, aid, a)
  const n4 = db.prepare("SELECT COUNT(*) n FROM claim_evidence WHERE agent_id=? AND target_id=? AND sign=1").get(aid, a).n
  check('事实清单：证据正反计数与账本一致', f.evidence.pro === n4 && f.evidence.con === 15 - n4, f.evidence)
  const d = draftOf(f)
  check('模板句：原文 + 来源 + 证据数', d.includes('人多数时候愿意讲道理') && d.includes('在对话里慢慢总结出来') && d.includes(n4 + ' 件事支持'), d)
  const fb = factsOf(db, aid, b)
  check('有矛盾的命题：模板句提到对方与状态', draftOf(fb).includes('照顾对方的感受更要紧') && draftOf(fb).includes('还在拉扯'), draftOf(fb))
  check('不存在的命题 → null', factsOf(db, aid, 'cl_nope') === null)
  void kV
}
{
  const seq0 = lastSeq(db, aid)
  const chat = fakeChat({ J19: { sentence: '我觉得人大多讲道理，这是聊着聊着总结出来的。' } })
  const r = await explain(db, aid, a, { now: tick(), chat })
  check('J19 润色：返回润色句', r.polished && r.sentence.includes('讲道理') && chat.count('J19') === 1, r)
  check('解释只读：账本不动', lastSeq(db, aid) === seq0)
  const r2 = await explain(db, aid, a, { now: tick(), chat })
  check('同一事实句：命中缓存，不再调用', r2.polished && r2.cached && chat.count('J19') === 1, r2)
  const bad = fakeChat({ J19: { sentence: '已经有 99 件事支持它了。' } })
  const r3 = await explain(db, aid, b, { now: tick(), chat: bad })
  check('润色新增数字：拒收，回落模板句', !r3.polished && r3.sentence === r3.draft && r3.code === 'SCHEMA' && bad.count('J19') === 2, r3)
  const r4 = await explain(db, aid, c, { now: tick(), chat: null })
  check('没有模型：直接给模板句', !r4.polished && r4.sentence === r4.draft && r4.code === 'CALL', r4)
  ev(aid, a, 1)
  const r5 = await explain(db, aid, a, { now: tick(), chat })
  check('新证据 → 事实句变了 → 重新润色', r5.polished && !r5.cached && chat.count('J19') === 2, r5)
  const r6 = await explain(db, aid, a, { polish: false })
  check('polish=false：不调用', !r6.polished && r6.sentence === r6.draft && chat.count('J19') === 2)
}

// ---------- 中环 N7 挂点 + 预算 ----------
{
  const a2 = 'agt_s12b_mid'
  setSangguanConfig(db, a2, { enabled: true })
  const x = mk(a2, 'W', '早起让一天更从容')
  for (let i = 0; i < 12; i++) ev(a2, x, 1)
  const chat = fakeChat({ J16: J16ok })
  const off = { cross: false, core: false, repair: false, open: false, deliberate: false, liveness: false, chat }
  const r = await runMid(db, a2, tick(), off)
  check('runMid：N7 自传摘要跑了一次', r.summary.length === 1 && chat.count('J16') === 1, r.summary)
  const day = nowIso().slice(0, 10)
  const bs = budgetSnapshot(db, a2, day)
  check('N7 走周池（T2 = 4 单位），不占中环', bs.pools.slow.used === 4 && bs.pools.mid.used === 0, bs)
  clock += DAY
  const r2 = await runMid(db, a2, tick(), off)
  check('次夜无新事：不跑', r2.summary.length === 0 && chat.count('J16') === 1)
  const r3 = await runMid(db, a2, tick(), { ...off, job: false, summary: false })
  check('summary:false 可关', Array.isArray(r3.summary) && r3.summary.length === 0)
  const a3 = 'agt_s12b_off'
  for (let i = 0; i < 12; i++) mk(a3, 'W', '关着也有的命题' + i)
  const chat3 = fakeChat({ J16: J16ok })
  const r4 = await runMid(db, a3, tick(), { chat: chat3 })
  check('开关关闭：runMid 直接返回，不摘要', r4.status === 'off' && chat3.count() === 0)
}

// ---------- 不变式与 P1 重放（SUMMARY_BUILD 不进 fold） ----------
for (const id of ['agt_s12b', 'agt_s12b_mid']) {
  const inv = checkInvariants(loadState(db, id))
  const live = snapshot(db, id)
  const pure = stateToSnapshot(fold(emptyState(), readEvents(db, id)), id)
  rebuild(db, id)
  check('不变式 + P1 重放：' + id, !inv.length && same(pure, live) && same(snapshot(db, id), live), inv.slice(0, 2))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
