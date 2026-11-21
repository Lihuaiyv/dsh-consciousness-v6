// 验收（2026-11-18）：v4 投影进总情绪——强/弱/过时/回退；前端拿到的 v4 字段
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { setFlag } from '../src/kernel.js'
import { valenceOf, primaryDistribution } from '../src/algo/affect_v4.js'
import { getAffect } from '../src/parts/affect/index.js'
import { attachDb } from '../src/algo/index.js'
import { seedAffect, spontaneousTick } from '../src/modules/affect.js'
import { v4ValenceOf } from '../src/modules/affect_live.js'

let passed = 0
function check(name, ok, detail) {
  if (!ok) { console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); process.exit(1) }
  passed++
  console.log('ok', name)
}
const near = (a, b, eps = 1e-3) => Math.abs(Number(a) - Number(b)) <= eps

/* 1) 投影：正负轴 = 现状好 + 有奔头 − 被惊到 */
check('安顶：约 +0.14（好但没奔头）', near(valenceOf({ s: 1, n: 0, d: 0 }), 0.14, 0.03), valenceOf({ s: 1, n: 0, d: 0 }))
check('乐顶：+0.75（最好）', near(valenceOf({ s: 1, n: 1, d: 1 }), 0.75, 0.03), valenceOf({ s: 1, n: 1, d: 1 }))
check('怡顶：封到 +1.0', near(valenceOf({ s: 1, n: 0, d: 1 }), 1.0, 0.03), valenceOf({ s: 1, n: 0, d: 1 }))
check('悲顶：约 -0.96', near(valenceOf({ s: 0, n: 0, d: 0 }), -0.96, 0.03), valenceOf({ s: 0, n: 0, d: 0 }))
check('惧顶：封到 -1.0', near(valenceOf({ s: 0, n: 1, d: 0 }), -1.0, 0.03), valenceOf({ s: 0, n: 1, d: 0 }))
check('平静中心：接近 0', Math.abs(valenceOf({ s: 0.5, n: 0.15, d: 0.5 })) < 0.03, valenceOf({ s: 0.5, n: 0.15, d: 0.5 }))
check('排序：怡/乐 是最高两档、安为正、惧最低',
  valenceOf({ s: 1, n: 0, d: 1 }) >= valenceOf({ s: 1, n: 1, d: 1 }) &&
  valenceOf({ s: 1, n: 1, d: 1 }) > valenceOf({ s: 1, n: 0, d: 0 }) &&
  valenceOf({ s: 1, n: 0, d: 0 }) > 0 &&
  valenceOf({ s: 0, n: 1, d: 0 }) < valenceOf({ s: 0, n: 1, d: 1 }) &&
  valenceOf({ s: 0, n: 1, d: 1 }) < 0)
check('投影在 -1~1 内（随机一百个点）', (() => {
  for (let i = 0; i < 100; i++) {
    const v = valenceOf({ s: Math.random(), n: Math.random(), d: Math.random() })
    if (!Number.isFinite(v) || v < -1 || v > 1) return false
  }
  return true
})())

/* 2) 总情绪合成：有 v4 用 v4，没有/过时退回旧 fast */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affect-total-'))
const db = openDb(path.join(dir, 'a.db'))
const aid = 'agt_total'
const t = new Date().toISOString()
db.prepare('INSERT INTO agents(id,name,created_at) VALUES(?,?,?)').run(aid, '小汐', t)
db.prepare('INSERT INTO affect_state(agent_id,primary_label,intensity,mood,updated_at) VALUES(?,?,?,?,?)').run(aid, 'calm', 0.5, 0.6, t)
db.prepare('INSERT INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)').run(aid, 0, 0.3, 0.5, 0.475, t, t)

let a = getAffect(db, aid)
check('没有 v4：总情绪 = 慢 + 0.35×旧快（0.475）', near(a.v3.total, 0.475), a.v3.total)
check('没有 v4：不返回 v4 字段', a.v4 === undefined, a.v4)

setFlag(db, 'affect.v4.valence', JSON.stringify({ v: 0.8, s: 0.9, n: 0.3, d: 0.8, label: '欣喜', at: new Date().toISOString(), conv: 'c' }))
a = getAffect(db, aid)
check('有 v4：总情绪 = 慢 + 0.35×投影（0.58）', near(a.v3.total, 0.58), a.v3.total)
check('有 v4：前端能拿到 v4（含三轴与词）', a.v4 && near(a.v4.v, 0.8) && near(a.v4.s, 0.9) && a.v4.label === '欣喜', a.v4)

setFlag(db, 'affect.v4.valence', JSON.stringify({ v: 0.8, s: 0.9, n: 0.3, d: 0.8, label: '欣喜', at: new Date(Date.now() - 3 * 3600000).toISOString(), conv: 'c' }))
a = getAffect(db, aid)
check('v4 过时（>2h）：退回旧 fast（0.475）', near(a.v3.total, 0.475) && a.v4 === undefined, { total: a.v3.total, v4: a.v4 })

/* 3) 两段会话同开：写 total 时只认本段的当场 */
setFlag(db, 'affect.v4.valence|c2', JSON.stringify({ v: 0.6, s: 0.8, n: 0.2, d: 0.7, label: '欣喜', at: new Date().toISOString(), conv: 'c2' }))
setFlag(db, 'affect.v4.valence', JSON.stringify({ v: -0.4, s: 0.2, n: 0.5, d: 0.3, label: '失落', at: new Date().toISOString(), conv: 'c1' }))
const v4c2 = v4ValenceOf(db, aid, { conv: 'c2' })
const v4g = v4ValenceOf(db, aid)
const v4c9 = v4ValenceOf(db, aid, { conv: 'c9' })
check('按会话读：c2 拿到自己的 0.6', v4c2 && near(v4c2.v, 0.6), v4c2)
check('不给会话号：拿到全局 0.4（-0.4）', v4g && near(v4g.v, -0.4), v4g)
check('会话没写过：退回全局', v4c9 && near(v4c9.v, -0.4), v4c9)

/* 4) 趋势样本：当场那格写 v4 投影，不再写旧 fast */
{
  attachDb(db)
  const aid2 = 'agt_sample'
  const old = new Date(Date.now() - 10 * 3600000).toISOString()
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version,last_interaction_at) VALUES(?,?,?,?,?,1,?)').run(aid2, '采样', 'daily', 'active', old, old)
  seedAffect(db, aid2)
  setFlag(db, 'affect.v4.valence', JSON.stringify({ v: 0.7, s: 0.9, n: 0.2, d: 0.8, label: '欣喜', at: new Date().toISOString(), conv: 'cA' }))
  spontaneousTick(db, aid2, Date.now(), { rnd: () => 0 })
  const sm = db.prepare('SELECT fast FROM affect_samples WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid2)
  const fj = sm ? JSON.parse(sm.fast) : null
  check('样本当场 = v4 投影 0.7（不是旧 fast）', fj && near(fj.pleasure, 0.7, 0.001), fj)
}

db.close()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
console.log(`\n${passed} 项全过`)
