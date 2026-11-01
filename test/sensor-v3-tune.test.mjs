/**
 * v3 传感器标定回归：分母不能用「感觉」定，必须能证明「日常数据不会一上就打满」。
 * 运行：node test/sensor-v3-tune.test.mjs
 *
 * 数据来源说明：全部是这里显式构造的 fixture（注释写清每个数字对应什么现实场景），
 * 期望值由公式直接推出，不抄任何"跑出来的结果"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { computeNeedProxies } from '../src/modules/proxies.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const near = (a, b, eps = 0.002) => Math.abs(Number(a) - Number(b)) <= eps

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-v3tune-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const HOUR = 3600000
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()

function mkAgent(id) {
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, id, 'daily', 'active', now())
  return id
}
function addTurn(aid, role, text, msAgo) {
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(`${aid}_t${Math.random().toString(36).slice(2)}`, aid, role, text, null, null, iso(msAgo))
}
function addEntities(aid, n, msAgo = 2 * 24 * HOUR) {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO entities(id,agent_id,name,kind,aliases,hits,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(`${aid}_e${i}`, aid, '实体' + i, 'thing', '[]', 0, iso(msAgo), iso(msAgo))
  }
}
function addRollback(aid, n, msAgo = 5 * HOUR) {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO changes(id,agent_id,field,before,after,applied_at,actor,source,rolled_back_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(`${aid}_c${i}`, aid, 'f', '0', '1', iso(msAgo), 'agent', 'agent', iso(msAgo))
  }
}
const V3 = (aid) => {
  const p = computeNeedProxies(db, aid)
  return p.v3 ? p.v3.detail : {}
}

// ---------- 1. continuity：按「覆盖了几个小时」，不按「说了多少句」 ----------
{
  // 现实场景：24h 内聊了 17 个小时（真实库里就是 962 轮 / 17 小时），一天还没聊满
  const aid = mkAgent('agt_cont')
  for (let h = 0; h < 17; h++) for (let k = 0; k < 57; k++) addTurn(aid, 'user', '在', (h + 0.2) * HOUR)
  const d = V3(aid)
  check('17 小时覆盖 → continuity ≈ 17/24 = 0.708（不是 1）', near(d.continuity, 17 / 24, 0.01), d.continuity)
  check('detail 里给出 hours24h', d.hours24h === 17, d.hours24h)
  check('962 轮本身不再把分数顶满', d.continuity < 0.75, d.continuity)
}

{
  // 反例：同样聊了 1000 句，但全挤在 2 个小时里 —— 连续性该低
  // 注意：按「钟点」计数会在整点边界多切一格（2 小时的跨度可能落到 3 个钟点），所以断言给到 ≤4 格。
  const aid = mkAgent('agt_burst')
  for (let k = 0; k < 1000; k++) addTurn(aid, 'user', '在', (k % 120) * 60000)
  const d = V3(aid)
  check('2 小时里 1000 句 → continuity ≤ 4/24（轮次不主导）', d.continuity <= 4 / 24 + 1e-9 && d.continuity < 0.2, { c: d.continuity, h: d.hours24h })
}

// ---------- 2. discovery：分母 315 = 45 个/天 × 7 天 ----------
{
  const aid = mkAgent('agt_disc')
  addEntities(aid, 266) // 真实库里 7 天新实体就是 266 个
  const d = V3(aid)
  check('266 个新实体 → discovery ≈ 0.844（原来 /8 早打到 1.0）', near(d.discovery, 266 / 315, 0.003), d.discovery)
  check('detail 带 new_entities 原始数', d.new_entities === 266, d.new_entities)
}
{
  const aid = mkAgent('agt_disc_max')
  addEntities(aid, 315)
  check('315 个才到 1.0', near(V3(aid).discovery, 1), V3(aid).discovery)
}

// ---------- 3. damage：÷8，4 次不该顶满 ----------
{
  const aid = mkAgent('agt_dmg')
  addRollback(aid, 4) // 真实库里 72h 回滚 4 次
  const d = V3(aid)
  check('4 次回滚 → damage = 0.5（原来 ÷3 直接 1.0）', near(d.damage, 0.5), d.damage)
  check('detail 带 damage_raw', d.damage_raw === 4, d.damage_raw)
}
{
  const aid = mkAgent('agt_dmg_max')
  addRollback(aid, 8)
  check('8 次才到 1.0', near(V3(aid).damage, 1), V3(aid).damage)
}
{
  const aid = mkAgent('agt_dmg_mix')
  addRollback(aid, 2)
  db.prepare('INSERT INTO action_log(id,agent_id,port,payload,status,created_at) VALUES(?,?,?,?,?,?)')
    .run('al1', aid, 'browse', '{}', 'failed', iso(HOUR))
  const d = V3(aid)
  check('回滚 2 + 失败动作 1 → 3/8 = 0.375', near(d.damage, 3 / 8), d.damage)
}

// ---------- 4. backlog：÷10 ----------
{
  const aid = mkAgent('agt_backlog')
  for (let i = 0; i < 5; i++) {
    db.prepare("INSERT INTO inbox_items(id,agent_id,lane,title,state,created_at) VALUES(?,?,?,?,?,?)")
      .run('in' + i, aid, 'ops', '待办', 'pending', now())
  }
  check('5 条待处理 → backlog = 0.5', near(V3(aid).backlog, 0.5), V3(aid).backlog)
}

// ---------- 5. fresh：÷24h ----------
{
  const aid = mkAgent('agt_fresh')
  addTurn(aid, 'user', '在', 24 * HOUR)
  const d = V3(aid)
  check('24h 前说过话 → fresh = e^-1 ≈ 0.368', near(d.fresh, Math.exp(-1), 0.01), d.fresh)
}
{
  const aid = mkAgent('agt_fresh_now')
  addTurn(aid, 'user', '在', 5 * 60000)
  check('5 分钟前说过 → fresh ≈ 0.996', near(V3(aid).fresh, Math.exp(-5 / 60 / 24), 0.01), V3(aid).fresh)
}

// ---------- 6. 空库不炸、不假造 ----------
{
  const aid = mkAgent('agt_empty')
  const p = computeNeedProxies(db, aid)
  check('空库也有 v3 包', !!p.v3, !!p.v3)
  const d = V3(aid)
  check('无对话 → continuity = 0（不是默认 0.5）', d.continuity === 0, d.continuity)
  check('无对话 → depth 取保守默认 0.3', near(d.depth, 0.3), d.depth)
  check('无提案 → delivery 记 0.5 且标明 proposals_n=0', d.delivery === 0.5 && d.proposals_n === 0, d)
  check('无浏览 → browseNew 记 0.5 且 browse_items=0', d.browseNew === 0.5 && d.browse_items === 0, d)
  check('无端口 → write_share = 0', d.write_share === 0, d.write_share)
}

// ---------- 7. 综合：真实量级下没有「一上来就 1.0」的新信号 ----------
{
  const aid = mkAgent('agt_realistic')
  for (let h = 0; h < 17; h++) for (let k = 0; k < 57; k++) addTurn(aid, 'user', '今天想聊点啥', (h + 0.2) * HOUR)
  addEntities(aid, 266)
  addRollback(aid, 4)
  db.prepare("INSERT INTO proposals(id,agent_id,change_class,target,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
    .run('pr1', aid, 'param', 'x', 'draft', now(), now())
  db.prepare('INSERT INTO action_ports(agent_id,name,enabled,updated_at) VALUES(?,?,?,?)').run(aid, 'look', 1, now())
  const p = computeNeedProxies(db, aid)
  const d = p.v3.detail
  const saturated = ['continuity', 'discovery', 'damage', 'backlog'].filter((k) => d[k] >= 0.999)
  check('真实量级下 continuity/discovery/damage/backlog 都不打满', saturated.length === 0, saturated.map((k) => [k, d[k]]))
  check('R 落在 0.4–0.9（可动区间）', p.v3.proxies.R > 0.4 && p.v3.proxies.R < 0.9, p.v3.proxies.R)
  check('A 不会因为只开一个只读端口就归零', p.v3.proxies.A > 0.2, p.v3.proxies.A)
  check('S 不会因为 4 次回滚就掉到底', p.v3.proxies.S > 0.5, p.v3.proxies.S)
}

console.log(`\n${pass} passed, ${fail} failed`)
db.close()
fs.rmSync(dir, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
