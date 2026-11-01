/**
 * G1-1：时效索引投影（纯函数）+ 写入工具。
 * 运行：node test/g1-1-timeline.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import {
  projectTimeline, overlaps, versionRefAt, logEvent, invalidateMemory, reactivateMemory,
  eventsOf, projectMany, driftOf, saidAt,
} from '../src/modules/timeline.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const D0 = Date.parse('2026-03-01T09:00:00+08:00')
const d = (n, h = 0) => new Date(D0 + n * 86400000 + h * 3600000).toISOString()
let SEQ = 0
const ev = (op, at, o = {}) => ({ seq: ++SEQ, op, at, valid_from: o.vf || null, reason: o.reason || null, cause_id: o.cause || null, text_ref: o.ref || null, approx: o.approx ? 1 : 0 })
const inAt = (p, t) => p.active.some((iv) => overlaps(iv, t, new Date(Date.parse(t) + 1).toISOString()))
const disputedAt = (p, t) => p.disputes.some((iv) => overlaps(iv, t, new Date(Date.parse(t) + 1).toISOString()))

// #1–#4 改口 + 冲突 + 结案
{
  const A = [ev('ADD', d(5), { vf: d(5) }), ev('INVALIDATE', d(120), { reason: 'conflict', cause: 'B' }), ev('DISPUTE_OPEN', d(120), { cause: 'cfl' })]
  const B = [ev('ADD', d(120), { vf: d(120) }), ev('DISPUTE_OPEN', d(120), { cause: 'cfl' })]
  const cs = { B: d(120) }
  const pA = projectTimeline(A, { causeSaid: cs })
  const pB = projectTimeline(B, { causeSaid: cs })
  check('#1 d60 A 当时有效', inAt(pA, d(60)) && !inAt(pB, d(60)), pA)
  check('#1 A 区间 [d5,d120)', pA.active.length === 1 && pA.active[0][0] === d(5) && pA.active[0][1] === d(120), pA.active)
  check('#2 d121 B 有效、A 争议', inAt(pB, d(121)) && !inAt(pA, d(121)) && disputedAt(pA, d(121)), { pA, pB })

  // #3 结案保留 B：A 再次作废（已无效，忽略），结案
  const A3 = [...A, ev('INVALIDATE', d(130), { reason: 'resolve', cause: 'cfl' }), ev('DISPUTE_CLOSE', d(130), { cause: 'cfl' })]
  const p3 = projectTimeline(A3, { causeSaid: cs })
  check('#3 失效点仍是 d120（幂等）', p3.active.length === 1 && p3.active[0][1] === d(120), p3.active)
  check('#3 d125 仍争议 / d131 不争议', disputedAt(p3, d(125)) && !disputedAt(p3, d(131)), p3.disputes)

  // #4 结案保留 A：A 复活、B 作废
  const A4 = [...A, ev('REACTIVATE', d(130), { cause: 'cfl' }), ev('DISPUTE_CLOSE', d(130), { cause: 'cfl' })]
  const B4 = [...B, ev('INVALIDATE', d(130), { reason: 'resolve', cause: 'cfl' }), ev('DISPUTE_CLOSE', d(130), { cause: 'cfl' })]
  const p4a = projectTimeline(A4, { causeSaid: cs })
  const p4b = projectTimeline(B4, { causeSaid: cs })
  check('#4 A 两段 [d5,d120) ∪ [d130,∞)', p4a.active.length === 2 && p4a.active[1][0] === d(130) && p4a.active[1][1] === null, p4a.active)
  check('#4 d125 B 有效 A 争议；d131 A 有效 B 无', inAt(p4b, d(125)) && disputedAt(p4a, d(125)) && inAt(p4a, d(131)) && !inAt(p4b, d(131)), { p4a, p4b })
  check('#4 现状 A 有效 B 无效', p4a.nowActive && !p4b.nowActive)
}

// #5 原地改写
{
  const E = [ev('ADD', d(10), { vf: d(10) }), ev('REVISE', d(50), { ref: 'far_old' })]
  const p = projectTimeline(E)
  check('#5 d30 用旧句', versionRefAt(p.revisions, d(30)).text_ref === 'far_old')
  check('#5 d60 用现行', versionRefAt(p.revisions, d(60)).text_ref === null)
  const inWin = p.revisions.some((r) => r.eff >= d(40) && r.eff < d(55))
  check('#5 d40–d55 期间改过', inWin)
}

// #6 过去事实：零宽
{
  const E = [ev('ADD', d(20), { vf: d(20) }), ev('INVALIDATE', d(20), { reason: 'past_fact' })]
  const p = projectTimeline(E)
  check('#6 零宽区间', p.active.length === 1 && p.active[0][0] === p.active[0][1], p.active)
  check('#6 d10 无', !p.active.some((iv) => overlaps(iv, d(0), d(11))))
  check('#6 到 d30 为止：历史陈述', p.active.some((iv) => overlaps(iv, d(0), d(30))))
}

// #12 取代链 A→B→C
{
  const cs = { B: d(30, 2), C: d(60, 5) }
  const A = [ev('ADD', d(10), { vf: d(10) }), ev('INVALIDATE', d(31), { reason: 'supersede', cause: 'B' })]
  const B = [ev('ADD', d(31), { vf: d(30, 2) }), ev('INVALIDATE', d(61), { reason: 'supersede', cause: 'C' })]
  const pA = projectTimeline(A, { causeSaid: cs })
  const pB = projectTimeline(B, { causeSaid: cs })
  check('#12 A 的 end = B 说话时间', pA.active[0][1] === d(30, 2), pA.active)
  check('#12 B 区间 [B说话, C说话)', pB.active[0][0] === d(30, 2) && pB.active[0][1] === d(60, 5), pB.active)
  const t = d(30, 3)
  check('#12 交界后只有 B', !inAt(pA, t) && inAt(pB, t))
}

// #13 取代者说话更早（乱序）
{
  const cs = { B: d(5) }
  const A = [ev('ADD', d(10), { vf: d(10) }), ev('INVALIDATE', d(12), { reason: 'supersede', cause: 'B' })]
  const p = projectTimeline(A, { causeSaid: cs })
  check('#13 不倒挂（零宽）', p.active.length === 1 && p.active[0][1] >= p.active[0][0], p.active)
}

// recorded 轴：直接用入库时间
{
  const E = [ev('ADD', d(10, 14), { vf: d(10, 1) }), ev('INVALIDATE', d(20))]
  const p = projectTimeline(E, { axis: 'recorded' })
  check('recorded 轴用 at', p.active[0][0] === d(10, 14))
  const s = projectTimeline(E)
  check('said 轴用 valid_from', s.active[0][0] === d(10, 1))
}

// HIDE / UNHIDE / DELETE / SYNC
{
  const p1 = projectTimeline([ev('ADD', d(1)), ev('HIDE', d(40))])
  check('HIDE 标隐藏', p1.hidden)
  const p2 = projectTimeline([ev('ADD', d(1)), ev('HIDE', d(40)), ev('UNHIDE', d(42))])
  check('UNHIDE 撤销', !p2.hidden && inAt(p2, d(41)))
  const p3 = projectTimeline([ev('ADD', d(1)), ev('SYNC', d(50), { reason: 'INVALIDATE', approx: true })])
  check('SYNC 按 reason 作废并标近似', !p3.nowActive && p3.approx && p3.active[0][1] === d(50), p3)
  const p4 = projectTimeline([ev('INVALIDATE', d(9))])
  check('缺 ADD：首事件补出生并标近似', p4.born === d(9) && p4.approx)
}

// 数据库工具
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-g11-'))
  const db = openDb(path.join(dir, 'app.db'))
  const aid = 'agt_g11'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(aid, 'g11', 'daily', 'active', now())
  const ins = (id) => db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,last_decay_at,status,created_at,version)
    VALUES(?,?,?,?,?,?,?,?,?,1)`).run(id, aid, 'fact', 'normal', '文本' + id, 'manual', now(), 'active', now())
  ins('m1'); ins('m2')
  check('表存在', !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_timeline'").get())
  check('非法 op 不写', logEvent(db, aid, 'm1', 'FOO') === null)
  logEvent(db, aid, 'm1', 'ADD', { at: d(1), validFrom: d(2) })
  check('valid_from 夹紧到 ≤ at', eventsOf(db, aid, 'm1')[0].valid_from === d(1))
  logEvent(db, aid, 'm2', 'ADD', { at: d(3), validFrom: d(3) })
  invalidateMemory(db, aid, 'm1', { reason: 'supersede', supersededBy: 'm2', bumpVersion: true, at: d(4) })
  const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get('m1')
  check('作废写主表', row.invalid_at === d(4) && row.superseded_by === 'm2' && row.version === 2, row)
  const pm = projectMany(db, aid, ['m1', 'm2'])
  check('projectMany 用取代者说话时间', pm.get('m1').active[0][1] === d(3), pm.get('m1').active)
  check('漂移 0', driftOf(row, pm.get('m1')) === null)
  reactivateMemory(db, aid, 'm1', { at: d(5) })
  const row2 = db.prepare('SELECT * FROM memory_items WHERE id=?').get('m1')
  check('复活后 invalid_at 空', row2.invalid_at === null)
  check('复活后投影一致', driftOf(row2, projectMany(db, aid, ['m1']).get('m1')) === null)
  const nope = invalidateMemory(db, aid, 'missing', { reason: 'x' })
  check('不存在的 id 不记事件', Number(nope.changes) === 0 && eventsOf(db, aid, 'missing').length === 0)
  // saidAt：原话 / 纪要 / 兜底
  db.prepare(`INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run('r1', aid, 's1', 't1', 0, 'user', '我喜欢美式', d(10, -1), '2026-03-11')
  db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,seg,start_at,end_at,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run('ep1', aid, 's1', '2026-03-11', 0, d(10, -2), d(10, -1), d(10, 1))
  check('saidAt 原话', saidAt(db, aid, { at: d(10, 1), sourceTurnId: 't1' }) === d(10, -1))
  check('saidAt 纪要（turn_id=纪要 id）', saidAt(db, aid, { at: d(10, 1), sourceTurnId: 'ep1' }) === d(10, -2))
  check('saidAt 显式优先', saidAt(db, aid, { at: d(10, 1), validAt: d(9), sourceTurnId: 't1' }) === d(9))
  check('saidAt 不晚于入库', saidAt(db, aid, { at: d(10, 1), validAt: d(12) }) === d(10, 1))
  check('saidAt 兜底入库时间', saidAt(db, aid, { at: d(10, 1) }) === d(10, 1))
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
