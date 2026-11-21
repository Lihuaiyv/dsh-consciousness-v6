// 本地模型调用排队（2026-11-17）
// 验：所有本地调用走同一条队列、单并发、优先级插队、排队超时提前失败、计数回落。
// 纯模块测试，不连真 Ollama；真实调用在 scratch/ 里单独验。
import assert from 'node:assert'
import { scheduleLocalTask, localQueueInfo, localBusy, localPending, LOCAL_PRIORITY } from '../src/modules/local_llm.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
function check(name, ok, detail) {
  if (!ok) { console.error('FAIL', name, detail === undefined ? '' : detail); process.exit(1) }
  passed++
  console.log('ok', name)
}

// 1) 单并发：三个任务同时入队，任何时刻最多一个在跑
{
  let now = 0
  let maxNow = 0
  const order = []
  const mk = (tag) => scheduleLocalTask(null, {
    priority: LOCAL_PRIORITY.normal, timeoutMs: 5000, label: tag,
    run: async () => { now++; maxNow = Math.max(maxNow, now); order.push(tag); await sleep(25); now-- },
  })
  await Promise.all([mk('a'), mk('b'), mk('c')])
  check('单并发：任何时刻只有一个本地调用在跑', maxNow === 1, 'maxNow=' + maxNow)
  check('单并发：按入队顺序跑完', order.join(',') === 'a,b,c', order.join(','))
  check('跑完计数回 0', localBusy() === 0 && localPending() === 0, localBusy() + '/' + localPending())
}

// 2) 优先级插队：先排着的低优先级要给后来的高优先级让路
{
  const order = []
  let release = null
  const hold = scheduleLocalTask(null, {
    priority: LOCAL_PRIORITY.split, timeoutMs: 5000, label: 'hold',
    run: () => new Promise((r) => { release = r }),
  })
  await sleep(10) // 让 hold 先占住槽
  const low = scheduleLocalTask(null, {
    priority: LOCAL_PRIORITY.batch, timeoutMs: 5000, label: 'low',
    run: async () => { order.push('low') },
  })
  const high = scheduleLocalTask(null, {
    priority: LOCAL_PRIORITY.chat, timeoutMs: 5000, label: 'high',
    run: async () => { order.push('high') },
  })
  await sleep(10)
  check('排队中：低优先级先到但还没跑', order.length === 0)
  check('排队中：队列里有 2 条', localPending() === 2, localPending())
  release()
  await Promise.all([hold, low, high])
  check('优先级插队：聊天(1)排到批量(7)前面', order.join(',') === 'high,low', order.join(','))
}

// 3) 排队超时：还没轮到就等超了，提前失败且不执行
{
  const ran = []
  let release = null
  const hold = scheduleLocalTask(null, {
    priority: LOCAL_PRIORITY.chat, timeoutMs: 5000, label: 'hold',
    run: () => new Promise((r) => { release = r }),
  })
  await sleep(10)
  const t0 = Date.now()
  // 队列 timer 是 unref 的（生产里插件进程常驻）；测试里用 sleep 保活，不然进程先退了
  const waiting = scheduleLocalTask(null, {
    priority: LOCAL_PRIORITY.normal, timeoutMs: 1000, label: 'wait',
    run: async () => { ran.push('wait') },
  })
  const err = await Promise.race([
    waiting.then(() => null, (e) => e),
    sleep(2500).then(() => 'timeout-not-rejected'),
  ])
  const waited = Date.now() - t0
  check('排队超时：到它的预算就被提前拒掉', !!err && err !== 'timeout-not-rejected' && /queue timeout/.test(String(err.message)), String(err && err.message || err))
  check('排队超时：不是等到被让位才拒的', waited < 2000, 'waited=' + waited)
  release()
  await hold
  check('排队超时：这个调用压根没执行', ran.length === 0, JSON.stringify(ran))
  check('排队超时后计数回 0', localBusy() === 0 && localPending() === 0, localBusy() + '/' + localPending())
}

// 4) 队列快照：谁在跑、谁在排、最近记录都看得到
{
  let release = null
  const busy = scheduleLocalTask(null, {
    priority: LOCAL_PRIORITY.split, timeoutMs: 5000, label: 'split:work',
    run: () => new Promise((r) => { release = r }),
  })
  await sleep(10)
  const waiting = scheduleLocalTask(null, { priority: LOCAL_PRIORITY.batch, timeoutMs: 5000, label: 'causal:judge', run: async () => {} })
  await sleep(5)
  const info = localQueueInfo(null)
  check('快照：running=1', info.running === 1, info.running)
  check('快照：queued=1', info.queued === 1, info.queued)
  check('快照：在跑的那条有名字', info.runningItems[0] && info.runningItems[0].label === 'split:work', JSON.stringify(info.runningItems))
  check('快照：排队的那条有优先级', info.queue[0] && info.queue[0].priority === LOCAL_PRIORITY.batch, JSON.stringify(info.queue))
  release()
  await Promise.all([busy, waiting])
  const after = localQueueInfo(null)
  check('快照：跑完 recent 记下两条', after.recent.length >= 2, after.recent.length)
  const okAll = after.recent.slice(-2).every((r) => r.ok)
  check('快照：recent 标 ok', okAll, JSON.stringify(after.recent.slice(-2)))
}

console.log(`\n${passed} 项全过`)
