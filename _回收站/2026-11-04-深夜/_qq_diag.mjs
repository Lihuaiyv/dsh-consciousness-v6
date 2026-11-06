import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const home = path.join(os.homedir(), '.dsh')
const db = new DatabaseSync(path.join(home, 'consciousness', 'app.db'), { readOnly: true })

console.log('=== tables with param/flag/qq ===')
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((x) => x.name)
console.log(tables.filter((n) => /param|flag|qq|event|agent/i.test(n)).join(', '))

const ap = db.prepare("SELECT agent_id, key, value FROM agent_params WHERE key LIKE 'qq.%' ORDER BY agent_id, key").all()
console.log('=== agent_params qq.* ===')
console.log(ap.length ? ap : '(none)')

try {
  const flags = db.prepare("SELECT key, value FROM flags WHERE key LIKE 'qq.%'").all()
  console.log('=== flags qq.* ===', flags)
} catch (e) {
  console.log('no flags table or', e.message)
}

const agents = db.prepare("SELECT id, name, status FROM agents LIMIT 20").all()
console.log('=== agents ===')
for (const a of agents) console.log(a.id, a.name, a.status)

try {
  const ev = db.prepare("SELECT at, agent_id, type, substr(payload,1,160) p FROM events WHERE type LIKE 'qq.%' ORDER BY at DESC LIMIT 15").all()
  console.log('=== recent qq events ===')
  console.log(ev)
} catch (e) {
  console.log('events?', e.message)
}

const bridgeDir = path.join(home, 'qq-bridge')
for (const f of ['qq-runtime.json', 'qq-sessions.json']) {
  const p = path.join(bridgeDir, f)
  console.log('===', f, '===')
  if (!fs.existsSync(p)) { console.log('missing'); continue }
  const raw = fs.readFileSync(p, 'utf8')
  try {
    const j = JSON.parse(raw)
    if (f === 'qq-sessions.json') console.log('keys', Object.keys(j).length, Object.entries(j).slice(0, 8))
    else console.log(JSON.stringify(j, null, 2).slice(0, 2000))
  } catch (e) {
    console.log('parse fail', e.message)
  }
}

const log = path.join(bridgeDir, 'qq-bridge-debug.log')
if (fs.existsSync(log)) {
  const st = fs.statSync(log)
  const lines = fs.readFileSync(log, 'utf8').trim().split(/\n/)
  console.log('=== debug log mtime', st.mtime.toISOString(), 'lines', lines.length, '===')
  console.log(lines.slice(-20).join('\n'))
}

// napcat process hint
console.log('=== napcat files ===')
const nc = path.join(home, 'napcat')
console.log('exists', fs.existsSync(nc), 'boot-qq.ps1', fs.existsSync(path.join(nc, 'boot-qq.ps1')))
