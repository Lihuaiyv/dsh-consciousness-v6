/**
 * 观测一张表（P5 收口，2026-11-15）：体检 + 检索日志 + 夜间整理 + 存储自检 + 读口数字。
 * 只读真库；不写、不修、不调模型。
 *
 *   node scripts/health-all.mjs
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { retrievalStats } from '../src/modules/retrieval_log.js'
import { lastConsolidation, consolidationLog } from '../src/modules/nightly.js'
import { auditStore } from '../src/modules/ops.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DB = process.argv[2] || path.resolve(here, '..', '..', 'runtime', 'consciousness', 'app.db')
const AID = 'agt_3977d80f17'
const db = new DatabaseSync(DB, { readOnly: true })
const median = (xs) => {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2)
}
const rows = []
const row = (name, state, detail) => rows.push({ name, state, detail })
const now = Date.now()

// 1) 体检（独立脚本，只读）
try {
  const r = spawnSync(process.execPath, [path.join(here, 'check-memory-unify.mjs')], { cwd: path.join(here, '..'), encoding: 'utf8', timeout: 120000 })
  const out = String(r.stdout || '') + String(r.stderr || '')
  const pass = (out.match(/^PASS/gm) || []).length
  const warn = (out.match(/^WARN/gm) || []).length
  const fail = (out.match(/^FAIL/gm) || []).length
  row('体检 check-memory-unify', fail ? 'RED' : (warn ? 'WARN' : 'OK'), `PASS ${pass} / WARN ${warn} / FAIL ${fail}`)
} catch (e) {
  row('体检 check-memory-unify', 'RED', String(e && e.message || e).slice(0, 120))
}

// 2) 检索日志（近 7 天）
try {
  const s = retrievalStats(db, AID, 7)
  const scenes = (s.scenes || []).map((x) => `${x.scene}:${x.calls}次/空${x.empty}`).join('，') || '无记录'
  row('检索日志 7 天', (s.scenes || []).length ? 'OK' : 'WARN', scenes)
} catch (e) {
  row('检索日志 7 天', 'RED', String(e && e.message || e).slice(0, 120))
}

// 3) 夜间整理
try {
  const last = lastConsolidation(db, AID)
  const days = Number((consolidationLog(db, AID, 7) || []).length)
  let episodes = null
  try { episodes = (JSON.parse(last.steps || '[]').find((s) => s.step === 'episodes') || {}).count } catch { /* 老账 */ }
  const stale = last ? (now - Date.parse(last.day + 'T23:00:00+08:00')) > 2 * 86400000 : true
  row('夜间整理', !last ? 'WARN' : (stale || !Number(last.ok) ? 'WARN' : 'OK'),
    last ? `最近 ${String(last.day).slice(0, 10)}，近 7 天 ${days} 次，episodes ${episodes != null ? episodes : '?'}，耗时 ${last.ms}ms` : '没有记录')
} catch (e) {
  row('夜间整理', 'RED', String(e && e.message || e).slice(0, 120))
}

// 4) 存储自检
try {
  const a = auditStore(db)
  row('存储自检 auditStore', a.bad ? 'RED' : 'OK', a.checks ? a.checks.map((c) => `${c.name}:${c.bad}`).join(' ') : '')
} catch (e) {
  row('存储自检 auditStore', 'RED', String(e && e.message || e).slice(0, 120))
}

// 5) 读口数字
try {
  const toks = db.prepare("SELECT value FROM metric_samples WHERE key='sys.inject_tokens' ORDER BY sampled_at DESC LIMIT 300").all().map((r) => Number(r.value)).filter(Number.isFinite)
  const med = median(toks)
  row('上下文块 token 中位', med != null && med <= 800 ? 'OK' : 'WARN', `${med} / 800（近 ${toks.length} 次）`)
  const q = db.prepare("SELECT quality, COUNT(*) n FROM hot_events WHERE agent_id=? AND active=1 GROUP BY quality ORDER BY n DESC").all(AID)
  const ev = db.prepare('SELECT COUNT(*) n FROM hot_events WHERE agent_id=? AND active=1').get(AID).n
  row('事件库', ev > 0 ? 'OK' : 'RED', `热 ${ev} 件；` + q.map((x) => `${x.quality} ${x.n}`).join(' / '))
  const inj = db.prepare("SELECT COUNT(*) n FROM events WHERE type='event.inject' AND created_at>=?").get(new Date(now - 7 * 86400000).toISOString()).n
  row('近 7 天事件注入', inj >= 0 ? 'OK' : 'WARN', `${inj} 次`)
  const surf = db.prepare("SELECT COUNT(*) n FROM surface_queue WHERE agent_id=? AND state='pending'").get(AID).n
  const due = db.prepare("SELECT COUNT(*) n FROM open_loops WHERE agent_id=? AND state IN ('open','half_said') AND due_at IS NOT NULL AND due_at<=? AND COALESCE(fire_count,0)<5").get(AID, new Date(now).toISOString()).n
  row('队列', 'OK', `浮现 pending ${surf}，到点开环 ${due}`)
} catch (e) {
  row('读口数字', 'RED', String(e && e.message || e).slice(0, 120))
}

const red = rows.filter((r) => r.state === 'RED').length
const warn = rows.filter((r) => r.state === 'WARN').length
console.log('记忆观测 · ' + new Date(now).toISOString().slice(0, 19).replace('T', ' '))
for (const r of rows) console.log(`${r.state.padEnd(4)} ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
console.log(`\n${red ? '红了 ' + red + ' 项' : '没有红的'}（WARN ${warn} 项）`)
db.close()
process.exit(red ? 1 : 0)
