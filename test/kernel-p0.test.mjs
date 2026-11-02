/**
 * P0 拔根：旧十维价值观的残根清退。
 *   1. 新库没有 persona_values 表；手写只进三观账本
 *   2. 旧库的残根（表行 + V 层 seed 命题）能被一次清退，且幂等
 *   3. 驱力 / 导出在缺表时不崩
 * 运行：node test/kernel-p0.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { setValue, listValues } from '../src/modules/persona.js'
import { append } from '../src/modules/sangguan/ledger.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { retireOldValues } from '../src/modules/sangguan/retire.js'
import { exportFull } from '../src/features.js'
import { getDrive, seedState } from '../src/core.js'
import { attachDb } from '../src/algo/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-kp0-'))
const db = openDb(path.join(dir, 'app.db'))
const T = '2026-11-02T03:00:00.000Z'
const add = (id) => db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, id, 'daily', 'active', T)

add('agt_new')

// 1) 新库没有旧表
const hasOld = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='persona_values'").get().n
check('新库没有 persona_values 表', hasOld === 0, hasOld)

// 2) 不认识的键也能手写：只进账本，而且像一句命题
const r = setValue(db, 'agt_new', { key: '诚实', weight: 0.3 })
const row = db.prepare('SELECT text,origin,kind FROM persona_claims WHERE agent_id=?').get('agt_new')
check('未知键手写落成命题', r.claimed === true && row && row.text === '我更看重诚实' && row.origin === 'user' && row.kind === 'norm', { r, row })
check('十维视图读的是折算，不再是旧表', listValues(db, 'agt_new').length === 10, listValues(db, 'agt_new').length)

// 3) 缺表时驱力不崩（foldValueWeights 走账本）
attachDb(db)
seedState(db, 'agt_new')
let driveOk = false
try { const d = getDrive(db, 'agt_new'); driveOk = !!d } catch { driveOk = false }
check('缺旧表时驱力照常', driveOk)

// 4) 旧库残根：表 + 三条 V seed，一次清退
const db2 = openDb(path.join(dir, 'old.db'))
db2.exec(`CREATE TABLE IF NOT EXISTS persona_values(agent_id TEXT NOT NULL, key TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.1,
  evidence TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(agent_id,key))`)
db2.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run('agt_old', 'old', 'daily', 'active', T)
for (const k of ['benevolence', 'security', 'stimulation']) db2.prepare('INSERT INTO persona_values VALUES(?,?,?,?,?)').run('agt_old', k, 0.33, '[]', T)
append(db2, 'agt_old', [
  { type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: T, payload: { claims: [{ layer: 'V', kind: 'norm', text: '我更看重照顾身边的人', origin: 'seed' }] } },
  { type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: T, payload: { claims: [{ layer: 'V', kind: 'norm', text: '我更看重稳定、不失去', origin: 'seed' }] } },
])
const before = loadState(db2, 'agt_old')
// 给第二条 seed 记一笔证据：它已经「长出后续」，撤回接口不认，得走保护带收回
{
  const { theta } = await import('../src/modules/sangguan/fold.js')
  append(db2, 'agt_old', [{ type: 'EVIDENCE', actor: 'user', at: T, payload: { evidence: [{ kind: 'verdict', target_type: 'claim', target_id: Object.keys(before.claims)[1], sign: 1, weight: theta(before, 'w_verdict'), ref: 't' }] } }])
}
const ret = retireOldValues(db2, now())
const after = loadState(db2, 'agt_old')
const liveSeeds = Object.values(after.claims).filter((c) => c.origin === 'seed' && c.status !== 'withdrawn').length
const rowsLeft = db2.prepare('SELECT COUNT(*) n FROM persona_values').get().n
check('旧 seed 全撤回（含已长证据的）', ret.withdrawn === 2 && ret.v_seed_after === 0 && liveSeeds === 0, ret)
check('撤回是终态不是删除', Object.values(after.claims).filter((c) => c.status === 'withdrawn').length === 2
  && Object.keys(after.claims).length === Object.keys(before.claims).length, Object.values(after.claims).map((c) => c.status))
check('旧表清空', ret.purged === 3 && rowsLeft === 0, { ret, rowsLeft })
const again = retireOldValues(db2, now())
check('再跑一次不重复记账', again.withdrawn === 0 && again.purged === 0, again)

// 5) 有旧表也不许影响导出
const out = exportFull(db2, 'agt_old')
check('导出不因旧表存在而失败', !!out.zip_base64 && out.zip_base64.length > 0)

db.close()
db2.close()
console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
