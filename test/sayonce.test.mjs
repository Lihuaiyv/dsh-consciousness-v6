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

  // maxDays 必须有窗口：窗口内说满就收声，窗口外的旧账不再压着今天
  for (const d of [1, 2]) {
    db.prepare("INSERT INTO events(id,agent_id,type,payload,created_at) VALUES(?,?,?,?,?)")
      .run('evt_once_' + d, aid, 'say.once', JSON.stringify({ key: 'trend.down', day: '' }), new Date(Date.now() - d * 86400000).toISOString())
  }
  check('说过三天', saidDays(db, aid, 'trend.down') === 3)
  check('窗口内说满三天：不再说', canSayOnce(db, aid, 'trend.down', { maxDays: 3, withinDays: 10 }) === false)
  check('没设 maxDays：还能说（只看今天）', canSayOnce(db, aid, 'trend.up') === true)

  // 回归（11-06 查出来的两个 bug）：
  // 1) bridge 不能传 maxDays：传了就等于「这辈子只活一天」
  db.prepare("INSERT INTO events(id,agent_id,type,payload,created_at) VALUES(?,?,?,?,?)")
    .run('evt_bridge_yday', aid, 'say.once', JSON.stringify({ key: 'bridge_next_day', day: '' }), new Date(Date.now() - 86400000).toISOString())
  check('bridge 昨天说过：今天照样能说（一天一次，不是只活一天）', canSayOnce(db, aid, 'bridge_next_day') === true, saidDays(db, aid, 'bridge_next_day'))
  // 2) trend 的旧账要能过期：三个月前那三天不该压着今天
  for (const d of [80, 81, 82]) {
    db.prepare("INSERT INTO events(id,agent_id,type,payload,created_at) VALUES(?,?,?,?,?)")
      .run('evt_old_' + d, aid, 'say.once', JSON.stringify({ key: 'trend.old', day: '' }), new Date(Date.now() - d * 86400000).toISOString())
  }
  check('窗口只管窗口内：总数仍是三天', saidDays(db, aid, 'trend.old') === 3, saidDays(db, aid, 'trend.old'))
  check('窗口内不计旧账', saidDays(db, aid, 'trend.old', { withinDays: 10 }) === 0, saidDays(db, aid, 'trend.old', { withinDays: 10 }))
  check('三个月前的三天不算数：今天还能说', canSayOnce(db, aid, 'trend.old', { maxDays: 3, withinDays: 10 }) === true)
} finally {
  w.close && w.close()
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
