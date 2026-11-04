/**
 * Shadow 观测（只读）：关系余量 / 内心行的落账 / 记忆来源。
 *
 * 用法：
 *   node scripts/shadow-report.mjs
 *   node scripts/shadow-report.mjs --agent agt_xxx --days 7
 *   node scripts/shadow-report.mjs --json
 *
 * 只读 app.db，不启 DSH、不碰 HTTP。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { shadowReport } from '../src/modules/self_residue.js'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  if (i < 0) return def
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DB = String(argOf('db', path.join(home, 'consciousness', 'app.db')))
if (!fs.existsSync(DB)) { console.error('找不到数据库：' + DB); process.exit(1) }

const db = openDb(DB)
const aid = String(argOf('agent', '') || (() => {
  const row = db.prepare("SELECT id FROM agents WHERE status<>'soft_deleted' ORDER BY COALESCE(last_interaction_at,created_at) DESC LIMIT 1").get()
  return row ? row.id : ''
})())
if (!aid) { console.error('库里没有可观测的 agent'); process.exit(1) }
const days = Number(argOf('days', 7)) || 7
const out = shadowReport(db, aid, { days })
db.close()

if (args.includes('--json')) {
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

const r = out.residue
const m = out.mind
console.log(`Shadow 观测 · ${aid} · 最近 ${out.window_days} 天`)
console.log(`余量：记录 ${r.recorded} / 提示 ${r.shown} / 结算 ${r.settled}（冷 ${r.by_dir.cold} / 暖 ${r.by_dir.warm}）`)
console.log(`开关：记录 ${r.recording ? 'on' : 'off'}，结算 ${r.settling ? 'on' : 'off'}`)
console.log(`内心行：落账 ${m.committed} / 丢弃 ${m.dropped}${m.dropped_rate == null ? '' : `（丢弃率 ${m.dropped_rate}）`}`)
const keys = Object.keys(m.by_key)
if (keys.length) {
  for (const k of keys) console.log(`  - ${k}: 落账 ${m.by_key[k].committed} / 丢弃 ${m.by_key[k].dropped}`)
}
console.log(`记忆：${out.memory.total} 条，低置信 ${out.memory.low_confidence} 条`)
for (const s of out.memory.by_source.slice(0, 8)) console.log(`  - ${s.source}: ${s.n} 条（低置信 ${s.low}）`)
console.log('参数：' + Object.entries(out.params).map(([k, v]) => `${k}=${v}`).join(' · '))
