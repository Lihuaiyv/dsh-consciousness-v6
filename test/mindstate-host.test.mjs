/**
 * 宿主级水位测试：不接真 DSH，只把 pre-step 收到的那一套形状喂进来。
 * 跑法：node test/mindstate-host.test.mjs
 *
 * 覆盖的是 index.js 里的 noteSessionMeter：
 *   1) requestContext().contextWindow 当作窗口，readTokens 的值当作水位；
 *   2) 15 秒节流：接连两步不重复 measure；
 *   3) readTokens 抛错 / 返回 0 时不写；
 *   4) 换会话各算各的，不串。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-mind-host-'))
process.env.DSH_HOME = dir

const { debugNoteSessionMeter, _resetMeterThrottle } = await import('../index.js')
const { meterOf, _resetMindState } = await import('../src/modules/mindstate.js')

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name, extra === undefined ? '' : JSON.stringify(extra)) }
}

function fakeSession(id, window) {
  return {
    id,
    requestContext: () => ({ provider: 'p', model: 'm', contextWindow: window }),
  }
}

const payload = (session) => ({ agent: { session } })

_resetMindState()
_resetMeterThrottle()

// 1) 正常量一次：65000 / 100000
debugNoteSessionMeter(payload(fakeSession('sess-a', 100000)), () => 65000)
const m1 = meterOf('sess-a')
check('noteSessionMeter：记下 used / window', m1 && m1.used === 65000 && m1.window === 100000, m1)
check('noteSessionMeter：ratio 算对', m1 && Math.abs(m1.ratio - 0.65) < 1e-9, m1)

// 2) 节流：同一瞬间再量一次，值不该变
debugNoteSessionMeter(payload(fakeSession('sess-a', 100000)), () => 20000)
const m2 = meterOf('sess-a')
check('节流：15 秒内不重复 measure', m2 && m2.used === 65000, m2)

// 3) 放行后换会话：各算各的
_resetMeterThrottle()
debugNoteSessionMeter(payload(fakeSession('sess-b', 80000)), () => 30000)
const mb = meterOf('sess-b')
check('换会话：自己的水位独立', mb && mb.used === 30000 && mb.window === 80000, mb)
check('换会话：sess-a 没被改', meterOf('sess-a') && meterOf('sess-a').used === 65000, meterOf('sess-a'))

// 4) requestContext 缺窗口：window=0，照样记账，但 mindstate 不会开口
_resetMeterThrottle()
debugNoteSessionMeter(payload(fakeSession('sess-c', undefined)), () => 40000)
const mc = meterOf('sess-c')
check('没有 contextWindow：window 记 0', mc && mc.used === 40000 && mc.window === 0, mc)

// 5) readTokens 抛错：不写，不崩
_resetMeterThrottle()
debugNoteSessionMeter(payload(fakeSession('sess-d', 100000)), () => { throw new Error('boom') })
check('measure 抛错：不写水位也不崩', meterOf('sess-d') === null, meterOf('sess-d'))

// 6) 返回 0：不写
_resetMeterThrottle()
debugNoteSessionMeter(payload(fakeSession('sess-e', 100000)), () => 0)
check('measure 返回 0：不写', meterOf('sess-e') === null, meterOf('sess-e'))

// 7) payload 形状不对：静默
_resetMeterThrottle()
debugNoteSessionMeter(null, () => 1)
debugNoteSessionMeter({}, () => 1)
debugNoteSessionMeter({ agent: {} }, () => 1)
check('payload 缺 session：静默不崩', true)

_resetMindState()
console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
