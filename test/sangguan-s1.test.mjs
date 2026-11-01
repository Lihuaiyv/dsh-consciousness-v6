/**
 * 三观 S1：建表、只增触发器（I1）、ledger.append、ULID、开关。
 * 运行：node test/sangguan-s1.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { ulid, decodeTime } from '../src/modules/sangguan/ulid.js'
import { L0_TABLES, PROJ_TABLES, ensureSangguanSchema } from '../src/modules/sangguan/schema.js'
import { append, readEvents, lastSeq, hasJob, SangguanError, ConflictError } from '../src/modules/sangguan/ledger.js'
import { isEnabled, setSangguanConfig, sangguanConfig } from '../src/modules/sangguan/config.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
function throwsCode(name, fn, code, cls = SangguanError) {
  try { fn(); check(name, false, '没有抛错') } catch (e) {
    check(name, e instanceof cls && (!code || e.code === code), { code: e.code, msg: e.message })
  }
}
function throwsAny(name, fn) {
  try { fn(); check(name, false, '没有抛错') } catch { check(name, true) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg1-'))
const file = path.join(dir, 'app.db')
let db = openDb(file)
const aid = 'agt_sg1'
const T0 = '2026-11-01T00:00:00.000Z'
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n

// ---------- 建表 ----------
const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all().map((r) => r.name))
check('L0 表齐全', L0_TABLES.every((t) => names.has(t)), L0_TABLES.filter((t) => !names.has(t)))
check('投影表齐全', PROJ_TABLES.every((t) => names.has(t)), PROJ_TABLES.filter((t) => !names.has(t)))
check('只增触发器已建', L0_TABLES.every((t) => names.has('trg_' + t + '_no_update') && names.has('trg_' + t + '_no_delete')))
let again = true
try { ensureSangguanSchema(db); ensureSangguanSchema(db) } catch { again = false }
check('建表幂等', again)

// ---------- ULID ----------
const ms = Date.parse(T0)
const u = ulid(ms)
check('ULID 26 位 Crockford', /^[0-9A-HJKMNP-TV-Z]{26}$/.test(u), u)
check('ULID 时间可解', decodeTime(u) === ms, decodeTime(u))
const burst = Array.from({ length: 2000 }, () => ulid(ms + 1))
check('同毫秒严格递增', burst.every((x, i) => i === 0 || x > burst[i - 1]))
check('同毫秒无重复', new Set(burst).size === burst.length)
check('晚的毫秒排在后面', ulid(ms + 2) > burst[burst.length - 1] && ulid(ms + 2) > u)
throwsAny('ULID 拒绝非法时间', () => ulid(NaN))

// ---------- 开关 ----------
check('开关默认关闭', isEnabled(db, aid) === false && sangguanConfig(db, aid).enabled === false)
setSangguanConfig(db, aid, { enabled: true })
check('开关可打开', isEnabled(db, aid) === true)
check('开关按 agent 隔离', isEnabled(db, 'agt_other') === false)
setSangguanConfig(db, aid, { enabled: false })
check('开关可关闭', isEnabled(db, aid) === false)

// ---------- append ----------
const claimEv = (text, at = T0, extra = {}) => ({
  type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at,
  payload: { claims: [{ layer: 'W', kind: 'belt', text, origin: 'extract', boundary: [{ text: '在工作场合', testable: true }], ...extra }] },
})
const r1 = append(db, aid, [claimEv('努力通常会有回报')])
check('append 返回事件 id', Array.isArray(r1.ids) && r1.ids.length === 1 && /^[0-9A-Z]{26}$/.test(r1.ids[0]), r1)
check('append 返回新命题 id', r1.entities.claims.length === 1 && r1.entities.claims[0].startsWith('cl_'), r1.entities)
const evs = readEvents(db, aid)
check('事件可读', evs.length === 1 && evs[0].type === 'CLAIM_EXP' && evs[0].actor === 'sys' && evs[0].at === T0, evs[0])
check('payload 回读一致', evs[0].payload.claims[0].id === r1.entities.claims[0] && evs[0].payload.claims[0].text === '努力通常会有回报')
const row = db.prepare('SELECT * FROM persona_claims WHERE id=?').get(r1.entities.claims[0])
check('命题实体同步落库', row && row.agent_id === aid && row.layer === 'W' && row.kind === 'belt' && row.created_at === T0 && row.pred_json === '[]', row)
check('边界落库', row && JSON.parse(row.boundary_json)[0].testable === true, row)

const r2 = append(db, aid, [claimEv('世界大体可预测', '2026-11-01T00:01:00.000Z'), claimEv('世界本质上随机', '2026-11-01T00:01:00.000Z')])
const evs2 = readEvents(db, aid)
check('批量写入按 seq 有序', evs2.length === 3 && evs2[1].seq < evs2[2].seq && evs2[1].id === r2.ids[0] && evs2[2].id === r2.ids[1])
check('lastSeq', lastSeq(db, aid) === evs2[2].seq, lastSeq(db, aid))
check('readEvents afterSeq', readEvents(db, aid, { afterSeq: evs2[0].seq }).length === 2)
check('readEvents types', readEvents(db, aid, { types: ['JOB_DONE'] }).length === 0)
check('agent 隔离', readEvents(db, 'agt_other').length === 0)

// ---------- I1 只增 ----------
const nEv = count('claim_events')
throwsAny('I1 claim_events 拒绝 UPDATE', () => db.prepare("UPDATE claim_events SET type='X'").run())
throwsAny('I1 claim_events 拒绝 DELETE', () => db.prepare('DELETE FROM claim_events').run())
throwsAny('I1 persona_claims 拒绝改 text', () => db.prepare("UPDATE persona_claims SET text='改过'").run())
throwsAny('I1 persona_claims 拒绝 DELETE', () => db.prepare('DELETE FROM persona_claims').run())
{
  // 行级触发器只对存在的行生效：另开一个库，每张 L0 表各插一行再试
  const scratch = openDb(path.join(dir, 'scratch.db'))
  const rows = {
    claim_events: "INSERT INTO claim_events(id,agent_id,at,type,actor) VALUES('e1','a','t','REJECT','sys')",
    persona_claims: "INSERT INTO persona_claims(id,agent_id,layer,kind,text,origin,created_at) VALUES('c1','a','W','belt','x','user','t')",
    claim_questions: "INSERT INTO claim_questions VALUES('q1','a','W','x','t')",
    claim_kappa: "INSERT INTO claim_kappa VALUES('k1','a','W','q1','c1','c2','d','e','t')",
    claim_predictions: "INSERT INTO claim_predictions VALUES('n1','a','c1','x','y',0.5,'t','t')",
    claim_evidence: "INSERT INTO claim_evidence VALUES('x1','a','act','claim','c1',1,0.6,'r',NULL,'t')",
    claim_edges: "INSERT INTO claim_edges VALUES('d1','a','DEPENDS','c1','c2','t')",
    claim_summaries: "INSERT INTO claim_summaries VALUES('s1','a','W','chapter',1,2,'x','t')",
  }
  for (const t of L0_TABLES) {
    scratch.exec(rows[t])
    throwsAny('I1 ' + t + ' 拒绝 UPDATE', () => scratch.prepare(`UPDATE ${t} SET agent_id='b'`).run())
    throwsAny('I1 ' + t + ' 拒绝 DELETE', () => scratch.prepare(`DELETE FROM ${t}`).run())
    check('I1 ' + t + ' 行还在', scratch.prepare(`SELECT COUNT(*) n FROM ${t} WHERE agent_id='a'`).get().n === 1)
  }
  scratch.close()
}
check('I1 之后数据未变', count('claim_events') === nEv && db.prepare('SELECT text FROM persona_claims WHERE id=?').get(r1.entities.claims[0]).text === '努力通常会有回报')

// ---------- 校验：失败不写 ----------
const before = lastSeq(db, aid)
throwsCode('未知事件类型', () => append(db, aid, [{ type: 'NOPE', actor: 'sys', at: T0, payload: {} }]), 'INVALID')
throwsCode('非法 actor', () => append(db, aid, [{ ...claimEv('x1'), actor: 'model' }]), 'INVALID')
throwsCode('缺时间', () => append(db, aid, [{ ...claimEv('x2'), at: undefined }]), 'INVALID')
throwsCode('非法时间', () => append(db, aid, [{ ...claimEv('x3'), at: '昨天' }]), 'INVALID')
throwsCode('非法层', () => append(db, aid, [{ ...claimEv('x4'), layer: 'X' }]), 'INVALID')
throwsCode('缺层', () => append(db, aid, [{ ...claimEv('x5'), layer: undefined }]), 'INVALID')
throwsCode('命题缺 text', () => append(db, aid, [claimEv('')]), 'INVALID')
throwsCode('种类不属于该层', () => append(db, aid, [claimEv('x6', T0, { kind: 'telos' })]), 'INVALID')
throwsCode('命题层与事件层不符', () => append(db, aid, [claimEv('x7', T0, { layer: 'L', kind: 'chapter' })]), 'INVALID')
throwsCode('非法 origin', () => append(db, aid, [claimEv('x8', T0, { origin: 'dream' })]), 'INVALID')
throwsCode('不该带实体的事件', () => append(db, aid, [{ type: 'EVIDENCE', actor: 'user', at: T0, payload: { claims: [{ layer: 'W', kind: 'belt', text: 'x', origin: 'user' }], evidence: [] } }]), 'INVALID')
throwsCode('实体数目不对', () => append(db, aid, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: T0, payload: { claims: [] } }]), 'INVALID')
throwsCode('缺必填字段', () => append(db, aid, [{ type: 'CON', layer: 'W', actor: 'sys', at: T0, payload: {} }]), 'INVALID')
throwsCode('空批次', () => append(db, aid, []), 'INVALID')
throwsCode('自带 id 重复', () => append(db, aid, [claimEv('x9', T0, { id: r1.entities.claims[0] })]), 'INVALID')
check('校验失败什么都没写', lastSeq(db, aid) === before && count('persona_claims') === 3)

// ---------- I6 原子：一条坏，整批不写 ----------
throwsCode('I6 坏事件拖垮整批', () => append(db, aid, [claimEv('好的一条'), { ...claimEv('坏的一条'), actor: '??' }]), 'INVALID')
check('I6 整批回滚', lastSeq(db, aid) === before && count('persona_claims') === 3)

// ---------- JOB_DONE 幂等键 ----------
const job = { type: 'JOB_DONE', actor: 'sys', at: T0, job_key: 'sg:night:2026-11-01', payload: {} }
check('任务未跑过', hasJob(db, aid, 'sg:night:2026-11-01') === false)
append(db, aid, [job])
check('任务已记', hasJob(db, aid, 'sg:night:2026-11-01') === true)
throwsCode('同键第二次拒绝', () => append(db, aid, [job]), 'DUP_JOB', ConflictError)
check('同键只有一条', db.prepare("SELECT COUNT(*) n FROM claim_events WHERE type='JOB_DONE'").get().n === 1)
append(db, 'agt_other', [job])
check('不同 agent 同键可写', hasJob(db, 'agt_other', 'sg:night:2026-11-01'))
throwsCode('JOB_DONE 必须带键', () => append(db, aid, [{ ...job, job_key: '' }]), 'INVALID')

// ---------- 外层事务：append 可嵌套 ----------
db.exec('BEGIN')
append(db, aid, [claimEv('外层事务里写的')])
db.exec('ROLLBACK')
check('外层回滚连带回滚', count('persona_claims') === 3 && lastSeq(db, aid) === before + 1)

// ---------- 重开库 ----------
db.close()
db = openDb(file)
check('重开后事件仍在', readEvents(db, aid).length === 4)
throwsAny('重开后触发器仍生效', () => db.prepare('DELETE FROM claim_events').run())

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
