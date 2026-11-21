/**
 * 夜里增量判：只判最近几天新切出来的事，把「主干边」写进 event_edges。
 * 用法：
 *   node scripts/judge-causal.mjs                 # 判最近 1 天（默认，给定时任务用）
 *   node scripts/judge-causal.mjs --days 3        # 判最近 3 天
 *   node scripts/judge-causal.mjs --dry           # 只判不写库
 *   node scripts/judge-causal.mjs --limit 50      # 最多判多少件（防跑超时）
 *
 * 开关：flags 里 event.causal.write=on 才写库；默认 off（影子），只打日志。
 * 证据：必须能在原话（cold_events.quotes）里找到，摘要写得再像也不算。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { getFlag } from '../src/kernel.js'
import { judgeBatch, writeJudgedEdges, counterfactualCheck, demoteIfStill } from '../src/modules/event_causal.js'

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d }
const strArg = (k) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : '' }
const DAYS = argOf('--days', 1)
const LIMIT = argOf('--limit', 200)
const DRY = process.argv.includes('--dry')
// 边跑边存（2026-11-17）：进程被带走时结果不丢，下一次读到已有 id 直接跳过。
const OUT = strArg('--out')
// 按天判（2026-11-17）：切事哪天 done 了，worker 就判那天；不按滚动 24 小时，免得跨天漏。
const DAY = strArg('--day')
// 判边用哪个模型（2026-11-17 主人定）：--model main = 宿主主模型（按 token 计费，一天一两块）；
// 默认 local = 本地 Ollama（免费）。切事一直留在本地。
const VIA = strArg('--model') === 'main' ? 'main' : 'local'

const db = openDb(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'runtime', 'consciousness', 'app.db'))
const aid = db.prepare('SELECT id FROM agents ORDER BY created_at LIMIT 1').get().id
const since = new Date(Date.now() - DAYS * 86400000).toISOString()
const arr = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }

// 已经判过的（记账在 events 里，一天一轮不重判）
const judged = new Set()
try {
  for (const r of db.prepare("SELECT json_extract(payload,'$.eventId') id FROM events WHERE agent_id=? AND type='event.causal.judge'").all(aid)) {
    if (r.id) judged.add(r.id)
  }
} catch { /* 没记录就全判 */ }

// 轮次 → 会话 + 序号（发生前后）
const turnMeta = new Map()
for (const r of db.prepare(`SELECT turn_id, session_id, seq FROM fragments
  WHERE agent_id=? AND turn_id IS NOT NULL AND session_id IS NOT NULL`).all(aid)) {
  if (!turnMeta.has(r.turn_id)) turnMeta.set(r.turn_id, { session: r.session_id, seq: Number(r.seq) || 0 })
}
const rows = DAY
  ? db.prepare(`SELECT h.id, h.title, h.story, h.cues, c.quotes, c.start_at, c.end_at, c.turn_ids
    FROM hot_events h JOIN cold_events c ON c.id=json_extract(h.source_cold_ids,'$[0]')
    WHERE h.agent_id=? AND h.active=1 AND date(c.start_at,'+8 hours')=?
    ORDER BY c.start_at ASC`).all(aid, DAY)
  : db.prepare(`SELECT h.id, h.title, h.story, h.cues, c.quotes, c.start_at, c.end_at, c.turn_ids
    FROM hot_events h JOIN cold_events c ON c.id=json_extract(h.source_cold_ids,'$[0]')
    WHERE h.agent_id=? AND h.active=1 AND c.start_at >= ?
    ORDER BY c.start_at ASC`).all(aid, since)
const ev = rows.map((r) => {
  const turns = arr(r.turn_ids)
  const metas = turns.map((t) => turnMeta.get(String(t))).filter(Boolean)
  return {
    id: r.id, title: r.title, story: r.story || '', cues: arr(r.cues), quotes: arr(r.quotes),
    startAt: r.start_at, endAt: r.end_at,
    session: metas.length ? metas[0].session : '', seq: metas.length ? Math.min(...metas.map((m) => m.seq)) : null,
  }
})
const specific = (c) => {
  const s = String(c || '').trim()
  if (!s) return false
  if (/^[\d.,:]+$/.test(s) || /^[a-z]+:/i.test(s) || s.includes('://')) return false
  return /[A-Za-z0-9]/.test(s) || Array.from(s).length >= 3
}
const bySession = new Map()
for (const e of ev) { if (!e.session) continue; if (!bySession.has(e.session)) bySession.set(e.session, []); bySession.get(e.session).push(e) }
for (const a of bySession.values()) a.sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0))

function candidatesOf(a) {
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
    if (a.cues.some((c) => specific(c) && b.cues.includes(c))) push(b)
  }
  return out.slice(0, 6)
}

const writeOn = String(getFlag(db, 'event.causal.write') || 'off') === 'on' && !DRY
// 续跑：--out 里已经判过的就不再判（进程被杀也能接着跑）
const done = new Set()
if (OUT && fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { const j = JSON.parse(line); if (j.id) done.add(j.id) } catch { /* 坏行跳过 */ }
  }
  if (done.size) console.log(`续跑：${OUT} 里已有 ${done.size} 件，跳过`)
}
const todo = ev.filter((e) => !judged.has(e.id) && !done.has(e.id)).slice(0, LIMIT)
console.log(`增量判：${since.slice(0, 10)} 以后 ${ev.length} 件，未判 ${todo.length} 件，写库=${writeOn ? 'on' : 'off'}`)

let calls = 0, pairs = 0, usable = 0, written = 0, confirmed = 0
const rels = {}
const t0 = Date.now()
for (const a of todo) {
  const cands = candidatesOf(a)
  if (!cands.length) continue
  let res = []
  try { res = await judgeBatch(db, a, cands, { via: VIA }) } catch (e) { console.log('判失败:', e.message); continue }
  // 反事实重排（2026-11-17）：判成因果的，再问一句"没有 A，B 还会发生吗"；还会 → 降级成"接着做"，不是因果。
  // 照 CRECE 的两阶段做法，专治"文本上强相关被当成因果"。
  for (const r of res) {
    if (!r.ok || !['cause', 'enable', 'prevent', 'revise', 'resolve'].includes(r.relation)) continue
    const b = cands.find((c) => c.id === r.id)
    if (!b) continue
    const cf = await counterfactualCheck(db, a, b, { via: VIA })
    if (cf.still != null) Object.assign(r, demoteIfStill(r, cf.still))
  }
  calls++
  // 边跑边存：一件判完立刻落盘，进程被带走也不丢
  if (OUT) {
    try { fs.appendFileSync(OUT, JSON.stringify({ id: a.id, title: a.title, res }) + '\n', 'utf8') } catch { /* 写不进不影响判 */ }
  }
  for (const r of res) {
    pairs++
    rels[r.relation] = (rels[r.relation] || 0) + 1
    if (r.ok) usable++
    if (!DRY) {
      try {
        db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
          'evt_' + Math.random().toString(36).slice(2, 12), aid, 'event.causal.judge',
          JSON.stringify({ eventId: a.id, cands: res.length, usable: res.filter((x) => x.ok).length }), new Date().toISOString())
      } catch { /* 记账失败不影响 */ }
    }
  }
  if (writeOn) {
    const w = writeJudgedEdges(db, aid, [{ a: { id: a.id, title: a.title }, res }], { nowMs: Date.now() })
    written += w.written; confirmed += w.confirmed
  }
  if (calls % 10 === 0) console.log(`  ${calls} 次调用 / ${pairs} 对 / 可用 ${usable} / ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}
console.log(`\n完：调用 ${calls} 次 · 判 ${pairs} 对 · 可用 ${usable}（${(100 * usable / Math.max(1, pairs)).toFixed(0)}%）`)
console.log('关系分布:', JSON.stringify(rels))
console.log(writeOn ? `写库：${written} 条（confirmed ${confirmed}）` : '没写库（event.causal.write 不是 on，影子跑）')
// 按天判完记一笔：后台 worker 靠这个标记知道这天已经判过（2026-11-17）
if (DAY && !DRY) {
  try {
    db.prepare('INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`event.causal.judged.${DAY}`, new Date().toISOString())
  } catch { /* 记不上不影响已判结果 */ }
}
db.close()
