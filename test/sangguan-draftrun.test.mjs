/**
 * 三观 · 起草流水线（P3）：J32 标注 → 聚类 → J33 起草 → 过闸进收件箱；幂等与运行态。
 * 运行：node test/sangguan-draftrun.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { setFlag } from '../src/kernel.js'
import '../src/modules/sangguan/templates.js'
import { runDraftRound, startDraftRound, draftJob } from '../src/modules/sangguan/draftrun.js'
import { listDrafts } from '../src/modules/sangguan/draftstore.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 700)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgdrun-'))
const db = openDb(path.join(dir, 'app.db'))

let seq = 0
function turn(agent, role, text, atIso, session) {
  seq++
  db.prepare(`INSERT INTO raw_turns(id, agent_id, session_id, seq, role, text, created_at, day)
    VALUES(?,?,?,?,?,?,?,?)`).run('t' + seq, agent, session, seq, role, text, atIso, atIso.slice(0, 10))
}
const day = (d) => '2026-11-0' + d + 'T10:00:00.000Z'

/** 两天的同一个取舍：数据不对，宁可重跑。 */
function seed(aid) {
  turn(aid, 'assistant', '我按趋势补了个数，先交。', day(1), 's' + aid)
  turn(aid, 'user', '别糊弄我，数据对吗', '2026-11-01T10:05:00.000Z', 's' + aid)
  turn(aid, 'assistant', '不对，我重跑一遍再给你。', '2026-11-01T10:10:00.000Z', 's' + aid)
  turn(aid, 'assistant', '这个数我估的，差不多。', day(3), 's' + aid)
  turn(aid, 'user', '别猜，重跑', '2026-11-03T10:05:00.000Z', 's' + aid)
  turn(aid, 'assistant', '好，我重跑，多花点时间也认。', '2026-11-03T10:10:00.000Z', 's' + aid)
}

const okAnno = async (slice) => ({
  ok: true,
  out: { items: slice.map((_, i) => ({ idx: i, alt: '按趋势补个数先交', foregone: '多花两天重跑', cost_to: '自己' })) },
})
const okDraft = async () => ({
  ok: true,
  out: {
    drafts: [
      { text: '数据不对的时候我会从头再跑一遍，哪怕你已经在催了', exclusion: '不会拿一个大概对的数交差', boundary: ['你明确说只要估算时'] },
      { text: '我重视准确', exclusion: '' },
    ],
  },
})

const aid = 'agt_run'
seed(aid)
const r1 = await runDraftRound(db, aid, { at: '2026-11-03T12:00:00.000Z', askAnno: okAnno, askDraft: okDraft })
check('一轮：取到两天两条料', r1.episodes === 2, r1.episodes)
check('一轮：两条都标注了', r1.annotated === 2, r1.annotated)
check('一轮：聚成一簇', r1.clusters === 1, r1.clusters)
check('一轮：起草两条', r1.drafts === 2, r1.drafts)
check('一轮：进收件箱两条（不过闸的也留着给人改）', r1.created === 2 && r1.duplicates === 0, r1)
check('一轮：没有错误', r1.errors.length === 0, r1.errors)

const box = listDrafts(db, aid)
check('收件箱：两条都在', box.length === 2, box.length)
check('收件箱：一条过闸、一条没过', box.filter((d) => d.gates.pass).length === 1, box.map((d) => d.gates))
check('收件箱：自动稿带来源与阶段', box.every((d) => d.source === 'llm' && d.batch_key === 'sg:draft:2026-11-03'))
check('收件箱：过闸那条带证据两条、跨天', (() => {
  const d = box.find((x) => x.gates.pass)
  return d && d.evidence.length === 2 && new Set(d.evidence.map((e) => e.at)).size === 2
})(), box.find((x) => x.gates.pass))

// 幂等：同一天再跑，不重复进
const r2 = await runDraftRound(db, aid, { at: '2026-11-03T13:00:00.000Z', askAnno: okAnno, askDraft: okDraft })
check('再跑：新进 0 条', r2.created === 0, r2)
check('再跑：两条都判重复', r2.duplicates === 2, r2.duplicates)
check('再跑：收件箱还是两条', listDrafts(db, aid).length === 2)

// J32 坏掉：不炸，记 error，进 0 条
const aidBad = 'agt_bad32'
seed(aidBad)
const r3 = await runDraftRound(db, aidBad, { at: day(3), askAnno: async () => { throw new Error('网络断了') }, askDraft: okDraft })
check('J32 抛错：整轮不炸', r3.created === 0 && r3.errors.length >= 1, r3)
check('J32 抛错：记下是哪一步', r3.errors[0].step === 'J32' && String(r3.errors[0].error).includes('网络断了'), r3.errors[0])
check('J32 抛错：收件箱空着', listDrafts(db, aidBad).length === 0)

const r4 = await runDraftRound(db, aidBad, { at: day(3), askAnno: async () => ({ ok: true, out: { items: [{ idx: 99, alt: 'x', foregone: '多花两天' }] } }), askDraft: okDraft })
check('J32 越界 idx：丢掉不进', r4.annotated === 0 && r4.created === 0, r4)

// J32 只有一条：聚不成簇
const aidOne = 'agt_one'
seed(aidOne)
const r5 = await runDraftRound(db, aidOne, { at: day(3), askAnno: async (slice) => ({ ok: true, out: { items: [{ idx: 0, alt: '按趋势补个数', foregone: '多花两天重跑' }] } }), askDraft: okDraft })
check('只有一条标注：不成簇、不出稿', r5.annotated === 1 && r5.clusters === 0 && r5.created === 0, r5)

// J33 不给稿
const aidNo = 'agt_nodraft'
seed(aidNo)
const r6 = await runDraftRound(db, aidNo, { at: day(3), askAnno: okAnno, askDraft: async () => ({ ok: true, out: { drafts: [] } }) })
check('J33 空手：进 0 条，不记创建错误', r6.drafts === 0 && r6.created === 0 && r6.errors.length === 0, r6)

// 运行态：正在跑时不许再起一轮
const aidBusy = 'agt_busy'
seed(aidBusy)
let release
const gate = new Promise((r) => { release = r })
const start = startDraftRound(db, aidBusy, {
  at: '2026-11-03T12:00:00.000Z',
  askAnno: async (slice) => { await gate; return okAnno(slice) },
  askDraft: okDraft,
})
check('起一轮：立刻回 started', start.started === true && start.job.status === 'running', start)
const again = startDraftRound(db, aidBusy, { at: '2026-11-03T12:01:00.000Z', askAnno: okAnno, askDraft: okDraft })
check('起一轮：跑着的时候再起被拒', again.started === false && again.job.status === 'running', again)
release()
await new Promise((r) => setTimeout(r, 50))
check('起一轮：跑完写回 done', draftJob(db, aidBusy).status === 'done', draftJob(db, aidBusy))
check('起一轮：结果里有进箱数', draftJob(db, aidBusy).status === 'done' && draftJob(db, aidBusy).created > 0, draftJob(db, aidBusy))

// 卡死的 running 超过 10 分钟可以重起
const aidStale = 'agt_stale'
seed(aidStale)
setFlag(db, 'sangguan.draftjob:' + aidStale, JSON.stringify({ status: 'running', started_at: new Date(Date.now() - 20 * 60000).toISOString(), day: '2026-11-03' }))
const stale = await startDraftRound(db, aidStale, { at: '2026-11-03T12:00:00.000Z', await: true, askAnno: okAnno, askDraft: okDraft })
check('卡死的任务：10 分钟后允许重起', stale.started === true && stale.job.status === 'done', stale.job)
check('卡死的任务：重起后真的进了箱', stale.job.created > 0, stale.job)

// 调用方给了 chat（测试 / 自定义端点）就用它，别偷偷走宿主模型
const aidChat = 'agt_chat'
seed(aidChat)
const { fakeChat } = await import('./sangguan-fake-llm.mjs')
const chat = fakeChat({
  J32: (input) => ({ items: input.map((_, i) => ({ idx: i, alt: '按趋势补个数先交', foregone: '多花两天重跑', cost_to: '自己' })) }),
  J33: () => ({
    drafts: [{ text: '数据不对的时候我会从头再跑一遍，哪怕你已经在催了', exclusion: '不会拿一个大概对的数交差' }],
  }),
})
const r7 = await runDraftRound(db, aidChat, { at: '2026-11-03T12:00:00.000Z', chat })
check('转发 chat：J32 走的是注入的模型', chat.count('J32') >= 1, chat.calls.map((c) => c.id))
check('转发 chat：J33 也走同一个模型', chat.count('J33') >= 1, chat.calls.map((c) => c.id))
check('转发 chat：草稿真进了箱', r7.created >= 1 && listDrafts(db, aidChat).length >= 1, { r: r7, n: listDrafts(db, aidChat).length })

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
