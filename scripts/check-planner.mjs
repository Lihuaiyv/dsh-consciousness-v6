/**
 * planner v0 锁（P3，2026-11-15）
 *  1. 按源分额度：memory 1200 token 能装 3 条 400 token 的，第 4 条 dropped
 *  2. 单条超额度不切半：一条 2000 字（≈1000 token）进 400 的 event 额度 → dropped
 *  3. 去重：同 id 只留一条
 *  4. 没配额度的源：不默认给钱，记 dropped/no-budget
 *  5. 空输入：不崩
 */
import { planInjection, tokensOf } from '../src/modules/planner.js'

let fails = 0
const ok = (name, cond, extra) => {
  if (cond) { console.log('PASS', name) } else { fails++; console.log('FAIL', name, extra ? JSON.stringify(extra) : '') }
}

try {
  const mem = (i, chars = 800, score = 0.5) => ({ source: 'memory', id: 'm' + i, text: '记' + i + '忆'.repeat(Math.max(0, chars - 2)), score })
  ok('token 估算：800 字 ≈ 400 token', tokensOf(mem(1)) >= 380 && tokensOf(mem(1)) <= 420, tokensOf(mem(1)))

  const r = planInjection([mem(1), mem(2), mem(3), mem(4)], { budgets: { memory: 1200, event: 400 } })
  ok('按额度装：3 条', r.kept.filter((x) => x.source === 'memory').length === 3, r.bySource)
  ok('超出的记 dropped（不丢数据）', r.dropped.some((d) => d.id === 'm4' && d.reason === 'budget'), r.dropped.map((d) => d.id))

  const ev = { source: 'event', id: 'e1', text: '事'.repeat(2000), score: 0.8 }
  const r2 = planInjection([ev], { budgets: { memory: 800, event: 400 } })
  ok('单条超额度：整条 dropped，不切半', r2.kept.length === 0 && r2.dropped[0].reason === 'budget', r2)

  const r3 = planInjection([mem(1), mem(1)], { budgets: { memory: 800 } })
  ok('去重：同一条只留一条', r3.kept.length === 1, r3.kept.map((x) => x.id))

  const r4 = planInjection([{ source: 'loop', id: 'l1', text: '答应过的事', score: 0.9 }], { budgets: { memory: 800 } })
  ok('没配额度：不默认给钱', r4.kept.length === 0 && r4.dropped[0].reason === 'no-budget', r4)

  const r5 = planInjection([], {})
  ok('空输入不崩', r5.kept.length === 0 && r5.dropped.length === 0, r5)
} catch (e) {
  fails++
  console.log('FAIL planner 异常:', (e && e.stack) || e)
}
process.exit(fails ? 1 : 0)
