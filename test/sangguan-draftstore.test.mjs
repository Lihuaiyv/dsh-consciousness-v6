/**
 * 三观 · 草稿收件箱（P1）：建/列/改/弃/去重/闸重算，手写与自动两档力度。
 * 运行：node test/sangguan-draftstore.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { createDraft, listDrafts, getDraft, patchDraft, markCommitted, markDiscarded, pendingCount } from '../src/modules/sangguan/draftstore.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}
function throwsAny(name, fn) {
  try { fn(); check(name, false, '没有抛错') } catch { check(name, true) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgdstore-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sgdstore'
const other = 'agt_other'
const at = (d, h = '10') => '2026-11-0' + d + 'T' + h + ':00:00.000Z'

const manual = (over = {}) => ({
  source: 'manual',
  kind: '准确',
  text: '数据不对就从头再跑，哪怕你在催',
  alt: '按趋势补个数先交差',
  foregone: '多花两天',
  exclusion: '不会拿一个大概对的数交差',
  boundary: ['你明确说只要估算时'],
  counterexample: '还没有被违反过',
  evidence: [{ at: '2026-11-01', quote: '你说「别糊弄，重跑」' }],
  vouch: true,
  ...over,
})

// ---------- 手写：一证 + 我认 ----------
const d1 = createDraft(db, aid, manual(), { at: at(3) })
check('手写：建得成', !!d1 && d1.id.startsWith('dr_'), d1)
check('手写：一证 + 我认 → 五闸全过', d1.gates.pass === true, d1.gates)
check('手写：不是重复', d1.duplicate === false)
check('手写：source/vouch 落库', d1.source === 'manual' && d1.vouch === true)
check('手写：证据日期只留到天', d1.evidence[0].at === '2026-11-01', d1.evidence)

const dNoVouch = createDraft(db, aid, manual({ text: '答应了的事就要做完，哪怕拖到很晚', vouch: false }), { at: at(3, '11') })
check('手写：没勾我认 → G5 不过', dNoVouch.gates.g5 === false && dNoVouch.gates.pass === false, dNoVouch.gates)

const dNoEv = createDraft(db, aid, manual({ text: '答应的事就要做完，哪怕拖到很晚', evidence: [] }), { at: at(3, '12') })
check('手写：没有证据 → G5 不过', dNoEv.gates.g5 === false, dNoEv.gates)

const dNoDate = createDraft(db, aid, manual({ text: '答应的事就要做完，哪怕拖到很晚', evidence: [{ quote: '你说过会等' }] }), { at: at(3, '13') })
check('手写：证据没日期 → G5 不过', dNoDate.gates.g5 === false, dNoDate.gates)

const dTask = createDraft(db, aid, manual({ text: '接口报错就先看日志，别乱改配置' }), { at: at(3, '14') })
check('手写：工作说明 → G4 不过', dTask.gates.g4 === false && dTask.gates.pass === false, dTask.gates)

throwsAny('手写：少于 6 个字拒', () => createDraft(db, aid, manual({ text: '不糊弄' }), { at: at(3, '15') }))
throwsAny('手写：超过 120 字拒', () => createDraft(db, aid, manual({ text: '长'.repeat(121) }), { at: at(3, '16') }))

// ---------- 去重 ----------
const dup = createDraft(db, aid, manual(), { at: at(4) })
check('去重：30 天内同文不重复插', dup.duplicate === true && dup.id === d1.id, dup.id)
check('去重：库里只有一条同文', db.prepare('SELECT COUNT(*) n FROM sangguan_drafts WHERE agent_id=? AND text=?').get(aid, d1.text).n === 1)
const dupLater = createDraft(db, aid, manual(), { at: '2026-12-20T10:00:00.000Z' })
check('去重：超过 30 天可以再建', dupLater.duplicate === false && dupLater.id !== d1.id, dupLater.id)

// ---------- 改：重算闸 ----------
const dFix = createDraft(db, aid, manual({ text: '重要的不是你说了什么，是后来做没做', alt: '', exclusion: '', vouch: false }), { at: at(5) })
check('改前：缺另一条路/排除/我认 → 不过', dFix.gates.pass === false && dFix.gates.g1 === false && dFix.gates.g3 === false, dFix.gates)
const dFixed = patchDraft(db, aid, dFix.id, { alt: '也可以说完就算', exclusion: '不会把承诺当客气话', vouch: true }, { at: at(5, '11') })
check('改后：G1/G3/G5 补上 → 全过', dFixed.gates.pass === true, dFixed.gates)
check('改后：状态变 edited', dFixed.status === 'edited')
check('改后：正文没动', dFixed.text === dFix.text)

throwsAny('改：不存在的草稿', () => patchDraft(db, aid, 'dr_nope', { text: '随便改改看' }))

// ---------- 列表与关闭 ----------
const openBefore = listDrafts(db, aid)
check('列表：默认只给开着的', openBefore.length >= 6 && openBefore.every((x) => x.status === 'draft' || x.status === 'edited'), openBefore.length)
check('列表：按时间倒序', openBefore[0].created_at >= openBefore[1].created_at)
check('列表：不串 agent', listDrafts(db, other).length === 0)

const committed = markCommitted(db, aid, d1.id, 'cl_fake', { at: at(6) })
check('关闭：入库后状态 committed + claim_id', committed.status === 'committed' && committed.claim_id === 'cl_fake')
check('关闭：入库后不在开口列表里', !listDrafts(db, aid).some((x) => x.id === d1.id))
check('关闭：已入库不能再改', (() => { try { patchDraft(db, aid, d1.id, { text: '改一改' }); return false } catch { return true } })())

const discarded = markDiscarded(db, aid, dNoVouch.id, { at: at(6, '11') })
check('关闭：丢掉后状态 discarded', discarded.status === 'discarded')
check('关闭：丢掉后不在开口列表里', !listDrafts(db, aid).some((x) => x.id === dNoVouch.id))
check('关闭：已丢掉不能再关一次', (() => { try { markDiscarded(db, aid, dNoVouch.id); return false } catch { return true } })())
check('计数：pendingCount = 开口条数', pendingCount(db, aid) === listDrafts(db, aid).length, { p: pendingCount(db, aid), l: listDrafts(db, aid).length })

// ---------- 自动稿：仍要两条跨天 ----------
const cluster2 = { kind: '时间', items: [{ at: '2026-11-01', alt: 'a', foregone: '多花两天' }, { at: '2026-11-03', alt: 'b', foregone: '又拖一晚' }] }
const a1 = createDraft(db, aid, {
  kind: '时间', text: '数据不对的时候我会从头再跑一遍，哪怕你已经在催了',
  alt: '按趋势补个数', foregone: '多花了两天', exclusion: '不会拿一个大概对的数交差',
  evidence: [{ at: '2026-11-01', quote: '重跑' }, { at: '2026-11-03', quote: '再查' }],
  cluster: cluster2,
}, { at: at(7) })
check('自动：两条跨天 → G5 过', a1.gates.g5 === true, a1.gates)
check('自动：source=llm 且不认我认', a1.source === 'llm' && a1.vouch === false)

const a2 = createDraft(db, aid, {
  kind: '时间', text: '数据不对的时候我会从头再跑第二遍，哪怕你在催',
  alt: '按趋势补个数', foregone: '多花了两天', exclusion: '不会拿一个大概对的数交差',
  evidence: [{ at: '2026-11-01', quote: '重跑' }],
  cluster: { kind: '时间', items: [{ at: '2026-11-01', alt: 'a', foregone: '多花两天' }] },
}, { at: at(7, '11') })
check('自动：只有一条 → G5 不过', a2.gates.g5 === false, a2.gates)

// ---------- 硬删 agent：草稿与任务状态一起清 ----------
{
  const { purgeAgent } = await import('../src/modules/sangguan/purge.js')
  const { setFlag } = await import('../src/kernel.js')
  setFlag(db, 'sangguan.draftjob:' + aid, JSON.stringify({ status: 'done', started_at: at(7) }))
  const total = db.prepare('SELECT COUNT(*) n FROM sangguan_drafts WHERE agent_id=?').get(aid).n
  check('清除前：草稿还在', total > 0)
  const rows = purgeAgent(db, aid)
  check('清除：返回里记了草稿条数', rows.sangguan_drafts === total, { got: rows.sangguan_drafts, total })
  check('清除：草稿表里没有这个 agent 了', listDrafts(db, aid, { status: ['draft', 'edited', 'committed', 'discarded'] }).length === 0)
  check('清除：起草任务状态也删了', !db.prepare("SELECT 1 FROM flags WHERE key=?").get('sangguan.draftjob:' + aid))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
