/**
 * 探针：在活库的副本上真跑一次「会疼」判定，看 J21 到底出不出东西。
 * 只写副本，不碰原件。
 *
 * 用法：node scripts/probe-violate.mjs [db路径] [回复文本...]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const src = process.argv[2] || path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const text = process.argv.slice(3).join(' ') || '这事我不管，谁难受谁自己受着，我只看结果。'
const aid = process.env.PROBE_AID || 'agt_3977d80f17'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-probe-'))
const dst = path.join(tmp, 'app.db')
fs.copyFileSync(src, dst)
for (const suf of ['-wal', '-shm']) {
  try { fs.copyFileSync(src + suf, dst + suf) } catch { /* ignore */ }
}
process.env.DSH_HOME = tmp

const { openDb } = await import('../src/db.js')
const { candidateClaims, checkReply } = await import('../src/modules/sangguan/violate.js')
const { sangguanConfig } = await import('../src/modules/sangguan/config.js')

const db = openDb(dst)
const out = []
const say = (...a) => { out.push(a.join(' ')); console.log(a.join(' ')) }

say('db=' + dst)
say('config=' + JSON.stringify(sangguanConfig(db, aid)))
const cands = candidateClaims(db, aid)
say('candidates=' + cands.length)
for (const c of cands) say('  - ' + c.id + ' π' + c.pi + ' n' + c.n + ' ' + c.text)

const at = new Date().toISOString()
const t0 = Date.now()
const r = await checkReply(db, aid, { text, at })
say('elapsed_ms=' + (Date.now() - t0))
say('result=' + JSON.stringify(r))

// 缓存/健康度回看
try {
  const rows = db.prepare("SELECT key,substr(value,1,300) v FROM flags WHERE key LIKE 'sangguan.violate%' OR key LIKE 'sangguan.judge%'").all()
  for (const x of rows) say('flag ' + x.key + ' = ' + x.v)
} catch (e) { say('flags err ' + e.message) }

db.close()
fs.rmSync(tmp, { recursive: true, force: true })
fs.writeFileSync('_probe.txt', out.join('\n'), 'utf8')
