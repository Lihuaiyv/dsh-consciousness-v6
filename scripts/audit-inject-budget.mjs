/**
 * 注入预算基线（只读，2026-11-15）
 *
 * 目的：给「一张预算表」定基线，不猜。
 *   1. 检索注入（memory pack）实际 token：metric_samples.type='sys.inject_tokens'
 *   2. 事件行实际字数：events.type='event.inject' 的 payload.chars
 *   3. 当前预算参数：event.inject.budget 等
 * 只读真库，不改任何东西。
 */
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DB = process.argv[2] || path.resolve('..', 'runtime', 'consciousness', 'app.db')
const db = new DatabaseSync(DB, { readOnly: true })

const median = (xs) => {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2)
}
const pct = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null }

const out = {}
try {
  const toks = db.prepare("SELECT value FROM metric_samples WHERE key='sys.inject_tokens' ORDER BY sampled_at DESC LIMIT 300").all().map((r) => Number(r.value)).filter((n) => Number.isFinite(n))
  out.memoryInject = { n: toks.length, median: median(toks), p90: pct(toks, 0.9), max: toks.length ? Math.max(...toks) : null, budget: 800 }
} catch { out.memoryInject = { n: 0, error: 'metric_samples 不可用' } }

try {
  const evs = db.prepare("SELECT payload FROM events WHERE type='event.inject' ORDER BY created_at DESC LIMIT 300").all()
    .map((r) => { try { return JSON.parse(r.payload || '{}') } catch { return {} } })
    .map((p) => Number(p.chars)).filter((n) => Number.isFinite(n))
  out.eventLine = { n: evs.length, median: median(evs), p90: pct(evs, 0.9), max: evs.length ? Math.max(...evs) : null, budget: 400 }
} catch { out.eventLine = { n: 0, error: 'events 不可用' } }

try {
  const hits = db.prepare("SELECT COUNT(*) n FROM events WHERE type='event.inject' AND created_at>=?").get(new Date(Date.now() - 7 * 24 * 3600e3).toISOString())
  out.eventInject7d = hits.n
} catch { /* 老库 */ }

console.log(JSON.stringify(out))
db.close()
