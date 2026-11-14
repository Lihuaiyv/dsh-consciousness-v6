/**
 * 事件级情绪：把「那件事」从情绪表里单独读出来。
 * 运行：node test/emotion-event.test.mjs
 *
 * 验五件事：
 *   1. 没有未结束的 episode 时返回 null（不硬编一个「平静」）
 *   2. 有 open episode：带着 id / label / 强度 / 原话 / 走了几分钟
 *   3. 强度为 0 的不算「挂着一件事」
 *   4. 三段：还在抬 / 抬完了还没散 / 已经该散了但没 ended
 *   5. 只读：读完这张表一个字节都不改
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { openEmotion, phaseOf, shouldSurfaceEmotion, surfaceCounts } from '../src/modules/emotion_event.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-emoevent-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_emoevent'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '感觉', 'daily', 'active', new Date().toISOString())

const now = Date.now()
const iso = (ms) => new Date(ms).toISOString()
const MIN = 60000

const addEp = (id, o = {}) => {
  db.prepare(`INSERT INTO affect_episodes(id, agent_id, cause, appraisal, label, intensity, resolution, started_at, ended_at, renewals, rise_from, rise_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, aid, o.cause ?? '那句话', null, o.label ?? 'irritated', o.intensity ?? 0.6,
    o.resolution ?? null, o.startedAt ?? iso(now - 10 * MIN), o.endedAt ?? null,
    o.renewals ?? 0, o.riseFrom ?? 0.2, o.riseAt ?? iso(now + 1 * MIN),
  )
}

// ---------- 1. 没有 open episode ----------
check('没有 episode 时返回 null', openEmotion(db, aid) === null)

// ---------- 2. 有 open episode ----------
addEp('ep1', { cause: '你一点都不活', label: 'frustrated', intensity: 0.62, startedAt: iso(now - 12 * MIN), riseAt: iso(now - 6 * MIN) })
const e = openEmotion(db, aid)
check('读得到', !!e && e.id === 'ep1', e)
check('带原话', e && e.cause === '你一点都不活', e && e.cause)
check('带标签与强度', e && e.label === 'frustrated' && Math.abs(e.intensity - 0.62) < 1e-9, e)
check('带走了几分钟', e && e.ageMin >= 11 && e.ageMin <= 13, e && e.ageMin)
check('rise 已过 → holding', e && e.phase === 'holding', e && e.phase)

// ---------- 3. 强度 0 不算挂着一件事 ----------
addEp('ep0', { intensity: 0, startedAt: iso(now - 5 * MIN), riseAt: iso(now - 4 * MIN) })
check('强度 0 不算事件', openEmotion(db, aid).id === 'ep1', openEmotion(db, aid))

// ---------- 4. 三段 ----------
const epRising = { started_at: iso(now - MIN), rise_at: iso(now + 5 * MIN) }
const epHolding = { started_at: iso(now - 20 * MIN), rise_at: iso(now - 10 * MIN) }
const epFading = { started_at: iso(now - 120 * MIN), rise_at: iso(now - 60 * MIN) }
check('rising', phaseOf(epRising, now) === 'rising', phaseOf(epRising, now))
check('holding', phaseOf(epHolding, now) === 'holding', phaseOf(epHolding, now))
check('fading', phaseOf(epFading, now) === 'fading', phaseOf(epFading, now))
check('没有 rise_at 用 started_at 兜底', phaseOf({ started_at: iso(now - 5 * MIN) }, now) === 'holding')

// ---------- 5. 只读 ----------
const before = db.prepare("SELECT id,intensity,resolution,ended_at FROM affect_episodes ORDER BY id").all()
openEmotion(db, aid)
const after = db.prepare("SELECT id,intensity,resolution,ended_at FROM affect_episodes ORDER BY id").all()
check('读它不改库', JSON.stringify(before) === JSON.stringify(after))

// ---------- 6. 该不该冒（纯判断，不写库） ----------
const liveOk = { id: 'ep1', intensity: 0.35, ageMin: 15 }
const base = { live: liveOk, cause: '你一点都不活', machine: false, enabled: true, keptEver: false, todayCount: 0 }
check('四条都过才冒', shouldSurfaceEmotion(base) === true)
check('不够强不冒', shouldSurfaceEmotion({ ...base, live: { ...liveOk, intensity: 0.34 } }) === false)
check('刚说完不冒', shouldSurfaceEmotion({ ...base, live: { ...liveOk, ageMin: 14 } }) === false)
check('今天第三次以后不冒', shouldSurfaceEmotion({ ...base, todayCount: 3 }) === false)
check('真留住过的不冒', shouldSurfaceEmotion({ ...base, keptEver: true }) === false)
check('没有这件事不冒', shouldSurfaceEmotion({ ...base, live: null }) === false)
check('空话不冒', shouldSurfaceEmotion({ ...base, cause: '  ' }) === false)
check('机器消息不冒', shouldSurfaceEmotion({ ...base, machine: true }) === false)
check('开关关掉不冒', shouldSurfaceEmotion({ ...base, enabled: false }) === false)

// ---------- 7. 账怎么数 ----------
const stamp = (ms) => new Date(ms).toISOString()
const ins = db.prepare('INSERT INTO events(id,agent_id,type,payload,created_at) VALUES(?,?,?,?,?)')
ins.run('ev_old', aid, 'affect.surface', JSON.stringify({ episode_id: 'ep1' }), stamp(now - 2 * 86400000))
ins.run('ev_legacy', aid, 'affect.surface', JSON.stringify({ episode_id: 'ep1', cause: '旧的' }), stamp(now))
let c = surfaceCounts(db, aid, 'ep1', now)
check('旧账没有真留住标记：不算这辈子冒过', c.keptEver === false, c)
check('今天的旧账仍算进一天三次', c.todayCount === 1, c)
check('昨天的账不进今天', surfaceCounts(db, aid, 'ep9', now).todayCount === 1)
ins.run('ev_kept', aid, 'affect.surface', JSON.stringify({ episode_id: 'ep1', kept: true }), stamp(now - 86400000))
c = surfaceCounts(db, aid, 'ep1', now)
check('标了真留住的，隔天也不再冒', c.keptEver === true, c)
check('别的事不被它挡住', surfaceCounts(db, aid, 'ep_other', now).keptEver === false)
ins.run('ev_l2', aid, 'affect.surface', JSON.stringify({ episode_id: 'ep2' }), stamp(now))
ins.run('ev_l3', aid, 'affect.surface', JSON.stringify({ episode_id: 'ep3' }), stamp(now))
check('今天满三次', surfaceCounts(db, aid, 'ep_other', now).todayCount === 3)
const epBefore = db.prepare('SELECT intensity FROM affect_episodes WHERE id=?').get('ep1')
surfaceCounts(db, aid, 'ep1', now)
shouldSurfaceEmotion(base)
const epAfter = db.prepare('SELECT intensity FROM affect_episodes WHERE id=?').get('ep1')
check('判断和数账都不改情绪', epBefore.intensity === epAfter.intensity)

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
