/**
 * 只读体检：把活库复制一份到临时目录再算，绝不动原件。
 * 输出 JSON（UTF-8），给「重启前先看一眼真实数字」用。
 *
 * 用法：node scripts/live-status.mjs [db路径]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const src = process.argv[2] || path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-live-'))
const dst = path.join(tmp, 'app.db')
fs.copyFileSync(src, dst)
for (const suf of ['-wal', '-shm']) {
  try { fs.copyFileSync(src + suf, dst + suf) } catch { /* 没有就算了 */ }
}
process.env.DSH_HOME = tmp

const { openDb } = await import('../src/db.js')
const { scorecard, liveGate, readBlind } = await import('../src/modules/sangguan/score.js')
const { shadowLog } = await import('../src/modules/sangguan/violate.js')
const { sangguanConfig } = await import('../src/modules/sangguan/config.js')
const { injectLog } = await import('../src/modules/sangguan/inject.js')

const db = openDb(dst)
const out = { src, copied_at: new Date().toISOString(), agents: [] }
let agents = []
try { agents = db.prepare('SELECT id,name FROM agents ORDER BY created_at').all() } catch { agents = [] }

for (const a of agents) {
  const row = { id: a.id, name: a.name }
  try { row.config = sangguanConfig(db, a.id) } catch (e) { row.config = { err: String(e.message || e) } }
  try {
    const sc = scorecard(db, a.id, { days: 30 })
    row.scorecard = sc
    row.layers = sc.claims.by_layer
  } catch (e) { row.scorecard = { err: String(e.message || e) } }
  try {
    const g = liveGate(db, a.id)
    row.gate = { ok: g.ok, reasons: g.reasons, content: g.content, blind: g.blind }
  } catch (e) { row.gate = { err: String(e.message || e) } }
  try { row.blind = readBlind(db, a.id) } catch { row.blind = null }
  try { row.shadow = shadowLog(db, a.id) } catch (e) { row.shadow = [] }
  try { row.inject_log = injectLog(db, a.id) } catch (e) { row.inject_log = null }
  try {
    row.turns_today = db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE agent_id=? AND substr(created_at,1,10)=date('now','localtime')").get(a.id).n
  } catch { row.turns_today = null }
  try {
    row.flags = db.prepare("SELECT key,substr(value,1,400) v FROM flags WHERE key LIKE 'sangguan.%' AND key LIKE ?").all('%' + a.id + '%')
  } catch { row.flags = [] }
  out.agents.push(row)
}

// 账本规模
try {
  out.ledger = db.prepare('SELECT type, COUNT(*) n FROM claim_events GROUP BY type ORDER BY n DESC').all()
} catch (e) { out.ledger = { err: String(e.message || e) } }
try { out.db_size_mb = +(fs.statSync(dst).size / 1048576).toFixed(1) } catch { out.db_size_mb = null }

db.close()
fs.rmSync(tmp, { recursive: true, force: true })
const text = JSON.stringify(out, null, 2)
const dest = process.argv[3]
if (dest) { fs.writeFileSync(dest, text, 'utf8'); console.log('wrote ' + dest + ' (' + text.length + ' chars)') }
else process.stdout.write(text)
