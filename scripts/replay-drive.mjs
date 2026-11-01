#!/usr/bin/env node
/**
 * 驱力缺口回放：拿真实事件重放，比较不同 deficit 公式。
 *
 * 数据源（只读）：~/.dsh/consciousness/app.db
 *   events.type='drive.satisfaction' → 每次结算后的 dims 快照
 *   events.type='drive.evaluated'    → 当时的 D / band / 档位（用作对照）
 *
 * 用法：
 *   node scripts/replay-drive.mjs                    # 默认挑事件最多的实例
 *   node scripts/replay-drive.mjs --agent agt_xxx
 *   node scripts/replay-drive.mjs --ticks 1000       # 把快照按时间线性插值到 1000 tick
 *   node scripts/replay-drive.mjs --variant max,l2   # l2 = D 用平方和开根（预览“不再 max”）
 *   node scripts/replay-drive.mjs --json
 *
 * 输出：每个公式的档位切换次数、饱和率、基线误差、D 分布、与线上档位的一致率、
 *       以及“缺口—行为一致性”（主动开口那条的维度当时是不是最高的缺口）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deficitV1, deficitV1b, deficitV1c, deficitV1d, deficitV2 } from '../src/algo/deficit.js'

const SETPOINT = { R: 0.6, E: 0.6, C: 0.6, A: 0.6, S: 0.6 }
const COUPLING = 0.05
const ALPHA = 0.35
const TICK_MS = 1000

function parseArgs(argv) {
  const out = { agent: null, ticks: 0, variants: 'max', json: false, db: null, scenario: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--agent') out.agent = argv[++i]
    else if (a === '--ticks') out.ticks = Number(argv[++i]) || 0
    else if (a === '--variant') out.variants = String(argv[++i] || 'max')
    else if (a === '--scenario') out.scenario = String(argv[++i] || '')
    else if (a === '--db') out.db = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0] + '*/'); process.exit(0) }
  }
  return out
}

/** 合成场景：不用等真实数据，先看候选公式在极端轨迹上的差别。 */
function syntheticTicks(kind) {
  const at0 = Date.now() - 200000
  const out = []
  if (kind === 'spike') {
    // 冷启动/休眠回来：连续 30 tick 全维满足度为 0，然后恢复
    for (let i = 0; i < 30; i++) out.push({ at: at0 + i * 1000, dims: { R: 0, E: 0, C: 0, A: 0, S: 0 } })
    for (let i = 30; i < 60; i++) out.push({ at: at0 + i * 1000, dims: { R: 0.6, E: 0.6, C: 0.6, A: 0.6, S: 0.6 } })
    return out
  }
  if (kind === 'multi') {
    // 五维同时缺：看 D=max 和 D=L2 的差别
    for (let i = 0; i < 60; i++) {
      const b = 0.3 + 0.02 * Math.sin(i / 6)
      out.push({ at: at0 + i * 1000, dims: { R: b, E: b, C: b, A: b, S: b } })
    }
    return out
  }
  return []
}

function defaultDb() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'consciousness', 'app.db')
}

function openReadOnly(file) {
  if (!fs.existsSync(file)) {
    console.error('找不到数据库：' + file)
    process.exit(1)
  }
  return new DatabaseSync(file, { readOnly: true })
}

function parseJson(s) {
  try { return JSON.parse(s || '{}') } catch { return {} }
}

function pickAgent(db, wanted) {
  if (wanted) return wanted
  const row = db.prepare(`SELECT agent_id, COUNT(*) n FROM events
    WHERE type='drive.satisfaction' GROUP BY agent_id ORDER BY n DESC LIMIT 1`).get()
  if (!row) {
    console.error('库里没有 drive.satisfaction 事件，没法回放')
    process.exit(1)
  }
  return row.agent_id
}

function loadTicks(db, aid) {
  const rows = db.prepare(`SELECT rowid rid, created_at, payload FROM events
    WHERE agent_id=? AND type='drive.satisfaction' ORDER BY rowid`).all(aid)
  return rows.map((r) => {
    const p = parseJson(r.payload)
    return { at: Date.parse(r.created_at), dims: p.dims || null }
  }).filter((x) => x.dims && Number.isFinite(x.at))
}

function loadBands(db, aid) {
  const rows = db.prepare(`SELECT created_at, payload FROM events
    WHERE agent_id=? AND type='drive.evaluated' ORDER BY rowid`).all(aid)
  return rows.map((r) => {
    const p = parseJson(r.payload)
    return { at: Date.parse(r.created_at), band: p.band, D: p.D }
  }).filter((x) => x.band && Number.isFinite(x.at))
}

function loadProactive(db, aid) {
  try { return db.prepare('SELECT dim, created_at FROM proactive WHERE agent_id=? ORDER BY created_at').all(aid) } catch { return [] }
}

function loadPersona(db, aid) {
  const out = {}
  try {
    const rows = db.prepare("SELECT path,value FROM persona WHERE agent_id=? AND path LIKE 'big5.%'").all(aid)
    for (const r of rows) {
      const v = Number(r.value)
      if (Number.isFinite(v)) out[r.path.slice(5)] = v
    }
  } catch { /* 老库没有 persona */ }
  return out
}

function interpolate(points, wanted) {
  if (!wanted || wanted <= points.length || points.length < 2) return points
  const t0 = points[0].at, t1 = points[points.length - 1].at
  const span = Math.max(1, t1 - t0)
  const out = []
  let j = 0
  for (let i = 0; i < wanted; i++) {
    const at = t0 + (span * i) / (wanted - 1)
    while (j + 1 < points.length && points[j + 1].at < at) j++
    const a = points[j], b = points[Math.min(j + 1, points.length - 1)]
    const k = b.at > a.at ? (at - a.at) / (b.at - a.at) : 0
    const dims = {}
    for (const d of ['R', 'E', 'C', 'A', 'S']) dims[d] = a.dims[d] + (b.dims[d] - a.dims[d]) * k
    out.push({ at, dims })
  }
  return out
}

function nearestBand(bands, at) {
  if (!bands.length) return null
  let lo = 0, hi = bands.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bands[mid].at < at) lo = mid + 1
    else hi = mid
  }
  let pick = bands[lo]
  for (const i of [lo - 1, lo + 1]) {
    if (bands[i] && Math.abs(bands[i].at - at) < Math.abs(pick.at - at)) pick = bands[i]
  }
  return pick
}

// v1 的进入/离开阈值；l2 预览沿用同一套，阈值没有重标定
const ENTER = { D0: 0.10, D1: 0.30, D2: 0.50, D3: 0.70 }
const EXIT = { D0: 0.05, D1: 0.25, D2: 0.45, D3: 0.65 }

function bandOf(D, prevBand) {
  const order = ['D0', 'D1', 'D2', 'D3']
  const rise = D >= ENTER.D3 ? 3 : D >= ENTER.D2 ? 2 : D >= ENTER.D1 ? 1 : 0
  const prev = Math.max(0, order.indexOf(prevBand))
  if (rise > prev) return order[rise]
  let cur = prev
  while (cur > 0 && D < EXIT[order[cur]]) cur--
  return order[cur]
}

function aggregate(smooth, variant) {
  const vals = Object.values(smooth).map((x) => Number(x) || 0)
  if (variant === 'l2') return Math.min(1, Math.sqrt(vals.reduce((s, x) => s + x * x, 0)))
  return Math.max(...vals)
}

function runFormula(formula, ticks, persona = {}) {
  let smoothPrev = null
  let prevBand = 'D0'
  const out = []
  for (const t of ticks) {
    const r = formula.run({}, {
      dims: t.dims, setpoint: SETPOINT, coupling: COUPLING,
      persona, smooth_prev: smoothPrev, prev_band: prevBand, alpha: ALPHA,
    })
    smoothPrev = r.smooth
    prevBand = r.band
    out.push({ at: t.at, raw: r.raw, smooth: r.smooth, D: r.D, band: r.band })
  }
  return out
}

function summarize(series, bands, variant, proactive) {
  let switches = 0, sat = 0, errSum = 0, dSum = 0, dMax = 0
  const dist = { D0: 0, D1: 0, D2: 0, D3: 0 }
  let prev = null
  const rows = []
  for (const s of series) {
    const D = aggregate(s.smooth, variant)
    const band = variant === 'max' ? s.band : bandOf(D, prev || 'D0')
    if (prev && band !== prev) switches++
    prev = band
    dist[band] = (dist[band] || 0) + 1
    if (D >= 0.95) sat++
    let err = 0
    for (const d of ['R', 'E', 'C', 'A', 'S']) err += Math.abs(Number(s.smooth[d] || 0) - Number(s.raw[d] || 0))
    errSum += err / 5
    dSum += D
    dMax = Math.max(dMax, D)
    rows.push({ at: s.at, smooth: s.smooth, raw: s.raw, band })
  }
  const n = rows.length || 1

  // 与线上档位一致率（只看时间对得上的）
  let compared = 0, agree = 0
  for (const s of rows) {
    const b = nearestBand(bands, s.at)
    if (b && Math.abs(b.at - s.at) <= 120000) {
      compared++
      if (b.band === s.band) agree++
    }
  }

  // 缺口—行为一致性：主动开口那一条，对应的维度当时是不是最大的缺口（且 ≥0.3）
  let matched = 0
  const behavior = []
  for (const p of proactive) {
    const at = Date.parse(p.created_at)
    let s = null
    for (const x of rows) { if (x.at <= at + 60000) s = x; else break }
    if (!s) continue
    const dims = Object.entries(s.smooth).map(([k, v]) => [k, Number(v) || 0]).sort((a, b) => b[1] - a[1])
    const top = dims[0]
    const ok = !!top && top[0] === p.dim && top[1] >= 0.3
    if (ok) matched++
    behavior.push({ dim: p.dim, at: p.created_at, top: top && top[0], top_deficit: top && +top[1].toFixed(3), ok })
  }

  const spanDays = rows.length > 1 ? (rows[rows.length - 1].at - rows[0].at) / 86400000 : 0
  return {
    ticks: rows.length,
    span_days: +spanDays.toFixed(2),
    band_switches: switches,
    // 90 天外推只在样本跨度 ≥7 天时给，否则 1 天的 1 次切换会外推成离谱的数
    switches_per_90d: spanDays >= 7 ? +(switches * 90 / spanDays).toFixed(1) : null,
    saturation: +(sat / n).toFixed(3),
    baseline_error: +(errSum / n).toFixed(4),
    D_mean: +(dSum / n).toFixed(3),
    D_max: +dMax.toFixed(3),
    bands: dist,
    live_agree: compared ? +(agree / compared).toFixed(3) : null,
    live_compared: compared,
    behavior_n: behavior.length,
    behavior_match: behavior.length ? +(matched / behavior.length).toFixed(3) : null,
    behavior,
    band_trace: rows.slice(0, 12).map((x) => x.band),
  }
}

function fmtPct(x) { return x == null ? '—' : (x * 100).toFixed(1) + '%' }

function main() {
  const args = parseArgs(process.argv.slice(2))
  const db = openReadOnly(args.db || defaultDb())
  let aid, raw, bands, proactive, ticks, persona
  if (args.scenario) {
    aid = args.agent || 'synthetic'
    ticks = syntheticTicks(args.scenario)
    if (!ticks.length) {
      console.error('未知场景：' + args.scenario + '（支持 spike / multi）')
      process.exit(1)
    }
    raw = ticks
    bands = []
    proactive = []
    persona = args.agent ? loadPersona(db, aid) : {}
  } else {
    aid = pickAgent(db, args.agent)
    raw = loadTicks(db, aid)
    if (!raw.length) {
      console.error('实例 ' + aid + ' 没有 drive.satisfaction 快照（还没评估过驱力），没法回放')
      process.exit(1)
    }
    bands = loadBands(db, aid)
    proactive = loadProactive(db, aid)
    ticks = interpolate(raw, args.ticks)
    persona = loadPersona(db, aid)
  }

  const formulas = { 'v1': deficitV1, 'v1b': deficitV1b, 'v1c': deficitV1c, 'v1d': deficitV1d, 'v2': deficitV2 }
  const variants = String(args.variants || 'max').split(',').map((s) => s.trim()).filter(Boolean)

  const results = []
  for (const [name, f] of Object.entries(formulas)) {
    const series = runFormula(f, ticks, persona)
    for (const v of variants) {
      const sum = summarize(series, bands, v, proactive)
      results.push({ formula: name, variant: v, ...sum })
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ agent: args.scenario ? null : aid, scenario: args.scenario || null, ticks_source: raw.length, ticks_used: ticks.length, results }, null, 2))
    return
  }

  const head0 = args.scenario
    ? '合成场景 ' + args.scenario + ' · ' + ticks.length + ' tick（不是真实回放）'
    : 'agent ' + aid + ' · 快照 ' + raw.length + ' 条 · 回放 ' + ticks.length + ' tick' +
      (args.ticks && args.ticks > raw.length ? '（线性插值）' : '') +
      (results[0] ? ' · 跨度 ' + results[0].span_days + ' 天' : '')
  console.log(head0)
  console.log('')
  const head = ['公式', 'tick', '跨档', '跨档/90d*', '饱和率', '基线误差', 'D均值', 'D峰', 'D0/D1/D2/D3', '与线上一致']
  const rows = results.map((r) => [
    r.formula + '@' + r.variant,
    String(r.ticks),
    String(r.band_switches),
    r.switches_per_90d == null ? '—' : String(r.switches_per_90d),
    fmtPct(r.saturation),
    String(r.baseline_error),
    String(r.D_mean),
    String(r.D_max),
    r.bands.D0 + '/' + r.bands.D1 + '/' + r.bands.D2 + '/' + r.bands.D3,
    r.live_agree == null ? '—' : fmtPct(r.live_agree),
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((x) => x[i].length)))
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  console.log(line(head))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of rows) console.log(line(r))

  console.log('')
  if (args.scenario) {
    console.log('档位轨迹（前 12 tick）：')
    for (const r of results) console.log('  ' + (r.formula + '@' + r.variant).padEnd(8) + ' ' + r.band_trace.join(' '))
    console.log('')
  }
  for (const r of results) {
    if (!r.behavior_n) continue
    console.log('缺口—行为（' + r.formula + '@' + r.variant + '）：' + r.behavior_n + ' 条主动开口，' +
      (r.behavior_match == null ? '—' : fmtPct(r.behavior_match)) + ' 当时是最高缺口')
    for (const b of r.behavior) {
      console.log('  - ' + b.at + ' 想说的维度 ' + b.dim + '，当时最高 ' + b.top + ' ' + b.top_deficit + (b.ok ? ' ✓' : ' ✗'))
    }
  }
  console.log('')
  console.log('说明：max = 现行 D=max(ñ)；l2 = 预览（D=min(1,√Σñ²)，阈值未重标定）。')
  console.log('     跨档/90d* 只在跨度 ≥7 天时外推，否则 —。')
  if (args.ticks && args.ticks > raw.length) {
    console.log('     注意：--ticks 是线性插值出来的点，平滑 α 会按点更新得更密，档位统计只作参考。')
  }
  console.log('     基线误差 = 平滑基线 ñ 对瞬时缺口 n 的一步残差均值；饱和率 = D≥0.95 的 tick 占比。')
}

main()
