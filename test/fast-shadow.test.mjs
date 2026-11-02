/**
 * 快情绪影子档：只算不生效。
 * 要保证：加了 fast 之后，她这一轮的表现（level / style / wish）一个字都没变。
 * 运行：node test/fast-shadow.test.mjs
 */
import { expressionState, cardLine, shadowLevel } from '../src/modules/expression_state.js'
import { expressionFrom } from '../src/algo/expression.js'
import { makeWorld } from './eval-persona/setup.mjs'
import { consciousnessBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const affectOf = (slow, fast, total = 0) => ({ primary_label: 'calm', intensity: 0.5, v3: { slow, fast, total } })

// ---- 1) 表现不变：level 仍然只由慢情绪决定
{
  const grid = []
  let changed = 0
  for (const slow of [-0.8, -0.4, 0, 0.35, 0.6]) {
    for (const fast of [-0.7, -0.3, 0, 0.4, 0.8]) {
      const st = expressionState({ affect: affectOf(slow, fast) })
      const base = expressionFrom({ slow, intensity: 0.5, ei: 0.6 })
      grid.push({ slow, fast, level: st.level, would: st.wouldLevel })
      if (st.wouldLevel !== st.level) changed++
      check('level 不受 fast 影响 (' + slow + ',' + fast + ')', st.level === base.level, { got: st.level, want: base.level })
      check('style 跟着 level 走 (' + slow + ',' + fast + ')', st.style === cardLine({ level: st.level }))
    }
  }
  check('影子确实会改档（不然这条影子没意义）', changed > 0, { changed, total: grid.length })
}

// ---- 2) 同慢情绪、不同快情绪：注入完全一样
{
  const w = makeWorld()
  try {
    const before = consciousnessBlock(w.db, w.aid)
    w.db.prepare('UPDATE affect_v3 SET fast=0.9 WHERE agent_id=?').run(w.aid)
    const after = consciousnessBlock(w.db, w.aid)
    check('快情绪拉满也不改这一轮', before === after, { same: before === after })
    w.db.prepare('UPDATE affect_v3 SET fast=-0.9 WHERE agent_id=?').run(w.aid)
    check('快情绪拉负也不改这一轮', before === consciousnessBlock(w.db, w.aid))
  } finally { w.close() }
}

// ---- 3) 影子函数本身：单调、有边界
{
  check('quiet + fast 高 → brief', shadowLevel('quiet', { fast: 0.5, slow: 0 }) === 'brief')
  check('warm 封顶', shadowLevel('warm', { fast: 0.9, slow: 0.5 }) === 'warm')
  check('quiet 封底', shadowLevel('quiet', { fast: -0.9, slow: 0 }) === 'quiet')
  check('低落时快情绪不抬档', shadowLevel('quiet', { fast: 0.5, slow: -0.6 }) === 'quiet')
  check('未知档按 normal 算', shadowLevel('乱写', { fast: 0, slow: 0 }) === 'normal')
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
