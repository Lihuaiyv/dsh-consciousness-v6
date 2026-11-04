/**
 * 原话层（quote_echo）的独立测试：不依赖宿主，只开一个临时库。
 * 用法：node --experimental-sqlite test/quote-echo.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { worthKeeping, captureQuote, quoteCandidate, commitQuote, heatOfQuote } from '../src/modules/quote_echo.js'
import { bandOf } from '../src/modules/tiers.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-quote-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_quote_test'
const nowIso = new Date().toISOString()
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '原话测试', 'chat', 'active', nowIso)

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name) } else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail)) }
}

const T0 = Date.parse('2026-11-03T08:00:00Z')

check('有笑字的留着', worthKeeping('小圈怎么歪歪扭扭的，很可爱', '嗯', 0) === true)
check('工作汇报不留', worthKeeping('把刚才那三处改完再跑一遍测试', '好', 0) === false)
check('太长的不整句留', worthKeeping('长'.repeat(300), '好', 0) === false)
check('情绪够的也留', worthKeeping('今天有点烦', '嗯', 0.6) === true)

const c1 = captureQuote(db, aid, { user: '小圈怎么歪歪扭扭的，很可爱', agent: '正圆像盖章，歪的像随手画的。', at: T0 })
check('存下这一条', !!(c1 && c1.id), c1)

const cand = quoteCandidate(db, aid, T0 + 3600000)
check('一小时后能取到', !!cand, cand)
check('回放的是原话', !!cand && cand.line.includes('小圈怎么歪歪扭扭的，很可爱'), cand)
check('没压成结论', !!cand && !cand.line.includes('喜欢'), cand)
check('落账', commitQuote(db, aid, cand, T0 + 3600000) === true, null)
check('四十五分钟内不再放', quoteCandidate(db, aid, T0 + 3600000 + 60000) === null, null)
check('同一条三天内不重复', quoteCandidate(db, aid, T0 + 3600000 + 46 * 60000) === null, null)
check('三天后可以再放', !!quoteCandidate(db, aid, T0 + 3.1 * 86400000), null)

const h0 = heatOfQuote({ created_at: new Date(T0).toISOString() }, 0, T0)
const h1 = heatOfQuote({ created_at: new Date(T0).toISOString() }, 0, T0 + 4 * 86400000)
const h2 = heatOfQuote({ created_at: new Date(T0).toISOString() }, 4, T0 + 4 * 86400000)
check('越放越凉', h0 > h1, { h0, h1 })
check('想起一次就焐热', h2 > h1, { h2, h1 })

const raw = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='quote.moment'").get(aid).n
check('只追加不覆盖', raw === 1, raw)

// 结论是便利贴：三十天没人想起过的结论，降长期档；原话不受这条影响。
const oldReflection = {
  type: 'reflection', importance: 0.8, salience: 0.5, hits: 0,
  created_at: new Date(Date.now() - 31 * 86400000).toISOString(),
}
check('三十天没想起的结论降长期档', bandOf(oldReflection) === 'long', bandOf(oldReflection))
const youngReflection = { ...oldReflection, created_at: new Date(Date.now() - 3 * 86400000).toISOString() }
check('新结论照常短期档', bandOf(youngReflection) === 'short', bandOf(youngReflection))

console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail ? 1 : 0)
