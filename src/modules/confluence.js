/**
 * 记忆汇流（confluence）· P0/P2：把某一刻的「现场」只读地拼出来。
 *
 * 设计见 docs/汇流-基石-2026-11-09.md（§5 材料 / §8 bundle / §9 技术层）。
 *
 * 边界（写进测试，不许破）：
 *   1) **只读**：不写任何表，不 touch，不拨 last_hit_at，不动 R。
 *   2) **不调模型**：只查询与拼装，不抽取、不总结。
 *   3) **确定性**：同一 (db, aid, at, opt) 两次调用，除 budget 估出的 token 可能有 ±1，其余一致。
 *   4) **遗忘优先**：被 HIDE / DELETE 的记忆和它指向的原话轮次，一律不进包（visibility.js）。
 *
 * 三层隔离：
 *   - reconstructScene：纯读 → bundle
 *   - runConfluence：bundle → 一段可注入的 system 段（带预算裁剪）
 *   - buildSnapshot / writeSnapshot：截面（P1 才写库；build 只拼对象）
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { now } from '../db.js'
import { getParam } from '../kernel.js'
import { forgottenMemoryIds, forgottenTurnIds } from './visibility.js'

const NOISE = /^(Time sampled|Approval prompts|##|<|\{|\[SCHEDULE|\[SYSTEM|Current runtime context)/i
const REAL_REL_KINDS = ['utterance', 'appraisal', 'manual', 'correction']

export const SCENE = Object.freeze({
  window: 4,          // ±N 轮
  maxMemories: 6,
  budget: 1600,       // 单道预算（不占日常 800）
  l2budget: 8000,     // L2 整段重放的单开预算（不挤 L1）
  lightChars: 120,    // 非锚点/非邻轮的概括长度
})

const iso = (v) => {
  if (!v) return null
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const clean = (s) => String(s || '').replace(/\r/g, '').trim()
const tok = (s) => Math.ceil(String(s || '').length / 2)
const par = (raw) => { try { return JSON.parse(raw || '{}') } catch { return {} } }

/** 本地（Asia/Shanghai）时钟，用于「时间感」。 */
export function localClock(isoStr) {
  const d = new Date(isoStr)
  if (!Number.isFinite(+d)) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d)
}

/** 本地（Asia/Shanghai）日期 YYYY-MM-DD。`day` 列是本地日，不能拿 UTC 的 slice 顶。 */
export function localDay(isoStr) {
  const d = new Date(isoStr)
  if (!Number.isFinite(+d)) return ''
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {})
  return `${p.year}-${p.month}-${p.day}`
}

export function phaseOf(isoStr) {
  const h = Number(localClock(isoStr).slice(0, 2))
  if (!Number.isFinite(h)) return ''
  if (h < 6) return '深夜'
  if (h < 11) return '上午'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '夜里'
}

const keepRow = (r) => (r.role === 'user' || r.role === 'assistant') && clean(r.text) && !NOISE.test(clean(r.text))

/**
 * 只读重建现场包。
 * @param {object} db
 * @param {string} aid
 * @param {string|Date} at 主钟时刻（said）
 * @param {{level?:'L0'|'L1'|'L2', window?:number, maxMemories?:number}} [opt]
 */
export const CONFLUENCE_VERSION = '2026-11-10.1'
try {
  // 重启后先看这个文件：确认这次加载的是哪一版（排查「代码改了、跑的还是旧的」）
  fs.appendFileSync(new URL('../../var/scene-boot.log', import.meta.url),
    new Date().toISOString() + ' boot ' + CONFLUENCE_VERSION + ' pid=' + process.pid + ' argv=' + String(process.argv[1] || '-').slice(-60) + '\n')
} catch { /* 只作观测 */ }

export function reconstructScene(db, aid, at, opt = {}) {
  const atIso = iso(at)
  if (!atIso) return { ok: false, reason: 'bad-at', at: String(at) }
  const level = opt.level === 'L0' || opt.level === 'L2' ? opt.level : 'L1'
  const explicitK = Number.isFinite(+opt.window) ? +opt.window : null
  const K = Math.max(0, explicitK != null ? explicitK : (level === 'L0' ? 0 : level === 'L2' ? 16 : SCENE.window))
  const t0 = Date.now()

  // ---- 锚点：前后 36 小时里离 at 最近的一句真话 ----
  // 不按 day 列查：fragments.day 是 UTC 日期（archive.js 的 dayOf），跨零点会错位。
  // 会话约束（11-09 已定）：默认只翻「正在说话的这条会话」，显式 sessionId 覆盖；
  // 早先只按 created_at 排，两条会话同时写时会翻到隔壁那本（15:22 实证）。
  const fromIso = new Date(Date.parse(atIso) - 36 * 3600000).toISOString()
  const toIso = new Date(Date.parse(atIso) + 36 * 3600000).toISOString()
  const explicitSession = opt.sessionId ? String(opt.sessionId) : null
  const wantSession = explicitSession
  const loadCandidates = (sid) => {
    const sql = `SELECT id, session_id, turn_id, seq, role, text, created_at, day
       FROM fragments WHERE agent_id=? AND role IN ('user','assistant') AND created_at BETWEEN ? AND ?
       ${sid ? 'AND session_id=?' : ''} ORDER BY created_at`
    const args = sid ? [aid, fromIso, toIso, sid] : [aid, fromIso, toIso]
    return db.prepare(sql).all(...args).filter(keepRow)
  }
  const seenSession = wantSession
  const sessionFallback = false
  const candidates = loadCandidates(wantSession)
  if (!candidates.length) return { ok: false, reason: 'no-turns', at: atIso, session: seenSession }

  let anchor = null
  let best = Infinity
  for (const r of candidates) {
    const d = Math.abs(Date.parse(r.created_at) - Date.parse(atIso))
    if (d < best) { best = d; anchor = r }
  }

  // ---- 划窗：同会话 ±K，加 gap_min；被忘的轮次整轮不进 ----
  const forgottenTurns = forgottenTurnIds(db, aid)
  if (anchor.turn_id && forgottenTurns.has(String(anchor.turn_id))) {
    return { ok: false, reason: 'forgotten-anchor', at: atIso }
  }
  const rawWindow = db.prepare(
    `SELECT id, turn_id, seq, role, text, created_at
       FROM fragments WHERE session_id=? AND seq BETWEEN ? AND ? ORDER BY seq`
  ).all(anchor.session_id, anchor.seq - K, anchor.seq + K)
    .filter((r) => keepRow(r) && !(r.turn_id && forgottenTurns.has(String(r.turn_id))))
  const window = rawWindow.map((r, i) => ({
    turn_id: r.turn_id || null,
    role: r.role,
    at: r.created_at,
    text: clean(r.text),
    anchor: r.id === anchor.id,
    gap_min: i === 0 ? null : Math.max(0, Math.round((Date.parse(r.created_at) - Date.parse(rawWindow[i - 1].created_at)) / 60000)),
  }))
  if (!window.length) return { ok: false, reason: 'empty-window', at: atIso }

  // ---- 来路 / 去路（P3.5）：窗口外各取两小段，只补骨架，不塞原文 ----
  // 只读同一会话；被忘的轮次一律不进。合计压到 ≤200 token（进包时还会再裁）。
  const brief = (r) => clean(r.text).replace(/\n/g, ' ').replace(/\*+/g, '').replace(/\s+/g, ' ').trim().slice(0, 32)
  const lo = anchor.seq - K
  const hi = anchor.seq + K
  const beforeRows = (() => {
    try {
      return db.prepare(`SELECT role, text, created_at FROM fragments
        WHERE session_id=? AND seq<? AND role IN ('user','assistant') ORDER BY seq DESC LIMIT 2`)
        .all(anchor.session_id, lo).reverse().filter(keepRow)
    } catch { return [] }
  })()
  const afterRows = (() => {
    try {
      return db.prepare(`SELECT role, text, created_at FROM fragments
        WHERE session_id=? AND seq>? AND role IN ('user','assistant') ORDER BY seq ASC LIMIT 2`)
        .all(anchor.session_id, hi).filter(keepRow)
    } catch { return [] }
  })()
  const coldMin = beforeRows.length
    ? Math.max(0, Math.round((Date.parse(window[0].at) - Date.parse(beforeRows[beforeRows.length - 1].created_at)) / 60000))
    : null
  const maxGap = window.reduce((a, w, i) => (w.gap_min != null && w.gap_min > (a.gap || 0) ? { gap: w.gap_min, i } : a), { gap: 0, i: -1 })
  const context = {
    before: beforeRows.length
      ? { lines: beforeRows.map(brief), cold_min: coldMin }
      : null,
    turning: maxGap.gap >= 10 ? { gap_min: maxGap.gap, at: window[maxGap.i].at, role: window[maxGap.i].role } : null,
    after: afterRows.length ? { lines: afterRows.map(brief) } : null,
  }

  // ---- 记忆：当时算数的那几条（按轮次回链，回不到再按时间窗兜底） ----
  const forgottenMems = forgottenMemoryIds(db, aid)
  const turnIds = window.map((w) => w.turn_id).filter(Boolean)
  const wStart = window[0].at
  const wEnd = window[window.length - 1].at
  let memRows = []
  if (turnIds.length) {
    memRows = db.prepare(
      `SELECT id, type, text, created_at, status, source, source_turn_id
         FROM memory_items m
        WHERE m.agent_id=? AND m.source_turn_id IN (${turnIds.map(() => '?').join(',')})
        ORDER BY m.created_at LIMIT ?`
    ).all(aid, ...turnIds, SCENE.maxMemories)
  }
  let memVia = 'turn'
  if (!memRows.length) {
    memRows = db.prepare(
      `SELECT id, type, text, created_at, status, source, source_turn_id
         FROM memory_items WHERE agent_id=? AND status='active' AND created_at BETWEEN ? AND ?
        ORDER BY created_at LIMIT ?`
    ).all(aid, wStart, wEnd, SCENE.maxMemories)
    memVia = 'window'
  }
  const memories = memRows
    .filter((m) => !forgottenMems.has(String(m.id)))
    .filter((m) => !(m.source_turn_id && forgottenTurns.has(String(m.source_turn_id))))
    .map((m) => {
      const p = db.prepare('SELECT speaker, quote, inferred FROM memory_provenance WHERE memory_id=?').get(m.id)
      const fa = db.prepare('SELECT id FROM fact_archive WHERE memory_id=?').get(m.id)
      return {
        id: m.id,
        type: m.type,
        text: m.text,
        at: m.created_at,
        by: p && p.speaker ? p.speaker : 'unknown',
        quote: p && p.quote ? p.quote : null,
        inferred: p ? Number(p.inferred || 0) : null,
        landing: m.source_turn_id ? 'turn:' + m.source_turn_id : (fa ? 'fa:' + fa.id : 'none'),
        via: memVia,
      }
    })

  // ---- 状态截面：全部按 at 投影，只读；老库缺表/缺列时给 null，不抛 ----------
  const tryGet = (sql, ...a) => { try { return db.prepare(sql).get(...a) || null } catch { return null } }
  const tryAll = (sql, ...a) => { try { return db.prepare(sql).all(...a) } catch { return [] } }
  const affectEv = tryGet(
    "SELECT payload, created_at FROM events WHERE agent_id=? AND type='affect.appraised' AND created_at<=? ORDER BY created_at DESC LIMIT 1",
    aid, atIso
  )
  const driveEv = tryGet(
    "SELECT payload, created_at FROM events WHERE agent_id=? AND type='drive.evaluated' AND created_at<=? ORDER BY created_at DESC LIMIT 1",
    aid, atIso
  )
  const relEv = tryGet(
    `SELECT kind, text, at FROM rel_event WHERE agent_id=? AND at<=? AND kind IN (${REAL_REL_KINDS.map(() => '?').join(',')})
      ORDER BY at DESC LIMIT 1`,
    aid, atIso, ...REAL_REL_KINDS
  )
  const rel24 = tryGet(
    `SELECT COUNT(*) n FROM rel_event WHERE agent_id=? AND at<=? AND at>=? AND kind IN (${REAL_REL_KINDS.map(() => '?').join(',')})`,
    aid, atIso, new Date(Date.parse(atIso) - 86400000).toISOString(), ...REAL_REL_KINDS
  )
  const loops = tryAll(
    `SELECT text, due_at, important FROM open_loops
      WHERE agent_id=? AND state='open' AND created_at<=? AND (closed_at IS NULL OR closed_at>?)
      ORDER BY important DESC, created_at DESC LIMIT 2`,
    aid, atIso, atIso
  )
  const lifeRow = tryGet(
    "SELECT text, created_at FROM memory_items WHERE agent_id=? AND source='life' AND created_at<=? ORDER BY created_at DESC LIMIT 1",
    aid, atIso
  )
  const readRow = tryGet(
    'SELECT guess_label, actual_label, created_at FROM affect_user_read WHERE agent_id=? AND created_at<=? ORDER BY created_at DESC LIMIT 1',
    aid, atIso
  )
  const prevTurn = tryGet(
    "SELECT created_at FROM fragments WHERE agent_id=? AND created_at<? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 1",
    aid, wStart
  )

  const ap = affectEv ? par(affectEv.payload) : null
  const affect = ap ? {
    label: ap.label || null,
    sig: ap.sig ?? null,
    v3: ap.v3 || null,
    hint: ap.algo && ap.algo.hint_label ? ap.algo.hint_label : null,
    at: affectEv.created_at,
  } : null
  const dp = driveEv ? par(driveEv.payload) : null
  const drive = dp ? {
    band: dp.band || null,
    D: dp.D && Object.keys(dp.D).length ? dp.D : null,
    D_sum: dp.D_sum ?? null,
    unlocked: dp.unlocked ? Object.keys(dp.unlocked).filter((k) => dp.unlocked[k] && k[0] !== '_') : null,
    at: driveEv.created_at,
  } : null
  const state = {
    affect,
    drive,
    relation: relEv ? { kind: relEv.kind, text: clean(relEv.text), at: relEv.at, n24: rel24 ? rel24.n : 0 } : null,
    loops: loops.map((l) => ({ text: clean(l.text), due_at: l.due_at })),
    // 生活那句太短（<6 字，多半是抽取时截断的碎片）就不摆进来——它读着像半截话，比没有更伤人。
    life: lifeRow && clean(lifeRow.text).length >= 10 ? { text: clean(lifeRow.text), at: lifeRow.created_at } : null,
    other: readRow ? {
      guess: readRow.guess_label || null,
      actual: readRow.actual_label || null,
      at: readRow.created_at,
    } : null,
    time: {
      at: atIso,
      clock: localClock(atIso),
      phase: phaseOf(atIso),
      sinceLastTalkMin: prevTurn ? Math.max(0, Math.round((Date.parse(anchor.created_at) - Date.parse(prevTurn.created_at)) / 60000)) : null,
      whoStarted: window[0].role === 'user' ? 'user' : 'self',
    },
  }

  // ---- 预算 ----
  const parts = {
    window: window.reduce((n, w) => n + tok(w.text), 0),
    memories: memories.reduce((n, m) => n + tok(m.text) + tok(m.quote), 0),
    state: tok(JSON.stringify(state)),
    chain: 0,
  }
  const budget = { tokens: Object.values(parts).reduce((a, b) => a + b, 0), parts }

  const missing = []
  if (!memories.length) missing.push('memories')
  if (!affect) missing.push('affect')
  if (!drive) missing.push('drive')
  if (!drive || !drive.D) missing.push('drive_D')
  if (!state.relation) missing.push('relation')
  if (!state.life) missing.push('life')
  if (!state.other) missing.push('other_affect')
  if (memories.some((m) => !m.quote)) missing.push('quote_partial')
  if (memories.some((m) => m.landing === 'none')) missing.push('landing_partial')
  if (window.some((w) => w.gap_min != null && w.gap_min >= 30)) missing.push('has_gap')

  return {
    ok: true,
    v: 1,
    level,
    at: atIso,
    anchor: {
      turn_id: anchor.turn_id || null,
      session_id: anchor.session_id,
      seq: anchor.seq,
      day: localDay(anchor.created_at),
    },
    window,
    context,
    memories,
    state,
    session: { id: anchor.session_id, filtered: !!wantSession, fallback: sessionFallback },
    labels: { reconstructed: true, axis: 'said', missing },
    budget,
    sources: { turns: window.length, memories: memories.length, state_events: [affectEv, driveEv, relEv].filter(Boolean).length },
    ms: Date.now() - t0,
  }
}

/**
 * 把 bundle 拼成一段可注入的 system 段；超预算就从窗口尾部、再从记忆尾部裁。
 * @returns {{ok:boolean, system:string, budget:{tokens:number}, dropped:string[]}}
 */
export function runConfluence(bundle, opt = {}) {
  if (!bundle || !bundle.ok) return { ok: false, reason: (bundle && bundle.reason) || 'no-bundle', system: '' }
  const cap = Math.max(200, Number(opt.budget) || SCENE.budget)
  const ask = clean(opt.ask)
  const dropped = []
  const w = bundle.window.slice()
  const mems = bundle.memories.slice()

  const render = () => {
    const L = []
    const st = bundle.state || {}
    const tm = st.time || {}
    L.push(`【记忆汇流 · 回到 ${bundle.at.slice(0, 10)} ${tm.clock || ''}】`)
    L.push('（下面是重建出来的现场，不是现在。每一条都标着「那是当时」。）')
    L.push('')
    L.push(`时间感：那是 ${tm.clock || ''}，${tm.phase || ''}${tm.sinceLastTalkMin != null ? `；距上一句话 ${tm.sinceLastTalkMin} 分钟` : ''}${tm.whoStarted ? `；这段是${tm.whoStarted === 'user' ? '你' : '我'}先开口的` : ''}。`)
    const ctx = bundle.context || {}
    if (ctx.before && ctx.before.lines && ctx.before.lines.length) {
      L.push('来路：' + (ctx.before.cold_min != null ? `进这段前冷过 ${ctx.before.cold_min} 分钟；` : '') + ctx.before.lines.map((x) => '「' + x + '」').join(' / '))
    }
    if (ctx.turning) L.push(`转折：中间冷了 ${ctx.turning.gap_min} 分钟，之后那句是${ctx.turning.role === 'user' ? '你说' : '我说'}的。`)
    if (ctx.after && ctx.after.lines && ctx.after.lines.length) {
      L.push('去路：后来' + ctx.after.lines.map((x) => '「' + x + '」').join('，') + '。')
    }
    L.push('')
    L.push('当时说过的话：')
    for (const t of w) {
      const who = t.role === 'user' ? '你' : '我'
      const gap = t.gap_min != null && t.gap_min >= 10 ? `（隔了 ${t.gap_min} 分钟）` : ''
      L.push(`- ${localClock(t.at)} ${who}：「${clean(t.text).replace(/\n/g, ' / ')}」${gap}`)
    }
    if (mems.length) {
      L.push('')
      L.push('当时算数的记忆：')
      for (const m of mems) {
        const by = m.by === 'self' ? '〔我〕' : m.by === 'user' ? '〔你〕' : ''
        L.push(`- [${m.type}] ${by}${clean(m.text)}${m.quote ? ` — 原话：「${m.quote}」` : ''}`)
      }
    }
    const s = []
    if (st.affect) s.push(`情绪 ${st.affect.label || '?'}${st.affect.v3 ? `（slow ${st.affect.v3.slow} / fast ${st.affect.v3.fast}）` : ''}`)
    if (st.drive) s.push(`驱力 ${st.drive.band || '?'}${st.drive.D ? '' : '（D 缺失）'}`)
    if (st.relation) s.push(`关系最近一次：${clean(st.relation.text).slice(0, 40)}`)
    if (st.other && (st.other.guess || st.other.actual)) s.push(`你当时像是 ${st.other.actual || st.other.guess}`)
    if (st.life) s.push(`生活：${clean(st.life.text).slice(0, 40)}`)
    if (st.loops && st.loops.length) s.push(`当时没闭合：${st.loops.map((l) => clean(l.text).slice(0, 30)).join('；')}`)
    if (s.length) { L.push(''); L.push('当时的形状：' + s.join('；') + '。') }
    if (ask) { L.push(''); L.push('现在要说的是：' + ask) }
    L.push('')
    L.push('硬规则（这一轮有效）：')
    L.push('1) 上面是「当时」，不是现在。说「现在」的时候必须是真的现在。')
    L.push('2) 重建出来的情绪只读，不要当成你此刻的情绪。')
    L.push('3) 你可以不同意当时的自己——不同意不是失真。')
    return L.join('\n')
  }

  let system = render()
  const size = () => tok(system)
  // 裁窗口尾部（保留锚点那一轮）
  while (size() > cap && w.length > 1) {
    const idx = w.findIndex((x) => x.anchor)
    const dropAt = idx >= 0 && idx < w.length - 1 ? w.length - 1 : 0
    dropped.push('window:' + (w[dropAt].turn_id || w[dropAt].at))
    w.splice(dropAt, 1)
    system = render()
  }
  // 再裁记忆尾部
  while (size() > cap && mems.length) {
    dropped.push('memory:' + mems[mems.length - 1].id)
    mems.pop()
    system = render()
  }
  // 最后硬截断（留省略号）
  if (size() > cap) {
    const keepChars = Math.max(80, cap * 2)
    system = system.slice(0, keepChars) + '\n…（超预算，已截断）'
    dropped.push('truncated')
  }
  return { ok: true, system, budget: { tokens: size(), cap }, dropped }
}

/**
 * 截面：只拼对象，不写库（写库走 recordScene）。
 * @param {'light'|'heavy'} tier
 */
export function buildSnapshot(db, aid, at, { tier = 'light' } = {}) {
  const atIso = iso(at)
  if (!atIso) return null
  const scene = reconstructScene(db, aid, atIso, { level: tier === 'light' ? 'L0' : 'L2', window: 0, maxMemories: 0 })
  if (!scene.ok) return null
  const st = scene.state || {}
  const light = tier === 'light'
  return {
    at: atIso,
    source: light ? 'auto' : 'change',
    affect_json: st.affect ? JSON.stringify(light ? {
      label: st.affect.label, sig: st.affect.sig, slow: st.affect.v3 && st.affect.v3.slow, fast: st.affect.v3 && st.affect.v3.fast,
    } : st.affect) : null,
    drive_json: st.drive ? JSON.stringify(light ? { band: st.drive.band, D_sum: st.drive.D_sum } : st.drive) : null,
    relation_json: st.relation ? JSON.stringify(st.relation) : null,
    persona_json: light ? null : JSON.stringify({ note: '人格无逐轮历史，按版本近似' }),
    life_json: st.life ? JSON.stringify(st.life) : null,
    loops_json: st.loops && st.loops.length ? JSON.stringify(st.loops) : null,
    voice_json: null,
    params_hash: null,
  }
}

// ---------------------------------------------------------------------------
// P1：留底（写侧）
//
// 每轮一条轻截面（记脉搏）+ 每 N 轮一条重截面（拍照片）+ 注入块原文另存。
// 三张表都只追加；turn_id 上有唯一索引，同一轮重复调用不会写第二行。
// 失败一律静默：留底不能拖慢或拖垮一次回复。
// ---------------------------------------------------------------------------

const BLOCK_LIMIT = 200
const blocks = new Map() // sessionId -> { at, block }

/** 系统提示拼好之后叫一下：把这一轮的注入块暂存起来，等落轮时一起写。 */
export function rememberBlock(sessionId, block, at = Date.now()) {
  if (!sessionId || !block) return false
  const key = String(sessionId)
  blocks.set(key, { at, block: String(block) })
  if (blocks.size > BLOCK_LIMIT) blocks.delete(blocks.keys().next().value)
  return true
}

export function takeBlock(sessionId) {
  if (!sessionId) return null
  return blocks.get(String(sessionId)) || null
}

const flagOf = (db, aid, key, dflt) => {
  try { return String(getParam(db, aid, key) ?? dflt) } catch { return dflt }
}
const numOf = (db, aid, key, dflt) => {
  const n = Number(getParam(db, aid, key))
  return Number.isFinite(n) && n > 0 ? n : dflt
}
const localDayStart = (isoStr) => {
  const day = localDay(isoStr)
  const t = Date.parse(day + 'T00:00:00+08:00')
  return Number.isFinite(t) ? new Date(t).toISOString() : isoStr
}
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex')

/**
 * 落一轮的留底：注入块原文 + 轻截面（+ 到点时的重截面）。
 * @returns {{ok:boolean, reason?:string, wrote:{archive:number,light:number,heavy:number}}}
 */
function dbgScene() { /* 调试期已过：逐轮日志关掉，只留启动标记 */ }

export function recordScene(db, aid, opt = {}) {
  const wrote = { archive: 0, light: 0, heavy: 0 }
  dbgScene('enter aid=' + aid + ' turn=' + (opt.turnId || '-'))
  if (!aid) { dbgScene('no-aid'); return { ok: false, reason: 'no-aid', wrote } }
  let flag = 'on'
  try { flag = flagOf(db, aid, 'scene.archive', 'on') } catch (e) { dbgScene('flag-throw ' + e.message) }
  dbgScene('flag=' + flag)
  if (flag === 'off') return { ok: false, reason: 'off', wrote }
  const atIso = iso(opt.at) || now()
  const turnId = opt.turnId ? String(opt.turnId) : null
  const sessionId = opt.sessionId ? String(opt.sessionId) : null
  const createdAt = now()

  // 1) 注入块原文（渲染后的那段）
  const cap = opt.block != null ? { at: Date.now(), block: String(opt.block) } : takeBlock(sessionId)
  if (cap && cap.block) {
    const key = turnId || ('noid:' + atIso + ':' + sha1(cap.block).slice(0, 8))
    try {
      db.prepare(`INSERT OR IGNORE INTO scene_archive(
        turn_id,agent_id,at,session_id,episode_id,block,block_hash,state_ref,bytes,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        key, aid, atIso, sessionId, null, cap.block, sha1(cap.block), null,
        Buffer.byteLength(cap.block, 'utf8'), createdAt
      )
      wrote.archive = 1
    } catch { /* 老库没这张表 */ }
  }

  // 2) 轻截面：每轮一条
  let light = null
  try { light = buildSnapshot(db, aid, atIso, { tier: 'light' }) } catch (e) { dbgScene('light-throw ' + (e && e.message)) }
  dbgScene('light=' + (light ? 'ok' : 'null'))
  if (light) {
    const id = 'ss_' + crypto.randomBytes(9).toString('hex')
    try {
      db.prepare(`INSERT OR IGNORE INTO state_scene(
        id,agent_id,at,session_id,episode_id,turn_id,tier,affect_json,drive_json,relation_json,
        persona_json,life_json,loops_json,voice_json,params_hash,source,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, aid, atIso, sessionId, null, turnId, 'light',
        light.affect_json, light.drive_json, light.relation_json, light.persona_json,
        light.life_json, light.loops_json, light.voice_json, light.params_hash, 'auto', createdAt
      )
      wrote.light = 1
    } catch { /* ignore */ }
  }

  // 3) 重截面：距上一条重截面够 N 轮，且当天没超过上限
  try {
    const every = Math.round(numOf(db, aid, 'scene.snapshot.every', 20))
    const maxPerDay = Math.round(numOf(db, aid, 'scene.snapshot.max_per_day', 48))
    const lastHeavy = db.prepare("SELECT at FROM state_scene WHERE agent_id=? AND tier='heavy' ORDER BY at DESC LIMIT 1").get(aid)
    const since = db.prepare("SELECT COUNT(*) n FROM state_scene WHERE agent_id=? AND tier='light' AND at>?").get(aid, lastHeavy ? lastHeavy.at : '1970-01-01T00:00:00.000Z')
    const todayHeavy = db.prepare("SELECT COUNT(*) n FROM state_scene WHERE agent_id=? AND tier='heavy' AND at>=?").get(aid, localDayStart(atIso))
    const due = opt.force || Number(since && since.n || 0) >= every
    if (due && Number(todayHeavy && todayHeavy.n || 0) < maxPerDay) {
      const heavy = buildSnapshot(db, aid, atIso, { tier: 'heavy' })
      if (heavy) {
        const id = 'ss_' + crypto.randomBytes(9).toString('hex')
        db.prepare(`INSERT OR IGNORE INTO state_scene(
          id,agent_id,at,session_id,episode_id,turn_id,tier,affect_json,drive_json,relation_json,
          persona_json,life_json,loops_json,voice_json,params_hash,source,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, aid, atIso, sessionId, null, turnId, 'heavy',
          heavy.affect_json, heavy.drive_json, heavy.relation_json, heavy.persona_json,
          heavy.life_json, heavy.loops_json, heavy.voice_json, heavy.params_hash,
          'change', createdAt
        )
        wrote.heavy = 1
      }
    }
  } catch { /* 重截面失败不影响轻的 */ }

  return { ok: true, wrote, light }
}


// ---------------------------------------------------------------------------
// P3：手动入口用的两个口子 + P1 收口（保留策略）
// ---------------------------------------------------------------------------

/** 把 "2026-11-05 15:00" / "2026-11-05T15:00" / 任意可解析时间 → ISO（无时区按本地 +08:00）。 */
function parseAt(s) {
  const raw = String(s || '').trim()
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(raw)) return new Date(raw.replace(' ', 'T') + ':00+08:00').toISOString()
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw)) return new Date(raw.replace(' ', 'T') + '+08:00').toISOString()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(raw + 'T12:00:00+08:00').toISOString()
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/**
 * L2 整段重放：从 scene_archive 取那一轮「拼好的整段」，不是重算。
 * 没有留底（重启前的账）或锚点已被忘 → null，由调用方退回 16 轮重建。
 */
export function replayScene(db, aid, opt = {}) {
  const atIso = iso(opt.at)
  if (!atIso) return null
  const sessionId = opt.sessionId ? String(opt.sessionId) : null
  let row = null
  try {
    // 只在 ±10 分钟内找（再远本来也不认），走 (agent_id, at) 索引，不随总量变慢
    const lo = new Date(Date.parse(atIso) - 10 * 60000).toISOString()
    const hi = new Date(Date.parse(atIso) + 10 * 60000).toISOString()
    const sql = `SELECT turn_id, at, session_id, block, bytes FROM scene_archive
      WHERE agent_id=? AND at BETWEEN ? AND ? ${sessionId ? 'AND session_id=?' : ''}
      ORDER BY ABS(strftime('%s', at) - strftime('%s', ?)) LIMIT 1`
    const args = sessionId ? [aid, lo, hi, sessionId, atIso] : [aid, lo, hi, atIso]
    row = db.prepare(sql).all(...args)[0] || null
  } catch { return null }
  if (!row || !row.block) return null
  // 离得太远就不算「这一轮」的整段留底，交给调用方退回重建
  if (Math.abs(Date.parse(atIso) - Date.parse(row.at)) > 10 * 60000) return null
  try { if (row.turn_id && forgottenTurnIds(db, aid).has(String(row.turn_id))) return null } catch { /* 可见性查不了就照常重放 */ }
  let state = null
  try {
    state = db.prepare("SELECT * FROM state_scene WHERE agent_id=? AND turn_id=? AND tier='heavy' LIMIT 1").all(aid, row.turn_id)[0] || null
  } catch { /* 老库没有 heavy */ }
  return {
    turn_id: row.turn_id, at: row.at, session_id: row.session_id, block: row.block, bytes: row.bytes, state,
    delta_min: Math.round((Date.parse(atIso) - Date.parse(row.at)) / 60000),
  }
}

/**
 * P4 · 她自己发起（默认关，开关 `confluence.self`）。
 * 三个数：强度（配置存在即算过）／间隔天数／每日水位。只开 L0，不开口、只留痕。
 * 返回 ok:false 的理由：off / waterline / too_soon / no-anchor。
 */
export function selfReturnTick(db, aid, opt = {}) {
  const nowIso = iso(opt.at) || now()
  const flag = opt.force ? 'on' : flagOf(db, aid, 'confluence.self', 'off')
  if (flag !== 'on') return { ok: false, reason: 'off' }
  const cap = Math.max(1, Math.floor(Number(opt.perDay != null ? opt.perDay : getParam(db, aid, 'confluence.self_per_day', 1)) || 1))
  const gapDays = Math.max(1, Number(opt.gapDays != null ? opt.gapDays : getParam(db, aid, 'confluence.gap_days', 7)) || 7)
  const day = localDay(nowIso)
  const dayStart = new Date(day + 'T00:00:00+08:00').toISOString()
  let todayCount = 0
  let lastAny = null
  try {
    todayCount = db.prepare("SELECT COUNT(*) n FROM revisit WHERE agent_id=? AND source='self' AND at>=?").all(aid, dayStart)[0].n
    lastAny = db.prepare('SELECT at FROM revisit WHERE agent_id=? ORDER BY at DESC LIMIT 1').all(aid)[0]?.at || null
  } catch { /* 老库没有 revisit */ }
  if (todayCount >= cap) return { ok: false, reason: 'waterline', today: todayCount }
  if (lastAny && !opt.forceGap) {
    const since = Date.parse(nowIso) - Date.parse(lastAny)
    if (since < gapDays * 86400000) return { ok: false, reason: 'too_soon', days: Math.floor(since / 86400000) }
  }
  const cutoff = new Date(Date.parse(nowIso) - gapDays * 86400000).toISOString()
  let anchorRow = null
  try {
    anchorRow = db.prepare("SELECT at, turn_id FROM state_scene WHERE agent_id=? AND tier='heavy' AND at<=? ORDER BY at DESC LIMIT 1").all(aid, cutoff)[0] || null
  } catch { /* 老库没有 state_scene */ }
  if (!anchorRow) return { ok: false, reason: 'no-anchor' }
  const v = sceneView(db, aid, { at: anchorRow.at, level: 'L0' })
  if (!v.ok) return { ok: false, reason: v.reason || 'no-scene' }
  try { logConfluence(db, aid, { at: v.at, level: 'L0', bundle: v.bundle, mode: 'self', anchorTurn: anchorRow.turn_id }) } catch { /* 只记账 */ }
  recordRevisit(db, aid, {
    at: nowIso, anchorTurn: anchorRow.turn_id, mood: v.bundle && v.bundle.state && v.bundle.state.affect ? v.bundle.state.affect.label : null,
    note: '自己想起：' + localDay(anchorRow.at), source: 'self',
  })
  return { ok: true, at: v.at, level: 'L0', system: v.system, budget: v.budget, anchor: anchorRow }
}

/**
 * 手动入口：一个时刻 → 一个可读的现场（只读，不落账）。
 * 落账由调用方用 logConfluence；这样 API / 命令 / 测试共用一个实现。
 */
export function sceneView(db, aid, opt = {}) {
  const at = parseAt(opt.at || opt.from)
  if (!at) return { ok: false, reason: 'bad-at', at: String(opt.at || '') }
  const level = opt.level || 'L1'
  if (level === 'L2') {
    const rep = replayScene(db, aid, { at, sessionId: opt.sessionId })
    if (rep) {
      const header = '【记忆汇流 · 整段重放 ' + rep.at.slice(0, 10) + '】\n（这是那一轮拼好的整段上下文，原样取出。只在这一轮给你看，不写回、不改写。）\n\n'
      const system = header + rep.block + (rep.state ? '\n\n（那一轮的重截面也在：' + String(rep.state.affect_json || '').slice(0, 120) + '）' : '')
      return {
        ok: true, at, level, session: { id: rep.session_id, filtered: !!opt.sessionId },
        replay: { turn_id: rep.turn_id, at: rep.at, bytes: rep.bytes, delta_min: rep.delta_min },
        system, budget: { tokens: Math.ceil(system.length / 2), cap: SCENE.l2budget }, dropped: [],
      }
    }
  }
  // 默认会话：只在「看现在」（±1 小时）时自动带上正在说话的那条；翻旧账不替用户猜本子。
  let sessionId = opt.sessionId ? String(opt.sessionId) : null
  if (!sessionId && opt.session !== false && Math.abs(Date.parse(at) - Date.now()) <= 3600000) {
    try {
      const r = db.prepare(`SELECT session_id FROM fragments WHERE agent_id=? AND session_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`).all(aid)[0]
      if (r) sessionId = r.session_id
    } catch { /* 老库没有 fragments */ }
  }
  const bundle = reconstructScene(db, aid, at, { level: opt.level || 'L1', window: opt.window, sessionId })
  if (!bundle.ok) return { ok: false, reason: bundle.reason || 'no-bundle', at, session: bundle.session }
  const out = runConfluence(bundle, { ask: opt.ask || '', budget: opt.budget })
  const note = level === 'L2' ? '（这一轮没有整段留底，退回 16 轮的现场重建。）\n\n' : ''
  return { ok: true, at, level: bundle.level, session: bundle.session, note: level === 'L2' ? 'no-archive' : undefined, system: note + out.system, budget: out.budget, dropped: out.dropped, bundle }
}

/**
 * 「回到某天」的口令解析（P3.6）。只认明确带日期的说法，别把普通闲聊当命令。
 * 返回 { at, level }；不像口令就 null。
 */
export function parseBackCommand(text) {
  const t = String(text || '').trim()
  const m = t.match(/^(?:宝宝[，,]?\s*)?(?:我们|你)?\s*(?:回到|翻回|回看|看看)\s*(?:一下|一眼)?\s*[：:]?\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2})[:：](\d{2}))?/)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3])
  if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return null
  const hh = m[4] != null ? Number(m[4]) : 15
  const mi = m[5] != null ? Number(m[5]) : 0
  if (!(hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59)) return null
  // 库里存 Z；口令按本地（+08:00）写
  const iso = new Date(Date.UTC(y, mo - 1, da, hh - 8, mi)).toISOString()
  return { at: iso, level: 'L1' }
}

/**
 * 落一条「这次想起」（revisit）。跟 confluence_log 分开：
 * 前者是「我回去过」，后者是「我这次说了什么」；她真开口了才写。
 */
export function recordRevisit(db, aid, opt = {}) {
  try {
    const id = 'rv_' + crypto.randomBytes(8).toString('hex')
    db.prepare(`INSERT INTO revisit(id,agent_id,at,anchor_turn,memory_ids,mood,note,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, aid, iso(opt.at) || now(), opt.anchorTurn ? String(opt.anchorTurn) : null,
      opt.memoryIds && opt.memoryIds.length ? JSON.stringify(opt.memoryIds).slice(0, 400) : null,
      opt.mood ? String(opt.mood).slice(0, 40) : null,
      opt.note ? String(opt.note).slice(0, 400) : null,
      opt.source || 'confluence', now()
    )
    return id
  } catch { return null }
}

/** 落一条汇流审计账（失败静默）。 */
export function logConfluence(db, aid, opt = {}) {
  try {
    const id = 'cf_' + crypto.randomBytes(8).toString('hex')
    db.prepare(`INSERT INTO confluence_log(
      id,agent_id,at,anchor_turn,anchor_episode,level,bundle_hash,mode,spoken,adopted,looked_back_at,dropped,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, aid, iso(opt.at) || now(), opt.anchorTurn || null, opt.anchorEpisode || null,
      opt.level || 'L1', sha1(JSON.stringify(opt.bundle || {})).slice(0, 16), opt.mode || 'manual',
      opt.spoken ? String(opt.spoken).slice(0, 400) : null, opt.adopted ? 1 : 0, null,
      opt.dropped && opt.dropped.length ? JSON.stringify(opt.dropped).slice(0, 400) : null, now()
    )
    return id
  } catch { return null }
}

/**
 * 自然触发：一句话里带「回到某天」→ 重建现场 → 落审计账。
 *
 * 三条入口（网页口令 / /chat、微信、QQ / API）共用这一个实现：
 * 以前网页口令自己调 sceneView+logConfluence，/chat 那条路完全不认口令——
 * 同一个功能在不同通道一半有、一半没有，账也记不上。
 *
 * 返回 line 是可直接拼进提示词的那段：只在这一轮用，不写回历史。
 */
export function openConfluenceByText(db, aid, text, opt = {}) {
  const hit = parseBackCommand(text)
  if (!hit) return { ok: false, reason: 'no-command' }
  const v = sceneView(db, aid, { at: hit.at, level: hit.level, sessionId: opt.sessionId || null })
  if (!v.ok) return { ok: false, reason: v.reason || 'no-scene', at: hit.at }
  try {
    logConfluence(db, aid, {
      at: v.at,
      level: v.level,
      bundle: v.bundle,
      mode: opt.mode || 'auto',
      anchorTurn: v.bundle && v.bundle.anchor ? v.bundle.anchor.turn_id : null,
    })
  } catch { /* 只记账，失败不影响这一轮 */ }
  return {
    ok: true,
    v,
    line: '【你刚回到 ' + v.at.slice(0, 10) + ' 看了一眼】\n这一轮可以引用下面这段；它不是现在，别说成现在。\n\n' + v.system,
  }
}

/**
 * 留底的保留策略（P1 收口）：注入块 180 天 + 最多 2 万行；轻截面 180 天；重截面 360 天。
 * 只删自己的三张表；失败静默（清理不能挡住主流程）。
 */
export function pruneScenes(db, aid, opt = {}) {
  // 0（或负数）= 永不删。默认读参数，主人 11-10 定成 0/0。
  const daysRaw = opt.days != null ? Number(opt.days) : Number(getParam(db, aid, 'scene.retain.days', 0))
  const capRaw = opt.maxArchive != null ? Number(opt.maxArchive) : Number(getParam(db, aid, 'scene.retain.max_archive', 0))
  const days = Number.isFinite(daysRaw) ? daysRaw : 0
  const maxArchive = Number.isFinite(capRaw) ? capRaw : 0
  const cutoff = days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : null
  const heavyCutoff = days > 0 ? new Date(Date.now() - days * 2 * 86400000).toISOString() : null
  const out = { archive: 0, light: 0, heavy: 0 }
  if (cutoff) try {
    out.archive += Number(db.prepare('DELETE FROM scene_archive WHERE agent_id=? AND at<?').run(aid, cutoff).changes || 0)
  } catch { /* 老库没这张表 */ }
  if (maxArchive > 0) try {
    out.archive += Number(db.prepare(
      `DELETE FROM scene_archive WHERE agent_id=? AND rowid NOT IN (
         SELECT rowid FROM scene_archive WHERE agent_id=? ORDER BY at DESC LIMIT ?)`
    ).run(aid, aid, maxArchive).changes || 0)
  } catch { /* ignore */ }
  if (cutoff) try {
    out.light += Number(db.prepare("DELETE FROM state_scene WHERE agent_id=? AND tier='light' AND at<?").run(aid, cutoff).changes || 0)
  } catch { /* ignore */ }
  if (heavyCutoff) try {
    out.heavy += Number(db.prepare("DELETE FROM state_scene WHERE agent_id=? AND tier='heavy' AND at<?").run(aid, heavyCutoff).changes || 0)
  } catch { /* ignore */ }
  return out
}
