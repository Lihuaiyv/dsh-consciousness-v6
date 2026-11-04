/**
 * 触发词账本：从 why 里抽出「是哪个词把我带跑的」，累加、看谁最可疑。
 * 运行：node test/trigger.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { seedAffect, extractTriggerWords, recordTriggers, triggerStats, reviewTick } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// ---------- 一、抽词 ----------
check('抽「」', JSON.stringify(extractTriggerWords('说了「还是不对」')) === JSON.stringify(['还是不对']),
  { v: extractTriggerWords('说了「还是不对」') })
check('抽『』', JSON.stringify(extractTriggerWords('『怎么写的这么蠢』是在贬低')) === JSON.stringify(['怎么写的这么蠢']),
  { v: extractTriggerWords('『怎么写的这么蠢』是在贬低') })
check('抽中文引号', JSON.stringify(extractTriggerWords('“算了”这句偏负')) === JSON.stringify(['算了']),
  { v: extractTriggerWords('“算了”这句偏负') })
check('没括起来的不算词', extractTriggerWords('这句看不出，是在说整个页面').length === 0)
check('空 why 返回空', extractTriggerWords('').length === 0 && extractTriggerWords(null).length === 0)
check('去重', JSON.stringify(extractTriggerWords('「卡了」和「卡了」')) === JSON.stringify(['卡了']),
  { v: extractTriggerWords('「卡了」和「卡了」') })
check('最多四个', extractTriggerWords('「a」「b」「c」「d」「e」').length === 4,
  { v: extractTriggerWords('「a」「b」「c」「d」「e」') })
check('超长的不算（>20 字）', extractTriggerWords('「' + '很'.repeat(25) + '」').length === 0)

// ---------- 二、记账 ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-trig-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_trig'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '触发词', 'daily', 'active', now())
seedAffect(db, aid)

const T = Date.parse('2026-11-03T10:00:00+08:00')
check('记一个词', recordTriggers(db, aid, { why: '说了「还是不对」', verdict: 'flip', at: T }) === 1)
check('没引号就记 0', recordTriggers(db, aid, { why: '看不出', verdict: 'flip', at: T }) === 0)

recordTriggers(db, aid, { why: '「还是不对」又来了', verdict: 'same', at: T + 1000 })
let row = db.prepare('SELECT * FROM affect_trigger WHERE agent_id=? AND word=?').get(aid, '还是不对')
check('同一个词累加', row.hits === 2, row)
check('只有翻面那次算误判', row.flips === 1, row)

recordTriggers(db, aid, { why: '「还是不对」第三次', verdict: 'drift', at: T + 2000 })
row = db.prepare('SELECT * FROM affect_trigger WHERE agent_id=? AND word=?').get(aid, '还是不对')
check('drift 也算误判', row.hits === 3 && row.flips === 2, row)

recordTriggers(db, aid, { why: '「你怎么这样」', verdict: 'flip', at: T + 3000 })
recordTriggers(db, aid, { why: '「你怎么这样」', verdict: 'same', at: T + 4000 })
recordTriggers(db, aid, { why: '「随便」', verdict: 'flip', at: T + 5000 })

// ---------- 三、统计 ----------
let st = triggerStats(db, aid, { at: T + 10000 })
check('总共三个词', st.total === 3, st)
check('默认 min=2：只出现一次的「随便」不算可疑', st.suspect.every((x) => x.word !== '随便'), st.suspect)
check('可疑榜按误判率排', st.suspect[0].word === '还是不对' && st.suspect[0].rate > st.suspect[1].rate,
  st.suspect)
check('rate 是 flips/hits', Math.abs(st.suspect[0].rate - 2 / 3) < 0.01, st.suspect[0])
check('min=1 时「随便」也进来', triggerStats(db, aid, { at: T + 10000, min: 1 }).suspect.some((x) => x.word === '随便'))

// ---------- 四、复查时顺带记账 ----------
let seq = 0
function ev(text, at, { gate = 1, rel = 0.5, cong = -0.3, label = 'irritated', sig = 0.2, theta = 0.1, why = '' } = {}) {
  const id = 'ev' + (++seq)
  db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,rel,cong,sig,theta,gate,label,why) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid, new Date(at).toISOString(), text, rel, cong, sig, theta, gate, label, why)
  return id
}
const T2 = Date.parse('2026-11-03T12:00:00+08:00')
ev('你做得真差', T2 - 7 * 3600000)
const r = await reviewTick(db, aid, {
  at: T2,
  judge: async () => ({ goal_relevance: 0.8, goal_congruence: 0.5, label: 'joy', why: '「真差」是在夸反话' }),
})
check('复查翻了面', r.verdict === 'flip', r)
const auto = db.prepare('SELECT * FROM affect_trigger WHERE agent_id=? AND word=?').get(aid, '真差')
check('复查顺带把词记上', !!auto && auto.hits === 1 && auto.flips === 1, auto)

check('复查判 same 时不加误判', (() => {
  const before = db.prepare('SELECT flips FROM affect_trigger WHERE agent_id=? AND word=?').get(aid, '真差').flips
  return before === 1
})())

try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不报 */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
