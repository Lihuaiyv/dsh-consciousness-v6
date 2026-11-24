/**
 * 呼吸哨兵（2026-11-22）
 *
 * 为什么单独开线程：卡死时主线程整个停住，主线程里写的日志全断，事后只能猜。
 * 这里主线程只做一件事——每 500ms 往共享内存里写一个时间戳（「我还在」）。
 * 另一个线程专门盯这个时间戳：超过 2 秒没更新就判定主线程停摆，
 * 那一刻它能记下：停摆多久、进程内存、数据库 WAL 大小、卡住时日志最后停在哪个阶段。
 * 它是唯一在卡死期间还活着的记录者。
 */
import fs from 'node:fs'
import { Worker } from 'node:worker_threads'

const WORKER_SRC = `
const { workerData } = require('node:worker_threads')
const fs = require('node:fs')
const sab = new Float64Array(workerData.sab)
const out = workerData.out
const wal = workerData.wal
const stage = workerData.stage
const stuckMs = workerData.stuckMs
const MAX_LINES = 400
let lastWrite = 0

function statSafe(p) { try { return fs.statSync(p).size } catch { return -1 } }
function tail(p) {
  try {
    const lines = fs.readFileSync(p, 'utf8').trim().split('\\n')
    return String(lines[lines.length - 1] || '').slice(0, 200)
  } catch { return '' }
}
function write(o) {
  try {
    fs.appendFileSync(out, JSON.stringify(o) + '\\n')
    if (fs.statSync(out).size > 128 * 1024) {
      const lines = fs.readFileSync(out, 'utf8').split('\\n').filter(Boolean)
      fs.writeFileSync(out, lines.slice(-MAX_LINES).join('\\n') + '\\n')
    }
  } catch (e) { /* 记录失败不能反过来影响现场 */ }
}

write({ at: new Date().toISOString(), kind: 'start', stuckMs })

setInterval(() => {
  const last = sab[0] || 0
  const now = Date.now()
  const gap = last ? now - last : -1
  if (gap >= stuckMs) {
    if (now - lastWrite >= 1000) {
      lastWrite = now
      const m = process.memoryUsage()
      write({
        at: new Date().toISOString(),
        kind: 'stall',
        stalledMs: gap,
        rssMB: Math.round(m.rss / 1048576),
        heapMB: Math.round(m.heapUsed / 1048576),
        externalMB: Math.round(m.external / 1048576),
        walSize: statSafe(wal),
        stageTail: tail(stage),
      })
    }
  } else if (lastWrite) {
    lastWrite = 0
    write({ at: new Date().toISOString(), kind: 'recover', stageTail: tail(stage) })
  }
}, 200)
`

/**
 * @param {{ outPath: string, walPath?: string, stagePath?: string, stuckMs?: number }} opt
 * @returns {{ stop: () => void }}
 */
export function startBreathWatch({ outPath, walPath = '', stagePath = '', stuckMs = 2000 } = {}) {
  if (!outPath) return { stop() {} }
  try {
    const sab = new SharedArrayBuffer(8)
    const view = new Float64Array(sab)
    view[0] = Date.now()
    const beat = setInterval(() => { view[0] = Date.now() }, 500)
    if (beat.unref) beat.unref()
    const w = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { sab, out: outPath, wal: walPath, stage: stagePath, stuckMs: Math.max(500, Number(stuckMs) || 2000) },
    })
    if (w.unref) w.unref()
    w.on('error', () => { /* 哨兵挂了不影响主流程 */ })
    return {
      stop() {
        try { clearInterval(beat) } catch { /* ignore */ }
        try { w.terminate() } catch { /* ignore */ }
      },
    }
  } catch { return { stop() {} } }
}
