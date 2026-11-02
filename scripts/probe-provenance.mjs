/** 只读：看每条命题的出处（哪条事件带进来的、actor 是谁、ref 指向什么）。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const src = path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const aid = process.argv[2] || 'agt_3977d80f17'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-prov-'))
const dst = path.join(tmp, 'app.db')
fs.copyFileSync(src, dst)
for (const s of ['-wal', '-shm']) { try { fs.copyFileSync(src + s, dst + s) } catch { /* ignore */ } }
process.env.DSH_HOME = tmp

const { openDb } = await import('../src/db.js')
const db = openDb(dst)
const L = []
const { loadState } = await import('../src/modules/sangguan/projection.js')
const s = loadState(db, aid)
const claims = Object.values(s.claims).map((c) => ({ ...c }))
for (const c of claims) {
  L.push('=== ' + c.id + ' [' + c.layer + '/' + c.kind + '] ' + c.status + ' origin=' + c.origin)
  L.push('    ' + String(c.text).slice(0, 100).replace(/\n/g, ' '))
  // CLAIM_EXP 里带这个 id 的事件
  const evs = db.prepare("SELECT * FROM claim_events WHERE agent_id=? ORDER BY seq").all(aid)
    .filter((e) => JSON.stringify(e).includes(c.id)).slice(0, 4)
  for (const e of evs) L.push('    #' + e.seq + ' ' + String(e.at).slice(0, 16) + ' ' + e.type + ' actor=' + e.actor + ' ' + JSON.stringify(e).slice(0, 200))
}
fs.writeFileSync('_prov.txt', L.join('\n'), 'utf8')
console.log('wrote _prov.txt')
db.close()
fs.rmSync(tmp, { recursive: true, force: true })
