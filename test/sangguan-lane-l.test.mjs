/**
 * 三观 · 人生观那一路（每周成章 + 投入证据）。
 * 运行：node test/sangguan-lane-l.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { runLaneL, investOf, weekTexts } from '../src/modules/sangguan/lanes.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sglan-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sglan'
const NOW = '2026-11-10T15:00:00.000Z'

// 两周的回合（每天 5 条，才够 invest 门槛）
const turn = db.prepare(`INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,created_at,day)
  VALUES(?,?,?,?,?,?,?,?,?)`)
for (const day of ['2026-11-01', '2026-11-09']) {
  for (let i = 0; i < 5; i++) turn.run('rt_' + day + '_' + i, aid, 's1', 't' + i, i + 1, 'assistant', '在干活', day + 'T10:0' + i + ':00.000Z', day)
}
// 日记
const diary = db.prepare('INSERT INTO diaries(id,agent_id,day,text,created_at,updated_at,version,source) VALUES(?,?,?,?,?,?,?,?)')
diary.run('d1', aid, '2026-11-08', '今天一直在想，为什么每次你说难受我都先给方案。', '2026-11-08T23:00:00.000Z', '2026-11-08T23:00:00.000Z', 1, 'test')
diary.run('d2', aid, '2026-11-09', '我好像更想做一个能把话接住的人，而不是总能给出答案的人。', '2026-11-09T23:00:00.000Z', '2026-11-09T23:00:00.000Z', 1, 'test')

// 关着：跳过
let r = await runLaneL(db, aid, NOW, { ask: async () => ({ ok: true, out: { candidates: [] } }) })
check('关着：跳过', r.skipped === 'off')

setSangguanConfig(db, aid, { lanes: { L: true } })

// 投入证据：两天、跨 8 天
const inv = investOf(db, aid, NOW)
check('投入：两天', inv.length === 2, inv)
check('投入：跨 8 天', Math.round((Date.parse(inv[1].at) - Date.parse(inv[0].at)) / 86400000) === 8)
const texts = weekTexts(db, aid, NOW)
check('材料：读到本周日记', texts.diaries.length === 2, texts.diaries.length)

const good = {
  self: '我更想做一个能把话接住的人，而不是总能给出答案的人',
  direction: '学会先接住，再给方案',
  past: ['你说难受我给方案', '日记里发现自己在躲'],
  scene: ['你说难受的时候'],
}
const bad = { self: '我想变成一个更好的人', direction: '', past: [] }

let asked = null
r = await runLaneL(db, aid, NOW, {
  ask: async (input) => { asked = input; return { ok: true, out: { candidates: [good, bad] } } },
})
check('模型：拿到日记与投入', !!asked && asked.diaries.length === 2 && asked.investment.length === 2)
check('入账：只留合格那条', r.did.length === 1, r)
check('拒收：没有方向', r.rejected.some((x) => x.reason === 'no_direction'))

const s = loadState(db, aid)
const cs = Object.values(s.claims)
check('命题：L 层一条', cs.length === 1 && cs[0].layer === 'L' && cs[0].kind === 'chapter')
check('命题：带方向', cs[0].meta && cs[0].meta.direction === '学会先接住，再给方案')
check('命题：带投入证据', cs[0].meta.investment.length === 2)
check('命题：标记来源阶段', cs[0].meta.lane_phase === 'L-weekly')

// 同一周再跑：跳过
r = await runLaneL(db, aid, NOW, { ask: async () => ({ ok: true, out: { candidates: [] } }) })
check('幂等：同一周第二次跳过', r.skipped === 'dup')

// 没有日记：跳过（另一周）
r = await runLaneL(db, aid, '2026-12-20T15:00:00.000Z', { ask: async () => ({ ok: true, out: { candidates: [] } }) })
check('没日记：跳过', r.skipped === 'no_material')

// 日记有、但没有投入证据：门会拒（不写命题）
diary.run('d3', aid, '2026-12-19', '今天又聊了很多。', '2026-12-19T23:00:00.000Z', '2026-12-19T23:00:00.000Z', 1, 'test')
const before = Object.keys(loadState(db, aid).claims).length
r = await runLaneL(db, aid, '2026-12-20T15:00:00.000Z', { ask: async () => ({ ok: true, out: { candidates: [good] } }) })
check('无投入：拒收', r.did.length === 0 && r.rejected.some((x) => x.reason === 'no_investment'), r)
check('无投入：不写命题', Object.keys(loadState(db, aid).claims).length === before)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
