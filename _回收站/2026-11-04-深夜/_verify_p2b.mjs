import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from './src/db.js'
import { getParam, writeParam } from './src/kernel.js'
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p2b-'))
const db = openDb(path.join(tmpDir, 'a.db'))
const aid = 'agt_p2'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(aid, '小汐', 'chat', 'active', new Date().toISOString())
console.log('default:', getParam(db, aid, 'memory.judge.enable'))
writeParam(db, aid, 'memory.judge.enable', 'on')
console.log('after writeParam:', getParam(db, aid, 'memory.judge.enable'))
writeParam(db, aid, 'memory.judge.daily_max', 12)
console.log('number param:', getParam(db, aid, 'memory.judge.daily_max'), typeof getParam(db, aid, 'memory.judge.daily_max'))
