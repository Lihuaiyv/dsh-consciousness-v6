/**
 * 阶段 E：记忆体检的 API 入口。
 * 面板要显示「时态」，先得有一条能读到数字的路——这个测试守的就是这条路。
 *
 * 运行：node test/memory-health-api.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { handle } from '../src/api.js'
import { addMemory } from '../src/modules/memory.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const w = makeWorld()
try {
  const dead = addMemory(w.db, w.aid, { text: '一条已作废的记忆', type: 'fact', fact_key: '用户.测试.作废' })
  w.db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(new Date().toISOString(), dead.id)
  addMemory(w.db, w.aid, { text: '咖啡的偏好：冰美式不加糖', type: 'fact', fact_key: '用户.咖啡.偏好' })
  addMemory(w.db, w.aid, { text: '一段反思：今天他说话有点急', type: 'reflection', fact_key: '用户.反应.急躁' })

  const res = await handle(w.db, {
    method: 'GET',
    path: '/v1/agents/' + w.aid + '/memory/health',
    token: 'user',
  })
  check('API 200', res.status === 200, res.status)
  const b = res.body || {}
  check('返回 stale.ejected', typeof b.stale?.ejected === 'number', b.stale)
  check('返回 stale.statement_eligible', typeof b.stale?.statement_eligible === 'number', b.stale)
  check('返回 keys.by_type', !!(b.keys && b.keys.by_type), b.keys)
  check('返回 passport.slot', typeof b.passport?.slot === 'number', b.passport)
  check('作废条被计到 ejected', Number(b.stale?.ejected) >= 1, b.stale)
  check('真槽位只算事实/评价', Number(b.passport?.slot) >= 1 && Number(b.keys?.with_key) > Number(b.keys?.slot), b.keys)

  // 未授权要被挡住（别把体检开成公开端点）
  const noAuth = await handle(w.db, { method: 'GET', path: '/v1/agents/' + w.aid + '/memory/health' })
  check('无 token 返回 401', noAuth.status === 401, noAuth.status)
} finally { w.close() }

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exitCode = 1
