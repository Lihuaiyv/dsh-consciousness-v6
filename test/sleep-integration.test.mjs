/**
 * 睡眠接线：跑一条「三天、白天聊天、夜里睡」的时间线，看宿主真的把睡眠算进去了。
 * 运行：node test/sleep-integration.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { seedAffect, applyEmotionV3, affectTrend } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const H = 3600000
const near = (a, b, eps) => Math.abs(a - b) <= eps

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sleepint-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

function mkAgent(aid, name) {
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, name, 'daily', 'active', now())
  seedAffect(db, aid)
}
function setParam(aid, key, value) {
  db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)').run(aid, key, String(value), now())
}
const v3 = (aid) => db.prepare('SELECT * FROM affect_v3 WHERE agent_id=?').get(aid)

/* 三天：每天 09:00–23:00 每 30 分钟一句「被骂」，夜里睡 */
let sampleNo = 0
function sample(aid, at) {
  const v = db.prepare('SELECT * FROM affect_v3 WHERE agent_id=?').get(aid)
  db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)').run(
    'afs_i' + (sampleNo++), aid, new Date(at).toISOString(), 'frustrated', 0.5,
    JSON.stringify({ pleasure: -0.5, arousal: 0, dominance: 0 }),
    JSON.stringify({
      mood: 0.5 + 0.5 * Number(v.total), total: v.total, slow: v.slow, fast: v.fast,
      baseline: v.baseline, base_off: v.base_off, fast_self: -0.5, fast_empathy: 0,
    }),
  )
}

function runDays(aid, startLocal) {
  let t = startLocal
  for (let day = 0; day < 3; day++) {
    for (let m = 0; m < 14 * 60; m += 30) {
      applyEmotionV3(db, aid, { pleasure: -0.5, label: 'frustrated', eUser: 0, closeness: 0.5, at: t, fresh: true })
      sample(aid, t)
      t += 30 * 60000
    }
    /* 跳到第二天早 09:00（先跨天，再拨钟，不然会回到同一天的早上） */
    const d = new Date(t)
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    t = d.getTime()
    applyEmotionV3(db, aid, { pleasure: -0.5, label: 'frustrated', eUser: 0, closeness: 0.5, at: t, fresh: true })
    sample(aid, t)
  }
  return t
}

const start = new Date(2026, 9, 30, 9, 0, 0, 0).getTime() // 10-30 09:00 本地
mkAgent('agt_on', '睡')
mkAgent('agt_off', '不睡')
setParam('agt_on', 'affect.sleep.lambda', 1.5)
setParam('agt_on', 'affect.sleep.reset', 0.06)
setParam('agt_off', 'affect.sleep.lambda', 1)
setParam('agt_off', 'affect.sleep.reset', 0)

runDays('agt_on', start)
runDays('agt_off', start)

const on = v3('agt_on')
const off = v3('agt_off')
check('两条时间线都跑完了', Number.isFinite(Number(on.slow)) && Number.isFinite(Number(off.slow)), { on: on.slow, off: off.slow })
check('开了睡眠之后落点不一样', Math.abs(Number(on.slow) - Number(off.slow)) > 0.005,
  { on: on.slow, off: off.slow })

/* 同一段夜色、同一个起点，只改参数：睡着的应该退得更狠 */
mkAgent('agt_solo', '单独')
const bedMs = new Date(2026, 9, 30, 22, 30, 0, 0).getTime()
const wakeMs = new Date(2026, 9, 31, 9, 0, 0, 0).getTime()
function nightRun(lambda, reset) {
  setParam('agt_solo', 'affect.sleep.lambda', lambda)
  setParam('agt_solo', 'affect.sleep.reset', reset)
  db.prepare('UPDATE affect_v3 SET slow=?, slow_at=?, fast=0, fast_at=NULL, base_off=0 WHERE agent_id=?')
    .run(0.4, new Date(bedMs).toISOString(), 'agt_solo')
  const out = applyEmotionV3(db, 'agt_solo', { pleasure: 0.4, label: 'joy', eUser: 0, closeness: 0.5, at: wakeMs, fresh: true })
  return out
}
const slept = nightRun(1.5, 0.06)
const stayed = nightRun(1, 0)
check('两种参数跑出不同的醒来值', Math.abs(slept.slow - stayed.slow) > 0.002, { slept: slept.slow, stayed: stayed.slow })
check('睡着的醒来后离水位更近',
  Math.abs(slept.slow - slept.baseline) < Math.abs(stayed.slow - stayed.baseline),
  { slept: slept.slow, b: slept.baseline, stayed: stayed.slow })
check('重置不会把她直接推到水位上（气过夜还在）',
  Math.abs(slept.slow - slept.baseline) > 0.002, { slept: slept.slow, b: slept.baseline })

/* 醒来那一刻：库里那两笔都得在（后面走势的曲线要用它们当端点） */
const bedAt = new Date(2026, 9, 30, 22, 30, 0, 0).toISOString()
const wakeAt = new Date(2026, 9, 31, 9, 0, 0, 0).toISOString()
function slowAt(aid, iso) {
  const row = db.prepare('SELECT slow FROM affect_samples WHERE agent_id=? AND at=?').get(aid, iso)
  if (!row) return null
  try { return JSON.parse(row.slow) } catch { return null }
}
check('睡前 / 醒来那两笔都在', !!(slowAt('agt_on', bedAt) && slowAt('agt_on', wakeAt) && slowAt('agt_off', bedAt) && slowAt('agt_off', wakeAt)))

/* 事件表里有睡眠记录 */
const evOn = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id='agt_on' AND type='affect.sleep'").get().n
const evOff = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id='agt_off' AND type='affect.sleep'").get().n
check('睡着了会写事件', evOn >= 2, { evOn })
check('关掉参数也走同一条路（事件照写）', evOff >= 2, { evOff })

/* 走势接口：sleep 段在，且推演终点贴着真实样本 */
const trend = affectTrend(db, 'agt_on', 3)
check('走势带 sleep 段', (trend.sleep || []).length >= 2, { n: trend.sleep && trend.sleep.length })
const seg = (trend.sleep || [])[0]
if (seg) {
  check('段是睡', seg.kind === 'sleep', seg.kind)
  check('曲线终点 = 真读数', near(Number(seg.s_end), Number(seg.actual), 0.002), { s_end: seg.s_end, actual: seg.actual })
  check('曲线落在区间里', seg.curve.length > 10 && seg.curve.every((p) => p.at >= Date.parse(seg.from) && p.at <= Date.parse(seg.to) + 1))
  /* 醒来的那个点，应该就是库里醒来的第一笔 */
  const wake = db.prepare("SELECT at FROM affect_samples WHERE agent_id='agt_on' AND at>=? ORDER BY at LIMIT 1").get(seg.to)
  check('醒来点和库里第一笔样本对得上', !!wake)
}

/* 关掉睡眠参数时，曲线仍然给（只是更慢回落），不能变成直线 */
const t2 = affectTrend(db, 'agt_off', 3)
check('关掉之后也照样有推演曲线', (t2.sleep || []).every((s) => s.curve.length > 0))

try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
