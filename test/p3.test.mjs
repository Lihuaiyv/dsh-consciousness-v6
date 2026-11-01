/**
 * P3 冲突升级与可追溯测试：留痕 / 详情 / 升级 / 定时升级 / 统计 / HTTP。
 * 运行：node test/p3.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { conflictDetail, conflictTimeline, escalateConflict, tickEscalation, conflictStats, MAX_LEVEL, ESCALATE_AFTER_DAYS, ESCALATE_HARD_DAYS } from '../src/modules/conflict.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p3-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_p3'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'P3', 'daily', 'active', now())

// ---- 造一条真实冲突：同主题、极性相反、涉及重要信息
{
  addMemory(db, aid, { text: '用户的生日是十月三日', type: 'fact', importance: 0.9 })
  const r = addMemory(db, aid, { text: '用户的生日不是十月三日吧', type: 'fact', importance: 0.9 })
  check('写入即判冲突', r.conflict === true, r)
  const c = db.prepare("SELECT * FROM conflicts WHERE agent_id=? AND state='open' ORDER BY rowid DESC LIMIT 1").get(aid)
  check('冲突行存在', !!c, c)
  check('带严重度', c.severity === 'high', c.severity)
  check('带判定种类', c.kind === 'polarity', c.kind)
  const ev = JSON.parse(c.evidence || '{}')
  check('留了判定依据（相似度 + 双方原文）', ev.similarity > 0 && ev.a_text && ev.b_text, ev)
}

// ---- 详情与时间线
{
  const c = db.prepare("SELECT id FROM conflicts WHERE agent_id=? AND state='open' LIMIT 1").get(aid)
  const d = conflictDetail(db, aid, c.id)
  check('详情带双方原文', d && d.a && d.b && /生日/.test(d.a.text), d && { a: d.a.text, b: d.b.text })
  check('详情带判定依据', d.evidence && d.evidence.similarity > 0, d.evidence)
  const tl = conflictTimeline(db, aid, c.id)
  check('时间线有开案记录', tl.length >= 1 && tl[0].type === 'memory.conflict', tl.map((x) => x.type))
}

// ---- 手动升级
{
  const c = db.prepare("SELECT id FROM conflicts WHERE agent_id=? AND state='open' LIMIT 1").get(aid)
  const up = escalateConflict(db, aid, c.id, { reason: '我需要你拍板' })
  check('升级到 1 级', up.level === 1, up)
  const d = conflictDetail(db, aid, c.id)
  check('详情里 level 变了', d.level === 1, d.level)
  check('时间线记了升级', d.timeline.some((e) => e.type === 'memory.conflict_escalated'), d.timeline.map((e) => e.type))
  const again = escalateConflict(db, aid, c.id, {})
  check('再升到 2 级', again.level === 2, again)
  const third = escalateConflict(db, aid, c.id, {})
  check('不超过上限', third.level === MAX_LEVEL, third)
  const alerts = db.prepare("SELECT COUNT(*) n FROM alerts WHERE agent_id=? AND severity=3").get(aid).n
  check('满级挂告警', Number(alerts) >= 1, alerts)
}

// ---- 定时升级：3 天升一级，7 天满级；已处理的跳过
{
  const old = new Date(Date.now() - (ESCALATE_AFTER_DAYS + 1) * 86400000).toISOString()
  db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,evidence,escalation_level)
    VALUES(?,?,?,?, 'open', ?, 'high','polarity','{}',0)`).run('cfl_slow', aid, 'x', 'y', old)
  const out = tickEscalation(db, aid)
  check('悬置 4 天被自动升级', out.some((x) => x.id === 'cfl_slow' && x.level === 1), out)
  db.prepare('UPDATE conflicts SET opened_at=? WHERE id=?').run(new Date(Date.now() - (ESCALATE_HARD_DAYS + 1) * 86400000).toISOString(), 'cfl_slow')
  tickEscalation(db, aid)
  check('悬置 8 天升到满级', Number(db.prepare('SELECT escalation_level l FROM conflicts WHERE id=?').get('cfl_slow').l) === MAX_LEVEL)
  db.prepare("UPDATE conflicts SET state='resolved', resolution='a' WHERE id=?").run('cfl_slow')
  check('已处理的不再升级', !tickEscalation(db, aid).some((x) => x.id === 'cfl_slow'))

  const early = escalateConflict(db, aid, 'cfl_slow', { reason: '手动' })
  check('已处理的冲突手动也跳过', early.state === 'resolved' && !!early.skipped, early)
}

// ---- 统计
{
  const st = conflictStats(db, aid)
  check('统计有总数与未处理数', st.total >= 2 && st.open >= 1, st)
  check('统计按级别分组', typeof st.by_level === 'object', st.by_level)
  check('统计有悬置天数', st.oldest_open_days >= 0, st.oldest_open_days)
}

// ---- 解决流程仍然可用，且留痕
{
  const c = db.prepare("SELECT id FROM conflicts WHERE agent_id=? AND state='open' LIMIT 1").get(aid)
  let n = 0
  const api = async (method, p, body = {}) => {
    const out = await handle(db, { method, path: p, body: { ...body, __idempotencyKey: 'p3' + (++n) }, token: 'user' })
    return out.body
  }
  const resolved = await api('POST', `/v1/agents/${aid}/conflicts/${c.id}`, { keep: 'b' })
  check('HTTP 解决冲突', resolved && resolved.state === 'resolved', resolved)
  const detail = await api('GET', `/v1/agents/${aid}/conflicts/${c.id}`)
  check('HTTP 冲突详情还能看到', detail && detail.id === c.id, detail && detail.id)
  const stats = await api('GET', `/v1/agents/${aid}/conflicts/stats`)
  check('HTTP 冲突统计', stats && typeof stats.total === 'number', stats)
  const list = await api('GET', `/v1/agents/${aid}/conflicts`)
  check('HTTP 冲突列表', Array.isArray(list) && list.length >= 1, Array.isArray(list) ? list.length : list)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
