import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from './src/db.js'
import { getParam, setParam } from './src/kernel.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p2-'))
const fresh = openDb(path.join(tmpDir, 'fresh.db'))
const cols = fresh.prepare('PRAGMA table_info(memory_pair_judge)').all().map((c) => c.name)
console.log('fresh table cols:', cols.join(','))
console.log('fresh integrity:', fresh.prepare('PRAGMA integrity_check').get().integrity_check)

// 老库：复制真库副本再 openDb（绝不直接动真库）
const src = 'C:/Users/ygys1/.dsh/consciousness/app.db'
const copy = path.join(tmpDir, 'old.db')
fs.copyFileSync(src, copy)
const old = openDb(copy)
const oldCols = old.prepare('PRAGMA table_info(memory_pair_judge)').all().map((c) => c.name)
console.log('old db upgraded cols:', oldCols.length)
console.log('old integrity:', old.prepare('PRAGMA integrity_check').get().integrity_check)
const aid = old.prepare('SELECT id FROM agents WHERE name=?').get('小汐').id
console.log('param default:', getParam(old, aid, 'memory.judge.enable'), getParam(old, aid, 'memory.judge.gate'), getParam(old, aid, 'memory.judge.timeout_ms'))
setParam(old, aid, 'memory.judge.enable', 'on')
console.log('param after set:', getParam(old, aid, 'memory.judge.enable'))
setParam(old, aid, 'memory.judge.enable', 'off')
console.log('param restored:', getParam(old, aid, 'memory.judge.enable'))
