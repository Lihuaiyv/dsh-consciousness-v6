#!/usr/bin/env node
/**
 * 窄门 shadow 报告（只读）。
 *
 * 用来看「如果现在把 memory.judge.gate 从 shadow 拨到 on，会动到什么」。
 * 只读打开真库，不写、不 touch。
 *
 * 用法：
 *   node scripts/judge-shadow-report.mjs [--db <path>] [--agent 小汐] [--sample 12]
 */
import { DatabaseSync } from 'node:sqlite'
import { dbPath as defaultDbPath } from '../src/paths.js'

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const dbPath = arg('db', defaultDbPath())
const agentName = arg('agent', '小汐')
const sampleN = Number(arg('sample', '12')) || 12

const db = new DatabaseSync(dbPath, { readOnly: true })
const agent = db.prepare('SELECT id, name FROM agents WHERE name=?').get(agentName)
if (!agent) { console.error('找不到意识体: ' + agentName); process.exit(1) }
const aid = agent.id

const one = (sql, ...a) => { try { const r = db.prepare(sql).get(...a); return r ? Object.values(r)[0] : 0 } catch { return -1 } }

let rows = []
try {
  rows = db.prepare('SELECT * FROM memory_pair_judge WHERE agent_id=? ORDER BY judged_at DESC').all(aid)
} catch { rows = [] }

const byVerdict = {}
const byVia = {}
const byModel = {}
for (const r of rows) {
  byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1
  byVia[r.via] = (byVia[r.via] || 0) + 1
  byModel[r.model || '(none)'] = (byModel[r.model || '(none)'] || 0) + 1
}

let events = []
try {
  events = db.prepare("SELECT * FROM events WHERE agent_id=? AND type IN ('memory.judge.gate','memory.judge.superseded') ORDER BY created_at DESC").all(aid)
} catch { events = [] }

const wouldInvalidate = rows.filter((r) => r.verdict === 'supersede' && !Number(r.applied)).length
const alreadyApplied = rows.filter((r) => Number(r.applied)).length

// 真模型耗时：只有门控事件里带 ms（缓存命中是 0，不计入）。
// 没有这组数，到时候没法判断「是不是 3s 超时边缘」。
const gateEvents = events.filter((e) => e.type === 'memory.judge.gate')
const msList = []
let timeoutHits = 0
for (const e of gateEvents) {
  try {
    const p = JSON.parse(e.payload)
    const n = Number(p.ms)
    if (Number.isFinite(n) && n > 0) msList.push(n)
    if (String(p.reason || '').includes('timeout')) timeoutHits++
  } catch { /* 坏 payload 跳过 */ }
}
msList.sort((a, b) => a - b)
const msAvg = msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : 0
const msP50 = msList.length ? msList[Math.floor(msList.length / 2)] : 0
const msMax = msList.length ? msList[msList.length - 1] : 0

console.log('== 窄门 shadow 报告 ==')
console.log('意识体:', agentName, '| 库:', dbPath)
console.log('')
console.log('-- 缓存 --')
console.log('  总行数:', rows.length)
console.log('  按判决:', JSON.stringify(byVerdict))
console.log('  按来源:', JSON.stringify(byVia))
console.log('  按模型:', JSON.stringify(byModel))
console.log('  现在开 on 会作废:', wouldInvalidate, '条 | 已经作废过:', alreadyApplied, '条')
console.log('')
console.log('-- 事件 --')
console.log('  memory.judge.gate:', one("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.judge.gate'", aid))
console.log('  memory.judge.superseded:', one("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.judge.superseded'", aid))
  console.log('  判定耗时(ms): avg=' + msAvg + ' p50=' + msP50 + ' max=' + msMax + ' | 超时=' + timeoutHits + ' 次')
console.log('')
console.log('-- 最近 ' + sampleN + ' 条（人工抽查用）--')
const memText = (id) => {
  try { return String(db.prepare('SELECT text FROM memory_items WHERE id=?').get(id)?.text || '').replace(/\s+/g, ' ').slice(0, 60) } catch { return '' }
}
for (const r of rows.slice(0, sampleN)) {
  console.log('  [' + r.verdict + '] ' + String(r.judged_at || '').slice(0, 16) + ' | ' + (r.reason || '').slice(0, 40))
  console.log('    旧:', memText(r.old_id))
  console.log('    新:', memText(r.new_id))
}
if (!rows.length) console.log('  （还没有判定数据：memory.judge.enable 还是 off，或还没跑到夜巡）')

db.close()
