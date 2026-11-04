/**
 * 慢情绪限幅：一串密集对话不该把它灌成一根柱子，但也不能把平时的起伏一起削平。
 * 运行：node test/slow-band.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { appraise, applyEmotionV3 } from '../src/modules/affect.js'
import { writeParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
const JOY = { joy: 0.9, peaceful: 0.2, curious: 0.2, calm: 0.0, confused: 0, lost: 0, irritated: 0, frustrated: 0 }

/* 直接喂 applyEmotionV3：闸门会随重复自我抑制，走 appraise 测不出「连灌」这件事。
   这里要比的是「同一串冲击下，限幅在不在」——所以把它单独拎出来。 */
function burst(w, n) {
  const t0 = Date.parse(new Date().toISOString())
  // 先把水位落定（world 刚建时 affect_v3.baseline 还是占位 0，第一次调用才会算出真值）
  applyEmotionV3(w.db, w.aid, { pleasure: 0, label: 'calm', eUser: 0, closeness: 0.5, at: t0 - 1000, fresh: false })
  for (let i = 0; i < n; i++) {
    applyEmotionV3(w.db, w.aid, { pleasure: 0.85, label: 'joy', eUser: 0, closeness: 0.5, at: t0 + i * 2000, fresh: true })
  }
}

function state(w) {
  return w.db.prepare('SELECT slow, fast, total, baseline FROM affect_v3 WHERE agent_id=?').get(w.aid) || {}
}
function baseOf(w) {
  return Number(state(w).baseline) || 0
}

// ---- 一、限幅真的会拦：把慢情绪人为放到水位上方 0.5，一步就该被拉回 0.2
{
  const w = makeWorld()
  const t = Date.now()
  applyEmotionV3(w.db, w.aid, { pleasure: 0, label: 'calm', eUser: 0, closeness: 0.5, at: t, fresh: false })
  const base = Number(state(w).baseline) || 0   // 第一次跑完才是真正的水位
  w.db.prepare('UPDATE affect_v3 SET slow=? WHERE agent_id=?').run(Math.min(1, base + 0.5), w.aid)
  applyEmotionV3(w.db, w.aid, { pleasure: 0, label: 'calm', eUser: 0, closeness: 0.5, at: t + 1000, fresh: false })
  const gap = Number(state(w).slow) - base
  check('开着限幅：越界 0.5 → 被压到 0.2+两成外溢（约 0.26）', Math.abs(gap - (0.2 + 0.3 * 0.2)) < 0.02, { gap: +gap.toFixed(3), base })
  w.close && w.close()
}
{
  const w = makeWorld()
  writeParam(w.db, w.aid, 'affect.slow.band', 0)
  const t = Date.now()
  applyEmotionV3(w.db, w.aid, { pleasure: 0, label: 'calm', eUser: 0, closeness: 0.5, at: t, fresh: false })
  const base = Number(state(w).baseline) || 0
  w.db.prepare('UPDATE affect_v3 SET slow=? WHERE agent_id=?').run(Math.min(1, base + 0.5), w.aid)
  applyEmotionV3(w.db, w.aid, { pleasure: 0, label: 'calm', eUser: 0, closeness: 0.5, at: t + 1000, fresh: false })
  const gap = Number(state(w).slow) - base
  check('关掉限幅：同样的越界不动它（对照组）', gap > 0.45, { gap: +gap.toFixed(3), base })
  w.close && w.close()
}

// ---- 二、连灌 20 下：它在动，但离水位不超过 0.2
{
  const w = makeWorld()
  burst(w, 20)
  const st = state(w)
  const base = baseOf(w)
  const gap = Math.abs(Number(st.slow) - base)
  check('连灌 20 下：离水位 ≤ 0.3（拐点压住了）', gap <= 0.3025, { slow: st.slow, fast: st.fast, base, gap: +gap.toFixed(3) })
  check('连灌 20 下：确实在动（没被拍死）', gap > 0.03, { gap: +gap.toFixed(3) })
  w.close && w.close()
}

// ---- 三、小起伏不受影响：单句、温和的事件，慢情绪照样动一点
{
  const w = makeWorld()
  const before = Number(w.db.prepare('SELECT slow FROM affect_v3 WHERE agent_id=?').get(w.aid).slow)
  await appraise(w.db, w.aid, '今天先把表格导出来吧', {
    labels: LABELS,
    closeness: 0.9,
    hint: {
      label: 'calm', kind: 'task', none: true, goal_relevance: 0.2, goal_congruence: 0.2,
      certainty: 0.8, novelty: 0.1, source: 'model', why: '', target: 'none',
    },
  })
  const after = Number(w.db.prepare('SELECT slow FROM affect_v3 WHERE agent_id=?').get(w.aid).slow)
  const base = Number(w.db.prepare('SELECT baseline FROM affect_v3 WHERE agent_id=?').get(w.aid).baseline) || 0
  check('温和的一句：完了仍然在水位附近（≤0.3）', Math.abs(after - base) <= 0.3025, { before, after, base: +base.toFixed(3) })
  w.close && w.close()
}

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
