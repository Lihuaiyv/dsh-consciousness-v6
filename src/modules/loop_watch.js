/**
 * 事件循环卡顿探针（2026-11-22）
 *
 * 为什么要有：卡死时 hook.log 停写、CPU 却在跑，事后只能猜「是哪一段」。
 * 这个探针每 50ms 摸一次事件循环：如果两次醒了超过 1.5 秒，说明主线程被同步任务占住了。
 * 它会把「卡了多久 + 卡之前最后做的是什么」写进 hook.log——卡住的位置就能自己报出来。
 *
 * 2026-11-22 加：每秒把「当前在做哪一段」覆盖写进 stage.txt。
 * 为什么不是写 hook.log：卡住时主线程写不进去，重启后日志就断了；
 * 而 stage.txt 每秒一次小文件覆盖，卡住时**最后一次成功写入**就是卡住的那一刻在哪段，
 * 重启也能翻到。看它不用开任何工具，更不用等。
 *
 * 用法：
 *   loopWatch.start(probe, { stageFile })   // 插件启动时一次
 *   loopWatch.mark('retrieve')              // 关键段落前后打点
 */
import fs from 'node:fs'

const TICK_MS = 50
const LAG_MS = 1500
const STAGE_EVERY_MS = 1000

let timer = null
let probeFn = null
let lastTick = 0
let lastTag = 'start'
let lastTagAt = 0
let maxLag = 0
let stallCount = 0
let stalls = []
let stageFile = ''
let lastStageWrite = 0

function writeStage() {
  if (!stageFile) return
  lastStageWrite = Date.now()
  const line = JSON.stringify({
    at: new Date().toISOString(),
    tag: lastTag,
    tagAgoMs: lastTagAt ? Date.now() - lastTagAt : 0,
    maxLag,
  }) + '\n'
  try {
    // 2026-11-22：原来每秒覆盖写一行，卡死恢复后一写就把「卡住时那行」盖掉了，
    // 回看只剩恢复后的现场。改成追加，丢一点空间换回可回看的那几十秒。
    fs.appendFileSync(stageFile, line)
    try {
      if (fs.statSync(stageFile).size > 32 * 1024) {
        const lines = fs.readFileSync(stageFile, 'utf8').split('\n').filter(Boolean)
        fs.writeFileSync(stageFile, lines.slice(-150).join('\n') + '\n')
      }
    } catch { /* 裁剪失败不影响记录 */ }
  } catch { /* 写不进去不影响主线程 */ }
}

export function start(fn, opts = {}) {
  if (timer) return
  probeFn = typeof fn === 'function' ? fn : null
  stageFile = String((opts && opts.stageFile) || '')
  lastTick = Date.now()
  writeStage()
  timer = setInterval(() => {
    const now = Date.now()
    const lag = now - lastTick - TICK_MS
    lastTick = now
    if (now - lastStageWrite >= STAGE_EVERY_MS) writeStage()
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
    writeStage()
  }, TICK_MS)
  if (timer.unref) timer.unref()
}

export function mark(tag) {
  lastTag = String(tag || '')
  lastTagAt = Date.now()
  writeStage()
}

export function stats() {
  return { maxLag, stallCount, stalls: stalls.slice(-6), lastTag }
}

export function stop() {
  if (timer) clearInterval(timer)
  timer = null
}
