/**
 * P2 会疼：说了没做到要被记下来，而且有后果。
 *   1. shadow 只记「会判成什么」，不落账
 *   2. live 记一笔 VIOLATE，π 往下走
 *   3. 同一条 30 天三次 → 自动立案（κ），这句从注入里下架
 *   4. 下一轮注入会提一句「刚才没做到」，说过就不再提
 * 运行：node test/kernel-p2.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { claimUserValue } from '../src/modules/sangguan/values_intake.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { readEvents } from '../src/modules/sangguan/ledger.js'
import { checkReply, shadowLog, pendingViolationLine, candidateClaims } from '../src/modules/sangguan/violate.js'
import { setSangguanConfig, sangguanConfig } from '../src/modules/sangguan/config.js'
import { injectView } from '../src/modules/sangguan/inject.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-kp2-'))
const db = openDb(path.join(dir, 'app.db'))
const A = 'agt_kp2'
const T0 = '2026-11-02T03:00:00.000Z'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(A, 'k', 'daily', 'active', T0)
setSangguanConfig(db, A, { enabled: true, violate: 'shadow' })
const r = claimUserValue(db, A, { key: 'benevolence', weight: 0.9 }, T0)
const cid = r.claim_id
const claims = candidateClaims(db, A)
check('候选里有刚认下的命题', claims.length === 1 && claims[0].id === cid, claims)

// 假判官：只在回复说「我不管别人了」时判违背
const judge = ({ reply }) => (/不管|懒得管/.test(reply) ? [{ claim_id: cid, why: '说不管别人了' }] : [])
const bad = '行吧，我不管别人了，随便。'

const shadow = await checkReply(db, A, { text: bad, at: T0, judge })
check('shadow 记下会判成什么', shadow.status === 'shadow' && shadow.findings.length === 1 && shadowLog(db, A).length === 1, shadow)
check('shadow 不落账', readEvents(db, A, { types: ['VIOLATE'] }).length === 0)

const clean = await checkReply(db, A, { text: '我待会儿去看看他。', at: T0, judge })
check('没踩到就是 clean', clean.status === 'clean', clean)

setSangguanConfig(db, A, { violate: 'live' })
const before = loadState(db, A).claims[cid].pi
const live = await checkReply(db, A, { text: bad, at: T0, judge })
const after = loadState(db, A).claims[cid]
check('live 真记一笔', live.status === 'violated' && readEvents(db, A, { types: ['VIOLATE'] }).length === 1, live)
check('π 往下走', after.pi < before, { before, after: after.pi })
check('这一笔能追到命题', readEvents(db, A, { types: ['VIOLATE'] })[0].payload.claim_id === cid)

// 第二、三次 → 立案
await checkReply(db, A, { text: bad, at: '2026-11-03T03:00:00.000Z', judge })
const third = await checkReply(db, A, { text: bad, at: '2026-11-04T03:00:00.000Z', judge })
const st = loadState(db, A)
const kappas = Object.values(st.kappas)
check('三次自动立案', third.escalated.length === 1 && kappas.length === 1, third)
check('立案后这句从候选里下架', candidateClaims(db, A).every((c) => c.id !== cid), candidateClaims(db, A).map((c) => c.id))
check('两句话进了交锋', Object.values(st.claims).filter((c) => c.status === 'contested').length === 2, Object.values(st.claims).map((c) => c.status))

// 注入提一句，说过不再提
setSangguanConfig(db, A, { inject: 'live' })
const v1 = injectView(db, A, { now: '2026-11-05T03:00:00.000Z', cache: false })
check('注入里提了刚才没做到', /刚才没做到|说了没做到|对不上/.test(v1.text), v1.text)
const v2 = injectView(db, A, { now: '2026-11-05T04:00:00.000Z', cache: false })
check('只提一轮', !/刚才没做到|说了没做到/.test(v2.text), v2.text)
check('过三天就不再提', pendingViolationLine(db, A, '2026-11-20T00:00:00.000Z') === null)

// 配置默认 shadow
check('默认档是 shadow', sangguanConfig(openDb(path.join(dir, 'none.db')), 'x').violate === 'shadow')

db.close()
console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
