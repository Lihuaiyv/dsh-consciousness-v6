/**
 * 三观 · 收口（P7）：L 列打开后，日记 / 志向不再往人生观里搬；关着时行为不变。
 * 运行：node test/sangguan-intake-lane.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgintake-'))
process.env.DSH_HOME = home
const { openDb } = await import('../src/db.js')
const { setSangguanConfig } = await import('../src/modules/sangguan/config.js')
const { intakeCandidates } = await import('../src/modules/sangguan/intake.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}

const db = openDb(path.join(home, 'app.db'))
let n = 0
const agent = (name) => {
  const id = 'ag_intake_' + (++n) + '_' + name
  db.prepare('INSERT OR IGNORE INTO agents(id,name,created_at) VALUES(?,?,?)').run(id, name, new Date().toISOString())
  setSangguanConfig(db, id, { enabled: true })
  return id
}
const now = new Date().toISOString()
function seedRows(aid) {
  db.prepare(`INSERT INTO diaries(id, agent_id, day, text, created_at, updated_at) VALUES(?,?,?,?,?,?)`)
    .run('d_' + aid, aid, '2026-11-02', '今天把屋子收拾了一遍，心里踏实多了', now, now)
  db.prepare(`INSERT INTO memory_items(id, agent_id, type, text, source, last_decay_at, status, created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('m_' + aid, aid, 'aspiration', '我想把日子过明白，不急着证明什么', 'test', now, 'active', now)
}

// 关着：日记与志向都进 L（旧行为）
{
  const aid = agent('off')
  seedRows(aid)
  const list = intakeCandidates(db, aid)
  check('L 关着：日记照旧进候选', list.some((x) => x.layer === 'L' && x.text.includes('收拾了一遍')), list)
  check('L 关着：志向照旧进候选', list.some((x) => x.layer === 'L' && x.text.includes('把日子过明白')), list)
}

// 打开：两条都不进
{
  const aid = agent('on')
  setSangguanConfig(db, aid, { lanes: { W: false, L: true, V: false } })
  seedRows(aid)
  const list = intakeCandidates(db, aid)
  check('L 打开：日记不再往人生观搬', !list.some((x) => x.layer === 'L' && x.text.includes('收拾了一遍')), list)
  check('L 打开：志向不再往人生观搬', !list.some((x) => x.layer === 'L' && x.text.includes('把日子过明白')), list)
  check('L 打开：这轮没有别的候选混进来', list.length === 0, list)
}

// 只关 W 不动 L：W 的冲突候选不再进，L 的日记照旧
{
  const aid = agent('w')
  setSangguanConfig(db, aid, { lanes: { W: true, L: false, V: false } })
  seedRows(aid)
  const list = intakeCandidates(db, aid)
  check('W 打开：L 的日记仍然照旧', list.some((x) => x.layer === 'L' && x.text.includes('收拾了一遍')), list)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
