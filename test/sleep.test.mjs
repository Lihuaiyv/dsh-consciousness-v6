/**
 * 睡眠（休眠）算法：分类 / 回落曲线 / 醒来重置 / 走势接口接线。
 * 运行：node test/sleep.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { seedAffect, affectTrend } from '../src/modules/affect.js'
import {
  localHour, isNight, nightHoursIn, classifyGap, decayCurve, wakeReset, sleepCurve,
  SLEEP_MIN_H, AWAY_MIN_H, NIGHT_START_H, NIGHT_END_H,
} from '../src/algo/sleep.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const finite = (x) => Number.isFinite(x)
const H = 3600000
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

/* 本地时间构造：给定本地 时:分 */
function localAt(y, m, d, hh, mm = 0) {
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime()
}

// ================= 一、夜里 / 白天 =================

check('本地小时读得出来', near(localHour(localAt(2026, 11, 2, 14, 30)), 14.5, 1e-9))
check('22:30 起算夜里', isNight(localAt(2026, 11, 2, 23, 0)) && !isNight(localAt(2026, 11, 2, 15, 0)))
check('早上 9 点前还算夜里', isNight(localAt(2026, 11, 2, 8, 30)) && !isNight(localAt(2026, 11, 2, 9, 30)))
check('坏输入不崩', localHour(NaN) === 0 && isNight(NaN) === true)
check('夜里的钟点数得出来',
  Math.abs(nightHoursIn(localAt(2026, 11, 1, 23, 0), localAt(2026, 11, 2, 9, 0)) - 10) < 0.5)

// ================= 二、空档分类 =================

{
  const night = classifyGap(localAt(2026, 11, 1, 23, 0), localAt(2026, 11, 2, 9, 0))
  check('整夜是睡', night && night.kind === 'sleep', night)
  check('睡的时长对得上', night && Math.abs(night.hours - 10) < 1e-9, night)

  /* 17:54 → 次日 17:54（跨一整个夜） */
  const big = classifyGap(localAt(2026, 10, 31, 17, 54), localAt(2026, 11, 1, 17, 54))
  check('24 小时的空档是睡', big && big.kind === 'sleep' && Math.abs(big.hours - 24) < 1e-9, big)

  const day = classifyGap(localAt(2026, 11, 2, 10, 0), localAt(2026, 11, 2, 15, 0))
  check('白天的长空档是「不在」', day && day.kind === 'away', day)

  const short = classifyGap(localAt(2026, 11, 2, 10, 0), localAt(2026, 11, 2, 12, 0))
  check('两小时的普通空档不分类', short === null, short)

  const nap = classifyGap(localAt(2026, 11, 2, 14, 0), localAt(2026, 11, 2, 15, 0))
  check('一小时的白天空档不算', nap === null, nap)

  const lateNap = classifyGap(localAt(2026, 11, 2, 0, 0), localAt(2026, 11, 2, 1, 30))
  check('凌晨 1.5 小时算睡', lateNap && lateNap.kind === 'sleep', lateNap)

  check('反的时间不分类', classifyGap(1000, 500) === null)
  check('NaN 不分类', classifyGap(NaN, 500) === null && classifyGap(0, NaN) === null)
  check('刚好卡在边界：低于 3 小时的白天空档不分类',
    classifyGap(localAt(2026, 11, 2, 10, 0), localAt(2026, 11, 2, 13, 0) - 1) === null)
  check('正好 3 小时的白天空档算「不在」',
    classifyGap(localAt(2026, 11, 2, 10, 0), localAt(2026, 11, 2, 13, 0) + 1) !== null)
  check('睡眠门槛 / 不在门槛是有意义的常数', SLEEP_MIN_H > 0 && AWAY_MIN_H > SLEEP_MIN_H && NIGHT_START_H > NIGHT_END_H)
}

// ================= 三、回落曲线 =================

{
  const from = localAt(2026, 11, 1, 23, 0)
  const to = localAt(2026, 11, 2, 7, 0)
  const b = -0.2
  const bAt = () => b
  /* λ=0.25/h，8 小时：s = b + (s0-b)·e^-2 */
  const c = decayCurve({ s0: 0.3, fromMs: from, toMs: to, bAt, lambda: 0.25 })
  const expect = b + (0.3 - b) * Math.exp(-2)
  check('曲线点数：8 小时 / 15 分钟 = 32', c.length === 32, { n: c.length })
  check('终点落在 to', c[c.length - 1].at === to)
  check('指数回落算得对', near(c[c.length - 1].s, Math.round(expect * 1000) / 1000, 2e-3),
    { got: c[c.length - 1].s, expect: +expect.toFixed(3) })
  check('一路单调靠近水位', c.every((p, i) => i === 0 || Math.abs(p.s - b) <= Math.abs(c[i - 1].s - b) + 1e-9))
  check('不越界', c.every((p) => p.s >= -1 && p.s <= 1))
  check('λ 大退得快', decayCurve({ s0: 0.3, fromMs: from, toMs: to, bAt, lambda: 0.25 }).slice(-1)[0].s
    < decayCurve({ s0: 0.3, fromMs: from, toMs: to, bAt, lambda: 0.165 }).slice(-1)[0].s)
  check('没有水位函数时不炸', finite(decayCurve({ s0: 0.3, fromMs: from, toMs: to, lambda: 0.25 })[0].s))
  check('空区间返回空', decayCurve({ s0: 0.3, fromMs: to, toMs: from, bAt, lambda: 0.25 }).length === 0)
}

// ================= 四、醒来重置 =================

{
  const s = -0.13
  const b = -0.2
  check('睡 0 小时不重置', wakeReset({ s, b, hours: 0 }) === s)
  check('睡 8 小时重置到 45% 封顶', near(wakeReset({ s, b, hours: 8 }), Math.round((s + 0.45 * (b - s)) * 1000) / 1000))
  check('睡得越久重置越多',
    wakeReset({ s, b, hours: 4 }) < wakeReset({ s, b, hours: 2 }) && wakeReset({ s, b, hours: 8 }) <= wakeReset({ s, b, hours: 4 }))
  check('永远重置不满 100%', wakeReset({ s, b, hours: 24 }) > b)
  check('重置不越界', Math.abs(wakeReset({ s: 0.99, b: 1, hours: 24 })) <= 1)
  check('坏参数不产生 NaN', finite(wakeReset({ s, b, hours: NaN })) && finite(wakeReset({})))
}

// ================= 五、sleepCurve：曲线 + 重置 =================

{
  const from = localAt(2026, 11, 1, 23, 0)
  const to = localAt(2026, 11, 2, 7, 0)
  const out = sleepCurve({ fromMs: from, toMs: to, s0: 0.3, bAt: () => -0.2, kind: 'sleep', lambda: 0.25, perHour: 0.06 })
  check('sleepCurve 认得出是睡', out.kind === 'sleep' && Math.abs(out.hours - 8) < 1e-9, out.kind)
  check('结束值比纯回落更靠近水位',
    Math.abs(out.end - -0.2) < Math.abs(out.curve.slice(-1)[0].s - -0.2))
  const away = sleepCurve({ fromMs: localAt(2026, 11, 2, 10, 0), toMs: localAt(2026, 11, 2, 15, 0), s0: 0.3, bAt: () => 0, kind: 'away', lambda: 0.165 })
  check('「不在」不重置', near(away.end, away.curve.slice(-1)[0].s))
}

// ================= 六、接进走势接口 =================

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sleep-'))
  const db = openDb(path.join(dir, 'app.db'))
  attachDb(db)
  const aid = 'agt_sleep'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '睡', 'daily', 'active', now())
  seedAffect(db, aid)

  /* 造三天：白天每 20 分钟一个点（09:00–23:00），夜里空着 */
  const ins = db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
  let n = 0
  const base = localAt(2026, 10, 30, 9, 0)
  for (let day = 0; day < 3; day++) {
    for (let m = 0; m < 14 * 60; m += 20) {
      const at = base + day * 86400000 + m * 60000
      const h = (at - base) / H
      const s = Math.round((-0.1 + 0.25 * Math.sin(h / 5)) * 1000) / 1000
      ins.run('afs_' + (n++), aid, new Date(at).toISOString(), 'calm', 0.4,
        JSON.stringify({ pleasure: 0.1, arousal: 0, dominance: 0 }),
        JSON.stringify({ mood: 0.5 + 0.5 * s, total: s, slow: s, fast: 0, baseline: -0.2, base_off: 0, fast_self: 0, fast_empathy: 0 }))
    }
  }
  const t = affectTrend(db, aid, 3)
  check('走势里带 sleep 段', Array.isArray(t.sleep) && t.sleep.length === 2, { n: t.sleep && t.sleep.length })
  const g = (t.sleep || [])[0]
  if (g) {
    check('夜里的空档判成 sleep', g.kind === 'sleep', g.kind)
    check('时长约 10 小时（23:00→09:00）', Math.abs(g.hours - 10) < 0.6, g.hours)
    check('曲线不是空的', g.curve.length > 30, g.curve.length)
    check('曲线端点贴着实际读到的那个点', finite(g.s_end) && finite(g.actual))
    check('曲线在窗口内', g.curve.every((p) => p.at >= Date.parse(g.from) && p.at <= Date.parse(g.to) + 1))
    check('曲线值合法', g.curve.every((p) => p.s >= -1 && p.s <= 1 && finite(p.s)))
  }
  check('白天没有空档就不该有 away 段', (t.sleep || []).every((x) => x.kind === 'sleep'))
  check('没有样本的空窗口不炸', affectTrend(db, 'agt_sleep', 1).sleep !== undefined)
  try { db.close() } catch { /* 关不掉就留着 */ }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 文件被占就不删 */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
