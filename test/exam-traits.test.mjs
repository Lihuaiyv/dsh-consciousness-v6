/**
 * 鱼格零件 · 考卷
 *
 * 管的是「五条性格轴现在偏哪边，证据够不够推它一步」，以及夜里从回复和记忆里捞证据。
 * 不跑夜间整理，不调用汇流。
 *
 * 运行：node test/exam-traits.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import {
  axisWords, typeProfile, isManualAxis, sensitivityEffects, readAxes, setAxisAuto,
} from '../src/modules/traits.js'
import { srcNet, wallFactor, add, flush } from '../src/modules/rope.js'
import { echoRatio, features, isTechReply, scan } from '../src/modules/self_scan.js'
import { setLearningPrefs } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

check('全中间说中间', axisWords({}) === '中间')
check('0.60 说偏外向', axisWords({ ei: 0.6 }).includes('偏外向'))
{
  const e = typeProfile({ ei: 0.6 }).letters[0]
  check('0.60 写出 E', e.show === true && e.letter === 'E', e)
}
{
  const e = typeProfile({ ei: 0.52 }).letters[0]
  check('0.52 不写字母', e.show === false, e)
}
check('敏感轴不交给经历推', isManualAxis('sensitivity') === true && setAxisAuto(null, 'a', 'sensitivity', 0.1, 'x').skipped === 'manual-axis')
{
  const low = sensitivityEffects(0.2)
  const high = sensitivityEffects(0.8)
  check('更敏感就更响、小事也算', high.swing > low.swing && high.threshold < low.threshold, { low, high })
}
check('空来源净力是 0', srcNet(null) === 0)
check('一边全正，净力为正', srcNet({ pos: 3, neg: 0 }) > 0.5)
check('正负一样，净力是 0', srcNet({ pos: 2, neg: 2 }) === 0)
check('正中间最好推，贴墙推不动', wallFactor(0.5) === 1 && wallFactor(0.9) === 0, { mid: wallFactor(0.5), wall: wallFactor(0.9) })

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-traits-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_traits'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'traits', 'daily', 'active', now())

check('不认识的轴记不进去', add(db, aid, { axis: 'nope', dir: 1, strength: 1 }) === null)

for (let i = 0; i < 3; i++) add(db, aid, { axis: 'ei', dir: 1, strength: 1, source: 'chat' })
flush(db, aid)
check('轮次不够，三条证据也不挪', readAxes(db, aid).ei === 0.6, readAxes(db, aid))

for (let i = 0; i < 6; i++) {
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)')
    .run('t' + i, aid, 'user', '说一句', now())
}
const before = readAxes(db, aid).ei
const moved = flush(db, aid).find((x) => x.axis === 'ei' && x.why === 'rope')
const after = readAxes(db, aid).ei
check('够了六轮，同向会再推高一点', moved && after > before, { before, after, moved })
const again = readAxes(db, aid).ei
flush(db, aid)
check('同一天不再连推', readAxes(db, aid).ei === again, { again, now: readAxes(db, aid).ei })

{
  const sentence = '我们下午一起去公园慢慢散步吧'
  check('整句复读，回声是 1', echoRatio(sentence, sentence) === 1)
  check('太短不算复读', echoRatio('你好', '你好') === 0)
  check('两个机制词算讲事', isTechReply(features('为什么会这样，本质是这个')) === true)
}

const scanAid = 'agt_scan'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(scanAid, 'scan', 'daily', 'active', now())
setLearningPrefs(db, scanAid, { personaLearn: false })
const frozen = scan(db, scanAid, { since: '2026-11-01T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z', flush: false })
check('学习关掉就不扫', frozen.skipped === 'frozen' && frozen.evidence === 0, frozen)
setLearningPrefs(db, scanAid, { personaLearn: true })

const since = '2026-11-08T00:00:00.000Z'
const until = '2026-11-08T12:00:00.000Z'
db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)')
  .run('su', scanAid, 'user', '嗯', '2026-11-08T01:00:00.000Z')
db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)')
  .run('sa', scanAid, 'agent', '为什么会这样，本质是这个', '2026-11-08T02:00:00.000Z')
db.prepare(`INSERT INTO memory_items(id,agent_id,type,text,source,last_decay_at,created_at)
  VALUES(?,?,?,?,?,?,?)`).run('sm', scanAid, 'fact', '这是一条原则', 'chat', '2026-11-08T03:00:00.000Z', '2026-11-08T03:00:00.000Z')
const swept = scan(db, scanAid, { since, until, flush: false })
const replySn = (swept.items || []).find((x) => x.axis === 'sn' && x.dir === 1 && x.source === 'reply' && x.why === '打比方/讲机制')
const memSn = (swept.items || []).find((x) => x.axis === 'sn' && x.dir === 1 && x.source === 'mem' && x.why === '存的是结论')
check('回复讲机制，记成偏抽象', !!replySn, swept.items)
check('记忆写原则，记成存的是结论', !!memSn, swept.items)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
