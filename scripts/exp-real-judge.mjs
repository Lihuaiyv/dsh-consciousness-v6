import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { structureCandidates, pairKey } from '../src/modules/pair_judge.js'
import { dbPath as defaultDbPath } from '../src/paths.js'

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def }
const dbPath = arg('db', defaultDbPath())
const n = Number(arg('n', '10')) || 10
const days = Number(arg('days', '7')) || 7
const out = arg('out', 'docs/记忆时态-真模型判定-输入.json')

const db = new DatabaseSync(dbPath, { readOnly: true })
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get('小汐').id
const since = new Date(Date.now() - days * 86400000).toISOString()
const rows = db.prepare(`SELECT * FROM memory_items
  WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND created_at>=?
  ORDER BY created_at DESC LIMIT 400`).all(aid, since)

const seen = new Set()
const pairs = []
for (const row of rows) {
  let cands = []
  try { cands = structureCandidates(db, aid, { newRow: row, limit: 4 }) } catch { cands = [] }
  for (const c of cands) {
    if (String(c.row.created_at || '') >= String(row.created_at || '')) continue
    const k = pairKey(aid, c.row, row)
    if (seen.has(k)) continue
    seen.add(k)
    pairs.push({
      reason: c.reason,
      old: { id: c.row.id, text: String(c.row.text || '').replace(/\s+/g, ' ').slice(0, 200), at: String(c.row.created_at || '').slice(0, 10) },
      newer: { id: row.id, text: String(row.text || '').replace(/\s+/g, ' ').slice(0, 200), at: String(row.created_at || '').slice(0, 10) },
    })
    if (pairs.length >= n) break
  }
  if (pairs.length >= n) break
}
const report = { generated_at: new Date().toISOString(), agent: '小汐', days, count: pairs.length, pairs: pairs.map((p, i) => ({ i: i + 1, ...p })) }
fs.mkdirSync('docs', { recursive: true })
fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
console.log('候选对:', pairs.length, '→', out)
for (const p of report.pairs) {
  console.log('\n#' + p.i + ' [' + p.reason + ']')
  console.log('  旧(' + p.old.at + '):', p.old.text.slice(0, 70))
  console.log('  新(' + p.newer.at + '):', p.newer.text.slice(0, 70))
}
db.close()
