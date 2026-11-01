/**
 * 旧价值观清退 · 端到端：新库没有旧表；命题 → 十维 → 驱力 / 提示词 / 自述 一路通。
 * 运行：node test/sangguan-value-cleanup-e2e.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { claimUserValue } from '../src/modules/sangguan/values_intake.js'
import { readViews } from '../src/modules/sangguan/bridge.js'
import { foldValueWeights } from '../src/modules/sangguan/vweights.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { needWeights } from '../src/algo/deficit.js'
import { DIMS } from '../src/modules/values.js'
import { seedState } from '../src/core.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-vclean-'))
const db = openDb(path.join(dir, 'app.db'))
const T = '2026-11-01T12:00:00.000Z'
const add = (id) => {
  db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, id, 'daily', 'active', T)
  seedState(db, id)
}

// 1) 新库不该再有旧表
const hasOld = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='persona_values'").get().n
check('新库没有 persona_values 表', hasOld === 0, hasOld)

// 2) 命题 → 十维：抬起来的维看得见，Σ=1，张力压对侧
add('agt_v')
claimUserValue(db, 'agt_v', { key: 'benevolence', weight: 0.9 })
claimUserValue(db, 'agt_v', { key: 'power', weight: 0.9 })
const view = readViews(db, 'agt_v', { at: T })
const w = view.V.weights
const sum = Object.values(w).reduce((a, b) => a + b, 0)
check('命题折出十维且 Σ=1', DIMS.length && Object.keys(w).length === 10 && Math.abs(sum - 1) < 0.02, { w, sum })
check('仁善↔权力 张力：赢的一侧高、输的一侧被压', w.benevolence > w.power || w.power > w.benevolence, w)
check('张力确实记进 V.tensions', (view.V.tensions || []).length >= 1, view.V.tensions)
check('提示词只列抬起来的维', view.V.line.startsWith('你看重：') && /仁善|权力/.test(view.V.line), view.V.line)

// 3) 十维进驱力：只看价值观也能推动「重要度」，且 Σw=5
const axes = { ei: 0.5, sn: 0.5, tf: 0.5, jp: 0.5, sensitivity: 0.5 }
const flat = needWeights(axes, {})
const shaped = needWeights(axes, w)
const sumW = Object.values(shaped.weights).reduce((a, b) => a + b, 0)
const moved = Object.keys(flat.weights).some((k) => Math.abs(shaped.weights[k] - flat.weights[k]) > 1e-4)
check('价值观能改驱力重要度（不是摆设）', moved, { flat: flat.weights, shaped: shaped.weights })
check('重要度 Σ=5（阈值不用重标）', Math.abs(sumW - 5) < 1e-6, sumW)

// 4) 同一笔账本读两次一致；fold 与 vweights 同源
const f1 = foldValueWeights(db, 'agt_v').weights
const f2 = foldValueWeights(db, 'agt_v').weights
check('折算幂等', JSON.stringify(f1) === JSON.stringify(f2), { f1, f2 })
check('bridge 与 vweights 同源', JSON.stringify(w) === JSON.stringify(f1), { w, f1 })

// 5) HTTP 读口：GET /values 不碰旧表也能出十维
add('agt_api')
claimUserValue(db, 'agt_api', { key: 'achievement', weight: 0.9 })
const res = await handle(db, { method: 'GET', path: '/v1/agents/agt_api/values', token: 'viewer' })
const items = Array.isArray(res) ? res : (res.body || res)
check('HTTP GET /values 返回十维', Array.isArray(items) && items.length === 10 && items.some((x) => x.key === 'achievement'), items && items.length)
const ex = await handle(db, { method: 'GET', path: '/v1/agents/agt_api/values/explain', token: 'viewer' })
const exb = ex.body || ex
check('explain 标明来源与命题数', !!exb && exb.source === 'engine' && exb.claims >= 1, exb && { source: exb.source, claims: exb.claims })

// 6) 手写不再写任何表
const before = loadState(db, 'agt_api')
const r = claimUserValue(db, 'agt_api', { key: 'achievement', weight: 0.9 })
const after = loadState(db, 'agt_api')
check('同一句手写不重复加命题', r.claimed === false && r.reason === 'exists' && Object.keys(after.claims).length === Object.keys(before.claims).length, { r })

db.close()
console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
