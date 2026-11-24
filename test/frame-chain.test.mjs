/**
 * 找核写链单测（2026-11-23）：用临时库 + mock 模型，模拟真实一轮的形状。
 * 覆盖：正常三句 / 单句 / 提件空 / 漏句补判 / 写表失败 / 重放覆盖 / 两轮并发。
 * 运行：node test/frame-chain.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { FRAME_WRITE_CHAIN, ensureTable } from '../src/modules/frame_shadow.js'
import { runChain } from '../src/modules/chain.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const AT = new Date().toISOString()
function newDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-chain-'))
  return openDb(path.join(dir, 'app.db'))
}
function ctxOf(db, { reply, turnId, runner }) {
  return {
    db, aid: 'agt_chain_test', reply, turnId, at: AT,
    sents: [], things: [], topicSets: { a: [], b: [], c: [] }, linkTo: null, assign: {}, missing: [], rows: 0,
    key: turnId, runner,
  }
}
const THINGS = () => JSON.stringify({ things: [{ what: '甲' }, { what: '乙' }] })
function mockRunner(calls, over = {}) {
  return {
    local: async (req, meta) => {
      calls.push(meta.label)
      if (over[meta.label]) return over[meta.label](req)
      if (meta.label === 'frame:write-assign') return JSON.stringify({ assign: { 1: 'A', 2: 'B', 3: 'B' } })
      if (meta.label === 'frame:write-fix') return JSON.stringify({ assign: {} })
      if (meta.label === 'frame:write-topics-a' || meta.label === 'frame:write-topics-b' || meta.label === 'frame:write-topics-c') return JSON.stringify({ topics: ['做质检'] })
      if (meta.label === 'frame:write-coref') return '{}'
      if (meta.label === 'frame:write-links') return JSON.stringify({ links: { 2: 1, 3: 2 } })
      if (meta.label === 'frame:write-attach') return JSON.stringify({ link: 0 })
      if (meta.label === 'frame:write-relate') return '{}'
      return ''
    },
    host: async (req, meta) => {
      calls.push(meta.label)
      if (over[meta.label]) return over[meta.label](req)
      if (meta.label === 'frame:write-judge') return THINGS()
      if (meta.label === 'frame:write-judge2') return THINGS()
      return ''
    },
  }
}
const rowsOf = (db, tid) => db.prepare('SELECT id, core, under_id FROM frame_shadow WHERE turn_id=? ORDER BY id').all(tid)

// 1 正常三句 → 两核，目的在上
{
  const db = newDb(); ensureTable(db)
  const calls = []
  const ctx = ctxOf(db, { reply: '第一句。第二句。第三句。', turnId: 't1', runner: mockRunner(calls) })
  const res = await runChain(FRAME_WRITE_CHAIN, ctx)
  const rows = db.prepare("SELECT id, core, role, sents, sat FROM frame_shadow WHERE turn_id='t1' ORDER BY id").all()
  check('三句：A 一段、核句 1', rows[0] && rows[0].role === 'nucleus' && rows[0].sents === '1' && rows[0].sat === null, rows)
  check('三句：B 一段、核句 2、补话攒在一起', rows[1] && rows[1].role === 'nucleus' && rows[1].sents === '2,3' && String(rows[1].sat).includes('第三句'), rows)
  check('三句：没漏句就不补判（fix 不跑）', !calls.includes('frame:write-fix') && calls.includes('frame:write-judge') && calls.includes('frame:write-assign'), calls)

  // 第一批：塌按接续入度标记（A 有外面接、B 无外部接且不含首句 → 孤立）
  const plans = db.prepare("SELECT id, plan FROM frame_shadow WHERE turn_id='t1' ORDER BY id").all()
  const pa = JSON.parse(plans[0].plan), pb = JSON.parse(plans[1].plan)
  check('第一批·塌：A 有外部接（indeg=1、不孤立）', pa.indeg === 1 && pa.orphan === false, pa)
  check('第一批·塌：B 无外部接且不含首句（孤立）', pb.indeg === 0 && pb.orphan === true, pb)
  check('第三批·题：只有一个题 → 不算该切', pa.split === false, pa)
}

// 2 单句 → 也进链（一句话也可能有核），落一件
{
  const db = newDb(); ensureTable(db)
  const ctx = ctxOf(db, { reply: '只有一句话也说清一件事。', turnId: 't2', runner: mockRunner([], { 'frame:write-judge': () => JSON.stringify({ things: [{ what: '甲' }] }), 'frame:write-judge2': () => JSON.stringify({ things: [{ what: '甲' }] }) }) })
  const res = await runChain(FRAME_WRITE_CHAIN, ctx)
  const rows = rowsOf(db, 't2')
  check('单句：正常结束、落一件', res.ok && rows.length === 1, rows)
  check('单句：核句就是那一句', (db.prepare("SELECT sents FROM frame_shadow WHERE id='t2-A'").get() || {}).sents === '1', rows)
}

// 3 判官给空 → 回退本地题名（不 stop、不丢这一轮）
{
  const db = newDb(); ensureTable(db)
  const calls = []
  const ctx = ctxOf(db, {
    reply: '第一句。第二句。第三句。', turnId: 't3',
    runner: mockRunner(calls, { 'frame:write-judge': () => '{"things":[]}', 'frame:write-judge2': () => '{"things":[]}' }),
  })
  const res = await runChain(FRAME_WRITE_CHAIN, ctx)
  check('判官空：回退本地题名，仍落 1 行', res.ok && !res.stopped && rowsOf(db, 't3').length === 1, rowsOf(db, 't3'))
  check('判官空：站队照跑（用回退的题名）', calls.includes('frame:write-judge') && calls.includes('frame:write-assign'), calls)
}

// 4 站队漏句 → 触发补判一次，补回来的也落表
{
  const db = newDb(); ensureTable(db)
  const calls = []
  const ctx = ctxOf(db, {
    reply: '第一句。第二句。第三句。', turnId: 't4',
    runner: mockRunner(calls, {
      'frame:write-assign': () => JSON.stringify({ assign: { 1: 'A' } }),
      'frame:write-fix': () => JSON.stringify({ assign: { 2: 'B', 3: 'B' } }),
    }),
  })
  const res = await runChain(FRAME_WRITE_CHAIN, ctx)
  const rows = rowsOf(db, 't4')
  check('漏句：补判被调用一次', calls.filter((x) => x === 'frame:write-fix').length === 1, calls)
  check('漏句：补回来的句子也落核', res.ok && rows.length === 2, rows)
  check('漏句：B 有 2、3 两句', rows[1] && rows[1].id === 't1-B'.replace('t1', 't4') && rows[1].core === '乙', rows)
}

// 4b 站队全部 N（纯接话）→ 不落行，链正常结束
{
  const db = newDb(); ensureTable(db)
  const calls = []
  const ctx = ctxOf(db, {
    reply: '第一句。第二句。第三句。', turnId: 't4b',
    runner: mockRunner(calls, { 'frame:write-assign': () => JSON.stringify({ assign: { 1: 'N', 2: 'N', 3: 'N' } }) }),
  })
  const res = await runChain(FRAME_WRITE_CHAIN, ctx)
  check('全 N：不落行、链正常', res.ok && rowsOf(db, 't4b').length === 0, res)
}

// 4c 接续失败（第一批）：可选步降级——写帧照常、塌跳过、记 degraded
{
  const db = newDb(); ensureTable(db)
  const calls = []
  const ctx = ctxOf(db, {
    reply: '第一句。第二句。第三句。', turnId: 't4c',
    runner: mockRunner(calls, { 'frame:write-links': () => { throw new Error('timeout') } }),
  })
  const res = await runChain(FRAME_WRITE_CHAIN, ctx)
  const rows = db.prepare("SELECT id, plan FROM frame_shadow WHERE turn_id='t4c' ORDER BY id").all()
  check('第一批·接续失败：写帧照常（两行）', res.ok && rows.length === 2, { res, rows })
  check('第一批·接续失败：plan 不写、塌跳过', rows.every((r) => r.plan == null), rows)
  check('第一批·接续失败：步骤记 degraded', res.steps.some((s) => s.id === 'links' && s.degraded === true), res.steps)
}

// 4c2 接续步（attach）失败：可选步降级——写帧照常、不抛
{
  const db = newDb(); ensureTable(db)
  const calls = []
  let threw = false
  let res
  try {
    res = await runChain(FRAME_WRITE_CHAIN, ctxOf(db, {
      reply: '第一句。第二句。第三句。', turnId: 't4c2',
      runner: mockRunner(calls, { 'frame:write-attach': () => { throw new Error('timeout') } }),
    }))
  } catch { threw = true }
  check('接续步失败：不抛、写帧照常', !threw && res && res.ok === true && rowsOf(db, 't4c2').length === 2, res && rowsOf(db, 't4c2'))
}

// 4d 字面证据（第二批）：一句命中另一核的两个两字词 → 加挂第二件，不否主判
{
  const db = newDb(); ensureTable(db)
  const calls = []
  const ctx = ctxOf(db, {
    reply: '先修词库。词库排位还得调。最后收尾。', turnId: 't4d',
    runner: mockRunner(calls, {
      'frame:write-judge': () => JSON.stringify({ things: [{ what: '修词库', kind: 'goal' }, { what: '调整词库排位', kind: 'action' }] }),
      'frame:write-judge2': () => JSON.stringify({ things: [{ what: '修词库' }, { what: '调整词库排位' }] }),
      'frame:write-assign': () => JSON.stringify({ assign: { 1: 'A', 2: 'A', 3: 'B' } }),
    }),
  })
  await runChain(FRAME_WRITE_CHAIN, ctx)
  const rows = db.prepare("SELECT id, sents FROM frame_shadow WHERE turn_id='t4d' ORDER BY id").all()
  check('第二批·字面证据：句2 同时挂两件（A 收 1、2；B 收 2、3）', rows.length === 2 && rows[0].sents === '1,2' && rows[1].sents === '2,3', rows)
}

// 4e 回指（第二批）：两个核是同一件事 → 合并，只落一行
{
  const db = newDb(); ensureTable(db)
  const calls = []
  const ctx = ctxOf(db, {
    reply: '第一句。第二句。第三句。', turnId: 't4e',
    runner: mockRunner(calls, { 'frame:write-coref': () => JSON.stringify({ merge: { B: 'A' } }) }),
  })
  const res = await runChain(FRAME_WRITE_CHAIN, ctx)
  const rows = db.prepare("SELECT id, sents FROM frame_shadow WHERE turn_id='t4e'").all()
  check('第二批·回指：B 并进 A，只落一行', res.ok && rows.length === 1 && rows[0].id === 't4e-A', rows)
  check('第二批·回指：三句都归 A', rows[0] && rows[0].sents === '1,2,3', rows)
}

// 4f 题（第三批）：两个互不相干的题 → 标记「该切帧」，但不改结构
{
  const db = newDb(); ensureTable(db)
  const calls = []
  const ctx = ctxOf(db, {
    reply: '第一句。第二句。第三句。', turnId: 't4f',
    runner: mockRunner(calls, {
      'frame:write-topics-a': () => JSON.stringify({ topics: ['改词库', '调排位'] }),
      'frame:write-topics-b': () => JSON.stringify({ topics: ['改词库', '调排位'] }),
      'frame:write-topics-c': () => JSON.stringify({ topics: ['改词库', '调排位'] }),
    }),
  })
  await runChain(FRAME_WRITE_CHAIN, ctx)
  const rows = db.prepare("SELECT plan FROM frame_shadow WHERE turn_id='t4f' ORDER BY id").all()
  const plan = JSON.parse(rows[0].plan)
  check('第三批·题：两个题 → 标记该切帧', plan.split === true, plan)
  check('第三批·题：只标记不改结构（仍落 2 行）', rows.length === 2, rows)
}

// 4j 共享句（一句归两核）在塌里：核内部接续不算，别把 A 多算一次
{
  const db = newDb(); ensureTable(db)
  await runChain(FRAME_WRITE_CHAIN, ctxOf(db, {
    reply: '第一句。第二句。第三句。', turnId: 't4j',
    runner: mockRunner([], {
      'frame:write-assign': () => JSON.stringify({ assign: { 1: 'A', 2: 'A', 3: 'AB' } }),
      'frame:write-links': () => JSON.stringify({ links: { 3: 2 } }),
    }),
  }))
  const rowA = db.prepare("SELECT plan, sents, sat FROM frame_shadow WHERE turn_id='t4j' AND id='t4j-A'").get()
  const planA = JSON.parse(rowA.plan)
  check('共享句：核内部接续不算（A 入度 0）', planA.indeg === 0, planA)
  check('共享句：A 段攒齐 1、2、3，补话是原话', rowA.sents === '1,2,3' && String(rowA.sat).includes('第二句'), rowA)
}

// 4k 同一字母重复归（模型回 AA）：句子编号不重复
{
  const db = newDb(); ensureTable(db)
  await runChain(FRAME_WRITE_CHAIN, ctxOf(db, {
    reply: '第一句。第二句。第三句。', turnId: 't4k',
    runner: mockRunner([], { 'frame:write-assign': () => JSON.stringify({ assign: { 1: 'AA', 2: 'B' } }) }),
  }))
  const row = db.prepare("SELECT sents FROM frame_shadow WHERE turn_id='t4k' AND id='t4k-A'").get()
  check('同一字母重复：句子编号去重', row && row.sents === '1', row)
}

// 4g 平级边（RST-DT 多核关系）：交叉→parallel、相邻→sequence、包含不重复写
{
  const db1 = newDb(); ensureTable(db1)
  await runChain(FRAME_WRITE_CHAIN, ctxOf(db1, { reply: '第一句。第二句。第三句。', turnId: 't4g1', runner: mockRunner([]) }))
  const e1 = db1.prepare("SELECT from_id, to_id, rel FROM frame_edges WHERE from_id LIKE 't4g1-%'").all()
  check('平级边：相邻两核 → sequence', e1.length === 1 && e1[0].rel === 'sequence', e1)

  const db2 = newDb(); ensureTable(db2)
  await runChain(FRAME_WRITE_CHAIN, ctxOf(db2, {
    reply: '第一句。第二句。第三句。', turnId: 't4g2',
    runner: mockRunner([], { 'frame:write-assign': () => JSON.stringify({ assign: { 1: 'A', 2: 'B', 3: 'AB' } }) }),
  }))
  const e2 = db2.prepare("SELECT from_id, to_id, rel FROM frame_edges WHERE from_id LIKE 't4g2-%'").all()
  check('平级边：交叉两核 → parallel', e2.length === 1 && e2[0].rel === 'parallel', e2)

  const db3 = newDb(); ensureTable(db3)
  await runChain(FRAME_WRITE_CHAIN, ctxOf(db3, {
    reply: '第一句。第二句。第三句。', turnId: 't4g3',
    runner: mockRunner([], { 'frame:write-assign': () => JSON.stringify({ assign: { 1: 'AB', 2: 'AB', 3: 'A' } }) }),
  }))
  const e3 = db3.prepare("SELECT from_id, to_id, rel FROM frame_edges WHERE from_id LIKE 't4g3-%'").all()
  check('父子边：包含关系 → parent（子→父）', e3.length === 1 && e3[0].rel === 'parent', e3)
}

// 4h 判官（语义关系）：核间 cause → frame_edges
{
  const db = newDb(); ensureTable(db)
  await runChain(FRAME_WRITE_CHAIN, ctxOf(db, {
    reply: '第一句。第二句。第三句。', turnId: 't4h',
    runner: mockRunner([], { 'frame:write-relate': () => JSON.stringify({ pairs: [{ a: 1, b: 2, rel: 'cause' }] }) }),
  }))
  const e = db.prepare("SELECT from_id, to_id, rel FROM frame_edges WHERE from_id LIKE 't4h-%'").all()
  check('判官：核间 cause 落边', e.some((x) => x.rel === 'cause'), e)
}

// 4i 判官（段间）：本轮段头接上一轮，标 switch
{
  const db = newDb(); ensureTable(db)
  db.prepare('INSERT INTO frame_shadow (id, turn_id, seg, created_at, core, sents, role) VALUES (?,?,?,?,?,?,?)')
    .run('t0-A', 't0', 't0', '2026-11-23T00:00:00.000Z', '上一段', '1', 'nucleus')
  await runChain(FRAME_WRITE_CHAIN, ctxOf(db, {
    reply: '第一句。第二句。第三句。', turnId: 't4i',
    runner: mockRunner([], {
      'frame:write-judge': () => THINGS(),
      'frame:write-attach': () => JSON.stringify({ link: 1 }),
      'frame:write-relate': () => JSON.stringify({ link: 'switch' }),
    }),
  }))
  const e = db.prepare("SELECT from_id, to_id, rel FROM frame_edges WHERE from_id LIKE 't4i-%' AND to_id='t0-A'").all()
  check('判官：段间 switch 落边', e.length === 1 && e[0].rel === 'switch', e)
}

// 9 零句子核：判官三件、分配只覆盖两件 → 第三件记进 emptyCores（不无声丢）
{
  const db = newDb(); ensureTable(db)
  const ctx = ctxOf(db, {
    reply: '第一句。第二句。第三句。', turnId: 't9',
    runner: mockRunner([], {
      'frame:write-judge': () => JSON.stringify({ things: [{ what: '甲' }, { what: '乙' }, { what: '丙' }] }),
      'frame:write-judge2': () => JSON.stringify({ things: [{ what: '甲' }, { what: '乙' }, { what: '丙' }] }),
      'frame:write-assign': () => JSON.stringify({ assign: { 1: 'A', 2: 'B' }, empty: ['C'] }),
    }),
  })
  const res = await runChain(FRAME_WRITE_CHAIN, ctx)
  const rows = rowsOf(db, 't9')
  check('零句子核：只落两行（丙没句子）', res.ok && rows.length === 2, rows)
  check('零句子核：记进 ctx.emptyCores 含 C', Array.isArray(ctx.emptyCores) && ctx.emptyCores.includes('C'), ctx.emptyCores)
}

// 5 写表失败 → 链报错但不抛
{
  const bad = {
    prepare() { throw new Error('db down') },
    exec() { throw new Error('db down') },
  }
  const calls = []
  let threw = false
  let res
  try { res = await runChain(FRAME_WRITE_CHAIN, ctxOf(bad, { reply: '第一句。第二句。第三句。', turnId: 't5', runner: mockRunner(calls) })) } catch { threw = true }
  check('写表失败：不抛给调用方', !threw)
  check('写表失败：链返回 ok=false，失败步是 write', res && res.ok === false && res.steps[res.steps.length - 1].id === 'write', res && res.steps)
}

// 6 重放同一轮 → 主键覆盖，行数不变
{
  const db = newDb(); ensureTable(db)
  await runChain(FRAME_WRITE_CHAIN, ctxOf(db, { reply: '第一句。第二句。第三句。', turnId: 't6', runner: mockRunner([]) }))
  await runChain(FRAME_WRITE_CHAIN, ctxOf(db, { reply: '第一句。第二句。第三句。', turnId: 't6', runner: mockRunner([]) }))
  check('重放：覆盖不翻倍', rowsOf(db, 't6').length === 2, rowsOf(db, 't6'))
}

// 7 两轮并发 → 各自落各自的，不串
{
  const db = newDb(); ensureTable(db)
  const slow = (calls) => ({
    local: async (req, meta) => {
      calls.push(meta.label)
      await new Promise((r) => setTimeout(r, 5))
      if (meta.label === 'frame:write-assign') return JSON.stringify({ assign: { 1: 'A', 2: 'B', 3: 'B' } })
      return ''
    },
    host: async (req, meta) => {
      calls.push(meta.label)
      await new Promise((r) => setTimeout(r, 5))
      if (meta.label === 'frame:write-judge') return THINGS()
      if (meta.label === 'frame:write-judge2') return THINGS()
      return ''
    },
  })
  const [r1, r2] = await Promise.all([
    runChain(FRAME_WRITE_CHAIN, ctxOf(db, { reply: '甲一。甲二。甲三。', turnId: 'ta1', runner: slow([]) })),
    runChain(FRAME_WRITE_CHAIN, ctxOf(db, { reply: '乙一。乙二。乙三。', turnId: 'tb1', runner: slow([]) })),
  ])
  check('并发两轮：都成功', r1.ok && r2.ok, { r1: r1.ok, r2: r2.ok })
  check('并发两轮：各落各的', rowsOf(db, 'ta1').length === 2 && rowsOf(db, 'tb1').length === 2, { a: rowsOf(db, 'ta1'), b: rowsOf(db, 'tb1') })
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)

