/**
 * 三观 G6：冲突过不了闸门则 κ 不变；同一记忆不种两次；关系门槛只报一次；
 * 说话令牌用尽时提问算冷却；对不上的行动结局不入账。
 * 运行：node test/sangguan-g6.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append } from '../src/modules/sangguan/ledger.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { bufferOf, placeOne } from '../src/modules/sangguan/fast.js'
import { intakeCandidates, intakeNotices, intakeActs, askBlocked } from '../src/modules/sangguan/intake.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg6-'))
const db = openDb(path.join(dir, 'app.db'))
const T0 = '2026-11-01T12:00:00.000Z'
const aid = 'agt_g6'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(aid, aid, 'daily', 'active', T0)
setSangguanConfig(db, aid, { enabled: true })

const mem = (id, type, text) => db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
  last_decay_at,valid_at,invalid_at,status,created_at,deleted_at,version)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, aid, type, 'normal', text, 'manual', 0.5, 0.5, 1, 5, T0, null, null, 'active', T0, null, 1)

mem('ma', 'fact', '你必须每次回答都要用中文')
mem('mb', 'fact', '你必须每次回复都要称呼主人')
db.prepare('INSERT INTO conflicts(id,agent_id,a_id,b_id,state) VALUES(?,?,?,?,?)').run('cf1', aid, 'ma', 'mb', 'open')
mem('mr', 'aspiration', '我想把这段日子慢慢串起来')
// 每轮 summarize 出来的「用户画像」是 reflection，不是它的立场；不能再被种成人生观
mem('ms', 'reflection', '1. 事实：用户只问了一句「在吗」。 2. 偏好与情绪：未见明确偏好。 3. 边界：未说明。')

{
  const first = intakeCandidates(db, aid)
  check('冲突和志向都进候选，画像总结不进', first.length === 3 && !first.some((x) => /用户|事实|边界/.test(x.text)), first.map((x) => x.kind))
  for (const x of first) await placeOne({ db, aid, at: T0, embed: async () => null }, { layer: x.layer, kind: x.kind, text: x.text }, [x.ref])
  const s = loadState(db, aid)
  check('闸门不过则 κ 数不变', Object.keys(s.kappas).length === 0)
  check('指令句没有变成命题', !Object.values(s.claims).some((c) => c.layer === 'W'))
  check('志向种成一条', Object.values(s.claims).filter((c) => c.layer === 'L').length === 1)
  const second = intakeCandidates(db, aid)
  check('同一记忆不会种出两条', second.length === 0 && Object.values(loadState(db, aid).claims).length === 1, second)
}

db.prepare(`INSERT INTO rel_tier(tier,label,warmth,formality,initiative,disclosure,detail_level,init_closeness,init_trust,init_dependence,sort)
  VALUES('owner','主人',0.8,0.2,0.5,0.7,3,0.7,0.7,0.2,0)`).run()
db.prepare(`INSERT INTO rel_person(id,agent_id,name,tier,closeness,trust,dependence,first_seen_at,last_seen_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('rp1', aid, '小周', 'owner', 0.8, 0.7, 0.5, T0, T0, T0, T0)
{
  const a = intakeNotices(db, aid)
  const b = intakeNotices(db, aid)
  const turns = bufferOf(db, aid).turns.filter((t) => String(t.ref).startsWith('rel:'))
  check('关系门槛只报一次', a.notices === 3 && b.notices === 0 && turns.length === 3, { a, b, n: turns.length })
  check('系统回合不带结论', turns.every((t) => t.role === 'system' && /跨过了往常的线/.test(t.text) && !/所以|因此|我相信/.test(t.text)), turns)
}

db.prepare('INSERT INTO drive_state VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
  aid, 0.5, 0.5, 0.2, 0.5, 0.5, JSON.stringify({ C: 0.6, A: 0.6, R: 0.6, E: 0.6, S: 0.6 }),
  'D0', 0, JSON.stringify({ c1: 0, c2: 0, c3: 0, c4: 0 }), T0, T0, null, null, '{}',
)
{
  check('说话令牌用尽则提问被挡住', askBlocked(db, aid) === true)
  db.prepare('UPDATE drive_state SET tokens=? WHERE agent_id=?').run(JSON.stringify({ c4: 4 }), aid)
  check('令牌还在就不挡', askBlocked(db, aid) === false)
  const gap = bufferOf(db, aid).turns.filter((t) => t.ref === 'gap:c')
  intakeNotices(db, aid)
  const gap2 = bufferOf(db, aid).turns.filter((t) => t.ref === 'gap:c')
  check('成就缺口只报一次', gap.length === 0 && gap2.length === 1, gap2)
}

{
  const claim = append(db, aid, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: T0, payload: { claims: [{ layer: 'W', kind: 'belt', text: '努力通常会有回报', origin: 'extract' }] } }]).entities.claims[0]
  const due = '2026-11-04T12:00:00.000Z'
  const nu = append(db, aid, [{ type: 'NU_REGISTER', actor: 'sys', at: T0, payload: { nus: [{ claim_id: claim, expect: '下周能做成', observe: '做成了没有', p: 0.6, due_at: due }] } }]).entities.nus[0]
  db.prepare('INSERT INTO action_log(id,agent_id,port,payload,status,created_at) VALUES(?,?,?,?,?,?)').run('act_bad', aid, 'remind', JSON.stringify({ nu_id: 'nu_missing' }), 'done', T0)
  const bad = intakeActs(db, aid, '2026-11-02T00:00:00.000Z')
  check('对不上的行动结局被拒绝', bad.written === 0 && bad.rejected === 1 && db.prepare('SELECT COUNT(*) n FROM claim_evidence').get().n === 0, bad)
  db.prepare('INSERT INTO action_log(id,agent_id,port,payload,status,created_at) VALUES(?,?,?,?,?,?)').run('act_ok', aid, 'remind', JSON.stringify({ nu_id: nu, sign: 1 }), 'done', T0)
  const ok = intakeActs(db, aid, '2026-11-02T01:00:00.000Z')
  check('对得上的行动结局写成 act', ok.written === 1 && loadState(db, aid).claims[claim].n === 1, ok)
}

console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
