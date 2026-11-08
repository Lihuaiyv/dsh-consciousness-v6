/**
 * S5：注入侧「还挂着」弱提示（默认 off，A 组回放不变）。
 * 运行：node test/claim-inject.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { writeParam } from '../src/kernel.js'
import { addLoop, loopLineFor } from '../src/parts/loops/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

// ① 默认 off：原样
{
  const w = makeWorld()
  try {
    addLoop(w.db, w.aid, { text: '先找躯干，看看整体怎么拆', kind: 'task', at: Date.now() - 3 * 86400000 })
    const line = loopLineFor(w.db, w.aid, {})
    check('默认 off：保留「还没做完」', String(line.text).includes('还没做完'), line.text)
    check('默认 off：仍以「还挂着」开头', String(line.text).includes('还挂着'), line.text)
  } finally { w.close() }
}

// ② 开启：换弱提示
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.inject', 'on')
    addLoop(w.db, w.aid, { text: '先找躯干，看看整体怎么拆', kind: 'task', at: Date.now() - 3 * 86400000 })
    const line = loopLineFor(w.db, w.aid, {})
    check('开启：换成「当时还没做」', String(line.text).includes('当时还没做，之后没再确认'), line.text)
    check('开启：不再说「还没做完」', !String(line.text).includes('还没做完'), line.text)
  } finally { w.close() }
}

// ③ 到期 loop：两种模式都保留「已经到期了」
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.inject', 'on')
    const due = new Date(Date.now() - 3600000).toISOString()
    addLoop(w.db, w.aid, { text: '今晚要把清单发我', kind: 'promise', due_at: due, at: Date.now() - 3 * 86400000 })
    const line = loopLineFor(w.db, w.aid, {})
    check('到期：仍说「已经到期了」', String(line.text).includes('已经到期了'), line.text)
    check('到期：不套弱提示', !String(line.text).includes('当时还没做'), line.text)
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
