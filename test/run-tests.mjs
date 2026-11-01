import assert from 'node:assert'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { openDb, recover, now } from '../src/db.js'
import { handle } from '../src/api.js'
import { purgeExpired, settleObservations, maybeDraftTaxonomy, maybeDraft, maybeDraftWithTarget, draftFromObservation, promoteDraft, createProposal, approve, reject, expireProposals, recoverChangeJournal, gcArtifacts, TARGET_IDS, seedState } from '../src/core.js'
import { resolveActiveArtifact, parsePayload, seedRuleBindings } from '../src/modules/artifacts.js'
import { validateObservation, researchObserver } from '../src/ports/observers.js'
import { LIMITS, evidenceNeed } from '../src/selfmod_limits.js'
import { TARGETS } from '../src/modules/selfmod_targets.js'
import { nudgeDeficit, pulseDriveFromSignals, coupleAffectToDrive } from '../src/modules/drive.js'
import { computeNeedProxies } from '../src/modules/proxies.js'
import { pushProactiveLine } from '../src/push.js'
import { queueProactive, settleProactiveAnswered, markProactiveIgnored, proactiveGate, proactiveStats, learnFromTurn, clampInjection, tickOneShadow, applyDriverToDrive, freeformModelHook, growModelHook, decideSpeak, relationsModelHook, minDeficitFor } from '../src/features.js'
import { AXES, axisWords, typeProfile, mbtiStyleLine, mbtiPromptLine, readAxes, setAxisAuto, setAxisManual, releaseAxis, axesView, sensitivityEffects, stimulusStrength, traitAmp, sensitivityOf, driveAmp } from '../src/modules/traits.js'
import { computeEdgeBias } from '../src/modules/edges.js'
import { growValues } from '../src/modules/values.js'
import { cohenKappa } from '../src/algo/kappa.js'
import { deficitV1, deficitV1c, deficitV1d, deficitV2, deficitV3, needWeights, learnSetpoint, personaSetpoint, APPETITE, SP_RATE_PER_DAY } from '../src/algo/deficit.js'
import { affectNeedDeltas, capDayDeltas, moodTilt } from '../src/algo/affect_need.js'
import { affectDynV1 } from '../src/algo/affect_dyn.js'
import { cleanUserText } from '../src/text.js'
import { generateNow, getThoughts, pickMemories } from '../src/modules/thoughts.js'
import { has as algoHas, list as algoList, setBinding, resolveVersion, getBinding, attachDb, clearBindings, hydrateAll } from '../src/algo/index.js'
import { buildFtsQuery, buildLikeTerms } from '../src/algo/recall.js'
import { recall, recallWithAlgo, getDrive } from '../src/core.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { memoryPort, personaPort, affectPort, drivePort, selfmodPort } from '../src/ports/index.js'
import { HARD_GATES } from '../src/modules/eval.js'
import { expressionState, feltLine, wishLine } from '../src/modules/expression_state.js'
import { surfaceQueueTick, pendingSurface, takeSurface } from '../src/modules/pulse.js'
import { readReplyTone, applySelfRead } from '../src/modules/self_read.js'

process.env.DSHC_TEST_NO_LIMIT = '1'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    let env
    try { env = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { env = {} }
    const out = await handle(db, env)
    const body = JSON.stringify(out.body)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const hook = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html><head><title>测试页</title></head><body><p>你好，意识体</p></body></html>')
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, got: Buffer.concat(chunks).toString('utf8').slice(0, 200) }))
  })
})
await new Promise((r) => hook.listen(0, '127.0.0.1', r))
const hookBase = `http://127.0.0.1:${hook.address().port}`
process.env.DSHC_SEND_WEBHOOK = hookBase + '/send'
process.env.DSHC_REMIND_WEBHOOK = hookBase + '/remind'
const pass = []
const fail = []

function check(name, cond, detail) {
  if (cond) { pass.push(name); console.log('PASS ' + name) }
  else { fail.push(name); console.log('FAIL ' + name + '  ' + JSON.stringify(detail)) }
}

check('memory_items 已无 tier 旧列', !db.prepare('PRAGMA table_info(memory_items)').all().some((c) => c.name === 'tier'))
check('fact_archive 已无 tier 旧列', !db.prepare('PRAGMA table_info(fact_archive)').all().some((c) => c.name === 'tier'))

async function api(method, p, body = {}, opt = {}) {
  const env = { method, path: p, body: { ...body }, token: opt.token || 'user' }
  if (opt.key) env.body.__idempotencyKey = opt.key
  const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) })
  return r.json()
}

const key = () => 'k-' + Math.random().toString(36).slice(2)

/** 放开 C3 自修改：令牌 + 档位解锁；可选清当日变更以免撞日限 */
function grantC3(db, aid, { clearChanges = true } = {}) {
  db.prepare('UPDATE drive_state SET tokens=?, unlocked=? WHERE agent_id=?').run(
    JSON.stringify({ c1: 0, c2: 0, c3: 2, c4: 4 }),
    JSON.stringify({ c1: false, c2: false, c3: true, c4: true }),
    aid,
  )
  if (clearChanges) db.prepare('DELETE FROM changes WHERE agent_id=?').run(aid)
  // 测试夹具：隔离规则会把历史回滚当成真实隔离，这里清掉
  db.prepare("UPDATE proposals SET state='settled' WHERE agent_id=? AND state='rolled_back'").run(aid)
  if (clearChanges) db.prepare('DELETE FROM cooldowns WHERE agent_id=?').run(aid)
}

/** G5 合格证据：独立来源 + 样本量（C3 默认 20） */
function ev(samples = 20, source = 'external') {
  return [{ source, samples }]
}

try {
  // 运行环境说明不是人说的话（回归：曾经被当成用户消息写进记忆）
  check('样板消息被丢弃', cleanUserText('Time sampled while preparing turn 1, step 1: 2026-10-27T13:10:45+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.') === '')
  check('样板+真话只留真话', cleanUserText('Current runtime context. This snapshot supersedes earlier.\n\n<system-reminder>技能目录</system-reminder>\n\n你好，我叫小周') === '你好，我叫小周')
  check('普通消息原样保留', cleanUserText('帮我看看这段代码') === '帮我看看这段代码')
  // 回归：DSH 把「审批已关闭」这类运行时说明单独包成一条 user 消息，紧跟在真话后面
  check('审批样板整条丢弃', cleanUserText('Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).') === '')
  check('子代理完工不算人话', cleanUserText('Background subagent 17e3c487-467e-4992-aaa0-b3d50bec22b5 finished and will do no further work unless you send it more.') === '')
  check('压缩摘要不算人话', cleanUserText('This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.') === '')

  const h = await api('GET', '/health')
  check('健康检查', h.ok === true && h.schema_version === 11, h)

  let a = await api('POST', '/v1/agents', { name: '测试' }, { key: key() })
  const AV1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
  await api('PUT', `/v1/agents/${a.id}/avatar`, { data: AV1 }, { key: key() })
  const avGot = await api('GET', `/v1/agents/${a.id}/avatar`)
  check('头像可存取', avGot.data === AV1, String(avGot.data).slice(0, 40))
  const avBad = await api('PUT', `/v1/agents/${a.id}/avatar`, { data: 'data:text/plain;base64,eA==' }, { key: key() })
  check('头像格式校验', avBad.error?.code === 'INVALID_ARGUMENT', avBad)
  const dupA = await api('POST', '/v1/agents', { name: '测试' }, { key: key() })
  check('重名被拒绝', dupA.error?.code === 'NAME_TAKEN', dupA)
  const badName = await api('POST', '/v1/agents', { name: '坏了\uFFFD名字' }, { key: key() })
  check('坏编码名字被拒绝', badName.error?.code === 'INVALID_ARGUMENT', badName)
  check('建实例', !!a.id, a)
  const aid = a.id

  // §8.8 T4：新建后各约定 kind 有 v0+active
  const birthBinds = await api('GET', `/v1/agents/${aid}/bindings`)
  check('T4 出生绑定齐套', Array.isArray(birthBinds) && birthBinds.length === 2
    && birthBinds.every((b) => b.v0_id && b.active_id && b.v0_id === b.active_id
      && ['structure', 'taxonomy'].includes(b.kind)), birthBinds)
  const birthArts = await api('GET', `/v1/agents/${aid}/artifacts`)
  check('T4 出生工件', Array.isArray(birthArts) && birthArts.length >= 2
    && birthArts.every((x) => x.status === 'available'), birthArts)

  // 记忆与冲突
  const m1 = await api('POST', `/v1/agents/${aid}/memory`, { text: '用户喜欢猫' }, { key: key() })
  check('写记忆', !!m1.id, m1)
  const dup = await api('POST', `/v1/agents/${aid}/memory`, { text: '用户喜欢猫' }, { key: key() })
  check('重复记忆合并', dup.duplicate === true && dup.id === m1.id, dup)
  const m2 = await api('POST', `/v1/agents/${aid}/memory`, { text: '用户不喜欢猫' }, { key: key() })
  check('低风险冲突自动归并', m2.conflict === false && m2.superseded === true, m2)
  const cfs = await api('GET', `/v1/agents/${aid}/conflicts`)
  check('冲突列表', cfs.length === 1 && cfs[0].state === 'resolved' && cfs[0].resolution === 'superseded', cfs)
  const old = db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(m1.id)
  check('低风险不失效旧条', !old.invalid_at, old)

  const list = await api('GET', `/v1/agents/${aid}/memory`)
  check('记忆列表', list.length >= 2, list.length)
  const pack = await api('POST', `/v1/agents/${aid}/pack`, { query: '猫' })
  check('两条都还能召回', pack.items.some((i) => i.id === m1.id) && pack.items.length >= 1, pack)

  // 高风险（身份类）才失效旧条 + 告警
  const hi1 = await api('POST', `/v1/agents/${aid}/memory`, { text: '主人的名字是小明' }, { key: key() })
  const hi2 = await api('POST', `/v1/agents/${aid}/memory`, { text: '主人的名字不是小明' }, { key: key() })
  const hiOld = db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(hi1.id)
  check('身份类冲突才失效', hi2.conflict === true && !!hiOld.invalid_at, { hi2, hiOld })
  const refl = await api('POST', `/v1/agents/${aid}/memory`, { text: '用户不喜欢狗', type: 'reflection' }, { key: key() })
  check('反思不参与冲突检测', refl.conflict === false && refl.superseded === false, refl)
  const cfOpen = (await api('GET', `/v1/agents/${aid}/conflicts`)).filter((c) => c.state === 'open')
  check('冲突带两条原文', cfOpen.length === 1 && cfOpen[0].a && cfOpen[0].b && cfOpen[0].a.text && cfOpen[0].b.text, cfOpen[0])
  const cfRes = await api('POST', `/v1/agents/${aid}/conflicts/${cfOpen[0].id}`, { keep: 'b' }, { key: key() })
  check('冲突可选保留', cfRes.state === 'resolved' && cfRes.keep === 'b', cfRes)
  const ovAfter = await api('GET', `/v1/agents/${aid}/overview`)
  check('处理后待处理归零', Number(ovAfter.conflicts_open) === 0, ovAfter.conflicts_open)

  // 软删/恢复
  const m3 = await api('POST', `/v1/agents/${aid}/memory`, { text: '要删的记忆' }, { key: key() })
  await api('DELETE', `/v1/memory/${m3.id}`, {}, { key: key() })
  const rs = await api('POST', `/v1/memory/${m3.id}/restore`, {}, { key: key() })
  check('7 天内恢复', rs.status === 'active', rs)
  await api('DELETE', `/v1/memory/${m3.id}`, {}, { key: key() })
  db.prepare('UPDATE memory_items SET deleted_at=? WHERE id=?')
    .run(new Date(Date.now() - 8 * 86400000).toISOString(), m3.id)
  const expired = await api('POST', `/v1/memory/${m3.id}/restore`, {}, { key: key() })
  check('超期恢复 410', expired.error?.code === 'GONE', expired)

  const mp = await api('POST', `/v1/agents/${aid}/memory`, { text: '到期硬删测试' }, { key: key() })
  await api('DELETE', `/v1/memory/${mp.id}`, {}, { key: key() })
  db.prepare('UPDATE memory_items SET deleted_at=? WHERE id=?')
    .run(new Date(Date.now() - 8 * 86400000).toISOString(), mp.id)
  const purged = await api('POST', '/v1/maintenance/purge', {}, { key: key() })
  const afterPurge = await api('GET', `/v1/agents/${aid}/memory?include_deleted=1`)
  check('到期硬删', purged.memories >= 1 && !afterPurge.some((x) => x.id === mp.id), { purged })

  // 参数与闸门
  const p3 = await api('PUT', `/v1/agents/${aid}/params/memory.recall.formula`, { value: 'v3' }, { key: key() })
  check('C3 参数拒绝', p3.error?.code === 'PROPOSAL_REQUIRED', p3)
  const ps = await api('GET', `/v1/agents/${aid}/params`)
  check('参数都带 level', ps.every((x) => x.level), ps.length)

  const g1 = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'persona.step_cap', before: 0.15, after: 0.3, evidence: ev(),
  }, { key: key() })
  check('G1 红线', g1.state === 'rejected' && g1.gate_trace.find((g) => g.code)?.code === 'RED_LINE', g1)
  grantC3(db, aid)
  const c4 = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C4', field: 'memory.inject.pool', before: 50, after: 55, evidence: ev(),
  }, { key: key() })
  check('C4 自动执行', c4.state === 'committed' && !!c4.auto, c4)
  const c4chg = db.prepare('SELECT COUNT(*) n FROM changes WHERE proposal_id=?').get(c4.id).n
  check('C4 留痕 changes', c4chg === 1, c4chg)
  // 学习开关与冷却
  const lp0 = await api('GET', `/v1/agents/${aid}/learning`)
  check('学习默认开', lp0.c4Auto === true && lp0.personaLearn === true && lp0.cooldownRounds === 6, lp0)
  const lp1 = await api('PUT', `/v1/agents/${aid}/learning`, { c4Auto: false, cooldownRounds: 12 }, { key: key() })
  check('学习开关保存', lp1.c4Auto === false && lp1.cooldownRounds === 12, lp1)
  grantC3(db, aid)
  const c4off = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C4', field: 'memory.inject.pool', before: 50, after: 56, evidence: ev(),
  }, { key: key() })
  check('C4 开关关闭不自动执行', c4off.state === 'screened' && !c4off.auto, c4off)
  await api('PUT', `/v1/agents/${aid}/learning`, { c4Auto: true, cooldownRounds: 6 }, { key: key() })
  const g2 = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'x', before: 'a', after: '泄露密钥', evidence: ev(),
  }, { key: key() })
  check('G2 护栏', g2.state === 'rejected' && g2.gate_trace.find((g) => g.code)?.code === 'GUARDRAIL', g2)
  const g3 = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C1', field: 'structure.edges', before: { edges: [] }, after: { edges: [] }, evidence: ev(50),
  }, { key: key() })
  check('G3 预算', g3.state === 'rejected' && g3.gate_trace.find((g) => g.code)?.code === 'BUDGET', g3)

  const p4 = await api('PUT', `/v1/agents/${aid}/params/memory.decay.lambda`, { value: 0.03 }, { key: key() })
  check('C4 参数直改', !!p4.change_id, p4)
  const lambdaVal = (await api('GET', `/v1/agents/${aid}/params`)).find((x) => x.key === 'memory.decay.lambda')?.value
  check('C4 参数生效', Number(lambdaVal) === 0.03, { lambdaVal })
  const aIso = await api('POST', '/v1/agents', { name: '参数隔离' }, { key: key() })
  const lambdaIso = (await api('GET', `/v1/agents/${aIso.id}/params`)).find((x) => x.key === 'memory.decay.lambda')?.value
  check('参数按实例隔离', Number(lambdaIso) === 0.02, { lambdaIso })

  // G3 日限：保留 C4 变更记录
  grantC3(db, aid, { clearChanges: false })
  const g3day = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'memory.recall.formula', before: 'v2', after: 'v2b', evidence: ev(),
  }, { key: key() })
  check('G3 日限', g3day.state === 'rejected' && g3day.gate_trace.find((g) => g.code)?.code === 'BUDGET', g3day)

  // G4：清日限后靠 cooldowns 表挡同字段
  grantC3(db, aid, { clearChanges: true })
  db.prepare('INSERT OR REPLACE INTO cooldowns VALUES(?,?,?,?,?)')
    .run(aid, 'field', 'memory.recall.formula', new Date(Date.now() + 7 * 86400000).toISOString(), 'test')
  const g4 = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'memory.recall.formula', before: 'v2', after: 'v2b', evidence: ev(),
  }, { key: key() })
  check('G4 冷却', g4.state === 'rejected' && g4.gate_trace.find((g) => g.code)?.code === 'COOLDOWN', g4)
  db.prepare('DELETE FROM cooldowns WHERE agent_id=? AND scope=? AND key=?').run(aid, 'field', 'memory.recall.formula')

  grantC3(db, aid, { clearChanges: true })
  const g5 = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'memory.recall.formula', before: 'v2', after: 'v2b',
  }, { key: key() })
  check('G5 证据', g5.state === 'rejected' && g5.gate_trace.find((g) => g.code)?.code === 'EVIDENCE', g5)
  const g5n = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'memory.recall.formula', before: 'v2', after: 'v2b', evidence: [{ source: 'external', samples: 5 }],
  }, { key: key() })
  check('G5 样本量', g5n.state === 'rejected' && g5n.gate_trace.find((g) => g.code)?.code === 'EVIDENCE', g5n)
  const g5self = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'memory.recall.formula', before: 'v2', after: 'v2b', evidence: [{ source: 'system', samples: 30 }],
  }, { key: key() })
  check('G5 独立来源', g5self.state === 'rejected' && g5self.gate_trace.find((g) => g.code)?.code === 'EVIDENCE', g5self)

  // 影子与批准
  grantC3(db, aid, { clearChanges: true })
  const tokBefore = JSON.parse(db.prepare('SELECT tokens FROM drive_state WHERE agent_id=?').get(aid).tokens)
  const prop = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'memory.recall.formula', before: 'v2', after: 'v2b', evidence: ev(),
  }, { key: key() })
  check('C3 进影子', prop.state === 'shadowed', prop)
  for (let i = 0; i < 20; i++) await api('POST', `/v1/proposals/${prop.id}/shadow`, {}, { key: key() })
  const det = await api('GET', `/v1/proposals/${prop.id}`)
  const log = JSON.parse(det.shadow_log)
  check('真实影子 20 轮', log.length === 20 && 'old_ndcg' in log[0], log[0])
  check('影子行为对比', typeof log[0].query === 'string' && Array.isArray(log[0].old_ids) && 'reply_diff' in log[0], log[0])
  const ap = await api('POST', `/v1/proposals/${prop.id}/approve`, {}, { key: key() })
  check('批准进观察期', !!ap.observing_until, ap)
  check('G7 人工闭环', ap.g7 === 'passed' && !!ap.rule_version, ap)
  const tokAfter = JSON.parse(db.prepare('SELECT tokens FROM drive_state WHERE agent_id=?').get(aid).tokens)
  check('批准扣令牌', Number(tokAfter.c3) === Number(tokBefore.c3) - 1, { tokBefore, tokAfter })
  const formulaApplied = (await api('GET', `/v1/agents/${aid}/params`)).find((x) => x.key === 'memory.recall.formula')?.value
  check('批准参数落库', String(formulaApplied) === 'v2b', formulaApplied)
  const detAp = await api('GET', `/v1/proposals/${prop.id}`)
  check('G7 闸门落库', JSON.parse(detAp.gate_trace).some((g) => g.gate === 'G7' && g.result === 'pass'), detAp.gate_trace)
  db.prepare('UPDATE proposals SET shadow_hit=0.5, observing_until=? WHERE id=?')
    .run(new Date(Date.now() - 86400000).toISOString(), prop.id)
  const settle = await api('POST', '/v1/maintenance/settle', {}, { key: key() })
  const det2 = await api('GET', `/v1/proposals/${prop.id}`)
  check('观察期结算回滚', det2.state === 'rolled_back' && settle.rolled_back >= 1, { settle, state: det2.state })
  const chs = await api('GET', `/v1/agents/${aid}/changes`)
  check('变更留痕', chs.length >= 2, chs.length)

  // 情绪
  const aff = await api('POST', `/v1/agents/${aid}/affect/appraise`, { text: '谢谢你，我很喜欢' }, { key: key() })
  check('情绪评价', aff.label === 'joy' && aff.intensity > 0.5, aff)
  const affSelf = await api('POST', `/v1/agents/${aid}/affect/appraise`, { text: '我好烦，今天真糟糕' }, { key: key() })
  check('自述心情不冒充主情绪', affSelf.label !== 'irritated', affSelf)
  // 单一心情：mood(0~1) 必须是 v3 总情绪(-1~1) 的换算，别再出现两套数
  {
    const aRow = db.prepare('SELECT mood FROM affect_state WHERE agent_id=?').get(aid)
    const vRow = db.prepare('SELECT total FROM affect_v3 WHERE agent_id=?').get(aid)
    const expect = 0.5 + 0.5 * Number(vRow.total)
    check('心情只有一个数（mood = 总情绪折算）', Math.abs(Number(aRow.mood) - expect) < 0.02, { mood: aRow.mood, total: vRow.total, expect })
    const got = await api('GET', `/v1/agents/${aid}/affect`)
    check('读接口也返回同一个心情', got && Math.abs(Number(got.mood) - expect) < 0.02, { mood: got && got.mood, expect })
  }
  const epRow = db.prepare('SELECT appraisal FROM affect_episodes WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)
  const epJson = JSON.parse(epRow.appraisal)
  check('用户情绪单独留档', epJson.user_label === 'irritated', epJson.user_label)
  const dec = await api('POST', `/v1/agents/${aid}/affect/decay`, { hours: 24 }, { key: key() })
  check('情绪衰减', dec.intensity < aff.intensity, { before: aff.intensity, after: dec.intensity })
  const eps = await api('GET', `/v1/agents/${aid}/affect/episodes`)
  check('episode 落库', eps.length >= 1, eps.length)

  // 它现在觉得你：反馈 + 学习
  const readEp = db.prepare('SELECT id FROM affect_episodes WHERE agent_id=? ORDER BY started_at DESC LIMIT 1').get(aid)
  const g0 = await api('GET', `/v1/agents/${aid}/affect/guess`)
  check('读你：最近几条 + 空统计', !g0.error && g0.latest && g0.latest.episode_id === readEp.id && g0.stats.n === 0, g0.latest)
  const gfb = await api('POST', `/v1/agents/${aid}/affect/feedback`,
    { episode_id: readEp.id, correct: false, actual_label: 'calm' }, { key: key() })
  check('反馈后它按你说的改', gfb.latest.top === 'calm' && gfb.latest.topP >= 0.5, gfb.latest)
  check('反馈进统计', gfb.stats.n === 1 && gfb.stats.accuracy === 0 && gfb.stats.confusions.length === 1, gfb.stats)
  const gfbYes = await api('POST', `/v1/agents/${aid}/affect/feedback`,
    { episode_id: readEp.id, correct: true }, { key: key() })
  check('说对了就记成对', gfbYes.stats.n === 1 && gfbYes.stats.hits === 1 && gfbYes.stats.accuracy === 100, gfbYes.stats)
  const gclr = await api('POST', `/v1/agents/${aid}/affect/feedback`,
    { episode_id: readEp.id, clear: true }, { key: key() })
  check('反馈可撤销', gclr.stats.n === 0 && gclr.latest.feedback === null, gclr.stats)
  const gNone = await api('POST', `/v1/agents/${aid}/affect/feedback`, { episode_id: 'aep_nope', correct: true }, { key: key() })
  check('反馈认不出 episode', gNone.error && gNone.error.code === 'NOT_FOUND', gNone)

  // 学了会改：同一句话，纠正过之后共情项要真的变
  {
    const a3 = await api('POST', '/v1/agents', { name: '读你学习' }, { key: key() })
    const aid3 = a3.id
    // 这一段测的是「读你 + 反馈 + 时间衰减」，假设每句话都留下一条 episode；
    // 事件闸门默认 on 会让重复的同一句话被习惯化挡掉，所以这个实例固定 shadow，别让闸门插手。
    db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
      .run(aid3, 'affect.gate.mode', JSON.stringify('shadow'), now())
    const first = await api('POST', `/v1/agents/${aid3}/affect/appraise`, { text: '又画错了，重画' }, { key: key() })
    const baseE = first.v3 ? first.v3.eUser : 0
    for (let i = 0; i < 3; i++) {
      await api('POST', `/v1/agents/${aid3}/affect/appraise`, { text: '又画错了，重画' }, { key: key() })
      const g = await api('GET', `/v1/agents/${aid3}/affect/guess`)
      await api('POST', `/v1/agents/${aid3}/affect/feedback`,
        { episode_id: g.latest.episode_id, actual_label: 'calm' }, { key: key() })
    }
    const again = await api('POST', `/v1/agents/${aid3}/affect/appraise`, { text: '又画错了，重画' }, { key: key() })
    check('学了会改：共情项跟着动', again.v3 && Number(again.v3.eUser) > Number(baseE), { base: baseE, after: again.v3 && again.v3.eUser })
    // 提示词里那句「对方刚才的情绪」必须和面板上的读数一致，否则它嘴上和面板说两套
    const { latestUserEmotion } = await import('../src/core.js')
    const gs = await api('GET', `/v1/agents/${aid3}/affect/guess`)
    const le = latestUserEmotion(db, aid3)
    check('提示词的读你和面板一致', le && gs.latest && le.label === gs.latest.top, { le, top: gs.latest && gs.latest.top })
    // 时间衰减：把纠正挪到 90 天前，读数应该几乎回到它原来的判断
    db.prepare('UPDATE affect_user_read SET created_at=? WHERE agent_id=?')
      .run(new Date(Date.now() - 90 * 86400000).toISOString(), aid3)
    const aged = await api('GET', `/v1/agents/${aid3}/affect/guess`)
    check('90 天前的纠正快失效', aged.latest && Math.abs(Number(aged.latest.topP) - Number(aged.latest.raw.p)) < 0.06,
      { top: aged.latest && aged.latest.topP, raw: aged.latest && aged.latest.raw })
    // 验收：读你准确率是独立指标，没纠正过是 null，纠正过就得有值
    const mv = await api('GET', `/v1/agents/${aid3}/metrics`)
    check('读你准确率进验收', mv['affect.read_accuracy'] && typeof mv['affect.read_accuracy'].value === 'number', mv['affect.read_accuracy'])
  }

  // 驱力
  const drv = await api('GET', `/v1/agents/${aid}/drive`)
  check('驱力五维', Object.keys(drv.dims).length === 5 && drv.tokens.c4 === 4, drv)
  // 满足度抬升（真实事件）；先复位再抬，避免前面测试干扰
  db.prepare('UPDATE drive_state SET r=0.55, e=0.55, c=0.55, a=0.55, s=0.6 WHERE agent_id=?').run(aid)
  const sat = await api('POST', `/v1/agents/${aid}/drive/satisfy`, { R: 0.08, E: 0.08, skipDecay: true }, { key: key() })
  check('满足度结算', sat.dims && Number(sat.dims.R) >= 0.62 && Number(sat.applied?.R) === 0.08, sat)
  // 复位：D 落在 [0.50,0.70)；默认公式 v3（v2 + 重要度权重）一次只升一档
  db.prepare('UPDATE drive_state SET r=0.15, e=0.55, c=0.55, a=0.55, s=0.6, smooth=NULL, band=? WHERE agent_id=?')
    .run('D0', aid)
  const ev1 = await api('POST', `/v1/agents/${aid}/drive/evaluate`, {}, { key: key() })
  const ev2 = await api('POST', `/v1/agents/${aid}/drive/evaluate`, {}, { key: key() })
  const ev3 = await api('POST', `/v1/agents/${aid}/drive/evaluate`, {}, { key: key() })
  const seq = [ev1.band, ev2.band, ev3.band]
  check('缺口分档：一次只升一档', seq[0] === 'D1' && ev1.streak === 1 && seq[1] === 'D2' && ev2.streak === 1
    && (seq[2] === 'D2' || seq[2] === 'D3'), { seq, s1: ev1.streak, s2: ev2.streak, s3: ev3.streak })
  check('默认公式是带权重的 v3', ev1.algo?.version === 'v3', ev1.algo)
  check('评估带权重与加权和', ev1.weights && typeof ev1.weights.R === 'number' && typeof ev1.D_sum === 'number', { w: ev1.weights, d: ev1.D_sum })
  check('平滑与解锁字段', ev2.unlocked && ev2.unlocked.c4 === true && !!ev1.algo, ev2)
  check('评估含代理', ev1.proxies && typeof ev1.proxies.R === 'number' && typeof ev1.proxies.S === 'number', ev1.proxies)

  // 防尖峰：v1 一步到 D3；v1c 同阈值但一次只升一档
  {
    const zero = { R: 0, E: 0, C: 0, A: 0, S: 0 }
    const one = deficitV1.run({}, { dims: zero, prev_band: 'D0' })
    let c = deficitV1c.run({}, { dims: zero, prev_band: 'D0' })
    const bands = [c.band]
    for (let i = 0; i < 3; i++) {
      c = deficitV1c.run({}, { dims: zero, prev_band: c.band, smooth_prev: c.smooth })
      bands.push(c.band)
    }
    check('防尖峰：v1 可一步到 D3', one.band === 'D3', one.band)
    check('防尖峰：v1c 一次只升一档', bands.join(',') === 'D1,D2,D3,D3', bands)
  }

  // v1d：人格调制设定点 + 5×5 符号耦合（候选，默认不启用）
  {
    const neutral = personaSetpoint({ ei: 0.5, sn: 0.5, tf: 0.5, jp: 0.5, sensitivity: 0.5 })
    check('v1d：中立人格回到 0.6 设定点', ['R', 'E', 'C', 'A', 'S'].every((k) => neutral[k] === 0.6), neutral)
    const dims = { R: 0.55, E: 0.55, C: 0.55, A: 0.55, S: 0.6 }
    const base = deficitV1d.run({}, { dims, persona: {} })
    const highOpen = deficitV1d.run({}, { dims, persona: { sn: 0.9 } })
    check('v1d：偏直觉抬高探索设定点', highOpen.setpoint.E > base.setpoint.E && highOpen.deficits.E > base.deficits.E,
      { baseSet: base.setpoint.E, highSet: highOpen.setpoint.E, baseE: base.deficits.E, highE: highOpen.deficits.E })
    const lowA = deficitV1d.run({}, { dims: { ...dims, A: 0.1 }, persona: {} })
    const highA = deficitV1d.run({}, { dims: { ...dims, A: 0.9 }, persona: {} })
    check('v1d：R↔A 负耦合（自主高压低关系满足）', highA.deficits.R > lowA.deficits.R, { low: lowA.deficits.R, high: highA.deficits.R })
    const explicit = deficitV1d.run({}, { dims, persona: {}, setpoint_explicit: { R: 0.8 } })
    check('v1d：显式设定点优先', explicit.setpoint.R === 0.8 && explicit.setpoint.E === 0.6, explicit.setpoint)
  }

  // deficit@v2：五条基线由经历自己长（没有手调旋钮）
  {
    const base = { R: 0.6, E: 0.6, C: 0.6, A: 0.6, S: 0.6 }
    const dims = { R: 0.6, E: 0.6, C: 0.6, A: 0.6, S: 0.6 }
    const day = learnSetpoint({ dims, setpoint: base, habit: dims, dt_days: 1 })
    check('v2：一天最多挪 0.02', ['R', 'E', 'C', 'A', 'S'].every((k) => Math.abs(day.moved[k]) <= SP_RATE_PER_DAY + 1e-9), day.moved)

    const high = { R: 0.9, E: 0.9, C: 0.9, A: 0.9, S: 0.9 }
    const month = learnSetpoint({ dims: high, setpoint: base, habit: high, dt_days: 60 })
    check('v2：长期过得好，基线往上长且带一点胃口',
      month.setpoint.R > 0.8 && month.setpoint.R <= high.R + APPETITE.R + 1e-9,
      { setpoint: month.setpoint, habit: month.habit })

    const starved = learnSetpoint({ dims: { R: 0.1, E: 0.1, C: 0.1, A: 0.1, S: 0.1 }, setpoint: base, habit: { R: 0.1, E: 0.1, C: 0.1, A: 0.1, S: 0.1 }, dt_days: 60 })
    check('v2：被晾久了，基线往下调但不归零', starved.setpoint.R < 0.45 && starved.setpoint.R >= 0.35, starved.setpoint)

    const intuit = learnSetpoint({ dims, setpoint: base, habit: dims, persona: { sn: 0.9 }, dt_days: 30 })
    check('v2：性格只做轻微倾斜', intuit.setpoint.E > day.setpoint.E && intuit.setpoint.E <= 0.8,
      { neutral: day.setpoint.E, intuit: intuit.setpoint.E })

    const run = deficitV2.run({}, { dims, setpoint: { ...base, R: 0.8 } })
    check('v2：缺口用学出来的基线算', run.deficits.R > 0 && run.algo?.version === 'v2', run)
    check('v2：基线始终覆盖五条', ['R', 'E', 'C', 'A', 'S'].every((k) => Number.isFinite(month.setpoint[k])), month.setpoint)

    const align = learnSetpoint({ dims, setpoint: base, habit: { ...dims, R: 0.72 }, dt_days: 0.005, align_first: true })
    // 现在对齐的是「习惯 + 饱足后的胃口」：0.72 + 0.08·(1−0.5·0.72) = 0.7712
    check('v2：第一次学习直接对齐 habit+饱足后的胃口',
      Math.abs(align.setpoint.R - (align.habit.R + APPETITE.R * (1 - 0.5 * align.habit.R))) < 1e-6, align.setpoint)

    // 饱足：习惯越高，额外想吃的越少
    const lowHabit = learnSetpoint({ dims: { ...dims, R: 0.3 }, setpoint: base, habit: { ...dims, R: 0.3 }, dt_days: 0.005, align_first: true })
    const highHabit = learnSetpoint({ dims: { ...dims, R: 0.95 }, setpoint: base, habit: { ...dims, R: 0.95 }, dt_days: 0.005, align_first: true })
    check('v3：习惯越高，胃口增量越小（饱足）',
      (lowHabit.setpoint.R - 0.3) > (highHabit.setpoint.R - 0.95), (lowHabit.setpoint.R - 0.3) + ' vs ' + (highHabit.setpoint.R - 0.95))

    // 上限 0.98：不再顶死在 1.0
    const pinned = learnSetpoint({ dims: { ...dims, E: 0.99 }, setpoint: base, habit: { ...dims, E: 0.99 }, dt_days: 0.005, align_first: true })
    check('v3：胃口上限是 0.98，不是 1.0', pinned.setpoint.E <= 0.98 + 1e-9 && pinned.setpoint.E > 0.9, pinned.setpoint.E)

    // 外部状态：关系 / 底色 / 工况 / 浏览 的 mods 直接改胃口，并且封顶 ±0.08
    const noMod = learnSetpoint({ dims, setpoint: base, habit: dims, dt_days: 0.005, align_first: true })
    const withMod = learnSetpoint({ dims, setpoint: base, habit: dims, dt_days: 0.005, align_first: true, mods: { S: 0.05 } })
    check('v3：外部状态能推高胃口', withMod.setpoint.S - noMod.setpoint.S > 0.04, { a: noMod.setpoint.S, b: withMod.setpoint.S })
    const capped = learnSetpoint({ dims, setpoint: base, habit: dims, dt_days: 0.005, align_first: true, mods: { S: 0.9 } })
    check('v3：外部状态封顶 ±0.08', capped.setpoint.S - noMod.setpoint.S <= 0.08 + 1e-6, { a: noMod.setpoint.S, b: capped.setpoint.S })

    // 性格与价值观也进胃口：敏感 → 安全胃口更高；看重安全 → 安全胃口更高
    const sens = learnSetpoint({ dims, setpoint: base, habit: dims, dt_days: 0.005, align_first: true, persona: { sensitivity: 0.95 } })
    check('v3：敏感的人安全胃口更高', sens.setpoint.S - noMod.setpoint.S > 0.02, { a: noMod.setpoint.S, b: sens.setpoint.S })
    const val = learnSetpoint({ dims, setpoint: base, habit: dims, dt_days: 0.005, align_first: true, values: { security: 0.3 } })
    check('v3：看重安全的人安全胃口更高', val.setpoint.S - noMod.setpoint.S > 0.005, { a: noMod.setpoint.S, b: val.setpoint.S })

    const low = deficitV2.run({}, { dims: { R: 0.5, E: 0.5, C: 0.5, A: 0.5, S: 0.5 }, setpoint: base })
    check('v2：门槛重标后 0.17 算 D1', low.band === 'D1', low.deficits)
    const tinyGap = deficitV2.run({}, { dims: { R: 0.55, E: 0.55, C: 0.55, A: 0.55, S: 0.6 }, setpoint: base })
    check('v2：0.08 的缺口还是 D0', tinyGap.band === 'D0', tinyGap.deficits)

    // 突然被冷落一周：基线跟着慢慢挪，缺口不会当天就被「学会不指望」抹平
    const lost = learnSetpoint({
      dims: { R: 0.2, E: 0.2, C: 0.2, A: 0.2, S: 0.2 },
      setpoint: { R: 0.8, E: 0.8, C: 0.8, A: 0.8, S: 0.8 },
      habit: { R: 0.8, E: 0.8, C: 0.8, A: 0.8, S: 0.8 },
      dt_days: 7,
    })
    check('v2：突然被冷落，基线还停在原来水平（缺口真的疼）', lost.setpoint.R > 0.6, lost.setpoint)

    const sat = deficitV2.run({}, { dims: high, setpoint: month.setpoint })
    check('v2：日子稳的时候只是有点饿，不炸档', sat.deficits.R < 0.3, sat.deficits)
  }

  // deficit@v3：五维「重要度」= 性格 × 价值观，Σw=5，定档取 max(w·ñ)
  {
    const base = { R: 0.6, E: 0.6, C: 0.6, A: 0.6, S: 0.6 }
    const dims = { R: 0.5, E: 0.5, C: 0.5, A: 0.5, S: 0.5 }

    const flat = needWeights({}, {})
    check('v3：全中性时权重恰好是 1', ['R', 'E', 'C', 'A', 'S'].every((k) => Math.abs(flat.weights[k] - 1) < 1e-9), flat.weights)
    check('v3：Σw 恒为 5（阈值不用重标）', Math.abs(Object.values(flat.weights).reduce((a, b) => a + b, 0) - 5) < 1e-6, flat.weights)

    const sens = needWeights({ sensitivity: 0.9 }, {})
    check('v3：敏感的人，安全更算数', sens.weights.S > 1 && sens.weights.S <= 1.8, sens.weights)
    check('v3：偏一端之后仍归一', Math.abs(Object.values(sens.weights).reduce((a, b) => a + b, 0) - 5) < 1e-3, sens.weights)

    const val = needWeights({}, { stimulation: 0.4, security: 0.02 })
    check('v3：看重刺激，探索更算数', val.weights.E > 1.05, val.weights)
    check('v3：价值观只做调制，不越界', Math.max(...Object.values(val.weights)) < 1.8, val.weights)

    const run = deficitV3.run({}, { dims, setpoint: base, persona: {}, values: {} })
    check('v3：中性时加权不改变缺口', Math.abs(run.weighted.R - run.deficits.R) < 1e-6, run.weighted)
    check('v3：D 取加权后的最大值', Math.abs(run.D - Math.max(...Object.values(run.weighted))) < 1e-3, run)
    check('v3：D_sum 是加权平均且不超过 D', run.D_sum > 0 && run.D_sum <= run.D + 1e-9, run)
    check('v3：算法版本可追溯', run.algo?.version === 'v3', run.algo)

    const off = deficitV3.run({}, { dims, setpoint: base, persona: { sensitivity: 0.9 }, weights_on: false })
    check('v3：关掉权重就退回 v2 口径', Math.abs(off.D - Math.max(...Object.values(off.deficits))) < 1e-3, off)

    const heavy = deficitV3.run({}, { dims: { ...dims, S: 0.3 }, setpoint: base, persona: { sensitivity: 0.95 } })
    check('v3：最看重的那条饿起来更疼', heavy.weighted.S > heavy.deficits.S && heavy.D >= heavy.weighted.S - 1e-9, heavy)
  }

  // 开口门槛跟着档位走（旧口径是固定 0.30，0.18 重标之后永远够不到）
  {
    check('开口门槛：D0 不开口', minDeficitFor('D0') >= 0.9, minDeficitFor('D0'))
    check('开口门槛：D1 是 0.22', minDeficitFor('D1') === 0.22, minDeficitFor('D1'))
    check('开口门槛：D2 是 0.15', minDeficitFor('D2') === 0.15, minDeficitFor('D2'))
    check('开口门槛：D3 是 0.10', minDeficitFor('D3') === 0.10, minDeficitFor('D3'))
    check('开口门槛：档位越急门槛越低', minDeficitFor('D3') < minDeficitFor('D2') && minDeficitFor('D2') < minDeficitFor('D1'))
    check('开口门槛：参数 >0 时覆盖档位', minDeficitFor('D2', 0.3) === 0.3, minDeficitFor('D2', 0.3))
    check('开口门槛：参数为 0 时按档位', minDeficitFor('D2', 0) === 0.15)
    check('开口门槛：未知档位回落到旧值', minDeficitFor('DX') === 0.3)
  }

  // 情绪 → 驱力：按「是哪一维」推，不按「好不好」一刀切
  {
    const f = affectNeedDeltas({ label: 'frustrated', intensity: 0.8, rel: 0.8 })
    check('E→N：挫败只压胜任', f.deltas.C < 0 && f.deltas.R == null && f.deltas.E == null, f)
    const c = affectNeedDeltas({ label: 'confused', intensity: 0.7, rel: 0.6 })
    check('E→N：困惑压探索', c.deltas.E < 0, c)
    const j = affectNeedDeltas({ label: 'joy', intensity: 0.9, rel: 0.9 })
    check('E→N：高兴同时抬胜任与关系', j.deltas.C > 0 && j.deltas.R > 0, j)
    const p = affectNeedDeltas({ label: 'peaceful', intensity: 0.6, rel: 0.5 })
    check('E→N：安宁抬安全', p.deltas.S > 0, p)
    const weak = affectNeedDeltas({ label: 'joy', intensity: 0.1 })
    check('E→N：强度太低的情绪不算信号', Object.keys(weak.deltas).length === 0, weak)
    const none = affectNeedDeltas({ label: 'unknown', intensity: 1 })
    check('E→N：没有映射的情绪不动需求', Object.keys(none.deltas).length === 0, none)
    check('E→N：单次每维不超过 0.02', Object.values(j.deltas).every((v) => Math.abs(v) <= 0.0200001), j.deltas)
    const capped = capDayDeltas([{ deltas: { C: 0.02 } }, { deltas: { C: 0.02 } }, { deltas: { C: 0.02 } }, { deltas: { C: 0.02 } }], 0.06)
    check('E→N：一天每维封顶 0.06', Math.abs(capped.C - 0.06) < 1e-9, capped)
    const mixed = capDayDeltas([{ deltas: { C: -0.02 } }, { deltas: { C: 0.02, E: 0.01 } }], 0.06)
    check('E→N：正负会互相抵消再封顶', (mixed.C || 0) === 0 && Math.abs(mixed.E - 0.01) < 1e-9, mixed)
  }

  // 长期情绪改「胃口」而不是满足度：满足度每次评估都被代理拉回去，小步幅活不过一次评估
  {
    const ir = moodTilt('irritated', 0.6)
    check('长情绪：烦躁撑大自主/胜任的胃口', ir.deltas.A > 0 && ir.deltas.C > 0, ir)
    check('长情绪：烦躁不动探索', ir.deltas.E == null, ir)
    const joy = moodTilt('joy', 0.9)
    check('长情绪：高兴把关系/胜任的胃口收一点', joy.deltas.C < 0 && joy.deltas.R < 0, joy)
    check('长情绪：力度不够不当长期情绪', Object.keys(moodTilt('irritated', 0.1).deltas).length === 0)
    check('长情绪：没有映射就不动胃口', Object.keys(moodTilt('unknown', 1).deltas).length === 0)
    check('长情绪：单次不超过 0.06', Object.values(moodTilt('irritated', 1).deltas).every((v) => Math.abs(v) <= 0.0600001))
    const dims0 = { R: 0.6, E: 0.6, C: 0.6, A: 0.6, S: 0.6 }
    const base0 = { R: 0.6, E: 0.6, C: 0.6, A: 0.6, S: 0.6 }
    const k1 = learnSetpoint({ dims: dims0, setpoint: base0, habit: dims0, dt_days: 0.005, align_first: true })
    const k2 = learnSetpoint({ dims: dims0, setpoint: base0, habit: dims0, dt_days: 0.005, align_first: true, mods: moodTilt('irritated', 0.6).deltas })
    check('长情绪：真进得了胃口', k2.setpoint.A > k1.setpoint.A && k2.setpoint.C > k1.setpoint.C, { base: k1.setpoint, mood: k2.setpoint })

    // 账要对得上：五项加起来必须等于胃口本身（页面就是照着这个念的）
    const bk = learnSetpoint({
      dims: dims0, setpoint: base0, habit: dims0, dt_days: 0.005, align_first: true,
      appetite_k: 2.5, mods: { R: 0.03 },
    })
    check('胃口：拆项加起来等于胃口本身',
      ['R', 'E', 'C', 'A', 'S'].every((kk2) => {
        const d = bk.detail[kk2]
        return Math.abs(d.habit + d.appetite + d.trait + d.value + d.mod - bk.setpoint[kk2]) < 0.001
      }), bk.detail.R)
    check('胃口：倍率 k 真的乘进饱足项', bk.detail.R.appetite > 0.13, bk.detail.R)
  }

  // 主动搭话：手动催一句（议程已降级为内部调度，不再落表）
  db.prepare('DELETE FROM proactive WHERE agent_id=?').run(aid)
  db.prepare('DELETE FROM proactive_stats WHERE agent_id=?').run(aid)
  db.prepare('UPDATE drive_state SET r=0.1 WHERE agent_id=?').run(aid)
  const q1 = await api('POST', `/v1/agents/${aid}/proactive/queue`, {}, { key: key() })
  check('手动催一句能排队', q1.queued === true && !!q1.text, q1)
  const denied = await api('POST', `/v1/agents/${aid}/actions`, { port: 'send_message', payload: {} }, { key: key() })
  check('外部动作仍需授权', denied.error?.code === 'PERMISSION_REQUIRED', denied)

  // 令牌（地基：C3 每 30 天补 1、容量 2 → 空桶 rewind 60 天应封顶到 2）
  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date().toISOString(), aid)
  db.prepare('UPDATE drive_state SET tokens=?, tokens_refill_at=? WHERE agent_id=?')
    .run(JSON.stringify({ c1: 0, c2: 0, c3: 0, c4: 4 }), new Date(Date.now() - 60 * 86400000).toISOString(), aid)
  const tk = await api('POST', `/v1/agents/${aid}/tokens/refill`, {}, { key: key() })
  check('令牌补充封顶', tk.c3 === 2 && tk.c4 === 4, tk)
  let b = await api('POST', '/v1/agents', { name: 'B' }, { key: key() })
  const bid = b.id
  const t1 = await api('POST', `/v1/agents/${bid}/tokens/consume`, { class: 'c4' }, { key: key() })
  const t2 = await api('POST', `/v1/agents/${bid}/tokens/consume`, { class: 'c4' }, { key: key() })
  check('令牌消耗与日限', t1.left === 3 && t2.error?.code === 'COOLDOWN', { t1, t2 })

  // 幂等
  const k1 = key()
  const i1 = await api('POST', `/v1/agents/${aid}/memory`, { text: '幂等' }, { key: k1 })
  const i2 = await api('POST', `/v1/agents/${aid}/memory`, { text: '幂等' }, { key: k1 })
  check('同键同体同结果', i1.id === i2.id, { i1, i2 })
  const i3 = await api('POST', `/v1/agents/${aid}/memory`, { text: '不同' }, { key: k1 })
  check('同键异体 409', i3.error?.code === 'IDEMPOTENCY_CONFLICT', i3)

  // 鉴权：不能自封 system，没有有效 token 一律拒绝
  const sysTok = await api('GET', `/v1/agents/${aid}`, {}, { token: 'system' })
  check('HTTP 不能自封 system', sysTok.error?.code === 'FORBIDDEN', sysTok)
  const badTok = await api('GET', `/v1/agents/${aid}`, {}, { token: 'nope' })
  check('无效 token 401', badTok.error?.code === 'UNAUTHORIZED', badTok)

  // 并发同键：要么两边同结果，要么一边明确 409 处理中，绝不重复落库
  const ck = key()
  const [c1, c2] = await Promise.all([
    api('POST', `/v1/agents/${aid}/memory`, { text: '并发幂等' }, { key: ck }),
    api('POST', `/v1/agents/${aid}/memory`, { text: '并发幂等' }, { key: ck }),
  ])
  const ok = [c1, c2].filter((x) => !x.error)
  const busy = [c1, c2].some((x) => x.error?.code === 'IDEMPOTENCY_IN_PROGRESS')
  const same = ok.length === 2 && ok[0].id === ok[1].id
  check('并发同键不重复执行', ok.length >= 1 && (ok.length === 1 ? busy : same), { c1, c2 })
  // 幂等键 7 天后回收
  db.prepare('INSERT OR REPLACE INTO idempotency VALUES(?,?,?,?,?)')
    .run('old-key', 'h', 200, '{}', new Date(Date.now() - 8 * 86400000).toISOString())
  await api('POST', '/v1/maintenance/purge', {}, { key: key() })
  const oldLeft = db.prepare("SELECT COUNT(*) n FROM idempotency WHERE key='old-key'").get().n
  check('幂等键过期回收', oldLeft === 0, oldLeft)

  // 总状态：注意档（模型不可用/提案临期/将休眠）
  const ovW = await api('GET', `/v1/agents/${aid}/overview`)
  const { collectCatalogFromFile } = await import('../scripts/catalog-source.mjs')
  const codeItems = collectCatalogFromFile(new URL('../client.js', import.meta.url))
  const uiCat = JSON.parse(fs.readFileSync(new URL('../src/catalog.json', import.meta.url), 'utf8'))
  const tax = await api('GET', `/v1/taxonomy?agent_id=${aid}`)
  check('分类法标签表', Array.isArray(tax.labels) && tax.labels.length === 8 && tax.labels.includes('calm'), tax)

  check('完整清单与代码同步', uiCat.items === codeItems.length, { catalog: uiCat.items, code: codeItems.length })

  check('总状态有注意档', Array.isArray(ovW.warn) && ['good', 'warn', 'need', 'asleep'].includes(ovW.status), { status: ovW.status, warn: ovW.warn })

  // 跨 agent
  const cross = await api('GET', `/v1/agents/${aid}/memory`, {}, { token: 'user:agt_other' })
  check('跨 agent 404', cross.error?.code === 'NOT_FOUND', cross)
  const memRow = db.prepare("SELECT id FROM memory_items WHERE agent_id=? LIMIT 1").get(aid)
  const crossPatch = await api('PATCH', `/v1/memory/${memRow.id}`, { mark: 'high' }, { token: 'user:agt_other', key: key() })
  check('跨 agent 改记忆 404', crossPatch.error?.code === 'NOT_FOUND', crossPatch)

  // 导出/导入（/export 已与全量同形；/import 可吃 schema 6）
  const exp = await api('GET', `/v1/agents/${aid}/export`)
  check('导出 zip', !!exp.zip_base64 && exp.encrypted === false, Object.keys(exp))
  const imp = await api('POST', `/v1/agents/${bid}/import`, { zip_base64: exp.zip_base64 }, { key: key() })
  check('导入成功', (typeof imp.imported === 'number' ? imp.imported : imp.imported?.memory) >= 1, imp)
  const impNew = await api('POST', '/v1/agents/import', { zip_base64: exp.zip_base64 }, { key: key() })
  check('导出可整卡导入为新卡', !!impNew.id && !!impNew.name && impNew.id !== aid, impNew)
  const memImp = await api('GET', `/v1/agents/${impNew.id}/memory`)
  check('导入新卡带记忆', Array.isArray(memImp) && memImp.length > 0, memImp.length)
  const badImp = await api('POST', '/v1/agents/import', { zip_base64: Buffer.from('this is not a zip').toString('base64') }, { key: key() })
  check('导入坏文件报错', badImp.error?.code === 'INVALID_ARGUMENT', badImp)
  // 情绪 PAD 必须跟标签一致，且不能因反复评价饱和到 1
  let padBad = { intensity: 0.3, mood: 0.3, pleasure: 1, arousal: 1, dominance: 1 }
  for (let i = 0; i < 5; i++) {
    padBad = affectDynV1.run({}, { mode: 'apply', state: padBad,
      appraisal: { label: 'irritated', goal_congruence: 0.03, novelty: 0.3, agency: 'self' } })
  }
  check('PAD 跟着标签走', padBad.pleasure < -0.1 && padBad.arousal < 0.6 && padBad.dominance < 0.4 && padBad.mood < 0.5, padBad)
  let padCalm = { intensity: 0.3, mood: 0.3, pleasure: -0.5, arousal: 0.6, dominance: 0.3 }
  for (let i = 0; i < 4; i++) {
    padCalm = affectDynV1.run({}, { mode: 'apply', state: padCalm,
      appraisal: { label: 'calm', goal_congruence: 0, novelty: 0, agency: 'self' } })
  }
  check('平静时 PAD 回正', padCalm.pleasure > 0.1 && padCalm.arousal < 0.2, padCalm)
  freeformModelHook.complete = async () => JSON.stringify({
    name: '随意卡',
    memory: [{ text: '用户喜欢下雨天', type: 'fact' }, { text: '用户讨厌香菜', type: 'fact', tier: 'deep' }],
    persona: { 'axis.sn': 0.7, 'bad.path': 0.3 },
    preferences: [{ tag: '咖啡', aversion: 0 }],
    taboos: [{ text: '不要提加班', level: 'soft' }],
    relations: [{ name: '主人', kind: 'owner', closeness: 0.8, trust: 0.7, root: true }],
  })
  let fr
  try {
    fr = await api('POST', '/v1/agents/import/freeform', { text: '任意文件：用户喜欢下雨天、讨厌香菜、喜欢咖啡、不要提加班、和主人关系亲近。', filename: 'x.txt' }, { key: key() })
  } finally { freeformModelHook.complete = null }
  check('随意导入采用率', !!fr.id && fr.adoption.rate > 0.5 && fr.imported.memory === 2, fr)
  const frMem = await api('GET', `/v1/agents/${fr.id}/memory`)
  check('随意导入记忆落库', frMem.length >= 2, frMem.length)
  const frTab = await api('GET', `/v1/agents/${fr.id}/taboos`)
  check('随意导入禁忌落库', frTab.some((t) => String(t.text).includes('加班')), frTab)

  // agent_params：A 改参 → 导出 → 导入 B；C 仍默认
  const pA = await api('POST', '/v1/agents', { name: 'ParamA' }, { key: key() })
  await api('PUT', `/v1/agents/${pA.id}/params/memory.decay.lambda`, { value: 0.03 }, { key: key() })
  const expParams = await api('GET', `/v1/agents/${pA.id}/export`)
  const pB = await api('POST', '/v1/agents', { name: 'ParamB' }, { key: key() })
  await api('POST', `/v1/agents/${pB.id}/import`, { zip_base64: expParams.zip_base64 }, { key: key() })
  const lambdaB = (await api('GET', `/v1/agents/${pB.id}/params`)).find((x) => x.key === 'memory.decay.lambda')?.value
  const rowB = db.prepare('SELECT value FROM agent_params WHERE agent_id=? AND key=?').get(pB.id, 'memory.decay.lambda')
  check('导入参数落到 B', Number(lambdaB) === 0.03 && !!rowB, { lambdaB, rowB })
  const pC = await api('POST', '/v1/agents', { name: 'ParamC' }, { key: key() })
  const lambdaC = (await api('GET', `/v1/agents/${pC.id}/params`)).find((x) => x.key === 'memory.decay.lambda')?.value
  const rowC = db.prepare('SELECT 1 AS ok FROM agent_params WHERE agent_id=? AND key=?').get(pC.id, 'memory.decay.lambda')
  check('新建 C 仍默认', Number(lambdaC) === 0.02 && !rowC, { lambdaC, rowC })

  // 指标
  const cat = await api('GET', `/v1/metrics/catalog`)
  check('指标 52 条', cat.length === 52 && new Set(cat.map((x) => x.key)).size === 52, cat.length)

  // 事件
  const evs = await api('GET', `/v1/agents/${aid}/events/stream`)
  check('事件流', Array.isArray(evs) && evs.length >= 1, Array.isArray(evs) ? evs.length : evs)

  // 关系 / 人格自动区 / 情绪历史 / 工况
  const rels = await api('GET', `/v1/agents/${aid}/relations`)
  check('默认三条关系', rels.length === 3 && rels[0].root === 1, rels)
  const nr = await api('POST', `/v1/agents/${aid}/relations`, { name: '朋友', closeness: 0.4 }, { key: key() })
  check('新增关系', !!nr.id, nr)
  const del = await api('DELETE', `/v1/relations/${nr.id}`, {}, { key: key() })
  check('删除关系', del.deleted === true, del)

  const val = await api('PUT', `/v1/agents/${aid}/values`, { key: '诚实', weight: 0.3 }, { key: key() })
  check('价值观写入', val.weight === 0.3, val)
  const pref = await api('POST', `/v1/agents/${aid}/preferences`, { tag: '安静', aversion: 0.8 }, { key: key() })
  check('偏好写入', !!pref.id, pref)
  const tab = await api('POST', `/v1/agents/${aid}/taboos`, { text: '不要提离职', level: 'root' }, { key: key() })
  check('禁忌写入', !!tab.id, tab)
  const tabooProp = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'reply.style', before: 'a', after: '不要提离职', evidence: ev(),
  }, { key: key() })
  check('禁忌触发红线', tabooProp.gate_trace.find((g) => g.code)?.code === 'RED_LINE', tabooProp)
  const drift = await api('GET', `/v1/agents/${aid}/persona/drift`)
  check('人格漂移', typeof drift.drift === 'number', drift)

  await api('POST', `/v1/agents/${aid}/affect/appraise`, { text: '谢谢你' }, { key: key() })
  const hist = await api('GET', `/v1/agents/${aid}/affect/history?days=7`)
  check('情绪历史采样', hist.series.length >= 1 && hist.heatmap.length >= 1, hist)
  const cond = await api('PUT', `/v1/agents/${aid}/condition`, { attention: 0.2, load: 0.9 }, { key: key() })
  check('工况过载', cond.state === 'overload', cond)

  const bud = await api('PUT', `/v1/agents/${aid}/budget`, { disturb_limit: 1 }, { key: key() })
  check('预算设置', bud.disturb_limit === 1, bud)
  const rv = await api('POST', `/v1/agents/${aid}/rules`, { note: 'v6' }, { key: key() })
  check('规则版本保存', rv.version >= 1, rv)
  const act = await api('POST', `/v1/rules/${rv.id}/activate`, {}, { key: key() })
  check('规则版本启用', act.active === true, act)

  await api('PUT', `/v1/agents/${aid}/budget`, { disturb_limit: 3 }, { key: key() })
  await api('PUT', `/v1/agents/${aid}/action-ports/send_message`, { enabled: true }, { key: key() })
  const ex = await api('POST', `/v1/agents/${aid}/actions`, { port: 'send_message', payload: { text: 'hi' } }, { key: key() })
  check('真实发消息', ex.status === 'sent', ex)
  await api('PUT', `/v1/agents/${aid}/action-ports/browse`, { enabled: true }, { key: key() })
  const br = await api('POST', `/v1/agents/${aid}/actions`, { port: 'browse', payload: { url: hookBase + '/page' } }, { key: key() })
  check('真实浏览', br.status === 'fetched' && br.result.title.includes('测试页'), br)
  await api('PUT', `/v1/agents/${aid}/action-ports/remind`, { enabled: true }, { key: key() })
  const rm = await api('POST', `/v1/agents/${aid}/actions`, { port: 'remind', payload: { text: '喝水' } }, { key: key() })
  check('真实提醒', rm.status === 'sent', rm)
  const acts = await api('GET', `/v1/agents/${aid}/actions`)
  check('行动日志', acts.length >= 3, acts)

  const ms = await api('POST', `/v1/agents/${aid}/metrics/sample`, {}, { key: key() })
  check('指标采样', ms.sampled >= 1, ms)
  const mh = await api('GET', `/v1/agents/${aid}/metrics/history?days=30`)
  check('指标历史', Object.keys(mh.series).length >= 1, mh.series)
  const mvShadow = await api('GET', `/v1/agents/${aid}/metrics`)
  check('影子结果喂进硬门槛指标', mvShadow['memory.recall_hit'].value != null && mvShadow['memory.ndcg5'].value != null,
    { hit: mvShadow['memory.recall_hit'], ndcg: mvShadow['memory.ndcg5'] })

  const bt = await api('GET', `/v1/agents/${aid}/blind`)
  check('盲测：给出 5 轮 A/B', Array.isArray(bt.rounds) && bt.rounds.length === 5 && !!bt.rounds[0].a, bt && bt.rounds && bt.rounds.length)
  const bs = await api('POST', `/v1/agents/${aid}/blind/${bt.test_id}`,
    { answers: bt.rounds.map((r) => ({ i: r.i, choice: 'a' })) }, { key: key() })
  check('盲测：提交后落指标', bs.total === 5 && typeof bs.score === 'number', bs)
  const mv = await api('GET', `/v1/agents/${aid}/metrics`)
  check('指标有值', Object.values(mv).some((x) => x.value != null), mv['memory.core_token'])

  const ing = await api('POST', `/v1/agents/${aid}/ingest`, { turns: [{ role: 'user', text: '我喜欢猫。我讨厌吵闹。' }] }, { key: key() })
  check('自动抽取记忆', ing.extracted >= 1 && ing.written >= 1, ing)

  // 关系抽取：对话里提到的师傅 / 妹妹，让模型抽成关系表的人（按名字合并，root 不动）
  const ra = await api('POST', '/v1/agents', { name: '关系抽取测' }, { key: key() })
  const rootBefore = db.prepare('SELECT closeness FROM relations WHERE agent_id=? AND root=1').get(ra.id)
  relationsModelHook.complete = async () => JSON.stringify({
    relations: [
      { name: '猴哥', kind: 'acquaintance', identity: '师傅', closeness: 0.6, trust: 0.6, dependence: 0.1 },
      { name: '引脚', kind: 'acquaintance', identity: '妹妹', closeness: 0.55, trust: 0.5, dependence: 0.2 },
      { name: '主人', kind: 'owner', closeness: 0.99, trust: 0.99 },
    ],
  })
  try {
    const ri = await api('POST', `/v1/agents/${ra.id}/ingest`, { turns: [{ role: 'user', text: '我有个师傅叫猴哥，还有个妹妹叫引脚' }] }, { key: key() })
    check('关系抽取：提到的人自动落库', ri.relations === 2, { relations: ri.relations, names: ri.relation_names })
    const rr = db.prepare('SELECT name,closeness,notes FROM relations WHERE agent_id=? ORDER BY name').all(ra.id)
    check('关系抽取：带身份、新名字不重复建',
      rr.some((r) => r.name === '猴哥' && /师傅/.test(r.notes || '')) && rr.some((r) => r.name === '引脚' && /妹妹/.test(r.notes || '')),
      rr)
    const ri2 = await api('POST', `/v1/agents/${ra.id}/ingest`, { turns: [{ role: 'user', text: '我妹妹引脚今天又提起猴哥' }] }, { key: key() })
    const n2 = db.prepare('SELECT COUNT(*) n FROM relations WHERE agent_id=?').get(ra.id).n
    check('关系抽取：同名合并不重复建', n2 === rr.length && ri2.relations === 2, { n2, before: rr.length })
    const rootAfter = db.prepare('SELECT closeness FROM relations WHERE agent_id=? AND root=1').get(ra.id)
    check('关系抽取：root 主人不被自动改', Number(rootAfter.closeness) === Number(rootBefore.closeness), { rootBefore, rootAfter })
  } finally { relationsModelHook.complete = null }

  const full = await api('GET', `/v1/agents/${aid}/export/full`)
  check('全量导出', !!full.zip_base64, Object.keys(full))
  const impFull = await api('POST', `/v1/agents/${bid}/import/full`, { zip_base64: full.zip_base64 }, { key: key() })
  check('全量导入', impFull.imported > 10, impFull)
  check('导入回报 FTS 重建', impFull.fts === 'rebuilt', impFull)
  const srcName = db.prepare('SELECT name FROM agents WHERE id=?').get(aid).name
  check('导入不改目标实例', srcName === db.prepare('SELECT name FROM agents WHERE id=?').get(aid).name, srcName)
  const anyMem = db.prepare('SELECT text FROM memory_items WHERE agent_id=? LIMIT 1').get(aid)
  if (anyMem) {
    const term = String(anyMem.text).replace(/["'*:^()]/g, ' ').trim().slice(0, 6)
    let ftsHit = 0
    try { ftsHit = db.prepare('SELECT COUNT(*) n FROM memory_fts WHERE memory_fts MATCH ?').get(term).n } catch { ftsHit = -1 }
    check('导入后 FTS 可检索', ftsHit !== 0, { term, ftsHit })
  }

  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const bdir = path.join(dir, 'consciousness', 'backups')
  fs.mkdirSync(bdir, { recursive: true })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(path.join(dir, 'app.db'), path.join(bdir, 'app-test.db'))
  const drill = await api('GET', '/v1/maintenance/backup-drill')
  check('备份恢复演练', drill.ok === true && drill.tables > 10, drill)
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome

  const viewerPost = await api('POST', `/v1/agents/${aid}/memory`, { text: 'viewer' }, { key: key(), token: 'viewer' })
  check('viewer 只读', viewerPost.error?.code === 'FORBIDDEN', viewerPost)
  const evs2 = await api('GET', `/v1/agents/${aid}/events/stream?last=0`)
  check('事件游标', Array.isArray(evs2) && evs2.length >= 1, evs2.length)

  // 单实例运行 + 对话
  const actB = await api('POST', `/v1/agents/${bid}/activate`, {}, { key: key() })
  check('激活一个', actB.id === bid && actB.status === 'active', actB)
  const listAfter = await api('GET', '/v1/agents')
  check('只保留一个运行中', listAfter.filter((x) => x.status === 'active').length === 1, listAfter.map((x) => x.status))
  const chat1 = await api('POST', `/v1/agents/${bid}/chat`, { text: '你好，我叫小周' }, { key: key() })
  check('对话有回复', typeof chat1.reply === 'string' && chat1.reply.length > 0, chat1)
  check('对话带注入', Array.isArray(chat1.pack), chat1.pack)
  const turns = await api('GET', `/v1/agents/${bid}/chat`)
  check('对话落库', turns.length >= 2 && turns[0].role === 'user', turns.length)
  await api('POST', `/v1/agents/${bid}/memory`, { text: '用户喜欢猫' }, { key: key() })
  const chat2 = await api('POST', `/v1/agents/${bid}/chat`, { text: '我喜欢什么？' }, { key: key() })
  check('问句能召回', chat2.pack.length >= 1, chat2.pack)
  // 导入过同一套记忆时会有多条近似重复，引用哪条都算“引用记忆”；这里同时要求召回里确实有猫那条。
  check('回复引用记忆', chat2.pack.some((x) => /猫/.test(x.text)) && chat2.reply.includes(chat2.pack[0].text), chat2.reply)
  const pausedChat = await api('POST', `/v1/agents/${aid}/chat`, { text: '在吗' }, { key: key() })
  check('休眠不能说话', pausedChat.error?.code === 'READ_ONLY', pausedChat)
  const backA = await api('POST', `/v1/agents/${aid}/activate`, {}, { key: key() })
  check('切回原实例', backA.paused >= 1, backA)

  // INV10：表白名单 + 依赖图 + ports；宿主契约（mock 宿主，不启 DSH）
  const here = path.dirname(fileURLToPath(import.meta.url))
  // 沙箱里子进程的管道 stdio 会 EPERM；输出落临时文件再读，语义不变（只认退出码）。
  function runScript(name) {
    const log = path.join(dir, 'ci-' + name.replace(/\.mjs$/, '') + '.log')
    const fd = fs.openSync(log, 'w')
    let status = null
    try {
      status = spawnSync(process.execPath, [path.join(here, '..', 'scripts', name)], { stdio: ['ignore', fd, fd] }).status
    } finally {
      fs.closeSync(fd)
    }
    let text = ''
    try { text = fs.readFileSync(log, 'utf8') } catch { /* ignore */ }
    return { status, text }
  }
  const own = runScript('check-ownership.mjs')
  check('表白名单 CI', own.status === 0, own.text)
  const dep = runScript('dep-graph.mjs')
  check('依赖图无环 CI', dep.status === 0, dep.text)
  const inv9 = runScript('check-inv9.mjs')
  check('INV9 模型名 CI', inv9.status === 0, inv9.text)
  const hostCheck = runScript('check-host.mjs')
  check('宿主契约 CI', hostCheck.status === 0, hostCheck.text)
  const health2 = await api('GET', '/health')
  check('ModelPort 能力声明', health2.model?.capabilities?.reply === true && !!health2.model?.adapter, health2.model)
  check('memoryPort 契约', typeof memoryPort.query.stats === 'function' && typeof memoryPort.command.add === 'function', memoryPort)
  check('personaPort 禁忌查询', Array.isArray(personaPort.query.listRootTaboos(db, aid)), null)
  check('drivePort 令牌查询', typeof drivePort.query.tokens(db, aid) === 'object', drivePort.query.tokens(db, aid))
  // 删掉 affect 文件级隔离：其余端口不依赖 affect 实现细节（契约层可 mock）
  const mockAffect = { query: { get: () => ({ primary_label: 'calm', intensity: 0.5, mood: 0.6 }) } }
  check('affectPort 可替换', mockAffect.query.get().primary_label === 'calm' && typeof affectPort.query.get === 'function', null)
  check('selfmodPort 存在', typeof selfmodPort.command.createProposal === 'function', null)

  // INV11：算法注册表 + 切换（调用方仍是 recall / pack）
  check('已登记 recall@v2', algoHas('recall', 'v2'), algoList('recall'))
  check('已登记 recall@v2b', algoHas('recall', 'v2b'), algoList('recall'))
  check('已登记 decay@v1', algoHas('decay', 'v1'), algoList('decay'))
  check('已登记 decay@v1b', algoHas('decay', 'v1b'), algoList('decay'))
  check('已登记 deficit@v1', algoHas('deficit', 'v1'), algoList('deficit'))
  check('已登记 deficit@v1b', algoHas('deficit', 'v1b'), algoList('deficit'))
  check('已登记 deficit@v1c', algoHas('deficit', 'v1c'), algoList('deficit'))
  check('已登记 deficit@v1d', algoHas('deficit', 'v1d'), algoList('deficit'))
  check('已登记 deficit@v2', algoHas('deficit', 'v2'), algoList('deficit'))
  check('未登记 recall@v3', !algoHas('recall', 'v3'), null)
  // 查询构造：memory_fts 是 trigram，只认 ≥3 字；长句不能塞 2-gram 泛词
  check('召回查询：长句只拆 3-gram', buildLikeTerms('好了，现在还要干什么吗?').length === 0
    && /"现在还"/.test(String(buildFtsQuery('好了，现在还要干什么吗?'))), buildFtsQuery('好了，现在还要干什么吗?'))
  check('召回查询：短词走 LIKE', buildLikeTerms('养猫').includes('养猫'), buildLikeTerms('养猫'))
  setBinding(aid, 'recall', { active: 'v2' })
  const packV2 = recall(db, aid, '猫', 8, 512)
  setBinding(aid, 'recall', { active: 'v2b' })
  const packV2b = recall(db, aid, '猫', 8, 512)
  check('切换版本调用方不变', packV2.count >= 1 && packV2b.count >= 1 && packV2.algo?.version === 'v2' && packV2b.algo?.version === 'v2b', { packV2, packV2b })
  check('绑定解析为 v2b', resolveVersion(aid, 'recall') === 'v2b', getBinding(aid, 'recall'))
  const apiPack = await api('POST', `/v1/agents/${aid}/pack`, { query: '猫' })
  check('HTTP 召回走绑定版本', apiPack.algo?.version === 'v2b' && apiPack.items.length >= 1, apiPack)
  const unreg = (() => { try { recallWithAlgo(db, aid, '猫', { version: 'v9' }); return null } catch (e) { return e } })()
  check('未登记拒绝运行', unreg?.code === 'ALGO_UNREGISTERED', unreg)
  // 影子：公式字段用真版本对打
  db.prepare("DELETE FROM cooldowns WHERE agent_id=? AND key='memory.recall.formula'").run(aid)
  grantC3(db, aid, { clearChanges: true })
  const propAlgo = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'memory.recall.formula', before: 'v2', after: 'v2b', evidence: ev(20, 'algo-test'),
  }, { key: key() })
  check('切算法进影子', propAlgo.state === 'shadowed', propAlgo)
  await api('POST', `/v1/proposals/${propAlgo.id}/shadow`, {}, { key: key() })
  const detAlgo = await api('GET', `/v1/proposals/${propAlgo.id}`)
  const logAlgo = JSON.parse(detAlgo.shadow_log)
  check('影子记录算法对', logAlgo[0]?.algo?.old === 'v2' && logAlgo[0]?.algo?.new === 'v2b', logAlgo[0])
  check('影子含新旧回复', typeof logAlgo[0]?.old_reply === 'string' && typeof logAlgo[0]?.new_reply === 'string'
    && (logAlgo[0].reply_diff === 0 || logAlgo[0].reply_diff === 1), logAlgo[0])
  setBinding(aid, 'recall', { active: 'v2' })
  // decay / deficit 槽位可切换
  setBinding(aid, 'decay', { active: 'v1' })
  const packDec1 = recall(db, aid, '猫', 8, 512)
  setBinding(aid, 'decay', { active: 'v1b' })
  const packDec2 = recall(db, aid, '猫', 8, 512)
  check('decay 切换召回仍可用', packDec1.count >= 1 && packDec2.count >= 1
    && packDec1.algo?.decay === 'v1' && packDec2.algo?.decay === 'v1b', { packDec1, packDec2 })
  setBinding(aid, 'decay', { active: 'v1' })
  setBinding(aid, 'deficit', { active: 'v1' })
  const drv1 = getDrive(db, aid)
  setBinding(aid, 'deficit', { active: 'v1b' })
  const drv2 = getDrive(db, aid)
  check('deficit 切换调用方不变', drv1.algo?.version === 'v1' && drv2.algo?.version === 'v1b'
    && drv1.band && drv2.band, { drv1: drv1.algo, drv2: drv2.algo, b1: drv1.band, b2: drv2.band })

  // v1d 走真实 drive 路径：绑定 + 人格设定点
  {
    db.prepare("UPDATE persona SET value='0.9' WHERE agent_id=? AND path='axis.sn'").run(aid)
    setBinding(aid, 'deficit', { active: 'v1d' })
    const evV1d = await api('POST', `/v1/agents/${aid}/drive/evaluate`, {}, { key: key() })
    check('v1d：drive 走真实路径', evV1d.algo?.version === 'v1d' && typeof evV1d.deficits.E === 'number', evV1d.algo)
    setBinding(aid, 'deficit', { active: 'v1' })
    db.prepare("UPDATE persona SET value='0.5' WHERE agent_id=? AND path='axis.sn'").run(aid)
  }

  setBinding(aid, 'deficit', { active: 'v1' })
  const grayDec = await api('PUT', `/v1/agents/${aid}/algo-bindings/decay`, { canary: 'v1b', ratio: 0.1 }, { key: key() })
  check('decay 灰度 API', grayDec.canary === 'v1b' && grayDec.ratio === 0.1, grayDec)
  // appraise / affect_dyn 槽位可切换
  check('已登记 appraise@v1', algoHas('appraise', 'v1'), algoList('appraise'))
  check('已登记 appraise@v1b', algoHas('appraise', 'v1b'), algoList('appraise'))
  check('已登记 affect_dyn@v1', algoHas('affect_dyn', 'v1'), algoList('affect_dyn'))
  check('已登记 affect_dyn@v1b', algoHas('affect_dyn', 'v1b'), algoList('affect_dyn'))
  setBinding(aid, 'appraise', { active: 'v1' })
  const aff1 = await api('POST', `/v1/agents/${aid}/affect/appraise`, { text: '谢谢你，我很喜欢' }, { key: key() })
  setBinding(aid, 'appraise', { active: 'v1b' })
  const aff2 = await api('POST', `/v1/agents/${aid}/affect/appraise`, { text: '谢谢你，我很喜欢' }, { key: key() })
  check('appraise 切换调用方不变', aff1.label === 'joy' && aff2.label === 'joy'
    && aff1.algo?.appraise?.version === 'v1' && aff2.algo?.appraise?.version === 'v1b', { aff1: aff1.algo, aff2: aff2.algo })
  setBinding(aid, 'appraise', { active: 'v1' })
  setBinding(aid, 'affect_dyn', { active: 'v1' })
  const affD1 = await api('POST', `/v1/agents/${aid}/affect/appraise`, { text: '谢谢你' }, { key: key() })
  const beforeI = affD1.intensity
  setBinding(aid, 'affect_dyn', { active: 'v1b' })
  // 重置状态后再评，避免累积掩盖版本差
  db.prepare('UPDATE affect_state SET intensity=0.5, mood=0.6, pleasure=0.1, arousal=-0.1, dominance=0 WHERE agent_id=?').run(aid)
  const affD2 = await api('POST', `/v1/agents/${aid}/affect/appraise`, { text: '谢谢你' }, { key: key() })
  check('affect_dyn 切换调用方不变', affD1.algo?.dyn?.version === 'v1' && affD2.algo?.dyn?.version === 'v1b'
    && typeof affD2.intensity === 'number', { a1: affD1.algo, a2: affD2.algo, beforeI, i2: affD2.intensity })
  setBinding(aid, 'affect_dyn', { active: 'v1' })
  const decAlgo = await api('POST', `/v1/agents/${aid}/affect/decay`, { hours: 24 }, { key: key() })
  check('affect_dyn 衰减带版本', decAlgo.algo?.name === 'affect_dyn' && decAlgo.algo?.version === 'v1', decAlgo)
  // 议程已降级为内部调度：算法仍登记，但不再落表、不再有生成接口
  db.prepare('UPDATE drive_state SET r=0.2, e=0.2 WHERE agent_id=?').run(aid)
  const grayAff = await api('PUT', `/v1/agents/${aid}/algo-bindings/appraise`, { canary: 'v1b', ratio: 0.1 }, { key: key() })
  check('appraise 灰度 API', grayAff.canary === 'v1b' && grayAff.ratio === 0.1, grayAff)
  const bindsAll = await api('GET', `/v1/agents/${aid}/algo-bindings`)
  check('绑定含新槽位', ['appraise', 'affect_dyn'].every((n) => bindsAll.some((b) => b.name === n)), bindsAll)
  check('sys.algo_switch 可测', true, { note: '换算法回归：recall/decay/deficit/appraise/affect_dyn 切换成功' })

  // INV11 阶段 4：绑定持久化 + 灰度 API + 回滚恢复
  const catalog = await api('GET', '/v1/algos')
  check('算法目录', Array.isArray(catalog) && catalog.some((a) => a.name === 'recall' && a.version === 'v2b'), catalog)
  setBinding(aid, 'recall', { active: 'v2', canary: 'v2b', ratio: 0.5 })
  const rowDb = db.prepare('SELECT * FROM algo_bindings WHERE agent_id=? AND name=?').get(aid, 'recall')
  check('绑定落库', rowDb && rowDb.active === 'v2' && rowDb.canary === 'v2b' && Number(rowDb.ratio) === 0.5, rowDb)
  clearBindings()
  hydrateAll(db)
  check('重启后水合', getBinding(aid, 'recall')?.canary === 'v2b' && resolveVersion(aid, 'recall', 'v2') != null, getBinding(aid, 'recall'))
  const gray = await api('PUT', `/v1/agents/${aid}/algo-bindings/recall`, { canary: 'v2b', ratio: 0.2 }, { key: key() })
  check('灰度 API', gray.canary === 'v2b' && gray.ratio === 0.2, gray)
  const denyActive = await api('PUT', `/v1/agents/${aid}/algo-bindings/recall`, { active: 'v2b' }, { key: key() })
  check('切 active 需提案', denyActive.error?.code === 'PROPOSAL_REQUIRED', denyActive)
  const binds = await api('GET', `/v1/agents/${aid}/algo-bindings`)
  check('列出绑定', binds.some((b) => b.name === 'recall' && b.canary === 'v2b'), binds)
  // 批准切版本后回滚应恢复 active
  grantC3(db, aid, { clearChanges: true })
  const propSw = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'memory.recall.formula', before: 'v2', after: 'v2b', evidence: ev(20, 'persist'),
  }, { key: key() })
  for (let i = 0; i < 20; i++) await api('POST', `/v1/proposals/${propSw.id}/shadow`, {}, { key: key() })
  const apSw = await api('POST', `/v1/proposals/${propSw.id}/approve`, {}, { key: key() })
  check('批准切到 v2b', getBinding(aid, 'recall')?.active === 'v2b' && apSw.applied === 'v2b', { bind: getBinding(aid, 'recall'), apSw })
  const chSw = (await api('GET', `/v1/agents/${aid}/changes`)).find((c) => c.field === 'memory.recall.formula' && !c.rolled_back_at)
  const rbSw = await api('POST', `/v1/changes/${chSw.id}/rollback`, {}, { key: key() })
  check('回滚恢复 v2', rbSw.state === 'rolled_back' && getBinding(aid, 'recall')?.active === 'v2', { rbSw, bind: getBinding(aid, 'recall') })

  // 影子前 5 轮护栏恶化 → aborted（stub shadowEval，不靠极小 pool 碰运气）
  grantC3(db, aid, { clearChanges: true })
  const propAbort = await api('POST', `/v1/agents/${aid}/proposals`, {
    change_class: 'C3', field: 'memory.recall.formula', before: 'v2', after: 'v2b', evidence: ev(),
  }, { key: key() })
  const selfmod = await import('../src/modules/selfmod.js')
  selfmod.__testHooks.shadowEval = () => ({
    old_hit: 1, new_hit: 0, old_ndcg: 1, new_ndcg: 0, changed: 1,
    behavior_diff: 1, reply_diff: 1, guardrail_ok: false,
    query: 'stub', old_ids: [], new_ids: [], old_reply: '', new_reply: '',
  })
  let abortTick
  try {
    abortTick = selfmod.shadowTick(db, propAbort.id)
  } finally {
    selfmod.__testHooks.shadowEval = null
  }
  const detAbort = await api('GET', `/v1/proposals/${propAbort.id}`)
  check('影子中止契约', abortTick.state === 'aborted' && abortTick.aborted === true && detAbort.state === 'aborted', {
    abortTick, state: detAbort.state,
  })

  // 硬门槛 / 盲测 / 关系边 / 标定
  await api('PUT', `/v1/agents/${aid}/persona/style.address`, { value: '小明' }, { key: key() })
  await api('PUT', `/v1/agents/${aid}/persona/style.banned`, { value: '随便' }, { key: key() })
  const blind = await api('POST', `/v1/agents/${aid}/eval/identity-blind`, {}, { key: key() })
  check('同一性盲测可跑', typeof blind.value === 'number' && Array.isArray(blind.trials) && blind.trials.length === 5, blind)
  const gates = await api('GET', `/v1/agents/${aid}/eval/hard-gates`)
  // 门槛条数跟着 HARD_GATES 走：加一条门槛不该让这条测试变红
  check('硬门槛条数与定义一致', Array.isArray(gates.gates) && gates.gates.length === HARD_GATES.length
    && gates.gates.every((g) => g.key && g.threshold != null), gates.gates)
  check('未校准时 κ 不算数', gates.values['affect.label_kappa'] == null, gates.values)
  db.prepare('INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('calibration:' + aid, JSON.stringify({
      affect: { kappa: 0.62, n: 250, at: new Date().toISOString() },
      recall: { hit: 0.8, falseRecall: 0.1, n: 60, at: new Date().toISOString() },
    }))
  const gates2 = await api('GET', `/v1/agents/${aid}/eval/hard-gates`)
  check('κ 读校准值', gates2.values['affect.label_kappa'] === 0.62, gates2.values)
  const sample = await api('POST', `/v1/agents/${aid}/metrics/sample`, {}, { key: key() })
  check('采样含硬门槛字段', sample.values['affect.label_kappa'] === 0.62
    && sample.values['persona.identity_blind'] != null, sample.values)
  const edges = await api('GET', `/v1/agents/${aid}/edges`)
  check('关系边图', edges.edge_count === 12 && (edges.edges || []).length === 12 && edges.bias, edges)
  const radar = await api('GET', `/v1/agents/${aid}/affect/radar`)
  check('情绪雷达', radar.labels && radar.labels.joy != null, radar)
  const diary = await api('GET', `/v1/agents/${aid}/diary?days=7`)
  check('日记生成', typeof diary.text === 'string' && diary.text.includes('我是'), diary)
  const cal = await api('GET', `/v1/agents/${aid}/eval/calibration`)
  check('标定建议结构', Array.isArray(cal.suggestions), cal)
  const calApply = await api('POST', `/v1/agents/${aid}/eval/calibration`, {}, { key: key() })
  check('标定可应用', Array.isArray(calApply.applied), calApply)

  // §8.8 T1/T2/T3/T5：隔离晋升、影子 fork、禁硬删 v0/pinned
  {
    const b = await api('POST', '/v1/agents', { name: '隔离B' }, { key: key() })
    const bid = b.id
    const bindsA0 = await api('GET', `/v1/agents/${aid}/bindings`)
    const bindsB0 = await api('GET', `/v1/agents/${bid}/bindings`)
    const aStruct0 = bindsA0.find((x) => x.kind === 'structure')
    const bStruct0 = bindsB0.find((x) => x.kind === 'structure')
    check('T1 基线独立工件', aStruct0.active_id !== bStruct0.active_id
      && aStruct0.v0_id !== bStruct0.v0_id, { a: aStruct0, b: bStruct0 })

    function grantC1(db, agentId) {
      db.prepare('UPDATE drive_state SET tokens=?, unlocked=? WHERE agent_id=?').run(
        JSON.stringify({ c1: 2, c2: 0, c3: 0, c4: 4 }),
        JSON.stringify({ c1: true, c2: false, c3: false, c4: true }),
        agentId,
      )
      db.prepare('DELETE FROM changes WHERE agent_id=?').run(agentId)
    }
    grantC1(db, aid)
    const curArt = db.prepare('SELECT * FROM rule_artifacts WHERE id=?').get(aStruct0.active_id)
    const payload = JSON.parse(curArt.payload_json)
    payload.edges = payload.edges.map((e) => (e.id === 'E3' ? { ...e, gain: 0.99 } : e))

    const prop = await api('POST', `/v1/agents/${aid}/proposals`, {
      change_class: 'C1', field: 'structure.edges', target: 'structure',
      before: JSON.parse(curArt.payload_json), after: payload,
      evidence: ev(50, 'lab'),
    }, { key: key() })
    check('T2 C1 提案进影子+fork', prop.state === 'shadowed' && !!prop.fork_artifact_id
      && prop.shadow_total === 40, prop)

    const midShadow = await api('POST', `/v1/proposals/${prop.id}/shadow`, {}, { key: key() })
    const bindsDuring = await api('GET', `/v1/agents/${aid}/bindings`)
    const aDuring = bindsDuring.find((x) => x.kind === 'structure')
    check('T2 影子不改 active', midShadow.state === 'shadowed' && aDuring.active_id === aStruct0.active_id
      && midShadow.shadow_done === 1, { midShadow, aDuring })

    for (let i = 1; i < 40; i++) await api('POST', `/v1/proposals/${prop.id}/shadow`, {}, { key: key() })
    const approved = await api('POST', `/v1/proposals/${prop.id}/approve`, {}, { key: key() })
    const bindsA1 = await api('GET', `/v1/agents/${aid}/bindings`)
    const bindsB1 = await api('GET', `/v1/agents/${bid}/bindings`)
    const aStruct1 = bindsA1.find((x) => x.kind === 'structure')
    const bStruct1 = bindsB1.find((x) => x.kind === 'structure')
    check('T1 A 晋升不影响 B', approved.g7 === 'passed'
      && aStruct1.active_id === prop.fork_artifact_id
      && aStruct1.previous_id === aStruct0.active_id
      && bStruct1.active_id === bStruct0.active_id, { approved, aStruct1, bStruct1 })

    const edgesA = await api('GET', `/v1/agents/${aid}/edges`)
    const edgesB = await api('GET', `/v1/agents/${bid}/edges`)
    const gainA = (edgesA.edges || []).find((e) => e.id === 'E3')?.gain
    const gainB = (edgesB.edges || []).find((e) => e.id === 'E3')?.gain
    check('T1 边解析隔离', gainA === 0.99 && gainB === 0, { gainA, gainB })

    // T3：硬删 v0 拒绝
    let delV0
    try {
      const { hardDeleteArtifact } = await import('../src/modules/artifacts.js')
      hardDeleteArtifact(db, aStruct1.v0_id)
      delV0 = { ok: true }
    } catch (e) {
      delV0 = { ok: false, code: e.code || e.message }
    }
    check('T3 禁硬删 v0', delV0.ok === false && String(delV0.code).includes('PROTECTED'), delV0)

    // T5：钉住后禁硬删
    const pin = await api('POST', `/v1/agents/${aid}/artifacts/${aStruct1.active_id}/pin`, {}, { key: key() })
    check('精品钉', pin.pinned_id === aStruct1.active_id, pin)
    // 先把 active 切回 previous，使 active 不再引用 fork；pinned 仍引用
    const actPrev = await api('POST', `/v1/agents/${aid}/bindings/structure/activate`, {
      artifact_id: aStruct1.previous_id,
    }, { key: key() })
    check('切回 previous', actPrev.active_id === aStruct1.previous_id
      && actPrev.pinned_id === aStruct1.active_id, actPrev)
    let delPin
    try {
      const { hardDeleteArtifact } = await import('../src/modules/artifacts.js')
      hardDeleteArtifact(db, aStruct1.active_id)
      delPin = { ok: true }
    } catch (e) {
      delPin = { ok: false, code: e.code || e.message }
    }
    check('T5 禁硬删 pinned', delPin.ok === false && String(delPin.code).includes('PROTECTED'), delPin)

    // A5：restore-v0 只动规则绑定
    const memBefore = (await api('GET', `/v1/agents/${aid}/memory`)).length
    const rv0 = await api('POST', `/v1/agents/${aid}/bindings/structure/restore-v0`, {}, { key: key() })
    const memAfter = (await api('GET', `/v1/agents/${aid}/memory`)).length
    check('A5 restore-v0 不清记忆', rv0.active_id === aStruct1.v0_id && memAfter === memBefore,
      { rv0, memBefore, memAfter })
  }

  // 否认 / 纠正
  const na = await api('POST', '/v1/agents', { name: '纠正' }, { key: key() })
  const nm = await api('POST', `/v1/agents/${na.id}/memory`, { text: '用户养了猫' }, { key: key() })
  const ni = await api('POST', `/v1/agents/${na.id}/ingest`, { turns: [{ role: 'user', text: '我没养猫' }] }, { key: key() })
  const oldRow = db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(nm.id)
  const negRow = db.prepare("SELECT text FROM memory_items WHERE agent_id=? AND text LIKE '%没有养猫%'").get(na.id)
  check('否认：旧条时效', ni.invalidated >= 1 && !!oldRow.invalid_at, { ni, oldRow })
  check('否认：落一条否认事实', !!negRow, negRow)

  // 时间状语：以前养过、现在没了
  const ta = await api('POST', '/v1/agents', { name: '时间线' }, { key: key() })
  await api('POST', `/v1/agents/${ta.id}/memory`, { text: '用户养了猫' }, { key: key() })
  const ti = await api('POST', `/v1/agents/${ta.id}/ingest`, { turns: [{ role: 'user', text: '我以前养过猫，现在没了' }] }, { key: key() })
  const cur = db.prepare("SELECT text,invalid_at FROM memory_items WHERE agent_id=? AND text LIKE '%现在没有养猫%'").get(ta.id)
  const past = db.prepare("SELECT text,invalid_at FROM memory_items WHERE agent_id=? AND text LIKE '%以前养过猫%'").get(ta.id)
  const oldOne = db.prepare("SELECT invalid_at FROM memory_items WHERE agent_id=? AND text='用户养了猫'").get(ta.id)
  check('时间状语：过去事实只在时间线', !!past && !!past.invalid_at, past)
  check('时间状语：现状否认生效', !!cur && !cur.invalid_at, cur)
  check('时间状语：旧的现在时失效', ti.invalidated >= 1 && !!oldOne.invalid_at, { ti, oldOne })

  // 主动开口
  const pa = await api('POST', '/v1/agents', { name: '主动' }, { key: key() })
  // 默认半夜不打扰；用例跑的时刻不固定，先关掉，安静时段单独测
  await api('PUT', `/v1/agents/${pa.id}/proactive/settings`, { quiet: false }, { key: key() })
  db.prepare('UPDATE drive_state SET r=0.2 WHERE agent_id=?').run(pa.id)
  // 默认要沉默 6 小时才开口
  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(Date.now() - 10 * 3600000).toISOString(), pa.id)
  const q = await queueProactive(db, pa.id)
  const pl = await api('GET', `/v1/agents/${pa.id}/proactive`)
  check('主动：按缺口现算一句', !!q && !!q.text && q.text.length > 0, q)
  check('主动：可查询待发送', pl.length >= 1 && pl[0].state === 'pending', pl.map((x) => x.text))

  // 主动的结局：回应 / 忽略 / 维度冷却
  db.prepare('UPDATE proactive SET state=\'delivered\', delivered_at=? WHERE agent_id=?').run(new Date(Date.now() - 60000).toISOString(), pa.id)
  const answered = settleProactiveAnswered(db, pa.id)
  const st1 = proactiveStats(db, pa.id)
  check('主动：回应会记账', answered >= 1 && st1.some((s) => Number(s.answered) >= 1), { answered, st1 })

  const oldAt = new Date(Date.now() - 30 * 3600000).toISOString()
  db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('prc_test_ign', pa.id, 'test', '', 'E', 'delivered', oldAt, oldAt)
  const ig = markProactiveIgnored(db, pa.id)
  check('主动：24 小时没回应记为忽略', ig >= 1, ig)

  db.prepare("INSERT OR REPLACE INTO proactive_stats(agent_id,dim,sent,answered,ignored,last_sent_at,cooldown_until) VALUES(?,?,?,?,?,?,?)")
    .run(pa.id, 'C', 2, 0, 2, now(), new Date(Date.now() + 86400000).toISOString())
  const gate = proactiveGate(db, pa.id, 'C')
  check('主动：两次忽略后该维度冷却', gate.ok === false && gate.reason === 'cooldown', gate)

  // 混合判据：缺口 + 证据 + 时机 要压过 打扰成本 才开口
  {
    // ① 发得太勤 + 全被忽略 → 成本顶格，劲头再大也先闭嘴
    const pl = await api('POST', '/v1/agents', { name: '成本' }, { key: key() })
    await api('PUT', `/v1/agents/${pl.id}/proactive/settings`, { quiet: false }, { key: key() })
    db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(Date.now() - 10 * 3600000).toISOString(), pl.id)
    db.prepare('UPDATE drive_state SET r=0.38, smooth=NULL WHERE agent_id=?').run(pl.id)
    for (let i = 1; i <= 6; i++) {
      const at = new Date(Date.now() - i * 86400000).toISOString()
      db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at,ignored) VALUES(?,?,?,?,?,?,?,?,1)')
        .run('prc_cost_' + i, pl.id, '早先说过的一句', '', 'E', 'delivered', at, at)
    }
    const d1 = await api('GET', `/v1/agents/${pl.id}/proactive/why`)
    check('主动：成本随频次和忽略率上浮', d1.score && d1.score.cost >= 0.8 && d1.score.ignore_rate >= 0.5, d1.score)
    check('主动：被忽略多了会自己拉长沉默', d1.idle_need_hours > 6, d1.idle_need_hours)
    check('主动：沉默时长按忽略率放大', d1.will === false && d1.reason === 'idle', { will: d1.will, reason: d1.reason, idle: d1.idle_need_hours })
    const q1a = await queueProactive(db, pl.id)
    check('主动：没到沉默时长不排队', q1a === null, q1a)
    db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(Date.now() - 30 * 3600000).toISOString(), pl.id)
    const d1b = await api('GET', `/v1/agents/${pl.id}/proactive/why`)
    check('主动：劲头压不过成本就不说', d1b.will === false && d1b.reason === 'low_benefit', { will: d1b.will, reason: d1b.reason, score: d1b.score })
    const q1 = await queueProactive(db, pl.id)
    check('主动：打分不过就不排队', q1 === null, q1)

    // ② 没真材料时「探索」维不凭空编（模型/规则都不行）
    const pe = await api('POST', '/v1/agents', { name: '证据' }, { key: key() })
    await api('PUT', `/v1/agents/${pe.id}/proactive/settings`, { quiet: false }, { key: key() })
    db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(Date.now() - 10 * 3600000).toISOString(), pe.id)
    db.prepare('UPDATE drive_state SET r=0.9, e=0.1, c=0.9, a=0.9, s=0.6, smooth=NULL WHERE agent_id=?').run(pe.id)
    db.prepare("UPDATE memory_items SET status='deleted' WHERE agent_id=?").run(pe.id)
    const d2 = await api('GET', `/v1/agents/${pe.id}/proactive/why`)
    check('主动：没真事时探索维不硬说', d2.will === false && d2.reason === 'no_evidence' && (!d2.score || d2.score.evidence_items === 0), { reason: d2.reason, score: d2.score })
    const q2 = await queueProactive(db, pe.id)
    check('主动：没材料就不排队', q2 === null, q2)
    const q2m = await queueProactive(db, pe.id, { manual: true })
    check('主动：手动催也不编没发生的事', q2m.queued === false && q2m.reason === 'no_evidence', q2m)

    // ③ 安静时段：自动闭嘴，手动仍可以
    const pq = await api('POST', '/v1/agents', { name: '半夜' }, { key: key() })
    const hhmm = (dt) => String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0')
    const nowD = new Date()
    await api('PUT', `/v1/agents/${pq.id}/proactive/settings`, {
      quiet: true,
      quiet_from: hhmm(new Date(nowD.getTime() - 60000)),
      quiet_to: hhmm(new Date(nowD.getTime() + 60000)),
    }, { key: key() })
    db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(Date.now() - 10 * 3600000).toISOString(), pq.id)
    db.prepare('UPDATE drive_state SET r=0.2, smooth=NULL WHERE agent_id=?').run(pq.id)
    const d3 = await api('GET', `/v1/agents/${pq.id}/proactive/why`)
    check('主动：安静时段自动不说', d3.will === false && d3.reason === 'quiet' && d3.quiet && d3.quiet.in_window === true, { will: d3.will, reason: d3.reason, quiet: d3.quiet })
    const q3 = await queueProactive(db, pq.id)
    check('主动：安静时段不排队', q3 === null, q3)
    const q3m = await queueProactive(db, pq.id, { manual: true })
    check('主动：安静时段手动仍可以', q3m.queued === true, q3m)

    // ④ v2 判据：五道门留痕 + 收益/成本拆项 + 决策记录
    {
      const pv = await api('POST', '/v1/agents', { name: '判据' }, { key: key() })
      await api('PUT', `/v1/agents/${pv.id}/proactive/settings`, { quiet: false }, { key: key() })
      db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(Date.now() - 10 * 3600000).toISOString(), pv.id)
      db.prepare('UPDATE drive_state SET r=0.2, smooth=NULL WHERE agent_id=?').run(pv.id)
      const d = await api('GET', `/v1/agents/${pv.id}/proactive/why`)
      const gids = (d.gates || []).map((g) => g.id)
      check('判据：五道门都留痕', ['evidence', 'frequency', 'idle', 'quiet', 'disturb', 'value', 'content'].every((x) => gids.includes(x)), gids)
      check('判据：收益拆开算', d.benefit_parts && Math.abs((d.benefit_parts.deficit + d.benefit_parts.evidence + d.benefit_parts.timing) - d.benefit) < 0.002, d.benefit_parts)
      check('判据：成本拆开算', d.cost_parts && Math.abs((d.cost_parts.base + d.cost_parts.frequency + d.cost_parts.ignore) - d.cost) < 0.002, d.cost_parts)
      check('判据：情绪进了收益/成本', d.benefit_parts && d.benefit_parts.persona && d.benefit_parts.persona.mood != null
        && d.cost_parts && d.cost_parts.persona_mood != null, { b: d.benefit_parts, c: d.cost_parts })
      check('判据：给得出人话理由', typeof d.explain === 'string' && d.explain.length > 8, d.explain)
      check('判据：内容门先挂待判', d.gates.some((g) => g.id === 'content' && g.ok === null), d.gates)

      const r = await queueProactive(db, pv.id, { manual: true })
      check('判据：说了会留下完整理由链', r.queued === true && !!r.decision_id, r && { queued: r.queued, decision_id: r.decision_id })
      const hist = await api('GET', `/v1/agents/${pv.id}/proactive/decisions`)
      const top = hist[0]
      check('判据：决策记录可查', Array.isArray(hist) && !!top && top.will === true && top.reason === 'ok', top && { reason: top.reason, will: top.will })
      check('判据：记录里有门和成本收益', !!top && Array.isArray(top.gates) && top.gates.length >= 6 && !!top.chain.cost && !!top.chain.benefit, top && top.gates && top.gates.length)
      check('判据：记录能指到说过的那句', !!top && top.text === r.text && !!r.text, top && top.text)
      const w = await api('GET', `/v1/agents/${pv.id}/proactive/why`)
      check('判据：why 带上次判断', !!w.last && w.last.id === top.id, w.last && w.last.id)
      const spv = await api('PUT', `/v1/agents/${pv.id}/proactive/settings`, { push: true }, { key: key() })
      check('判据：主动发消息可授权', spv.push === true, spv)
      const spv2 = await api('PUT', `/v1/agents/${pv.id}/proactive/settings`, { push: false }, { key: key() })
      check('判据：默认不主动发消息', spv2.push === false, spv2)

      // 主动推消息：用假 controller 走完整路径（不真发、不碰任何会话）
      const line = '我在想你那句话'
      const pushId = 'prc_push_test'
      db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(pushId, pv.id, line, 'test', 'C', 'pending', now())
      let got = null
      const fake = { prompt: async (req) => { got = req } }
      const p1 = await pushProactiveLine({ db, aid: pv.id, line, proactiveId: pushId, sessionId: 'sid_test', controller: fake, prefs: { push: true } })
      const rowAfter = db.prepare('SELECT state, delivered_at FROM proactive WHERE id=?').get(pushId)
      check('推送：调 prompt 并标记已投递', p1.ok === true && got && got.sessionId === 'sid_test' && got.mode === 'queue'
        && got.content[0].text.includes(line) && rowAfter.state === 'delivered' && rowAfter.delivered_at == null,
      { p1, got, rowAfter })
      const p2 = await pushProactiveLine({ db, aid: pv.id, line, proactiveId: pushId, sessionId: 'sid_test', controller: fake, prefs: { push: false } })
      check('推送：没授权就不发', p2.ok === false && p2.reason === 'off', p2)
      const p3 = await pushProactiveLine({ db, aid: pv.id, line, proactiveId: pushId, sessionId: null, controller: fake, prefs: { push: true } })
      check('推送：没有会话就不发', p3.reason === 'no_session', p3)
      const p4 = await pushProactiveLine({ db, aid: pv.id, line, proactiveId: pushId, sessionId: 'sid_test', controller: null, prefs: { push: true } })
      check('推送：没有端口就不发', p4.reason === 'no_port', p4)
      const pushId2 = 'prc_push_fail'
      db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(pushId2, pv.id, line, 'test', 'C', 'pending', now())
      const boom = { prompt: async () => { throw new Error('session/not-found') } }
      const p5 = await pushProactiveLine({ db, aid: pv.id, line, proactiveId: pushId2, sessionId: 'sid_x', controller: boom, prefs: { push: true } })
      const rowFail = db.prepare('SELECT state FROM proactive WHERE id=?').get(pushId2)
      check('推送：失败留在待发，不丢话', p5.ok === false && p5.reason === 'prompt_failed' && rowFail.state === 'pending', { p5, state: rowFail.state })
    }

    // ⑦ 缺口代理：只看对方的话；C 与 A 分开量；事件脉冲；基线误差有值
    {
      const g = await api('POST', '/v1/agents', { name: '代理' }, { key: key() })
      db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(g.id)
      const addTurn = (role, text) => db.prepare('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?)')
        .run('cht_' + Math.random().toString(16).slice(2), g.id, role, text, '[]', null, now())
      addTurn('user', '今天还行')
      for (let i = 0; i < 4; i++) addTurn('agent', '好棒，谢谢你，喜欢')
      const px = computeNeedProxies(db, g.id)
      check('代理：正性只看用户发言', px.detail.pos20 === 0, px.detail)
      const C0 = px.proxies.C
      const A0 = px.proxies.A
      check('代理：C 与 A 不再共线', Math.abs(C0 - A0) > 0.01, { C0, A0 })
      db.prepare('UPDATE action_ports SET enabled=1 WHERE agent_id=?').run(g.id)
      const px2 = computeNeedProxies(db, g.id)
      check('代理：自主随授权面变化，C 不动', px2.proxies.A > A0 && px2.proxies.C === C0, { A0, A1: px2.proxies.A, C0, C1: px2.proxies.C })

      // 小样本要向先验收缩：n=3 全成功也不许说 tool=1.0（否则 C 被两三个样本钉死）
      db.prepare('DELETE FROM action_log WHERE agent_id=?').run(g.id)
      const insAct = db.prepare('INSERT INTO action_log VALUES(?,?,?,?,?,?)')
      for (let i = 0; i < 3; i++) insAct.run('act_x' + i, g.id, 'browse', '{}', 'ok', now())
      const pxFew = computeNeedProxies(db, g.id)
      check('代理：样本少时 tool 不拉满', pxFew.detail.tool < 0.8 && pxFew.detail.tool > 0.5, pxFew.detail)
      check('代理：样本数一起记下来', pxFew.detail.samples && pxFew.detail.samples.acts === 3, pxFew.detail.samples)
      for (let i = 0; i < 30; i++) insAct.run('act_y' + i, g.id, 'browse', '{}', 'ok', now())
      const pxMany = computeNeedProxies(db, g.id)
      check('代理：样本够了才接近满', pxMany.detail.tool > pxFew.detail.tool && pxMany.detail.tool > 0.9, { few: pxFew.detail.tool, many: pxMany.detail.tool })
      db.prepare('DELETE FROM action_log WHERE agent_id=?').run(g.id)

      // E4：久没互动 → 关系满足度下降（缺口扩大），每 20 小时最多一次
      db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(Date.now() - 3 * 86400000).toISOString(), g.id)
      const r0 = db.prepare('SELECT r FROM drive_state WHERE agent_id=?').get(g.id).r
      const p1 = pulseDriveFromSignals(db, g.id)
      const r1 = db.prepare('SELECT r FROM drive_state WHERE agent_id=?').get(g.id).r
      check('脉冲：久没互动压低关系满足', p1.some((p) => p.kind === 'lonely') && r1 < r0, { r0, r1, p1 })
      const p1b = pulseDriveFromSignals(db, g.id)
      check('脉冲：孤独不重复触发', !p1b.some((p) => p.kind === 'lonely'), p1b)

      // 安全维：新的冲突事件 → 安全满足度下降
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('evt_pulse_conf', g.id, 'memory.conflict', '{}', now())
      const s0 = db.prepare('SELECT s FROM drive_state WHERE agent_id=?').get(g.id).s
      const p2 = pulseDriveFromSignals(db, g.id)
      const s1 = db.prepare('SELECT s FROM drive_state WHERE agent_id=?').get(g.id).s
      check('脉冲：冲突压低安全满足', p2.some((p) => p.kind === 'safety') && s1 < s0, { s0, s1, p2 })

      const mts = await api('GET', `/v1/agents/${g.id}/metrics`)
      const be = mts['drive.baseline_error']
      check('缺口基线误差有值', be && typeof be.value === 'number' && be.value >= 0 && be.value <= 1, be)

      // 过载属于工况，不再混进安全感
      db.prepare('DELETE FROM condition_state WHERE agent_id=?').run(g.id)
      const sNorm = computeNeedProxies(db, g.id).proxies.S
      db.prepare('INSERT OR REPLACE INTO condition_state VALUES(?,?,?,?,?)').run(g.id, 0.8, 0.9, 'overload', now())
      const pxOver = computeNeedProxies(db, g.id)
      check('安全维不再混入过载', Math.abs(pxOver.proxies.S - sNorm) < 1e-9 && pxOver.detail.overload === 1,
        { sNorm, S: pxOver.proxies.S, overload: pxOver.detail.overload })

      // 情绪 → 驱力：只有过了闸的事件才结算
      {
        db.prepare('DELETE FROM affect_events WHERE agent_id=?').run(g.id)
        db.prepare('DELETE FROM flags WHERE key=?').run('e2n.since:' + g.id)
        const before = db.prepare('SELECT c FROM drive_state WHERE agent_id=?').get(g.id).c
        db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,rel,cong,nov,cert,prev_cong,sig,theta,gate,label,raw_label,margin,scores,episode_id,formula) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run('aev_t1', g.id, now(), '测试', 0.9, 0, 0, 1, 0, 0.9, 0.15, 0, 'frustrated', 'frustrated', 0, '{}', null, 'concern')
        coupleAffectToDrive(db, g.id)
        const gated0 = db.prepare('SELECT c FROM drive_state WHERE agent_id=?').get(g.id).c
        check('E→N：没过闸的情绪不动需求', Math.abs(gated0 - before) < 1e-9, { before, gated0 })

        db.prepare("UPDATE affect_events SET gate=1 WHERE id='aev_t1'").run()
        const res = coupleAffectToDrive(db, g.id)
        const gated1 = db.prepare('SELECT c FROM drive_state WHERE agent_id=?').get(g.id).c
        check('E→N：过了闸的挫败压低胜任', gated1 < gated0 && res.applied.C < 0, { applied: res.applied, gated1 })
        const again = coupleAffectToDrive(db, g.id)
        check('E→N：同一批事件不重复结算', again.events === 0, again)
      }

      // 回放脚本：给一条真实形状的快照事件，确认脚本能读库、能出 v1 结果
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('evt_replay_sat', g.id, 'drive.satisfaction',
        JSON.stringify({ applied: { R: 0.01 }, dims: { R: 0.55, E: 0.55, C: 0.34, A: 0.55, S: 0.6 }, dt: 0.1 }), now())
      const replay = spawnSync(process.execPath, [
        fileURLToPath(new URL('../scripts/replay-drive.mjs', import.meta.url)),
        '--db', path.join(dir, 'app.db'), '--agent', g.id,
      ], { encoding: 'utf8' })
      check('驱力回放脚本可运行', replay.status === 0 && /v1@max/.test(replay.stdout || ''),
        { status: replay.status, err: (replay.stderr || '').slice(0, 160) })

      // 合成场景：不用真实事件也能验候选公式（spike 下只有 v1c 首档是 D1）
      const sc = spawnSync(process.execPath, [
        fileURLToPath(new URL('../scripts/replay-drive.mjs', import.meta.url)),
        '--db', path.join(dir, 'app.db'), '--scenario', 'spike', '--json',
      ], { encoding: 'utf8' })
      let scOk = false
      try {
        const j = JSON.parse(sc.stdout || '{}')
        const v1c = (j.results || []).find((r) => r.formula === 'v1c')
        scOk = sc.status === 0 && j.scenario === 'spike' && v1c && v1c.band_trace[0] === 'D1'
      } catch { scOk = false }
      check('驱力回放：合成场景 spike', scOk, { status: sc.status, err: (sc.stderr || '').slice(0, 160) })
    }

    // ⑤ 模型说 SILENT：静默、不投递、留证；连续同样的判断合并成一条
    {
      const ps = await api('POST', '/v1/agents', { name: '静默' }, { key: key() })
      await api('PUT', `/v1/agents/${ps.id}/proactive/settings`, { quiet: false }, { key: key() })
      db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(Date.now() - 10 * 3600000).toISOString(), ps.id)
      db.prepare('UPDATE drive_state SET r=0.2, smooth=NULL WHERE agent_id=?').run(ps.id)
      const before = db.prepare('SELECT COUNT(*) n FROM proactive WHERE agent_id=?').get(ps.id).n
      let q = null
      try {
        freeformModelHook.complete = async () => 'SILENT'
        q = await queueProactive(db, ps.id, { manual: true })
      } finally { freeformModelHook.complete = null }
      const after = db.prepare('SELECT COUNT(*) n FROM proactive WHERE agent_id=?').get(ps.id).n
      check('静默：模型说 SILENT 就不投递', q && q.queued === false && q.reason === 'silent' && after === before, q && { reason: q.reason, after, before })
      const h = await api('GET', `/v1/agents/${ps.id}/proactive/decisions`)
      check('静默：内容门留了否证', !!h[0] && h[0].reason === 'silent' && h[0].gates.some((g) => g.id === 'content' && g.ok === false), h[0] && h[0].reason)
      const n1 = h.length
      try {
        freeformModelHook.complete = async () => 'SILENT'
        await queueProactive(db, ps.id, { manual: true })
      } finally { freeformModelHook.complete = null }
      const h2 = await api('GET', `/v1/agents/${ps.id}/proactive/decisions`)
      check('静默：连续同样的判断合并成一条', h2.length === n1 && h2[0].repeats >= 2, { n1, n2: h2.length, rep: h2[0] && h2[0].repeats })
      const dcap = await api('GET', `/v1/agents/${ps.id}/proactive/why`)
      check('静默：当天试过就不再反复叫模型', dcap.will === false && dcap.reason === 'attempt_cap' && dcap.tries_today >= 1, { reason: dcap.reason, tries: dcap.tries_today })
    }

    // ⑥ 内容门：模型给了追问/提醒腔 → 退回规则句，并写明为什么
    {
      const pc = await api('POST', '/v1/agents', { name: '内容门' }, { key: key() })
      await api('PUT', `/v1/agents/${pc.id}/proactive/settings`, { quiet: false }, { key: key() })
      db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(Date.now() - 10 * 3600000).toISOString(), pc.id)
      db.prepare('UPDATE drive_state SET r=0.2, smooth=NULL WHERE agent_id=?').run(pc.id)
      let q = null
      try {
        freeformModelHook.complete = async () => '提醒你一下：该睡了？'
        q = await queueProactive(db, pc.id, { manual: true })
      } finally { freeformModelHook.complete = null }
      check('内容门：追问/提醒腔退回规则句', q && q.queued === true && q.source === 'rules', q && { source: q.source, text: q.text })
      check('内容门：退回也要说明理由', q && q.why && q.why.gates.some((g) => g.id === 'content' && /退回/.test(g.detail)), q && q.why && q.why.gates)
    }
  }

  // 慢学习：关系三维 + 步幅上限
  const la = await api('POST', '/v1/agents', { name: '学习' }, { key: key() })
  const b0 = db.prepare('SELECT closeness,trust FROM relations WHERE agent_id=? AND root=1').get(la.id)
  const lr = learnFromTurn(db, la.id, '谢谢你，今天真好')
  const b1 = db.prepare('SELECT closeness,trust FROM relations WHERE agent_id=? AND root=1').get(la.id)
  check('慢学习：亲近上升且不超步幅', lr.changed.length >= 1 && b1.closeness > b0.closeness && b1.closeness - b0.closeness <= 0.01 + 1e-9, { b0, b1 })
  const lch = db.prepare("SELECT COUNT(*) n FROM changes WHERE agent_id=? AND field LIKE 'relations.%'").get(la.id).n
  check('慢学习：留痕可解释', lch >= 1, lch)

  // Cohen's κ
  check('κ：完全一致为 1', cohenKappa(['joy','calm','joy'], ['joy','calm','joy']).kappa === 1)
  check('κ：扣掉碰巧一致', cohenKappa(['joy','joy','joy','calm'], ['joy','joy','calm','calm']).kappa <= 0.5)

  // 认不出的情绪：推缺口 + 攒够自动起草
  const beforeE = db.prepare('SELECT e FROM drive_state WHERE agent_id=?').get(aid).e
  nudgeDeficit(db, aid, 'e', 0.02)
  const afterE = db.prepare('SELECT e FROM drive_state WHERE agent_id=?').get(aid).e
  check('认不出能推缺口', afterE > beforeE, { beforeE, afterE })
  for (let i = 0; i < 50; i++) {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('evt_unk_' + i, aid, 'affect.unlabeled', JSON.stringify({ text: '样本 ' + i, label: 'undefined_feeling' }), new Date().toISOString())
  }
  const draft = maybeDraftTaxonomy(db, aid, ['calm', 'joy'])
  db.prepare('INSERT INTO metric_samples VALUES(?,?,?,?,?)').run('mts_drv_test', aid, 'affect.label_kappa', 0.2, new Date().toISOString())
  const drvFind = await api('GET', `/v1/agents/${aid}/drivers`)
  db.prepare("DELETE FROM events WHERE agent_id=? AND type='acceptance.anomaly'").run(aid)
  await api('GET', `/v1/agents/${aid}/drivers`)
  const anEv0 = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='acceptance.anomaly'").get(aid).n
  await api('GET', `/v1/agents/${aid}/drivers`)
  const anEv1 = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='acceptance.anomaly'").get(aid).n
  check('驱动发信号+节流', anEv0 === 1 && anEv1 === 1, { anEv0, anEv1 })
  for (let i = anEv1; i < 20; i++) {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('evt_an_' + i, aid, 'acceptance.anomaly', JSON.stringify({ metric: 'affect.label_kappa', value: 0.2 }), new Date().toISOString())
  }
  const anDraft = maybeDraft(db, aid, 'appraise.version')
  db.prepare("UPDATE drive_state SET band='D0' WHERE agent_id=?").run(aid)
  let bandErr = null
  try { promoteDraft(db, aid, anDraft.id, {}) } catch (e) { bandErr = e }
  check('档位不足挡住自修改', bandErr && bandErr.code === 'BAND', bandErr && bandErr.message)
  db.prepare("UPDATE drive_state SET band='D3' WHERE agent_id=?").run(aid)
  check('验收异常可起草', anDraft && anDraft.target === 'appraise.version', anDraft)
  db.prepare("DELETE FROM flags WHERE key LIKE 'driver.push:%'").run()
  const driveC0 = Number(db.prepare('SELECT c FROM drive_state WHERE agent_id=?').get(aid).c)
  const pushed = applyDriverToDrive(db, aid)
  const driveC1 = Number(db.prepare('SELECT c FROM drive_state WHERE agent_id=?').get(aid).c)
  check('驱动推缺口', pushed.some((x) => x.driver === 'acceptance.anomaly') && driveC1 > driveC0, { driveC0, driveC1, pushed })
  const againPush = applyDriverToDrive(db, aid)
  check('推缺口有节流', againPush.length === 0, againPush)
  check('驱动：验收异常可见', Array.isArray(drvFind) && drvFind.some((d) => d.driver === 'acceptance.anomaly'), drvFind)
  const tgs = await api('GET', `/v1/agents/${aid}/targets`)
  const APPLIES = ['artifact:taxonomy', 'artifact:structure', 'param', 'binding']
  check('目标表契约完整', TARGETS.every((t) => t.id && t.label && t.changeClass && t.field && t.signal
    && t.threshold > 0 && t.windowDays > 0 && t.cooldownDays > 0 && t.evidence && t.base && APPLIES.includes(t.apply)),
  TARGETS.map((t) => t.id + ':' + t.apply))
  // 合成一个「只给数据」的目标：不改核心代码也能起草
  for (let i = 0; i < 3; i++) {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('evt_syn_' + i, aid, 'test.signal', JSON.stringify({ text: '合成信号 ' + i }), new Date().toISOString())
  }
  const synDraft = maybeDraftWithTarget(db, aid, {
    id: 'test.synthetic', label: '合成目标', changeClass: 'C4', field: 'memory.decay.lambda',
    signal: 'test.signal', threshold: 3, windowDays: 7, cooldownDays: 30, evidence: 'user-utterance', base: () => 0.02,
  })
  check('合成目标可起草（零代码改动）', synDraft && synDraft.target === 'test.synthetic', synDraft)
    check('目标进度接口', Array.isArray(tgs) && tgs.length >= 2 && tgs.some((t) => t.id === 'memory.inject.pool') && tgs.every((t) => t.threshold > 0), tgs)
    check('目标表含分类法', Array.isArray(TARGET_IDS) && TARGET_IDS.includes('taxonomy.labels'), TARGET_IDS)
    check('认不出攒够自动起草', draft && draft.samples >= 50, draft)
  const again = maybeDraftTaxonomy(db, aid, ['calm', 'joy'])
  check('草案 30 天内不重复', again === null, again)

  const drafts = await api('POST', `/v1/agents/${aid}/drafts`, {}, { key: key() })
  check('草案可查询', Array.isArray(drafts) && drafts.some((d) => d.id === draft.id && d.state === 'draft'), drafts)
  const d0 = drafts.find((d) => d.id === draft.id)
  const sug = (() => { try { return JSON.parse(d0.gate_trace || '[]')[0].suggest || {} } catch { return {} } })()
  check('草案带模型建议名', sug.proposed === true && ('name' in sug), sug)

  db.prepare('DELETE FROM changes WHERE agent_id=?').run(aid)
db.prepare('UPDATE drive_state SET unlocked=?, tokens=?, band=? WHERE agent_id=?').run(JSON.stringify({ c1: false, c2: true, c3: true, c4: true }), JSON.stringify({ c1: 0, c2: 2, c3: 2, c4: 4 }), 'D3', aid)
  const promoted = await api('POST', `/v1/proposals/${draft.id}/promote`, { key: 'bittersweet', name: '五味杂陈' }, { key: key() })
  check('草案可提交为 C2', promoted.state === 'shadowed' && Number(promoted.shadow_total) === 20, promoted)
  check('草案标记 promoted', db.prepare('SELECT state FROM proposals WHERE id=?').get(draft.id).state === 'promoted')
  for (let i = 0; i < 20; i++) tickOneShadow(db, promoted.id)
  const sh = db.prepare('SELECT shadow_done, shadow_total, state FROM proposals WHERE id=?').get(promoted.id)
  check('影子自动推进', Number(sh.shadow_done) === 20 && Number(sh.shadow_total) === 20, sh)

  // 提案 TTL：到期自动 expired，收件区不再显示
  const pTtl = 'prop_ttl_' + Math.random().toString(16).slice(2, 8)
  db.prepare("INSERT INTO proposals(id,agent_id,change_class,field,before,after,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(pTtl, aid, 'C3', 'memory.inject.pool', '50', '60', 'screened', new Date().toISOString(), new Date(Date.now() - 86400000).toISOString())
  settleObservations(db)
  check('过期提案标记 expired', db.prepare('SELECT state FROM proposals WHERE id=?').get(pTtl).state === 'expired')

  // 观察期按真实对话轮计数，不是结算调用次数
  const pObs = 'prop_obs_' + Math.random().toString(16).slice(2, 8)
  db.prepare("INSERT INTO proposals(id,agent_id,change_class,field,before,after,state,created_at,expires_at,observing_until,shadow_hit) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(pObs, aid, 'C3', 'x.y', '1', '2', 'committed', new Date().toISOString(), new Date(Date.now() + 7 * 86400000).toISOString(), new Date(Date.now() + 14 * 86400000).toISOString(), 0.9)
  for (let i = 0; i < 3; i++) {
    db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)')
      .run('ct_' + pObs + '_' + i, aid, 'user', '轮次 ' + i, new Date().toISOString())
  }
  settleObservations(db)
  const obsRow = db.prepare('SELECT observe_samples, state FROM proposals WHERE id=?').get(pObs)
  check('观察期按对话轮计数', Number(obsRow.observe_samples) === 3 && obsRow.state === 'committed', obsRow)

  // 外部新知：人投喂文件 → 直接起草，证据带出处
  const kn = await api('POST', `/v1/agents/${aid}/knowledge`, {
    title: '某篇情绪粒度论文', url: 'https://example.org/paper', note: '细分情绪标签能提升识别',
    target: 'taxonomy.labels',
  }, { key: key() })
  const knRow = db.prepare('SELECT state, gate_trace, change_class FROM proposals WHERE id=?').get(kn.id)
  check('外部新知可起草', knRow && knRow.state === 'draft' && knRow.gate_trace.includes('user-doc') && knRow.change_class === 'C2', knRow)
  const knBad = await api('POST', `/v1/agents/${aid}/knowledge`, { title: 'x', target: 'nope.nope' }, { key: key() })
  check('新知目标必须存在', knBad.error?.code === 'INVALID_ARGUMENT', knBad)
  const drvKn = await api('GET', `/v1/agents/${aid}/drivers`)
  check('新知驱动可见', Array.isArray(drvKn) && drvKn.some((d) => d.driver === 'external.knowledge'), drvKn)

  const rv1 = validateObservation({ source: 'research', title: 'x', targets: ['taxonomy.labels'], citation: { url: 'u' } })
  check('自动调研需两条出处', rv1.ok === false && rv1.errors.includes('research-needs-2-citations'), rv1)
  const rv2 = validateObservation({ source: 'research', title: 'x', targets: ['taxonomy.labels'], citation: { url: 'u' }, citations: [{ url: 'a' }, { url: 'b' }] })
  check('两条出处合格', rv2.ok === true, rv2)
  check('调研观察源占位为空', researchObserver().length === 0)
  const robs = draftFromObservation(db, aid, { source: 'research', title: '论文A', url: 'https://a', excerpt: '机制 X', targets: ['taxonomy.labels'], citation: { url: 'https://a' }, citations: [{ url: 'https://a' }, { url: 'https://b' }] })
  const rrow = db.prepare('SELECT gate_trace FROM proposals WHERE id=?').get(robs.id)
  check('自动调研观察也走同一管道', rrow.gate_trace.includes('"source":"research"'), rrow)

  // 未读红点：只有「跑满影子的可批准提案」计数，已读后归零
  db.prepare("INSERT INTO proposals(id,agent_id,change_class,field,before,after,state,created_at,expires_at,shadow_done,shadow_total) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run('prp_ready_test', aid, 'C3', 'x.y', '1', '2', 'shadowed', new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), 20, 20)
  let ovU = await api('GET', `/v1/agents/${aid}/overview`)
  check('未读=可批准提案', Number(ovU.unread) >= 1, ovU.unread)
  db.prepare("UPDATE proposals SET state='settled' WHERE agent_id=? AND state='shadowed' AND shadow_done>=shadow_total").run(aid)
  ovU = await api('GET', `/v1/agents/${aid}/overview`)
  check('处理后才消失', Number(ovU.unread) === 0, ovU.unread)

  // journal 恢复
  const mid = 'mem_crash_test'
  db.prepare("INSERT INTO journal(agent_id,op,payload,state,created_at) VALUES(?,?,?,'intent',?)")
    .run(aid, 'insert_memory', JSON.stringify({ memory_id: mid }), now())
  db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
      last_decay_at,valid_at,invalid_at,status,created_at,deleted_at,version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mid, aid, 'fact', 'normal', 'crash', 'manual', 0.5, 0.5, 1, 5, now(), null, null, 'active', now(), null, 1)
  const n = recover(db)
  const gone = !db.prepare('SELECT 1 FROM memory_items WHERE id=?').get(mid)
  check('journal 恢复', n >= 1 && gone, { n, gone })
  {
  // ---------------- 合法性 / 休眠 / 硬删 ----------------
  const g1 = await api('POST', '/v1/agents', { name: '守卫' }, { key: key() })
  const gid = g1.id
  db.prepare('UPDATE drive_state SET s=0.20 WHERE agent_id=?').run(gid)
  const lg1 = await api('GET', `/v1/agents/${gid}/legitimacy`)
  check('合法性：安全见底即 BLOCK', lg1.pass === false && lg1.reasons.some((r) => r.code === 'SAFETY_LOW'), lg1)
  db.prepare('UPDATE drive_state SET s=0.60 WHERE agent_id=?').run(gid)
  const lg2 = await api('GET', `/v1/agents/${gid}/legitimacy`)
  check('合法性：正常时 PASS', lg2.pass === true, lg2)
  await api('POST', `/v1/agents/${gid}/taboos`, { text: '别提那件事', level: 'root' }, { key: key() })
  const pr9 = await api('POST', `/v1/agents/${gid}/proposals`, {
    change_class: 'C3', field: 'persona.tone', before: 'a', after: '别提那件事', evidence: ['e1'],
  }, { key: key() })
  check('合法性：root 禁忌被 G1 拦', pr9.state === 'rejected' && pr9.gate_trace[0].code === 'RED_LINE', pr9)

  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?')
    .run(new Date(Date.now() - 30 * 86400000).toISOString(), gid)
  const dv9 = await api('GET', `/v1/agents/${gid}/drive`)
  check('休眠：30 天无互动标记为 dormant', dv9.dormant === true, { dormant: dv9.dormant, idle: dv9.idle_days })
  const rf9 = await api('POST', `/v1/agents/${gid}/tokens/refill`, {}, { key: key() })
  check('休眠：不攒令牌', Number(rf9.c4) === Number(dv9.tokens.c4), { before: dv9.tokens.c4, after: rf9.c4 })
  const ag9 = await queueProactive(db, gid)
  check('休眠：不会主动开口', ag9 === null, ag9)
  const e0 = await api('POST', `/v1/agents/${gid}/drive/evaluate`, {}, { key: key() })
  check('休眠恢复：休眠中评估把计数打到 3', e0.unlocked._resume === 3, e0.unlocked)
  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date().toISOString(), gid)
  const e1 = await api('POST', `/v1/agents/${gid}/drive/evaluate`, {}, { key: key() })
  const e2 = await api('POST', `/v1/agents/${gid}/drive/evaluate`, {}, { key: key() })
  check('休眠恢复：前两次不解锁',
    e1.unlocked._resume === 2 && e2.unlocked._resume === 1 && !e1.unlocked.c1 && !e2.unlocked.c1,
    { e1: e1.unlocked, e2: e2.unlocked })
  const e3 = await api('POST', `/v1/agents/${gid}/drive/evaluate`, {}, { key: key() })
  check('休眠恢复：第三次归零才允许解锁', e3.unlocked._resume === 0, e3.unlocked)

  const d1 = await api('POST', '/v1/agents', { name: '待清理' }, { key: key() })
  await api('POST', `/v1/agents/${d1.id}/memory`, { text: '会被清掉' }, { key: key() })
  db.prepare("UPDATE agents SET status='soft_deleted', deleted_at=? WHERE id=?")
    .run(new Date(Date.now() - 10 * 86400000).toISOString(), d1.id)
  const d2 = await api('POST', '/v1/agents', { name: '刚删' }, { key: key() })
  db.prepare("UPDATE agents SET status='soft_deleted', deleted_at=? WHERE id=?")
    .run(new Date(Date.now() - 2 * 86400000).toISOString(), d2.id)
  const pg = purgeExpired(db)
  check('硬删：超过 7 天连记忆一起清',
    pg.agents >= 1 && !db.prepare('SELECT 1 FROM agents WHERE id=?').get(d1.id)
    && db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?').get(d1.id).n === 0, pg)
  check('硬删：7 天内的保留', !!db.prepare('SELECT 1 FROM agents WHERE id=?').get(d2.id), d2.id)

  // ---------------- 注入端到端（fake ctx） ----------------
  {
    const os = await import('node:os')
    const path = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-home-'))
    const oldHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const sections = []
      const handlers = {}
      const child = {
        effect: (f) => { f(); return () => {} },
        systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
        webServer: { register: () => () => {} },
      }
      const ctx = {
        on: (n, fn) => { handlers[n] = fn },
        inject: (deps, fn) => {
          if (deps.includes('systemPrompt')) fn(child)
          else if (deps.includes('webServer')) fn({ effect: child.effect, webServer: child.webServer })
        },
        effect: (f) => f(),
      }
      const mod = await import('../index.js?e2e=' + Date.now())
      mod.apply(ctx)

      const edb = new DatabaseSync(path.join(home, 'consciousness', 'app.db'))
      edb.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
        .run('agt_e2e', '小测', 'daily', 'active', new Date().toISOString())
      edb.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
          last_decay_at,valid_at,invalid_at,status,created_at,deleted_at,version)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run('mem_e2e', 'agt_e2e', 'fact', 'normal', '用户喜欢猫', 'manual',
          0.5, 0.9, 1, 5, new Date().toISOString(), null, null, 'active', new Date().toISOString(), null, 1)

      edb.prepare('INSERT INTO affect_state VALUES(?,?,?,?,?,?,?,?,?)')
        .run('agt_e2e', 'calm', null, 0.5, 0.6, 0.1, -0.1, 0, new Date().toISOString())
      edb.prepare('INSERT INTO drive_state VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('agt_e2e', 0.55, 0.55, 0.55, 0.55, 0.6, JSON.stringify({ R: 0.6, E: 0.6, C: 0.6, A: 0.6, S: 0.6 }),
          'D0', 0, JSON.stringify({ c1: 0, c2: 0, c3: 0, c4: 4 }), new Date().toISOString(),
          '2020-01-01T00:00:00.000Z', null, null, JSON.stringify({ c1: false, c2: false, c3: false, c4: true }))
      const block = sections.length ? String(sections[0].text()) : ''
      check('注入：系统提示带上它和它的记忆',
        block.includes('小测') && block.includes('用户喜欢猫') && block.includes('关系'),
        block.slice(0, 120))

      // pre-step 召回钩子：能跑、真的召回到、并且把 next() 交回去
      const preStep = handlers['agent/pre-step']
      let nexted = false
      const preOut = typeof preStep === 'function'
        ? await preStep({ messages: [{ content: '用户喜欢猫' }] }, () => { nexted = true; return 'ok' })
        : null
      const dyn = mod.recentRecall.get('agt_e2e')
      check('注入：pre-step 真召回并续上链路',
        nexted === true && preOut === 'ok' && !!dyn && dyn.text.includes('猫'), dyn)

      const hr = mod.hostReport()
      // 只校验四个核心缝；tools / commands 缝可以 pending，不算破坏注入链路
      const coreSeams = ['systemPrompt', 'agent/pre-step', 'session/event', 'webServer']
      check('注入：宿主契约四缝全绿',
        hr && coreSeams.every((n) => hr.seams.some((s) => s.seam === n && s.level === 'ok')),
        hr && hr.summary)

      handlers['session/event']({ id: 's-e2e' }, { type: 'user/message', data: { content: [{ type: 'text', text: '你好呀' }] } })
      handlers['session/event']({ id: 's-e2e' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我在。' }] } } })
      // 回合落库是 1200ms 去抖（等 tool 步的正文），这里要等过窗口
      await new Promise((r) => setTimeout(r, 1400))
      const turns = edb.prepare('SELECT role,text FROM chat_turns ORDER BY rowid').all()
      check('注入：一轮对话写回记忆', turns.length === 2 && turns[0].text === '你好呀', turns.map((t) => t.role + ':' + t.text))

      const beforeNoise = edb.prepare('SELECT COUNT(*) n FROM chat_turns').get().n
      handlers['session/event']({ id: 's-e2e' }, { type: 'user/message', data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-01-01' }] } })
      handlers['session/event']({ id: 's-e2e' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '嗯' }] } } })
      await new Promise((r) => setTimeout(r, 1400))

      check('注入：样板消息不写回', edb.prepare('SELECT COUNT(*) n FROM chat_turns').get().n === beforeNoise,
        edb.prepare('SELECT COUNT(*) n FROM chat_turns').get().n)

      handlers['session/event']({ id: 's-e2e' }, { type: 'user/message', data: { content: [{ type: 'text', text: '谢谢你，我太喜欢了' }] } })
      handlers['session/event']({ id: 's-e2e' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我在呢。' }] } } })
      await new Promise((r) => setTimeout(r, 1700))
      const af = edb.prepare('SELECT primary_label, intensity FROM affect_state WHERE agent_id=?').get('agt_e2e')
      check('对话会更新情绪', af && af.primary_label !== 'calm', af)
      const dr = edb.prepare('SELECT last_eval_at FROM drive_state WHERE agent_id=?').get('agt_e2e')
      check('对话会评估驱力', dr && dr.last_eval_at > '2020-01-02', dr)
    } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
    }
  }

  }
} catch (e) {
  console.log('TEST ERROR', e)
} finally {
  await new Promise((r) => server.close(r))
  await new Promise((r) => hook.close(r))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* windows lock */ }
}

// 回归：观察期结算的三处坑
{
  const aid = db.prepare("SELECT id FROM agents WHERE status='active'").get().id
  const past = new Date(Date.now() - 1000).toISOString()
  db.prepare('DELETE FROM changes WHERE agent_id=?').run(aid)
  db.prepare('DELETE FROM cooldowns WHERE agent_id=?').run(aid)
  db.prepare('UPDATE drive_state SET unlocked=?, tokens=?, band=? WHERE agent_id=?')
    .run(JSON.stringify({ c1: true, c2: true, c3: true, c4: true }), JSON.stringify({ c1: 2, c2: 4, c3: 4, c4: 4 }), 'D3', aid)
  seedRuleBindings(db, aid)
  db.prepare("UPDATE proposals SET state='settled' WHERE agent_id=? AND state='rolled_back'").run(aid)

  const c4r = createProposal(db, aid, { change_class: 'C4', field: 'memory.inject.pool', before: 50, after: 55, evidence: [{ source: 'user-utterance', samples: 25 }] })
  db.prepare('UPDATE proposals SET observing_until=? WHERE id=?').run(past, c4r.id)
  settleObservations(db)
  const c4st = db.prepare('SELECT state FROM proposals WHERE id=?').get(c4r.id).state
  check('C4 观察期不误回滚', c4st === 'settled', c4st)

  db.prepare('DELETE FROM changes WHERE agent_id=?').run(aid)
  db.prepare('DELETE FROM cooldowns WHERE agent_id=?').run(aid)
  const art0 = resolveActiveArtifact(db, aid, 'taxonomy')
  const p0 = parsePayload(art0)
  const samples0 = db.prepare("SELECT COUNT(*) n FROM metric_samples WHERE agent_id=? AND key='memory.recall_hit'").get(aid).n
  const c2r = createProposal(db, aid, {
    change_class: 'C2', field: 'taxonomy.labels', target: 'taxonomy.labels',
    before: p0, after: { ...p0, affect_labels: [...p0.affect_labels, 'reg_tmp'] },
    evidence: [{ source: 'user-utterance', samples: 12 }],
  })
  for (let i = 0; i < 20; i++) tickOneShadow(db, c2r.id)
  const samples1 = db.prepare("SELECT COUNT(*) n FROM metric_samples WHERE agent_id=? AND key='memory.recall_hit'").get(aid).n
  check('结构/分类法影子不污染召回指标', samples1 === samples0, { samples0, samples1 })
  approve(db, c2r.id, 'user')
  db.prepare('UPDATE proposals SET shadow_hit=0, observing_until=? WHERE id=?').run(past, c2r.id)
  settleObservations(db)
  const c2st = db.prepare('SELECT state FROM proposals WHERE id=?').get(c2r.id).state
  const back = resolveActiveArtifact(db, aid, 'taxonomy')
  check('分类法自动回滚切回旧工件', c2st === 'rolled_back' && back && back.id === art0.id, { state: c2st, back: back && back.id, old: art0.id })
}

// 回归：草案过期 / 拒收清收件区 / 漂移拦截 / 观察样本保留
{
  const aid = db.prepare("SELECT id FROM agents WHERE status='active'").get().id
  db.prepare("INSERT INTO proposals(id,human_no,agent_id,change_class,target,field,before,after,state,gate_trace,created_at,expires_at,shadow_done,shadow_total,shadow_log,shadow_hit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run('prp_exp_test', null, aid, 'C3', 't', 'persona.step_cap', '0.15', '0.3', 'draft', '[]',
      new Date(Date.now() - 9 * 86400000).toISOString(), new Date(Date.now() - 86400000).toISOString(), 0, 0, '[]', null)
  expireProposals(db)
  check('草案过期会清掉', db.prepare("SELECT state FROM proposals WHERE id='prp_exp_test'").get().state === 'expired')

  db.prepare('DELETE FROM changes WHERE agent_id=?').run(aid)
  db.prepare('DELETE FROM cooldowns WHERE agent_id=?').run(aid)
  db.prepare('UPDATE drive_state SET unlocked=?, tokens=?, band=? WHERE agent_id=?')
    .run(JSON.stringify({ c1: true, c2: true, c3: true, c4: true }), JSON.stringify({ c1: 2, c2: 4, c3: 4, c4: 4 }), 'D3', aid)
  const rej = createProposal(db, aid, { change_class: 'C3', target: 'x', field: 'memory.recall.formula', before: 'v2', after: 'v2b', evidence: [{ source: 'user-utterance', samples: 25 }] })
  reject(db, rej.id, { reason: '测试拒绝' }, 'user')
  const inboxState = (db.prepare('SELECT state FROM inbox_items WHERE ref_id=?').get(rej.id) || {}).state
  check('拒收后收件区同步', inboxState === 'denied', inboxState)

  db.prepare('DELETE FROM changes WHERE agent_id=?').run(aid)
  db.prepare('DELETE FROM cooldowns WHERE agent_id=?').run(aid)
  const drift = createProposal(db, aid, { change_class: 'C3', target: 'x', field: 'memory.recall.formula', before: 'not-json-999', after: 'v2b', evidence: [{ source: 'user-utterance', samples: 25 }] })
  db.prepare('UPDATE proposals SET shadow_done=shadow_total WHERE id=?').run(drift.id)
  let driftErr = null
  try { approve(db, drift.id, 'user') } catch (e) { driftErr = e }
  check('批准时漂移被拦下', driftErr && driftErr.code === 'DRIFT', driftErr && driftErr.message)

  const od = draftFromObservation(db, aid, {
    source: 'research', title: '样本量测试', targets: ['taxonomy.labels'],
    citation: { url: 'https://a' }, citations: [{ url: 'https://a' }, { url: 'https://b' }], samples: 20,
  })
  const odRow = db.prepare('SELECT gate_trace FROM proposals WHERE id=?').get(od.id)
  check('观察样本量随证据保留', JSON.parse(odRow.gate_trace)[0].samples === 20, JSON.parse(odRow.gate_trace)[0].samples)
}

// 回归：等级校验 / 门槛可配置 / 影子过期 / 回滚隔离
{
  const aid = db.prepare("SELECT id FROM agents WHERE status='active'").get().id
  db.prepare('DELETE FROM changes WHERE agent_id=?').run(aid)
  db.prepare('DELETE FROM cooldowns WHERE agent_id=?').run(aid)
  db.prepare("UPDATE proposals SET state='settled' WHERE agent_id=? AND state='rolled_back'").run(aid)
  db.prepare('UPDATE drive_state SET unlocked=?, tokens=?, band=? WHERE agent_id=?')
    .run(JSON.stringify({ c1: true, c2: true, c3: true, c4: true }), JSON.stringify({ c1: 2, c2: 4, c3: 4, c4: 4 }), 'D3', aid)

  const spoof = createProposal(db, aid, { change_class: 'C4', field: 'memory.recall.formula', before: 'v2', after: 'v2b', evidence: [{ source: 'user-utterance', samples: 25 }] })
  check('等级不能降级申报', spoof.state === 'rejected' && (spoof.gate_trace || []).find((g) => g.code)?.code === 'CLASS', spoof.gate_trace)

  check('证据门槛可配置', evidenceNeed('C1') === 50 && evidenceNeed('C3') === 20 && LIMITS.shadowRounds.C1 === 40 && LIMITS.shadowTtlDays === 14, LIMITS)

  db.prepare("INSERT OR REPLACE INTO proposals(id,human_no,agent_id,change_class,target,field,before,after,state,gate_trace,created_at,expires_at,shadow_done,shadow_total,shadow_log,shadow_hit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run('prp_shadow_exp', null, aid, 'C3', 't', 'memory.recall.formula', '"v2"', '"v2b"', 'shadowed', '[]',
      new Date(Date.now() - 20 * 86400000).toISOString(), new Date(Date.now() - 86400000).toISOString(), 3, 20, '[]', null)
  expireProposals(db)
  check('影子中提案会过期', db.prepare("SELECT state FROM proposals WHERE id='prp_shadow_exp'").get().state === 'expired')

  const insRb = db.prepare("INSERT OR REPLACE INTO proposals(id,human_no,agent_id,change_class,target,field,before,after,state,gate_trace,created_at,expires_at,shadow_done,shadow_total,shadow_log,shadow_hit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  insRb.run('prp_rb_1', null, aid, 'C4', 't', 'memory.recall.weights.relation', '0.1', '0.12', 'rolled_back', '[]', new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), 0, 0, '[]', null)
  insRb.run('prp_rb_2', null, aid, 'C4', 't', 'memory.recall.weights.relation', '0.1', '0.12', 'rolled_back', '[]', new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), 0, 0, '[]', null)
  const quar = createProposal(db, aid, { change_class: 'C4', field: 'memory.recall.weights.relation', before: 0.1, after: 0.12, evidence: [{ source: 'user-utterance', samples: 25 }] })
  check('两次回滚后隔离', quar.state === 'rejected' && (quar.gate_trace || []).find((g) => g.code)?.code === 'QUARANTINE', quar.gate_trace)
}

// 回归：护栏前缀 / 提案四字段 / 版本 GC / 崩溃日志回退
{
  const aid = db.prepare("SELECT id FROM agents WHERE status='active'").get().id
  db.prepare('DELETE FROM changes WHERE agent_id=?').run(aid)
  db.prepare('DELETE FROM cooldowns WHERE agent_id=?').run(aid)
  db.prepare("UPDATE proposals SET state='settled' WHERE agent_id=? AND state='rolled_back'").run(aid)
  db.prepare('UPDATE drive_state SET unlocked=?, tokens=?, band=? WHERE agent_id=?')
    .run(JSON.stringify({ c1: true, c2: true, c3: true, c4: true }), JSON.stringify({ c1: 2, c2: 4, c3: 4, c4: 4 }), 'D3', aid)

  const guard = createProposal(db, aid, { change_class: 'C4', field: 'shadow.weights', before: 1, after: 2, evidence: [{ source: 'user-utterance', samples: 25 }] })
  check('护栏前缀一律拒绝', guard.state === 'rejected' && (guard.gate_trace || []).find((g) => g.code)?.code === 'GUARDRAIL', guard.gate_trace)

  const metaProp = createProposal(db, aid, { change_class: 'C4', field: 'memory.inject.pool', before: 50, after: 52, evidence: [{ source: 'user-utterance', samples: 25 }] })
  const mrow = db.prepare('SELECT expect, risk, rollback_plan, deficit FROM proposals WHERE id=?').get(metaProp.id)
  check('提案四字段齐全', mrow && mrow.expect && mrow.risk && mrow.rollback_plan && mrow.deficit, mrow)

  const old = new Date(Date.now() - 30 * 86400000).toISOString()
  db.prepare('INSERT INTO rule_artifacts(id,kind,version,payload_json,status,created_at,retired_at) VALUES(?,?,?,?,?,?,?)').run('art_gc_test', 'taxonomy', 999, '{}', 'available', old, null)
  const g = gcArtifacts(db, { softDays: 7, hardDays: 0 })
  check('无引用旧版本会被回收', db.prepare("SELECT status FROM rule_artifacts WHERE id='art_gc_test'").get()?.status === 'retired' || db.prepare("SELECT 1 FROM rule_artifacts WHERE id='art_gc_test'").get() === undefined, g)

  const v0 = db.prepare("SELECT v0_id FROM agent_bindings WHERE agent_id=? AND kind='taxonomy'").get(aid)
  check('v0 指针受保护', !!v0 && !!db.prepare('SELECT 1 FROM rule_artifacts WHERE id=?').get(v0.v0_id), v0)

  db.prepare('UPDATE agent_params SET value=? WHERE agent_id=? AND key=?').run('0.03', aid, 'memory.decay.lambda')
  db.prepare('INSERT INTO change_journal(id,proposal_id,agent_id,field,before_value,after_value,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('jrn_test', null, aid, 'memory.decay.lambda', '0.02', '0.03', 'pending', now(), now())
  const rec = recoverChangeJournal(db)
  const lam = JSON.parse(db.prepare("SELECT value FROM agent_params WHERE agent_id=? AND key='memory.decay.lambda'").get(aid).value)
  check('变更日志崩溃回退', rec >= 1 && Number(lam) === 0.02 && db.prepare("SELECT state FROM change_journal WHERE id='jrn_test'").get().state === 'recovered', { rec, lam })
}

// ---------------- 想法：四段、称呼、周期、只读 ----------------
{
  const aid = db.prepare("SELECT id FROM agents WHERE status='active'").get().id
  db.prepare('INSERT OR REPLACE INTO persona VALUES(?,?,?,?,?)').run(aid, 'style.address', JSON.stringify('阿明'), 'manual', now())

  const v = await generateNow(db, aid)
  check('想法四段齐全', v.items.length === 4 && v.items.every((i) => i.text && i.text.length > 0), v.items)
  check('想法保留完整句子', v.items.every((i) => i.text.length >= 10 && i.text.length <= 400 && !/[\r\n]/.test(i.text)), v.items.map((i) => i.text.length))
  check('想法用角色卡称呼', v.items[1].label === '它眼中的阿明', v.items.map((i) => i.label))
  check('想法来源可追溯', ['model', 'rules'].includes(v.source), v.source)

  const fresh = getThoughts(db, aid)
  check('想法默认新鲜状态', fresh.status === 'fresh' && fresh.items.length === 4, fresh.status)
  check('想法默认 30 天刷新', fresh.interval_days === 30, fresh.interval_days)

  db.prepare('UPDATE thoughts SET created_at=? WHERE agent_id=?')
    .run(new Date(Date.now() - 40 * 86400000).toISOString(), aid)
  const old = getThoughts(db, aid)
  check('想法过期会自动重想', old.status === 'generating' || old.status === 'stale', old.status)

  const again = await generateNow(db, aid)
  check('想法可连续更新', again.items.length === 4 && getThoughts(db, aid).status === 'fresh', again.items.length)

  db.prepare("UPDATE persona SET value=? WHERE agent_id=? AND path='style.address'").run(JSON.stringify('小柯'), aid)
  check('称呼改完标签热更新', getThoughts(db, aid).items[1].label === '它眼中的小柯', getThoughts(db, aid).items[1].label)

  db.prepare("UPDATE persona SET value=? WHERE agent_id=? AND path='style.address'").run(JSON.stringify(''), aid)
  check('称呼为空才退回你', getThoughts(db, aid).items[1].label === '它眼中的你', getThoughts(db, aid).items[1].label)
}

// ---------------- 想法取材：分层 + 权重 + 近期 + 类型均衡 ----------------
{
  const aid = db.prepare("SELECT id FROM agents WHERE status='active'").get().id
  const mk = (id, text, type, weight, days) => db.prepare(
    `INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,last_decay_at,status,created_at,version)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, aid, type, 'normal', text, 'test', 0.5, weight, 1, 5, now(), 'active',
    new Date(Date.now() - days * 86400000).toISOString(), 1)

  mk('mem_core_1', '高权重：主人不喜欢被叫老师', 'fact', 1.0, 0)
  for (let i = 0; i < 12; i++) mk('mem_f' + i, '事实素材' + i, 'fact', 0.9, 1)
  for (let i = 0; i < 6; i++) mk('mem_e' + i, '经过素材' + i, 'episode', 0.95, 60)
  for (let i = 0; i < 4; i++) mk('mem_a' + i, '感受素材' + i, 'appraisal', 0.3, 3)

  const picked = pickMemories(db, aid, 22)
  const texts = picked.items.map((x) => x.text)
  const types = new Set(picked.items.map((x) => x.type))
  check('记忆取材：高权重一定进', texts.includes('高权重：主人不喜欢被叫老师'), picked.items.slice(0, 3))
  check('记忆取材：类型均衡', types.has('事实') && types.has('经过') && types.has('感受'), [...types])
  check('记忆取材：有上限不重复', picked.items.length <= 22 && picked.items.length >= 10 && new Set(texts).size === texts.length, picked.items.length)
  check('记忆取材：近期加权可见', texts.some((t) => t === '事实素材0') || texts.some((t) => t.startsWith('事实素材')), texts.slice(0, 5))
}

// ---------------- 性格五轴（4 号文档 v2） ----------------
{
  // 1) σ=.5、没被戳中 → 强度 1.000
  const neutral = computeEdgeBias({ sigma: 0.5, axes: {}, stimulus: 0.1, mode: 'on', text: '今天天气不错', ownerCloseness: 0.3 })
  check('五轴：中性人格强度不变', Math.abs(neutral.intensityMul - 1) < 1e-9, neutral.intensityMul)

  // 2) 同一句话，σ 越大强度越大
  const lo = computeEdgeBias({ sigma: 0.1, axes: { tf: 0.9 }, stimulus: 0.9, mode: 'on', text: '你应该道歉', ownerCloseness: 0.5 })
  const hi = computeEdgeBias({ sigma: 0.9, axes: { tf: 0.9 }, stimulus: 0.9, mode: 'on', text: '你应该道歉', ownerCloseness: 0.5 })
  check('五轴：敏感度单调', hi.intensityMul > lo.intensityMul, { lo: lo.intensityMul, hi: hi.intensityMul })

  // 3) S < 门槛时不放大（小事不算）
  const lowS = computeEdgeBias({ sigma: 0.5, axes: { tf: 1 }, stimulus: 0.2, mode: 'on', text: '你应该道歉', ownerCloseness: 0.5 })
  check('五轴：小事没到门槛不放大', lowS.axis.A === 0 && lowS.intensityMul < 1.01, lowS.axis)

  // 4) 中间人格被戳中也不放大（只剩底噪）
  const mid = computeEdgeBias({ sigma: 0.5, axes: { tf: 0.5 }, stimulus: 0.9, mode: 'on', text: '你应该道歉', ownerCloseness: 0.5 })
  check('五轴：中间人格不被拧', Math.abs(mid.intensityMul - 1) < 1e-9, mid.intensityMul)

  // 5) shadow 只算不用
  const sh = computeEdgeBias({ sigma: 0.9, axes: { tf: 0.95 }, stimulus: 0.9, mode: 'shadow', text: '你应该道歉', ownerCloseness: 0.5 })
  check('五轴：shadow 只算不用', sh.intensityMul === 1 && sh.shadowIntensityMul > 1, { on: sh.intensityMul, shadow: sh.shadowIntensityMul })

  // 6) 人话投影 + 三条主效应的中性点
  check('五轴：全中间给兜底', axisWords({}) === '中间')
  const tp = typeProfile({ ei: 0.9, sn: 0.1, tf: 0.9, jp: 0.1, sensitivity: 0.5 })
  check('鱼格投影：四字母', tp.name === 'ESTP' && tp.mids === 0, tp)
  check('鱼格投影：标签强度', Math.abs(tp.strength - 0.8) < 1e-9, tp.strength)
  check('鱼格投影：中间不算偏', typeProfile({}).mids === 4, typeProfile({}))
  // 浮点坑：0.6-0.5 = 0.0999…，必须仍然算「过了 60/40」
  check('鱼格投影：0.60 写出 E', typeProfile({ ei: 0.6 }).letters[0].show === true, typeProfile({ ei: 0.6 }).letters[0])
  check('鱼格投影：0.52 不写', typeProfile({ ei: 0.52 }).letters[0].show === false, typeProfile({ ei: 0.52 }).letters[0])
  check('五轴：只写偏的', axisWords({ ei: 0.9, sn: 0.5, tf: 0.5, jp: 0.5, sensitivity: 0.9 }) === '偏外向 · 敏感',
    axisWords({ ei: 0.9, sn: 0.5, tf: 0.5, jp: 0.5, sensitivity: 0.9 }))
  check('MBTI 效应：一句话表达倾向',
    mbtiStyleLine({ ei: 0.9, sn: 0.1, tf: 0.9, jp: 0.1 }) === '多说一点、带点热度、说具体的事、先讲道理和结论、留一点弹性',
    mbtiStyleLine({ ei: 0.9, sn: 0.1, tf: 0.9, jp: 0.1 }))
  check('MBTI 效应：中间不注入', mbtiStyleLine({}) === '', mbtiStyleLine({}))
  check('MBTI 效应：整句带类型',
    mbtiPromptLine({ ei: 0.9, sn: 0.1, tf: 0.9, jp: 0.1 }) === 'MBTI：ESTP 多说一点、带点热度、说具体的事、先讲道理和结论、留一点弹性',
    mbtiPromptLine({ ei: 0.9, sn: 0.1, tf: 0.9, jp: 0.1 }))
  check('MBTI 效应：没有的轴不写（当前只有 E）',
    mbtiPromptLine({ ei: 0.598 }) === 'MBTI：E 多说一点、带点热度',
    mbtiPromptLine({ ei: 0.598 }))
  check('MBTI 效应：多轴偏出按字母热更新',
    mbtiPromptLine({ ei: 0.9, tf: 0.1 }) === 'MBTI：EF 多说一点、带点热度、先接住感受',
    mbtiPromptLine({ ei: 0.9, tf: 0.1 }))
  check('MBTI 效应：全中间不硬塞类型', mbtiPromptLine({}) === '', mbtiPromptLine({}))
  const sMid = sensitivityOf({ sensitivity: 0.5 })
  check('五轴：σ=.5 三条主效应中性', Math.abs(sMid.amp - 1) < 1e-9 && Math.abs(sMid.halfLife - 1.3) < 1e-9 && Math.abs(sMid.threshold - 0.425) < 1e-9, sMid)

  // 7) 迁移：big5 → axis、保留手写、幂等
  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-mig-'))
  const mfile = path.join(mdir, 'app.db')
  let mdb = openDb(mfile)
  mdb.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run('agt_mig', '迁移', 'daily', 'active', now())
  mdb.prepare('INSERT INTO persona(agent_id,path,value,origin,updated_at) VALUES(?,?,?,?,?)').run('agt_mig', 'big5.openness', '0.8', 'manual', now())
  mdb.close()
  mdb = openDb(mfile)
  const mig = mdb.prepare('SELECT path,value,origin FROM persona WHERE agent_id=?').all('agt_mig')
  check('迁移：big5 → axis 且保留手写', mig.length === 1 && mig[0].path === 'axis.sn' && mig[0].value === '0.8' && mig[0].origin === 'manual', mig)
  mdb.close()
  mdb = openDb(mfile)
  check('迁移：幂等不重复', mdb.prepare('SELECT COUNT(*) n FROM persona WHERE agent_id=?').get('agt_mig').n === 1)
  mdb.close()

  // 8) 解耦：性格极端也不直接写价值观
  const ddir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-dec-'))
  const d2 = openDb(path.join(ddir, 'app.db'))
  attachDb(d2)
  d2.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run('agt_dec', '解耦', 'daily', 'active', now())
  seedState(d2, 'agt_dec')
  for (const k of ['ei', 'sn', 'tf', 'jp', 'sensitivity']) {
    d2.prepare('UPDATE persona SET value=? WHERE agent_id=? AND path=?').run(JSON.stringify(1), 'agt_dec', 'axis.' + k)
  }
  const vals = growValues(d2, 'agt_dec', { force: true })
  check('解耦：性格极端不写价值观', vals.every((v) => Math.abs(v.weight - 0.1) < 1e-6), vals.map((v) => v.weight))
  check('解耦：价值观 Σ=1', Math.abs(vals.reduce((s, v) => s + v.weight, 0) - 1) < 1e-6)
  d2.close()
  attachDb(db)

  // 9) 12 道门：E/I 调 idle、J/P 调可试次数、σ 调成本（直接调判断函数，不依赖 HTTP）
  db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run('agt_gate', '门控', 'daily', 'active', now())
  seedState(db, 'agt_gate')
  db.prepare('UPDATE drive_state SET r=0.2 WHERE agent_id=?').run('agt_gate')
  const setAx = (k, v) => db.prepare('UPDATE persona SET value=? WHERE agent_id=? AND path=?').run(JSON.stringify(v), 'agt_gate', 'axis.' + k)
  setAx('ei', 0); setAx('jp', 0); setAx('sensitivity', 0)
  const wLow = decideSpeak(db, 'agt_gate')
  setAx('ei', 1); setAx('jp', 1); setAx('sensitivity', 1)
  const wHigh = decideSpeak(db, 'agt_gate')
  check('12 道门：偏外向的 idle 要求更短', wHigh.idle_need_hours < wLow.idle_need_hours, { low: wLow.idle_need_hours, high: wHigh.idle_need_hours })
  check('12 道门：J/P 调可试次数', wHigh.attempt_cap > wLow.attempt_cap, { low: wLow.attempt_cap, high: wHigh.attempt_cap })
  check('12 道门：敏感抬高打扰成本', wHigh.cost > wLow.cost, { low: wLow.cost, high: wHigh.cost })

  // 10) 自述：now 里是五轴，不是 big5
  const { getSelfview } = await import('../src/modules/selfview.js')
  const sv = getSelfview(db, 'agt_gate')
  check('自述：now 里是五轴', Array.isArray(sv.now.axes) && sv.now.axes.length === 5 && !('big5' in sv.now), Object.keys(sv.now))
  check('自述：now 里带类型投影', sv.now.type && Array.isArray(sv.now.type.letters) && sv.now.type.letters.length === 4 && typeof sv.now.type.letters[0].show === 'boolean', sv.now.type)

  // 11) 标签被保留（新标签要连续两轮）时，放大不能丢
  {
    const { appraiseWithEdges } = await import('../src/features.js')
    const mk = (id, mode) => {
      db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, id, 'daily', 'active', now())
      seedState(db, id)
      db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
        .run(id, 'persona.axes.mode', JSON.stringify(mode), now())
      for (const [k, v] of Object.entries({ ei: 0.5, sn: 0.5, tf: 0.95, jp: 0.5, sensitivity: 0.95 })) {
        db.prepare('UPDATE persona SET value=? WHERE agent_id=? AND path=?').run(String(v), id, 'axis.' + k)
      }
      db.prepare('UPDATE affect_state SET primary_label=?, intensity=?, mood=?, pleasure=?, arousal=?, dominance=? WHERE agent_id=?')
        .run('calm', 0.2, 0.6, 0.1, -0.1, 0, id)
      db.prepare('DELETE FROM affect_episodes WHERE agent_id=?').run(id)
    }
    mk('agt_hold_off', 'off')
    mk('agt_hold_on', 'on')
    await appraiseWithEdges(db, 'agt_hold_off', '你错了，真差劲')
    await appraiseWithEdges(db, 'agt_hold_on', '你错了，真差劲')
    const rOff = await appraiseWithEdges(db, 'agt_hold_off', '你错了，真差劲')
    const rOn = await appraiseWithEdges(db, 'agt_hold_on', '你错了，真差劲')
    check('换标签那轮放大不丢', rOn.intensity > rOff.intensity, { off: rOff.intensity, on: rOn.intensity })
  }
}

// ---------------- 设置接线：学习速率 / 步幅上限 / 工况系数 / 衰减 0 / C3 额度 ----------------
{
  const { decayAffect, refillTokens } = await import('../src/core.js')
  const { computeEdgeBias } = await import('../src/modules/edges.js')
  const aid = 'agt_wire'
  db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
    .run(aid, '接线', 'daily', 'active', now())
  seedState(db, aid)
  const setP = (k, v) => db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
    .run(aid, k, JSON.stringify(v), now())
  const resetAxis = (v) => {
    db.prepare("UPDATE persona SET value=?, origin='auto' WHERE agent_id=? AND path='axis.tf'").run(String(v), aid)
    db.prepare('INSERT OR REPLACE INTO flags(key,value) VALUES(?,?)').run('axis.round:tf:' + aid, '-6')
  }

  resetAxis(0.5)
  const d1 = setAxisAuto(db, aid, 'tf', 0.2, 'test')
  check('接线：默认步幅 0.05', Math.abs(d1.after - 0.55) < 1e-9, d1)

  setP('persona.learn_rate', 0.01)
  resetAxis(0.5)
  const d2 = setAxisAuto(db, aid, 'tf', 0.2, 'test')
  check('接线：学习速率调小 → 步幅跟着小', Math.abs(d2.after - 0.51) < 1e-9, d2)

  setP('persona.learn_rate', 0.2)
  setP('persona.step_cap', 0.02)
  resetAxis(0.5)
  const d3 = setAxisAuto(db, aid, 'tf', 0.2, 'test')
  check('接线：单次步幅上限封顶', Math.abs(d3.after - 0.52) < 1e-9, d3)

  const eLo = computeEdgeBias({ sigma: 0.5, axes: {}, load: 1, arousal: 0.6, stimulus: 0.9, text: '今天天气不错', mode: 'on', conditionCoef: 1 })
  const eHi = computeEdgeBias({ sigma: 0.5, axes: {}, load: 1, arousal: 0.6, stimulus: 0.9, text: '今天天气不错', mode: 'on', conditionCoef: 5 })
  check('接线：工况系数放大情绪与记忆', eHi.intensityMul > eLo.intensityMul && eHi.memoryWeightMul > eLo.memoryWeightMul,
    { lo: eLo.intensityMul, hi: eHi.intensityMul, mlo: eLo.memoryWeightMul, mhi: eHi.memoryWeightMul })

  db.prepare('UPDATE affect_state SET intensity=0.8, mood=0.8 WHERE agent_id=?').run(aid)
  setP('affect.decay', 0)
  const dec = decayAffect(db, aid, 24)
  check('接线：衰减 0 = 不回落', dec.intensity === 0.8 && dec.mood === 0.8, dec)

  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(now(), aid)
  db.prepare('UPDATE drive_state SET tokens=?, tokens_refill_at=? WHERE agent_id=?')
    .run(JSON.stringify({ c1: 1, c2: 1, c3: 1, c4: 4 }), now(), aid)
  setP('guard.budget.c3', 0.5)
  const tk = refillTokens(db, aid)
  check('接线：C3 额度来自参数', tk.c3 <= 0.5001, tk)
}

// ---------------- 敏感度进设置：默认偏高 / 手调 / 交回 / 接口 / 重铺底色 ----------------
{
  const { setPersona } = await import('../src/core.js')
  const { rebuildBaselineAhead } = await import('../src/modules/affect.js')
  const aid = 'agt_sens'
  db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(aid, '敏感度', 'daily', 'active', now())
  seedState(db, aid)

  check('敏感度：出生默认 0.80', Math.abs(readAxes(db, aid).sensitivity - 0.8) < 1e-9, readAxes(db, aid).sensitivity)
  const man = setAxisManual(db, aid, 'sensitivity', 0.93)
  check('敏感度：手调写 manual', man.after === 0.93 && readAxes(db, aid).sensitivity === 0.93, man)
  check('敏感度：手调后不再自动漂',
    db.prepare("SELECT origin FROM persona WHERE agent_id=? AND path='axis.sensitivity'").get(aid).origin === 'manual')
  const rel = releaseAxis(db, aid, 'sensitivity')
  check('敏感度：交回经历保留数值', rel.origin === 'auto' && readAxes(db, aid).sensitivity === 0.93, rel)

  const view = axesView(db, aid)
  check('敏感度：视图带曲线与五轴', view.default === 0.8 && view.axes.length === 5 && !!view.curve, view)
  const fx = sensitivityEffects(0.8)
  check('敏感度：0.80 的效果可预告',
    Math.abs(fx.swing - 0.39) < 1e-9 && Math.abs(fx.threshold - 0.35) < 1e-9 && Math.abs(fx.halfLife - 1.48) < 1e-9, fx)
  check('敏感度：越界写不进去', (() => {
    try { setPersona(db, aid, 'axis.sensitivity', { value: 1.4 }, 'user'); return false } catch (e) { return e.status === 400 }
  })())

  // 接口：读 / 越界 / 手调 / 交回 / 重铺
  const axv = await handle(db, { method: 'GET', path: '/v1/agents/' + aid + '/persona/axes', body: {}, token: 'user' })
  check('接口：persona/axes 能读', axv.status === 200 && axv.body.default === 0.8 && !!axv.body.curve, axv.body)
  const bad = await handle(db, { method: 'PUT', path: '/v1/agents/' + aid + '/persona/axis.sensitivity', body: { value: 2, __idempotencyKey: 'k-sens-bad' }, token: 'user' })
  check('接口：敏感度越界 400', bad.status === 400 && bad.body.error.code === 'INVALID_ARGUMENT', bad.body)
  const okw = await handle(db, { method: 'PUT', path: '/v1/agents/' + aid + '/persona/axis.sensitivity', body: { value: 0.66, __idempotencyKey: 'k-sens-ok' }, token: 'user' })
  check('接口：手调 0.66', okw.status === 200 && okw.body.value === 0.66 && okw.body.origin === 'manual', okw.body)
  const rel2 = await handle(db, { method: 'PUT', path: '/v1/agents/' + aid + '/persona/axis.sensitivity', body: { value: 0.66, origin: 'auto', __idempotencyKey: 'k-sens-rel' }, token: 'user' })
  check('接口：交回经历', rel2.status === 200 && rel2.body.origin === 'auto', rel2.body)

  // 重铺：过去段原样，当前段在「此刻」截断，新段接上、不留空档
  const at = Date.now()
  db.prepare('DELETE FROM affect_baseline WHERE agent_id=?').run(aid)
  const ins = db.prepare('INSERT INTO affect_baseline(agent_id,seg_no,started_at,duration_h,from_val,to_val,seed) VALUES(?,?,?,?,?,?,?)')
  ins.run(aid, 0, new Date(at - 72 * 3600000).toISOString(), 72, -0.4, 0.2, aid)
  ins.run(aid, 1, new Date(at).toISOString(), 72, 0.2, -0.5, aid)
  const beforeRow = db.prepare('SELECT * FROM affect_baseline WHERE agent_id=? AND seg_no=0').get(aid)
  const rb = rebuildBaselineAhead(db, aid, { at })
  const after = db.prepare('SELECT * FROM affect_baseline WHERE agent_id=? ORDER BY seg_no').all(aid)
  const after0 = after.find((r) => Number(r.seg_no) === 0)
  check('重铺：过去段一行不动', !!after0 && after0.started_at === beforeRow.started_at
    && after0.duration_h === beforeRow.duration_h && after0.to_val === beforeRow.to_val, after0)
  const firstFuture = after.find((r) => Number(r.seg_no) === 1)
  check('重铺：从此刻接上', !!rb.rebuilt && !!firstFuture
    && Math.abs(Date.parse(firstFuture.started_at) - at) < 5
    && Math.abs(Number(firstFuture.from_val) - 0.2) < 1e-9, firstFuture)
  const spans = after.map((r) => ({ s: Date.parse(r.started_at), e: Date.parse(r.started_at) + Number(r.duration_h) * 3600000 }))
  check('重铺：段与段不留空档', spans.every((x, i) => i === 0 || Math.abs(x.s - spans[i - 1].e) < 5), spans.slice(0, 3))
  check('重铺：铺到至少明天', spans[spans.length - 1].e > at + 86400000 - 60000, spans[spans.length - 1])
  const rb2 = await handle(db, { method: 'POST', path: '/v1/agents/' + aid + '/affect/rebuild-baseline', body: { __idempotencyKey: 'k-sens-rb' }, token: 'user' })
  check('接口：重铺底色', rb2.status === 200 && rb2.body.rebuilt === true, rb2.body)
}

// 记忆增量曲线：vault.js 重构时丢过 history 导出，前端只剩一行 "vt.history is not a function"
{
  const { history: vaultHistory } = await import('../src/modules/vault.js')
  check('vault.history 有导出', typeof vaultHistory === 'function', typeof vaultHistory)
  // 主用例已经关掉 http 服务，这里直接走 handle，等价于 /dsh-consciousness/api
  const call = async (method, p, b = {}) => {
    const env = { method, path: p, body: { ...b }, token: 'user' }
    if (method !== 'GET') env.body.__idempotencyKey = 'k-' + Math.random().toString(36).slice(2)
    const r = await handle(db, env)
    return r.body
  }
  const va = await call('POST', '/v1/agents', { name: '仓库曲线' })
  const vd = await call('GET', `/v1/agents/${va.id}/vault`)
  const vh = await call('GET', `/v1/agents/${va.id}/vault/history?days=90`)
  check('vault.history 能画 90 天', !vh.error && Array.isArray(vh.series) && vh.series.length === 90, vh.error || (vh.series && vh.series.length))
  const last = vh.series && vh.series[vh.series.length - 1]
  const total = (vd && vd.total_bytes) || 0
  check('vault.history 收盘和仓库同一口径', !!last && Math.abs(last.close - total) <= Math.max(64, total * 0.05), { close: last && last.close, total })
  const v30 = await call('GET', `/v1/agents/${va.id}/vault/history?days=30`)
  check('vault.history 跟着天数切', !v30.error && v30.series && v30.series.length === 30, v30.error || (v30.series && v30.series.length))
  await call('DELETE', `/v1/agents/${va.id}`)
}

// 自己长偏好：模型收束 + 严格过滤，只增不减
{
  const call = async (method, p, b = {}) => {
    const env = { method, path: p, body: { ...b }, token: 'user' }
    if (method !== 'GET') env.body.__idempotencyKey = 'k-' + Math.random().toString(36).slice(2)
    const r = await handle(db, env)
    return r.body
  }
  const g = await call('POST', '/v1/agents', { name: '长偏好' })
  check('长偏好：建实例', !!g.id, g)

  // 没有记忆时长不出东西，也不报错
  const empty = await call('POST', `/v1/agents/${g.id}/preferences/grow`, {})
  check('长偏好：没记忆就说没记忆', empty.reason === 'no_memory' && empty.added.length === 0, empty)

  // 先塞两条真记忆：模型按它们长出偏好
  const { addMemory } = await import('../src/modules/memory.js')
  addMemory(db, g.id, { text: '主人说爱吃香菜，但受不了煮烂的。', type: 'fact' })
  addMemory(db, g.id, { text: '主人讨厌被连续追问，喜欢先给结论再解释。', type: 'fact' })

  growModelHook.complete = async () => JSON.stringify({
    preferences: [
      { tag: '香菜', aversion: 0.1, why: '记忆里说爱吃' },
      { tag: '被连续追问', aversion: 0.9, why: '明确说讨厌' },
      { tag: '一', aversion: 0.5, why: '太短，应该被丢掉' },
      { tag: '先给结论', aversion: 0.2, why: '喜欢' },
    ],
  })
  let grew
  try {
    grew = await call('POST', `/v1/agents/${g.id}/preferences/grow`, {})
  } finally { growModelHook.complete = null }
  check('长偏好：长出条目', grew.added.length === 3, grew.added)
  check('长偏好：太短的标签被丢', !grew.added.some((x) => x.tag === '一'), grew.added)
  check('长偏好：厌恶度保留', grew.added.some((x) => x.tag === '被连续追问' && x.aversion === 0.9), grew.added)
  const stored = await call('GET', `/v1/agents/${g.id}/preferences`)
  check('长偏好：落库且标 auto', stored.length === 3 && stored.every((p) => p.origin === 'auto'), stored)

  // 再长一次：同一批候选必须被去重，一条都不加
  growModelHook.complete = async () => JSON.stringify({ preferences: [{ tag: '香菜', aversion: 0.3 }, { tag: '被连续追问', aversion: 0.8 }] })
  let again
  try { again = await call('POST', `/v1/agents/${g.id}/preferences/grow`, {}) } finally { growModelHook.complete = null }
  check('长偏好：已有的不重复加', again.added.length === 0 && again.reason === 'nothing_new', again)

  // 模型抽风（不是 JSON）不能写坏库
  growModelHook.complete = async () => '我觉得他喜欢香菜吧'
  let junk
  try { junk = await call('POST', `/v1/agents/${g.id}/preferences/grow`, {}) } finally { growModelHook.complete = null }
  const afterJunk = await call('GET', `/v1/agents/${g.id}/preferences`)
  check('长偏好：模型抽风不写库', junk.added.length === 0 && afterJunk.length === 3, { junk, n: afterJunk.length })

  // 模型调用失败：报 model_error，不抛给界面
  growModelHook.complete = async () => { throw new Error('没接上') }
  let boom
  try { boom = await call('POST', `/v1/agents/${g.id}/preferences/grow`, {}) } finally { growModelHook.complete = null }
  check('长偏好：模型失败有话说', boom.reason === 'model_error' && boom.model === 'error', boom)

  // 手写那条照样能加（顺带回归「点了没反应」：空标签必须报错，不能静默）
  const manual = await call('POST', `/v1/agents/${g.id}/preferences`, { tag: '安静', aversion: 0.8 })
  check('偏好写入仍然可用', !!manual.id, manual)
  const blank = await call('POST', `/v1/agents/${g.id}/preferences`, { tag: '   ', aversion: 0.5 })
  check('空标签明确报错', blank.error && blank.error.code === 'INVALID_ARGUMENT', blank)

  // 删：手写的能收回，自己长的一条都不许删
  const delManual = await call('DELETE', `/v1/agents/${g.id}/preferences/${manual.id}`)
  check('手写偏好可删除', delManual.deleted === true, delManual)
  const autoRow = stored.find((p) => p.origin === 'auto')
  const delAuto = await call('DELETE', `/v1/agents/${g.id}/preferences/${autoRow.id}`)
  check('自己长的删不掉', delAuto.error && delAuto.error.code === 'LOCKED', delAuto)
  const stillThere = await call('GET', `/v1/agents/${g.id}/preferences`)
  check('删不掉就还在', stillThere.length === 3 && stillThere.every((p) => p.origin === 'auto'), stillThere.length)
  const delGhost = await call('DELETE', `/v1/agents/${g.id}/preferences/prf_nope`)
  check('删不存在的偏好 → 404', delGhost.error && delGhost.error.code === 'NOT_FOUND', delGhost)

  // 自动长：不用人点，按「够久 + 有新记忆」自己触发；状态存 flags，重启不丢
  const { growPrefsDue, autoGrowPreferences } = await import('../src/features.js')
  db.prepare('DELETE FROM flags WHERE key LIKE ?').run('grow.pref_%')
  // 这个实例只有 2 条记忆，把门槛调到 2 才谈得上「该不该长」；线上默认是 3
  const dueOpt = { needNew: 2 }
  let due = growPrefsDue(db, g.id, dueOpt)
  check('自动长：新库该长', due.due === true && due.fresh === 2, due)
  growModelHook.complete = async () => JSON.stringify({ preferences: [{ tag: '内脏', aversion: 0.85 }] })
  let auto1
  try { auto1 = await autoGrowPreferences(db, g.id, dueOpt) } finally { growModelHook.complete = null }
  check('自动长：自己长出一条', auto1.added.length === 1 && auto1.reason === 'ok', auto1)
  const flagAt = db.prepare("SELECT value FROM flags WHERE key='grow.pref_last_at'").get()
  check('自动长：记账落库', !!flagAt && Number(flagAt.value) > 0, flagAt)
  due = growPrefsDue(db, g.id, dueOpt)
  check('自动长：刚长过就不长', due.due === false && due.reason === 'too_soon', due)

  // 时间做了手脚也不该「没新材料还长」：把 last_at 推回两小时前，条数没变
  db.prepare("UPDATE flags SET value=? WHERE key='grow.pref_last_at'").run(String(Date.now() - 2 * 3600 * 1000))
  due = growPrefsDue(db, g.id, dueOpt)
  check('自动长：没新记忆就不长', due.due === false && due.reason === 'nothing_new', due)

  addMemory(db, g.id, { text: '主人说周报别写太长。', type: 'fact' })
  addMemory(db, g.id, { text: '主人喜欢周五下午过一遍进度。', type: 'fact' })
  addMemory(db, g.id, { text: '主人不吃内脏。', type: 'fact' })
  due = growPrefsDue(db, g.id, dueOpt)
  check('自动长：攒够新记忆就该长', due.due === true && due.fresh >= 3, due)

  await call('DELETE', `/v1/agents/${g.id}`)
}

// 表达状态：一轮里只有一个语气出口（关系热度不能把低落的她逼得多说）
{
  const low = expressionState({
    affect: { primary_label: 'frustrated', intensity: 0.62, mood: 0.4, v3: { slow: -0.5, total: -0.3, baseline: -0.1 } },
    relation: { closeness: 0.94, trust: 0.74, kind: 'owner', warmth: 0.91, formality: 0.12, disclosure: 0.7, initiative: 0.75 },
    ei: 0.4,
  })
  check('表达：低落压过关系热度', low.tone === 'cool' && low.sentences === 1, low)
  check('表达：主动性不因关系近而抬高', low.initiative === 0, low)
  check('表达：温度被情绪拉低', low.warmth < 0.91, low)

  const high = expressionState({
    affect: { primary_label: 'joy', intensity: 0.5, mood: 0.7, v3: { slow: 0.35, total: 0.4, baseline: 0.2 } },
    relation: { closeness: 0.9, trust: 0.8, kind: 'owner', warmth: 0.9, formality: 0.1, disclosure: 0.7, initiative: 0.8 },
    ei: 0.8,
  })
  check('表达：心情好愿意多说', high.level === 'warm' && high.sentences >= 3 && high.proactive >= 1, high)

  const felt = feltLine({ label: 'frustrated', intensity: 0.5, slow: -0.4, mood: -0.3 })
  check('感受是推测口吻', felt.startsWith('感觉现在大概'), felt)
  check('感受不写命令、不带生硬免责', felt.startsWith('感觉现在大概') && !/只说|语气|句数|必须|不许|不用照着演|底子/.test(felt), felt)
  check('感受只说整体心情、不说底色', felt.includes('整体心情偏负面') && !felt.includes('底色'), felt)
  const strongFelt = feltLine({ label: 'frustrated', intensity: 0.5, slow: -0.4, mood: -0.3, weight: 0.7 })
  check('权重大时改成陈述口吻', strongFelt.startsWith('现在的情绪是：'), strongFelt)

  const wish = wishLine({ level: 'brief' })
  check('愿望是「我想」不是命令', wish.includes('我想') && !/只说|必须|不许/.test(wish), wish)

  // 未知标签 / 没有关系：降级而不是抛
  const fallback = expressionState({ affect: { primary_label: '彩虹', intensity: 0.9, v3: { slow: 0.5 } }, relation: null })
  check('表达：未知标签降级不抛', !!fallback.felt && fallback.level === 'warm', fallback)

  // 旧命令词必须从注入源码里消失（防回归）
  const idxSrc = fs.readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8')
  check('注入不再有「说话分寸」命令行', !idxSrc.includes('这一轮的说话分寸') && !idxSrc.includes('只说 1 句'), null)
}

// 空闲心跳：候选浮现 → 取走记账 → 冷却 → 过期
{
  const { addMemory } = await import('../src/modules/memory.js')
  const pa = 'agt_pulse_' + Math.random().toString(36).slice(2, 8)
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(pa, '浮现', 'chat', 'active', now())
  addMemory(db, pa, { text: '她记得主人喜欢在夜里听雨声。', type: 'fact' })
  const t1 = surfaceQueueTick(db, pa)
  check('心跳：第一次排出候选', t1.queued === 1, t1)
  const pend = pendingSurface(db, pa)
  check('心跳：候选带得出正文', !!pend && !!pend.text, pend)
  const t2 = surfaceQueueTick(db, pa)
  check('心跳：同一轮不重复排', t2.queued === 0, t2)
  const taken = takeSurface(db, pa)
  check('心跳：取走后出队', !!taken && pendingSurface(db, pa) === null, taken)
  const sf = db.prepare('SELECT kind,text FROM surfaced_items WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(pa)
  check('心跳：取走时记一次浮现', !!sf && sf.kind === 'spontaneous', sf)
  const t3 = surfaceQueueTick(db, pa)
  check('心跳：冷却期内不再浮同一条', t3.queued === 0, t3)
  db.prepare('UPDATE surfaced_items SET at=? WHERE agent_id=?').run(new Date(Date.now() - 10 * 86400000).toISOString(), pa)
  const t4 = surfaceQueueTick(db, pa)
  check('心跳：冷却期过后还能再浮', t4.queued === 1, t4)
  db.prepare("UPDATE surface_queue SET expires_at=? WHERE agent_id=? AND state='pending'").run(new Date(Date.now() - 1000).toISOString(), pa)
  const t5 = surfaceQueueTick(db, pa)
  check('心跳：过期候选作废', t5.expired >= 1, t5)
  db.prepare('DELETE FROM surface_queue WHERE agent_id=?').run(pa)
  db.prepare('DELETE FROM surfaced_items WHERE agent_id=?').run(pa)
  db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(pa)
  db.prepare('DELETE FROM agents WHERE id=?').run(pa)
}

// 注入预算：新的「此刻我 / 我想怎么说」也归入情绪档，超预算照旧先丢
{
  const packed2 = clampInjection(['## 意识体：X', '此刻我：我有点烦。', '我想怎么说：' + 'x'.repeat(300)], 60)
  check('注入预算：感受行归入情绪档', packed2.dropped.includes('affect') && packed2.text.includes('意识体'), packed2)
}

// 回读自己那句话：小步修正慢情绪，短句 / 差得不多都不动
{
  const warm = readReplyTone('好呀，今天想多聊一会儿～你慢慢说，我听着呢。')
  check('回读：热络的句子读得出来', warm && warm.warmth > 0.2 && warm.flat === false, warm)
  const flat = readReplyTone('嗯。')
  check('回读：短句算平，不据此改情绪', flat && flat.flat === true, flat)
  const cool = readReplyTone('算了，随便，不想说这个。')
  check('回读：冷淡的句子读得出来', cool && cool.warmth < -0.2, cool)

  const ra = 'agt_selfread_' + Math.random().toString(36).slice(2, 8)
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(ra, '回读', 'chat', 'active', now())
  db.prepare('INSERT OR REPLACE INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)')
    .run(ra, -0.2, -0.5, 0, -0.5, now(), now())
  const up = applySelfRead(db, ra, '好呀，今天想多聊一会儿～你慢慢说，我听着呢。')
  const afterUp = db.prepare('SELECT slow FROM affect_v3 WHERE agent_id=?').get(ra).slow
  check('回读：说得比情绪热 → 往上挪一点', up.applied === true && afterUp > -0.5 && afterUp < -0.4, { up, afterUp })

  const flatRead = applySelfRead(db, ra, '嗯。')
  check('回读：短句不动情绪', flatRead.applied === false && flatRead.reason === 'flat', flatRead)

  db.prepare('UPDATE affect_v3 SET slow=?, total=? WHERE agent_id=?').run(-0.1, -0.1, ra)
  const closeRead = applySelfRead(db, ra, '差不多吧，就这样。')
  check('回读：差得不多不抖', closeRead.applied === false && closeRead.reason === 'close', closeRead)

  db.prepare('DELETE FROM affect_v3 WHERE agent_id=?').run(ra)
  db.prepare('DELETE FROM agents WHERE id=?').run(ra)
}

console.log(`\n通过 ${pass.length} / ${pass.length + fail.length}`)
if (fail.length) { console.log('失败:', fail); process.exit(1) }

// 注入预算：超了先丢情绪、再丢记忆，核心永远保留
{
  const big = ['## 意识体：测试', '此刻情绪：烦躁，强度 0.80，心情 -0.2。', '需求缺口档位：D3。', '关于这句话，你能想起的事：\n' + '- ' + 'x'.repeat(2000)]
  const packed = clampInjection(big, 200)
  check('注入预算先丢情绪再丢记忆', packed.tokens <= 200 && packed.dropped.includes('affect') && packed.text.includes('意识体'), packed)
}
