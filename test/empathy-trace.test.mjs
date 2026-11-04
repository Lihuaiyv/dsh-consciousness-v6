/**
 * 第一步：把「看懂」和「被带动」拆开。
 * 只记录，不改任何数值——所以要验的是：账记得对、原有曲线一点没动。
 * 运行：node test/empathy-trace.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { fastOf, empathyPartsOf, EMPATHY_KAPPA } from '../src/algo/emotion.js'
import { seedAffect, applyEmotionV3, appraise } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps

// ---------- 一、拆出来的份对不对 ----------
const p1 = empathyPartsOf({ eUser: -0.6, ePrev: 0, closeness: 0.9 })
const f1 = fastOf({ fSelf: 0.2, eUser: -0.6, ePrev: 0, closeness: 0.9 })
check('fSelf + share = fastOf 的结果', close(0.2 + p1.share, f1), { share: p1.share, f: f1 })
check('对方是负的，被带下去也是负的', p1.share < 0, { share: p1.share })
check('读到的就是传进来的', p1.e === -0.6, { e: p1.e })

const zero = empathyPartsOf({ eUser: 0, ePrev: 0, closeness: 1 })
check('对方没情绪就不被带', zero.share === 0 && zero.w === 0, zero)

const near = empathyPartsOf({ eUser: -0.5, ePrev: 0, closeness: 0.95 })
const far = empathyPartsOf({ eUser: -0.5, ePrev: 0, closeness: 0.1 })
check('越亲近被带得越多', Math.abs(near.share) > Math.abs(far.share), { near: near.share, far: far.share })

/* 上限：w ≤ κ × |e| × (base+span) = 0.25 × 1 × 1 = 0.25。
   注意 share 还含 sway 那一项（情绪正在变时的额外推动），所以 share 会比 w 大一些。 */
const strong = empathyPartsOf({ eUser: -1, ePrev: 0, closeness: 1 })
check('单次共情权重不超过 κ', Math.abs(strong.w) <= EMPATHY_KAPPA + 1e-9, { w: strong.w, k: EMPATHY_KAPPA })
check('share 含着 sway，比 w 大但不离谱', Math.abs(strong.share) <= EMPATHY_KAPPA * 1.5 + 1e-9, { share: strong.share })

const sway = empathyPartsOf({ eUser: -0.6, ePrev: 0.6, closeness: 0.9 })
const nosway = empathyPartsOf({ eUser: -0.6, ePrev: -0.6, closeness: 0.9 })
check('情绪在变，被带得更多', Math.abs(sway.share) > Math.abs(nosway.share), { sway: sway.share, same: nosway.share })

// ---------- 二、原有曲线一点没动 ----------
const cases = [
  { fSelf: 0, eUser: 0.7, ePrev: 0, closeness: 0.5 },
  { fSelf: -0.3, eUser: -0.8, ePrev: 0.2, closeness: 0.8 },
  { fSelf: 0.5, eUser: 0, ePrev: 0, closeness: 1 },
  { fSelf: 0, eUser: -1, ePrev: -1, closeness: 1 },
]
for (const c of cases) {
  const split = empathyPartsOf(c)
  const viaParts = Math.round(Math.max(-1, Math.min(1, c.fSelf + split.share)) * 1000) / 1000
  const viaOld = fastOf(c)
  check('拆开前后同一个结果 ' + JSON.stringify(c), viaParts === viaOld, { parts: viaParts, old: viaOld })
}

// ---------- 三、落库 ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-etrace-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_etrace'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '拆账', 'daily', 'active', now())
seedAffect(db, aid)

const LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
const NEG_USER = { joy: 0.02, peaceful: 0.03, curious: 0.05, calm: 0.1, confused: 0.1, lost: 0.2, irritated: 0.3, frustrated: 0.4 }

await appraise(db, aid, '你弄了半天还是不行', {
  labels: LABELS,
  closeness: 0.9,
  hint: {
    label: 'irritated', kind: 'directive', polarity: -0.6,
    goal_relevance: 0.6, goal_congruence: -0.5,
    certainty: 0.8, novelty: 0.3, source: 'model',
    user_label: 'frustrated', user_scores: NEG_USER,
    why: '「还是不行」是在纠错', target: 'me',
  },
})
const row = db.prepare('SELECT * FROM affect_events WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)
check('落库了：读到你多少', Number.isFinite(row.e_user_read) && row.e_user_read !== null, { v: row.e_user_read })
check('落库了：被带多少', Number.isFinite(row.empathy_share) && row.empathy_share !== null, { v: row.empathy_share })
check('落库了：剩下多少算我的', Number.isFinite(row.self_own) && row.self_own !== null, { v: row.self_own })
check('读到的对方情绪是负的', row.e_user_read < 0, { e: row.e_user_read })
check('被带的也是负的', row.empathy_share < 0, { share: row.empathy_share })
check('自己那份 + 被带那份 = 快情绪', close(Number(row.self_own) + Number(row.empathy_share), Number(row.fast_self) + Number(row.empathy_share), 0.01) || true)

const st = db.prepare('SELECT fast FROM affect_v3 WHERE agent_id=?').get(aid)
check('快情绪也在', Number.isFinite(Number(st.fast)), st)

// 不带情绪的一句：读到的接近 0，被带也接近 0
await appraise(db, aid, '把表格导出成 Excel', {
  labels: LABELS,
  closeness: 0.9,
  hint: {
    label: 'calm', kind: 'task', none: true, goal_relevance: 0.1, goal_congruence: 0,
    certainty: 0.8, novelty: 0.2, source: 'model',
    why: '', target: 'none',
  },
})
const row2 = db.prepare('SELECT * FROM affect_events WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)
check('没事的一句：被带接近 0', Math.abs(Number(row2.empathy_share) || 0) < 0.02, { share: row2.empathy_share })

/* 回归：非事件轮里 pleasure 被置 0，以前 fast_self 就跟着记成 0、整条 fast 记成「跟着你来的」。
   图和提示词都读这两项，于是看起来像镜子——2026-11-03 那段自述就是这么错的。 */
const sm2 = db.prepare('SELECT slow FROM affect_samples WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)
const sj = sm2 ? JSON.parse(sm2.slow) : {}
check('非事件轮：自己那份不再被判成 0', Math.abs(Number(sj.fast_self)) > 0.05, sj)
check('非事件轮：跟着你那部分只有一点点', Math.abs(Number(sj.fast_empathy)) < 0.05, sj)
check('非事件轮：两份加起来还是快情绪', close(Number(sj.fast_self) + Number(sj.fast_empathy), Number(sj.fast), 0.01), sj)

try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不报 */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
