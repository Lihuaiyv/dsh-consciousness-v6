/**
 * 「我特别看重」的标 / 撤：加和撤都归她自己。
 * 运行：node test/loop-important.test.mjs
 *
 * 判据：标了，事由里 important=true；撤了，回到 false；标一条不存在的，说找不到。
 * 用 makeWorld() 临时库，不碰生产库。
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addLoop } from '../src/modules/loops.js'
import { markLoopImportant, isLoopImportant, proactiveTriggerOf, setProactivePrefs } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const at = (ms) => new Date(Date.now() + ms).toISOString()

const w = makeWorld()
try {
  setProactivePrefs(w.db, w.aid, { enabled: true, per_day: 1, idle_hours: 0, quiet: false })
  const { id } = addLoop(w.db, w.aid, { text: '答应过他周三提醒交周报', due_at: at(-3600000) })

  check('标之前不是特别看重', isLoopImportant(w.db, id) === false)
  const t0 = proactiveTriggerOf(w.db, w.aid)
  check('标之前事由里 important=false', !!t0 && t0.important === false, t0)

  const on = markLoopImportant(w.db, w.aid, id, true)
  check('加标成功', on.ok === true && on.important === true, on)
  check('加标之后 isLoopImportant=true', isLoopImportant(w.db, id) === true)
  const t1 = proactiveTriggerOf(w.db, w.aid)
  check('加标之后事由里 important=true', !!t1 && t1.important === true, t1)

  const off = markLoopImportant(w.db, w.aid, id, false)
  check('撤标成功', off.ok === true && off.important === false, off)
  check('撤标之后回到 false', isLoopImportant(w.db, id) === false)
  const t2 = proactiveTriggerOf(w.db, w.aid)
  check('撤标之后事由里 important=false', !!t2 && t2.important === false, t2)

  const miss = markLoopImportant(w.db, w.aid, 'lp_not_exist', true)
  check('标一条不存在的：说找不到', miss.ok === false && miss.reason === 'loop_not_found', miss)
} finally { w.close() }

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
