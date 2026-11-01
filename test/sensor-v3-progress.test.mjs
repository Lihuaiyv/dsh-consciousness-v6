/**
 * 进步验证（不是重复上一次的测试）：问的是「信号到底有没有判别力」。
 *
 * 判据：同一个信号，在不同真实处境下必须给出**不同**的数；旧公式在这些处境里全是 1.0，等于没测。
 * 测试里的场景是构造的（每天 0 / 3 / 17 / 24 个小时这类），但期望值全部由公式直接推出，
 * 没有任何一行是从"跑出来的结果"抄回去的。
 *
 * 运行：node test/sensor-v3-progress.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { computeNeedProxies } from '../src/modules/proxies.js'

let pass = 0, fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
const HOUR = 3600000
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-v3prog-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

function mkAgent(id) {
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, id, 'daily', 'active', now())
  return id
}
function addTurns(aid, n, hours) {
  for (let i = 0; i < n; i++) {
    const h = hours ? i % hours : 0
    db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(`${aid}_${i}`, aid, 'user', '今天聊聊这个吧', null, null, iso((h + 0.3) * HOUR))
  }
}
function addEntities(aid, n) {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO entities(id,agent_id,name,kind,aliases,hits,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(`${aid}_e${i}`, aid, 'x' + i, 'thing', '[]', 0, iso(2 * 24 * HOUR), iso(2 * 24 * HOUR))
  }
}
function addRollbacks(aid, n) {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO changes(id,agent_id,field,before,after,applied_at,actor,source,rolled_back_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(`${aid}_c${i}`, aid, 'f', '0', '1', iso(3 * HOUR), 'agent', 'agent', iso(3 * HOUR))
  }
}
const V3 = (aid) => computeNeedProxies(db, aid).v3

// ---------- 1. continuity 有没有判别力：空 / 安静 / 正常 /  marathon ----------
{
  const scen = [
    ['空', mkAgent('p_empty'), 0, 0],
    ['安静的一天（3 小时）', mkAgent('p_quiet'), 40, 3],
    ['正常的一天（17 小时）', mkAgent('p_normal'), 960, 17],
    ['拉满的一天（24 小时）', mkAgent('p_full'), 2000, 24],
  ]
  const got = {}
  for (const [label, aid, n, h] of scen) {
    addTurns(aid, n, h)
    got[label] = V3(aid).detail.continuity
  }
  const vals = Object.values(got)
  check('continuity：四档处境给出四个不同的数', new Set(vals.map((v) => v.toFixed(3))).size === 4, got)
  check('continuity：安静的一天明显低于正常的一天', got['正常的一天（17 小时）'] - got['安静的一天（3 小时）'] > 0.3, got)
  check('continuity：正常的一天 < 0.8（没有一上来就打满）', got['正常的一天（17 小时）'] < 0.8, got)
  check('continuity：真的聊满 24 小时才到 1.0', got['拉满的一天（24 小时）'] === 1, got)
  check('continuity：空的一天就是 0', got['空'] === 0, got)

  // 旧公式对照（轮数/20）：除"空"以外全被顶到 1.0 —— 这就是原来"没判别力"的证据
  const old = { '空': 0, '安静的一天（3 小时）': clamp01(40 / 20), '正常的一天（17 小时）': clamp01(960 / 20), '拉满的一天（24 小时）': clamp01(2000 / 20) }
  check('旧公式（轮数/20）在安静/正常两档都是 1.0', old['安静的一天（3 小时）'] === 1 && old['正常的一天（17 小时）'] === 1, old)
  check('新公式把这两档分开了（差 > 0.3）', got['正常的一天（17 小时）'] - got['安静的一天（3 小时）'] > 0.3, { 旧: old, 新: got })
}

// ---------- 2. discovery：单调 + 不打满 ----------
{
  const cases = [0, 40, 160, 280, 315]
  const vals = cases.map((n) => {
    const aid = mkAgent('p_ent' + n)
    addEntities(aid, n)
    return { n, d: V3(aid).detail.discovery }
  })
  const strict = vals.every((x, i) => i === 0 || x.d > vals[i - 1].d)
  check('discovery：实体越多分越高（严格单调）', strict, vals)
  check('discovery：280 个（今天的真实量级）仍是 0.889，没打满', Math.abs(vals[3].d - 280 / 315) < 0.002, vals[3])
  const oldVals = cases.map((n) => clamp01(n / 8))
  check('旧公式（/8）：40 个就 1.0', oldVals[1] === 1, oldVals)
}

// ---------- 3. damage：越拆越不安全，但 4 次不封顶 ----------
{
  const vals = [0, 2, 4, 6, 8].map((n) => {
    const aid = mkAgent('p_dmg' + n)
    addRollbacks(aid, n)
    return { n, d: V3(aid).detail.damage }
  })
  check('damage：回滚越多分越高（严格单调）', vals.every((x, i) => i === 0 || x.d > vals[i - 1].d), vals)
  check('damage：4 次 = 0.5（旧公式这里已经 1.0）', Math.abs(vals[2].d - 0.5) < 1e-9, vals[2])
  check('damage：8 次才到顶', vals[4].d === 1, vals[4])
}

// ---------- 4. 端到端：同样"今天很热闹"，有没有弄坏东西，S 要分开 ----------
{
  const good = mkAgent('p_safe')
  addTurns(good, 960, 17)
  addEntities(good, 280)
  const bad = mkAgent('p_hurt')
  addTurns(bad, 960, 17)
  addEntities(bad, 280)
  addRollbacks(bad, 4)
  const sGood = V3(good).proxies.S
  const sBad = V3(bad).proxies.S
  check('S：同样热闹，弄坏 4 次的明显更低', sGood - sBad > 0.08, { 干净: sGood, 弄坏: sBad })
  check('S：干净的一天能接近 1（没出事就是没出事）', sGood > 0.9, sGood)
  check('S：弄坏 4 次也不会直接掉到 1−0.2（其余项照算）', sBad > 0.5, sBad)
}

// ---------- 5. 中性的话不再被当成负面 ----------
{
  const aid = mkAgent('p_neutral')
  for (let i = 0; i < 20; i++) {
    db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at) VALUES(?,?,?,?,?,?,?)')
      .run('nt' + i, aid, 'user', '这个嘛……嗯，看一下', null, null, iso(60000))
  }
  const d = V3(aid).detail
  check('中性 20 句 → pos_centered = 0.5', Math.abs(d.pos_centered - 0.5) < 1e-9, d.pos_centered)
  const p = computeNeedProxies(db, aid)
  check('中性 20 句的 R 不低于 0.4（旧版会被打到 0.28）', p.v3.proxies.R >= 0.4, p.v3.proxies.R)
}

// ---------- 6. 全部五个维度都还在合法区间 ----------
{
  const aid = mkAgent('p_range')
  addTurns(aid, 500, 10)
  addEntities(aid, 120)
  addRollbacks(aid, 3)
  const p = V3(aid).proxies
  const inRange = Object.entries(p).every(([, v]) => Number.isFinite(v) && v >= 0 && v <= 1)
  check('五个维度都在 0..1 且是有限数', inRange, p)
  const detailKeys = ['continuity', 'discovery', 'damage', 'backlog', 'fresh', 'depth', 'pos_centered']
  const missing = detailKeys.filter((k) => !(k in V3(aid).detail))
  check('诊断字段齐全（能复盘每个数从哪来）', missing.length === 0, missing)
}

console.log(`\n${pass} passed, ${fail} failed`)
db.close()
fs.rmSync(dir, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
