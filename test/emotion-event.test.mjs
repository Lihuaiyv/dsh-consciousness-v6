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
import { openEmotion, phaseOf } from '../src/modules/emotion_event.js'

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

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
