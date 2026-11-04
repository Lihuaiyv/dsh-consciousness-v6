/**
 * 评价上下文：最近几句原话要拼得对（顺序、条数、截断、坏输入）。
 * 运行：node test/context.test.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { recentSayings } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE affect_events(id TEXT, agent_id TEXT, at TEXT, cause TEXT)')
const ins = db.prepare('INSERT INTO affect_events VALUES(?,?,?,?)')
const AID = 'agt_x'
const lines = [
  '欸你刚刚都想啥呢，怎么这麽久',
  '好了，你的小圈是不是还没画',
  '小圈怎么歪歪扭扭的，很可爱',
  '你想怎么样？',
  '  多  空格\n换行  ',
]
lines.forEach((c, i) => ins.run('e' + i, AID, new Date(2026, 10, 3, 16, i).toISOString(), c))

const ctx = recentSayings(db, AID, 4)
const got = ctx.split('\n')
check('取最近 4 条', got.length === 4, { got })
check('顺序是从旧到新', got[got.length - 1] === '多 空格 换行' && got[got.length - 2] === '你想怎么样？', { got })
check('不把最早那条带进来', !ctx.includes('欸你刚刚都想啥呢'), { ctx })
check('空白被压平', !/ {2,}/.test(ctx), { ctx })

const one = recentSayings(db, AID, 1)
check('limit=1 只取最后一句', one === '  多  空格 换行  '.replace(/\s+/g, ' ').trim(), { one })

check('别的 agent 不出现在里面', recentSayings(db, 'agt_other', 4) === '', { other: recentSayings(db, 'agt_other', 4) })
check('limit 会被夹住', recentSayings(db, AID, 999).split('\n').length <= 8)
check('空库不崩', recentSayings(new DatabaseSync(':memory:'), AID) === '')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
