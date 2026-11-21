/**
 * 事件库 v2 的判边（2026-11-19，影子，**不写库**）。
 *
 * 跟旧 event_causal.js 的分工：
 *   - 旧的那套读 cold_events / hot_events（旧链，已冻结）；
 *   - 这套读 events_v2 的件（新链），逐对判 ECI 九类，只返回候选边，写不写由调用方决定。
 *
 * 规矩照旧判边：
 *   - 只在同一会话内、按时间相邻的两件判（跨会话不判，跟切事一致）；
 *   - 必须从 A 或 B 的原文/摘要里一字不差抄一句当证据，抄不出答 none；
 *   - 先后发生不等于因果，说不清就 none。
 */
export const REL_PULL = {
  cause: 1, enable: 0.9, prevent: 0.8, revise: 0.9, resolve: 0.9,
  continue: 0.5, same: 1, contradict: -0.7, none: 0,
}

const PAIR_SYS = `你是事件关系判断员。给你 A 和 B 两件事的记叙，判断它们之间是什么关系。
关系只能是：
  same —— 同一件事的不同版本（说的是同一件事）
  continue —— 同一件事接着往下（不是因果；A 的尾巴被 B 接上就算，不要求 A 导致 B）
  cause —— A 导致 B
  enable —— A 让 B 成为可能
  prevent —— A 阻止了 B
  revise —— B 改写/推翻了 A 的结论
  resolve —— B 把 A 收尾了
  contradict —— 两件说法冲突
  none —— 没关系
注意：same 和 continue 不是因果——不要因为「A 不是 B 的原因」就判 none。
判之前先看两处：A 的结果/最后一句，B 的起因/第一句。A 还留着话头、B 把这话头接下去，或者 A 的事做完了、B 是同一批事的下一步，可以考虑 continue；但只是时间上碰巧挨着、话题已经换了，仍判 none。
如果 A 结束和 B 开始之间隔了三天以上，除非 A 明确留着等 B，别判 continue，倾向 none。
必须从 A 或 B 的原文里一字不差抄一句作为证据（至少十个字，整句抄，不许只抄半截）；抄不出就答 none。
先后发生不等于因果；说不清就 none。
只输出 JSON：{"relation":"","direction":"A_to_B|B_to_A","confidence":0~1,"evidence":"","why":"一句话：凭什么这么判"}`

function parseJson(raw) {
  const s = String(raw || '')
  try { return JSON.parse(s) } catch { /* 往下抠 */ }
  const i = s.indexOf('{'), j = s.lastIndexOf('}')
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)) } catch { /* 放弃 */ } }
  return null
}

const toList = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }

/** 判一对，返回候选边（不写库）。输入给足：标题 + 摘要 + 起因/经过/结果 + 专名 + 引文。 */
export async function judgePairV2(a, b, { complete, timeoutMs = 120000 } = {}) {
  if (typeof complete !== 'function') throw new Error('judgePairV2 需要注入 complete')
  const ex = (r) => { try { return JSON.parse(r.extra || '{}') } catch { return {} } }
  const block = (label, r) => {
    const e = ex(r)
    const quotes = toList(r.quotes).slice(0, 3)
    const cues = toList(r.cues).slice(0, 4)
    return `${label}（${String(r.start_at || '').slice(5, 16)}）「${r.title}」\n状态：${r.status || '空'}\n摘要：${String(r.summary || '').slice(0, 220)}` +
      `\n起因：${String(e.cause || '').slice(0, 100)}｜经过：${String(e.process || '').slice(0, 140)}｜结果：${String(e.result || '').slice(0, 100)}` +
      `\n专名：${cues.join('/') || '无'}\n原文：${quotes.join(' / ') || '无'}`
  }
  const text = `${block('A', a)}\n\n${block('B', b)}\n\n时间：A 结束于 ${String(a.end_at || '').slice(5, 16)}，B 开始于 ${String(b.start_at || '').slice(5, 16)}，${gapText(a, b)}`
  let raw = ''
  try { raw = await complete({ system: PAIR_SYS, text, maxTokens: 200, timeoutMs }) } catch { raw = '' }
  const j = parseJson(raw)
  const rel = String((j && j.relation) || 'none').toLowerCase()
  const pull = REL_PULL[rel] != null ? REL_PULL[rel] : 0
  const evidence = String((j && j.evidence) || '').trim()
  const eA = ex(a), eB = ex(b)
  const pool = [a.summary, b.summary, eA.cause, eA.process, eA.result, eB.cause, eB.process, eB.result, ...toList(a.quotes), ...toList(b.quotes)].join('\n')
  // 2026-11-19：证据要整句命中、至少十个字——只切前 12 字比对会把「半截话」也放过去。
  const hit = evidence.length >= 10 && pool.includes(evidence)
  const ok = !!(rel && rel !== 'none' && pull !== 0 && hit && Number(j && j.confidence) >= 0.6)
  const dir = String((j && j.direction) || 'A_to_B')
  return {
    from: a.id, to: b.id,
    // 语义方向：revise/contradict 常是后件改前件，写库时按这个指边
    semanticFrom: dir === 'B_to_A' ? b.id : a.id,
    semanticTo: dir === 'B_to_A' ? a.id : b.id,
    kind: rel === 'none' ? 'none' : rel,
    pull, confidence: Number(j && j.confidence) || 0,
    direction: dir,
    evidence, why: String((j && j.why) || '').trim(),
    // 2026-11-19：判过的都要留档，含 none（负样本，防反复重判）
    record: rel !== undefined,
    ok, raw: String(raw).slice(0, 160),
  }
}

/** 2026-11-19：把 A 和 B 之间的时间间隔写进输入——隔太久不该判 continue。 */
function gapText(a, b) {
  const ms = Date.parse(b.start_at) - Date.parse(a.end_at)
  if (!Number.isFinite(ms) || ms < 0) return '时间重叠或倒序'
  const days = ms / 86400000
  if (days >= 1) return `隔了 ${days.toFixed(1)} 天`
  const mins = Math.max(1, Math.round(ms / 60000))
  return mins >= 60 ? `隔了 ${(mins / 60).toFixed(1)} 小时` : `隔了 ${mins} 分钟`
}

/**
 * 判一天：events_v2 当天、同一会话内相邻两件逐对判。
 * 另外给「某个会话在库里的第一件」打**线头**（threadHead）标记——2026-11-19 主人定：
 * 分叉会话按新会话走，第一件前面没有同会话的件；打标记不硬连，读口顺着专名去翻父会话。
 * @returns {Promise<{pairs:number, edges:object[], threadHeads:Array}>} 只返回候选，不写库。
 */
export async function judgeDayV2(db, aid, day, { complete, limit = 60 } = {}) {
  const rows = db.prepare(
    'SELECT id, session_id, start_at, end_at, title, summary, quotes, cues, status, extra FROM events_v2 WHERE agent_id=? AND day=? ORDER BY start_at',
  ).all(aid, day)
  const edges = []
  let pairs = 0
  for (let i = 0; i + 1 < rows.length && edges.length < limit; i++) {
    const a = rows[i], b = rows[i + 1]
    if (a.session_id && b.session_id && a.session_id !== b.session_id) continue
    pairs++
    edges.push(await judgePairV2(a, b, { complete }))
  }
  // 线头：这个会话在整个库里最早的那件（跨天也算），且它就在当天
  const firstOf = db.prepare('SELECT id FROM events_v2 WHERE agent_id=? AND session_id=? ORDER BY start_at LIMIT 1')
  const threadHeads = []
  for (const r of rows) {
    if (!r.session_id) continue
    const f = firstOf.get(aid, r.session_id)
    if (f && f.id === r.id) threadHeads.push({ eventId: r.id, sessionId: r.session_id, title: r.title })
  }
  return { pairs, edges, threadHeads }
}
