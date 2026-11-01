/**
 * 关系动力学 v1（人物账本版）：三轴有界 / 边际递减 / 信任不对称 / 习惯化 / 事件接入 / 旧表镜像。
 * 运行：node test/reldyn.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { bootstrap, ownerPerson, bumpRelation, listEvents, remember, tick, axesSeries } from '../src/modules/relations.js'
import { learnFromTurn, relObserve } from '../src/features.js'
import { appraise } from '../src/core.js'
import { seedAffect } from '../src/modules/affect.js'
import { computeEdgeBias } from '../src/modules/edges.js'
import { eventValence, moodAdjust, applyEvent, decayAxis, repairTrust, REL_DEFAULTS, toneOf } from '../src/algo/reldyn.js'
import { rulesAppraise } from '../src/algo/appraise.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

// ================= 一、纯函数 =================
{
  const s0 = { closeness: 0.5, trust: 0.5, dependence: 0.2 }
  const a1 = applyEvent(s0, { v: 0.6, w: 1, kind: 'praise' })
  const a2 = applyEvent(a1, { v: 0.6, w: 1, kind: 'praise' })
  check('正向有界', a1.closeness > 0.5 && a1.closeness < 0.6, a1)
  check('边际递减：第二次涨得更少', a2.delta.closeness < a1.delta.closeness, { d1: a1.delta, d2: a2.delta })
  check('单轴单次不超过 stepCap', Math.abs(a1.delta.closeness) <= REL_DEFAULTS.stepCap + 1e-9)

  let up = s0
  for (let i = 0; i < 500; i++) up = applyEvent(up, { v: 1, w: 1, kind: 'praise' })
  check('永远到不了 1.0', up.closeness <= 0.999 && up.closeness > 0.9, up)

  let down = { closeness: 0.9, trust: 0.9, dependence: 0.9 }
  for (let i = 0; i < 500; i++) down = applyEvent(down, { v: -1, w: 1, kind: 'critic' })
  check('永远掉不到 0', down.closeness >= 0 && down.trust >= 0, down)

  const pos = applyEvent({ closeness: 0.6, trust: 0.6, dependence: 0.2 }, { v: 0.5, w: 1 })
  const neg = applyEvent({ closeness: 0.6, trust: 0.6, dependence: 0.2 }, { v: -0.5, w: 1 })
  check('信任破得比建立快', Math.abs(neg.delta.trust) > Math.abs(pos.delta.trust), { pos: pos.delta, neg: neg.delta })

  const close = applyEvent({ closeness: 0.98, trust: 0.98, dependence: 0.2 }, { v: -0.5, w: 1 })
  const far = applyEvent({ closeness: 0.2, trust: 0.2, dependence: 0.2 }, { v: -0.5, w: 1 })
  check('越亲越容易被伤到', Math.abs(close.delta.closeness) > Math.abs(far.delta.closeness))

  check('心情只放大正向', moodAdjust(0.5, 0.9) > moodAdjust(0.5, 0.1) && near(moodAdjust(-0.5, 0.9), -0.5))
  check('半衰期 30 天走一半', near(decayAxis(0.8, 0.5, 30, 30), 0.65))
  check('修复封顶在受损前', repairTrust({ trust: 0.3 }, { strength: 0.6, ceiling: 0.35 }).trust <= 0.35 + 1e-9)
  check('红线永远 -1', eventValence({ goalCongruence: 1, kind: 'boundary' }) === -1)
}

// ================= 二、评价：否定不再被「好」骗 =================
{
  const insult = rulesAppraise('你不好')
  const praise = rulesAppraise('谢谢你，今天真好')
  check('「你不好」判负向', insult.label === 'irritated' && insult.goal_congruence < 0, insult)
  check('夸还是夸', praise.label === 'joy' && praise.goal_congruence > 0, praise)
}

// ================= 三、接进人物账本 =================
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-reldyn-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_reldyn'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '关系', 'daily', 'active', now())
// 旧表也放一行，验证镜像
db.prepare('INSERT INTO relations(id,agent_id,name,kind,closeness,trust,dependence,root,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run('rel_owner', aid, '主人', 'owner', 0.55, 0.6, 0.2, 1, null, now(), now())
bootstrap(db, aid)

const owner0 = ownerPerson(db, aid)
check('账本里有主人', !!owner0 && owner0.tier === 'owner', owner0 && owner0.tier)
check('习惯化表就位', !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rel_habit'").get())

// 3.1 一次事件：三轴动 + 一笔账
{
  const before = ownerPerson(db, aid)
  const n0 = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
  const out = bumpRelation(db, aid, { v: 0.6, kind: 'praise', label: 'joy', reason: '谢谢你', at: Date.now() })
  const after = ownerPerson(db, aid)
  const n1 = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
  check('亲近涨了', after.closeness > before.closeness, { before: before.closeness, after: after.closeness })
  check('信任涨了', after.trust > before.trust, { before: before.trust, after: after.trust })
  check('落了一笔账', n1 === n0 + 1, { n0, n1 })
  check('账上能看到原话', String(out.event_id).length > 0 && listEvents(db, aid, 5)[0].text === '谢谢你', out)
  check('单次不超步幅', Math.abs(after.closeness - before.closeness) <= REL_DEFAULTS.stepCap + 1e-9)
}

// 3.2 习惯化：越刷越淡
{
  const rows = []
  for (let i = 0; i < 10; i++) {
    const o = bumpRelation(db, aid, { v: 0.6, kind: 'praise', label: 'joy', reason: '谢谢你', at: Date.now() + i })
    if (o.w) rows.push(o.w)
  }
  check('习惯化：权重递减', rows.length >= 5 && rows[0] > rows[rows.length - 1], rows)
}

// 3.3 负向：信任掉得比亲近快
{
  const before = ownerPerson(db, aid)
  bumpRelation(db, aid, { v: -0.8, kind: 'critic', label: 'irritated', reason: '你真烦', at: Date.now() })
  const after = ownerPerson(db, aid)
  check('负向：亲近/信任都下降', after.closeness < before.closeness && after.trust < before.trust,
    { bc: before.closeness, ac: after.closeness, bt: before.trust, at: after.trust })
  check('负向：信任跌得更多', (before.trust - after.trust) > (before.closeness - after.closeness))
}

// 3.4 relObserve 走完整链路：你不好 → 负向
{
  const before = ownerPerson(db, aid)
  const out = relObserve(db, aid, { text: '你不好', source: 'chat' })
  const after = ownerPerson(db, aid)
  check('relObserve：「你不好」让亲近下降', after.closeness < before.closeness, { before: before.closeness, after: after.closeness })
  check('relObserve：事件类型是 critic', out.kind === 'critic', out.kind)
}

// 3.5 learnFromTurn：账本 + 旧表镜像一致
{
  const before = ownerPerson(db, aid)
  const out = learnFromTurn(db, aid, '谢谢你')
  const after = ownerPerson(db, aid)
  const legacy = db.prepare('SELECT closeness,trust FROM relations WHERE id=?').get('rel_owner')
  check('learnFromTurn：账本动了', after.closeness > before.closeness)
  check('learnFromTurn：旧表镜像同一组数字', near(legacy.closeness, after.closeness, 1e-6) && near(legacy.trust, after.trust, 1e-6),
    { legacy, after: { c: after.closeness, t: after.trust } })
  check('learnFromTurn：返回了变化', out.changed.length >= 1, out.changed)
}

// 3.6 v0 开关：关掉就完全不动
{
  db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
    .run(aid, 'relation.dynamics.formula', JSON.stringify('v0'), now())
  const before = ownerPerson(db, aid)
  const out = relObserve(db, aid, { text: '谢谢你' })
  const after = ownerPerson(db, aid)
  check('v0：不记账', out.skipped === 'v0' && near(after.closeness, before.closeness))
  db.prepare('DELETE FROM agent_params WHERE agent_id=? AND key=?').run(aid, 'relation.dynamics.formula')
}

// 3.7 中性句：也留痕，但比夸奖轻得多（政策：被搭话本身算一点点正向）
{
  const n0 = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
  const b0 = ownerPerson(db, aid)
  learnFromTurn(db, aid, '今天天气不错')
  const n1 = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
  const a0 = ownerPerson(db, aid)
  const chatStep = a0.closeness - b0.closeness
  check('中性句：记一条轻事件', n1 === n0 + 1, { n0, n1 })
  check('中性句：轻轻往上，不是大跳', chatStep > 0 && chatStep < 0.005, { chatStep })

  const r1 = relObserve(db, aid, { text: '嗯，然后呢' })
  const r2 = relObserve(db, aid, { text: '你真棒' })
  const vChat = r1.changed && r1.changed[0] ? r1.changed[0].v : 0
  const vPraise = r2.changed && r2.changed[0] ? r2.changed[0].v : 0
  check('中性句比夸奖轻得多', vChat > 0 && vChat < vPraise, { vChat, vPraise })
}

// ================= 四、C2：同一句批评，信任不同 → 伤害不同 =================
{
  const hi = computeEdgeBias({ appraisal: { goal_congruence: -0.6, label: 'irritated' }, ownerTrust: 0.8, ownerCloseness: 0.9, mode: 'on' })
  const lo = computeEdgeBias({ appraisal: { goal_congruence: -0.6, label: 'irritated' }, ownerTrust: 0.2, ownerCloseness: 0.9, mode: 'on' })
  check('C2：信任高 → 伤害系数 <1', hi.harmMul < 1, hi.harmMul)
  check('C2：信任低 → 伤害系数 >1', lo.harmMul > 1, lo.harmMul)
  check('C2：正向事件不吃伤害系数', computeEdgeBias({ appraisal: { goal_congruence: 0.6 }, ownerTrust: 0.2 }).harmMul === 1)
  check('C2：亲近只给正向加项', computeEdgeBias({ appraisal: { goal_congruence: -0.6 }, ownerTrust: 0.5, ownerCloseness: 0.9 }).congruenceAdd === 0)

  seedAffect(db, aid)
  const eHi = await appraise(db, aid, '你错了，真差劲', { edgeBias: hi, hint: null, formula: 'v1' })
  const eLo = await appraise(db, aid, '你错了，真差劲', { edgeBias: lo, hint: null, formula: 'v1' })
  const gHi = Number(eHi.appraisal && eHi.appraisal.goal_congruence)
  const gLo = Number(eLo.appraisal && eLo.appraisal.goal_congruence)
  check('C2 端到端：低信任伤得更重', gLo < gHi, { 高信任: gHi, 低信任: gLo })
}

// ================= 五、P2：久不见，三轴回到基线（不是归零） =================
{
  remember(db, aid, { name: '小周', tier: 'acquaintance' }, { source: 'test' })
  const longAgo = new Date(Date.now() - 30 * 86400000).toISOString()
  db.prepare("UPDATE rel_person SET closeness=0.8, trust=0.8, dependence=0.5, last_seen_at=? WHERE agent_id=? AND name='小周'")
    .run(longAgo, aid)
  const ownerBefore = ownerPerson(db, aid)
  tick(db, aid)
  const p = db.prepare("SELECT * FROM rel_person WHERE agent_id=? AND name='小周'").get(aid)
  const ownerAfter = ownerPerson(db, aid)
  check('P2：30 天没见，亲近回到半程', Math.abs(p.closeness - 0.525) < 0.02, p.closeness)
  check('P2：信任比亲近回得慢', p.trust > p.closeness && p.trust < 0.8, p.trust)
  check('P2：依赖回得最快', p.dependence < 0.2, p.dependence)
  check('P2：主人不走时间', near(ownerAfter.closeness, ownerBefore.closeness))
  const ev = db.prepare("SELECT COUNT(*) n FROM rel_event WHERE agent_id=? AND kind='decay'").get(aid).n
  check('P2：衰减也落账', ev >= 1, ev)
}

// ================= 六、C7：三轴 → 说话方式 =================
{
  const owner = toneOf({ closeness: 0.95, trust: 0.72, kind: 'owner', mood: 0.5, extraversion: 0.6 })
  const stranger = toneOf({ closeness: 0.1, trust: 0.3, kind: 'stranger', mood: 0.5 })
  check('C7：主人更热、更不正式', owner.warmth > stranger.warmth && owner.formality < stranger.formality, { owner, stranger })
  check('C7：陌生人披露更少', owner.disclosure > stranger.disclosure, { owner: owner.disclosure, stranger: stranger.disclosure })
  check('C7：心情好更主动', toneOf({ closeness: 0.5, mood: 0.9 }).initiative > toneOf({ closeness: 0.5, mood: 0.1 }).initiative)
  const all = [owner, stranger].every((t) => ['warmth', 'formality', 'disclosure', 'initiative'].every((k) => t[k] >= 0 && t[k] <= 1))
  check('C7：不越界 0..1', all, { owner, stranger })
}

// ================= 七、修复：只回信任，回不到受损前 =================
{
  const pid = ownerPerson(db, aid).id
  db.prepare('UPDATE rel_person SET trust=0.6, closeness=0.8 WHERE id=?').run(pid)
  const before = Number(ownerPerson(db, aid).trust)
  bumpRelation(db, aid, { v: -0.9, kind: 'critic', label: 'irritated', reason: '你真烦', at: Date.now() })
  const hurt = ownerPerson(db, aid)
  check('修复：受伤时信任下降', Number(hurt.trust) < before, { before, after: Number(hurt.trust) })
  bumpRelation(db, aid, { v: 0.6, kind: 'repair', label: 'calm', reason: '对不起', at: Date.now() + 10 })
  const rep1 = ownerPerson(db, aid)
  check('修复：信任回升', Number(rep1.trust) > Number(hurt.trust), { hurt: Number(hurt.trust), rep: Number(rep1.trust) })
  check('修复：亲近不动', near(Number(rep1.closeness), Number(hurt.closeness)), { hurt: Number(hurt.closeness), rep: Number(rep1.closeness) })
  for (let i = 0; i < 5; i++) bumpRelation(db, aid, { v: 0.6, kind: 'repair', label: 'calm', reason: '对不起', at: Date.now() + 20 + i })
  const rep2 = ownerPerson(db, aid)
  check('修复：仍回不到受损前', Number(rep2.trust) < before - 1e-6, { before, now: Number(rep2.trust) })
  check('修复：但补回了这次损失的大半', Number(rep2.trust) > Number(hurt.trust) + (before - Number(hurt.trust)) * 0.5,
    { hurt: Number(hurt.trust), now: Number(rep2.trust) })
  const ap = relObserve(db, aid, { text: '对不起，是我不好', source: 'chat' })
  check('修复：道歉自动识别为 repair', ap.kind === 'repair', ap.kind)
}

// ================= 八、三轴走势：从账本重放 =================
{
  const pid = ownerPerson(db, aid).id
  bumpRelation(db, aid, { v: 0.3, kind: 'praise', label: 'joy', reason: '好', at: Date.now() - 1000 })
  const s = axesSeries(db, aid, pid, 30)
  check('走势：至少两个点', s.points.length >= 2, s.points.length)
  check('走势：每个点都带三轴', s.points.every((p) => Number.isFinite(p.c) && Number.isFinite(p.t) && Number.isFinite(p.d)), s.points.slice(0, 2))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
