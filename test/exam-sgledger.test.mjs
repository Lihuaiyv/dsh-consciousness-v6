/**
 * 三观账本 · 考卷
 *
 * 管的是「一句命题怎么记下、怎么重放」。不跑快环，不调用模型，不往话里注。
 *
 * 运行：node test/exam-sgledger.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, readEvents } from '../src/modules/sangguan/ledger.js'
import { emptyState, fold, checkInvariants } from '../src/modules/sangguan/fold.js'
import { listHeads, rebuild, stateAt } from '../src/modules/sangguan/projection.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const blank = emptyState()
check('空账本没有违规', checkInvariants(blank).length === 0)
fold(blank, [])
check('折叠不改原来那份', blank.last_seq === 0 && Object.keys(blank.claims).length === 0)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgledger-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sgledger'
db.prepare('INSERT INTO agents(id,name,created_at) VALUES(?,?,?)').run(aid, 'ledger', new Date().toISOString())

let emptyErr = null
try { append(db, aid, []) } catch (e) { emptyErr = e }
check('空批次不记', !!(emptyErr && /不能为空/.test(emptyErr.message)), emptyErr && emptyErr.message)

const text = '把话说明白'
const at = '2026-11-09T01:00:00.000Z'
const ev = {
  type: 'CLAIM_EXP', layer: 'V', actor: 'user', at,
  payload: { claims: [{ layer: 'V', kind: 'norm', text, origin: 'user' }] },
}
const wrote = append(db, aid, [ev])
const rows = readEvents(db, aid)
check('记下一句能读回', rows.length === 1 && rows[0].type === 'CLAIM_EXP' && wrote.entities.claims.length === 1, rows)
const heads = listHeads(db, aid, 'V')
check('链头上有这句', heads.some((h) => h.text === text && h.status === 'active'), heads)
const again = rebuild(db, aid)
const heads2 = listHeads(db, aid, 'V')
check('清空重放还在', again.claims === 1 && heads2.some((h) => h.text === text), again)
const seen = stateAt(db, aid, rows[0].seq)
check('看到记下的那一刻，命题在', Object.values(seen.claims).some((c) => c.layer === 'V' && c.status === 'active'))

const job = { type: 'JOB_DONE', actor: 'sys', at: '2026-11-09T03:00:00.000Z', job_key: 'exam-ledger-job', payload: {} }
append(db, aid, [job])
let dup = null
try { append(db, aid, [{ ...job, at: '2026-11-09T04:00:00.000Z' }]) } catch (e) { dup = e }
check('同一幂等键再记一次会拒', dup && dup.code === 'DUP_JOB', dup && dup.code)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
