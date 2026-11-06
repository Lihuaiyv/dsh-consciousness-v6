/**
 * 情绪动力 · 应用那一半的考卷。
 * 运行：node test/exam-affect-apply.test.mjs
 *
 * 守的是「一次评价怎么变成状态」这件事的边界，不守数值配方：
 *   1. 落库后的强度在界内、是有限数（NaN 传出去会一路污染到提示词）
 *   2. 正价事件把慢情绪推上去，负价把它压下来（同起点比）
 *   3. 时间在走：隔两小时再接，快情绪确实比刚才更靠近水位
 *   4. 没有情绪数据时不硬编，返回 null
 *   5. 衰减不涨；应用一次评价不碰记忆
 *
 * 注意：applyEmotionV3 有两种返回形状——走完整条路时给整包（label/intensity/v3），
 * 只走「应用 v3 那一半」时直接给 v3 本身。两种都收，卷子只认数。
 *
 * 数值配方（半衰期、余温、上涨段）不在这里钉死——钉死了每次调参都要改卷子。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { seedAffect } from '../src/modules/affect.js'
import { applyEmotionV3, decayAffect } from '../src/parts/affect/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-affect-apply-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

let seq = 0
function mkAgent() {
  const id = 'agt_ax_' + (++seq)
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(id, id, 'daily', 'active', now())
  seedAffect(db, id)
  return id
}
const v3Of = (out) => (out && out.v3) || out || {}
const stateOf = (aid) => db.prepare('SELECT primary_label, intensity, mood FROM affect_state WHERE agent_id=?').get(aid) || {}
const inRange = (x, lo, hi) => Number.isFinite(Number(x)) && Number(x) >= lo && Number(x) <= hi

// ---- 1. 界内 + 有限
{
  const aid = mkAgent()
  const out = applyEmotionV3(db, aid, { pleasure: 0.6, label: 'joy', eUser: 0.5, closeness: 0.9, at: Date.now() - 3600000 })
  check('有返回', !!out, out)
  const st = stateOf(aid)
  check('落库强度在 0~1', inRange(st.intensity, 0, 1), st)
  check('落库心情在 0~1', inRange(st.mood, 0, 1), st)
  check('标签写回了库里', !!st.primary_label, st)
  const v3 = v3Of(out)
  check('v3 三件都是有限数', ['slow', 'fast', 'total'].every((k) => Number.isFinite(Number(v3[k]))), v3)
  check('v3 的慢/快都在 -1~1', ['slow', 'fast', 'total'].every((k) => inRange(v3[k], -1, 1)), v3)
}

// ---- 2. 正价往上、负价往下（同起点比）
{
  const up = mkAgent()
  const down = mkAgent()
  const t0 = Date.now() - 3600000
  const a = applyEmotionV3(db, up, { pleasure: 0.7, label: 'joy', eUser: 0.5, closeness: 0.9, at: t0 })
  const b = applyEmotionV3(db, down, { pleasure: -0.7, label: 'irritated', eUser: 0.5, closeness: 0.9, at: t0 })
  check('正价之后慢情绪更高', Number(v3Of(a).slow) > Number(v3Of(b).slow), { up: v3Of(a).slow, down: v3Of(b).slow })
  check('正价之后快情绪更热', Number(v3Of(a).fast) > Number(v3Of(b).fast), { up: v3Of(a).fast, down: v3Of(b).fast })
}

// ---- 3. 时间在走：快情绪往水位回落
{
  const aid = mkAgent()
  const t0 = Date.now() - 3 * 3600000
  const first = applyEmotionV3(db, aid, { pleasure: 0.8, label: 'joy', eUser: 0.5, closeness: 0.9, at: t0 })
  const fast1 = Number(v3Of(first).fast)
  const later = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', eUser: 0, closeness: 0.5, at: t0 + 2 * 3600000 })
  const fast2 = Number(v3Of(later).fast)
  check('两小时后快情绪更靠近水位（热的那侧不涨）', fast2 <= fast1 + 1e-9, { fast1, fast2 })
}

// ---- 4. 没有情绪数据：返回 null，不硬编一个
{
  const ghost = 'agt_ax_ghost'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(ghost, ghost, 'daily', 'active', now())
  const out = applyEmotionV3(db, ghost, { pleasure: 0.3, label: 'joy', at: Date.now() - 60000 })
  check('没有 affect_v3 时返回 null', out === null, out)
}

// ---- 5. 衰减：24 小时后强度不涨
{
  const aid = mkAgent()
  const t0 = Date.now() - 30 * 3600000
  applyEmotionV3(db, aid, { pleasure: -0.8, label: 'irritated', eUser: 0.5, closeness: 0.9, at: t0 })
  const before = Number(stateOf(aid).intensity)
  const d = decayAffect(db, aid, 24)
  const after = Number(stateOf(aid).intensity)
  check('衰减后强度不涨', after <= before + 1e-9, { before, after })
  check('衰减返回的是有限数', inRange(d.intensity, 0, 1), d && d.intensity)
}

// ---- 6. 不碰记忆
{
  const aid = mkAgent()
  const before = db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?').get(aid).n
  applyEmotionV3(db, aid, { pleasure: 0.2, label: 'joy', at: Date.now() - 60000 })
  const after = db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?').get(aid).n
  check('应用一次评价不碰记忆', before === after, { before, after })
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
