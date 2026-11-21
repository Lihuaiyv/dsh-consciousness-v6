/**
 * C2 链锁（2026-11-15 定稿字段）：生成 → 判官 → 聚类 → 升格。
 * 假模型验证编排，不跑真 14B。
 */
import { distillEvent, judgeFacts, clusterCandidates, promoteClusters } from '../src/modules/fact_distill.js'

let fails = 0
const ok = (name, cond, extra) => {
  if (cond) { console.log('PASS', name) } else { fails++; console.log('FAIL', name, extra ? JSON.stringify(extra) : '') }
}

const ev = { title: '某件事', story: '经过', quotes: '["原话"]' }
const base = { kind: 'preference', subject: 'owner', subject_id: 'owner', status: 'now', text: '他不想要主动推送', why: '别弹窗', cue: '下次写提醒时', effect: '先问一句', valid_from: '', valid_until: '' }

// 1) 生成：kind/subject/status 白名单
const gen = async () => ({ text: JSON.stringify({ facts: [
  base,
  { ...base, subject: 'bad' },
  { ...base, status: 'bad' },
  { ...base, text: '' },
] }) })
const d = await distillEvent(null, gen, ev)
ok('生成：只留合法 kind/subject/status + text', d.facts.length === 1 && d.facts[0].subject === 'owner' && !!d.facts[0].subject_id, d.facts)

// 2) 判官：accept 收；判官可改 subject/status；其它丢；漏判不收
const judge = async () => ({ text: JSON.stringify({ judge: [
  { i: 1, verdict: 'accept', subject: 'stranger', subject_id: 'stranger:阿强', status: 'past', reason: '改一下' },
  { i: 2, verdict: 'vague', reason: '空泛' },
] }) })
const j = await judgeFacts(judge, { facts: [base, { ...base, text: 'b' }, { ...base, text: 'c' }], sourceText: '原文' })
ok('判官：accept 一条', j.kept.length === 1, j)
ok('判官：subject/status/subject_id 以判官为准', j.kept[0].subject === 'stranger' && j.kept[0].status === 'past' && j.kept[0].subject_id === 'stranger:阿强', j.kept[0])
ok('判官：其它原因丢', j.dropped.some((x) => x.text === 'b'), j.dropped)
ok('判官：漏判按不收', j.dropped.some((x) => x.text === 'c' && x.reason === 'not-judged'), j.dropped)

// 3) 聚类：合并成员并沿用最具体那条的 subject/status
const cluster = async () => ({ text: JSON.stringify({ clusters: [{ members: [1, 2], kind: 'preference', text: '最具体的一条', why: '依据' }] }) })
const cs = await clusterCandidates(cluster, [base, { ...base, subject: 'owner', status: 'now' }, { ...base, subject: 'owner', status: 'now' }])
ok('聚类：并成一组', cs.some((c) => c.members.length === 2), cs)
ok('聚类：subject/status/subject_id 沿用成员', cs.every((c) => c.subject === 'owner' && c.status === 'now' && c.subject_id === 'owner'), cs)

// 4) 升格：behavior ≥2；world 要反例；cue/effect 必填；太长不收
const use = { cue: '下次写提醒时', effect: '先问一句' }
const evs = (n, day = '2026-11-12') => Array.from({ length: n }, (_, i) => ({ id: 'e' + i, at: `${day}T0${i}:00:00Z` }))
const r1 = promoteClusters([{ ...use, members: [0, 1], kind: 'preference', text: base.text, falsifier: '' }], evs(2))
ok('升格：preference 一次即可', r1.promoted.length === 1, r1)
const r2 = promoteClusters([{ ...use, members: [0], kind: 'behavior', text: '被否定时先沉默', falsifier: '' }], evs(1))
ok('升格：behavior 只有 1 件 → 不够', r2.promoted.length === 0 && r2.weak[0].weakReason === 'need-2-events', r2)
const r3 = promoteClusters([{ ...use, members: [0, 1, 2, 3, 4, 5], kind: 'world', text: '格式服从和智力是两回事', falsifier: '当模型变强时' }], evs(6))
ok('升格：组内 >5 条 → oversized 不升', r3.promoted.length === 0 && r3.weak[0].weakReason === 'oversized', r3)
const r4 = promoteClusters([{ ...use, members: [0, 1], kind: 'world', text: '格式服从和智力是两回事', falsifier: '' }], evs(2))
ok('升格：world 没反例 → 不升', r4.promoted.length === 0 && r4.weak[0].weakReason === 'no-falsifier', r4)
const r5 = promoteClusters([{ ...use, members: [0, 1], kind: 'world', text: '系统和功能可能受影响', falsifier: '当模型变强时' }], evs(2))
ok('升格：模糊词 → 不升', r5.promoted.length === 0 && r5.weak[0].weakReason === 'vague', r5)
const r6 = promoteClusters([{ members: [0, 1], kind: 'preference', text: base.text, falsifier: '' }], evs(2))
ok('升格：没 cue/effect → no-use 不升', r6.promoted.length === 0 && r6.weak[0].weakReason === 'no-use', r6)
const r8 = promoteClusters([{ ...use, members: [0, 1], kind: 'project', text: '一件事；另一件事' }], evs(2))
ok('升格：带「；」的合并句 → merged 不升', r8.promoted.length === 0 && r8.weak[0].weakReason === 'merged', r8)
const r7 = promoteClusters([{ ...use, members: [0, 1], kind: 'project', text: '长'.repeat(120) }], evs(2))
ok('升格：超过 80 字 → too-long 不升', r7.promoted.length === 0 && r7.weak[0].weakReason === 'too-long', r7)
const r9 = promoteClusters([{ ...use, members: [0, 1], kind: 'behavior', text: '同一件事' }], [{ id: 'e1', at: '2026-11-12T01:00:00Z' }, { id: 'e1', at: '2026-11-12T02:00:00Z' }])
ok('升格：同一事件出现两次只算 1 件（behavior）', r9.promoted.length === 0 && r9.weak[0].support === 1 && r9.weak[0].weakReason === 'need-2-events', r9)

process.exit(fails ? 1 : 0)
