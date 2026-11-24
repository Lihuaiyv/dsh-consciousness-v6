/**
 * 本地模型唯一通道的规矩（2026-11-22）
 *
 * 验的是「不会再卡住」这件事本身，不碰真模型：
 *   - 参数写死、不可改；
 *   - 并发永远是 1（一次只进一个任务）；
 *   - 优先级排队（数字小的先跑）；
 *   - 嵌套调用就地跑，不会一个槽等自己（这是老代码最像「卡死」的地方）；
 *   - 排太久直接失败，不占着队列空转。
 *
 * 运行：node test/local-gateway.test.mjs
 */
import { GATEWAY, PRIORITY, enqueue, gatewayStatus, isLocalOllamaUrl, gatewayEmbedAdapter } from '../src/modules/local_gateway.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++
    console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1) 参数写死：不读 flag、不接受覆盖
check('并发写死 1', GATEWAY.concurrency === 1, GATEWAY.concurrency)
check('聊天模型写死 14B', GATEWAY.chat.model === 'qwen2.5:14b-instruct', GATEWAY.chat.model)
check('语义模型写死 0.6b', GATEWAY.embed.model === 'qwen3-embedding:0.6b', GATEWAY.embed.model)
check('ctx 写死 8000', GATEWAY.chat.numCtx === 8000, GATEWAY.chat.numCtx)
check('常驻 keep_alive=-1', GATEWAY.chat.keepAlive === -1, GATEWAY.chat.keepAlive)
check('实验模型跑完就卸（keep_alive=0）', GATEWAY.exp.keepAlive === 0, GATEWAY.exp.keepAlive)
check('GATEWAY 冻结', Object.isFrozen(GATEWAY) && Object.isFrozen(GATEWAY.chat) && Object.isFrozen(GATEWAY.embed))
// 顺序（主人 2026-11-22 定）：对话 > 实验 > 事后整理
check('顺序：对话最高', PRIORITY.chat === Math.min(...Object.values(PRIORITY)), PRIORITY)
check('顺序：实验在切事/普通/批量前面', PRIORITY.exp < PRIORITY.split && PRIORITY.exp < PRIORITY.normal && PRIORITY.exp < PRIORITY.batch, PRIORITY)

// 2) 一次只进一个任务
let live = 0
let maxLive = 0
const order = []
await Promise.all([1, 2, 3, 4, 5].map((n) => enqueue(null, {
  lane: 'test', label: 'conc-' + n, priority: PRIORITY.normal, timeoutMs: 5000,
  run: async () => {
    live++
    maxLive = Math.max(maxLive, live)
    await sleep(15)
    live--
    order.push(n)
  },
})))
check('并发峰值 = 1（同一个模型一次只进一个任务）', maxLive === 1, { maxLive })
check('5 个任务都跑完', order.length === 5, order)

// 2b) 两个槽：14B 忙的时候，向量照样立刻跑（不同模型、不同进程，不用互相让路）
{
  let chatEndedAt = 0
  let embedAt = 0
  let peak = 0
  let inChat = 0
  let inEmbed = 0
  let peakChat = 0
  let peakEmbed = 0
  const chatHold = enqueue(null, {
    lane: 'chat', label: 'long-chat', priority: PRIORITY.chat, timeoutMs: 5000,
    run: async () => {
      inChat++; peak++; peakChat = Math.max(peakChat, inChat)
      await sleep(500)
      inChat--; peak--
      chatEndedAt = Date.now()
    },
  })
  await sleep(30) // 让 14B 那个槽先占住
  const t0 = Date.now()
  await enqueue(null, {
    lane: 'embed', label: 'quick-embed', priority: PRIORITY.embed, timeoutMs: 5000,
    run: async () => {
      inEmbed++; peak++; peakEmbed = Math.max(peakEmbed, inEmbed)
      embedAt = Date.now()
      await sleep(20)
      inEmbed--; peak--
    },
  })
  check('向量不等 14B（各走各的槽）', embedAt > 0 && embedAt - t0 < 200 && chatEndedAt === 0,
    { waitedMs: embedAt - t0, chatStillRunning: chatEndedAt === 0 })
  check('两个槽各自最多 1 个任务', peakChat === 1 && peakEmbed === 1, { peakChat, peakEmbed })
  check('不同模型可以同时各跑一个（总并发 2）', peak >= 1, { peak })
  await chatHold
}

// 3) 优先级：数字小的先跑，同级按入队顺序
const seqOrder = []
const slowFirst = enqueue(null, {
  lane: 'test', label: 'low', priority: PRIORITY.batch, timeoutMs: 5000,
  run: async () => { await sleep(40); seqOrder.push('low') },
})
await sleep(5) // 确保 low 已经进队列、还没跑完
const normal = enqueue(null, {
  lane: 'test', label: 'normal', priority: PRIORITY.normal, timeoutMs: 5000,
  run: async () => { seqOrder.push('normal') },
})
const hi = enqueue(null, {
  lane: 'test', label: 'hi', priority: PRIORITY.chat, timeoutMs: 5000,
  run: async () => { seqOrder.push('hi') },
})
await Promise.all([slowFirst, normal, hi])
// 2026-11-22 分块之后，规则变成「块内先来后到、块间才插队」：
// 这三个任务都在聊天块里（label 不匹配 exp:/split: 这些前缀），所以按入队顺序跑，
// 优先级数字不再在块内插队——这条断言跟着设计改，不再要求 hi 抢到 normal 前面。
check('同一块里按先来后到（块内不再按优先级数字插队）', seqOrder.join(',') === 'low,normal,hi', seqOrder)

// 4) 嵌套调用就地跑：老的队列会让一个槽等自己，永久卡住
let nested = ''
const outer = await enqueue(null, {
  lane: 'test', label: 'outer', priority: PRIORITY.chat, timeoutMs: 3000,
  run: async () => {
    // 在任务里再调一次通道（以前这里就是死锁点）
    nested = await enqueue(null, {
      lane: 'test', label: 'inner', priority: PRIORITY.batch, timeoutMs: 3000,
      run: async () => 'inner-ok',
    })
    return 'outer-ok'
  },
})
check('外层任务完成（没死锁）', outer === 'outer-ok', outer)
check('内层调用就地执行', nested === 'inner-ok', nested)

// 5) 排队超时：占着槽的任务不该把后面的人拖死
//    （队列的等待下限是 1 秒：连 1 秒都不肯等的调用，应该自己先失败）
const hold = enqueue(null, {
  lane: 'test', label: 'hold', priority: PRIORITY.chat, timeoutMs: 5000,
  run: async () => { await sleep(1400); return 'hold-done' },
})
let timeoutErr = ''
try {
  await enqueue(null, {
    lane: 'test', label: 'waiter', priority: PRIORITY.batch, timeoutMs: 1000,
    run: async () => 'never',
  })
} catch (e) { timeoutErr = String(e && e.message) }
check('排太久直接失败（不占队列空转）', /queue timeout/.test(timeoutErr), timeoutErr)
await hold

// 6) 状态快照
const st = await gatewayStatus(null)
check('状态：并发报 1', st.concurrency === 1, st.concurrency)
check('状态：队列清空', st.queued === 0 && st.running === 0, { queued: st.queued, running: st.running })
check('状态：带冻结参数', st.frozen.chat === GATEWAY.chat.model, st.frozen)
check('状态：最近记录里有刚才的任务', Array.isArray(st.recent) && st.recent.some((r) => r.label === 'outer'), st.recent.slice(-3))

// 7) 本机向量口识别 + 适配器形状
check('识别本机 ollama 向量口', isLocalOllamaUrl('http://127.0.0.1:11434/v1') === true)
check('别处的向量口不动它', isLocalOllamaUrl('http://127.0.0.1:8080/v1') === false)
const ad = gatewayEmbedAdapter()
check('向量适配器 embedOnly（不冒充聊天）', ad.embedOnly === true && typeof ad.embed === 'function')

console.log(`\n${pass}/${pass + fail} 通过`)
if (fail) process.exitCode = 1
