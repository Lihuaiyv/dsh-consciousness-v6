import { openDb } from '../src/db.js'
import { getAllParams } from '../src/kernel.js'
import os from 'node:os'
import path from 'node:path'

const db = openDb(path.join(os.homedir(), '.dsh', 'consciousness', 'app.db'))
const aid = db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY rowid LIMIT 1").get()?.id
console.log('aid', aid)
const all = getAllParams(db, aid)
for (const k of ['qq.bridge.enable', 'qq.bridge.owner_qq', 'qq.bridge.ingest', 'qq.bridge.sessions_file']) {
  console.log(k, '=', JSON.stringify(all[k]))
}
console.log('--- recent qq events ---')
for (const r of db.prepare("SELECT type,payload,created_at FROM events WHERE type LIKE 'qq.bridge.%' ORDER BY created_at DESC LIMIT 10").all()) {
  console.log(r.created_at, r.type, String(r.payload).slice(0, 200))
}
console.log('--- last qq turns ---')
for (const r of db.prepare("SELECT role, substr(text,1,40) t, created_at, conversation_id FROM chat_turns WHERE conversation_id LIKE 'qq:%' ORDER BY created_at DESC LIMIT 8").all()) {
  console.log(r.created_at, r.role, r.conversation_id, r.t)
}
console.log('--- agents (recent) ---')
for (const r of db.prepare("SELECT id,name,status,created_at FROM agents ORDER BY created_at DESC LIMIT 5").all()) console.log(r)
db.close()
