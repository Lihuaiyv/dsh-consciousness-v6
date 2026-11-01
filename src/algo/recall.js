/**
 * 召回算法实现：recall@v2（现行）与 recall@v2b（对照，证明可切换）
 * 可提取性 R 走 decay 注册表，不再内嵌公式。
 *
 * 查询构造说明（2026-10 修）：memory_fts 是 `tokenize='trigram'`，
 * 只认 **≥3 字**的子串；把整句用户话当一个短语塞进去，几乎永远 0 命中。
 * 所以这里把查询拆成 3-gram（喂 FTS）+ 2-gram（兜底 LIKE），OR 起来。
 */

import { run as registryRun } from './registry.js'
import { bandOf, heatOf, touch } from '../modules/tiers.js'

/** 中文连续段 / 英文数字段。标点在正则里天然断开，不会被当成词。 */
function segments(q) {
  return String(q || '').match(/[\u4e00-\u9fff]+|[a-zA-Z0-9]{2,}/g) || []
}

/** 查询里所有 n-gram，去重；长段整体也留一个（≥3 字时 trigram 能直接命中）。 */
function ngrams(q, n) {
  const out = new Set()
  const seen = new Set()
  for (const seg of segments(q)) {
    for (let i = 0; i + n <= seg.length; i++) {
      const g = seg.slice(i, i + n)
      if (!seen.has(g)) { seen.add(g); out.add(g) }
      if (out.size >= 32) return [...out]
    }
  }
  return [...out]
}

/** FTS 查询：3-gram OR；trigram 分词器只认 ≥3 字，2 字及以下交给 LIKE。 */
export function buildFtsQuery(q) {
  const terms = ngrams(q, 3)
  if (!terms.length) return null
  return terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
}

/**
 * LIKE 兜底词：只在**短问题**上用。
 * 长句子里塞 2-gram 会把「现在」「还要」这种泛词当证据，召回一堆无关记忆，
 * 比召回不到更糟（污染 prompt）。宁可空着，退回静态 top-10。
 */
export function buildLikeTerms(q) {
  const compact = String(q || '').replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, '')
  if (!compact || compact.length > 6) return []
  const out = new Set([compact])
  for (const t of ngrams(q, 2)) {
    out.add(t)
    if (out.size >= 4) break
  }
  return [...out]
}

function fetchCandidates(db, aid, query, pool = 50) {
  const lim = Math.max(10, Math.min(200, Number(pool) || 50))
  let rows = []
  const fq = buildFtsQuery(query)
  if (fq) {
    try {
      rows = db.prepare(`SELECT m.*, bm25(memory_fts) AS rank FROM memory_fts
        JOIN memory_items m ON m.id=memory_fts.id
        WHERE memory_fts MATCH ? AND m.agent_id=? AND m.status='active' AND m.invalid_at IS NULL
        ORDER BY rank LIMIT ?`).all(fq, aid, lim)
    } catch { rows = [] }
  }
  if (!rows.length) {
    const terms = buildLikeTerms(query)
    if (terms.length) {
      const where = terms.map(() => 'text LIKE ?').join(' OR ')
      try {
        rows = db.prepare("SELECT *, 0 AS rank FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND (" + where + ") LIMIT ?")
          .all(aid, ...terms.map((t) => '%' + t + '%'), lim)
      } catch { rows = [] }
    }
  }
  return rows
}

function scoreAndPick(rows, opt, decayRun, ctx) {
  const k = Math.max(1, Math.min(20, Number(opt.k || 8)))
  const budget = Number(opt.budget || 512)
  const relW = Number(opt.rel ?? 0.6)
  const retrW = Number(opt.retr ?? 0.25)
  const weightW = Number(opt.weight ?? 0.15)
  // 关系加成：记忆挂在熟人/主人名下时多算一点（0 = 不看关系）
  const relationW = Math.max(0, Math.min(1, Number(opt.relation) || 0))
  const relationMap = opt.relMap instanceof Map ? opt.relMap : null
  /* 心情一致加成（mood-congruent recall）：心情与这条记忆出生时的效价同号 → 加分。
     mood 取慢情绪（-1~+1），valence 是记忆出生时的效价；乘积天然带符号。 */
  const mood = Math.max(-1, Math.min(1, Number(opt.mood) || 0))
  const moodW = Math.max(0, Math.min(1, Number(opt.moodW) || 0))
  // 遗忘阈值：可提取性 R 低于它就「想不起来了」。默认 0 = 不设门槛（旧行为）。
  const floor = Math.max(0, Math.min(0.9, Number(opt.floor) || 0))
  const nowMs = Date.now()
  const scored = rows.map((r) => {
    // bm25() 是负数（越负越相关），旧的 max(0, rank) 会把它压成 0 → 相关性恒等于 1。
    // 这里取 -rank 做归一，最相关的 rel≈0.5~1，弱命中会明显掉下去。
    const bm = Number(r.rank || 0)
    const rel = 1 / (1 + Math.max(0, -bm))
    const R = Number(decayRun(r).R || 0)
    if (floor > 0 && R < floor) return null
    // 跟面板一样现算：库里的 heat/band 是巡检快照，白天会飘，不能拿来加档位偏置
    const h = heatOf(r, nowMs)
    const band = bandOf(r, h, nowMs)
    const relation = relationMap && relationW ? relationW * (relationMap.get(r.id) || 0) : 0
    const valence = Math.max(-1, Math.min(1, Number(r.valence) || 0))
    const moodBonus = moodW && mood ? moodW * mood * valence : 0
    const base = relW * rel + retrW * R + weightW * Number(r.weight || 0.5) + relation + moodBonus
    // 档位只加一个小偏置（短期 +0.03 / 中期 +0.015 / 长期 0）。
    // 不能乘在总分上：那会让「档位高但只是勉强相关」的条目压过真正相关的那条。
    const tierBonus = band === 'short' ? 0.03 : band === 'mid' ? 0.015 : 0
    return [r, base + tierBonus, band]
  }).filter(Boolean).sort((a, b) => {
    const d = b[1] - a[1]
    if (Math.abs(d) > 1e-9) return d
    return (Date.parse(b[0].created_at) || 0) - (Date.parse(a[0].created_at) || 0)
  })
  const picked = []
  let used = 0
  for (const [r, score, band] of scored.slice(0, k)) {
    const cost = Math.max(1, Math.floor(r.text.length / 2))
    if (used + cost > budget) continue
    picked.push({ id: r.id, text: r.text, score: Math.round(score * 1000) / 1000, band })
    used += cost
  }
  // 被想起来 = 强化一次。测试里传 touch:false 可以关掉，避免污染断言。
  if (ctx && ctx.db && opt.touch !== false && picked.length) {
    try { touch(ctx.db, picked.map((x) => x.id), nowMs) } catch { /* 记账失败不影响召回 */ }
  }
  return { items: picked, tokens: used, count: picked.length }
}

function makeRecall(version, defaults) {
  return {
    name: 'recall',
    version,
    kind: 'recall',
    metrics: ['memory.recall_hit', 'memory.ndcg5', 'sys.algo_switch'],
    run(ctx, input = {}) {
      const db = ctx.db
      const aid = ctx.aid
      const query = input.query
      const opt = {
        rel: input.rel != null ? Number(input.rel) : defaults.rel,
        retr: input.retr != null ? Number(input.retr) : defaults.retr,
        weight: input.weight != null ? Number(input.weight) : defaults.weight,
        floor: input.floor != null ? Number(input.floor) : 0,
        k: input.k != null ? input.k : 8,
        budget: input.budget != null ? input.budget : 512,
        pool: input.pool != null ? Number(input.pool) : 50,
        relation: input.relation != null ? Number(input.relation) : 0,
        relMap: input.relMap,
        mood: input.mood != null ? Number(input.mood) : 0,
        moodW: input.moodW != null ? Number(input.moodW) : 0,
        touch: input.touch,
      }
      const decayVer = String(input.decayVersion || 'v1')
      const decayRun = (row) => registryRun('decay', decayVer, ctx, { row, scale: input.decayScale })
      const rows = fetchCandidates(db, aid, query, opt.pool)
      const out = scoreAndPick(rows, opt, decayRun, ctx)
      out.algo = { name: 'recall', version, decay: decayVer }
      return out
    },
  }
}

/** 现行默认：0.6·rel + 0.25·retr + 0.15·weight */
export const recallV2 = makeRecall('v2', { rel: 0.6, retr: 0.25, weight: 0.15 })

/** 对照版：抬高相关性、压低可提取性与条权，用于证明切换不改调用方 */
export const recallV2b = makeRecall('v2b', { rel: 0.7, retr: 0.2, weight: 0.1 })
