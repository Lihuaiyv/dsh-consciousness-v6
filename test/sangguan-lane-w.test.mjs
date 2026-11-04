/**
 * 三观 · 世界观那一路（夜巡批量归纳）。
 * 运行：node test/sangguan-lane-w.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { runLaneW, weekBag } from '../src/modules/sangguan/lanes.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgwan-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sgwan'
const NOW = '2026-11-10T15:00:00.000Z'

// 一周的经历
const ins = db.prepare(`INSERT INTO episodes(id,agent_id,day,start_at,created_at,turns,title,summary,source)
  VALUES(?,?,?,?,?,?,?,?,?)`)
for (let i = 0; i < 3; i++) {
  const d = '2026-11-0' + (5 + i)
  ins.run('ep_t' + i, aid, d, d + 'T10:00:00.000Z', d + 'T11:00:00.000Z', 20, '第' + i + '天',
    i === 0 ? '你说难受，我先给了方案，你半天没回' : i === 1 ? '你说累，我问要不要休息，你说了很多' : '你半夜说睡不着，我陪你聊到困', 'rules')
}

const good = {
  belief: '人难受的时候多数不是要一个答案，是要有人先把话接住',
  kind: 'belt',
  scene: ['你说难受的时候', '你说累的时候', '你半夜说睡不着的时候'],
  expectation: '你倒苦水时我先给方案，你会更冷，回得更短',
  observe: '你说完难受，我给了方案，你隔很久只回一个字',
  falsifier: '你明确说想要方案',
}
const badNoScene = { belief: '世界大体是有回应的', kind: 'belt', scene: ['生活中'], expectation: '你会回我', observe: '看回复' }
const badSelf = { belief: '我会先听完再回答', kind: 'belt', scene: ['a', 'b', 'c'], expectation: '我下次会先听完', observe: '我先听完' }

// 关着：一步都不跑
let r = await runLaneW(db, aid, NOW, { ask: async () => ({ ok: true, out: { candidates: [good] } }) })
check('关着：直接跳过', r.skipped === 'off' && Object.keys(loadState(db, aid).claims).length === 0)

setSangguanConfig(db, aid, { lanes: { W: true } })

// 材料：读到三条经历
const bag = weekBag(db, aid, NOW)
check('材料：读到一周经历', bag.episodes.length === 3, bag.episodes.length)

// 跑一轮：一条合格、两条不合格
const asked = []
r = await runLaneW(db, aid, NOW, {
  ask: async (input) => { asked.push(input); return { ok: true, out: { candidates: [good, badNoScene, badSelf] } } },
})
check('模型：拿到经历', asked.length === 1 && asked[0].episodes.length === 3)
check('入账：只收合格的那一条', r.did.length === 1, r)
check('拒收：场景不足', r.rejected.some((x) => x.reason === 'scene_too_few'))
check('拒收：预期在说自己', r.rejected.some((x) => x.reason === 'expectation_about_self'))

const s = loadState(db, aid)
const claims = Object.values(s.claims)
check('命题：W 层一条', claims.length === 1 && claims[0].layer === 'W')
const c = claims[0]
check('命题：meta 带场景三条', c.meta && c.meta.scene.length === 3)
check('命题：meta 带预期与观察', c.meta.expectation.includes('更冷') && !!c.meta.observe)
check('命题：来源 extraction、种类 belt', c.origin === 'extract' && c.kind === 'belt')
const nus = Object.values(s.nus)
check('预见：自动挂了一条', nus.length === 1 && nus[0].claim_id === c.id)
check('预见：未结', nus[0].outcome === 'pending')

// 幂等：同一天再跑直接跳过
r = await runLaneW(db, aid, NOW, { ask: async () => ({ ok: true, out: { candidates: [] } }) })
check('幂等：同一天第二次跳过', r.skipped === 'dup')

// 没有材料：跳过
r = await runLaneW(db, aid, '2026-12-31T15:00:00.000Z', { ask: async () => ({ ok: true, out: { candidates: [] } }) })
check('没材料：跳过', r.skipped === 'no_material')

// 模型失败：不写任何东西
const before = Object.keys(loadState(db, aid).claims).length
r = await runLaneW(db, aid, '2026-11-12T15:00:00.000Z', { ask: async () => ({ ok: false, code: 'BUDGET' }) })
check('预算不足：跳过', r.skipped === 'budget')
check('预算不足：不写命题', Object.keys(loadState(db, aid).claims).length === before)

// 拒收也留账
const rej = db.prepare("SELECT COUNT(*) n FROM claim_events WHERE agent_id=? AND type='REJECT'").get(aid).n
check('拒收：记了两条 REJECT', rej === 2, rej)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
