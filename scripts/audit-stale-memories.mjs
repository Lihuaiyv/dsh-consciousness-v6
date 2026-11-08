#!/usr/bin/env node
/**
 * S0 只读体检：给现行记忆发「护照」，数出多少条旧结论可能被当成现状。
 *
 * 只读：用 DatabaseSync readOnly 打开，不 touch、不写库。
 * 用法：
 *   node scripts/audit-stale-memories.mjs [--db <path>] [--agent <name>] [--json <out>]
 */
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

const dbPath = arg('db', (process.env.DSH_DB || (process.env.DSH_HOME || 'C:/Users/l/.dsh').replace(/\\/g, '/') + '/consciousness/app.db'))
const agentName = arg('agent', '小汐')
const jsonOut = arg('json', '')

const db = new DatabaseSync(dbPath, { readOnly: true })
const agent = db.prepare('SELECT id, name FROM agents WHERE name=?').get(agentName)
if (!agent) {
  console.error('找不到意识体: ' + agentName)
  process.exit(1)
}
const aid = agent.id

const EXCLUDE = new Set(['用户', '助手', '我', '你', '他', '她', '主人', '小汐', '对方', '自己'])
const STATE_WORDS = new Set(['待完成', '完成', '已完成', '已', '未', '进行中', '待办', '已做', '没做', '还没做'])

/** fact_key → 主题段（去掉主体段和状态段，取最长的一段） */
function topicOf(fk) {
  const parts = String(fk || '').split('.').map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return ''
  const mid = parts.slice(1, parts.length > 2 ? -1 : undefined)
    .filter((s) => s.length >= 2 && !EXCLUDE.has(s) && !STATE_WORDS.has(s))
  mid.sort((a, b) => b.length - a.length)
  return mid[0] || ''
}

/** 解析 fact_archive.payload，拿回链。 */
function derivedOf(payload) {
  if (!payload) return null
  try {
    const p = JSON.parse(payload)
    return p.episode_id ? 'episode:' + p.episode_id : (p.source_turn_id ? 'turn:' + p.source_turn_id : null)
  } catch { return null }
}

const rows = db.prepare(`SELECT * FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL ORDER BY created_at`).all(aid)

const tl = db.prepare(`SELECT memory_id, op, at, valid_from FROM memory_timeline WHERE agent_id=? ORDER BY seq`).all(aid)
const tlBy = new Map()
for (const e of tl) {
  if (!tlBy.has(e.memory_id)) tlBy.set(e.memory_id, [])
  tlBy.get(e.memory_id).push(e)
}

const fa = db.prepare(`SELECT memory_id, payload FROM fact_archive WHERE agent_id=?`).all(aid)
const faBy = new Map(fa.map((x) => [x.memory_id, x.payload]))

// 同主题分组 → 找出「更晚的同主题说法」
const byTopic = new Map()
for (const r of rows) {
  const t = topicOf(r.fact_key)
  if (!t) continue
  if (!byTopic.has(t)) byTopic.set(t, [])
  byTopic.get(t).push(r)
}
const stale = []
const laterAt = new Map()
for (const [topic, list] of byTopic) {
  if (list.length < 2) continue
  list.sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
  for (let i = 0; i < list.length - 1; i++) {
    const old = list[i]
    const newer = list.slice(i + 1).find((x) =>
      Date.parse(x.created_at) - Date.parse(old.created_at) >= 30 * 60000)
    if (!newer) continue
    laterAt.set(old.id, newer)
    stale.push({ old, newer, topic })
  }
}

const withFactKey = rows.filter((r) => String(r.fact_key || '').trim()).length
const withTimeline = rows.filter((r) => tlBy.has(r.id)).length
const withOccurred = rows.filter((r) => {
  const ev = (tlBy.get(r.id) || []).find((e) => e.op === 'ADD')
  return !!(ev && ev.valid_from) || !!r.created_at
}).length
const withDerived = rows.filter((r) => derivedOf(faBy.get(r.id)) || r.source_turn_id).length
const withValidUntil = rows.filter((r) => r.invalid_at || laterAt.has(r.id)).length

const conflicts = db.prepare("SELECT state, severity, COUNT(*) n FROM conflicts WHERE agent_id=? GROUP BY state, severity").all(aid)

const report = {
  generated_at: new Date().toISOString(),
  agent: agentName,
  db: dbPath,
  totals: {
    active: rows.length,
    with_fact_key: withFactKey,
    with_timeline: withTimeline,
    with_derived: withDerived,
  },
  passport_coverage: {
    occurred: withOccurred,
    recorded: rows.length,
    valid_until: withValidUntil,
    derived: withDerived,
  },
  stale_candidates: stale.length,
  stale_samples: stale.slice(0, 15).map((x) => ({
    old_id: x.old.id,
    old_text: String(x.old.text).slice(0, 60),
    old_key: x.old.fact_key || null,
    newer_id: x.newer.id,
    newer_text: String(x.newer.text).slice(0, 60),
    newer_key: x.newer.fact_key || null,
    topic: x.topic,
  })),
  conflicts,
}

console.log('== S0 只读体检 ==')
console.log('意识体:', agentName, '| 活跃记忆:', rows.length)
console.log('护照覆盖:', JSON.stringify(report.passport_coverage))
console.log('有 fact_key:', withFactKey, '| 有 timeline:', withTimeline, '| 有回链:', withDerived)
console.log('同主题更晚说法（过时候选）:', stale.length)
console.log('冲突:', conflicts.map((c) => c.state + '/' + c.severity + '=' + c.n).join(' ') || '无')
console.log('\n-- 候选样例 --')
for (const s of report.stale_samples) {
  console.log('[' + s.topic + ']', s.old_text.slice(0, 34), '=>', s.newer_text.slice(0, 34), '| key:', s.old_key, '→', s.newer_key)
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8')
  console.log('\n基线已写入:', jsonOut)
}
db.close()
