/**
 * 链引擎单测（2026-11-23）：顺序、when、stop、错误策略、防重入、校验。
 * 运行：node test/chain.test.mjs
 */
import { validateChain, runChain, runningChains, __resetRunning } from '../src/modules/chain.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

__resetRunning()

// 1 顺序执行 + ctx 传递（code → local → io）
{
  const order = []
  const chain = {
    id: 'seq', block: 'chat',
    steps: [
      { id: 'a', kind: 'code', run(ctx) { order.push('a'); ctx.x = 1 } },
      { id: 'b', kind: 'local', block: 'chat', label: 't:local-b', request: (ctx) => ({ text: String(ctx.x) }), run(ctx, raw) { order.push('b:' + raw) } },
      { id: 'c', kind: 'io', run(ctx) { order.push('c') } },
    ],
  }
  const ctx = { key: 'k1', runner: { local: async (req) => { order.push('call:' + req.text); return 'ok' } } }
  const res = await runChain(chain, ctx)
  check('顺序执行，ctx 从 code 传到 local', res.ok && order.join(',') === 'a,call:1,b:ok,c', order)
}

// 2 when 不满足跳过
{
  const order = []
  const chain = {
    id: 'when', block: 'chat',
    steps: [
      { id: 'a', kind: 'code', run() { order.push('a') } },
      { id: 'b', kind: 'code', run() { order.push('b') }, when: () => false },
    ],
  }
  const res = await runChain(chain, { key: 'k2' })
  check('when=false 跳过该步', res.ok && order.join(',') === 'a' && res.steps.find((s) => s.id === 'b').skipped, res.steps)
}

// 3 stop 提前正常结束
{
  const order = []
  const chain = {
    id: 'stop', block: 'chat',
    steps: [
      { id: 'a', kind: 'code', run() { order.push('a'); return { stop: true } } },
      { id: 'b', kind: 'code', run() { order.push('b') } },
    ],
  }
  const res = await runChain(chain, { key: 'k3' })
  check('stop 后不再跑下一步，且不算失败', res.ok && res.stopped && order.join(',') === 'a', { res, order })
}

// 4 request 返回 null → 这步跳过，继续
{
  const order = []
  const chain = {
    id: 'nullable', block: 'chat',
    steps: [
      { id: 'a', kind: 'local', block: 'chat', label: 't:null', request: () => null, run() { order.push('a') } },
      { id: 'b', kind: 'code', run() { order.push('b') } },
    ],
  }
  const res = await runChain(chain, { key: 'k4', runner: { local: async () => 'x' } })
  check('request=null 跳过且继续', res.ok && order.join(',') === 'b' && res.steps.find((s) => s.id === 'a').skipped, res.steps)
}

// 5 错误 abort（默认）：停、不抛、ok=false
{
  const order = []
  const chain = {
    id: 'abort', block: 'chat',
    steps: [
      { id: 'a', kind: 'local', block: 'chat', label: 't:boom', request: () => ({}), run() { order.push('a') } },
      { id: 'b', kind: 'code', run() { order.push('b') } },
    ],
  }
  let threw = false
  let res
  try { res = await runChain(chain, { key: 'k5', runner: { local: async () => { throw new Error('boom') } } }) } catch { threw = true }
  check('出错不抛给调用方', !threw)
  check('abort 停在失败步，后续不跑', res && !res.ok && order.join(',') === '' && res.steps[0].err === 'boom', res)
}

// 6 onError=continue：出错继续跑下一步
{
  const order = []
  const chain = {
    id: 'continue', block: 'chat', onError: 'continue',
    steps: [
      { id: 'a', kind: 'local', block: 'chat', label: 't:boom2', request: () => ({}), run() { order.push('a') } },
      { id: 'b', kind: 'code', run() { order.push('b') } },
    ],
  }
  const res = await runChain(chain, { key: 'k6', runner: { local: async () => { throw new Error('x') } } })
  check('continue 出错后继续', res && !res.ok && order.join(',') === 'b', res)
}

// 7 防重入：同 key 同时只跑一份
{
  __resetRunning()
  let release
  const gate = new Promise((r) => { release = r })
  const chain = {
    id: 'reenter', block: 'chat',
    steps: [{ id: 'm', kind: 'local', block: 'chat', label: 't:re', request: () => ({}), run: async () => {} }],
  }
  const p1 = runChain(chain, { key: 'same', runner: { local: async () => { await gate; return 'x' } } })
  const p2 = await runChain(chain, { key: 'same', runner: { local: async () => 'x' } })
  check('同 key 重入被挡（skipped running）', p2.ok === false && p2.skipped === 'running', p2)
  release()
  const r1 = await p1
  check('第一次照常跑完', r1.ok, r1)
  check('跑完清掉防重入', runningChains().length === 0, runningChains())
}

// 8 校验：块号递减
{
  let msg = ''
  try {
    validateChain({ id: 'bad', block: 'night', steps: [{ id: 'a', kind: 'code', block: 'chat', run() {} }] })
  } catch (e) { msg = e.message }
  check('块号往回走 → 立刻拒绝', /块号递减/.test(msg), msg)
}

// 9 校验：模型步缺 label
{
  let msg = ''
  try { validateChain({ id: 'bad2', block: 'chat', steps: [{ id: 'a', kind: 'local', request: () => ({}), run() {} }] }) } catch (e) { msg = e.message }
  check('模型步缺 label → 拒绝', /缺 label/.test(msg), msg)
}

// 10 没注入 runner：该步记错，不抛
{
  const chain = {
    id: 'norunner', block: 'chat',
    steps: [{ id: 'a', kind: 'host', block: 'chat', label: 't:host', request: () => ({}), run() {} }],
  }
  const res = await runChain(chain, { key: 'k10' })
  check('没注入 runner → 该步报错，链不抛', res && !res.ok && /runner\.host/.test(res.steps[0].err), res)
}

// 11 校验：空 steps
{
  let msg = ''
  try { validateChain({ id: 'empty', block: 'chat', steps: [] }) } catch (e) { msg = e.message }
  check('空 steps → 拒绝', /steps 为空/.test(msg), msg)
}

// 12 校验：块名不许写数字（老数字 3 是实验，会和新 night 撞）
{
  let msg = ''
  try { validateChain({ id: 'numb', block: 3, steps: [{ id: 'a', kind: 'code', run() {} }] }) } catch (e) { msg = e.message }
  check('块写数字 → 拒绝', /块只能是 chat \/ exp \/ night/.test(msg), msg)
}

// 13 校验：when 给了但不是函数
{
  let msg = ''
  try { validateChain({ id: 'badwhen', block: 'chat', steps: [{ id: 'a', kind: 'code', run() {}, when: 'yes' }] }) } catch (e) { msg = e.message }
  check('when 不是函数 → 拒绝', /when 必须是函数/.test(msg), msg)
}

// 14 没给 key：自动分配，不互相挡；失败的步能报出来
{
  __resetRunning()
  const chain = {
    id: 'anon', block: 'chat',
    steps: [{ id: 'a', kind: 'code', run() {} }],
  }
  const r1 = await runChain(chain, {})
  const r2 = await runChain(chain, {})
  check('没 key：自动分配，两条都能跑', r1.ok && r2.ok && r1.key !== r2.key, { r1: r1.key, r2: r2.key })

  const bad = {
    id: 'anonfail', block: 'chat',
    steps: [
      { id: 'ok1', kind: 'code', run() {} },
      { id: 'boom', kind: 'code', run() { throw new Error('x') } },
    ],
  }
  const r3 = await runChain(bad, {})
  check('失败步 id 能报出来', r3.ok === false && r3.failedStep === 'boom', r3)
}

// 15 optional 步失败：不中断、不算硬失败、记 degraded
{
  const order = []
  const chain = {
    id: 'opt', block: 'chat',
    steps: [
      { id: 'a', kind: 'local', block: 'chat', label: 't:opt', request: () => ({}), run() { order.push('a') }, optional: true },
      { id: 'b', kind: 'code', run() { order.push('b') } },
    ],
  }
  const res = await runChain(chain, { key: 'k15', runner: { local: async () => { throw new Error('x') } } })
  check('optional 失败：链继续、ok 仍 true', res.ok && order.join(',') === 'b', res)
  check('optional 失败：该步记 degraded', res.steps.find((s) => s.id === 'a').degraded === true, res.steps)
  check('optional 失败：不算 failedStep', !res.failedStep, res)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
