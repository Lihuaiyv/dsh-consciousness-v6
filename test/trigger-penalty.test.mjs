/**
 * 第四步：触发词账本反哺。
 * 一个词被复查证明总判歪，以后遇到它就把关切度收一成——只降不升。
 * 运行：node test/trigger-penalty.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { seedAffect, appraise, recordTriggers, refreshPenalty, badWordsOf, triggerStats } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-pen-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_pen'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '反哺', 'daily', 'active', now())
seedAffect(db, aid)

// ---------- 一、门槛 ----------
const T = Date.now()
/* 「还是不对」：出现 4 次，判歪 3 次（0.75）→ 够格 */
for (let i = 0; i < 4; i++) {
  recordTriggers(db, aid, { why: '「还是不对」这句', verdict: i < 3 ? 'flip' : 'same', at: T + i })
}
/* 「随便」：出现 4 次，判歪 1 次（0.25）→ 不够格 */
for (let i = 0; i < 4; i++) {
  recordTriggers(db, aid, { why: '「随便」这句', verdict: i === 0 ? 'flip' : 'same', at: T + i })
}
/* 「算了」：出现 2 次，判歪 2 次（1.0）但次数不够 → 不够格 */
for (let i = 0; i < 2; i++) {
  recordTriggers(db, aid, { why: '「算了」这句', verdict: 'flip', at: T + i })
}

check('够格的只有「还是不对」', JSON.stringify(badWordsOf(db, aid)) === JSON.stringify(['还是不对']),
  { v: badWordsOf(db, aid) })
refreshPenalty(db, aid)
const pen = db.prepare('SELECT word,penalty FROM affect_trigger WHERE agent_id=? ORDER BY word').all(aid)
check('只给够格的打戳', pen.find((p) => p.word === '还是不对').penalty === 1, pen)
check('比例不够的不打戳', pen.find((p) => p.word === '随便').penalty === 0, pen)
check('次数不够的不打戳', pen.find((p) => p.word === '算了').penalty === 0, pen)

// ---------- 二、命中就降一成 ----------
const LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
const baseHint = {
  kind: 'eval', polarity: -0.5,
  goal_relevance: 0.8, goal_congruence: -0.5,
  certainty: 0.8, novelty: 0.3, source: 'model',
  label: 'irritated', why: '在纠错', target: 'me',
}
const last = () => db.prepare('SELECT * FROM affect_events WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)

await appraise(db, aid, '还是不对，重来', { labels: LABELS, hint: baseHint })
const hit = last()
await appraise(db, aid, '把表格导出一下', { labels: LABELS, hint: baseHint })
const miss = last()
console.log('命中 rel:', hit.rel, '未命中 rel:', miss.rel)
check('命中的关切度被收了一成', Math.abs(Number(hit.rel) - Number(miss.rel) * 0.9) < 0.02, { hit: hit.rel, miss: miss.rel })
check('打上了 known_bad_word 的戳', hit.why_flag === 'known_bad_word', { flag: hit.why_flag })
check('没命中的不打卡', miss.why_flag !== 'known_bad_word', { flag: miss.why_flag })

// ---------- 三、只降不升 ----------
check('降权之后还是正关切（不是判成没事）', Number(hit.rel) > 0.5, { rel: hit.rel })
check('降权不会把方向翻过来', Number(hit.cong) <= 0, { cong: hit.cong })

// ---------- 四、关掉就不生效 ----------
setParam(db, aid, 'affect.trigger.enabled', { value: 0 })
await appraise(db, aid, '还是不对，再来', { labels: LABELS, hint: baseHint })
const off = last()
check('关掉之后不降权', Math.abs(Number(off.rel) - Number(miss.rel)) < 0.02, { off: off.rel, base: miss.rel })
check('关掉之后也不打卡', off.why_flag !== 'known_bad_word', { flag: off.why_flag })

// ---------- 五、门槛可以调 ----------
setParam(db, aid, 'affect.trigger.enabled', { value: 1 })
check('门槛放低到 1 次，「算了」也算', badWordsOf(db, aid, { minFlips: 1, rate: 1 }).includes('算了'),
  { v: badWordsOf(db, aid, { minFlips: 1, rate: 1 }) })
check('比例要求放低，「随便」也算', badWordsOf(db, aid, { minFlips: 1, rate: 0.2 }).includes('随便'),
  { v: badWordsOf(db, aid, { minFlips: 1, rate: 0.2 }) })

// ---------- 六、复查之后会自动刷新戳 ----------
db.prepare('UPDATE affect_trigger SET penalty=0 WHERE agent_id=?').run(aid)
refreshPenalty(db, aid)
const again = db.prepare('SELECT word,penalty FROM affect_trigger WHERE agent_id=? AND word=?').get(aid, '还是不对')
check('再刷一次戳能恢复', again.penalty === 1, again)

const st = triggerStats(db, aid, { days: 30, min: 1 })
check('统计里还看得见这些词', st.total === 3, st)

try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
