/**
 * 情绪方向：只认 affect_baseline 当前段的起点，不假装有「三天前的 slow 采样」。
 * 运行：node test/affect-trend.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { trendOf } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-trend-'))
const db = openDb(path.join(dir, 'app.db'))
const put = (aid, slow, fromVal, seg = 3) => {
  db.prepare('DELETE FROM affect_v3 WHERE agent_id=?').run(aid)
  db.prepare('DELETE FROM affect_baseline WHERE agent_id=?').run(aid)
  if (slow != null) db.prepare('INSERT INTO affect_v3(agent_id,slow,baseline) VALUES(?,?,0)').run(aid, slow)
  if (fromVal != null) {
    db.prepare('INSERT INTO affect_baseline(agent_id,seg_no,started_at,duration_h,from_val,to_val,seed) VALUES(?,?,?,?,?,?,?)')
      .run(aid, seg, now(), 72, fromVal, fromVal + 0.1, 'test')
  }
}

check('没有 slow → 不出方向', trendOf(db, 'agt_none') === null, trendOf(db, 'agt_none'))

put('agt_up', 0.3, -0.05)
const up = trendOf(db, 'agt_up')
check('比段起点高 0.35 → 缓过来', up && up.dir === 'up' && up.text.includes('缓过来'), up)

put('agt_down', -0.3, 0.05)
const down = trendOf(db, 'agt_down')
check('比段起点低 0.35 → 往下掉', down && down.dir === 'down' && down.text.includes('往下掉'), down)

put('agt_flat', 0.1, 0.08)
check('差 0.02 是正常起伏 → 不出', trendOf(db, 'agt_flat') === null, trendOf(db, 'agt_flat'))

put('agt_noseg', 0.3, null)
check('没有底色段 → 不出', trendOf(db, 'agt_noseg') === null, trendOf(db, 'agt_noseg'))

// 老库没表：不抛
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-trend2-'))
const db2 = openDb(path.join(dir2, 'app.db'))
db2.exec('DROP TABLE IF EXISTS affect_baseline')
db2.prepare('INSERT INTO affect_v3(agent_id,slow,baseline) VALUES(?,?,0)').run('agt_old', 0.5)
let okOld = false
try { okOld = trendOf(db2, 'agt_old') === null } catch { okOld = false }
check('没有底色表时不抛', okOld, null)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
