/**
 * P3 planner v0（2026-11-15）：把「挑谁、给多少预算」收成一个纯函数。
 *
 * 输入：候选池的候选（{source,id,text,detail,score,...}）+ 预算表（token）
 * 输出：{ kept, dropped, bySource, tokens }
 *
 * 规则（先保守，不接线）：
 *   - 按 source 分额度；没配额度的 source 一律 dropped（不默认给钱）；
 *   - 同源按 score 从高到低；
 *   - 单条超额度不切半（切半会改语义），整条 dropped；
 *   - 去重：同 source+id；memory 再按正文前 80 字。
 * 本模块不写库、不碰提示词；接线是下一刀。
 */
import { estTokens } from './pack.js'
import { DEFAULTS } from './inject_budget.js'

const textOf = (c) => [c && c.text, c && c.detail].filter(Boolean).join('\n')

/** 估算一条候选要花多少 token（正文 + 经过）。 */
export function tokensOf(candidate) {
  try { return Math.max(1, estTokens(textOf(candidate))) } catch { return 1 }
}

export function planInjection(candidates, { budgets = DEFAULTS, order = ['memory', 'event'] } = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const kept = []
  const dropped = []
  const bySource = {}
  const tokens = {}

  for (const source of order) {
    const budget = Math.max(0, Number(budgets[source]) || 0)
    let used = 0
    let n = 0
    const seen = new Set()
    const sorted = list.filter((c) => c && c.source === source).sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    for (const c of sorted) {
      // 去重按 id（有 id 就用 id）；没 id 才退回正文全串——别拿前 80 字冒充「同一条」，
      // 工作段摘要那种同前缀的条目会被误并。
      const key = c.id
        ? source + ':' + String(c.id)
        : source + ':' + String(c.text || '').replace(/\s+/g, '')
      if (seen.has(key)) continue
      seen.add(key)
      const t = tokensOf(c)
      if (t > budget - used) { dropped.push({ ...c, need: t, reason: 'budget' }); continue }
      used += t
      n++
      kept.push({ ...c, tokens: t })
    }
    bySource[source] = n
    tokens[source] = used
  }

  // 没配额度的 source：不默认给钱，统一记 dropped
  for (const c of list) {
    if (!c || order.includes(c.source)) continue
    dropped.push({ ...c, reason: 'no-budget' })
  }

  return { kept, dropped, bySource, tokens }
}
