/**
 * 关系余量：她自己的回话偏离当轮表达基准 → 记一笔 → 下一轮只影响语气；
 * 夜间结算默认关，打开后同方向 ≥3 条才小步动一次三轴。
 * 运行：node test/self-residue.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { ownerPerson, bootstrap } from '../src/modules/relations.js'
import {
  recordSelfResidue, residueCandidate, commitResidue, settleSelfResidue, residueStats, residueDirFor,
} from '../src/modules/self_residue.js'
import { consciousnessBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-residue-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

let seq = 0
function newAgent(budget = 800) {
  seq += 1
  const aid = 'agt_res_' + seq
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '余量' + seq, 'daily', 'active', now())
  bootstrap(db, aid)
  if (budget != null) setParam(db, aid, 'memory.inject.budget', { value: budget })
  return aid
}
const count = (aid, type) => {
  try { return Number(db.prepare('SELECT COUNT(*) n FROM events WHERE agent_id=? AND type=?').get(aid, type).n || 0) } catch { return -1 }
}

// ---- 方向判定（纯函数，和 commitTurn 用同一套阈值） ----
{
  check('偏冷够大 → cold', residueDirFor(-0.4, 0.2) === 'cold', residueDirFor(-0.4, 0.2))
  check('偏软够大 → warm', residueDirFor(0.6, 0.1) === 'warm', residueDirFor(0.6, 0.1))
  check('差不多 → 不记', residueDirFor(0.1, 0.1) === '', residueDirFor(0.1, 0.1))
  check('非法输入 → 不记', residueDirFor(null, 0.2) === '', residueDirFor(null, 0.2))
}

// ---- 记录 ----
{
  const aid = newAgent()
  const c = recordSelfResidue(db, aid, { dir: 'cold', delta: -0.6, warmth: -0.4, expected: 0.2, replyLen: 8 })
  check('cold 能记下', !!c && c.dir === 'cold', c)
  check('cold 记一条事件', count(aid, 'rel.self_residue') === 1)
  const w = recordSelfResidue(db, aid, { dir: 'warm', delta: 0.5, warmth: 0.6, expected: 0.1, replyLen: 30 })
  check('warm 能记下', !!w && w.dir === 'warm', w)
  check('非法方向不记', recordSelfResidue(db, aid, { dir: 'x' }) === null)
}

// ---- 开关 ----
{
  const aid = newAgent()
  setParam(db, aid, 'relation.selfresidue', { value: 'off' })
  check('关掉后不记', recordSelfResidue(db, aid, { dir: 'cold', delta: -0.6 }) === null)
  check('关掉后不出候选', residueCandidate(db, aid).line === '')
}

// ---- 候选 → 落账 → 不再重复 ----
{
  const aid = newAgent()
  recordSelfResidue(db, aid, { dir: 'cold', delta: -0.6, warmth: -0.4, expected: 0.2 })
  const c = residueCandidate(db, aid)
  check('冷余量有句子', c.line.includes('上一句你说得有点硬'), c)
  check('冷余量带 id', !!c.id, c)
  check('落账成功', commitResidue(db, aid, c) === true)
  check('落账后不再出', residueCandidate(db, aid).line === '')
  check('提示事件 1 条', count(aid, 'rel.self_residue.shown') === 1)
}

// ---- TTL：6 小时前的余量不出 ----
{
  const aid = newAgent()
  recordSelfResidue(db, aid, { dir: 'cold', delta: -0.6, warmth: -0.4, expected: 0.2, at: Date.now() - 7 * 3600000 })
  check('7 小时前的余量过期', residueCandidate(db, aid).line === '')
}

// ---- 注入：宽预算出现，紧预算不消耗 ----
{
  const aid = newAgent(800)
  recordSelfResidue(db, aid, { dir: 'cold', delta: -0.6, warmth: -0.4, expected: 0.2 })
  const text = consciousnessBlock(db, aid, {})
  check('宽预算：余量进注入', text.includes('上一句你说得有点硬'), text.slice(0, 220))
  check('宽预算：余量已提示', count(aid, 'rel.self_residue.shown') === 1)
}
{
  const aid = newAgent(40)
  recordSelfResidue(db, aid, { dir: 'cold', delta: -0.6, warmth: -0.4, expected: 0.2 })
  const text = consciousnessBlock(db, aid, {})
  check('紧预算：余量不在文本里', !text.includes('上一句你说得有点硬'), text)
  check('紧预算：余量没被消耗', count(aid, 'rel.self_residue.shown') === 0)
}

// ---- 夜间结算：默认关 ----
{
  const aid = newAgent()
  const before = ownerPerson(db, aid)
  for (let i = 0; i < 3; i++) recordSelfResidue(db, aid, { dir: 'cold', delta: -0.5, warmth: -0.4, expected: 0.1 })
  const off = settleSelfResidue(db, aid)
  check('默认不结算', off.skipped === 'settle-off', off)
  const after = ownerPerson(db, aid)
  check('默认不结算：信任不动', Number(after.trust) === Number(before.trust), { before, after })
}

// ---- 夜间结算：打开后 3 条冷 → 信任/亲近小步下降 ----
{
  const aid = newAgent()
  for (let i = 0; i < 3; i++) recordSelfResidue(db, aid, { dir: 'cold', delta: -0.5, warmth: -0.4, expected: 0.1, at: Date.now() - (3 - i) * 60000 })
  setParam(db, aid, 'relation.selfresidue.settle', { value: 'on' })
  const before = ownerPerson(db, aid)
  const r = settleSelfResidue(db, aid)
  const after = ownerPerson(db, aid)
  check('打开后结算 3 条', r.settled === 3 && r.dir === 'cold', r)
  check('信任下降', Number(after.trust) < Number(before.trust), { before, after })
  check('亲近下降', Number(after.closeness) < Number(before.closeness), { before, after })
  check('单次幅度有上限', Number(before.trust) - Number(after.trust) <= 0.011, { before, after })
  const again = settleSelfResidue(db, aid)
  check('同日只结算一次', again.skipped === 'already', again)
  check('结算事件 1 条', count(aid, 'rel.self_residue.settled') === 1)
}

// ---- 正向余量：3 条才动，幅度更小 ----
{
  const aid = newAgent()
  const before = ownerPerson(db, aid)
  for (let i = 0; i < 3; i++) recordSelfResidue(db, aid, { dir: 'warm', delta: 0.5, warmth: 0.6, expected: 0.1 })
  setParam(db, aid, 'relation.selfresidue.settle', { value: 'on' })
  const r = settleSelfResidue(db, aid)
  const after = ownerPerson(db, aid)
  check('warm 也结算', r.dir === 'warm' && r.settled === 3, r)
  check('warm 幅度小于 cold', Number(after.trust) - Number(before.trust) < 0.011, { before, after })
  check('warm 不动依赖太多', Math.abs(Number(after.dependence) - Number(before.dependence)) < 0.005, { before, after })
}

// ---- 跨零点：同一批余量不能被算两次 ----
{
  const aid = newAgent()
  const base = new Date()
  base.setHours(23, 59, 0, 0)
  const t1 = base.getTime()
  for (let i = 0; i < 3; i++) recordSelfResidue(db, aid, { dir: 'cold', delta: -0.5, warmth: -0.4, expected: 0.1, at: t1 - 1000 })
  setParam(db, aid, 'relation.selfresidue.settle', { value: 'on' })
  const first = settleSelfResidue(db, aid, { at: t1 })
  const second = settleSelfResidue(db, aid, { at: t1 + 2 * 60000 })
  check('跨零点第一次结算 3 条', first.settled === 3, first)
  check('跨零点第二次不再结算', second.settled === 0 && second.skipped === 'below', second)
}

// ---- 统计 ----
{
  const aid = newAgent()
  recordSelfResidue(db, aid, { dir: 'cold', delta: -0.5 })
  const s = residueStats(db, aid, { days: 7 })
  check('统计：记录 1 条', s.recorded === 1, s)
  check('统计：显示 0 条', s.shown === 0, s)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
