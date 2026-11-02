/**
 * 分享门：她自己生活里看到的事，能排到「想跟你说一句」的最前面；
 * 排过一次就不再重复，没得分享时回落到开环。
 * 运行：node test/selfhood-share.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { lifeTick } from '../src/modules/life.js'
import { proactiveTriggerOf, composeProactiveLine } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}
const at = new Date(2026, 10, 2, 15, 0, 0).getTime()
const browseOk = async () => ({ items: [{ title: '看海攻略', url: 'https://example.com/sea', snippet: '海边风大，要带外套。' }] })
const modelOk = { chat: async () => '海边风大，得带件外套。' }

function seed(w) {
  w.db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(at - 3600000).toISOString(), w.aid)
}

// ---- 1. 有生活 → share 优先
{
  const w = makeWorld()
  try {
    seed(w)
    const out = await lifeTick(w.db, w.aid, { at, browse: browseOk, model: modelOk })
    check('先有生活', out.ok === true, out)
    const trig = proactiveTriggerOf(w.db, w.aid)
    check('触发是 share', !!trig && trig.kind === 'share', trig)
    check('带生活标题', !!trig && String(trig.text).includes('外套'), trig)
    check('带 summary', !!trig && String(trig.summary).includes('外套'), trig)
  } finally { w.close() }
}

// ---- 2. 排过一次 → 回落开环
{
  const w = makeWorld()
  try {
    seed(w)
    const out = await lifeTick(w.db, w.aid, { at, browse: browseOk, model: modelOk })
    w.db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('prc_share_2', w.aid, out.summary, 'share:' + out.id + ' · 自己看到的', 'R', 'pending', new Date().toISOString(), null)
    const trig = proactiveTriggerOf(w.db, w.aid)
    check('排过之后不再 share', !trig || trig.kind !== 'share', trig)
  } finally { w.close() }
}

// ---- 3. 没有 share 时，开环照旧
{
  const w = makeWorld()
  try {
    seed(w)
    w.db.prepare(`INSERT INTO open_loops(id,agent_id,kind,text,state,due_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run('lp_share_3', w.aid, 'task', '该收尾了', 'open', new Date(Date.now() - 1000).toISOString(), new Date().toISOString(), new Date().toISOString())
    const trig = proactiveTriggerOf(w.db, w.aid)
    check('没有生活时回落到开环', !!trig && trig.kind === 'loop', trig)
  } finally { w.close() }
}

// ---- 4. 模型不可用时，share 用生活原句兜底，不退化成「有点想跟你说话」
{
  const w = makeWorld()
  try {
    seed(w)
    const out = await lifeTick(w.db, w.aid, { at, browse: browseOk, model: modelOk })
    const composed = await composeProactiveLine(w.db, w.aid, {
      dim: 'R', kind: 'share', title: out.summary, summary: out.summary, deficit: 0,
    })
    check('兜底句就是她自己的生活原句', composed.text === out.summary, composed)
    check('内容门通过', composed.gate && composed.gate.ok === true, composed.gate)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
