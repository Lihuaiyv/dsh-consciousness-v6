import { now } from '../db.js'
import { zipStore, unzipStore } from '../zip.js'
import { err, nid, agent, active, modelStatus, getParam, getFlag } from '../kernel.js'
import { getDrive } from './drive.js'
import { getAffect } from './affect.js'
import { inbox, listProposals } from './selfmod.js'
import { memoryStats } from './memory.js'
import { rebuildMemoryFts, rebuildRawFts, rebuildFactFts } from './archive.js'
import { purgeAgent, purgeOrphans } from './sangguan/purge.js'
import { readEvents } from './sangguan/ledger.js'

/**
 * 存储体检 + 自愈。
 *
 * 存储层最容易坏在两处，而且都不会报错、只会静默丢能力：
 *   ① 全文索引漏行（写入中断 / 外部导入）→ 那条记忆永远搜不到；
 *   ② 图边指向已不存在的记忆 → 一跳扩散捞到空。
 * 两项都能自动修，所以巡检顺手做掉，不等人发现。
 */
export function auditStore(db, opt = {}) {
  const n = (sql) => { try { return Number(db.prepare(sql).get().n || 0) } catch { return -1 } }
  const checks = [
    { name: 'memory_fts', bad: n("SELECT COUNT(*) n FROM memory_items m WHERE m.status='active' AND NOT EXISTS(SELECT 1 FROM memory_fts f WHERE f.id=m.id)") },
    { name: 'raw_fts', bad: n("SELECT COUNT(*) n FROM raw_turns r WHERE NOT EXISTS(SELECT 1 FROM raw_fts f WHERE f.id=r.id)") },
    { name: 'fact_fts', bad: n("SELECT COUNT(*) n FROM fact_archive f WHERE NOT EXISTS(SELECT 1 FROM fact_fts x WHERE x.id=f.id)") },
    { name: 'memory_links', bad: n("SELECT COUNT(*) n FROM memory_links l WHERE NOT EXISTS(SELECT 1 FROM memory_items m WHERE m.id=l.from_id) OR NOT EXISTS(SELECT 1 FROM memory_items m WHERE m.id=l.to_id)") },
  ]
  const bad = checks.some((c) => c.bad > 0)
  const repaired = []
  if (opt.repair && bad) {
    const by = Object.fromEntries(checks.map((c) => [c.name, c.bad]))
    try {
      if (by.memory_fts > 0 && rebuildMemoryFts(db)) repaired.push('memory_fts')
      if (by.raw_fts > 0 && rebuildRawFts(db)) repaired.push('raw_fts')
      if (by.fact_fts > 0 && rebuildFactFts(db)) repaired.push('fact_fts')
      if (by.memory_links > 0) {
        db.prepare('DELETE FROM memory_links WHERE NOT EXISTS(SELECT 1 FROM memory_items m WHERE m.id=memory_links.from_id) OR NOT EXISTS(SELECT 1 FROM memory_items m WHERE m.id=memory_links.to_id)').run()
        repaired.push('memory_links')
      }
    } catch { /* 修不了就等下次 */ }
  }
  return { ok: !bad, checks, repaired, at: new Date().toISOString() }
}

// ---------------- 工况（condition_state 本域） ----------------

export function getCondition(db, aid) {
  agent(db, aid)
  const r = db.prepare('SELECT * FROM condition_state WHERE agent_id=?').get(aid)
  return r || { attention: 0.7, load: 0.2, state: 'focus', updated_at: now() }
}

export function setCondition(db, aid, body) {
  active(db, aid)
  const attention = Math.max(0, Math.min(1, Number(body.attention ?? 0.7)))
  const load = Math.max(0, Math.min(1, Number(body.load ?? 0.2)))
  const state = load > 0.8 ? 'overload' : attention < 0.4 ? 'distracted' : 'focus'
  db.prepare('INSERT OR REPLACE INTO condition_state VALUES(?,?,?,?,?)').run(aid, attention, load, state, now())
  return { attention, load, state }
}

export function purgeExpired(db) {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString()
  let agents = 0, memories = 0
  const TABLES = ['memory_items', 'conflicts', 'persona', 'persona_values', 'preferences', 'taboos',
    'relations', 'affect_state', 'affect_episodes', 'affect_samples', 'affect_user_read', 'condition_state', 'drive_state',
    'action_ports', 'action_log', 'proposals', 'changes', 'inbox_items', 'events',
    'metric_snapshots', 'metric_samples', 'chat_turns', 'bindings', 'agent_bindings', 'algo_bindings', 'agent_params', 'persona_views', 'thoughts',
    'proactive', 'proactive_stats', 'proactive_decisions', 'episodes', 'diaries', 'raw_turns', 'fact_archive', 'memory_timeline', 'retrieval_log', 'entities', 'extract_queue', 'consolidation_log',
    'axis_rope', 'axis_evidence', 'persona_judge']
  for (const a of db.prepare("SELECT id FROM agents WHERE status='soft_deleted' AND deleted_at<?").all(cutoff)) {
    const arts = db.prepare('SELECT active_id,previous_id,pinned_id,v0_id FROM agent_bindings WHERE agent_id=?').all(a.id)
    for (const t of TABLES) { try { db.prepare(`DELETE FROM ${t} WHERE agent_id=?`).run(a.id) } catch { /* 表不存在或列不同 */ } }
    for (const b of arts) {
      for (const id of [b.active_id, b.previous_id, b.pinned_id, b.v0_id]) {
        if (!id) continue
        const still = db.prepare(
          `SELECT 1 FROM agent_bindings WHERE active_id=? OR previous_id=? OR pinned_id=? OR v0_id=?`,
        ).get(id, id, id, id)
        if (!still) {
          try { db.prepare('DELETE FROM rule_artifacts WHERE id=?').run(id) } catch { /* 忽略 */ }
        }
      }
    }
    try { db.prepare('DELETE FROM memory_fts WHERE id NOT IN (SELECT id FROM memory_items)').run() } catch { /* 忽略 */ }
    try { db.prepare('DELETE FROM raw_fts WHERE id NOT IN (SELECT id FROM raw_turns)').run() } catch { /* 忽略 */ }
    try { db.prepare('DELETE FROM fact_fts WHERE id NOT IN (SELECT id FROM fact_archive)').run() } catch { /* 忽略 */ }
    // 整实例清除：账本只增的唯一例外。失败不挡 agent 清除，孤儿留给 purgeOrphans
    try { purgeAgent(db, a.id) } catch { /* 三观清除失败不挡主流程 */ }
    db.prepare('DELETE FROM agents WHERE id=?').run(a.id)
    agents++
  }
  for (const m of db.prepare("SELECT id FROM memory_items WHERE status='soft_deleted' AND deleted_at<?").all(cutoff)) {
    try { db.prepare('DELETE FROM memory_fts WHERE id=?').run(m.id) } catch { /* 忽略 */ }
    // 明确硬删 = 连 T4 的事实存根一起清：说好要忘的，不能只在主表忘。
    // 改写留下的 `<id>:hist:<n>` 旧句也得删。前缀用 substr 比较——LIKE 里的 _ 是通配符，会误伤相似 id。
    const pre = m.id + ':'
    try { db.prepare('DELETE FROM fact_fts WHERE id IN (SELECT id FROM fact_archive WHERE memory_id=? OR substr(memory_id,1,?)=?)').run(m.id, pre.length, pre) } catch { /* 老库没有存根 */ }
    try { db.prepare('DELETE FROM fact_archive WHERE memory_id=? OR substr(memory_id,1,?)=?').run(m.id, pre.length, pre) } catch { /* 老库没有存根 */ }
    // 时效索引也只增不删的例外之一：单条硬删
    try { db.prepare('DELETE FROM memory_timeline WHERE memory_id=?').run(m.id) } catch { /* 老库没有时效索引 */ }
    // 记忆硬删了，挂在它上面的开环也一起清，否则会指着一条不存在的记忆。
    try { db.prepare('DELETE FROM open_loops WHERE memory_id=?').run(m.id) } catch { /* 老库没有开环 */ }
    db.prepare('DELETE FROM memory_items WHERE id=?').run(m.id)
    memories++
  }
  // 幂等键 7 天后回收，避免表无限增长
  let idem = 0
  try { idem = Number(db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(new Date(Date.now() - 7 * 86400000).toISOString()).changes || 0) } catch { /* 老库可能没有这张表 */ }
  // 陈年 pending：7 天没投递的主动消息作废。别让旧账占着注入位和「今天说过」的统计。
  let staleProactive = 0
  try {
    staleProactive = Number(db.prepare("UPDATE proactive SET state='expired' WHERE state='pending' AND created_at < ?").run(new Date(Date.now() - 7 * 86400000).toISOString()).changes || 0)
  } catch { /* 老库没有 proactive 表 */ }
  // agents 里已经没有、三观数据还在的（上次清除失败的），补清
  try { purgeOrphans(db) } catch { /* 补清失败下次再来 */ }
  return { agents, memories, idem, staleProactive }
}

// ---------------- export / import ----------------
const TABLES = ['agents', 'memory_items', 'memory_links', 'conflicts', 'persona', 'relations',
  'affect_state', 'affect_episodes', 'condition_state', 'drive_state', 'proposals', 'changes',
  'inbox_items', 'events', 'metric_snapshots', 'traces', 'tokens', 'budgets', 'action_ports', 'alerts', 'persona_views', 'thoughts', 'open_loops']

export function exportZip(db, aid) {
  agent(db, aid)
  const rows = db.prepare('SELECT * FROM memory_items WHERE agent_id=?').all(aid)
  const nd = rows.map((r) => JSON.stringify(r)).join('\n')
  const files = {
    'manifest.json': JSON.stringify({ agent_id: aid, schema_version: 1, exported_at: now(), tables: TABLES }, null, 2),
    'memory.ndjson': nd,
  }
  // 三观账本只做存档（事件按 seq，fold 可重放）；导入不回放，没有账本就不出这个文件
  let sg = []
  try { sg = readEvents(db, aid) } catch { /* 老库没有三观表 */ }
  if (sg.length) files['sangguan.ndjson'] = sg.map((e) => JSON.stringify(e)).join('\n')
  return zipStore(files)
}

export function importZip(db, aid, buffer) {
  active(db, aid)
  let files
  try { files = unzipStore(buffer) } catch { err(400, 'INVALID_ARGUMENT', '不是合法的 zip') }
  if (!files['manifest.json']) err(400, 'INVALID_ARGUMENT', '缺少 manifest.json')
  const manifest = JSON.parse(files['manifest.json'].toString('utf8'))
  if (manifest.schema_version !== 1) err(400, 'SCHEMA_MISMATCH', 'schema_version 不匹配')
  let n = 0
  if (files['memory.ndjson']) {
    for (const line of files['memory.ndjson'].toString('utf8').split('\n')) {
      if (!line.trim()) continue
      const m = JSON.parse(line)
      let mid = m.id || nid('mem_')
      const old = db.prepare('SELECT agent_id FROM memory_items WHERE id=?').get(mid)
      if (old && old.agent_id !== aid) mid = nid('mem_')
      db.prepare(`INSERT OR REPLACE INTO memory_items(
          id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
          last_decay_at,valid_at,invalid_at,status,created_at,deleted_at,version)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(mid, aid, m.type || 'fact', m.mark || 'normal', m.text || '', 'import',
          0.5, 0.5, 1, 5, now(), null, null, m.status || 'active', m.created_at || now(), m.deleted_at || null, 1)
      db.prepare('DELETE FROM memory_fts WHERE id=?').run(mid)
      db.prepare('INSERT INTO memory_fts(id,text) VALUES(?,?)').run(mid, m.text || '')
      n++
    }
  }
  return { imported: { memory: n } }
}

// ---------------- misc ----------------
export function overview(db, aid) {
  const a = agent(db, aid)
  const stats = memoryStats(db, aid)
  const alerts = []
  // 优先级：安全 1 → 数据 2 → 运行 3 → 人格 4 → 指标 5（前端只取前两条）
  if (stats.open_conflicts) alerts.push({ id: 'conflict', kind: 'data', priority: 2, title: '有 ' + stats.open_conflicts + ' 条记忆冲突未处理' })
  try {
    const ready = listProposals(db, aid).filter((p) => p.state === 'shadowed' && Number(p.shadow_done) >= Number(p.shadow_total)).length
    if (ready) alerts.push({ id: 'proposal', kind: 'run', priority: 3, title: '有 ' + ready + ' 条提案等你批准' })
  } catch { /* 老库没有该状态 */ }

  const box = inbox(db, aid)
  const last = a.last_interaction_at || a.created_at
  const idleDays = last ? (Date.now() - Date.parse(last)) / 86400000 : 0
  const asleep = idleDays >= 14

  // 注意档：不阻塞，但应该在概览上看见
  const warn = []
  try {
    const soon = (box.todo || []).concat(box.change || []).filter((i) => i.expiring)
    if (soon.length) warn.push({ id: 'expiring', kind: 'run', priority: 3, title: soon.length + ' 条提案 3 天内到期' })
  } catch { /* 老库没有到期字段 */ }
  try {
    if (modelStatus().primary !== 'ok') warn.push({ id: 'model', kind: 'run', priority: 3, title: '模型不可用，正在用本地规则打分' })
  } catch { /* ignore */ }
  if (!alerts.length && idleDays >= 12 && !asleep) warn.push({ id: 'sleep-soon', kind: 'run', priority: 4, title: '已沉默 ' + Math.floor(idleDays) + ' 天，再过 2 天进入休眠' })

  const status = alerts.length ? 'need' : warn.length ? 'warn' : asleep ? 'asleep' : 'good'

  let drive = null
  try {
    const d = getDrive(db, aid)
    drive = { band: d.band, D: d.D, tokens: d.tokens }
  } catch { /* 无驱动数据 */ }
  let affect = null
  try {
    const f = getAffect(db, aid)
    affect = {
      label: f.primary_label,
      intensity: f.intensity,
      mood: f.mood,
      total: f.v3 ? f.v3.total : null,
      baseline: f.v3 ? f.v3.baseline : null,
      base_off: f.v3 ? (f.v3.base_off == null ? null : f.v3.base_off) : null,
      slow: f.v3 ? f.v3.slow : null,
      fast: f.v3 ? f.v3.fast : null,
    }
  } catch { /* 无情绪数据 */ }

  let unread = 0
  try {
    unread = Number(db.prepare("SELECT COUNT(*) n FROM proposals WHERE agent_id=? AND state='shadowed' AND shadow_done>=shadow_total").get(aid).n || 0)
  } catch { unread = 0 }

  // 嘀咕：观测层，不进 memory_items；开关默认开
  const mutterOn = getParam(db, aid, 'ui.mutter.enabled') !== false
  let mutter = null
  try {
    const raw = getFlag(db, 'ui.mutter.' + aid)
    if (raw) {
      const j = JSON.parse(raw)
      if (j && j.text) mutter = { text: String(j.text), tokens: Number(j.tokens) || null, at: j.at || null }
    }
  } catch { mutter = null }

  return {
    id: a.id, name: a.name, mode: a.mode, state: a.status, unread,
    status, alerts, warn, inbox: { todo: box.todo.length, change: box.change.length },
    conflicts_open: Number(stats.open_conflicts || 0),
    memory_count: stats.count,
    recent: { last_interaction: last, idle_days: +idleDays.toFixed(1), last_memory: stats.last_memory },
    mutter: { enabled: mutterOn, ...(mutter || {}) },
    drive, affect,
  }
}
