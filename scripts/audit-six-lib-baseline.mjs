#!/usr/bin/env node
/**
 * 阶段 0 基线（只读）：六库时态现状。
 *
 * 只读打开，不 touch、不写库、不加热。
 * 用真函数（passport.stampRow / passportLine）算口径，不在这里复制一套判定。
 * 输出：控制台摘要 + JSON 落盘（默认 docs/记忆时态-基线-<日期>.json）。
 *
 * 用法：
 *   node scripts/audit-six-lib-baseline.mjs [--db <path>] [--agent <name>] [--json <out>] [--quiet]
 */
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { stampRow, passportLine, topicOfFactKey, related, isStale } from '../src/modules/passport.js'
import { isStalePair } from '../src/modules/stale_pair.js'
import { dbPath as defaultDbPath } from '../src/paths.js'

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const quiet = process.argv.includes('--quiet')

const dbPath = arg('db', defaultDbPath())
const agentName = arg('agent', '小汐')
const today = new Date().toISOString().slice(0, 10)
const jsonOut = arg('json', 'docs/记忆时态-基线-' + today + '.json')

const db = new DatabaseSync(dbPath, { readOnly: true })
const agent = db.prepare('SELECT id, name FROM agents WHERE name=?').get(agentName)
if (!agent) { console.error('找不到意识体: ' + agentName); process.exit(1) }
const aid = agent.id

const cnt = (sql, ...a) => {
  try { return Number(db.prepare(sql).get(...a).n || 0) } catch { return -1 }
}
const SLOT_TYPES = new Set(['fact', 'appraisal'])
const slotOf = (row) => SLOT_TYPES.has(String(row && row.type || ''))

// ── 1. 六库体量 ─────────────────────────────────────────────
const volumes = {
  T1_active: cnt("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL", aid),
  T1_all: cnt('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid),
  T1_invalid: cnt('SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND invalid_at IS NOT NULL', aid),
  T1_superseded: cnt('SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND superseded_by IS NOT NULL', aid),
  T2_episodes: cnt('SELECT COUNT(*) n FROM episodes WHERE agent_id=?', aid),
  T3_diaries: cnt('SELECT COUNT(*) n FROM diaries WHERE agent_id=?', aid),
  T4_raw: cnt('SELECT COUNT(*) n FROM raw_turns WHERE agent_id=?', aid),
  T4_archive: cnt('SELECT COUNT(*) n FROM fact_archive WHERE agent_id=?', aid),
  timeline: cnt('SELECT COUNT(*) n FROM memory_timeline WHERE agent_id=?', aid),
  timeline_revise: cnt("SELECT COUNT(*) n FROM memory_timeline WHERE agent_id=? AND op IN ('REVISE','INVALIDATE')", aid),
  rel_edge: cnt('SELECT COUNT(*) n FROM rel_edge'),
  rel_edge_closed: cnt('SELECT COUNT(*) n FROM rel_edge WHERE valid_to IS NOT NULL'),
}

// ── 2. T1：type × 有无 key ─────────────────────────────────
const rows = db.prepare(`SELECT id,type,text,fact_key,created_at,invalid_at,superseded_by,source,confidence
  FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL ORDER BY created_at`).all(aid)

const typeKey = {}
for (const r of rows) {
  const t = String(r.type || '(null)')
  typeKey[t] = typeKey[t] || { total: 0, withKey: 0, withKeySlot: 0 }
  typeKey[t].total++
  if (String(r.fact_key || '').trim()) {
    typeKey[t].withKey++
    if (slotOf(r)) typeKey[t].withKeySlot++
  }
}

// ── 3. 逐条护照（真函数） ───────────────────────────────────
const laterStmt = db.prepare(`SELECT id,text,fact_key,created_at FROM memory_items
  WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND id<>?
    AND fact_key IS NOT NULL AND fact_key LIKE ? AND created_at>?
  ORDER BY created_at DESC LIMIT 1`)

const passport = { invalid: 0, topic_key: 0, topic_state: 0, none: 0 }
const future = { invalid: 0, topic_key: 0, topic_state: 0, none: 0 }
let weakCands = 0
const ejectNow = []      // 当前 isStale 会挤出的
const ejectFuture = []   // 严格版会挤出的（invalid + 同 key 真槽位）
const statePairRows = [] // 状态词对（只标不挤）
const lineCount = { total: 0, nonEmpty: 0, update: 0, statement: 0, cross: 0 }
function bucketOf(line) {
  if (!line) return null
  if (line.includes('记下的判断')) return 'statement'
  if (line.includes('有更新的说法') || line.includes('当时还没做完')) return 'update'
  return 'cross'
}

for (const r of rows) {
  const s = stampRow(db, aid, r)
  const src = s.validUntil ? (s.source || 'topic_key') : 'none'
  passport[src] = (passport[src] || 0) + 1

  // validUntil 只在「同 key」或「状态词对」时设置；只同主题的落进 weakLater（不判旧）。
  const fut = src
  future[fut] = (future[fut] || 0) + 1
  if (s.weakLater) weakCands++
  const statePair = s.source === 'topic_state'

  let staleNow = false
  try { staleNow = isStale(db, aid, r) } catch { staleNow = false }
  if (staleNow) ejectNow.push({ id: r.id, type: r.type, src })
  const futEject = src === 'invalid' || (src === 'topic_key' && slotOf(r))
  if (futEject) ejectFuture.push({ id: r.id, type: r.type, src })
  if (statePair) {
    statePairRows.push({ id: r.id, type: r.type, text: String(r.text).slice(0, 50) })
  }

  const line = passportLine(db, aid, r)
  lineCount.total++
  const bk = bucketOf(line)
  if (bk) { lineCount.nonEmpty++; lineCount[bk]++ }
}

// ── 4. 账本侧（S2/S3 路径：含已作废的） ────────────────────
// S1 只召回活的，所以上面 rows 里 source=invalid 恒为 0；
// 真正要量的是「作废条在被翻出来时，能不能说清自己是旧的」。
const allRows = db.prepare(`SELECT id,type,text,fact_key,created_at,invalid_at,superseded_by
  FROM memory_items WHERE agent_id=? ORDER BY created_at`).all(aid)
const ledger = { invalid: 0, topic_key: 0, topic_state: 0, none: 0, lineNonEmpty: 0, lineHasInvalid: 0 }
for (const r of allRows) {
  const s = stampRow(db, aid, r)
  const src = s.validUntil ? (s.source || 'topic_key') : 'none'
  ledger[src] = (ledger[src] || 0) + 1
  const line = passportLine(db, aid, r)
  if (line) ledger.lineNonEmpty++
  if (r.invalid_at && line && /旧|更|作废|更新/.test(line)) ledger.lineHasInvalid++
}
const statusMix = db.prepare('SELECT status, COUNT(*) n FROM memory_items WHERE agent_id=? GROUP BY status').all(aid)

// ── 5. 重复 fact_key（真槽位候选） ─────────────────────────
const dupKeys = db.prepare(`SELECT fact_key, COUNT(*) c, GROUP_CONCAT(type) ts
  FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL
    AND fact_key IS NOT NULL AND fact_key<>''
  GROUP BY fact_key HAVING c>1 ORDER BY c DESC`).all(aid)

const dupDetail = dupKeys.map((d) => {
  const list = db.prepare(`SELECT id,type,text,created_at FROM memory_items
    WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND fact_key=?
    ORDER BY created_at`).all(aid, d.fact_key)
  const allSlot = list.every((x) => slotOf(x))
  return {
    key: d.fact_key,
    count: Number(d.c),
    types: String(d.ts || ''),
    allSlot,
    rows: list.map((x) => ({ id: x.id, type: x.type, at: x.created_at, text: String(x.text).slice(0, 60) })),
  }
})

// ── 5. T2/T3 注入字段（够不够带日期） ───────────────────────
const epSample = db.prepare('SELECT id,day,title,summary FROM episodes WHERE agent_id=? ORDER BY day DESC LIMIT 3').all(aid)
const diSample = db.prepare('SELECT id,day,substr(text,1,60) t FROM diaries WHERE agent_id=? ORDER BY day DESC LIMIT 3').all(aid)
const epHasCreatedAt = false // searchEpisodes 返回对象里没有 created_at（本轮基线待阶段 C 修）
const diTextHasDay = diSample.every((d) => String(d.t || '').includes(String(d.day || '')))

// ── 6. 事件里的旧信号（近 7 天） ───────────────────────────
const since7 = new Date(Date.now() - 7 * 86400000).toISOString()
const ev = {
  stale_pair_seen_7d: cnt("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.stale_pair_seen' AND created_at>=?", aid, since7),
  stale_superseded_7d: cnt("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.stale_superseded' AND created_at>=?", aid, since7),
  fact_superseded_7d: cnt("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.fact_superseded' AND created_at>=?", aid, since7),
  reflect_merged_7d: cnt("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.reflect_merged' AND created_at>=?", aid, since7),
}
const conflicts = db.prepare('SELECT state, COUNT(*) n FROM conflicts WHERE agent_id=? GROUP BY state').all(aid)

const report = {
  generated_at: new Date().toISOString(),
  agent: agentName,
  db: dbPath,
  stage: 'baseline-v5',
  volumes,
  type_key_matrix: typeKey,
  passport_sources: passport,
  passport_future_buckets: future,
  passport_lines: lineCount,
  ledger,
  status_mix: statusMix,
  eject: {
    now: ejectNow.length,
    future_strict: ejectFuture.length,
    statePairLabeled: statePairRows.length,
    weak_candidates: weakCands,
    statePairSamples: statePairRows.slice(0, 12),
  },
  dup_fact_keys: {
    groups: dupDetail.length,
    groupsAllSlot: dupDetail.filter((d) => d.allSlot).length,
    rowsInGroups: dupDetail.reduce((s, d) => s + d.count, 0),
    detail: dupDetail,
  },
  cross_layer: {
    episodes_with_topics: cnt("SELECT COUNT(*) n FROM episodes WHERE agent_id=? AND topics IS NOT NULL AND topics<>''", aid),
    episodes_created_at_in_item: epHasCreatedAt,
    diary_text_has_day: diTextHasDay,
    ep_sample: epSample.map((x) => ({ day: x.day, title: x.title, summary: String(x.summary || '').slice(0, 40) })),
    di_sample: diSample,
  },
  events_7d: ev,
  conflicts,
}

if (!quiet) {
  console.log('== 阶段 0 基线（六库时态） ==')
  console.log('意识体:', agentName, '| 库:', dbPath)
  console.log('\n-- 六库体量 --')
  for (const [k, v] of Object.entries(volumes)) console.log('  ' + k.padEnd(18), v)
  console.log('\n-- T1 type × key --')
  for (const [t, v] of Object.entries(typeKey)) console.log('  ' + t.padEnd(12), 'total=' + v.total, 'key=' + v.withKey, 'keySlot=' + v.withKeySlot)
  console.log('\n-- 护照现状（source） --', JSON.stringify(passport))
  console.log('-- 护照未来分档 --', JSON.stringify(future))
  console.log('-- passportLine 非空 --', lineCount.nonEmpty + '/' + lineCount.total)
  console.log('-- 账本侧（含作废条） --', JSON.stringify(ledger))
  console.log('-- status 分布 --', JSON.stringify(statusMix))
  console.log('\n-- 挤出 --')
  console.log('  现在会挤:', ejectNow.length)
  console.log('  严格版会挤(invalid + 同key真槽位):', ejectFuture.length)
  console.log('  状态词对（只标不挤）:', statePairRows.length)
  console.log('  同主题候选（weakLater，不判旧）:', weakCands)
  console.log('\n-- 重复 fact_key --')
  console.log('  组数:', dupDetail.length, '| 全部是槽位类型的组:', dupDetail.filter((d) => d.allSlot).length, '| 涉及条数:', report.dup_fact_keys.rowsInGroups)
  for (const d of dupDetail) console.log('   ', d.count + 'x', d.key, '|', d.types, d.allSlot ? '| 可退休' : '| 含非槽位')
  console.log('\n-- 跨层 --')
  console.log('  episodes 有 topics:', report.cross_layer.episodes_with_topics, '/', volumes.T2_episodes)
  console.log('  searchEpisodes 返回带 created_at:', epHasCreatedAt)
  console.log('  diary 正文自带 day:', diTextHasDay)
  console.log('\n-- 近 7 天事件 --', JSON.stringify(ev))
  console.log('-- 冲突 --', JSON.stringify(conflicts))
}

try {
  const dir = jsonOut.includes('/') || jsonOut.includes('\\') ? jsonOut.replace(/[\\/][^\\/]+$/, '') : ''
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8')
  if (!quiet) console.log('\n基线已写入:', jsonOut)
} catch (e) {
  console.error('写基线失败:', e && e.message)
}
db.close()
