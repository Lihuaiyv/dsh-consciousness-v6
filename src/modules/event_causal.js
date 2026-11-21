/**
 * 大因果体 · 底图（规则版，不调模型）。
 *
 * 按 `docs/功能/1-记忆-读与联想/思路-大因果体检索-2026-11-14.md` 来：
 *   §4.3 存一条关系：pull（−1~+1，符号是方向）+ direction + level + 证据 + 状态；kind 只作标签。
 *   §5.1 先认「同一件事」（same_as），只写边，**不自动合并事件**。
 *   §5.2 底图求「没有孤立事件」：same_as / adjacent / continue；孤立件连到同一天最近的一件。
 *   §7   底图只负责连通，不参与「体」的边界；体查询时算，不落表。
 *   §6.1 查询先认意图（why / next / settled / default），没有意图就不加因果行。
 *
 * 2026-11-16 主人定的两条：
 *   - 接可以多入多出（两条矛盾统一成一个 = 合题；一个想法散成几支 = 分叉），
 *     但**每条边都必须朝时间前进**（from 早、to 晚），图里永远没有环；
 *   - 「同一条线」按时间接：同一个会话里时间紧挨着的两段，就是同一件事的下一步。
 */
import { now } from '../db.js'

export const BASE_DAYS = 30            // 底图只看最近这么久（更老的边留着）
export const ADJ_GAP_MIN = 60          // 同一天挨着：相邻两件间隔 ≤ 60 分钟
export const SAME_SESSION_GAP_H = 0.33 // 同一个会话里「接着」：间隔 ≤ 20 分钟
export const CROSS_SESSION_DAYS = 7    // 跨会话同话题：最多隔这么久
export const PULL = {
  same_as: 1.0,      // 同一件事：折叠用，不参与因果排序（§4 表）
  continue: 0.5,     // 同一条线的下一步，不是因果
  adjacent: 0.3,     // 同一天挨着，只连通
  bridge: 0.3,       // 跨体桥（第一版不做，留位置）
  fallback: 0.2,     // 实在孤立：连到同一天最近的一件
}
export const CONFIRMED_PULL = 0.7      // confirmed 门槛（§5.5）
export const COVERAGE_TARGET = 0.95    // 底图覆盖（§5.6 / §10）
export const MAX_SPINE = 12            // 一条主轴最多几件；满了断开另起（线短，尾巴才是这条线自己的）

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const parseArr = (s) => {
  try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
}
const localDay = (iso) => {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 抓手算不算「专名」：含字母数字或 ≥3 字；排掉 IP、网址、路径、邮箱这些噪声（实测它们会乱连）。 */
const specific = (cue) => {
  const c = String(cue || '').trim()
  if (!c) return false
  if (/^[\d.,:]+$/.test(c)) return false
  if (/^[a-z]+:/i.test(c) || c.includes('://')) return false
  if (/[\\/]/.test(c) && /[.\\/][A-Za-z0-9]{1,6}$/.test(c)) return false
  if (/^[\w.-]+@[\w.-]+$/.test(c)) return false
  return /[A-Za-z0-9]/.test(c) || Array.from(c).length >= 3
}

/** 标题的 3 字滑窗覆盖度（§5.1 字面相似）。 */
export function gramOverlap(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s，。、；：！？「」『』（）()《》“”"'…—\-_·,.;:!?/\\|]/g, '')
  const s = norm(a), t = norm(b)
  if (s.length < 4 || t.length < 4) return 0
  const set = new Set()
  for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3))
  if (!set.size) return 0
  let hit = 0
  for (const g of set) if (t.includes(g)) hit++
  return hit / set.size
}

/** 亲密度四分量（§3）：因果强度 0.35 + 共有专名 0.25 + 字面重合 0.15 + 知道得早晚 0.25。带符号。 */
export const PULL_WEIGHTS = { relation: 0.35, cues: 0.25, literal: 0.15, proximity: 0.25 }

export function computePull(a, b, relation = 'none', opt = {}) {
  const w = { ...PULL_WEIGHTS, ...(opt.weights || {}) }
  const rel = REL_PULL[relation] != null ? REL_PULL[relation] : 0
  const relScore = Math.min(1, Math.abs(rel))
  const shared = (Array.isArray(a.cues) ? a.cues : []).filter((c) => specific(c) && (Array.isArray(b.cues) ? b.cues : []).includes(c)).length
  const cueScore = Math.min(1, shared / 2)
  const literal = gramOverlap(a.title, b.title)
  const ta = Date.parse(a.startAt), tb = Date.parse(b.startAt)
  const gapDays = Number.isFinite(ta) && Number.isFinite(tb) ? Math.abs(tb - ta) / 86400000 : 30
  const proximity = 1 / (1 + gapDays)
  const v = w.relation * relScore + w.cues * cueScore + w.literal * literal + w.proximity * proximity
  const sign = relation === 'contradict' ? -1 : 1
  return Number((sign * Math.min(1, Math.max(0, v))).toFixed(3))
}

/** 读出这几十天里的事件，形状统一（后面算候选都吃这个）。 */
export function loadEvents(db, aid, { nowMs = Date.now(), days = BASE_DAYS } = {}) {
  const since = new Date(nowMs - Math.max(1, days) * 86400000).toISOString()
  let rows = []
  try {
    rows = db.prepare(`SELECT h.id, h.title, h.story, h.cues, h.state, h.want,
        c.start_at, c.end_at, c.turn_ids, c.quotes, c.status, c.weight
      FROM hot_events h
      JOIN cold_events c ON c.id = json_extract(h.source_cold_ids, '$[0]')
      WHERE h.agent_id=? AND h.active=1 AND c.start_at >= ?
      ORDER BY c.start_at ASC`).all(aid, since)
  } catch { return [] }

  // 轮次 → 会话 + 轮次序号：**发生前后**看这个，不看墙钟（主人 2026-11-16 定）
  const turnMeta = new Map()
  try {
    for (const r of db.prepare(`SELECT turn_id, session_id, seq FROM fragments
      WHERE agent_id=? AND created_at >= ? AND turn_id IS NOT NULL AND session_id IS NOT NULL`).all(aid, since)) {
      if (!r.turn_id || !r.session_id) continue
      const prev = turnMeta.get(r.turn_id)
      if (!prev || (Number(r.seq) || 0) < (Number(prev.seq) || 0)) turnMeta.set(r.turn_id, { session: r.session_id, seq: Number(r.seq) || 0 })
    }
  } catch { /* 老库没有就退化成同一天 */ }

  return rows.map((r) => {
    const turns = parseArr(r.turn_ids)
    const metas = turns.map((t) => turnMeta.get(String(t))).filter(Boolean)
    const session = metas.length ? metas[0].session : ''
    const seq = metas.length ? Math.min(...metas.map((m) => m.seq)) : null
    return {
      id: r.id,
      title: r.title,
      story: r.story,
      cues: parseArr(r.cues),
      turns,
      quotes: parseArr(r.quotes),
      status: String(r.status || ''),
      weight: num(r.weight, 0.5),
      want: num(r.want, 0.25),
      state: r.state,
      session,
      seq,
      startAt: r.start_at,
      endAt: r.end_at || r.start_at,
      day: localDay(r.start_at),
    }
  }).filter((e) => e.startAt && Number.isFinite(Date.parse(e.startAt)))
}

/**
 * 算底图边（纯函数，不碰库）。
 * @returns {Array} [{ from_id, to_id, kind, direction, pull, level, confidence, evidence, reason, status, judge }]
 */
export function baseEdgesOf(items, opt = {}) {
  const adjGapMin = num(opt.adjGapMin, ADJ_GAP_MIN)
  const sessionGapH = num(opt.sessionGapH, SAME_SESSION_GAP_H)
  const list = [...items].sort((a, b) => (Date.parse(a.startAt) - Date.parse(b.startAt)) || (a.id < b.id ? -1 : 1))
  const out = []
  const seen = new Set()
  const push = (a, b, kind, pull, evidence, confidence) => {
    if (!a || !b || a.id === b.id) return
    const ta = Date.parse(a.startAt), tb = Date.parse(b.startAt)
    // 硬约束：边一律从早指向晚（同一时刻按 id 定序），保证图里没有环
    const forward = ta < tb || (ta === tb && a.id <= b.id)
    const from = forward ? a : b
    const to = forward ? b : a
    const key = `${from.id}|${to.id}|${kind}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      from_id: from.id, to_id: to.id, kind,
      direction: 'forward', pull, level: 0,
      confidence: Number(confidence != null ? confidence : Math.min(1, pull)),
      evidence: typeof evidence === 'string' ? evidence : JSON.stringify(evidence || {}),
      reason: '', status: 'confirmed', judge: 'rule',
    })
  }

  // ① same_as：同一件事（只写边，不合并）。turn 重叠 ≥1 或引文同句 → 高置信；标题近义 → 中等。
  const byTurn = new Map()
  for (const e of list) for (const t of e.turns) {
    const k = String(t || '').trim()
    if (!k) continue
    if (!byTurn.has(k)) byTurn.set(k, [])
    byTurn.get(k).push(e)
  }
  for (const [turn, arr] of byTurn) {
    if (arr.length < 2) continue
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      push(arr[i], arr[j], 'same_as', PULL.same_as, { turn }, 1)
    }
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j]
      const shared = a.quotes.find((q) => String(q).length >= 10 && b.quotes.some((q2) => String(q2).includes(String(q).slice(0, 20))))
      if (shared) { push(a, b, 'same_as', PULL.same_as, { quote: String(shared).slice(0, 40) }, 1); continue }
      // 标题近义：跨天也算（同一件事的重复切常常隔很久），门槛 0.7
      if (gramOverlap(a.title, b.title) >= 0.7) push(a, b, 'same_as', 0.8, { titleOverlap: 1 }, 0.8)
    }
  }

  // ② adjacent：同一天、时间上挨着的前后各 1 件（只负责「没有孤立事件」，不进体）
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i], b = list[i + 1]
    const gap = (Date.parse(b.startAt) - Date.parse(a.endAt)) / 60000
    if (a.day && a.day === b.day && gap <= adjGapMin) {
      push(a, b, 'adjacent', PULL.adjacent, { gapMin: Math.round(gap) })
    }
  }

  // 抓手 → 事件（跨会话同话题用）
  const byCue = new Map()
  for (const e of list) {
    for (const c of e.cues) {
      const k = String(c || '').trim()
      if (!k || !specific(k)) continue
      if (!byCue.has(k)) byCue.set(k, [])
      byCue.get(k).push(e)
    }
  }

  // ③ 主轴：**不建边**（2026-11-17 主人纠正）。
  //    文档定的是「轴、肉、体都不存，读的时候按门槛现算」；一度做成 kind='spine' 的存边是错的。
  //    主轴在读的时候由 loadBody 从种子出发按门槛收节点、按先后排出来，不是这里生成的。

  // ④ 跨会话的同一话题：两个专名抓手都对上才算（一个太松，实测会串成一大团）
  for (const e of list) {
    const count = new Map()
    for (const c of e.cues) {
      const k = String(c || '').trim()
      if (!k || !specific(k)) continue
      for (const other of byCue.get(k) || []) {
        if (other === e || (e.session && e.session === other.session)) continue
        count.set(other, (count.get(other) || 0) + 1)
      }
    }
    for (const [other, n] of count) {
      const gapDays = Math.abs(Date.parse(other.startAt) - Date.parse(e.startAt)) / 86400000
      if (n >= 2 && gapDays <= CROSS_SESSION_DAYS) {
        push(e, other, 'continue', PULL.continue, { sharedCues: n, gapDays: +gapDays.toFixed(1) })
      }
    }
  }

  return out
}

/** 底图覆盖率：有任一 confirmed 底图边的事件占多少（§10 验收线 ≥95%）。 */
export function coverageOf(db, aid) {
  try {
    const n = db.prepare('SELECT COUNT(*) n FROM hot_events WHERE agent_id=? AND active=1').get(aid).n
    const covered = db.prepare(`SELECT COUNT(DISTINCT id) n FROM (
      SELECT from_id id FROM event_edges WHERE agent_id=? AND status='confirmed' AND kind IN ('same_as','adjacent','continue')
      UNION SELECT to_id id FROM event_edges WHERE agent_id=? AND status='confirmed' AND kind IN ('same_as','adjacent','continue'))`).get(aid, aid).n
    return { events: n, covered, ratio: n ? covered / n : 0 }
  } catch { return { events: 0, covered: 0, ratio: 0 } }
}

/**
 * 建底图（幂等，只追加）。先把「没有孤立事件」做到；孤立件连到同一天最近的一件。
 */
export function buildBaseGraph(db, aid, { nowMs = Date.now(), days = BASE_DAYS } = {}) {
  const iso = new Date(nowMs).toISOString()
  const items = loadEvents(db, aid, { nowMs, days })
  if (!items.length) return { ok: true, events: 0, edges: 0, added: 0, coverage: coverageOf(db, aid) }

  const edges = baseEdgesOf(items)
  const touched = new Set()
  for (const e of edges) { touched.add(e.from_id); touched.add(e.to_id) }
  const byDay = new Map()
  for (const e of items) {
    if (!e.day) continue
    if (!byDay.has(e.day)) byDay.set(e.day, [])
    byDay.get(e.day).push(e)
  }
  for (const e of items) {
    if (touched.has(e.id)) continue
    const same = (byDay.get(e.day) || []).filter((x) => x.id !== e.id)
    if (!same.length) continue
    same.sort((a, b) => Math.abs(Date.parse(a.startAt) - Date.parse(e.startAt)) - Math.abs(Date.parse(b.startAt) - Date.parse(e.startAt)))
    const near = same[0]
    const [a, b] = Date.parse(e.startAt) <= Date.parse(near.startAt) ? [e, near] : [near, e]
    edges.push({
      from_id: a.id, to_id: b.id, kind: 'adjacent', direction: 'forward',
      pull: PULL.fallback, level: 0, confidence: PULL.fallback,
      evidence: JSON.stringify({ fallback: true }), reason: '孤立件：连到同一天最近的一件（只用于「那阵子在干嘛」）',
      status: 'confirmed', judge: 'rule',
    })
  }

  const ins = db.prepare(`INSERT OR IGNORE INTO event_edges
    (id,agent_id,from_id,to_id,kind,direction,pull,level,confidence,evidence,reason,status,judge,valid_from,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  let added = 0
  for (const e of edges) {
    try {
      const r = ins.run('edge_' + Math.random().toString(36).slice(2, 12), aid, e.from_id, e.to_id, e.kind,
        e.direction, e.pull, e.level, e.confidence, e.evidence, e.reason || '', e.status, e.judge, iso, iso, iso)
      added += Number(r.changes) || 0
    } catch { /* 单条写不进不影响别的 */ }
  }
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
      'evt_' + Math.random().toString(36).slice(2, 12), aid, 'event.causal.build',
      JSON.stringify({ events: items.length, edges: edges.length, added }), iso,
    )
  } catch { /* 记账失败不算错 */ }
  return { ok: true, events: items.length, edges: edges.length, added, coverage: coverageOf(db, aid) }
}

/**
 * 一个「体」：**一根主轴 + 挂在主轴上的跳线**（主人 2026-11-16 定）。
 *
 *   - 主轴（kind='spine'）：同一段对话里按轮次先后一颗接一颗，每件最多一个前驱一个后继。
 *     它只保证「谁先谁后」，不走跳线、不成环、不分叉。
 *   - 跳线（same_as / continue / bridge / 因果）：不是用来串的，是挂在珠子旁边的线，
 *     一个节点可以挂好几条，跨多远都行；读的时候只在需要往旁边看时用。
 *   - head = 主轴末端（这件事现在到哪了）；root = 主轴起点。
 * 不落表，查询时算（§3 / §7）。
 */
export function loadBodyLegacy(db, aid, eventId, { maxSpine = 60, maxJumps = 8, threshold = 0.25 } = {}) {
  const anchor = String(eventId)
  const empty = { id: anchor, spine: [], nodes: [], size: 0, root: null, head: null, joins: [], forks: [], jumps: [] }
  let edges = []
  try {
    edges = db.prepare(`SELECT from_id, to_id, kind, pull FROM event_edges
      WHERE agent_id=? AND status='confirmed' AND valid_to IS NULL`).all(aid)
  } catch { return empty }
  if (!edges.length) return empty

  // 主轴：一前一后
  const nextOf = new Map(), prevOf = new Map()
  for (const e of edges) {
    if (e.kind !== 'spine') continue
    nextOf.set(e.from_id, e.to_id)
    prevOf.set(e.to_id, e.from_id)
  }
  const order = [anchor]
  let cur = anchor
  while (prevOf.has(cur) && order.length < maxSpine) { cur = prevOf.get(cur); order.unshift(cur) }
  cur = anchor
  while (nextOf.has(cur) && order.length < maxSpine) { cur = nextOf.get(cur); order.push(cur) }
  const inSpine = new Set(order)

  // 同一件事的同伴（same_as 组）：折叠成一个点，但节点表里要把它们都带上，
  // 否则「体里只有一件」会把另外几个版本漏掉（2026-11-17 测试发现）。
  const sameGroup = new Set(order)
  for (const e of edges) {
    if (e.kind !== 'same_as') continue
    if (inSpine.has(e.from_id) || inSpine.has(e.to_id)) { sameGroup.add(e.from_id); sameGroup.add(e.to_id) }
  }
  const fetchIds = [...sameGroup]

  let rows = []
  try {
    rows = db.prepare(`SELECT h.id, h.title, h.story, h.want, h.state,
        c.start_at, c.end_at, c.status, c.weight
      FROM hot_events h JOIN cold_events c ON c.id=json_extract(h.source_cold_ids,'$[0]')
      WHERE h.agent_id=? AND h.id IN (${fetchIds.map(() => '?').join(',')})`).all(aid, ...fetchIds)
  } catch { return empty }
  const byId = new Map(rows.map((r) => [r.id, {
    id: r.id, title: r.title, story: r.story, want: num(r.want, 0.25),
    status: String(r.status || ''), startAt: r.start_at, endAt: r.end_at,
  }]))
  const spine = order.map((id) => byId.get(id)).filter(Boolean)
  if (!spine.length) return empty
  // 起点/末端取「这组节点里时间最早/最晚的」——同一件事折叠后，head 要指向最新的那个版本
  // （2026-11-17 测试发现：只取主轴链会漏掉折叠进来的版本，把旧版当成"现在"）
  const sortedAll = [...byId.values()].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
  const root = sortedAll[0]
  const head = sortedAll[sortedAll.length - 1]

  // 跳线：一端在主轴、另一端在主轴外的，各留一条；同一节点最多 2 条。
  // 门槛（threshold）决定"看得见多少"：门槛高只走最重的几条（这条线），门槛低把周围带出来。
  const jumpOut = new Map()
  for (const e of edges) {
    if (e.kind === 'spine') continue
    if (Math.abs(num(e.pull, 0)) < threshold) continue
    const a = inSpine.has(e.from_id), b = inSpine.has(e.to_id)
    if (a === b) continue
    const inside = a ? e.from_id : e.to_id
    const outside = a ? e.to_id : e.from_id
    const list = jumpOut.get(inside) || []
    if (list.length >= 2) continue
    if (list.some((x) => x.id === outside)) continue
    list.push({ id: outside, kind: e.kind, pull: num(e.pull, 0.3) })
    jumpOut.set(inside, list)
  }
  const jumps = []
  for (const [fromId, list] of jumpOut) {
    for (const j of list) {
      if (jumps.length >= maxJumps) break
      jumps.push({ from: fromId, ...j })
    }
  }
  // 跳线外端也取一下标题，拼句子要用
  const outsideIds = [...new Set(jumps.map((j) => j.id))].slice(0, maxJumps)
  if (outsideIds.length) {
    try {
      const more = db.prepare(`SELECT h.id, h.title FROM hot_events h WHERE h.agent_id=? AND h.id IN (${outsideIds.map(() => '?').join(',')})`).all(aid, ...outsideIds)
      const titleOf = new Map(more.map((r) => [r.id, r.title]))
      for (const j of jumps) j.title = titleOf.get(j.id) || j.id
    } catch { /* 取不到就算了 */ }
  }

  // 合题 / 分叉：主轴之外的多入多出（跳线也算）
  const joins = [], forks = []
  const inDeg = new Map(), outDeg = new Map()
  for (const e of edges) {
    if (e.kind === 'spine') continue
    outDeg.set(e.from_id, (outDeg.get(e.from_id) || 0) + 1)
    inDeg.set(e.to_id, (inDeg.get(e.to_id) || 0) + 1)
  }
  for (const n of spine) {
    if ((inDeg.get(n.id) || 0) >= 2) joins.push({ id: n.id, title: n.title })
    if ((outDeg.get(n.id) || 0) >= 2) forks.push({ id: n.id, title: n.title })
  }

  return { id: anchor, spine, nodes: spine, size: spine.length, root, head, joins, forks, jumps }
}

/**
 * 让模型判一对事件的关系（主干边；§5.4）。
 * 规矩照文档：必须抄一句原文当证据，抄不出就是 none；同一件事由规则处理，这里主要判因果/延续。
 * 只返回结果，不写库——写不写由调用方（影子和开关）决定。
 */
const REL_PULL = { cause: 1, enable: 0.9, prevent: 0.8, revise: 0.9, resolve: 0.9, continue: 0.5, same: 1, contradict: -0.7, none: 0 }
// 弱边（2026-11-17 主人定）：没有关系 ≠ 没有边。每两件事之间都有联系，只是强弱不同。
// 判 none 的给一个极小值，进图（status='weak'），读的时候按门槛（≥0.25）自然滤掉。
export const WEAK_PULL = 0.05

/**
 * 判边用哪个模型（2026-11-17 主人定）：**主模型 → 本地 → 规则**，一路往下降，每步都留标签。
 *   main：宿主主模型（质量高、按 token 计费）
 *   local：Ollama 本地模型（免费、慢）
 *   rule：两个都没通，只剩规则兜底——这时候**一条边都不判**（返回空），但标签照记，谁看都知道这天没真判。
 * 返回 { text, judge }：judge 就是这次到底谁判的。
 */
async function completeBy(db, { system, text, maxTokens, timeoutMs, temperature, model: m = '', via = 'local' }) {
  if (via === 'main') {
    try {
      // kernel 导出的是单例对象（export const model = createModel()），不是函数
      const kernel = await import('../kernel.js')
      const out = await kernel.model.chat([
        { role: 'system', content: system },
        { role: 'user', content: text },
      ], maxTokens, false, temperature)
      // 落到规则兜底 = 主模型其实没通（返回空壳）；**输出为空也当没通**，降级去本地。
      // 2026-11-17 实测：主模型调通了但吐回空字符串，被当成"判过了"，一晚上记了 530 件空判断。
      if (kernel.model.servedBy !== 'fallback' && String(out || '').trim()) return { text: out, judge: 'main' }
    } catch { /* 往下走本地 */ }
  }
  try {
    const { localComplete } = await import('./local_llm.js')
    // 判边/反事实是批量兜底：让切事和聊天先走（7=最低），本地只填主模型没通的那部分。
    const out = await localComplete(db, {
      system, text, maxTokens, timeoutMs, temperature,
      priority: 7,
      label: 'causal:' + String(via || 'local'),
      ...(m ? { model: m } : {}),
    })
    if (String(out || '').trim()) return { text: out, judge: 'local' }
  } catch { /* 往下走规则 */ }
  return { text: '', judge: 'rule' }
}

export async function judgePair(db, a, b, { timeoutMs = 180000, model = '', via = 'local' } = {}) {
  const system = `你是事件关系判断员。给你 A 和 B 两件事的摘要，判断它们之间是什么关系。
关系只能是：same（同一件事的不同版本）、continue（同一话题的下一步，不是因果）、cause（A 导致 B）、enable（A 让 B 可能）、prevent（A 阻止了 B）、revise（B 改写/推翻 A 的结论）、resolve（B 把 A 收尾了）、contradict（两件说法冲突）、none（没关系）。
必须从 A 或 B 的摘要里一字不差抄一句作为证据；抄不出就答 none。
先后发生不等于因果；说不清就 none。
只输出 JSON：{"relation":"...","direction":"A_to_B|B_to_A|both","confidence":0~1,"evidence":"...","why":"一句话：你凭什么这么判（想说清是哪一步让你这么想的）"}`
  const text = `A（${String(a.startAt || '').slice(5, 16)}）「${a.title}」\n${String(a.story || '').slice(0, 200)}\n\nB（${String(b.startAt || '').slice(5, 16)}）「${b.title}」\n${String(b.story || '').slice(0, 200)}`
  const t0 = Date.now()
  const r = await completeBy(db, { system, text, maxTokens: 300, timeoutMs, temperature: 0.1, model, via })
  const ms = Date.now() - t0
  const out = typeof r === 'string' ? r : (r && r.text) || ''
  const judge = (r && r.judge) || 'rule'
  let j = null
  try { j = JSON.parse(out) } catch { try { j = JSON.parse(String(out).slice(String(out).indexOf('{'), String(out).lastIndexOf('}') + 1)) } catch { j = null } }
  const rel = j && String(j.relation || '').trim().toLowerCase()
  const pull = REL_PULL[rel] != null ? REL_PULL[rel] : 0
  const evidence = String((j && j.evidence) || '').trim()
  const inText = evidence && (String(a.story || '').includes(evidence.slice(0, 12)) || String(b.story || '').includes(evidence.slice(0, 12)))
  // 抄不出原文 / 置信太低 / 关系不认识，都按 none 处理——宁可少连
  const usable = !!(rel && rel !== 'none' && pull !== 0 && evidence && inText && Number(j.confidence) >= 0.6)
  return {
    relation: rel || 'none', pull, confidence: Number(j && j.confidence) || 0,
    direction: String((j && j.direction) || 'A_to_B'), evidence, ms, judge,
    why: String((j && j.why) || '').trim(),
    ok: usable, raw: String(out).slice(0, 200),
  }
}

/**
 * 一次判一批：A 和它的几个候选 B，一次调用判完（省调用数，§5.4）。
 * @returns {Array} [{ b: 序号, relation, direction, pull, confidence, evidence, ok }]
 */
export async function judgeBatch(db, a, candidates, { timeoutMs = 240000, model = '', via = 'local' } = {}) {
  if (!a || !Array.isArray(candidates) || !candidates.length) return []
  const system = `你是事件关系判断员。给一件事 A 和几个候选 B1..Bn，逐个判断 A 和每个 B 的关系。
关系只能是：same（同一件事的不同版本）、continue（同一话题的下一步，不是因果）、cause（A 导致 B）、enable（A 让 B 可能）、prevent（A 阻止了 B）、revise（B 改写/推翻 A 的结论）、resolve（B 把 A 收尾了）、contradict（两件说法冲突）、none（没关系）。
必须从 A 或 B 的摘要里一字不差抄一句作为证据；抄不出就答 none。
先后发生不等于因果；说不清就 none。宁可多答 none。
只输出 JSON：{"pairs":[{"b":1,"relation":"...","direction":"A_to_B|B_to_A|both","confidence":0~1,"evidence":"...","why":"一句话：你凭什么这么判"}]}`
  const list = candidates.slice(0, 8)
  const quotesOf = (e) => (Array.isArray(e.quotes) ? e.quotes.map(String) : []).filter((q) => q.length >= 6).slice(0, 3).join(' ／ ').slice(0, 240)
  const block = (tag, e, storyLen) => `${tag}（${String(e.startAt || '').slice(5, 16)}）「${e.title}」\n经过：${String(e.story || '').slice(0, storyLen)}\n原话：${quotesOf(e) || '（没有存原话）'}`
  const text = `${block('A', a, 160)}\n\n` + list.map((b, i) => block(`B${i + 1}`, b, 120)).join('\n\n')
  const t0 = Date.now()
  const r = await completeBy(db, { system, text, maxTokens: 900, timeoutMs, temperature: 0.1, model, via })
  const ms = Date.now() - t0
  const out = typeof r === 'string' ? r : (r && r.text) || ''
  const judge = (r && r.judge) || 'rule'
  let arr = null
  try { const j = JSON.parse(out); arr = Array.isArray(j) ? j : j.pairs } catch { arr = null }
  if (!Array.isArray(arr)) {
    try {
      const s = out.indexOf('{'), e = out.lastIndexOf('}')
      const j = JSON.parse(out.slice(s, e + 1)); arr = Array.isArray(j) ? j : j.pairs
    } catch { arr = [] }
  }
  // 证据必须能在「原话」里找到——story 是切事模型写的摘要，摘要对摘要验不出真假（2026-11-16 实测）
  const inQuotes = (e, evidence) => {
    if (!e || !evidence || evidence.length < 8) return false
    const qs = Array.isArray(e.quotes) ? e.quotes.map(String) : []
    const head = evidence.slice(0, 12)
    return qs.some((q) => q.includes(head) || head.includes(q.slice(0, 12)))
  }
  return (arr || []).map((p) => {
    const i = Number(p.b || p.index || 0) - 1
    const b = list[i]
    const rel = String(p.relation || 'none').toLowerCase()
    const pull = (rel === 'none' || REL_PULL[rel] == null) ? WEAK_PULL : REL_PULL[rel]
    const evidence = String(p.evidence || '').trim()
    const ok = !!(b && rel !== 'none' && pull !== 0 && (inQuotes(a, evidence) || inQuotes(b, evidence)) && Number(p.confidence) >= 0.6)
    return { b: i + 1, id: b && b.id, title: b && b.title, relation: rel, pull, direction: String(p.direction || 'A_to_B'), confidence: Number(p.confidence) || 0, evidence, ok, ms, judge, why: String(p.why || '').trim() }
  })
}

/**
 * 把模型判出来的关系写成边（§5.5）。
 * - 判成关系且证据抄得出：confidence ≥0.75 写 confirmed，否则写 candidate（不参与检索）
 * - 同一对同一类只留一条活边（唯一索引管着），重复命中抬 confidence
 * - 方向照样按时间/轮次排：from 早、to 晚；模型说反了就把 from/to 换过来
 * @returns {{written:number, confirmed:number, candidate:number, skipped:number}}
 */
export function writeJudgedEdges(db, aid, judged, { nowMs = Date.now(), minConf = 0.75 } = {}) {
  const iso = new Date(nowMs).toISOString()
  const clock = new Map()
  try {
    for (const r of db.prepare(`SELECT h.id, c.start_at FROM hot_events h
      JOIN cold_events c ON c.id=json_extract(h.source_cold_ids,'$[0]') WHERE h.agent_id=?`).all(aid)) {
      clock.set(r.id, Date.parse(r.start_at) || 0)
    }
  } catch { /* 没表就按传入顺序 */ }

  const upd = db.prepare(`UPDATE event_edges SET confidence=?, pull=?, evidence=?, judge=?, updated_at=?
    WHERE agent_id=? AND from_id=? AND to_id=? AND kind=? AND status<>'rejected'`)
  const ins = db.prepare(`INSERT OR IGNORE INTO event_edges
    (id,agent_id,from_id,to_id,kind,direction,pull,level,confidence,evidence,reason,status,judge,valid_from,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  let written = 0, confirmed = 0, candidate = 0, weak = 0, skipped = 0
  const judges = { main: 0, local: 0, rule: 0 }

  for (const item of judged || []) {
    const a = item && item.a
    if (!a || !a.id) continue
    for (const r of (item.res || [])) {
      if (!r || !r.id) { skipped++; continue }
      const ta = clock.get(a.id) || 0
      const tb = clock.get(r.id) || 0
      // 方向：from 早、to 晚。模型给的 direction 只影响解释标签，不改方向。
      const [fromId, toId] = ta <= tb ? [a.id, r.id] : [r.id, a.id]
      // 弱边也写（2026-11-17 主人定）：没有关系 ≠ 没有边；判 none / 没通过证据的，给极小 pull，status='weak'。
      // 读的时候按门槛（≥0.25）自然把它们滤掉，所以图是连续的一张网，不读的时候看不见。
      const isWeak = !r.ok
      const kind = isWeak ? 'related' : (r.relation === 'same' ? 'same_as' : r.relation)
      const pull = isWeak ? WEAK_PULL : Math.abs(num(r.pull, 0.5)) * (r.pull < 0 ? -1 : 1)
      const conf = isWeak ? Math.min(Number(r.confidence) || 0.3, 0.5) : Number(r.confidence) || 0
      const status = isWeak ? 'weak' : (conf >= minConf ? 'confirmed' : 'candidate')
      const evidence = String(r.evidence || '')
      // 谁判的（2026-11-17 主人要）：main=宿主主模型 / local=本地模型 / rule=规则兜底。
      // 直接写在边的 judge 列上，读边的时候一眼能看出这条是谁下的判断。
      const judge = ['main', 'local', 'rule'].includes(r.judge) ? r.judge : 'local'
      judges[judge] = (judges[judge] || 0) + 1
      try {
        const u = upd.run(conf, pull, evidence, judge, iso, aid, fromId, toId, kind)
        if (Number(u.changes) > 0) {
          written++
          if (status === 'confirmed') confirmed++; else if (status === 'weak') weak++; else candidate++
          continue
        }
        const i = ins.run('edge_' + Math.random().toString(36).slice(2, 12), aid, fromId, toId, kind,
          'forward', pull, 0, conf, evidence,
          isWeak ? (r.why ? '弱边：' + String(r.why).slice(0, 200) : '弱边：判没关系但仍在同一张网上') : (r.why ? String(r.why).slice(0, 300) : '模型判'),
          status, judge, iso, iso, iso)
        if (Number(i.changes) > 0) {
          written++
          if (status === 'confirmed') confirmed++; else if (status === 'weak') weak++; else candidate++
        } else skipped++
      } catch { skipped++ }
    }
  }
  return { written, confirmed, candidate, weak, skipped, judges }
}

/** 反事实重排（2026-11-17，照 CRECE 的两阶段做法）：判成因果的，再问一句"没有 A，B 还会发生吗"。 */
export function demoteIfStill(res, still) {
  if (!res || !res.ok) return res
  const causal = ['cause', 'enable', 'prevent', 'revise', 'resolve']
  if (!causal.includes(res.relation)) return res
  if (!still) return { ...res, cf: 'needed' }        // 没有 A 就没有 B → 因果成立，留着
  return {
    ...res,
    relation: 'continue',                            // 只是挨着/接着，不是因果
    pull: PULL.continue,
    cf: 'still',                                     // 反事实说"还会"，降级
    cfReason: '没有 A，B 仍然会发生',
  }
}

/** 调模型做一次反事实判断。返回 { still:boolean|null, why:string }。 */
export async function counterfactualCheck(db, a, b, { timeoutMs = 120000, model = '', via = 'local' } = {}) {
  try {
    const system = `只做一个判断：如果 A 没有发生，B 还会发生吗？
只输出 JSON：{"still": true|false, "why": "一句话"}。说不清就 still=true（宁可不算因果）。`
    const text = `A「${a.title}」\n${String(a.story || '').slice(0, 140)}\n\nB「${b.title}」\n${String(b.story || '').slice(0, 140)}`
    const raw = await completeBy(db, { system, text, maxTokens: 120, timeoutMs, temperature: 0, model, via })
    const out = typeof raw === 'string' ? raw : (raw && (raw.text || raw.content)) || ''
    let j = null
    try { j = JSON.parse(out) } catch {
      try { const s = out.indexOf('{'), e = out.lastIndexOf('}'); j = JSON.parse(out.slice(s, e + 1)) } catch { j = null }
    }
    if (!j || typeof j.still !== 'boolean') return { still: null, why: '没判出来' }
    return { still: j.still, why: String(j.why || '') }
  } catch (e) {
    return { still: null, why: '调用失败: ' + (e && e.message || e) }
  }
}

/** 查询意图（§6.1）。没有意图就不加因果行——不加比乱加好。 */
export function intentOf(text) {
  const q = String(text || '')
  if (/为什么|怎么变成|起因|怎么会|缘由|凭什么/.test(q)) return 'why'
  if (/后来|然后呢|结果|接下来|现在到哪|进行到/.test(q)) return 'next'
  if (/现在怎样|定了吗|还没完|收口|定下来/.test(q)) return 'settled'
  return 'default'
}

function ufFind(p, x) {
  let r = x
  while (p.get(r) !== r) r = p.get(r)
  while (p.get(x) !== r) { const n = p.get(x); p.set(x, r); x = n }
  return r
}

/**
 * 最大生成树（Kruskal，§4.5）。主干不能算「最长路径」（带环是 NP-hard），
 * 所以按 |pull| 从大到小只保留能连通所有节点的最重边——树天然破环、扰动稳、正负号还在。
 */
export function maxSpanningTree(nodeIds, edges) {
  const p = new Map(nodeIds.map((id) => [id, id]))
  const adj = new Map(nodeIds.map((id) => [id, []]))
  const sorted = [...edges].sort((a, b) => Math.abs(Number(b.pull) || 0) - Math.abs(Number(a.pull) || 0))
  let picked = 0
  for (const e of sorted) {
    if (!p.has(e.from_id) || !p.has(e.to_id)) continue
    const ra = ufFind(p, e.from_id), rb = ufFind(p, e.to_id)
    if (ra === rb) continue
    p.set(ra, rb)
    const w = Number(e.pull) || 0
    adj.get(e.from_id).push({ id: e.to_id, pull: w, kind: e.kind })
    adj.get(e.to_id).push({ id: e.from_id, pull: w, kind: e.kind })
    picked++
    if (picked >= nodeIds.length - 1) break
  }
  return adj
}

/** 树上两点之间的路径（节点 id 数组） */
function pathInTree(adj, from, to) {
  if (from === to) return [from]
  const prev = new Map([[from, null]])
  const q = [from]
  while (q.length) {
    const cur = q.shift()
    for (const n of adj.get(cur) || []) {
      if (prev.has(n.id)) continue
      prev.set(n.id, cur)
      if (n.id === to) {
        const path = [to]
        let x = to
        while (prev.get(x) != null) { x = prev.get(x); path.unshift(x) }
        return path
      }
      q.push(n.id)
    }
  }
  return [from]
}

/**
 * 体（§2、§4.5、§6.2）——**不存任何结构，读的时候现算**：
 *   1. 从种子出发，只看 |pull| ≥ 门槛的 confirmed 边，扩 2 跳（限跳，不做传递闭包）；
 *   2. 在这片点上建最大生成树；
 *   3. 主轴 = 树上从最早节点到 head 的路径，最多 5 个节点（§3）；
 *   4. head = 没有 revise/resolve/sublate 指出去的节点里最晚的那个；多个就标 unfinished（§7）。
 */
export function loadBody(db, aid, eventId, { threshold = 0.25, maxNodes = 40, maxSpine = 5, maxJumps = 8 } = {}) {
  const anchor = String(eventId)
  const empty = { id: anchor, spine: [], nodes: [], size: 0, root: null, head: null, unfinished: false, joins: [], forks: [], jumps: [] }
  let all = []
  try {
    all = db.prepare(`SELECT from_id, to_id, kind, pull FROM event_edges
      WHERE agent_id=? AND status='confirmed' AND valid_to IS NULL`).all(aid)
  } catch { return empty }
  if (!all.length) return empty

  // 只看门槛以上的边；同一件事（same_as）永远算，它是折叠不是关系
  const linked = all.filter((e) => e.kind === 'same_as' || Math.abs(Number(e.pull) || 0) >= threshold)
  const nbr = new Map()
  for (const e of linked) {
    if (!nbr.has(e.from_id)) nbr.set(e.from_id, [])
    if (!nbr.has(e.to_id)) nbr.set(e.to_id, [])
    nbr.get(e.from_id).push(e)
    nbr.get(e.to_id).push(e)
  }
  // 从种子扩 2 跳
  const keep = new Set([anchor])
  let frontier = [anchor]
  for (let hop = 0; hop < 2 && frontier.length; hop++) {
    const next = []
    for (const id of frontier) {
      for (const e of nbr.get(id) || []) {
        const other = e.from_id === id ? e.to_id : e.from_id
        if (keep.has(other) || keep.size >= maxNodes) continue
        keep.add(other); next.push(other)
      }
    }
    frontier = next
  }
  const sub = linked.filter((e) => keep.has(e.from_id) && keep.has(e.to_id))
  if (!sub.length) return empty

  let rows = []
  try {
    rows = db.prepare(`SELECT h.id, h.title, h.story, h.want, h.state, c.start_at, c.end_at, c.status
      FROM hot_events h JOIN cold_events c ON c.id=json_extract(h.source_cold_ids,'$[0]')
      WHERE h.agent_id=? AND h.id IN (${[...keep].map(() => '?').join(',')})`).all(aid, ...keep)
  } catch { return empty }
  const byId = new Map(rows.map((r) => [r.id, {
    id: r.id, title: r.title, story: r.story, want: num(r.want, 0.25),
    status: String(r.status || ''), startAt: r.start_at, endAt: r.end_at,
  }]))
  if (!byId.size) return empty
  const byTime = [...byId.values()].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
  const root = byTime[0]

  // head：有 revise/resolve/sublate 指出去的，已经收口了，不算 head（§7）
  const settled = new Set()
  for (const e of all) {
    if (!keep.has(e.from_id)) continue
    if (e.kind === 'revise' || e.kind === 'resolve' || e.kind === 'sublate') settled.add(e.from_id)
  }
  const open = byTime.filter((n) => !settled.has(n.id))
  const headList = open.length ? open : byTime
  const head = headList[headList.length - 1]
  const unfinished = headList.length > 1

  // 主轴只走主干边（§7：底图不参与体的边界；§4.3：先有主干边，后有体）。
  // 主干边不够连成线的时候才退回底图，并且明确标 weak——"只是挨着"，不冒充因果。
  const TRUNK_KINDS = new Set(['cause', 'enable', 'prevent', 'revise', 'resolve', 'contradict', 'sublate', 'same_as'])
  const trunk = sub.filter((e) => TRUNK_KINDS.has(e.kind))
  let adj = maxSpanningTree([...keep], trunk)
  let path = pathInTree(adj, root.id, head.id)
  let weak = false
  if (path.length < 2) {
    adj = maxSpanningTree([...keep], sub)
    path = pathInTree(adj, root.id, head.id)
    weak = path.length >= 2        // 退到底图才连上的，标"只是挨着"
  }
  const spineIds = path.slice(-maxSpine)
  const spine = spineIds.map((id) => byId.get(id)).filter(Boolean)

  // 跳线：主轴外 1 跳（不铺开）
  const inSpine = new Set(spineIds)
  const jumps = []
  for (const e of all) {
    if (e.kind === 'same_as') continue
    if (Math.abs(Number(e.pull) || 0) < threshold) continue
    const a = inSpine.has(e.from_id), b = inSpine.has(e.to_id)
    if (a === b) continue
    if (jumps.length >= maxJumps) break
    jumps.push({ from: a ? e.from_id : e.to_id, id: a ? e.to_id : e.from_id, kind: e.kind, pull: Number(e.pull) || 0 })
  }
  if (jumps.length) {
    const ids = [...new Set(jumps.map((j) => j.id))]
    try {
      const more = db.prepare(`SELECT id, title FROM hot_events WHERE agent_id=? AND id IN (${ids.map(() => '?').join(',')})`).all(aid, ...ids)
      const titleOf = new Map(more.map((r) => [r.id, r.title]))
      for (const j of jumps) j.title = titleOf.get(j.id) || j.id
    } catch { /* 取不到标题就算了 */ }
  }

  const joins = [], forks = []
  const inDeg = new Map(), outDeg = new Map()
  for (const e of all) {
    if (e.kind === 'same_as') continue
    outDeg.set(e.from_id, (outDeg.get(e.from_id) || 0) + 1)
    inDeg.set(e.to_id, (inDeg.get(e.to_id) || 0) + 1)
  }
  for (const n of spine) {
    if ((inDeg.get(n.id) || 0) >= 2) joins.push({ id: n.id, title: n.title })
    if ((outDeg.get(n.id) || 0) >= 2) forks.push({ id: n.id, title: n.title })
  }

  return { id: anchor, spine, nodes: spine, size: spine.length, root, head, unfinished, weak, joins, forks, jumps }
}

/** 数组化（quotes/cues/turn_ids 这些列都是 JSON 字符串） */
function arrOf(s) {
  try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
}

/** 一句话是不是像专名（排掉 IP / 路径 / URL / 纯数字） */
function cueLike(c) {
  const s = String(c || '').trim()
  if (!s) return false
  if (/^[\d.,:]+$/.test(s) || /^[a-z]+:/i.test(s) || s.includes('://')) return false
  return /[A-Za-z0-9]/.test(s) || Array.from(s).length >= 3
}

/**
 * 判一整天（2026-11-17）：从 judge-causal.mjs 搬进模块，好让插件 worker 直接调。
 * 为什么要搬：独立脚本调不到宿主主模型（chain: no adapter for chat，HostLlmAdapter 只在插件进程里有上下文）。
 * 这里只判、只返回结果；写库和要不要写由调用方定（开关还是 event.causal.write）。
 */
export async function judgeDay(db, aid, day, { via = 'main', limit = 400, onProgress = null, canContinue = null } = {}) {
  // 已经判过的（events 里记着 eventId）
  const judged = new Set()
  try {
    for (const r of db.prepare("SELECT json_extract(payload,'$.eventId') id FROM events WHERE agent_id=? AND type='event.causal.judge'").all(aid)) {
      if (r.id) judged.add(r.id)
    }
  } catch { /* 没记录就全判 */ }

  // 轮次 → 会话 + 序号（用来看「谁在谁前面」）
  const turnMeta = new Map()
  try {
    for (const r of db.prepare(`SELECT turn_id, session_id, seq FROM fragments
      WHERE agent_id=? AND turn_id IS NOT NULL AND session_id IS NOT NULL`).all(aid)) {
      if (!turnMeta.has(r.turn_id)) turnMeta.set(r.turn_id, { session: r.session_id, seq: Number(r.seq) || 0 })
    }
  } catch { /* 没有轮次就用时间排 */ }

  const rows = db.prepare(`SELECT h.id, h.title, h.story, h.cues, c.quotes, c.start_at, c.end_at, c.turn_ids
    FROM hot_events h JOIN cold_events c ON c.id=json_extract(h.source_cold_ids,'$[0]')
    WHERE h.agent_id=? AND h.active=1 AND date(c.start_at,'+8 hours')=?
    ORDER BY c.start_at ASC`).all(aid, day)
  const ev = rows.map((r) => {
    const metas = arrOf(r.turn_ids).map((t) => turnMeta.get(String(t))).filter(Boolean)
    return {
      id: r.id, title: r.title, story: r.story || '', cues: arrOf(r.cues), quotes: arrOf(r.quotes),
      startAt: r.start_at, endAt: r.end_at,
      session: metas.length ? metas[0].session : '', seq: metas.length ? Math.min(...metas.map((m) => m.seq)) : null,
    }
  })
  const bySession = new Map()
  for (const e of ev) {
    if (!e.session) continue
    if (!bySession.has(e.session)) bySession.set(e.session, [])
    bySession.get(e.session).push(e)
  }
  for (const a of bySession.values()) a.sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0))

  // 候选：同会话前后各 2 件 → 同日 → 共享专名；最多 6 个（§5.3）
  const candidatesOf = (a) => {
    const seen = new Set([a.id])
    const out = []
    const push = (b) => { if (!b || seen.has(b.id)) return; seen.add(b.id); out.push(b) }
    const sib = bySession.get(a.session) || []
    const idx = sib.findIndex((x) => x.id === a.id)
    if (idx >= 0) {
      for (let k = idx - 1; k >= Math.max(0, idx - 2); k--) push(sib[k])
      for (let k = idx + 1; k <= Math.min(sib.length - 1, idx + 2); k++) push(sib[k])
    }
    for (const b of ev) {
      if (out.length >= 8) break
      if (b.id === a.id || seen.has(b.id)) continue
      if (String(b.startAt).slice(0, 10) === String(a.startAt).slice(0, 10)) push(b)
    }
    for (const b of ev) {
      if (out.length >= 8) break
      if (b.id === a.id || seen.has(b.id)) continue
      if (a.cues.some((c) => cueLike(c) && b.cues.includes(c))) push(b)
    }
    return out.slice(0, 6)
  }

  const todo = ev.filter((e) => !judged.has(e.id)).slice(0, limit)
  let calls = 0, pairs = 0, usable = 0
  let stopped = false
  const rels = {}
  const judges = { main: 0, local: 0, rule: 0 }
  const judgedList = []
  for (const a of todo) {
    // 让路（2026-11-17 主人定）：跟切事一个规矩——主人刚说过话、或者本地模型正被别的活占着，
    // 这一轮就停在这儿，判过的已经记进 events，下次接着判剩下的。不硬占、不卡人。
    if (canContinue && !canContinue()) { stopped = true; break }
    const cands = candidatesOf(a)
    if (!cands.length) continue
    let res = []
    try { res = await judgeBatch(db, a, cands, { via }) } catch (e) {
      if (onProgress) onProgress({ calls, pairs, usable, error: String(e && e.message) })
      continue
    }
    // 反事实重排：判成因果的，再问一句「没有 A，B 还会吗」；还会就降级
    for (const r of res) {
      if (!r.ok || !['cause', 'enable', 'prevent', 'revise', 'resolve'].includes(r.relation)) continue
      const b = cands.find((c) => c.id === r.id)
      if (!b) continue
      try {
        const cf = await counterfactualCheck(db, a, b, { via })
        if (cf.still != null) Object.assign(r, demoteIfStill(r, cf.still))
      } catch { /* 反事实失败就保留原判断 */ }
    }
    calls++
    for (const r of res) {
      pairs++
      rels[r.relation] = (rels[r.relation] || 0) + 1
      if (r.ok) usable++
      const j = ['main', 'local', 'rule'].includes(r.judge) ? r.judge : 'rule'
      judges[j] = (judges[j] || 0) + 1
    }
    try {
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
        'evt_' + Math.random().toString(36).slice(2, 12), aid, 'event.causal.judge',
        JSON.stringify({
          eventId: a.id, cands: res.length, usable: res.filter((x) => x.ok).length, via,
          // 理由也记账（2026-11-17 主人要）：不开写库也能看见它凭什么这么判，好查它哪步想错
          whys: res.filter((x) => x.why).slice(0, 4).map((x) => ({ b: x.b, rel: x.relation, why: x.why })),
        }), new Date().toISOString())
    } catch { /* 记账失败不影响 */ }
    judgedList.push({ a: { id: a.id, title: a.title }, res })
    if (onProgress) onProgress({ calls, pairs, usable })
  }
  return { day, calls, pairs, usable, rels, judges, judged: judgedList, total: ev.length, pending: todo.length, stopped }
}

/**
 * 问「为什么」：逆着因果箭头，最多 3~5 个因，只回一跳、不往下追，**不融合不总结**（2026-11-16 主人定）。
 */
export function formatWhyLine(db, aid, eventId, { budget = 200, maxCauses = 5 } = {}) {
  const id = String(eventId)
  let rows = []
  try {
    rows = db.prepare(`SELECT e.from_id, e.pull, e.kind, h.title
      FROM event_edges e JOIN hot_events h ON h.id = e.from_id
      WHERE e.agent_id=? AND e.to_id=? AND e.valid_to IS NULL
        AND e.status IN ('confirmed','candidate')
        AND e.kind IN ('cause','enable','prevent','revise','resolve','contradict')`).all(aid, id)
  } catch { return { text: '', chars: 0, causes: [] } }
  const causes = [...rows].sort((a, b) => Math.abs(b.pull) - Math.abs(a.pull)).slice(0, maxCauses)
  if (!causes.length) return { text: '', chars: 0, causes: [] }
  const line = `（为什么：因为${causes.map((c) => `「${c.title}」`).join('、')}）`
  const text = line.length > budget ? line.slice(0, Math.max(0, budget - 1)) + '…' : line
  return { text, chars: text.length, causes }
}

/** 按意图分派（§6.1）：问为什么就逆着找因，其余顺着走（后来/现在到哪）。 */
export function readLine(db, aid, eventId, { intent = 'default', budget = 200 } = {}) {
  if (intent === 'why') return formatWhyLine(db, aid, eventId, { budget })
  return formatBodyLine(db, aid, eventId, { budget, intent })
}
export function formatBodyLine(db, aid, eventId, { budget = 200, intent = 'default', around = 3 } = {}) {
  const body = loadBody(db, aid, eventId)
  if (!body.size || body.size < 2 || !body.spine || body.spine.length < 2) return { text: '', chars: 0, body }
  // 只取种子附近那一截（前后各 around 件）——整条主轴可能几十件，全塞进一句话读起来就是倒垃圾
  // （2026-11-17 模拟：60 件主轴拼出来 400 多字，全是工作段标题）
  const idx = body.spine.findIndex((n) => n.id === String(eventId))
  const from = idx < 0 ? Math.max(0, body.spine.length - around - 1) : Math.max(0, idx - around)
  const to = idx < 0 ? body.spine.length : Math.min(body.spine.length, idx + around + 1)
  const names = body.spine.slice(from, to).map((n) => n.title)
  // weak 的意思是「这条线是靠底图（挨着/同话题）连上的，还没判出因果」——措辞上不能冒充因果。
  // weak 时不再追加「并进/分叉」那些，否则尾巴会拖成「…还没判出因果）；这里并进了别的线）」。
  let line = body.weak
    ? `（挨着：${names.join(' → ')}。这几件只是连着，还没判出因果）`
    : `（这条线：${names.join(' → ')}。最新是「${body.head.title}」`
  if (!body.weak) {
    // joins/forks 只带 id+title（没有 from/to 列表），这里别再取不存在的字段——2026-11-17 模拟抓到的 bug
    if (body.joins.length) {
      line += `；这里并进了别的线`
    } else if (body.forks.length) {
      line += `；它又分出去过`
    }
    line += '）'
  }
  const text = line.length > budget ? line.slice(0, Math.max(0, budget - 1)) + '…' : line
  return { text, chars: text.length, body }
}
