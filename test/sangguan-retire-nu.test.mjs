/**
 * 三观 · 收回命题时把悬空的预见一起作废（B6）。
 * 运行：node test/sangguan-retire-nu.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, SangguanError } from '../src/modules/sangguan/ledger.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { retireClaim, pendingNusOf } from '../src/modules/sangguan/retire.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
function throwsCode(name, fn, code) {
  try { fn(); check(name, false, '没有抛错') } catch (e) {
    check(name, e instanceof SangguanError && (!code || e.code === code), { code: e.code, msg: e.message })
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgretire-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sgretire'
const T0 = '2026-11-03T04:00:00.000Z'
const T1 = '2026-11-03T05:00:00.000Z'
const T2 = '2026-11-10T05:00:00.000Z'

// 两条保护带：cid 不带预见，lid 带一条未到期预见
const r = append(db, aid, [{
  type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: T0,
  payload: { claims: [{ layer: 'V', kind: 'norm', text: '排查问题要先把实际事件列出来核对', origin: 'extract' }] },
}])
const cid = r.entities.claims[0]
// ν 的 claim_id 要等命题 id 出来才能填：改成两步写（真实链路也是先有命题再有 ν）
const lid = append(db, aid, [{
  type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: T0,
  payload: { claims: [{ layer: 'V', kind: 'norm', text: '数据不对就重跑一遍', origin: 'extract' }] },
}]).entities.claims[0]
append(db, aid, [{
  type: 'NU_REGISTER', actor: 'sys', at: T0,
  payload: { nus: [{ claim_id: lid, expect: '一周内会重跑一次', observe: 'action_log 里出现重跑', p: 0.6, due_at: T2 }] },
}])

const s1 = loadState(db, aid)
check('准备：有 1 条未结预见', pendingNusOf(s1, lid).length === 1)

// 不带预见的命题：只收回
const a = retireClaim(db, aid, cid, { at: T1, reason: '测试' })
check('无预见：收回成功', a.retired === cid && a.voided.length === 0)
check('无预见：状态 withdrawn', loadState(db, aid).claims[cid].status === 'withdrawn')

// 带预见的命题：先 void 再收回
const b = retireClaim(db, aid, lid, { at: T1, reason: '测试' })
const s2 = loadState(db, aid)
check('有预见：返回作废 id', b.voided.length === 1)
check('有预见：ν 变 void', Object.values(s2.nus)[0].outcome === 'void')
check('有预见：命题 withdrawn', s2.claims[lid].status === 'withdrawn')
check('有预见：不再留 pending', pendingNusOf(s2, lid).length === 0)
check('有预见：作废原因写成 claim_retired（面板据此说「不是判错」）', (() => {
  const row = db.prepare("SELECT payload_json FROM claim_events WHERE agent_id=? AND type='NU_RESOLVE' ORDER BY seq DESC LIMIT 1").get(aid)
  return JSON.parse(row.payload_json).why === 'claim_retired'
})())

// 重复执行：已终态，跳过且不再记账
const before = db.prepare('SELECT COUNT(*) n FROM claim_events WHERE agent_id=?').get(aid).n
const c = retireClaim(db, aid, lid, { at: T1 })
check('重复：跳过', c.retired === null && c.skipped === 'terminal')
check('重复：不新增事件', db.prepare('SELECT COUNT(*) n FROM claim_events WHERE agent_id=?').get(aid).n === before)

// 不存在 / 核心
throwsCode('不存在：报错', () => retireClaim(db, aid, 'cl_nope', { at: T1 }), 'INVALID')
append(db, aid, [{
  type: 'CLAIM_EXP', layer: 'W', actor: 'user', at: T0,
  payload: { claims: [{ layer: 'W', kind: 'core', text: '世界大体是有回应的', origin: 'seed' }] },
}])
const coreId = Object.values(loadState(db, aid).claims).find((x) => x.kind === 'core').id
throwsCode('核心：不许收回', () => retireClaim(db, aid, coreId, { at: T1 }), 'INVALID')

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
