/**
 * 事件循环卡顿探针（2026-11-22）
 *
 * 为什么要有：卡死时 hook.log 停写、CPU 却在跑，事后只能猜「是哪一段」。
 * 这个探针每 50ms 摸一次事件循环：如果两次醒了超过 1.5 秒，说明主线程被同步任务占住了。
 * 它会把「卡了多久 + 卡之前最后做的是什么」写进 hook.log——卡住的位置就能自己报出来。
 *
 * 用法：
 *   loopWatch.start(probe)      // 插件启动时一次
 *   loopWatch.mark('retrieve')  // 关键段落前后打点
 */
const TICK_MS = 50
const LAG_MS = 1500

let timer = null
let probeFn = null
let lastTick = 0
let lastTag = 'start'
let lastTagAt = 0
let maxLag = 0
let stallCount = 0
let stalls = []

export function start(fn) {
  if (timer) return
  probeFn = typeof fn === 'function' ? fn : null
  lastTick = Date.now()
  timer = setInterval(() => {
    const now = Date.now()
    const lag = now - lastTick - TICK_MS
    lastTick = now
    if (lag < LAG_MS) return
    maxLag = Math.max(maxLag, lag)
    stallCount++
    const item = {
      at: new Date().toISOString(),
      lagMs: lag,
      tag: lastTag,
      tagAgoMs: lastTagAt ? now - lastTagAt : 0,
    }
    stalls.push(item)
    if (stalls.length > 20) stalls.shift()
    try {
      if (probeFn) probeFn('eventloop-stall lag=' + lag + 'ms after=' + lastTag + '（' + item.tagAgoMs + 'ms 前打的点）')
    } catch { /* 探针自己不能影响主线程 */ }
  }, TICK_MS)
  if (timer.unref) timer.unref()
}

export function mark(tag) {
  lastTag = String(tag || '')
  lastTagAt = Date.now()
}

export function stats() {
  return { maxLag, stallCount, stalls: stalls.slice(-6), lastTag }
}

export function stop() {
  if (timer) clearInterval(timer)
  timer = null
}
