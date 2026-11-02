import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { seedAffect, applyEmotionV3 } from '../src/modules/affect.js'

const H = 3600000
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-labspeed-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_labspeed'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '测速', 'daily', 'active', now())
seedAffect(db, aid)
setParam(db, aid, 'affect.walk.sd', { value: 0 })
setParam(db, aid, 'affect.baseline.load.gain', { value: 0 })
const T0 = Date.parse('2026-11-02T08:00:00.000Z')
const COLS = ['baseline', 'slow', 'fast', 'total', 'slow_at', 'fast_at', 'base_off', 'base_off_at', 'walk', 'walk_at', 'circ_phase', 'circ_phase_at', 'rec_label']
applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 })
const snap = db.prepare('SELECT * FROM affect_v3 WHERE agent_id=?').get(aid)
snap.base_off = 0
snap.walk = 0
const restore = () => db.prepare('UPDATE affect_v3 SET ' + COLS.map((c) => c + '=?').join(', ') + ' WHERE agent_id=?')
  .run(...COLS.map((c) => snap[c]), aid)

function run(label, pleasure) {
  restore()
  const r0 = applyEmotionV3(db, aid, { pleasure, label, at: T0, fresh: true })
  const out = [['0h', Math.abs(Number(r0.slow) - Number(r0.baseline))]]
  for (const h of [1, 2, 6]) {
    const r = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 + h * H, fresh: false })
    out.push([h + 'h', Math.abs(Number(r.slow) - Number(r.baseline))])
  }
  return out
}
for (const [label, p] of [['lost', -0.6], ['irritated', -0.6], ['calm', 0.6], ['curious', 0.6]]) {
  const rows = run(label, p)
  console.log(label.padEnd(10) + rows.map(([h, d]) => h + '=' + Number(d).toFixed(3)).join('  '))
}
