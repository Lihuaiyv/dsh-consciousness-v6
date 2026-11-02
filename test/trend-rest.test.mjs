/**
 * 走势里的两样新东西：
 *   1. rest：十几分钟的短空档也给一条回落曲线（以前只有睡着/不在才画）；
 *   2. now：现在离水位多远、照这个速度多久回一半。
 * 运行：node test/trend-rest.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { seedAffect, affectTrend } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}
const MIN = 60000
const H = 3600000

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-trend-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_trend'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '走势', 'daily', 'active', now())
seedAffect(db, aid)

const nowMs = Date.now()
const ins = (at, s, b) => db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
  .run('afs_' + at + '_' + Math.random().toString(36).slice(2, 6), aid, new Date(at).toISOString(),
    'calm', 0.2, JSON.stringify({ pleasure: 0.1 }),
    JSON.stringify({ slow: s, fast: 0.1, baseline: b, base_off: 0, walk: 0, circ_phase: 0 }))

/* 三段断点：20 分钟（rest）、1 分钟（太短不画）、3 小时（away→sleep） */
const t0 = nowMs - 6 * H
ins(t0, 0.30, -0.10)
ins(t0 + 20 * MIN, 0.26, -0.11)
ins(t0 + 21 * MIN, 0.255, -0.11)
ins(t0 + 61 * MIN, 0.20, -0.12)
ins(t0 + 3 * H + 61 * MIN, 0.02, -0.12)

const tr = affectTrend(db, aid, 1)
check('走势带 rest 数组', Array.isArray(tr.rest))
check('20 分钟的空档被画成回落曲线', tr.rest.length >= 1 && tr.rest.some((g) => g.hours > 0.3 && g.hours < 0.5),
  { hours: tr.rest.map((g) => g.hours) })
check('1 分钟的空档不画（太短，画出来是毛）', !tr.rest.some((g) => g.hours < 0.1))
check('3 小时的空档仍然算 sleep/away，不在 rest 里', !tr.rest.some((g) => g.hours > 1))

const g = tr.rest.find((x) => x.hours > 0.6 && x.hours < 0.8) || tr.rest.find((x) => x.hours > 0.3)
check('rest 曲线从真实起点出发', g && Math.abs(g.s0 - 0.255) < 1e-9, { s0: g && g.s0, hours: g && g.hours })
check('rest 曲线落在下一个真读数上', g && Math.abs(g.s_end - Number(g.actual)) < 1e-9,
  { end: g && g.s_end, actual: g && g.actual })
check('rest 曲线是往水位方向走的', g && Math.abs(g.s_end - g.s0) > 0, { s0: g.s0, end: g.s_end })

/* now：离水位多远 + 半衰期（半衰期要按「方向 + 这一种的倍数」算，别写死一个数） */
check('走势带 now', tr.now && Number.isFinite(tr.now.dist) && Number.isFinite(tr.now.half_h), tr.now)
const last = tr.points[tr.points.length - 1]
check('now.dist = 慢情绪 − 水位', Math.abs(tr.now.dist - (last.s - last.b)) < 0.002,
  { dist: tr.now.dist, calc: +(last.s - last.b).toFixed(3) })
const distNow = last.s - last.b
const sideNow = Math.abs(distNow) < 0.01 ? 'flat' : (distNow < 0 ? 'down' : 'up')
check('side 和差的符号对得上', tr.now.side === sideNow, { side: tr.now.side, want: sideNow })
/* 标签是 calm（soft=1），所以只看方向：高位 → ×0.8 的时长，低位 → ×1.4 */
const mulNow = Math.abs(distNow) < 0.01 ? 1 : (distNow < 0 ? 1.4 : 0.8)
const halfWant = Math.log(2) / (0.205 / mulNow)
check('半衰期 = ln2 /（λ / 用时倍数）', Math.abs(tr.now.half_h - halfWant) < 0.15,
  { half: tr.now.half_h, want: +halfWant.toFixed(2) })

/* 把两个恢复倍数都关成 1：半衰期 = ln2/0.205 ≈ 3.4h，和高低无关 */
setParam(db, aid, 'affect.recover.pos', { value: 1 })
setParam(db, aid, 'affect.recover.neg', { value: 1 })
const tr2 = affectTrend(db, aid, 1)
check('关掉正负差之后半衰期约 3.4 小时', Math.abs(tr2.now.half_h - 3.38) < 0.2, { half: tr2.now.half_h })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
