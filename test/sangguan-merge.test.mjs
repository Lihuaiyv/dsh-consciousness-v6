/**
 * 三观 · 合并（同一取舍方向归一条，保留多种说法）与推导边。
 * 运行：node test/sangguan-merge.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append } from '../src/modules/sangguan/ledger.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { mergeClaims, linkDerives, derivesOf } from '../src/modules/sangguan/merge.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
function throwsAny(name, fn) {
  try { fn(); check(name, false, '没有抛错') } catch { check(name, true) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgmerge-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sgmerge'
const T = '2026-11-03T07:00:00.000Z'

const addV = (text) => append(db, aid, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: T, payload: { claims: [{ layer: 'V', kind: 'norm', text, origin: 'extract' }] } }]).entities.claims[0]
const a = addV('数据不对的时候宁可从头再跑一遍')
const b = addV('宁可多跑一遍也不交一个大概对的数')
const c = addV('陪你的时候手机先扣着')

// 其中一条挂一条未到期预见
append(db, aid, [{
  type: 'NU_REGISTER', actor: 'sys', at: T,
  payload: { nus: [{ claim_id: a, expect: '一周内会重跑', observe: 'action_log 里出现重跑', p: 0.6, due_at: '2026-11-10T07:00:00.000Z' }] },
}])

// ---------- 合并 ----------
const r = mergeClaims(db, aid, [a, b], { text: '数据不对的时候宁可从头再跑一遍，也不交一个大概对的数', at: T })
const s = loadState(db, aid)
check('合并：新的那条活跃', s.claims[r.id] && s.claims[r.id].status === 'active')
check('合并：旧的都收回', s.claims[a].status === 'withdrawn' && s.claims[b].status === 'withdrawn')
check('合并：旧原文留在 variants', s.claims[r.id].meta.variants.length === 2)
check('合并：悬空预见被作废', Object.values(s.nus).every((n) => n.outcome !== 'pending'))
check('合并：另一条不受影响', s.claims[c].status === 'active')
check('合并：账本只增（没删命题）', db.prepare('SELECT COUNT(*) n FROM persona_claims WHERE agent_id=?').get(aid).n === 4)

// ---------- 闸：不能乱并 ----------
throwsAny('合并：一条不给并', () => mergeClaims(db, aid, [c], { at: T }))
throwsAny('合并：已终态不能并', () => mergeClaims(db, aid, [a, c], { at: T }))
throwsAny('合并：核心不能并', () => {
  const core = append(db, aid, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'user', at: T, payload: { claims: [{ layer: 'V', kind: 'principle', text: '我更看重把话说明白', origin: 'user' }] } }]).entities.claims[0]
  mergeClaims(db, aid, [core, c], { at: T })
})

// ---------- 推导边 ----------
const d1 = addV('读不到就说读不到')
const d2 = addV('不懂就说不懂')
linkDerives(db, aid, r.id, [d1, d2], { at: T })
check('推导：两条边', derivesOf(db, aid, r.id).length === 2)
check('推导：方向对（核心 → 下条）', derivesOf(db, aid, r.id).includes(d1) && derivesOf(db, aid, d2).length === 0)
check('推导：不能自环', linkDerives(db, aid, r.id, [r.id], { at: T }).added === 0)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
