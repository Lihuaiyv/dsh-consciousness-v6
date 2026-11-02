import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { affectTrend } from '../src/modules/affect.js'

const SRC = path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'consciousness', 'app.db')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-size-'))
const dst = path.join(dir, 'app.db')
fs.copyFileSync(SRC, dst)
for (const ext of ['-wal', '-shm']) if (fs.existsSync(SRC + ext)) fs.copyFileSync(SRC + ext, dst + ext)
const db = openDb(dst)
for (const days of [1, 7]) {
  const tr = affectTrend(db, 'agt_3977d80f17', days)
  const json = JSON.stringify(tr)
  console.log(`days=${days} points=${tr.points.length} sleep=${tr.sleep.length} rest=${tr.rest.length} bytes=${json.length}`)
  console.log('  now=' + JSON.stringify(tr.now))
  if (tr.rest.length) {
    const g = tr.rest[tr.rest.length - 1]
    console.log(`  最后一段短空档 ${g.hours}h s0=${g.s0} -> ${g.s_end}（真读数 ${g.actual}）点数=${g.curve.length}`)
  }
}
