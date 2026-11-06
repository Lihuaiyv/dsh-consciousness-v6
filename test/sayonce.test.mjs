/**
 * 「一句话一天最多说一次」的闸。
 * 运行：node test/sayonce.test.mjs
 *
 * 验四件事：
 *   1. 第一次说 → 放行，并且落一条 say.once
 *   2. 同一天再说 → 不给
 *   3. maxDays 到了 → 隔天也不再给
 *   4. 不同的 key 互不影响
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { canSayOnce, saidDays, saidToday } from '../src/modules/sayonce.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const w = makeWorld()
const { db, aid } = w
try {
  check('第一次：放行', canSayOnce(db, aid, 'bridge') === true)
  check('落了一条 say.once', db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='say.once'").get(aid).n === 1)
  check('记着今天说过', saidToday(db, aid, 'bridge') === true)
  check('同一天再说：不给', canSayOnce(db, aid, 'bridge') === false)
  check('另一个 key 不受影响', canSayOnce(db, aid, 'trend.down') === true)

  // maxDays：已经说过两天，明天也不开口了
  for (const d of [1, 2]) {
    db.prepare("INSERT INTO events(id,agent_id,type,payload,created_at) VALUES(?,?,?,?,?)")
      .run('evt_once_' + d, aid, 'say.once', JSON.stringify({ key: 'trend.down', day: '' }), new Date(Date.now() - d * 86400000).toISOString())
  }
  check('说过三天', saidDays(db, aid, 'trend.down') === 3)
  check('maxDays=3 到了：不再说', canSayOnce(db, aid, 'trend.down', { maxDays: 3 }) === false)
  check('没设 maxDays：还能说（只看今天）', canSayOnce(db, aid, 'trend.up') === true)
  check('bridge 只许说一天：明天也不说', canSayOnce(db, aid, 'bridge', { maxDays: 1 }) === false)
} finally {
  w.close && w.close()
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
