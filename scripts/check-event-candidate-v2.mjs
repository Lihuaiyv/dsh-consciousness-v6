/**
 * 候选边生成验收（2026-11-19）
 * 纯函数，不碰库。锁的是：
 *   1. 同会话相邻 → 出候选；
 *   2. 跨会话相邻 → 不出（不能把两条线硬连）；
 *   3. 同专名跨天 → 出候选；
 *   4. 接续挂着的 → 出候选且分数 ≥0.7；
 *   5. 泛词（提示词/门禁）不算专名，不产生候选；
 *   6. 分数分档：model / weak / drop。
 */
import { scoreCandidates } from '../src/modules/event_candidate_v2.js'

let fails = 0
const ok = (name, cond, extra) => {
  if (cond) console.log('PASS', name)
  else { fails++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)) }
}

const row = (id, day, sess, at, title, cues, status = null, extra = '{}') => ({
  id, day, session_id: sess, start_at: at, end_at: at, title,
  summary: `${title}的经过`, quotes: '[]', cues: JSON.stringify(cues), status, extra,
})

const rows = [
  row('a', 'd1', 's1', '2026-11-18T01:00:00Z', '修 D46 注入', ['D46', 'oneLine'], null),
  row('e', 'd1', 's1', '2026-11-18T01:10:00Z', '跑门禁', ['门禁'], null),
  row('c', 'd1', 's2', '2026-11-18T01:05:00Z', '另一条线', ['提示词'], null),
  row('o', 'd1', 's2', '2026-11-18T02:00:00Z', 'D46 还挂着', ['D46'], '挂着', '{"result":"还等重启验证"}'),
  row('d', 'd2', 's1', '2026-11-19T01:00:00Z', '接着修 D46', ['D46'], null),
  row('f', 'd2', 's1', '2026-11-19T03:00:00Z', '泛词件', ['提示词'], null),
]
const cands = scoreCandidates(rows, { threshold: 0.5, weak: 0.35 })
const has = (from, to, why) => cands.some((x) => x.from === from && x.to === to && x.why === why)

ok('同会话相邻 → 出候选', has('a', 'e', '同会话相邻'), cands.filter((x) => x.why === '同会话相邻'))
ok('跨会话相邻 → 不出', !cands.some((x) => x.from === 'a' && x.to === 'c'))
ok('同专名跨天 → 出候选', has('a', 'd', '同专名跨天'), cands.filter((x) => x.why === '同专名跨天'))
const cont = cands.find((x) => x.from === 'o' && x.to === 'd' && x.why.includes('接续挂着的'))
ok('接续挂着的 → 出候选且 ≥0.7', !!cont && cont.score >= 0.7, cont)
ok('泛词不算专名：提示词不产生候选', !cands.some((x) => (x.from === 'c' && x.to === 'f') || (x.from === 'f' && x.to === 'd')))
ok('候选都有分数与档位', cands.every((x) => typeof x.score === 'number' && ['model', 'weak', 'drop'].includes(x.tier)))

console.log(`\n通过 ${fails === 0 ? '全部' : '有失败'}（候选 ${cands.length}）`)
if (fails) process.exitCode = 1
