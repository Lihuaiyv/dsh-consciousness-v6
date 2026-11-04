/**
 * 三观 · 收口（P7 补）：V 列打开后，机器代笔的价值观不再自动落账；人自己写的那条仍然可以。
 * 运行：node test/sangguan-values-lane.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgvin-'))
process.env.DSH_HOME = home
const { openDb } = await import('../src/db.js')
const { setSangguanConfig } = await import('../src/modules/sangguan/config.js')
const { ingestValues, claimUserValue } = await import('../src/modules/sangguan/values_intake.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}
const db = openDb(path.join(home, 'app.db'))
let n = 0
const agent = (name, lanes) => {
  const id = 'ag_vin_' + (++n) + '_' + name
  db.prepare('INSERT OR IGNORE INTO agents(id,name,created_at) VALUES(?,?,?)').run(id, name, new Date().toISOString())
  setSangguanConfig(db, id, { enabled: true, lanes: lanes || {} })
  return id
}
const now = new Date().toISOString()
const seedAsp = (aid) => db.prepare(`INSERT INTO memory_items(id, agent_id, type, text, source, last_decay_at, status, created_at)
  VALUES(?,?,?,?,?,?,?,?)`).run('m_' + aid, aid, 'aspiration', '我想把每一天都过得明白一点', 'test', now, 'active', now)
const vCount = (aid) => db.prepare("SELECT COUNT(*) n FROM persona_claims WHERE agent_id=? AND layer='V'").get(aid).n

// V 关着：志向照旧自动落成 V（旧行为）
{
  const aid = agent('off')
  seedAsp(aid)
  const r = await ingestValues(db, aid, now, { user: '' })
  check('V 关着：机器代笔照旧落账', r.offered === 1 && vCount(aid) === 1, { r, n: vCount(aid) })
}

// V 打开：不再自动落账
{
  const aid = agent('on', { V: true })
  seedAsp(aid)
  const r = await ingestValues(db, aid, now, { user: '' })
  check('V 打开：进料直接跳过', r.skipped === 'lane' && r.offered === 0, r)
  check('V 打开：没有偷偷写 V', vCount(aid) === 0, vCount(aid))
}

// V 打开：人自己写的仍然能进（这是人手写，不是机器代笔）
{
  const aid = agent('user', { V: true })
  const r = claimUserValue(db, aid, { key: 'c', weight: 1 }, now)
  check('V 打开：人写的价值仍可进', r.claimed === true && vCount(aid) === 1, { r, n: vCount(aid) })
  const row = db.prepare("SELECT text, origin FROM persona_claims WHERE agent_id=? AND layer='V'").get(aid)
  check('人写的：origin=user', row && row.origin === 'user', row)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
