/**
 * 事件库 v2 的候选边生成（2026-11-19，影子，不写库）。
 *
 * 目标：只把「值得让模型判」的对交出去，不做全对全判（那是平方级）。
 * 三个来源：
 *   ① 同会话相邻（A→B）
 *   ② 同专名跨天
 *   ③ 开放环接续（前件 stata=挂着，后件提到它的专名）
 * 每对打分：专名重叠 / 时间远近 / 前件状态 / 因果词；阈值决定进模型还是丢。
 */
const GENERIC = new Set([
  '门禁', '模型', '提示词', '代码', '测试', '文档', '记忆', '事件', '工作', '生活', '计划', '记录',
  '窗口', '接口', '系统', '问题', '结果', '原因', '完成', '继续', '修复', '优化', '讨论', '调整',
])
const CUE_WORDS = /(因为|所以|导致|结果|修好之后|才会|要不是|跑通|红了|绿了|没生效|没加载)/

const toList = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }
/** 专名闸：长度 ≥3，或含英文/数字——挡「情绪链/提示词」这类通用词。 */
const concrete = (c) => !!c && !GENERIC.has(c) && (c.length >= 3 || /[A-Za-z0-9]/.test(c))
const cues = (row) => toList(row.cues).filter(concrete)
const extra = (row) => { try { return JSON.parse(row.extra || '{}') } catch { return {} } }

/** 专名重叠：重叠数 / 较小的一边（都不为空才有效）。 */
function overlapOf(a, b) {
  const A = new Set(cues(a)), B = new Set(cues(b))
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const c of A) if (B.has(c)) hit++
  return hit / Math.min(A.size, B.size)
}

/** 时间远近：同日相邻 1；同会话隔 1 件 0.7；隔 2 件 0.4；跨天 ≤3 天按天衰减。 */
function proxOf(a, b, sameSessNeighbor, gapDays) {
  if (sameSessNeighbor === 'adjacent') return 1
  if (sameSessNeighbor === 'near') return 0.7
  if (!gapDays) return 0.4
  if (gapDays <= 1) return 0.6
  if (gapDays <= 3) return 0.45
  return 0.2
}

/** 前件状态：挂着最值得接；收起次之；空未知。 */
function statusOf(a) {
  if (a.status === '挂着') return 1
  if (a.status === '收起') return 0.5
  return 0.4
}

function hasCue(row) {
  const e = extra(row)
  const text = [row.title, row.summary, e.cause, e.process, e.result, ...toList(row.quotes)].join('\n')
  return CUE_WORDS.test(text) ? 0.6 : 0
}

/**
 * 生成候选对。
 * @param {object[]} rows events_v2 的行（已按 start_at 排序）
 * @param {object} [opt] { threshold: 0.5, weak: 0.35, maxPerNode: 4 }
 * @returns {Array} [{ from, to, score, parts, why }]
 */
export function scoreCandidates(rows, { threshold = 0.5, weak = 0.35, maxPerNode = 4 } = {}) {
  const out = []
  const byDay = new Map()
  for (const r of rows) {
    const k = r.day || String(r.start_at || '').slice(0, 10)
    if (!byDay.has(k)) byDay.set(k, [])
    byDay.get(k).push(r)
  }
  for (const [day, list] of byDay) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      // ① 同会话相邻
      const b = list[i + 1]
      if (b && a.session_id && a.session_id === b.session_id) {
        const parts = { overlap: overlapOf(a, b), prox: 1, status: statusOf(a), cue: hasCue(a) || hasCue(b) }
        out.push(make(a, b, parts, '同会话相邻', { threshold, weak }))
      }
      // ② 同专名跨天：同一天后面的件 + 别的天
      const aCues = cues(a)
      if (!aCues.length) continue
      for (let j = i + 1; j < list.length; j++) {
        const b2 = list[j]
        if (!b2 || !b2.quotes) continue
        const ov = overlapOf(a, b2)
        if (ov < 0.5) continue
        const parts = { overlap: ov, prox: 0.6, status: statusOf(a), cue: hasCue(a) || hasCue(b2) }
        out.push(make(a, b2, parts, '同专名跨天', { threshold, weak }))
      }
    }
  }
  // 跨天同专名：不同天的件，专名重叠
  const days = [...byDay.keys()].sort()
  for (let d = 0; d < days.length; d++) {
    for (let e = d + 1; e < days.length; e++) {
      const gap = e - d
      for (const a of byDay.get(days[d])) {
        for (const b of byDay.get(days[e])) {
          const ov = overlapOf(a, b)
          if (ov < 0.5) continue
          out.push(make(a, b, { overlap: ov, prox: proxOf(a, b, '', gap), status: statusOf(a), cue: hasCue(a) || hasCue(b) }, '同专名跨天', { threshold, weak, gap }))
        }
      }
    }
  }
  // ③ 开放环接续：挂着的件，被后面提到它专名的件接上（优先级最高）
  const openList = rows.filter((r) => r.status === '挂着')
  for (const o of openList) {
    const oCues = new Set(cues(o))
    if (!oCues.size) continue
    let n = 0
    for (const b of rows) {
      if (n >= 3) break
      if (b.id === o.id) continue
      if (String(b.start_at) <= String(o.start_at)) continue
      if (!cues(b).some((c) => oCues.has(c))) continue
      n++
      out.push(make(o, b, { overlap: 1, prox: 0.7, status: 1, cue: hasCue(b) }, '接续挂着的', { threshold, weak }))
    }
  }

  // 去重（同一对多来源时合并来源，不丢依据）+ 限每节点候选数
  const idx = new Map()
  const uniq = []
  for (const c of out.sort((x, y) => y.score - x.score)) {
    const k = c.from + '>' + c.to
    if (idx.has(k)) {
      const prev = uniq[idx.get(k)]
      if (!prev.why.includes(c.why)) prev.why = prev.why + ' / ' + c.why
      continue
    }
    idx.set(k, uniq.length)
    uniq.push(c)
  }
  const perNode = new Map()
  const kept = []
  for (const c of uniq) {
    const n = perNode.get(c.from) || 0
    if (n >= maxPerNode) continue
    perNode.set(c.from, n + 1)
    kept.push(c)
  }
  return kept
}

function make(a, b, parts, why, { threshold = 0.5, weak = 0.35 } = {}) {
  let score = 0.35 * parts.overlap + 0.35 * parts.prox + 0.2 * parts.status + 0.1 * parts.cue
  // 同会话相邻本身是最强信号：不看专名也至少进模型档
  if (why === '同会话相邻') score = Math.max(score, 0.55)
  // 接续挂着的：开放环被接上，优先级最高
  if (why === '接续挂着的') score = Math.max(score, 0.7)
  return {
    from: a.id, to: b.id, score: Number(score.toFixed(3)),
    tier: score >= threshold ? 'model' : score >= weak ? 'weak' : 'drop',
    parts, why,
  }
}
