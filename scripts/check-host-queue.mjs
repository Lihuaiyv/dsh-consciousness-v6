// 后台宿主调用排队（2026-11-17）
// 验：全局并发有上限、同一 agent 严格保序、不同 agent 互不阻塞、排队超时提前失败、快照看得见。
// 纯模块测试，不真调云端；真实调用在 scratch/ 里单独验。
import assert from 'node:assert'
import { scheduleHostTask, hostQueueInfo } from '../src/modules/host_llm.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
function check(name, ok, detail) {
  if (!ok) { console.error('FAIL', name, detail === undefined ? '' : detail); process.exit(1) }
  passed++
  console.log('ok', name)
}

// 1) 全局并发：4 个不同 agent 同时来，最多 2 个在跑
{
  let running = 0
  let maxRun = 0
  const mk = (i) => scheduleHostTask(null, {
    agent: 'ag' + i, label: 't' + i, timeoutMs: 5000,
    run: async () => { running++; maxRun = Math.max(maxRun, running); await sleep(30); running-- },
  })
  await Promise.all([mk(1), mk(2), mk(3), mk(4)])
  // 2026-11-22 主人要求跨会话排队后，默认并发是 1；这里只验「不越上限」和「确实在按队列跑」。
  check('全局并发 ≤ 2', maxRun <= 2, 'maxRun=' + maxRun)
  check('全局并发确实在排队（串行为 1）', maxRun >= 1, 'maxRun=' + maxRun)
  check('跑完 running 归零', hostQueueInfo(null).running === 0)
}

// 2) 同一 agent 保序：后发的快任务不许插到前一个慢任务前面
{
  const order = []
  const a1 = scheduleHostTask(null, {
    agent: 'X', label: 'X:1', timeoutMs: 5000,
    run: async () => { order.push('start1'); await sleep(40); order.push('end1') },
  })
  const a2 = scheduleHostTask(null, {
    agent: 'X', label: 'X:2', timeoutMs: 5000,
    run: async () => { order.push('start2'); order.push('end2') },
  })
  await Promise.all([a1, a2])
  check('同一 agent 严格保序（前一个完才下一个）', order.join(',') === 'start1,end1,start2,end2', order.join(','))
}

// 3) 不同 agent 也排队：2026-11-22 主人要求「跨会话排队」，默认并发 1，两个 agent 不再并行
{
  let r = 0
  let maxR = 0
  const order = []
  const mk = (key) => scheduleHostTask(null, {
    agent: key, label: key, timeoutMs: 5000,
    run: async () => { r++; maxR = Math.max(maxR, r); order.push(key); await sleep(40); r-- },
  })
  await Promise.all([mk('Y'), mk('Z')])
  check('不同 agent 也排队（并发 1 时 maxR=1）', maxR === 1, 'maxR=' + maxR)
  check('两个 agent 都跑到了', order.length === 2, 'ran=' + order.join(','))
}

// 4) 排队超时：槽被占满时，等超预算的那个提前失败、且不执行
{
  const ran = []
  const h1 = scheduleHostTask(null, { agent: 'H1', timeoutMs: 8000, run: () => sleep(1800) })
  const h2 = scheduleHostTask(null, { agent: 'H2', timeoutMs: 8000, run: () => sleep(1800) })
  await sleep(20)
  const mid = hostQueueInfo(null)
  check('快照：一个在跑、其余在排（并发 1）', mid.running === 1 && mid.queued >= 1, JSON.stringify(mid))
  const t0 = Date.now()
  const late = scheduleHostTask(null, {
    agent: 'H3', label: 'late', timeoutMs: 1000,
    run: async () => { ran.push('late') },
  })
  // 队列 timer 是 unref 的；sleep 保活，等它自己超时（槽 1800ms 后才放，超时 1000ms 先到）
  const err = await Promise.race([late.then(() => null, (e) => e), sleep(3000).then(() => 'not-rejected')])
  const waited = Date.now() - t0
  check('排队超时：到预算就被提前拒掉', !!err && err !== 'not-rejected' && /host queue timeout/.test(String(err.message)), String((err && err.message) || err))
  check('排队超时：不是等到让位才拒', waited < 1500, 'waited=' + waited)
  await Promise.all([h1, h2])
  check('排队超时：那个调用没执行', ran.length === 0, JSON.stringify(ran))
  check('超时后队列干净', hostQueueInfo(null).running === 0 && hostQueueInfo(null).queued === 0)
}

// 5) 快照 recent：名字、等多久、跑多久都在
{
  await Promise.all([
    scheduleHostTask(null, { agent: 'R', label: 'affect:topic', timeoutMs: 5000, run: async () => { await sleep(10) } }),
    scheduleHostTask(null, { agent: 'R', label: 'affect:judge', timeoutMs: 5000, run: async () => { await sleep(10) } }),
  ])
  const info = hostQueueInfo(null)
  const labels = info.recent.slice(-2).map((r) => r.label)
  check('快照：recent 记下两条名字', labels.join(',') === 'affect:topic,affect:judge', labels.join(','))
  const ok = info.recent.slice(-2).every((r) => r.ok)
  check('快照：recent 标 ok', ok, JSON.stringify(info.recent.slice(-2)))
}

console.log(`\n${passed} 项全过`)
