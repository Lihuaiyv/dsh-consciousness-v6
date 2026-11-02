/**
 * 只读：看活库里 V 层的命题都长什么样，为什么「会疼」挑不出候选。
 * 用法：node scripts/probe-vclaims.mjs [aid]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const src = path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const aid = process.argv[2] || 'agt_3977d80f17'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-vc-'))
const dst = path.join(tmp, 'app.db')
fs.copyFileSync(src, dst)
for (const s of ['-wal', '-shm']) { try { fs.copyFileSync(src + s, dst + s) } catch { /* ignore */ } }
process.env.DSH_HOME = tmp

const { openDb } = await import('../src/db.js')
const { loadState } = await import('../src/modules/sangguan/projection.js')
const { isTerminal, SIGMA_LOCK } = await import('../src/modules/sangguan/catalog.js')

const db = openDb(dst)
const s = loadState(db, aid)
const text = new Map(db.prepare('SELECT id,text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
const busy = new Set()
for (const k of Object.values(s.kappas)) if (SIGMA_LOCK.includes(k.sigma)) { busy.add(k.pos_id); busy.add(k.neg_id) }

const L = []
for (const layer of ['W', 'L', 'V']) {
  L.push('===== ' + layer)
  for (const c of Object.values(s.claims).filter((x) => x.layer === layer)) {
    const why = []
    if (isTerminal(c.status)) why.push('terminal')
    if (c.status !== 'active') why.push('status=' + c.status)
    if (busy.has(c.id)) why.push('busy')
    if (c.kind === 'commit') why.push('commit')
    const t = text.get(c.id) || ''
    if (!t) why.push('无文本')
    L.push([c.id, c.kind, c.status, c.origin, 'pi=' + c.pi, 'n=' + c.n].join(' | ') + (why.length ? '  << ' + why.join(',') : '') + (t ? '\n    文本：' + t.slice(0, 120) : ''))
  }
}
L.push('')
L.push('persona_claims V 行数：' + db.prepare('SELECT COUNT(*) n FROM persona_claims WHERE agent_id=? AND layer=?').get(aid, 'V').n)
L.push('claim_events 里 V 相关：' + db.prepare("SELECT COUNT(*) n FROM claim_events WHERE agent_id=? AND layer='V'").get(aid).n)
fs.writeFileSync('_vclaims.txt', L.join('\n'), 'utf8')
console.log('wrote _vclaims.txt (' + L.length + ')')
db.close()
fs.rmSync(tmp, { recursive: true, force: true })
