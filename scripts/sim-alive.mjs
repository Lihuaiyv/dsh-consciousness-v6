/**
 * 「活起来」四件事的模拟对比：随机游走 / 相位被改写 / 快慢耦合 / 自发扰动。
 *
 * 跑两条一模一样的 14 天时间线：一条把四个参数都关掉（旧行为），一条用默认值。
 * 只比数据，不调模型。
 *
 * 运行：node scripts/sim-alive.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { seedAffect, applyEmotionV3, spontaneousTick } from '../src/modules/affect.js'

const H = 3600000
const DAY = 24 * H

/* 一条固定的 14 天时间线：日常说几句、第 3~4 天熬夜、第 8~10 天没人理 */
function timeline() {
  const day0 = Date.parse('2026-10-20T08:00:00.000Z')
  const turns = []
  for (let d = 0; d < 14; d++) {
    if (d >= 7 && d <= 9) continue // 三天没人理
    for (const [h, p] of [[9.5, 0.2], [13, -0.1], [20, 0.3], [22.5, -0.2]]) {
      turns.push({ at: day0 + d * DAY + h * H, pleasure: p })
    }
  }
  /* 熬夜：凌晨一点半还在说话 */
  for (const d of [3, 4]) {
    turns.push({ at: day0 + d * DAY + 1.5 * H, pleasure: 0.1 })
    turns.push({ at: day0 + d * DAY + 3 * H, pleasure: -0.3 })
  }
  turns.sort((a, b) => a.at - b.at)
  return { day0, turns }
}

function run(kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-alive-' + kind + '-'))
  const db = openDb(path.join(dir, 'app.db'))
  attachDb(db)
  const aid = 'agt_' + kind
  const { day0, turns } = timeline()
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, kind, 'daily', 'active', new Date(day0).toISOString())
  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(day0).toISOString(), aid)
  seedAffect(db, aid)
  const off = kind === 'off'
  setParam(db, aid, 'affect.walk.sd', { value: off ? 0 : 0.03 })
  setParam(db, aid, 'affect.circ.nightShift', { value: off ? 0 : 12 })
  setParam(db, aid, 'affect.couple.gain', { value: off ? 0 : 0.5 })
  setParam(db, aid, 'affect.spont.rate', { value: off ? 0 : 0.6 })

  const end = day0 + 14 * DAY
  const tick = 5 * 60e3
  let i = 0
  const walks = []
  const ratios = []
  const phases = []
  let spont = 0
  for (let t = day0; t < end; t += tick) {
    while (i < turns.length && turns[i].at <= t) {
      const tu = turns[i++]
      db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(tu.at).toISOString(), aid)
      const r = applyEmotionV3(db, aid, { pleasure: tu.pleasure, label: 'calm', eUser: 0, closeness: 0.5, at: tu.at })
      if (r) {
        walks.push(r.walk)
        phases.push(r.circPhase)
        if (Math.abs(tu.pleasure) > 0.05) ratios.push({ b: r.baseline, ratio: r.fast / tu.pleasure })
      }
    }
    const s = spontaneousTick(db, aid, t, { rnd: Math.random })
    if (s) spont++
  }
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get()
  const ev = rows
    ? db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='affect.spontaneous'").get(aid).n
    : 0
  const wAbs = walks.map((x) => Math.abs(Number(x) || 0))
  const lo = ratios.filter((r) => r.b < -0.05)
  const hi = ratios.filter((r) => r.b > 0.05)
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
  return {
    walkMean: avg(wAbs),
    walkMax: Math.max(...wAbs, 0),
    walkDistinct: new Set(walks.map((x) => Number(x).toFixed(4))).size,
    phaseMax: Math.max(...phases, 0),
    phaseEnd: phases.length ? phases[phases.length - 1] : 0,
    lowRatio: avg(lo.map((r) => r.ratio)),
    highRatio: avg(hi.map((r) => r.ratio)),
    lowN: lo.length,
    highN: hi.length,
    spont,
    spontEvents: ev,
  }
}

const off = run('off')
const on = run('on')
const f = (x, n = 3) => (Number.isFinite(x) ? Number(x).toFixed(n) : '—')

console.log('14 天同一条时间线（每天几句 + 两天熬夜 + 三天没人理）\n')
console.log('指标                        旧（四个都关）   新（默认参数）')
console.log(`水位被随机拖走的|平均|      ${f(off.walkMean)}            ${f(on.walkMean)}`)
console.log(`水位被随机拖走的|最大|      ${f(off.walkMax)}            ${f(on.walkMax)}`)
console.log(`走过多少个不同的水位偏移    ${off.walkDistinct}               ${on.walkDistinct}`)
console.log(`日节律相位最大偏移（分钟）  ${f(off.phaseMax, 1)}           ${f(on.phaseMax, 1)}`)
console.log(`收尾时剩下的相位（分钟）    ${f(off.phaseEnd, 1)}            ${f(on.phaseEnd, 1)}`)
console.log(`水位低时的反应倍数          ${f(off.lowRatio)}            ${f(on.lowRatio)}   (n=${on.lowN})`)
console.log(`水位高时的反应倍数          ${f(off.highRatio)}            ${f(on.highRatio)}   (n=${on.highN})`)
console.log(`三天没人理时自己冒出来的    ${off.spont} 次             ${on.spont} 次`)
console.log(`留下的 affect.spontaneous   ${off.spontEvents} 条             ${on.spontEvents} 条`)
