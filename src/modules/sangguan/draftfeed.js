/**
 * 草稿取料（P2）：从真实对话里找「取舍现场」，不做判断、不调模型。
 *
 * 为什么只找取舍：三观长歪不是闸门不严，是料不对。上一版从对话里抽「立场」，
 * 抽出来的全是工程记录。这一版只认一种东西——两个都说得通的做法，它选了其中一个，
 * 并且为此付了点什么。
 *
 * 规则是从 scripts/sangguan-draft.mjs 搬出来的，命令行和页面起草共用同一份，
 * 免得两边抽出来的东西不一样。字面规则，宁可少取，不许凑数。
 */

/** A. 诚实类：对方要求的不是「做对」，是「别说满 / 别猜 / 说人话 / 别糊弄」。 */
export const HONESTY = /(别猜|不要猜|不许猜|假数据|糊弄|骗我|骗人|人话|像模板|太满|太绕|别绕|敷衍|说实话|说真话|别捧|别夸|别装|先认错|又认错|不敢说|如实)/
/** B. 返工类：对方让她重来、再查。只作弱信号，因为多半是任务，不是取舍。 */
export const REDO = /(不对|不是这样|重新|重做|再检查|检查一下|再查|再试|试试|错了|漏了|断了|没对上|不好使|没生效)/
/** C. 自述取舍：她自己把「宁可 / 不如 / 没敢 / 代价」说出来了。 */
export const TRADEOFF = /(宁可|宁愿|不如|没敢|不敢|放弃|让步|慢一点|不糊|不凑|代价|没舍得)/
/** D. 客套与汇报，抽到直接丢。 */
export const NOISE = /^(好的|收到|嗯嗯|明白|我这就|已完成|搞定了|谢谢|好，)/

const HER = new Set(['assistant', 'agent']) // 老数据里两种角色名都有
const DEFAULT_LIMIT = 3000
const DEFAULT_MAX = 80

export function clip(s, n = 220) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** 没有指定 agent 时取话最多的那个（命令行用）。 */
export function pickAgent(db, want) {
  if (want) return want
  const row = db.prepare(
    "SELECT agent_id, COUNT(*) n FROM raw_turns WHERE text IS NOT NULL AND length(text) > 0 GROUP BY agent_id ORDER BY n DESC LIMIT 1",
  ).get()
  if (!row) throw new Error('库里没有可用的 agent')
  return row.agent_id
}

function loadTurns(db, aid, limit) {
  return db.prepare(`
    SELECT id, session_id, role, text, created_at
    FROM raw_turns
    WHERE agent_id = ? AND text IS NOT NULL AND length(trim(text)) > 0
    ORDER BY created_at DESC
    LIMIT ?
  `).all(aid, limit).reverse()
}

const hour = 3600 * 1000
const gapOk = (a, b) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 2 * hour

/** A / B：对方说了什么，她原来怎么做、后来改成什么。同一会话、两小时内才算。 */
export function mineCorrected(turns) {
  const out = []
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]
    if (t.role !== 'user') continue
    const honesty = HONESTY.test(t.text)
    const redo = REDO.test(t.text)
    if (!honesty && !redo) continue
    if (NOISE.test(t.text.trim())) continue
    if (t.text.length > 400) continue // 长段多半是需求，不是纠正
    let before = null
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      if (HER.has(turns[j].role) && turns[j].session_id === t.session_id) { before = turns[j]; break }
    }
    // 「她改成」只认紧接着的那一句：跨了十几分钟的下一段，多半是另一件事
    let after = null
    for (let j = i + 1; j < turns.length && j <= i + 2; j++) {
      if (HER.has(turns[j].role) && turns[j].session_id === t.session_id && gapOk(t.created_at, turns[j].created_at)) {
        after = turns[j]
        break
      }
    }
    if (!before) continue
    if (before.session_id !== t.session_id) continue
    if (!gapOk(t.created_at, before.created_at)) continue
    out.push({
      kind: honesty ? 'honesty' : 'redo',
      at: t.created_at,
      session: t.session_id,
      trigger: clip(t.text, 160),
      before: clip(before.text, 420),
      after: after ? clip(after.text, 320) : null,
      score: honesty ? 0.92 : 0.38,
    })
  }
  return out
}

/** C：她自己把取舍讲出来了。 */
export function mineStated(turns) {
  const out = []
  for (const t of turns) {
    if (!HER.has(t.role)) continue
    if (!TRADEOFF.test(t.text)) continue
    if (t.text.length > 800) continue
    out.push({
      kind: 'stated',
      at: t.created_at,
      session: t.session_id,
      trigger: null,
      before: clip(t.text, 420),
      after: null,
      score: 0.6,
    })
  }
  return out
}

/** D：承诺的结局。说过「我明天…」结果没做到，是最贵的一种取舍记录。 */
export function minePledges(db, aid) {
  const out = []
  try {
    const rows = db.prepare(`
      SELECT at, type, payload_json FROM claim_events
      WHERE agent_id = ? AND type IN ('NU_RESOLVE','VIOLATE')
      ORDER BY at DESC LIMIT 40
    `).all(aid)
    for (const r of rows) {
      let p = {}
      try { p = JSON.parse(r.payload_json || '{}') } catch { /* 坏数据跳过 */ }
      if (p.outcome && p.outcome !== 'miss') continue
      out.push({ kind: 'missed', at: r.at, session: null, trigger: null, before: clip(JSON.stringify(p), 300), after: null, score: 0.95 })
    }
  } catch { /* 没有账本 */ }
  return out
}

/** 同一句话被纠正过多次才算数；一次是偶然。这里只标次数，不合并。 */
export function countRepeats(list) {
  const key = (e) => (e.kind === 'missed' ? 'missed' : clip(e.trigger || '', 12))
  const n = new Map()
  for (const e of list) n.set(key(e), (n.get(key(e)) || 0) + 1)
  for (const e of list) e.repeat = n.get(key(e))
  return list
}

export function dedupe(list) {
  const seen = new Set()
  return list.filter((e) => {
    const k = (e.kind + '|' + clip(e.trigger || e.before, 40)).replace(/\s+/g, '')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * 取料主入口：{ meta, episodes }。meta 只放与时间无关的计数，时间戳由调用方补，
 * 同一份库同一批参数跑两次，结果一致（页面起草和命令行才敢共用）。
 */
export function mineEpisodes(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(20000, Number(opt.limit) || DEFAULT_LIMIT))
  const max = Math.max(1, Math.min(500, Number(opt.max) || DEFAULT_MAX))
  const turns = loadTurns(db, aid, limit)
  const eps = countRepeats(dedupe([...mineCorrected(turns), ...mineStated(turns), ...minePledges(db, aid)]))
    .sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)))
    .slice(0, max)
  const byKind = {}
  for (const e of eps) byKind[e.kind] = (byKind[e.kind] || 0) + 1
  return {
    meta: { agent: aid, turns_scanned: turns.length, episodes: eps.length, by_kind: byKind },
    episodes: eps,
  }
}
