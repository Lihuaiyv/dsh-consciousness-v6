/**
 * P3 会欠账：承诺 → ν → 到期结算。
 *   1. 抽取只认「承诺词 + 期限词」，否定句和问句不记
 *   2. 同一条 7 天内不重复记
 *   3. 到期没做到 → miss（不是 void），兑现率因此有分母
 *   4. 兑现率能从 scorecard 读出来
 * 运行：node test/kernel-p3.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { extractPledges, registerPledges, dueOf, confirmNu, pledgeMissLine } from '../src/modules/sangguan/pledge.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { readEvents } from '../src/modules/sangguan/ledger.js'
import { checkDue } from '../src/modules/sangguan/practice.js'
import { scorecard } from '../src/modules/sangguan/score.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { injectView } from '../src/modules/sangguan/inject.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-kp3-'))
const db = openDb(path.join(dir, 'app.db'))
const A = 'agt_kp3'
const T = '2026-11-02T03:00:00.000Z' // 周一
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(A, 'k', 'daily', 'active', T)
setSangguanConfig(db, A, { enabled: true })

// 1) 抽取：该记的记，不该记的不记
check('带期限的承诺抽得出', extractPledges('好，我明天去看看他。', T).length === 1)
check('没有期限不记', extractPledges('我会照顾好自己的。', T).length === 0)
check('否定句不记', extractPledges('我明天不会去了。', T).length === 0)
check('问句不记', extractPledges('我明天去吗？', T).length === 0)
check('一句最多抽两条', extractPledges('我明天修好它。我后天把报告发你。我下周再核对一遍。', T).length === 2)

// 2) 期限解析
check('明天落在明天晚上', dueOf('明天', T).slice(0, 10) === '2026-11-03')
check('待会落在三小时内', Date.parse(dueOf('待会再说', T)) - Date.parse(T) === 3 * 3600e3)
check('下周一说的是下一个周一', dueOf('下周一', T).slice(0, 10) === '2026-11-09', dueOf('下周一', T))

// 3) 登记：命题 + ν，各一条
const r1 = registerPledges(db, A, { text: '好，我明天去看看他。', at: T })
const st1 = loadState(db, A)
check('承诺落成一条命题', r1.registered.length === 1 && Object.values(st1.claims).length === 1, r1)
check('同时登记一条 ν', Object.values(st1.nus).length === 1 && st1.nus[r1.registered[0].nu_id].due_at.slice(0, 10) === '2026-11-03')
check('命题文本是「我答应：…」', Object.values(st1.claims)[0] && db.prepare('SELECT text FROM persona_claims WHERE id=?').get(r1.registered[0].claim_id).text.startsWith('我答应：'))

// 4) 同一句七天内不重复记
const r2 = registerPledges(db, A, { text: '好，我明天去看看他。', at: '2026-11-03T03:00:00.000Z' })
check('七天内不重复记', r2.registered.length === 0 && r2.skipped[0].reason === 'dup', r2)

// 5) 到期没记录 → miss（不是 void）
const night = await checkDue(db, A, '2026-11-04T03:00:00.000Z', { force: true })
const st2 = loadState(db, A)
const nu = Object.values(st2.nus)[0]
check('到期结算成 miss', nu.outcome === 'miss' && night.did.some((d) => d.outcome === 'miss'), { nu, night })
check('有一笔负证据追到 ν', readEvents(db, A, { types: ['EVIDENCE'] }).some((e) => e.payload.evidence[0].target_type === 'nu' && e.payload.evidence[0].sign === -1))

// 6) 兑现率有分母
const sc = scorecard(db, A, { now: '2026-11-05T03:00:00.000Z' })
check('兑现率读得出来（这次 0）', sc.nu.settled === 1 && sc.nu.kept_rate === 0, sc.nu)
check('内核的「欠账」一项成立', sc.kernel.debt === true, sc.kernel)

// 7) 第二条承诺也登记（不改表：ν 只增）
registerPledges(db, A, { text: '我明天把报告发你。', at: '2026-11-05T03:00:00.000Z' })
check('第二条承诺也登记了', Object.values(loadState(db, A).nus).length === 2)

// 8) 条件句不算承诺（A4）
check('条件句不登记', extractPledges('如果明天不下雨，我就去看看他。', T).length === 0)
check('除非句不登记', extractPledges('除非他先道歉，我明天才去。', T).length === 0)

// 9) 确认兑现：人替它记一笔，到期不再冤判 miss（A4）
const r4 = registerPledges(db, A, { text: '我后天把东西修好。', at: '2026-11-10T03:00:00.000Z' })
const nu4 = r4.registered[0].nu_id
confirmNu(db, A, { nu_id: nu4, outcome: 'hit', note: '他自己发照片了' }, '2026-11-10T06:00:00.000Z')
const night4 = await checkDue(db, A, '2026-11-13T03:00:00.000Z', { force: true })
check('确认做到后结算成 hit', night4.did.some((d) => d.id === nu4 && d.outcome === 'hit'), night4)

// 10) 欠账会提一次（A9）
setSangguanConfig(db, A, { inject: 'live' })
const ml = pledgeMissLine(db, A, '2026-11-04T03:00:00.000Z')
check('欠账能生成提醒', !!(ml && /欠着|没做到/.test(ml.line)), ml)
const v1 = injectView(db, A, { now: '2026-11-04T03:00:00.000Z', cache: false })
check('提醒进了注入', /欠着|没做到/.test(v1.text), v1.text)
const v2 = injectView(db, A, { now: new Date(Date.parse('2026-11-04T03:00:00.000Z') + 1000).toISOString(), cache: false })
check('只提一次', !/欠着|没做到/.test(v2.text), v2.text)

db.close()
console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
