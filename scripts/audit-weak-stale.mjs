#!/usr/bin/env node
/**
 * 弱标抽查导出：把「同主题但不同 key、只标不挤」的条目导成 Markdown 表，供人工过目。
 * 只读。用法：node scripts/audit-weak-stale.mjs [--db <path>] [--agent <name>] [--out <md>]
 */
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { stampRow, topicOfFactKey } from '../src/modules/passport.js'

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

const dbPath = arg('db', (process.env.DSH_DB || (process.env.DSH_HOME || 'C:/Users/l/.dsh').replace(/\\/g, '/') + '/consciousness/app.db'))
const agentName = arg('agent', '小汐')
const out = arg('out', 'docs/记忆时态-弱标抽查.md')
const db = new DatabaseSync(dbPath, { readOnly: true })
const agent = db.prepare('SELECT id FROM agents WHERE name=?').get(agentName)
if (!agent) { console.error('找不到意识体'); process.exit(1) }
const aid = agent.id

const rows = db.prepare(`SELECT * FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL`).all(aid)
const by = new Map()
for (const r of rows) {
  const t = topicOfFactKey(r.fact_key)
  if (!t) continue
  if (!by.has(t)) by.set(t, [])
  by.get(t).push(r)
}
const weak = []
for (const [topic, list] of by) {
  if (list.length < 2) continue
  list.sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
  for (let i = 0; i < list.length - 1; i++) {
    const newer = list.slice(i + 1).find((x) => Date.parse(x.created_at) - Date.parse(list[i].created_at) >= 30 * 60000)
    if (!newer) continue
    const s = stampRow(db, aid, list[i])
    // 弱标候选＝只有 weakLater、没被判成确定更新；旧写法查 s.source==='topic_weak'，
    // 但 stampRow 从不产生那个值，所以这个脚本一直导出 0 对。
    if (s.weakLater) weak.push({ topic, old: list[i], newer })
  }
}

const lines = [
  '# 弱标抽查（同主题、不同 key，只标不挤）',
  '',
  '生成时间：' + new Date().toISOString() + '。共 ' + weak.length + ' 对。逐条看：是真的「旧说法被更新」，还是只是同话题的不同事。',
  '',
  '| # | 主题 | 旧条（较早） | 新条（较晚） | 判断 |',
  '|---|---|---|---|---|',
]
weak.forEach((x, i) => {
  const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 60)
  lines.push('| ' + (i + 1) + ' | ' + esc(x.topic) + ' | ' + esc(x.old.text) + ' | ' + esc(x.newer.text) + ' |  |')
})
lines.push('', '> 判断栏留空，人工勾「更新 / 补充 / 无关」。')
fs.writeFileSync(out, lines.join('\n'), 'utf8')
console.log('已导出 ' + weak.length + ' 对 → ' + out)
db.close()
