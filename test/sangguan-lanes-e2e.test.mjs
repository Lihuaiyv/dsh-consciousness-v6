/**
 * 三观 · 整体模拟：一条经历从进来到变成注入里的两行，走完整条链路。
 * 覆盖：世界观夜巡 → 人生观周章 → 草稿五闸 → 人批入库 → 宪章 → 召回 → 注入。
 * 运行：node test/sangguan-lanes-e2e.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sge2e-'))
process.env.DSH_HOME = home
const { openDb } = await import('../src/db.js')
const api = await import('../src/api.js')
const { setSangguanConfig, sangguanConfig } = await import('../src/modules/sangguan/config.js')
const { runLaneW, runLaneL, investOf, weekBag } = await import('../src/modules/sangguan/lanes.js')
const { clusterByForegone, buildDrafts, commitDraft } = await import('../src/modules/sangguan/draft.js')
const { buildConstitution } = await import('../src/modules/sangguan/constitution.js')
const { recall } = await import('../src/modules/sangguan/recall.js')
const { injectView } = await import('../src/modules/sangguan/inject.js')
const { loadState } = await import('../src/modules/sangguan/projection.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const db = openDb(path.join(home, 'app.db'))
const aid = (await api.handle(db, { method: 'POST', path: '/v1/agents', token: 'user', body: { name: '端到端', __idempotencyKey: 'mk' } })).body.id
await api.handle(db, { method: 'PUT', path: '/v1/agents/' + aid + '/sangguan/config', token: 'user', body: { enabled: true, __idempotencyKey: 'on' } })
await setSangguanConfig(db, aid, { lanes: { W: true, L: true, V: true } })

const NOW = '2026-11-10T15:00:00.000Z'
const s0 = loadState(db, aid)
console.log('改造前：', Object.keys(s0.claims).length, '条命题')

// ---------- 料 ----------
const ep = db.prepare(`INSERT INTO episodes(id,agent_id,day,start_at,created_at,turns,title,summary,source) VALUES(?,?,?,?,?,?,?,?,?)`)
for (let i = 0; i < 3; i++) {
  const d = '2026-11-0' + (5 + i)
  ep.run('ep' + i, aid, d, d + 'T10:00:00.000Z', d + 'T11:00:00.000Z', 20, '第' + i + '天',
    ['你说难受，我先给了方案，你半天没回', '你说累，我问要不要休息，你说了很多', '你半夜说睡不着，我陪你到困'][i], 'rules')
}
const turn = db.prepare(`INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)`)
for (const day of ['2026-11-01', '2026-11-09']) {
  for (let i = 0; i < 5; i++) turn.run('rt' + day + i, aid, 's1', 't' + i, i + 1, 'assistant', '在干活', day + 'T10:0' + i + ':00.000Z', day)
}
const dy = db.prepare('INSERT INTO diaries(id,agent_id,day,text,created_at,updated_at,version,source) VALUES(?,?,?,?,?,?,?,?)')
dy.run('d1', aid, '2026-11-08', '今天一直在想，为什么你说难受我先给方案。', '2026-11-08T23:00:00.000Z', '2026-11-08T23:00:00.000Z', 1, 'test')
dy.run('d2', aid, '2026-11-09', '我好像更想做一个能把话接住的人。', '2026-11-09T23:00:00.000Z', '2026-11-09T23:00:00.000Z', 1, 'test')

check('材料：一周经历', weekBag(db, aid, NOW).episodes.length === 3)
check('材料：投入两天', investOf(db, aid, NOW).length === 2)

// ---------- W ----------
const w = await runLaneW(db, aid, NOW, {
  ask: async () => ({ ok: true, out: { candidates: [{
    belief: '人难受的时候多数不是要一个答案，是要有人先把话接住',
    kind: 'belt', scene: ['你说难受的时候', '你说累的时候', '你半夜说睡不着的时候'],
    expectation: '你倒苦水时我先给方案，你会更冷', observe: '你说完难受，我给了方案，你隔很久只回一个字',
  }] } }),
})
check('W：长出一条', w.did.length === 1, w)

// ---------- L ----------
const l = await runLaneL(db, aid, NOW, {
  ask: async () => ({ ok: true, out: { candidates: [{
    self: '我更想做一个能把话接住的人，而不是总能给出答案的人',
    direction: '学会先接住，再给方案', past: ['你说难受我给方案', '日记里发现自己在躲'],
    scene: ['你说难受的时候'],
  }] } }),
})
check('L：长出一条', l.did.length === 1, l)

// ---------- V（草稿 → 人批） ----------
const ann = [
  { ref: 'e1', at: '2026-10-30T10:00:00.000Z', alt: '按趋势补个数交差', foregone: '多花了两天', cost_to: '对方' },
  { ref: 'e2', at: '2026-11-01T10:00:00.000Z', alt: '先交一半', foregone: '又拖了一晚', cost_to: '自己' },
]
const clusters = clusterByForegone(ann)
check('草稿：聚成一簇', clusters.length === 1 && clusters[0].items.length === 2, clusters)
const drafts = await buildDrafts(db, aid, clusters, {
  at: NOW,
  ask: async () => ({ ok: true, out: { drafts: [{
    text: '数据不对的时候我会从头再跑一遍，哪怕你已经在催了',
    exclusion: '不会拿一个大概对的数交差', boundary: ['你明确说只要估算时'],
  }] } }),
})
check('草稿：过五闸', drafts.length === 1 && drafts[0].gates.pass, drafts[0] && drafts[0].gates)
const vid = commitDraft(db, aid, drafts[0], { at: NOW, human: true })
check('草稿：人批后入库', !!vid)

// ---------- 账本 ----------
const s = loadState(db, aid)
const byLayer = { W: 0, L: 0, V: 0 }
for (const c of Object.values(s.claims)) if (c.status === 'active') byLayer[c.layer] += 1
check('账本：三列各一条', byLayer.W === 1 && byLayer.L === 1 && byLayer.V === 1, byLayer)

// ---------- 宪章 ----------
const con = buildConstitution(db, aid)
check('宪章：三行', con.lines.length === 3, con.lines)
check('宪章：预算内', con.tokens <= 400, con.tokens)

// ---------- 召回 + 注入 ----------
const rec = recall(db, aid, '这个数不对，要不要重新跑')
check('召回：核心三条', rec.core.length === 3)
const view = injectView(db, aid, { now: '2026-11-10T15:05:00.000Z', query: '这个数不对，要不要重新跑' })
check('注入：走新取法', view.text.includes('你看世界的方式：') && view.text.includes('你更看重：'), view.text)
check('注入：没超预算', view.tokens <= view.budget, { t: view.tokens, b: view.budget })
check('注入：只带相关条目', view.lines.filter((x) => x.startsWith('你看世界的方式：')).length === 1, view.lines)

// ---------- 幂等 ----------
const w2 = await runLaneW(db, aid, NOW, { ask: async () => ({ ok: true, out: { candidates: [] } }) })
const l2 = await runLaneL(db, aid, NOW, { ask: async () => ({ ok: true, out: { candidates: [] } }) })
check('夜巡：同一天不重复长', w2.skipped === 'dup' && l2.skipped === 'dup')

// ---------- 开关关掉：一切照旧 ----------
const before = JSON.stringify(sangguanConfig(db, aid).lanes)
check('开关：三列都打开过', before === '{"W":true,"L":true,"V":true}')
await setSangguanConfig(db, aid, { lanes: { W: false, L: false, V: false } })
const off = injectView(db, aid, { now: '2026-11-10T15:06:00.000Z', query: '这个数不对' })
check('开关：关掉后退回旧取法', !off.text.includes('你看世界的方式：'), off.text.slice(0, 100))

console.log(`\n改造后：W ${byLayer.W} / L ${byLayer.L} / V ${byLayer.V}，宪章 ${con.tokens} token，注入 ${view.tokens} token`)
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
