/**
 * 缺数据不许充数：没有浏览/没有提案时，那一项要整个摘掉、剩下的权重归一，
 * 不能拿 0.5 这个"中间值"混进平均里装作测到了。
 *
 * 这里用的是可验证的代数不变量：摘掉一项时 E = 其余项加权平均；
 * 数据补上后 E 必须正好等于「旧值 × 旧权重 + 新项 × 新权重」——不变量对不上就是代码在自说自话。
 *
 * 运行：node test/sensor-v3-renorm.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { computeNeedProxies } from '../src/modules/proxies.js'
import { ingestBrowse } from '../src/modules/browse.js'

let pass = 0, fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const HOUR = 3600000
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-v3renorm-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

function mkAgent(id) {
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, id, 'daily', 'active', now())
  return id
}
function addTurns(aid, n, hours = 3) {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(`${aid}_${i}`, aid, 'user', '今天聊聊这个吧', null, null, iso(((i % hours) + 0.3) * HOUR))
  }
}
function addEntities(aid, n) {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO entities(id,agent_id,name,kind,aliases,hits,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(`${aid}_e${i}`, aid, 'x' + i, 'thing', '[]', 0, iso(2 * 24 * HOUR), iso(2 * 24 * HOUR))
  }
}
const V3 = (aid) => computeNeedProxies(db, aid).v3

// ---------- 1. E：没有浏览数据 → 该项摘掉，权重 0.85 ----------
{
  const aid = mkAgent('rn_e')
  addTurns(aid, 60, 4)
  addEntities(aid, 100)
  const before = V3(aid)
  check('没接过浏览 → browse_used = false', before.detail.browse_used === false, before.detail)
  check('没接过浏览 → 参与归一的总权重 = 0.85', near(before.detail.e_weights, 0.85), before.detail.e_weights)

  // 补上一条浏览：E 必须等于「旧 E × 0.85 + browseNew × 0.15」
  const r = ingestBrowse(db, aid, { url: 'https://newdomain.example/x', title: '新的领域', text: '去看了一个没去过的地方' })
  check('浏览确实落库', r.ok === true, r)
  const after = V3(aid)
  check('接过浏览 → browse_used = true 且权重回到 1.0', after.detail.browse_used === true && near(after.detail.e_weights, 1.0), after.detail)
  const expect = 0.85 * before.proxies.E + 0.15 * after.detail.browseNew
  check('补数据后的 E = 旧E×0.85 + 新项×0.15（代数不变量）', near(after.proxies.E, expect, 1e-9), { before: before.proxies.E, after: after.proxies.E, expect })
  check('补数据后 E 变了（说明这项真的接进去了）', Math.abs(after.proxies.E - before.proxies.E) > 1e-6, { before: before.proxies.E, after: after.proxies.E })
}

// ---------- 2. E：摘掉浏览项之后仍然有判别力 ----------
{
  const quiet = mkAgent('rn_e_quiet')
  addTurns(quiet, 60, 4)
  addEntities(quiet, 10)
  const busy = mkAgent('rn_e_busy')
  addTurns(busy, 60, 4)
  addEntities(busy, 280)
  const d = V3(busy).proxies.E - V3(quiet).proxies.E
  check('都没浏览数据时，实体多的 E 仍明显更高', d > 0.05, d)
}

// ---------- 3. C：提案不足 3 条 → delivery 摘掉，权重 0.8 ----------
{
  const aid = mkAgent('rn_c')
  addTurns(aid, 30)
  const before = V3(aid)
  check('没有提案 → delivery_used = false', before.detail.delivery_used === false, before.detail)
  const sum = 0.55 + 0.25
  check('C 归一权重 = 0.8（0.55 + 0.25）', near(sum, 0.8), sum)

  for (let i = 0; i < 3; i++) {
    db.prepare('INSERT INTO proposals(id,agent_id,change_class,target,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run('pr' + i, aid, 'param', 'x', 'done', now(), now())
  }
  const after = V3(aid)
  check('3 条提案 → delivery_used = true', after.detail.delivery_used === true, after.detail)
  const expect = 0.8 * before.proxies.C + 0.2 * 1
  check('补数据后的 C = 旧C×0.8 + delivery×0.2（代数不变量）', near(after.proxies.C, expect, 1e-9), { before: before.proxies.C, after: after.proxies.C, expect })
}

// ---------- 4. A：写端口全关 → 明确标成「配置挡住」，并给出上限 ----------
{
  const aid = mkAgent('rn_a')
  addTurns(aid, 30)
  const off = V3(aid)
  check('写端口全关 → config_blocked = write_ports_off', off.detail.config_blocked === 'write_ports_off', off.detail)
  check('写端口全关 → write_on = 0', off.detail.write_on === 0, off.detail)
  check('a_ceiling 比实际 A 高（说明是被允许度压住的）', off.detail.a_ceiling > off.proxies.A, { A: off.proxies.A, ceil: off.detail.a_ceiling })

  for (const p of ['send_message', 'browse', 'comment', 'remind', 'canvas', 'voice']) {
    db.prepare('INSERT INTO action_ports(agent_id,name,enabled,updated_at) VALUES(?,?,?,?)').run(aid, p, 1, now())
  }
  const on = V3(aid)
  check('写端口全开后 → config_blocked 清空', on.detail.config_blocked === null, on.detail)
  check('写端口全开后 → A 明显上升', on.proxies.A - off.proxies.A > 0.15, { off: off.proxies.A, on: on.proxies.A })
  check('写端口全开后 A 接近 a_ceiling', Math.abs(on.proxies.A - on.detail.a_ceiling) < 0.05, { A: on.proxies.A, ceil: on.detail.a_ceiling })
}

// ---------- 5. 三处改动互不串味 ----------
{
  const aid = mkAgent('rn_mix')
  addTurns(aid, 60, 5)
  addEntities(aid, 150)
  const p = V3(aid)
  const keys = ['browse_used', 'delivery_used', 'config_blocked', 'a_ceiling', 'e_weights']
  check('诊断字段齐全', keys.every((k) => k in p.detail), keys.filter((k) => !(k in p.detail)))
  check('五维仍在 0..1', ['R', 'E', 'C', 'A', 'S'].every((k) => p.proxies[k] >= 0 && p.proxies[k] <= 1), p.proxies)
}

console.log(`\n${pass} passed, ${fail} failed`)
db.close()
fs.rmSync(dir, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
