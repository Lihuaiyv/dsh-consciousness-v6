/**
 * G1-3：老库补录 / 夜巡对账 / 体检漂移 / 导入导出。
 * 运行：node test/g1-3-backfill.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { addMemory, softDelete, resolveConflict } from '../src/modules/memory.js'
import { applyWrite } from '../src/modules/gate.js'
import {
  ensureTimelineBootstrapped, auditTimeline, timelineDrift, eventsOf, projectMany,
} from '../src/modules/timeline.js'
import { memoryHealth } from '../src/modules/retrieval_log.js'
import { runNightly, localDay } from '../src/modules/nightly.js'
import { exportMemory, importMemory } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-g13-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_g13'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(aid, 'g13', 'daily', 'active', now())
const write = (cand) => addMemory(db, aid, { text: cand.text, type: 'fact', fact_key: cand.fact_key || null, source: 'extract', skipConflict: true })

// 造一份「什么都发生过」的库
const swim = addMemory(db, aid, { text: '每周二晚上去游泳', type: 'fact', fact_key: 'habit.swim', source: 'extract' })
applyWrite(db, aid, { text: '每周二和周四晚上去游泳', fact_key: 'habit.swim' }, write)
const home1 = addMemory(db, aid, { text: '我住在杭州', type: 'fact', fact_key: 'home', source: 'extract' })
const home2 = addMemory(db, aid, { text: '我搬到上海住了', type: 'fact', fact_key: 'home', source: 'extract' })
const spicyA = addMemory(db, aid, { text: '我喜欢吃辣的川菜', type: 'fact', source: 'extract' })
const conf = applyWrite(db, aid, { text: '我不喜欢吃辣的川菜' }, write)
resolveConflict(db, aid, conf.conflict_id, { keep: 'b' })
const gtr = addMemory(db, aid, { text: '我在学弹吉他', type: 'fact', source: 'manual' })
softDelete(db, gtr.id)

// 变回「G1 之前」：清空时效索引与补录标记
const before = db.prepare('SELECT COUNT(*) n FROM memory_timeline').get().n
db.exec('DELETE FROM memory_timeline')
db.prepare("DELETE FROM flags WHERE key='timeline.bootstrapped.v1'").run()
check('清空前有事件', before > 0, before)
check('清空后全部 missing', timelineDrift(db, aid).missing === db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?').get(aid).n)

const n = ensureTimelineBootstrapped(db)
check('补录了全部记忆', n === db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?').get(aid).n, n)
check('补录后漂移 0', JSON.stringify(timelineDrift(db, aid)) === JSON.stringify({ total: n, drift: 0, missing: 0 }), timelineDrift(db, aid))
check('补录全部 approx=1', db.prepare('SELECT COUNT(*) n FROM memory_timeline WHERE approx=0').get().n === 0)
check('第二次启动不重复补', ensureTimelineBootstrapped(db) === 0)
{
  const e = eventsOf(db, aid, swim.id)
  const hist = db.prepare('SELECT id FROM fact_archive WHERE memory_id=?').get(swim.id + ':hist:1')
  check('补录出 REVISE 且指向旧句', e.some((x) => x.op === 'REVISE' && x.text_ref === hist.id), e)
  const h1 = eventsOf(db, aid, home1.id)
  check('补录出 supersede', h1.some((x) => x.op === 'INVALIDATE' && x.cause_id === home2.id), h1)
  const sa = eventsOf(db, aid, spicyA.id).map((x) => x.op)
  check('补录出争议开/结 + 开案作废', sa[0] === 'ADD' && sa.indexOf('INVALIDATE') > 0
    && sa.indexOf('DISPUTE_OPEN') > 0 && sa.indexOf('DISPUTE_CLOSE') > sa.indexOf('DISPUTE_OPEN'), sa)
  check('补录出 HIDE', eventsOf(db, aid, gtr.id).some((x) => x.op === 'HIDE'))
  const p = projectMany(db, aid, [spicyA.id]).get(spicyA.id)
  const opened = db.prepare('SELECT opened_at FROM conflicts WHERE id=?').get(conf.conflict_id).opened_at
  const bSaid = eventsOf(db, aid, conf.id).find((x) => x.op === 'ADD').valid_from
  check('补录后的投影（说话轴）：A 止于 B 说出口', p.active.length === 1 && p.active[0][1] === bSaid && !p.nowActive, { p: p.active, bSaid })
  const pr = projectMany(db, aid, [spicyA.id], { axis: 'recorded' }).get(spicyA.id)
  check('补录后的投影（入库轴）：A 止于开案，不是结案', pr.active[0][1] === opened, { p: pr.active, opened })
}

// 人为删掉一条事件 → 对账补回
{
  const seq = db.prepare("SELECT seq FROM memory_timeline WHERE memory_id=? AND op='INVALIDATE'").get(home1.id).seq
  db.prepare('DELETE FROM memory_timeline WHERE seq=?').run(seq)
  check('删后出现漂移', timelineDrift(db, aid).drift === 1, timelineDrift(db, aid))
  const a = auditTimeline(db, aid)
  check('对账修 1 条', a.fixed === 1 && a.missing === 0, a)
  check('对账后漂移 0', timelineDrift(db, aid).drift === 0)
  const sync = eventsOf(db, aid, home1.id).find((x) => x.op === 'SYNC')
  check('SYNC 标近似、时间取 invalid_at', sync && sync.approx === 1 && sync.reason === 'INVALIDATE'
    && sync.at === db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(home1.id).invalid_at, sync)
  check('再对账不重复写', auditTimeline(db, aid).fixed === 0)
  // 绕过 timeline 直接改主表（模拟钩子漏写）
  db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(now(), home2.id)
  check('漏写被体检看到', memoryHealth(db, aid).timeline_drift.drift === 1, memoryHealth(db, aid).timeline_drift)
  const night = await runNightly(db, aid, { day: localDay(), force: true, merge: false })
  const st = night.steps.find((s) => s.step === 'timeline_audit')
  check('夜巡含 timeline_audit 且修好', st && st.ok && st.fixed === 1, st)
  check('夜巡后漂移 0', timelineDrift(db, aid).drift === 0)
}

// 导出 → 导入到另一个意识体：不顶掉原意识体的事件
{
  const aid2 = 'agt_g13b'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(aid2, 'g13b', 'daily', 'active', now())
  const mineBefore = db.prepare('SELECT COUNT(*) n FROM memory_timeline WHERE agent_id=?').get(aid).n
  const pack = exportMemory(db, aid)
  check('导出含时效索引', pack.counts.memory_timeline > 0, pack.counts)
  // 先让原意识体退场，避免主键冲突让导入换新 id（这里测的是同 id 场景）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-g13c-'))
  const db2 = openDb(path.join(tmp, 'app.db'))
  db2.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(aid2, 'g13b', 'daily', 'active', now())
  const r = importMemory(db2, aid2, { zip_base64: pack.zip_base64 })
  check('导入收下事件', (r.by_table.memory_timeline || 0) > 0, r.by_table)
  check('导入后漂移 0', timelineDrift(db2, aid2).drift === 0 && timelineDrift(db2, aid2).missing === 0, timelineDrift(db2, aid2))
  const r2 = importMemory(db2, aid2, { zip_base64: pack.zip_base64 })
  check('重复导入不重复记', !r2.by_table.memory_timeline, r2.by_table)
  // 同库跨意识体导入：记忆 id 被换新 → 走补录
  const r3 = importMemory(db, aid2, { zip_base64: pack.zip_base64 })
  check('同库跨意识体：原意识体事件不变', db.prepare('SELECT COUNT(*) n FROM memory_timeline WHERE agent_id=?').get(aid).n === mineBefore)
  check('同库跨意识体：新意识体漂移 0', timelineDrift(db, aid2).drift === 0 && timelineDrift(db, aid2).missing === 0, { r3: r3.by_table, d: timelineDrift(db, aid2) })
  db2.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
