/**
 * 切事件 v2（ES-Mem 路线）——**未接线，别 import 进生产路径**。
 *
 * 隔离要求：这份文件不 import src/modules/event_split.js，不读旧的冷/热库，不碰 hot_events。
 * 唯一入口：docs/功能/2-记忆-写与切事/切事件-基石/基石-切事件-2026-11-17.md
 *
 * 分工（照基石 §4）：
 *   ① loadRows           读碎片（只读 fragments）
 *   ② embedRows          算向量（注入 model.embed）
 *   ③ splitSegments      自然段：≥4 小时断开 / 换 session 断开（这不是「切」，只是分堆）
 *   ④ candidateBoundaries 段内相邻耦合度 → 低分位候选点
 *   ⑤ refineBoundaries   只对候选点：取前后 L 轮，模型在固定标签里选 + 置信度
 *   ⑥ buildEvents        真边界之间的连续区间成一件（成员由代码算，不交给模型）
 *   ⑦ writeEventsV2      写 events_v2 + event_members
 *   ⑧ describeBoundary   Level 1：写「A 结束了，转到 B」那句当检索锚
 *
 * 现在（2026-11-17）：①②③④ 已实现，⑤⑥⑦⑧ 还是 TODO。
 */

import crypto from 'node:crypto'
import { localDayBounds } from '../db.js'

export const V2_NOTE = '切事件 v2：读碎片 / 候选边界 / 写事件库 v2 已实现；worker 未接线'

/** Stage 2 固定标签集，不许模型自由发挥（基石 §4.3）。 */
export const BOUNDARY_LABELS = ['Topic_Shift', 'Topic_Intro', 'Detail_Elaborate', 'Direct_Resp']
export const BOUNDARY_POSITIVE = new Set(['Topic_Shift', 'Topic_Intro'])

/** 自然段：相邻两句隔 ≥4 小时就算断开；换 session 也断开。 */
export const GAP_MS = 4 * 3600 * 1000

const NOISE = [
  /^You are the Team Lead named/,
  /^\[SCHEDULE/,
  /^Delegation depth/,
  /^Repeated tool call detected/,
  // 2026-11-18：宿主的配置变更通报。写口 text.js 已补（以后不入库），
  // 这里兜历史：库里那批旧行读的时候剔掉，别让它们变成件的起句。
  /^The user changed the approval policy/,
  /^You are repeating the (?:exact )?same tool call/,
  // 2026-11-18：宿主派子代理的任务书（1000+ 字、整条无一句人话）。
  // 11-14 那天 11 个 <5 句「碎件」里有 4 个就是它；全库约 28 条。写口 text.js 同步修。
  /^(?:你是一个「[^」]{1,12}」子代理|你是本会话的团队成员|你是编码助手，工作目录|你是研究助理。任务：|你是实验执行员|你是情绪标注员[。，,]|你是(?:一个)?判定器[，。：]|你是只读审阅员[。，]|你是(?:严格的)?(?:文档审稿人|反方辩护人|实现核查员))/,
  /^(```|[{[]|\||## )/,
]

/** 这句是不是机器话（不是任何一件「事」的原料）。 */
export function isNoise(text) {
  const t = String(text || '').trim()
  if (!t) return true
  return NOISE.some((re) => re.test(t))
}

/**
 * ① 读碎片：本地日窗口内的用户/我发言，按时间升序。
 * 只读 fragments；日界用 localDayBounds（本地 +08），不用 day 列（那是 UTC 日期）。
 */
export function loadRows(db, aid, day) {
  const { start, end } = localDayBounds(day)
  // 2026-11-19 主人定：子代理会话照进碎片库（审计用），但不进切事。
  // 子代理会话的 id 是纯 uuid（8-4-4-4-12），主会话是 dsh:… / session-…；按会话来源挡，比按内容花样挡干净。
  // 2026-11-19 主人定：子代理会话照进碎片库（审计用），但进库时就明确标出来；切事读口按标记 + 会话来源挡。
  // 新行由 appendTurn 写 meta.sessionKind='sub'；旧行没有标记，用纯 uuid 格式兜底。
  const rows = db.prepare(`SELECT id, turn_id, role, text, created_at, session_id
    FROM fragments
    WHERE agent_id=? AND role IN ('user','assistant') AND created_at >= ? AND created_at < ?
      AND session_id NOT LIKE '________-____-____-____-____________'
      AND COALESCE(json_extract(meta,'$.sessionKind'),'') <> 'sub'
    ORDER BY created_at`).all(aid, start, end)
  const clean = []
  for (const r of rows) {
    const t = String(r.text || '').trim()
    if (isNoise(t)) continue
    clean.push({ ...r, text: t })
  }
  // 2026-11-18：同一条消息补发（「我想到一句又发一条，第二条带上前一条全文」）时只留后一条。
  // 库不动（碎片只追加），只在这次读里合并。远距离的重复句仍按原逻辑去重。
  const merged = keepLaterContinuations(clean)
  const seen = new Set()
  const deduped = []
  for (const r of merged) {
    const key = String(r.role) + '\u0001' + r.text
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(r)
  }
  return { rows, clean: deduped }
}

/**
 * 相邻、同会话、同角色、5 分钟内：后一条是前一条的全文加料（或一模一样）→ 留后一条。
 * 反过来（前一条更全）就丢后一条，不拿半截换全文。
 */
function keepLaterContinuations(list) {
  const WINDOW = 5 * 60 * 1000
  const out = []
  for (const r of list) {
    const prev = out[out.length - 1]
    const dt = prev ? Date.parse(r.created_at) - Date.parse(prev.created_at) : Infinity
    if (prev && prev.role === r.role && prev.session_id === r.session_id && dt >= 0 && dt <= WINDOW) {
      const a = String(prev.text || '')
      const b = String(r.text || '')
      if (b === a || (b.startsWith(a) && b.length > a.length)) { out[out.length - 1] = r; continue }
      if (a.startsWith(b) && a.length > b.length) continue
    }
    out.push(r)
  }
  return out
}

/** ③b 按会话分组：同一渠道的流各自独立，互不当邻居。
 *  2026-11-17 查出来：会话是并行的（11-16 有 9 个会话，时间交叠），
 *  当成一条时间线滑窗会把 A 渠道的话和 B 渠道的话拼成邻居。 */
export function groupBySession(rows) {
  const map = new Map()
  for (const r of rows) {
    const k = String(r.session_id || '')
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(r)
  }
  return [...map.entries()].map(([session_id, list]) => ({ session_id, rows: list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)) }))
}

/** ③ 自然段：只按 ≥4 小时断开。
 *  2026-11-17 实测：按 session 断开太狠——11-16 一天 583 条会被切成 136 段（平均 4 条一段），
 *  相邻耦合度全被切断，候选边界没法看。会话只是「渠道」变了，人还是同一个人在说话。 */
export function splitSegments(rows) {
  const segs = []
  let cur = []
  for (const r of rows) {
    const prev = cur[cur.length - 1]
    if (prev && (Date.parse(r.created_at) - Date.parse(prev.created_at)) >= GAP_MS) { segs.push(cur); cur = [] }
    cur.push(r)
  }
  if (cur.length) segs.push(cur)
  return segs
}

/** 皮尔逊相关（ES-Mem 用它算相邻向量的耦合）。 */
export function pearson(a, b) {
  const n = Math.min(a.length, b.length)
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i] }
  ma /= n; mb /= n
  let num = 0, da = 0, db2 = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb
    num += x * y; da += x * x; db2 += y * y
  }
  return num / (Math.sqrt(da * db2) + 1e-12)
}

/** 耦合度：互信息 I = -½·log(1-ρ²)。越小越像换事。 */
export function coupleMI(rho) {
  const r2 = Math.min(0.9999, rho * rho)
  return -0.5 * Math.log(1 - r2)
}

/**
 * ② 算向量：批量喂给注入的 embed(texts) => number[][]。
 * 一次 32 条（Ollama /v1/embeddings 单批够用）。
 */
export async function embedRows(rows, embed, { batch = 32, slice = 160 } = {}) {
  const out = []
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch).map((r) => String(r.text || '').slice(0, slice))
    const vecs = await embed(part)
    if (!Array.isArray(vecs) || vecs.length !== part.length) throw new Error('embed 返回条数不对：' + (vecs && vecs.length))
    out.push(...vecs)
  }
  return out
}

/**
 * ④ 候选边界：**只在段内**算相邻耦合度，跨段的相邻对不参与（跨段本来就是断的）。
 * 返回 [{ segIdx, i, at, rho, mi }]，i 是全局行号（段内第 0 条 = 边界后那一条）。
 */
export function candidateBoundaries(rows, vecs, { quantile = 0.04 } = {}) {
  const segs = splitSegments(rows)
  const score = []
  let offset = 0
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s]
    for (let k = 1; k < seg.length; k++) {
      const i = offset + k
      const rho = pearson(vecs[i - 1], vecs[i])
      score.push({ segIdx: s, i, at: rows[i].created_at, rho, mi: coupleMI(rho) })
    }
    offset += seg.length
  }
  if (!score.length) return { segs, candidates: [], threshold: null, scored: 0, stats: { score: 0 } }
  const sorted = [...score].sort((a, b) => a.mi - b.mi)
  const cut = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * quantile)))
  const threshold = sorted[cut].mi
  const candidates = score.filter((x) => x.mi <= threshold)
  return { segs, candidates, threshold, scored: score.length, all: score }
}

// TODO(⑥)：buildEvents —— 真边界之间的连续区间成一件；成员由代码按区间填
// TODO(⑧)：describeBoundary —— Level 1 那句检索锚

/** 泛词：当抓手等于没抓手。只挡「谁都说得出口」的词，不挡专名。 */
const CUE_STOP = new Set([
  '继续', '好了', '好的', '这个', '那个', '这里', '那里', '问题', '事情', '东西', '事情',
  '工作', '生活', '时间', '一下', '一句', '两句', '我们', '你们', '他们', '什么', '怎么',
  '为什么', '可以', '不是', '没有', '就是', '然后', '现在', '刚才', '之前', '两个', '三个',
  '上面', '下面', '一个', '自己', '这样', '那样', '是的', '对的', '行', '好', '嗯', '收到',
])

/** 抓手清洗：去标点、挡泛词、挡半句、必须能在这一件的原文里找到。 */
function cleanCues(list, src) {
  const out = []
  for (const c0 of Array.isArray(list) ? list : []) {
    const c = String(c0 || '').trim().replace(/[，。！？、；：""''（）【】\s]/g, '')
    if (!c || c.length < 2 || c.length > 12) continue
    if (CUE_STOP.has(c)) continue
    if (src && !src.includes(c)) continue
    if (out.includes(c)) continue
    out.push(c)
    if (out.length >= 6) break
  }
  return out
}

/**
 * ⑦ 写事件库 v2：events_v2 + event_members，同一事务、幂等。
 *
 * 输入：`{ day, events: [{ title, summary, quotes[], cues[], fragmentIds[],
 *          cause?, process?, result?, place?, who?, realm?, anchors?, status?, weight?, confidence? }] }`
 * 输出：`{ added, skipped, failed, ids, errors }`
 *
 * 三条硬规矩：
 *   1. **整批先验**：任何一条缺 title/summary/碎片，整批一条不写（不半批落地）；
 *   2. **时间自己查**：start/end 取碎片的真实 MIN/MAX，不信调用方；
 *   3. **成员是权威**：event_members 由这份 fragmentIds 填，turn_ids 只是副本。
 */
export function writeEventsV2(db, aid, { day, events, cutRev = 1, mode = null, quality = 'model', now = null, replace = false } = {}) {
  const out = { added: 0, skipped: 0, failed: 0, removed: 0, ids: [], errors: [] }
  const list = Array.isArray(events) ? events : []
  if (!list.length || !day) {
    if (!day) { out.failed++; out.errors.push('no-day') }
    return out
  }
  const stamp = now || new Date().toISOString()
  const prepared = []
  for (const e of list) {
    const title = String((e && e.title) || '').trim().slice(0, 40)
    const summary = String((e && e.summary) || '').trim()
    const fragIds = [...new Set((Array.isArray(e && e.fragmentIds) ? e.fragmentIds : []).filter(Boolean))]
    if (!title || !summary || !fragIds.length) { out.failed++; out.errors.push('bad-event'); continue }
    const rows = db.prepare(
      `SELECT id, turn_id, text, created_at, session_id FROM fragments WHERE id IN (${fragIds.map(() => '?').join(',')}) ORDER BY created_at, seq`,
    ).all(...fragIds)
    if (rows.length !== fragIds.length) { out.failed++; out.errors.push('missing-fragment'); continue }
    prepared.push({ e, title, summary, fragIds, rows })
  }
  // 有一条不合格 → 整批不写
  if (out.failed || prepared.length !== list.length) { out.added = 0; out.skipped = 0; out.ids = []; return out }

  db.exec('BEGIN')
  try {
    // 2026-11-19 主人定：重切 = 把那天旧件清掉重写（不是新旧叠加）。
    // 只在整批验过之后才删，删的是这一天、这个 agent 的件；别的天一行不动。
    if (replace) {
      const oldIds = db.prepare('SELECT id FROM events_v2 WHERE agent_id=? AND day=?').all(aid, day).map((r) => r.id)
      if (oldIds.length) {
        const delM = db.prepare('DELETE FROM event_members WHERE event_id=?')
        for (const id of oldIds) delM.run(id)
        db.prepare('DELETE FROM events_v2 WHERE agent_id=? AND day=?').run(aid, day)
        out.removed = oldIds.length
      }
    }
    for (const p of prepared) {
      const { e, title, summary, fragIds, rows } = p
      const startAt = rows[0].created_at
      const endAt = rows[rows.length - 1].created_at
      const turnIds = [...new Set(rows.map((r) => r.turn_id).filter(Boolean))]
      // 2026-11-19：件属于哪条会话线（一件不跨会话；首碎片的会话就是这件的会话）
      const sessionId = String(e.sessionId || rows[0].session_id || '') || null
      const id = 'ev2_' + crypto.createHash('sha1')
        .update([aid, day, fragIds[0], fragIds[fragIds.length - 1], title].join('\u0001'))
        .digest('hex').slice(0, 16)
      if (db.prepare('SELECT id FROM events_v2 WHERE id=?').get(id)) { out.skipped++; continue }
      const srcText = rows.map((r) => r.text).join('\n')
      const quotes = (Array.isArray(e.quotes) ? e.quotes : [])
        .map(String).filter((s) => s && srcText.includes(s)).slice(0, 6)
      const cues = cleanCues(e.cues, srcText)
      const extra = JSON.stringify({
        cause: e.cause ?? null, process: e.process ?? null, result: e.result ?? null,
        place: e.place ?? null, who: e.who ?? null, realm: e.realm ?? null,
        anchors: Array.isArray(e.anchors) ? e.anchors : [],
        joined: Number(e.joined || 1),
      })
      db.prepare(`INSERT INTO events_v2(
        id, agent_id, day, start_at, end_at, turn_ids, session_id, boundary, boundary_kind, boundary_conf,
        title, summary, quotes, cues, status, mode, weight, quality, confidence, cut_rev, extra, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, aid, day, startAt, endAt, JSON.stringify(turnIds), sessionId,
        e.boundary ?? null, e.boundary_kind ?? null, e.boundary_conf ?? null,
        title, summary, JSON.stringify(quotes), JSON.stringify(cues),
        e.status ?? null, mode ?? e.mode ?? null,
        Number.isFinite(e.weight) ? e.weight : 0.5, quality,
        Number.isFinite(e.confidence) ? e.confidence : 0.5, cutRev, extra, stamp,
      )
      const im = db.prepare('INSERT INTO event_members(event_id, fragment_id, agent_id, day) VALUES(?,?,?,?)')
      for (const fid of fragIds) im.run(id, fid, aid, day)
      out.added++
      out.ids.push(id)
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* rollback 失败就别盖住原错 */ }
    out.added = 0
    out.ids = []
    out.failed += 1
    out.errors.push(String((err && err.message) || err).slice(0, 120))
  }
  return out
}

const SIDES_SYS = [
  '你在读一段真实聊天的左右两半。分别用一句不超过 12 个字的话说清：这一半在干什么。',
  '写「谁在做什么、对什么东西」，不要评价、不要写感受、不要写"讨论了一些问题"这种空话。',
  '说不清就写最具体的那一个动作，宁可窄不要宽。',
  '只输出 JSON，不要解释、不要代码块：{"left":"...","right":"..."}',
].join('\n')

/**
 * ⑥ 换事的判法：不问「换没换」，让模型分别给左右两半各写一句「在干什么」，
 * 再由代码比这两句像不像。像 → 同一件；不像 → 边界。
 * 理由：判别题容易被敷衍（全点头），生成题不好敷衍；而且顺手产出了标题。
 */
export async function describeSides(rows, candidate, { complete, L = 6 } = {}) {
  const before = rows.slice(Math.max(0, candidate.i - L), candidate.i)
  const after = rows.slice(candidate.i, Math.min(rows.length, candidate.i + L))
  const body = '【左】\n' + before.map((r) => (r.role === 'user' ? '主人：' : '我：') + r.text.slice(0, 200)).join('\n')
    + '\n【右】\n' + after.map((r) => (r.role === 'user' ? '主人：' : '我：') + r.text.slice(0, 200)).join('\n')
  let left = '', right = '', err = null
  try {
    const raw = await complete({ system: SIDES_SYS, text: body, maxTokens: 160 })
    const d = parseObj(raw) || {}
    left = String(d.left || '').trim().slice(0, 30)
    right = String(d.right || '').trim().slice(0, 30)
    if (!left || !right) err = 'empty-sides'
  } catch (e) { err = String((e && e.message) || e).slice(0, 120) }
  const sim = left && right ? titleSimilarity(left, right) : null
  return { ...candidate, left, right, sim, err }
}

/** ④b 滑窗波形：位置 i 处「前 w 句均值向量」对「后 w 句均值向量」的余弦。
 *  这是 TextTiling 的块相似度做法，比逐句相邻对比稳：一句话再长也带不歪整个窗。
 *  谷底（相似度低）= 可能在换事。纯算术，不调模型。 */
export function windowCurve(vecs, { w = 5 } = {}) {
  const mean = (list) => {
    const n = list[0].length
    const out = new Float64Array(n)
    for (const v of list) for (let k = 0; k < n; k++) out[k] += v[k]
    for (let k = 0; k < n; k++) out[k] /= list.length
    return out
  }
  const dot = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; return s }
  const norm = (a) => Math.sqrt(dot(a, a))
  const out = []
  for (let i = w; i <= vecs.length - w; i++) {
    const L = mean(vecs.slice(i - w, i))
    const R = mean(vecs.slice(i, i + w))
    out.push({ i, sim: dot(L, R) / (norm(L) * norm(R) + 1e-12) })
  }
  return out
}

/** 平滑：3 点移动平均，把单句噪声压掉。 */
export function smoothCurve(curve, k = 1) {
  return curve.map((p) => {
    let s = 0, n = 0
    for (let d = -k; d <= k; d++) {
      const q = curve.find((x) => x.i === p.i + d)
      if (q) { s += q.sim; n++ }
    }
    return { i: p.i, sim: s / (n || 1) }
  })
}

/** 找谷：局部极小 + 低于分位线。返回 [{i, sim, quantile}]。 */
export function findValleys(curve, { quantile = 0.2, smooth = 1 } = {}) {
  const c = smooth > 0 ? smoothCurve(curve, smooth) : curve
  if (!c.length) return []
  const sorted = [...c].sort((a, b) => a.sim - b.sim)
  const cut = sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * quantile)))].sim
  const out = []
  for (let k = 1; k < c.length - 1; k++) {
    if (c[k].sim <= c[k - 1].sim && c[k].sim <= c[k + 1].sim && c[k].sim <= cut) out.push({ ...c[k], quantile })
  }
  return out
}

/** 找谷并按「深度」排序（TextTiling 的 depth score）：
 *  谷深 = (左边最近的峰 - 谷) + (右边最近的峰 - 谷)。
 *  只看绝对值不行——一天里相邻窗的相似度总在 0.7~0.9，必须看它相对两边掉了多少。 */
export function findDeepValleys(curve, { smooth = 1 } = {}) {
  const c = smooth > 0 ? smoothCurve(curve, smooth) : curve
  if (c.length < 5) return []
  const valleys = []
  for (let k = 2; k < c.length - 2; k++) {
    if (!(c[k].sim <= c[k - 1].sim && c[k].sim <= c[k + 1].sim)) continue
    // 往左往右各找最近的峰
    let li = k - 1
    while (li > 0 && c[li - 1].sim >= c[li].sim) li--
    let ri = k + 1
    while (ri < c.length - 1 && c[ri + 1].sim >= c[ri].sim) ri++
    const depth = (c[li].sim - c[k].sim) + (c[ri].sim - c[k].sim)
    valleys.push({ ...c[k], depth, leftPeak: c[li].sim, rightPeak: c[ri].sim })
  }
  return valleys.sort((a, b) => b.depth - a.depth)
}

/** 只留深度前 k 名，且要求彼此至少隔 minGap 句（避免同一处分出好几个谷）。 */
export function pickBoundaries(deep, { k = 12, minGap = 8 } = {}) {
  const out = []
  for (const v of deep) {
    if (out.length >= k) break
    if (out.some((x) => Math.abs(x.i - v.i) < minGap)) continue
    out.push(v)
  }
  return out.sort((a, b) => a.i - b.i)
}

/**
 * ⑦ 二级切分：一件太长就在内部递归切，切点在「内部最深的那一刀」。
 * 停止条件：句子数 ≤ maxTurns、或这一刀深度 < minDepth（真的没信号，别硬切）。
 * 返回叶子区间 [{a, b, depth}]（a/b 是相对这件开头的下标）。
 */
export function splitRecursive(vecs, { w = 8, maxTurns = 40, minTurns = 12, minDepth = 0.05 } = {}) {
  const out = []
  const walk = (start, len, depthFromParent) => {
    if (len <= maxTurns) { out.push({ a: start, b: start + len, depth: depthFromParent }); return }
    const ww = Math.max(3, Math.min(w, Math.floor(len / 6)))
    if (len < ww * 2 + 2) { out.push({ a: start, b: start + len, depth: depthFromParent }); return }
    const slice = vecs.slice(start, start + len)
    const deep = findDeepValleys(windowCurve(slice, { w: ww }), { smooth: 1 })
    const best = deep[0]
    if (!best || best.depth < minDepth) { out.push({ a: start, b: start + len, depth: depthFromParent }); return }
    const cut = Math.max(minTurns, Math.min(len - minTurns, best.i))
    walk(start, cut, best.depth)
    walk(start + cut, len - cut, best.depth)
  }
  walk(0, vecs.length, null)
  return out
}

/** ⑥b 活跃区间：件可以跨很久，但中间未必有人在说话。
 *  相邻两句隔超过 gapMs（默认 2 小时）就是一段空档——空档不进件的"活跃时间"，
 *  但件本身不拆（同一件事等了一天，还是一件）。检索按活跃区间定位，不按起止。 */
export function activeSpans(rows, { gapMs = 2 * 3600 * 1000 } = {}) {
  const spans = []
  let cur = null
  for (const r of rows) {
    const t = Date.parse(r.created_at)
    if (!Number.isFinite(t)) continue
    if (!cur) { cur = { start: t, end: t, n: 1 }; continue }
    if (t - cur.end >= gapMs) { spans.push(cur); cur = { start: t, end: t, n: 1 } }
    else { cur.end = t; cur.n++ }
  }
  if (cur) spans.push(cur)
  return spans
}

/** 两句标题像不像：中文字二元组 Jaccard。0 = 完全不像，1 = 一样。 */export function titleSimilarity(a, b) {
  const grams = (s) => {
    const t = String(s || '').replace(/[\s，。、；：「」""''（）()\-—…]/g, '')
    const out = new Set()
    const arr = Array.from(t)
    if (arr.length === 1) out.add(arr[0])
    for (let i = 0; i < arr.length - 1; i++) out.add(arr[i] + arr[i + 1])
    return out
  }
  const A = grams(a), B = grams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

const REFINE_SYS = [
  '你在读一段真实聊天的局部，要判断：从「前」到「后」是不是换了一件新的事。',
  '',
  '「事」的定义（照 ES-Mem）：一段以稳定的主题或意图为中心的时间段；内部高度同质，',
  '边界由下面三种变化标记：',
  '  ① 话题切换：说的事情主体换了（从改代码换到聊晚饭）',
  '  ② 任务阶段变化：从讨论到动手、从做到验收这种阶段跳变',
  '  ③ 互动形态变化：从技术讨论变成情绪交流、从商量变成下指令',
  '',
  '不算换事的：同一件里的补充细节、紧接着回应、情绪起伏（恼一下又松下来）、把刚才那件事继续做下去。',
  '',
  '给 0 到 100 的整数（不要只给极限值，中间分是有意义的）：',
  '  0-20  明显还是同一件：补充细节、直接回应、同一件事往下做',
  '  20-40 有点偏，但主体没变',
  '  40-60 说不清',
  '  60-80 大概率换了一件（阶段跳变或主体变了）',
  '  80-100 明显换了另一件事',
  '',
  '例子：',
  '  前「显存占了 12G，得压一下上下文」/ 后「那下一步怎么做」→ 20（同一件在往下推）',
  '  前「我把这个文件写坏了」/ 后「链现在干净了，但太稀」→ 30（还在修同一件）',
  '  前「讨论模型配置和性能」/ 后「具体排查卡顿原因」→ 65（阶段从讨论转到排查）',
  '  前「验收完了，五样都在这」/ 后「那咱们今晚吃什么」→ 90（从干活转到吃饭）',
  '',
  '同一件里的情绪起伏不增高分。别怕给低分。',
  '只输出 JSON，不要解释、不要代码块：{"score":整数,"why":"一句话"}',
].join('\n')

function parseObj(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const tryObj = (t) => { try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : null } catch { return null } }
  const direct = tryObj(s)
  if (direct) return direct
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) { const v = tryObj(fence[1].trim()); if (v) return v }
  const obj = s.match(/\{[\s\S]*\}/)
  return obj ? tryObj(obj[0]) : null
}

/**
 * ⑤ 精炼：只对候选点取前后 L 轮，让模型给 0~100 的「换事程度」。
 * 2026-11-17 教训：先写成「四选一 + 置信度」，8b 把 24 个候选全判成 Topic_Shift（全点头）。
 * 问「是不是换了」比问「换了多少」更容易被顺着答，所以改成打分，阈值默认 60。
 */
export async function refineBoundaries(rows, candidates, { complete, L = 6, threshold = 60 } = {}) {
  const out = []
  for (const c of candidates) {
    const before = rows.slice(Math.max(0, c.i - L), c.i)
    const after = rows.slice(c.i, Math.min(rows.length, c.i + L))
    const body = '【前】\n' + before.map((r) => (r.role === 'user' ? '主人：' : '我：') + r.text.slice(0, 200)).join('\n')
      + '\n【后】\n' + after.map((r) => (r.role === 'user' ? '主人：' : '我：') + r.text.slice(0, 200)).join('\n')
    let score = null, why = '', err = null
    try {
      const raw = await complete({ system: REFINE_SYS, text: body, maxTokens: 200 })
      const d = parseObj(raw) || {}
      const n = Number(d.score)
      if (Number.isFinite(n)) score = Math.max(0, Math.min(100, n))
      else err = 'no-score:' + JSON.stringify(d).slice(0, 80)
      why = String(d.why || '').slice(0, 120)
    } catch (e) { err = String((e && e.message) || e).slice(0, 120) }
    out.push({
      ...c, score, why, err,
      peb: score === null ? 0 : score / 100,
      isBoundary: score !== null && score >= threshold,
    })
  }
  return out
}

/** ⑥ 成事：真边界之间的连续区间 = 一件。成员由区间算，不交给模型。 */
export function buildEvents(rows, refined) {
  const cuts = []
  for (const r of refined) if (r.isBoundary) cuts.push(r.i)
  const bounds = [0, ...cuts.sort((a, b) => a - b), rows.length]
  const events = []
  for (let k = 0; k < bounds.length - 1; k++) {
    const from = bounds[k], to = bounds[k + 1]
    if (to <= from) continue
    const slice = rows.slice(from, to)
    events.push({
      from, to,
      start_at: slice[0].created_at, end_at: slice[slice.length - 1].created_at,
      turns: slice.length,
      first: slice[0].text.slice(0, 60),
      last: slice[slice.length - 1].text.slice(0, 60),
      fragmentIds: slice.map((r) => r.id),
    })
  }
  return events
}
