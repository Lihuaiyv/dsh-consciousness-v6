/**
 * 提示词三道闸的模拟：一天一天走，看哪些话什么时候说、什么时候闭嘴。
 * 运行：node scripts/sim/sim-prompt-gates.mjs
 *
 * 三样东西：
 *   1. 「上次你们聊到」—— 一天一次，隔天还能再说（不是只活一天）
 *   2. 「这两天在往下掉」—— 同一方向说满三天收声；窗口过了还能再说
 *   3. 「有件事我后来再看」—— 一天一次，同一条最多两天
 *
 * 全部用假时钟走，不碰线上库（makeWorld 是临时库）。
 */
import { makeWorld } from '../../test/eval-persona/setup.mjs'
import { canSayOnce } from '../../src/modules/sayonce.js'
import { reappraiseLine } from '../../src/modules/reappraise.js'

const DAY = 86400000
const w = makeWorld()
const { db, aid } = w
const t0 = Date.now() - 10 * DAY

let fail = 0
function check(name, ok, detail) {
  if (!ok) { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail)) }
}

// 一条「后来再看」的旧事：判过变淡，所以有资格被贴出来
db.prepare('INSERT INTO events(id,agent_id,type,payload,created_at) VALUES(?,?,?,?,?)')
  .run('evt_sim_reap', aid, 'memory.reappraise',
    JSON.stringify({ memory_id: 'mem_sim', text: '现在再看，没那么堵了', changed: true }),
    new Date(t0).toISOString())

const days = [0, 1, 2, 3, 4, 5, 20]
const rows = []
for (const d of days) {
  const at = t0 + d * DAY
  const bridge = canSayOnce(db, aid, 'bridge', { at })
  const trend = canSayOnce(db, aid, 'trend.down', { at, maxDays: 3, withinDays: 10 })
  const reap = reappraiseLine(db, aid, at) !== ''
  rows.push({ d, bridge, trend, reap })
}

console.log('天  「上次你们聊到」  「这两天在往下掉」  「后来再看」')
for (const r of rows) {
  console.log(String(r.d).padStart(2) + '  ' +
    (r.bridge ? '说' : '—').padEnd(14) +
    (r.trend ? '说' : '—').padEnd(18) +
    (r.reap ? '说' : '—'))
}

const get = (d) => rows.find((r) => r.d === d)
check('bridge 每天都说得出来', [0, 1, 2, 3, 4, 5].every((d) => get(d).bridge === true), rows)
check('bridge 第 20 天也还在说', get(20).bridge === true, get(20))
check('方向灯：前三天说', [0, 1, 2].every((d) => get(d).trend === true), rows)
check('方向灯：第四天起收声', [3, 4, 5].every((d) => get(d).trend === false), rows)
check('方向灯：窗口过了（第 20 天）还能再说', get(20).trend === true, get(20))
check('后来再看：第一天说', get(0).reap === true, get(0))
check('后来再看：第二天还能说', get(1).reap === true, get(1))
check('后来再看：第三天起不再说（同一条最多两天）', [2, 3, 4, 5].every((d) => get(d).reap === false), rows)

w.close && w.close()
console.log(fail ? '\n不对的地方：' + fail + ' 条' : '\n三道闸都对：bridge 每天一次、方向灯三天收声、后来再看最多两天')
process.exit(fail ? 1 : 0)
