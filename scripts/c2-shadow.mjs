/**
 * C2 认识蒸馏 · 影子跑批（聚类 + 升格版，2026-11-15）
 *
 * 流程（对齐「抽象切稳定」）：
 *   事件 → 候选 gist → 跨事件聚类 → 同一 gist 出现在 ≥2 件独立事件 → 升为事实候选
 *   只出现 1 次的，留影子标 weak，不升格。
 *
 * 只读真库、只写 scratch；不碰 memory_items、不进注入。
 *   node scripts/c2-shadow.mjs 60
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { localComplete } from '../src/modules/local_llm.js'
import { distillEvent, judgeFacts, clusterCandidates, promoteClusters } from '../src/modules/fact_distill.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DB = path.resolve(here, '..', '..', 'runtime', 'consciousness', 'app.db')
const AID = 'agt_3977d80f17'
const LIMIT = Math.max(2, Math.min(500, Number(process.argv[2]) || 60))
const DIR = path.resolve(here, '..', '..', 'scratch', 'c2-shadow')
fs.mkdirSync(DIR, { recursive: true })
const STATE = path.join(DIR, 'state.json')
const OUT_FACTS = path.join(DIR, 'facts.jsonl')
const OUT_CLUSTERS = path.join(DIR, 'clusters.jsonl')

let state = { lastAt: null }
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { /* 第一次 */ }

const db = new DatabaseSync(DB, { readOnly: true })
const where = state.lastAt ? 'AND created_at > ?' : ''
const args = state.lastAt ? [AID, state.lastAt, LIMIT] : [AID, LIMIT]
const events = db.prepare(`SELECT id, title, story, quotes, created_at FROM cold_events
  WHERE agent_id=? ${where} ORDER BY created_at ASC LIMIT ?`).all(...args)
db.close()

const call = (_db, req) => localComplete(DB, { ...req, temperature: 0, seed: 42 })
const existing = []
try { for (const line of fs.readFileSync(OUT_FACTS, 'utf8').split('\n')) if (line.trim()) existing.push(JSON.parse(line).text) } catch { /* 没有 */ }

const t0 = Date.now()
const candidates = []      // { kind, text, why, event }
const eventMeta = []       // 与 candidates 一一对应的 { id, at }
let genEmpty = 0, failed = 0
const droppedGen = {}
for (const ev of events) {
  try {
    const d = await distillEvent(null, call, ev)
    if (!d.facts.length) { genEmpty++; continue }
    const j = await judgeFacts(call, {
      facts: d.facts,
      sourceText: `事件：${ev.title}\n经过：${String(ev.story || '')}\n原话：${String(ev.quotes || '')}`,
      existing,
    })
    for (const f of j.dropped) droppedGen[f.reason] = (droppedGen[f.reason] || 0) + 1
    for (const f of j.kept) {
      candidates.push({ kind: f.kind, subject: f.subject, subject_id: f.subject_id, status: f.status, basis: f.basis, confidence: f.confidence, importance: f.importance, sensitivity: f.sensitivity, scope: f.scope, text: f.text, why: f.why, cue: f.cue, effect: f.effect, valid_from: f.valid_from, valid_until: f.valid_until })
      eventMeta.push({ id: ev.id, at: ev.created_at })
    }
  } catch { failed++ }
}

// 聚类：候选太多时分批（每批 60），批内聚完再合并不了跨批同义——所以先只做单批
const CHUNK = 20
const clusters = []
for (let off = 0; off < candidates.length; off += CHUNK) {
  const part = candidates.slice(off, off + CHUNK)
  const cs = await clusterCandidates(call, part)
  for (const c of cs) clusters.push({ ...c, members: c.members.map((i) => i + off) })
}
const { promoted, weak } = promoteClusters(clusters, eventMeta)

if (events.length) {
  const nowIso = new Date().toISOString()
  const lines = promoted.map((c) => JSON.stringify({ created_at: nowIso, updated_at: nowIso, kind: c.kind, subject: c.subject, subject_id: c.subject_id, status: c.status, basis: c.basis, confidence: c.confidence, importance: c.importance, sensitivity: c.sensitivity, scope: c.scope, text: c.text, why: c.why, cue: c.cue, effect: c.effect, valid_from: c.valid_from, valid_until: c.valid_until, support: c.support, events: c.events }))
  const clines = clusters.map((c) => JSON.stringify({ at: new Date().toISOString(), kind: c.kind, text: c.text, falsifier: c.falsifier, support: [...new Set(c.members.map((i) => eventMeta[i] && eventMeta[i].id))].length }))
  const wlines = weak.map((c) => JSON.stringify({ at: new Date().toISOString(), kind: c.kind, text: c.text, cue: c.cue, effect: c.effect, falsifier: c.falsifier, support: c.support, weakReason: c.weakReason }))
  if (wlines.length) fs.appendFileSync(path.join(DIR, 'weak.jsonl'), wlines.join('\n') + '\n', 'utf8')
  if (lines.length) fs.appendFileSync(OUT_FACTS, lines.join('\n') + '\n', 'utf8')
  if (clines.length) fs.appendFileSync(OUT_CLUSTERS, clines.join('\n') + '\n', 'utf8')
  fs.writeFileSync(STATE, JSON.stringify({ lastAt: events[events.length - 1].created_at, at: new Date().toISOString() }, null, 1), 'utf8')
}

console.log(JSON.stringify({
  events: events.length, candidates: candidates.length, genEmpty, failed,
  droppedByGenerator: droppedGen,
  clusters: clusters.length, promoted: promoted.length, weak: weak.length,
  avgMs: events.length ? Math.round((Date.now() - t0) / events.length) : 0,
  out: OUT_FACTS,
}, null, 1))
if (promoted.length) {
  console.log('\n升格（≥2 件事支持）：')
  for (const c of promoted.slice(0, 12)) console.log(`- [${c.kind} ×${c.support}] ${c.text}  ｜下次：${c.cue.slice(0, 22)} ｜做法：${c.effect.slice(0, 18)}`)
} else {
  console.log('\n没有 ≥2 件支持的候选——按规则全部留在影子（weak）。')
}
