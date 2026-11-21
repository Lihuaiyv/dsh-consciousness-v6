/**
 * 事件库 v2 判边验收（2026-11-19）
 * 锁的是「新库判边」这条影子路径：
 *   1. 只在同一会话内、相邻两件判（跨会话不判）；
 *   2. 九类词表合法，none 不成立边；
 *   3. 证据必须能在两件的摘要/原文里找到，找不到就降级 ok=false；
 *   4. 只返回候选，**不写库**（event_edges 一行不动）。
 * 用临时库 + 假模型，不联网。
 */
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { judgeDayV2, judgePairV2, REL_PULL } from '../src/modules/event_causal_v2.js'

const P = path.join(os.tmpdir(), 'dsh-check-causal-v2-' + Date.now() + '.db')
let fails = 0
const ok = (name, cond, extra) => {
  if (cond) console.log('PASS', name)
  else { fails++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)) }
}

const db = openDb(P)
const aid = 'a1'
const day = '2026-11-19'
const add = (id, sess, at, title, summary, quotes) => db.prepare(
  'INSERT INTO events_v2(id,agent_id,day,start_at,end_at,turn_ids,session_id,title,summary,quotes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
).run(id, aid, day, at, at, '[]', sess, title, summary, JSON.stringify(quotes), at)

add('e1', 's1', '2026-11-19T01:00:00Z', '定窗口', '把情绪链窗口固定成五句，门禁绿了', ['窗口固定成五句'])
add('e2', 's1', '2026-11-19T02:00:00Z', '跑检索', '试着用新窗口跑检索，结果偏了', ['窗口固定成五句'])
add('e3', 's1', '2026-11-19T03:00:00Z', '改规则', '改了抓手规则，复核一遍', ['复核'])
add('e4', 's2', '2026-11-19T04:00:00Z', '换会话', '另开一条线', ['另开'])

let calls = 0
const complete = async ({ system, text }) => {
  calls++
  if (!String(system).startsWith('你是事件关系判断员')) return '{}'
  if (calls === 1) return JSON.stringify({ relation: 'cause', direction: 'A_to_B', confidence: 0.9, evidence: '把情绪链窗口固定成五句', why: '先定窗口才跑检索' })
  if (calls === 2) return JSON.stringify({ relation: 'none', direction: 'A_to_B', confidence: 0.8, evidence: '', why: '接不上' })
  return JSON.stringify({ relation: 'revise', direction: 'B_to_A', confidence: 0.9, evidence: '这句原文里没有', why: '编的证据' })
}

const before = db.prepare('SELECT COUNT(*) c FROM event_edges').get().c
const out = await judgeDayV2(db, aid, day, { complete })
ok('同会话相邻才判：4 件跨 2 会话 → 2 对', out.pairs === 2 && out.edges.length === 2, { pairs: out.pairs, n: out.edges.length })
ok('第一对判出 cause，证据命中，ok', out.edges[0].ok && out.edges[0].kind === 'cause' && out.edges[0].pull === 1, out.edges[0])
ok('第二对 none 不成立边', out.edges[1].kind === 'none' && !out.edges[1].ok, out.edges[1])
ok('九类词表齐', ['cause', 'enable', 'prevent', 'revise', 'resolve', 'continue', 'same', 'contradict', 'none'].every((k) => REL_PULL[k] != null))
ok('不写库：event_edges 一行没动', db.prepare('SELECT COUNT(*) c FROM event_edges').get().c === before)
// 2026-11-19：线头——每个会话在库里最早的那件打 threadHead（分叉会话按新会话走，不硬连）
const headIds = out.threadHeads.map((h) => h.eventId)
ok('线头：两个会话各一个 threadHead', out.threadHeads.length === 2 && headIds.includes('e1') && headIds.includes('e4'), out.threadHeads)

// 证据编造的用例：单独判一对
const out2 = await judgeDayV2(db, aid, day, { complete: async () => JSON.stringify({ relation: 'revise', confidence: 0.9, evidence: '这句原文里没有', why: '编的' }) })
ok('证据抄不出原文 → 降级 ok=false', out2.edges.every((e) => e.ok === false), out2.edges.map((e) => ({ k: e.kind, ok: e.ok })))

// 2026-11-19：证据要整句、至少十个字；短证据不成立
const row1 = db.prepare('SELECT * FROM events_v2 WHERE id=?').get('e1')
const row2 = db.prepare('SELECT * FROM events_v2 WHERE id=?').get('e2')
const shortEv = await judgePairV2(row1, row2, {
  complete: async () => JSON.stringify({ relation: 'cause', confidence: 0.95, evidence: '窗口固定成五句', why: '短证据' }),
})
ok('证据不足十个字 → 不成立', shortEv.ok === false, { ev: shortEv.evidence, len: shortEv.evidence.length, ok: shortEv.ok })

// 2026-11-19：方向语义化——B_to_A 时语义源是 B、目标是 A
const dir = await judgePairV2(row1, row2, {
  complete: async () => JSON.stringify({ relation: 'revise', direction: 'B_to_A', confidence: 0.9, evidence: '把情绪链窗口固定成五句', why: '后件改前件' }),
})
ok('方向 B_to_A：语义源是 B、目标是 A', dir.semanticFrom === 'e2' && dir.semanticTo === 'e1', { from: dir.semanticFrom, to: dir.semanticTo, dir: dir.direction })
ok('判过的都留档（含 none）', out2.edges.every((e) => e.record === true), out2.edges.map((e) => e.record))

console.log(`\n通过 ${fails === 0 ? '全部' : '有失败'}（对 ${out.pairs} / 边 ${out.edges.length}）`)
if (fails) process.exitCode = 1
