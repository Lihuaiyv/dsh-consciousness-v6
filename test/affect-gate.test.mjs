/**
 * 情绪事件闸门 gate@v1（P2 生效）：纯函数 + 接线。
 * 证明四件事：
 *   1) 显著性算得对：中性话不过闸、强评价过闸、重复同类被打折、变化会抬高；
 *   2) shadow 挡位行为不变（episode 仍逐条写），on 挡位只有事件才写 episode / 换标签；
 *   3) 被点名评价 / 气话 / 对方在气头上 都能把「模型判 none」的话拉回来；
 *   4) 事件之间快情绪会自己滑落，标签留着；心情会调制记忆召回。
 * 运行：node test/affect-gate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { significanceOf, gateOf, labelMargin, shadowGate, socialFloorOf, GATE } from '../src/algo/gate.js'
import { promptFor, finalizeAppraisal, ModelPort } from '../src/model.js'
import { appraiseV1 } from '../src/algo/appraise.js'
import { seedAffect, appraise, affectGateEvents, getAffect, decayAt, applyEmotionV3, moodValenceOf, episodeLevelAt, listEpisodes } from '../src/modules/affect.js'
import { addMemory, recall } from '../src/modules/memory.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// ================= 一、纯函数 =================

const neutral = significanceOf({ rel: 0.3, cong: 0, nov: 0.1, cert: 0.9, prevCong: 0 })
check('中性话：sig 很低', neutral.sig < 0.05, neutral)
check('中性话：不过闸', !gateOf(neutral.sig), neutral)

const praise = significanceOf({ rel: 0.9, cong: 0.8, nov: 0.6, cert: 0.6, prevCong: 0 })
check('强评价：sig 高', praise.sig > 0.5, praise)
check('强评价：过闸', gateOf(praise.sig), praise)

const habitual = significanceOf({ rel: 0.9, cong: 0.8, nov: 0.6, cert: 0.6, prevCong: 0, habitCount: 3 })
check('同类第三次：sig 被打折', habitual.sig < praise.sig * 0.5, { praise: praise.sig, habitual: habitual.sig })
check('习惯化系数符合 1/(1+kn)', Math.abs(habitual.sig - praise.sig / (1 + GATE.habitK * 3)) < 0.002, habitual)

const flipped = significanceOf({ rel: 0.9, cong: 0.8, nov: 0.6, cert: 0.6, prevCong: -0.8 })
check('方向翻转：变化项抬高 sig', flipped.sig > praise.sig, { praise: praise.sig, flipped: flipped.sig })
check('变化项封顶 1', flipped.change === 1, flipped)

check('rel=0：一定不过闸', gateOf(significanceOf({ rel: 0, cong: 1, nov: 1, cert: 0 }).sig) === false)
check('gate 边界：等于 theta 算过', gateOf(GATE.theta, GATE.theta) && !gateOf(GATE.theta - 0.001, GATE.theta))
check('过闸线：P2 取 0.10（偏丰富）', GATE.theta === 0.1, GATE.theta)

check('标签领先：0.5/0.3 → 0.2', labelMargin({ joy: 0.5, calm: 0.2, curious: 0.3 }) === 0.2)
check('标签领先：空分布 → null', labelMargin(null) === null)

const sg = shadowGate({ rel: 0.9, cong: 0.8, nov: 0.6, cert: 0.6, scores: { joy: 0.6, calm: 0.1 } })
check('shadowGate 一次给全', sg.gate === true && sg.margin === 0.5 && sg.theta === GATE.theta, sg)

// 显式 change（P1 关切口径直接给变化量）
const ch0 = significanceOf({ rel: 0.9, cong: 0.8, nov: 0.6, cert: 0.6, prevCong: 0.8, change: 0 })
const ch1 = significanceOf({ rel: 0.9, cong: 0.8, nov: 0.6, cert: 0.6, prevCong: 0.8, change: 1 })
check('显式 change：0 与 1 拉开', ch1.sig > ch0.sig && ch1.change === 1, { ch0, ch1 })

// ================= 一·B 评价口径（P1） =================
check('口径：v1 提示词不含 concern_relevance', !promptFor('v1').includes('concern_relevance'))
check('口径：concern 提示词含关切字段', promptFor('concern').includes('concern_relevance') && promptFor('concern').includes('none'))
check('口径：concern 提示词要求先分类', promptFor('concern').includes('kind') && promptFor('concern').includes('polarity'))
const DIST = { joy: 0.05, peaceful: 0.05, curious: 0.1, calm: 0.2, confused: 0.1, lost: 0.05, irritated: 0.25, frustrated: 0.2 }
const fin = finalizeAppraisal({ scores: DIST, concern_relevance: 0.9, concern_congruence: -0.7, change: 0.8, none: false })
check('concern → goal_* 映射', fin.goal_relevance === 0.9 && fin.goal_congruence === -0.7 && fin.change === 0.8, fin)
check('concern → 标签取最大', fin.label === 'irritated', fin.label)
const finNone = finalizeAppraisal({ scores: DIST, concern_relevance: 0.9, concern_congruence: -0.8, none: true })
check('none：相关性压到地板', finNone.goal_relevance <= 0.15 && finNone.goal_congruence === 0, finNone)
// 先分类再定量：模型给 0–1 会一律往「任务」猜，kind 要能兜住
const finEval = finalizeAppraisal({ kind: 'eval', polarity: -1, concern_relevance: 0.1, scores: DIST })
check('kind=eval → 相关性抬高、方向为负', finEval.goal_relevance >= 0.6 && finEval.goal_congruence < 0 && finEval.none === false, finEval)
const finTaskK = finalizeAppraisal({ kind: 'task', polarity: 0, concern_relevance: 0.1, scores: DIST })
check('kind=task → none', finTaskK.none === true && finTaskK.goal_relevance <= 0.15, finTaskK)
const finRel = finalizeAppraisal({ kind: 'relation', polarity: 1, scores: DIST })
check('kind=relation → 正相关', finRel.goal_relevance >= 0.5 && finRel.goal_congruence > 0, finRel)
// 对方在气头上：模型判 chat 也按关系处理
const finAngry = finalizeAppraisal({ kind: 'chat', polarity: 0, scores: DIST, user_scores: { irritated: 0.45, frustrated: 0.35, calm: 0.2 } })
check('对方在气头上：chat 也变关系事件', finAngry.none === false && finAngry.goal_relevance >= 0.5 && finAngry.goal_congruence < 0, finAngry)
const finCalmChat = finalizeAppraisal({ kind: 'chat', polarity: 0, scores: DIST, user_scores: { calm: 0.7, curious: 0.3 } })
check('对方平静：chat 仍不制造事件', finCalmChat.none === true && finCalmChat.goal_relevance <= 0.15, finCalmChat)
const apV1 = appraiseV1.run(null, { text: '在吗', hint: { label: 'calm', goal_relevance: 0.5, goal_congruence: 0, source: 'model' } })
check('v1 没给 change：保持 null 走 |Δc|', apV1.change === null, apV1.change)
const apC = appraiseV1.run(null, { text: '回滚', hint: { label: 'frustrated', concern_relevance: 0.9, concern_congruence: -0.8, change: 0.7, source: 'model' } })
check('concern 字段进 appraisal', apC.goal_relevance === 0.9 && apC.goal_congruence === -0.8 && apC.change === 0.7, apC)
// 链式适配器不能把 formula / context 吞掉
const seenArgs = []
const port = new ModelPort(
  { available: () => true, appraise: (t, f) => { seenArgs.push([t, f]); return { label: 'calm', source: 'model' } } },
  { appraise: () => ({ label: 'calm', source: 'rules' }) },
)
await port.appraise('x', 'concern')
check('ModelPort → 适配器：formula 不被吞', seenArgs[0] && seenArgs[0][1] === 'concern', seenArgs)
const seenCtx = []
const port2 = new ModelPort(
  { available: () => true, appraise: (t, f, c) => { seenCtx.push([t, f, c]); return { label: 'calm', source: 'model' } } },
  { appraise: () => ({ label: 'calm', source: 'rules' }) },
)
await port2.appraise('我真是服了', 'concern', '你一点都不活')
check('ModelPort → 适配器：上下文不被吞', seenCtx[0] && seenCtx[0][2] === '你一点都不活', seenCtx)

// ================= 二、接线 =================

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-gate-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_gate'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '闸门', 'daily', 'active', now())
seedAffect(db, aid)

const LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
function hintOf(label, { rel = 0.8, cong = 0, nov = 0.3, cert = 0.7 } = {}) {
  return {
    label, goal_relevance: rel, goal_congruence: cong,
    agency: 'other', certainty: cert, novelty: nov,
    source: 'model', user_label: 'calm', user_scores: null,
    scores: { joy: 0.1, peaceful: 0.1, curious: 0.1, calm: 0.4, confused: 0.1, lost: 0.1, irritated: 0.05, frustrated: 0.05 },
  }
}
function setGateMode(mode) {
  db.prepare(`INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(aid, 'affect.gate.mode', JSON.stringify(mode), now())
}
const epCount = () => db.prepare('SELECT COUNT(*) n FROM affect_episodes WHERE agent_id=?').get(aid).n
const evLatest = () => db.prepare('SELECT * FROM affect_events WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)

// ---- shadow：行为不变（回滚挡位，留作对账） ----
setGateMode('shadow')
const r1 = await appraise(db, aid, '在吗', { labels: LABELS, closeness: 0.5, hint: hintOf('calm', { rel: 0.3, cong: 0, nov: 0.1, cert: 0.9 }) })
const e1 = evLatest()
check('shadow：每条消息都写一行事件记录', !!e1 && e1.episode_id === r1.id, e1 && { id: e1.id, ep: e1.episode_id, rid: r1.id })
check('shadow：记录带口径', e1.formula === 'concern', e1.formula)
check('shadow：中性话 gate=0', Number(e1.gate) === 0, e1)
check('shadow：记录带 sig / theta', Number.isFinite(Number(e1.sig)) && Number(e1.theta) === GATE.theta, e1)

const r2 = await appraise(db, aid, '你全画错了，回滚', { labels: LABELS, closeness: 0.9, hint: hintOf('frustrated', { rel: 0.9, cong: -0.8, nov: 0.7, cert: 0.5 }) })
const e2 = evLatest()
check('shadow：强评价 gate=1', Number(e2.gate) === 1, e2)
check('shadow：强评价 sig 高于中性话', Number(e2.sig) > Number(e1.sig), { e1: e1.sig, e2: e2.sig })
check('shadow：episode 仍然每条一个', epCount() === 2, epCount())

const st = db.prepare('SELECT * FROM affect_state WHERE agent_id=?').get(aid)
check('shadow：主情绪照常写', !!st && !!st.primary_label, st && st.primary_label)
check('shadow：强度照常写', Number(st.intensity) > 0, st && st.intensity)

// ---- on：事件才改主情绪 ----
setGateMode('on')
// 切换挡位时把 shadow 期遗留的「未收尾」episode 收掉，模拟真实切换
db.prepare('UPDATE affect_episodes SET ended_at=? WHERE agent_id=? AND ended_at IS NULL').run(now(), aid)
const n0 = epCount()
const label0 = db.prepare('SELECT primary_label FROM affect_state WHERE agent_id=?').get(aid).primary_label
const r3 = await appraise(db, aid, '把那个函数也改一下', { labels: LABELS, closeness: 0.5, hint: hintOf('calm', { rel: 0.2, cong: 0.05, nov: 0.1, cert: 0.9 }) })
check('on：任务话不成事件（emitted=false）', r3.emitted === false && r3.id === null, { emitted: r3.emitted, id: r3.id })
check('on：任务话不写 episode', epCount() === n0, { before: n0, after: epCount() })
check('on：任务话不改主情绪', db.prepare('SELECT primary_label FROM affect_state WHERE agent_id=?').get(aid).primary_label === label0, { label0 })
check('on：不成事件也留一行日志', Number(evLatest().gate) === 0)

// 先把主情绪压回低处，让这一下的抬升看得见（否则 0.7 旧 + 0.3 新 的惯性已经把差距抹平）
db.prepare('UPDATE affect_state SET intensity=?, updated_at=? WHERE agent_id=?').run(0.05, now(), aid)
const r4 = await appraise(db, aid, '你全画错了，回滚', { labels: LABELS, closeness: 0.9, hint: hintOf('frustrated', { rel: 0.9, cong: -0.8, nov: 0.7, cert: 0.5 }) })
check('on：强评价成为事件', r4.emitted === true && !!r4.id, { emitted: r4.emitted, id: r4.id })
check('on：成事件才写 episode', epCount() === n0 + 1, { before: n0, after: epCount() })
check('on：主情绪换成这一下的标签', db.prepare('SELECT primary_label FROM affect_state WHERE agent_id=?').get(aid).primary_label === 'frustrated')
check('on：旧 episode 被收尾', (() => {
  const rows = db.prepare('SELECT ended_at FROM affect_episodes WHERE agent_id=? ORDER BY started_at').all(aid)
  return rows.slice(0, -1).every((x) => !!x.ended_at) && rows[rows.length - 1].ended_at == null
})(), null)
check('on：返回里带闸门读数', r4.gate && r4.gate.mode === 'on' && r4.gate.passed === true, r4.gate)

// 上升段：事件当下只走半步，峰值分开存，几分钟里自己爬上去
const stR4 = db.prepare('SELECT intensity FROM affect_state WHERE agent_id=?').get(aid)
const ep4 = db.prepare('SELECT * FROM affect_episodes WHERE id=?').get(r4.id)
check('上升段：episode 存峰值，比这一下写进主情绪的高', Number(ep4.intensity) > Number(stR4.intensity) + 0.01, { peak: ep4.intensity, written: stR4.intensity })
check('上升段：记下起点 rise_from 和起爬时刻 rise_at', ep4.rise_from != null && !!ep4.rise_at, { from: ep4.rise_from, at: ep4.rise_at })
const t4 = Date.parse(ep4.rise_at)
const lv0 = episodeLevelAt(db, aid, ep4, t4)
check('上升段：事件当下 = 起点 + 半步（attackStart 0.5）', Math.abs(lv0 - Number(stR4.intensity)) < 0.006, { lv0, written: stR4.intensity, from: ep4.rise_from })
const lvMid = episodeLevelAt(db, aid, ep4, t4 + 2 * 60000)
check('上升段：2 分钟时在起点和峰值之间', lvMid > lv0 + 0.004 && lvMid < Number(ep4.intensity) - 0.003, { lvMid, peak: ep4.intensity })
const lvTop = episodeLevelAt(db, aid, ep4, t4 + 3 * 60000)
check('上升段：3 分钟爬到峰值', Math.abs(lvTop - Number(ep4.intensity)) < 0.006, { lvTop, peak: ep4.intensity })
const lvAfter = episodeLevelAt(db, aid, ep4, t4 + 3600000)
check('上升段之后：回到原来的衰减曲线（1 小时只退一点）', lvAfter < Number(ep4.intensity) && lvAfter > Number(ep4.intensity) * 0.6, lvAfter)
check('上升段：还在爬的时候 phase = rise', (listEpisodes(db, aid)[0] || {}).phase === 'rise', (listEpisodes(db, aid)[0] || {}).phase)
check('上升段：老记录（没有 rise_at）直接当峰值', episodeLevelAt(db, aid, { intensity: 0.42, started_at: now() }, Date.now()) === 0.42)
check('上升段：attackStart / attack 可调', (() => {
  db.prepare(`INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value`).run(aid, 'affect.event.attackStart', JSON.stringify(0), now())
  const low = episodeLevelAt(db, aid, ep4, t4)
  db.prepare('DELETE FROM agent_params WHERE agent_id=? AND key=?').run(aid, 'affect.event.attackStart')
  return Math.abs(low - Number(ep4.rise_from)) < 0.006
})(), { from: ep4.rise_from })

// 被点名评价的下限：模型判 none 时也要对「你一点都不活」有反应
const sf1 = socialFloorOf('你一点都不活')
check('社交下限：被点名评价 → rel≥0.5、负向', !!sf1 && sf1.rel >= 0.5 && sf1.cong < 0, sf1)
check('社交下限：普通任务句子不触发', socialFloorOf('把那个函数改一下') === null)
check('社交下限：只点名不评价 → 低相关', (() => { const s = socialFloorOf('你能看一下吗'); return !!s && s.rel < 0.5 })(), socialFloorOf('你能看一下吗'))
check('社交下限：不点名也说它自己的状态 → 触发', (() => { const s = socialFloorOf('都不饿阿'); return !!s && s.rel >= 0.5 })(), socialFloorOf('都不饿阿'))
check('社交下限：说对方自己不饿 → 不触发', socialFloorOf('我不饿') === null)
check('社交下限：太喜欢不因裸「太」判负', (() => {
  const s = socialFloorOf('你太喜欢这样了')
  return !!s && s.cong > 0
})(), socialFloorOf('你太喜欢这样了'))
check('社交下限：太差仍是否定', (() => {
  const s = socialFloorOf('你太差了')
  return !!s && s.cong < 0
})(), socialFloorOf('你太差了'))
check('社交下限：气话（服了/无语/算了）→ 触发且为负', (() => {
  const a = socialFloorOf('我真是服了'); const b = socialFloorOf('算了'); const c = socialFloorOf('太无语了')
  return !!a && a.rel >= 0.45 && a.cong < 0 && !!b && !!c
})(), [socialFloorOf('我真是服了'), socialFloorOf('算了')])
const r5 = await appraise(db, aid, '你一点都不活', { labels: LABELS, closeness: 0.9, hint: hintOf('calm', { rel: 0.1, cong: 0, nov: 0.2, cert: 0.2 }) })
check('模型判 none 的抱怨也能过闸', r5.emitted === true && r5.gate.sig >= 0.1, r5.gate)
const r6 = await appraise(db, aid, '我真是服了', { labels: LABELS, closeness: 0.9, hint: hintOf('calm', { rel: 0.05, cong: 0, nov: 0.2, cert: 0.2 }) })
check('不带「你」的气话也能过闸', r6.emitted === true && r6.gate.sig >= 0.1, r6.gate)
// 复现：同一段情绪再来一句，不新开 episode，而是把正在退的那次重新点亮并稍微加强
check('复现：同一段情绪 → 不新开 episode', r6.renewed === true && r6.id === r5.id, { renewed: r6.renewed, r6id: r6.id, r5id: r5.id })
check('复现：强度被重新点亮并加强', Number(r6.intensity) > Number(r5.intensity) + 0.05, { before: r5.intensity, after: r6.intensity })
const renRow = db.prepare('SELECT renewals, intensity, rise_from FROM affect_episodes WHERE id=?').get(r6.id)
check('复现：renewals 记账', renRow && Number(renRow.renewals) >= 1, renRow)
check('复现：重新点亮不走上升段（起点=新峰值）', Number(renRow.rise_from) === Number(renRow.intensity), renRow)

// 习惯化：同一类再来三次，sig 应递减；每次照样写日志（过不过闸都由 theta 断）
const sigs = []
for (let i = 0; i < 3; i++) {
  await appraise(db, aid, '谢谢你，我很喜欢', { labels: LABELS, closeness: 0.9, hint: hintOf('joy', { rel: 0.9, cong: 0.8, nov: 0.6, cert: 0.6 }) })
  sigs.push(Number(evLatest().sig))
}
check('同类重复：sig 逐次下降', sigs[0] > sigs[1] && sigs[1] > sigs[2], sigs)

// 衰减：10 小时没新事件，强度应自己退（标签不动）
// 真实的 10 小时等于 episode 早散了（45 分钟没新事件就收尾），所以先把还开着的收掉再回拨时间
db.prepare('UPDATE affect_episodes SET ended_at=? WHERE agent_id=? AND ended_at IS NULL').run(now(), aid)
db.prepare('UPDATE affect_state SET intensity=?, updated_at=? WHERE agent_id=?')
  .run(0.6, new Date(Date.now() - 10 * 3600000).toISOString(), aid)
const d = decayAt(db, aid, db.prepare('SELECT * FROM affect_state WHERE agent_id=?').get(aid))
check('衰减：10 小时后强度降低', d.intensity < 0.6 && d.intensity > 0, d)
check('衰减：标签不动', db.prepare('SELECT primary_label FROM affect_state WHERE agent_id=?').get(aid).primary_label != null)

// 快情绪：事件当下到峰值，非事件按「隔了多久」滑下去（不是一句话归零）
db.prepare('UPDATE affect_v3 SET fast=?, slow=?, fast_at=? WHERE agent_id=?')
  .run(0.5, 0.2, new Date(Date.now() - 10 * 60000).toISOString(), aid)
const v3Slow = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', eUser: 0, closeness: 0.5, fresh: false })
check('非事件：快情绪 10 分钟只退掉一成多（τ=20, shape=1.5）', v3Slow.fast > 0.35 && v3Slow.fast < 0.47, v3Slow.fast)
db.prepare('DELETE FROM agent_params WHERE agent_id=? AND key=?').run(aid, 'affect.fast.tau')
db.prepare('INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
  .run(aid, 'affect.fast.tau', JSON.stringify(60), now())
db.prepare('UPDATE affect_v3 SET fast=?, fast_at=? WHERE agent_id=?')
  .run(0.5, new Date(Date.now() - 10 * 60000).toISOString(), aid)
const v3Slow2 = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', eUser: 0, closeness: 0.5, fresh: false })
check('非事件：tau=60 时退得更慢', v3Slow2.fast > 0.44, v3Slow2.fast)
db.prepare('DELETE FROM agent_params WHERE agent_id=? AND key=?').run(aid, 'affect.fast.tau')
db.prepare('UPDATE affect_v3 SET fast=?, fast_at=? WHERE agent_id=?')
  .run(0.02, new Date().toISOString(), aid)
const v3Spike = applyEmotionV3(db, aid, { pleasure: 0.6, label: 'joy', eUser: 0, closeness: 0.5, fresh: true })
check('事件：快情绪当下到峰值', v3Spike.fast > 0.5, v3Spike.fast)

// 心情一致回忆：心情好先想起好事，低落先想起难受的事
await addMemory(db, aid, { text: '今天吃了苹果，心里挺舒服', type: 'fact', valence: 0.8, source: 'manual' })
await addMemory(db, aid, { text: '今天吃了苹果，心里挺难受', type: 'fact', valence: -0.8, source: 'manual' })
check('记忆：出生时记下效价', db.prepare("SELECT valence FROM memory_items WHERE agent_id=? AND text LIKE '%舒服%'").get(aid).valence === 0.8)
db.prepare('UPDATE affect_v3 SET slow=? WHERE agent_id=?').run(0.8, aid)
check('心情读数：正', moodValenceOf(db, aid) === 0.8)
const up = recall(db, aid, '苹果', 2, 512, { mood: moodValenceOf(db, aid) })
db.prepare('UPDATE affect_v3 SET slow=? WHERE agent_id=?').run(-0.8, aid)
const down = recall(db, aid, '苹果', 2, 512, { mood: moodValenceOf(db, aid) })
check('心情好：先想起正效价的那条', up.items[0] && up.items[0].text.includes('舒服'), up.items)
check('心情低：先想起负效价的那条', down.items[0] && down.items[0].text.includes('难受'), down.items)
db.prepare('UPDATE affect_v3 SET slow=? WHERE agent_id=?').run(0.2, aid)

// 统计接口
const g = affectGateEvents(db, aid, { days: 3, limit: 50 })
check('统计：模式是 on', g.mode === 'on', g.mode)
check('统计：总条数 = 2 影子 + 4 on + 3 习惯化', g.total === 9, g.total)
check('统计：过闸率在 0~1', g.rate > 0 && g.rate <= 1, g.rate)
check('统计：每天有值', g.perDay > 0, g.perDay)
check('统计：sig 六桶求和等于总数', g.hist.reduce((x, y) => x + y, 0) === g.total, g.hist)
check('统计：带最近记录', Array.isArray(g.items) && g.items.length === 9, g.items && g.items.length)
check('回放：覆盖最近 episode', g.replay && g.replay.total === epCount(), { replay: g.replay && g.replay.total, ep: epCount() })
check('像不像人：事件/天 有值', typeof g.humanness.eventsPerDay === 'number', g.humanness)
check('像不像人：换脸/天 有数', typeof g.humanness.labelFlipsPerDay === 'number' && g.humanness.labelFlipsPerDay >= 0, g.humanness)
check('像不像人：惯性在 -1~1 或 null', g.humanness.inertia === null || (typeof g.humanness.inertia === 'number' && g.humanness.inertia >= -1 && g.humanness.inertia <= 1), g.humanness)

const a = getAffect(db, aid)
check('getAffect 不受影响', !!a && !!a.primary_label, a && a.primary_label)

// ================= 三、事件只抬不降 / 不应期只压抬升 =================
const resetState = (v, label) => db.prepare('UPDATE affect_state SET intensity=?, primary_label=?, updated_at=? WHERE agent_id=?')
  .run(v, label || 'calm', now(), aid)
const stopAll = () => db.prepare("UPDATE affect_episodes SET ended_at=?, resolution='faded' WHERE agent_id=? AND ended_at IS NULL").run(now(), aid)
const epOf = (id) => db.prepare('SELECT * FROM affect_episodes WHERE id=?').get(id)

// 1) 闸门事件不再被「0.7 旧 + 0.3 新」折半：起点 0.20，峰值应明显抬起来
resetState(0.20)
stopAll()
const x1 = await appraise(db, aid, '你完全不理解我的意思', { labels: LABELS, closeness: 0.9, hint: hintOf('frustrated', { rel: 0.9, cong: -0.8, nov: 0.7, cert: 0.4 }) })
const epX = epOf(x1.id)
check('事件：抬升不再被惯性折半', x1.emitted === true && Number(epX.intensity) > 0.20 + 0.18, { peak: epX.intensity, from: epX.rise_from })
check('事件：上升段起点就是原来的强度', Math.abs(Number(epX.rise_from) - 0.20) < 0.02, epX.rise_from)

// 2) 事件只抬不降：当前 0.75，来一句峰值更低的（方向弱、但够过闸）→ 强度留在原处，不塌
resetState(0.75, 'curious')
stopAll()
const y1 = await appraise(db, aid, '你想一想再说', { labels: LABELS, closeness: 0.9, hint: hintOf('frustrated', { rel: 0.95, cong: -0.1, nov: 0.8, cert: 0.3 }) })
const epY = epOf(y1.id)
check('事件只抬不降：换标签也不掉强度', Number(y1.intensity) >= 0.74, { written: y1.intensity, peak: epY && epY.intensity })
check('事件只抬不降：没在爬就不标 rise', listEpisodes(db, aid)[0].phase === 'decay', listEpisodes(db, aid)[0].phase)

// 3) 不应期只压抬升：同样起点 0.20 再来一次，抬的那一截 ×0.7
resetState(0.20)
stopAll()
const z1 = await appraise(db, aid, '你完全不理解我的意思', { labels: LABELS, closeness: 0.9, hint: hintOf('frustrated', { rel: 0.9, cong: -0.8, nov: 0.7, cert: 0.4 }) })
const epZ = epOf(z1.id)
const riseY = Number(epX.intensity) - 0.20
const riseZ = Number(epZ.intensity) - 0.20
check('不应期：只把抬起来的那截打七折', Number(epZ.intensity) < Number(epX.intensity) - 0.03 && Math.abs(riseZ - riseY * 0.7) < 0.02, { 无不应期: epX.intensity, 不应期: epZ.intensity, riseY, riseZ })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
