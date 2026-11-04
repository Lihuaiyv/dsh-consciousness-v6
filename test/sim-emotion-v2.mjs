/**
 * 第五步：整体模拟对比（v1 = 旧行为，v2 = 三种接收方式 + 调节层）。
 *
 * 合成三天的对话流，按真实比例混任务/纠错/夸奖/闲聊，两种模式各跑一遍，
 * 比「情绪曲线」和「被带动占多少」。这是模拟，不是真实记录——真实数据要攒几天才有。
 *
 * 运行：node test/sim-emotion-v2.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { seedAffect, applyEmotionV3 } from '../src/modules/affect.js'

const H = 3600000

/** 固定种子的伪随机，保证两次跑的是同一串事 */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const MIX = [
  { k: 'task', w: 62, pleasure: 0, eUser: 0, label: 'calm', closeness: 0.9 },
  { k: 'directive', w: 12, pleasure: -0.25, eUser: -0.2, label: 'irritated', closeness: 0.9 },
  { k: 'eval_bad', w: 8, pleasure: -0.6, eUser: -0.65, label: 'frustrated', closeness: 0.9 },
  { k: 'eval_good', w: 6, pleasure: 0.6, eUser: 0.5, label: 'joy', closeness: 0.9 },
  { k: 'chat', w: 12, pleasure: 0.05, eUser: 0.05, label: 'calm', closeness: 0.9 },
]
const TOTAL_W = MIX.reduce((a, b) => a + b.w, 0)

/** 造三天的消息流：白天每小时 2~4 条，夜里 0~1 条 */
function buildStream() {
  const r = rng(20261103)
  const out = []
  const start = Date.parse('2026-11-01T08:00:00+08:00')
  for (let day = 0; day < 3; day++) {
    for (let h = 0; h < 24; h++) {
      const hourMs = start + (day * 24 + h) * H
      const night = h < 8 || h >= 23
      const n = night ? (r() < 0.25 ? 1 : 0) : 2 + Math.floor(r() * 3)
      for (let i = 0; i < n; i++) {
        let x = r() * TOTAL_W
        let pick = MIX[0]
        for (const m of MIX) { if (x < m.w) { pick = m; break } x -= m.w }
        out.push({
          at: hourMs + Math.floor(r() * 50) * 60000,
          ...pick,
          // 情绪强度带一点噪声，别让三条曲线一模一样
          pleasure: pick.pleasure * (0.7 + r() * 0.6),
          eUser: pick.eUser * (0.7 + r() * 0.6),
        })
      }
    }
  }
  return out
}

function runMode(mode, stream) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-'))
  const db = openDb(path.join(dir, 'app.db'))
  attachDb(db)
  const aid = 'agt_sim'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '模拟', 'daily', 'active', now())
  seedAffect(db, aid)
  setParam(db, aid, 'affect.empathy.mode', { value: mode })

  /* 先垫一句，把 slow_at 定在流开始之前 */
  applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: stream[0].at - 60000 })

  const samples = []
  const modeCount = { share: 0, hold: 0, dampen: 0 }
  let sinkN = 0
  let prevSinking = false
  let empAbs = 0
  let fastAbs = 0

  for (const m of stream) {
    const r = applyEmotionV3(db, aid, {
      pleasure: m.pleasure,
      label: m.label,
      eUser: m.eUser,
      closeness: m.closeness,
      at: m.at,
      fresh: true,
      kind: m.k,
    })
    const how = String(r.empathyMode || 'share')
    if (modeCount[how] != null) modeCount[how] += 1
    if (r.sinking && !prevSinking) sinkN += 1
    prevSinking = !!r.sinking
    empAbs += Math.abs(Number(r.empathyShare) || 0)
    fastAbs += Math.abs(Number(r.fast) || 0)
    samples.push({ at: m.at, slow: r.slow, fast: r.fast, total: r.total, b: r.baseline, k: m.k, share: r.empathyShare, sinking: r.sinking })
  }

  const slows = samples.map((s) => s.slow)
  const dayMaxStep = []
  for (let d = 0; d < 3; d++) {
    const day = samples.filter((s) => new Date(s.at).toDateString() === new Date(Date.parse('2026-11-01T08:00:00+08:00') + d * 24 * H).toDateString())
    let mx = 0
    for (let i = 1; i < day.length; i++) mx = Math.max(mx, Math.abs(day[i].slow - day[i - 1].slow))
    dayMaxStep.push(+mx.toFixed(3))
  }
  const out = {
    mode,
    samples: samples.length,
    slowMean: +(slows.reduce((a, b) => a + b, 0) / slows.length).toFixed(3),
    slowMin: +Math.min(...slows).toFixed(3),
    slowMax: +Math.max(...slows).toFixed(3),
    slowRange: +(Math.max(...slows) - Math.min(...slows)).toFixed(3),
    dayMaxStep,
    empathyShare: +(empAbs / Math.max(1e-6, fastAbs)).toFixed(3),
    avgAbsShare: +(empAbs / Math.max(1, samples.length)).toFixed(3),
    avgAbsFast: +(fastAbs / Math.max(1, samples.length)).toFixed(3),
    modeCount,
    sinkN,
    finalSlow: +samples[samples.length - 1].slow.toFixed(3),
    finalTotal: +samples[samples.length - 1].total.toFixed(3),
  }
  try { db.close?.() } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  return out
}

const stream = buildStream()
const v1 = runMode('v1', stream)
const v2 = runMode('v2', stream)

console.log('消息条数:', stream.length)
console.log('--- v1（旧） ---', JSON.stringify(v1, null, 1))
console.log('--- v2（新） ---', JSON.stringify(v2, null, 1))

const pct = (a, b) => (b === 0 ? '—' : ((a - b) / Math.abs(b) * 100).toFixed(1) + '%')
console.log('\n=== 对比 ===')
console.log('slow 波动范围', v1.slowRange, '→', v2.slowRange, pct(v2.slowRange, v1.slowRange))
console.log('slow 最低点  ', v1.slowMin, '→', v2.slowMin)
console.log('每日最大单步', JSON.stringify(v1.dayMaxStep), '→', JSON.stringify(v2.dayMaxStep))
console.log('共情占比    ', v1.empathyShare, '→', v2.empathyShare, pct(v2.empathyShare, v1.empathyShare))
console.log('平均|被带动|', v1.avgAbsShare, '→', v2.avgAbsShare, pct(v2.avgAbsShare, v1.avgAbsShare))
console.log('平均|快情绪|', v1.avgAbsFast, '→', v2.avgAbsFast)
console.log('反向稳住次数', JSON.stringify(v1.modeCount), '→', JSON.stringify(v2.modeCount))
console.log('沉没触发次数', v1.sinkN, '→', v2.sinkN)
console.log('最后慢情绪  ', v1.finalSlow, '→', v2.finalSlow)
