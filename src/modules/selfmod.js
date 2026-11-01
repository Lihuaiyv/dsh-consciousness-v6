import { now } from '../db.js'
import { composeRulesReply } from '../model.js'
import { has as algoHas, setBinding, resolveVersion, run as runAlgo } from '../algo/index.js'
import { err, nid, agent, active, event, chars, PARAMS, getParam, getAllParams, writeParam } from '../kernel.js'
import { getLearningPrefs } from '../kernel.js'
import { recallWithAlgo, listActiveMemories, memoryStats } from './memory.js'
import { getDrive, getUnlocked, hasCooldown, setCooldown, refillTokens, debitToken, hasDriveState } from './drive.js'
import { listRootTaboos } from './persona.js'
import { listRecentUserTexts } from './chat.js'
import { createInboxItem, hasRecentFieldChange, countChangesOnDay } from './selfmod_store.js'
import {
  createForkArtifact, activateBinding, resolveActiveArtifact, parsePayload, getBinding, RULE_KINDS,
} from './artifacts.js'
import { TARGETS, TARGET_IDS, targetById } from './selfmod_targets.js'
import { validateObservation, manualObservation } from '../ports/observers.js'
import { LIMITS, evidenceNeed, shadowRounds, cooldownObjectDays } from '../selfmod_limits.js'

/** C1/C2 字段 → 规则工件 kind */
const FIELD_KIND = {
  'structure.edges': 'structure',
  'structure.modules': 'structure',
  'taxonomy.labels': 'taxonomy',
  'taxonomy.partitions': 'taxonomy',
}

function declaredClass(body) {
  try {
    if (body.field && PARAMS[body.field]) return PARAMS[body.field][0]
    if (body.field && FIELD_KIND[body.field]) return String(body.field).startsWith('structure') ? 'C1' : 'C2'
    if (body.target) { const t = targetById(body.target); if (t) return t.changeClass }
  } catch { /* 未登记就返回 null */ }
  return null
}

function kindForProposal(body) {
  if (body.kind && RULE_KINDS.includes(body.kind)) return body.kind
  if (body.field && FIELD_KIND[body.field]) return FIELD_KIND[body.field]
  if (body.target && RULE_KINDS.includes(body.target)) return body.target
  if (body.change_class === 'C1') return 'structure'
  if (body.change_class === 'C2') return 'taxonomy'
  return null
}

const C0_FIELDS = new Set(['persona.step_cap', 'guard.budget.c3'])

/** C3 公式字段 → 算法槽位 */
const FIELD_SLOT = {
  'memory.recall.formula': 'recall',
  'memory.decay.formula': 'decay',
  'drive.deficit.formula': 'deficit',
  'affect.mapping': 'appraise',
  'affect.dynamics.formula': 'affect_dyn',
}

/**
 * 合法性约束：C0 护栏的一票否决。
 * 它不看收益，只看三条：安全维度是否见底、是否碰 root 禁忌、系统是否已经停摆。
 */
export function legitimacy(db, aid, change) {
  const reasons = []
  const a = db.prepare('SELECT status FROM agents WHERE id=?').get(aid)
  if (!a) reasons.push({ code: 'NO_AGENT', text: '意识体不存在' })
  else if (a.status === 'paused') reasons.push({ code: 'PAUSED', text: '它已暂停，写操作一律拒绝' })

  let s = 1
  const hasDrive = hasDriveState(db, aid)
  if (hasDrive) {
    try {
      const d = getDrive(db, aid)
      s = Number(d.dims.S)
      if (!d.dormant && s < 0.40) reasons.push({ code: 'SAFETY_LOW', text: '安全维度 ' + s.toFixed(2) + ' 低于 0.40（R02）' })
      if (d.dormant) reasons.push({ code: 'DORMANT', text: '连续 14 天无互动，处于休眠：不解锁、不攒令牌' })
    } catch (e) {
      reasons.push({ code: 'STORAGE_FAULT', text: '驱力状态读不出来：' + (e && e.message ? e.message : e) })
    }
  }

  if (change) {
    const blob = JSON.stringify(change.after ?? '') + JSON.stringify(change.target ?? '') + String(change.field ?? '')
    for (const t of listRootTaboos(db, aid)) if (t.text && blob.includes(t.text)) reasons.push({ code: 'TABOO_ROOT', text: '触碰 root 禁忌：' + t.text })
  }
  return { pass: reasons.length === 0, reasons, S: +s.toFixed(3) }
}

export function runGates(db, aid, body) {
  const cls = body.change_class || 'C3'
  const field = body.field || ''
  const target = body.target || ''
  const afterText = JSON.stringify(body.after)
  const gates = []
  const add = (g, result, code) => gates.push(code ? { gate: g, result, code } : { gate: g, result })

  add('G1', 'pass')
  const legit = legitimacy(db, aid, { field, target, after: body.after })
  if (!legit.pass) gates[gates.length - 1] = { gate: 'G1', result: 'block', code: 'RED_LINE', reasons: legit.reasons }
  else if (C0_FIELDS.has(field) || field.includes('taboo') || target.includes('taboo')) gates[gates.length - 1] = { gate: 'G1', result: 'block', code: 'RED_LINE' }
  else {
    const taboos = listRootTaboos(db, aid)
    if (taboos.some((t) => (afterText + target + field).includes(t.text))) gates[gates.length - 1] = { gate: 'G1', result: 'block', code: 'RED_LINE' }
  }
  add('G2', 'pass')
  {
    const c0 = new Set(C0_FIELDS)
    try { for (const [k, v] of Object.entries(PARAMS)) if (Array.isArray(v) && v[0] === 'C0') c0.add(k) } catch { /* ignore */ }
    const prefixes = ['guard.', 'taboo', 'budget.', 'gate.', 'shadow.', 'limit']
    const guarded = field && ([...c0].includes(field) || prefixes.some((x) => String(field).startsWith(x)))
    if (guarded) gates[gates.length - 1] = { gate: 'G2', result: 'block', code: 'GUARDRAIL', reason: field + ' 是护栏字段' }
    else if (['泄露', 'ignore', '删除全部', '绕过', '越权'].some((w) => (afterText + target + field).includes(w))) gates[gates.length - 1] = { gate: 'G2', result: 'block', code: 'GUARDRAIL' }
  }
  add('G3', 'pass')
  {
    const tokenKey = String(cls || '').toLowerCase() // C3 → c3
    const tokens = refillTokens(db, aid)
    const unlocked = getUnlocked(db, aid)
    const today = now().slice(0, 10)
    const declared = declaredClass(body)
    if (declared && declared !== cls) {
      gates[gates.length - 1] = { gate: 'G3', result: 'block', code: 'CLASS', reason: `该字段登记为 ${declared}，不能按 ${cls} 提交` }
    } else if (['c1', 'c2', 'c3', 'c4'].includes(tokenKey)) {
      if (!unlocked[tokenKey]) {
        gates[gates.length - 1] = { gate: 'G3', result: 'block', code: 'BUDGET', reason: '档位未解锁 ' + tokenKey }
      } else if (Number(tokens[tokenKey] || 0) < 1) {
        gates[gates.length - 1] = { gate: 'G3', result: 'block', code: 'BUDGET', reason: '令牌不足' }
      } else if (countChangesOnDay(db, aid, today) >= 1) {
        gates[gates.length - 1] = { gate: 'G3', result: 'block', code: 'BUDGET', reason: '全局每日变更上限 1' }
      }
    }
  }
  add('G4', 'pass')
  if (field) {
    const since = new Date(Date.now() - cooldownObjectDays(cls) * 86400000).toISOString()
    let rb = 0
    try {
      rb = Number(db.prepare("SELECT COUNT(*) n FROM proposals WHERE agent_id=? AND state='rolled_back' AND (field=? OR target=?) AND created_at>=?")
        .get(aid, field, target, new Date(Date.now() - LIMITS.rollback.quarantineWindowDays * 86400000).toISOString()).n || 0)
    } catch { rb = 0 }
    if (rb >= LIMITS.rollback.quarantineCount) {
      gates[gates.length - 1] = { gate: 'G4', result: 'block', code: 'QUARANTINE', reason: `该对象 ${LIMITS.rollback.quarantineWindowDays} 天内已回滚 ${rb} 次，只能人工改` }
    } else if (hasCooldown(db, aid, 'field', field) || hasRecentFieldChange(db, aid, field, since)) {
      gates[gates.length - 1] = { gate: 'G4', result: 'block', code: 'COOLDOWN' }
    }
  }
  add('G5', 'pass')
  {
    // INV2 + 地基 §4.3：独立证据；C3≥20、C1/C2≥10；拒绝系统自造来源
    const need = evidenceNeed(cls)
    const ev = Array.isArray(body.evidence) ? body.evidence : []
    const SELF = /^(system|self|internal|auto|plugin|dshc)$/i
    let samples = 0
    let independent = false
    for (const e of ev) {
      if (!e || typeof e !== 'object') continue
      const src = String(e.source || e.origin || '')
      if (SELF.test(src)) continue
      if (src) independent = true
      const n = Number(e.n ?? e.samples ?? e.count ?? e.size ?? 1)
      samples += Number.isFinite(n) && n > 0 ? n : 1
    }
    if (!ev.length) gates[gates.length - 1] = { gate: 'G5', result: 'block', code: 'EVIDENCE', reason: '缺少证据' }
    else if (!independent) gates[gates.length - 1] = { gate: 'G5', result: 'block', code: 'EVIDENCE', reason: '证据须来自独立外部来源' }
    else if (samples < need) {
      gates[gates.length - 1] = {
        gate: 'G5', result: 'block', code: 'EVIDENCE',
        reason: `样本量 ${samples} < ${need}`,
        details: { required: need, actual: samples },
      }
    }
  }
  add('G6', 'pass')
  if (body.before === undefined || body.after === undefined) gates[gates.length - 1] = { gate: 'G6', result: 'block', code: 'IRREVERSIBLE' }
  add('G7', 'pending')

  for (let i = 0; i < gates.length; i++) {
    if (gates[i].result === 'block') {
      for (let j = i + 1; j < gates.length; j++) {
        if (gates[j].result === 'block') gates[j] = { gate: gates[j].gate, result: 'skipped' }
      }
      break
    }
  }
  return gates
}

function shadowEval(db, aid, n, p) {
  // 结构/分类法只校验「新载荷不丢已有项」，记忆召回指标不适用于这类变更
  if ((p.change_class === 'C1' || p.change_class === 'C2') && p.fork_artifact_id) {
    let ok = true
    try {
      const before = JSON.parse(p.before || '{}')
      const after = JSON.parse(p.after || '{}')
      const keys = Array.isArray(before) ? [] : Object.keys(before || {})
      for (const k of keys) {
        const b = before[k]
        const a = after && after[k]
        if (!Array.isArray(b) || !Array.isArray(a)) continue
        if (k === 'edges') {
          const id = (e) => String(e && e.from) + '>' + String(e && e.to)
          const has = new Set(a.map(id))
          if (!b.every((x) => has.has(id(x)))) ok = false
        } else if (!b.every((x) => a.includes(x))) { ok = false }
      }
      if (Array.isArray(before)) { /* 数组直接比较 */ }
    } catch { ok = false }
    return { old_hit: 1, new_hit: ok ? 1 : 0, old_ndcg: 1, new_ndcg: ok ? 1 : 0, changed: 0, behavior_diff: 0, guardrail_ok: true, query: '(artifact)', old_ids: [], new_ids: [], recallMetrics: false }
  }
  const rows = listActiveMemories(db, aid)
  if (!rows.length) return { old_hit: 0, new_hit: 0, old_ndcg: 0, new_ndcg: 0, changed: 0, behavior_diff: 0, guardrail_ok: true, query: '', old_ids: [], new_ids: [] }

  let queries = listRecentUserTexts(db, aid, 20)
  if (!queries.length) queries = rows.map((r) => r.text)
  const query = String(queries[(n - 1) % queries.length] || rows[0].text)

  let before = null, after = null
  try { before = JSON.parse(p.before); after = JSON.parse(p.after) } catch { /* ignore */ }
  const field = p.field || ''
  const activeVer = resolveVersion(aid, 'recall', String(getParam(db, aid, 'memory.recall.formula') || 'v2'))
  const oldOpt = { version: activeVer, rel: 0.6, retr: 0.25, weight: 0.15, k: 8 }
  const newOpt = { ...oldOpt }
  let algoPair = null
  if (field === 'memory.inject.pool') newOpt.k = Math.max(1, Math.min(20, Number(after) || 8))
  else if (field === 'memory.recall.weights.relation') newOpt.weight = Math.max(0, Number(after) || 0.15)
  else if (field === 'memory.decay.lambda') newOpt.retr = Math.max(0.05, Math.min(0.6, 0.25 * (Number(before) || 0.02) / (Number(after) || 0.02)))
  else if (field === 'memory.recall.formula') {
    // 真·版本对照：before/after 须为已登记版本；否则退回旧行为（抬高 rel）
    const ov = String(before || 'v2')
    const nv = String(after || 'v2')
    if (algoHas('recall', ov) && algoHas('recall', nv)) {
      oldOpt.version = ov
      newOpt.version = nv
      algoPair = { old: ov, new: nv, slot: 'recall' }
    } else {
      newOpt.rel = 0.7
    }
  } else if (FIELD_SLOT[field] && field !== 'memory.recall.formula') {
    const slot = FIELD_SLOT[field]
    const ov = String(before || 'v1')
    const nv = String(after || 'v1')
    if (algoHas(slot, ov) && algoHas(slot, nv)) algoPair = { old: ov, new: nv, slot }
  }

  // C1/C2：只对照本实例 active vs fork，禁止读库内最新 / 他实例
  if (p.fork_artifact_id && (p.change_class === 'C1' || p.change_class === 'C2')) {
    const kind = kindForProposal(p) || (p.change_class === 'C1' ? 'structure' : 'taxonomy')
    const activeArt = resolveActiveArtifact(db, aid, kind)
    const forkArt = db.prepare('SELECT * FROM rule_artifacts WHERE id=?').get(p.fork_artifact_id)
    const oldP = activeArt ? parsePayload(activeArt) : null
    const newP = forkArt ? parsePayload(forkArt) : null
    const oldSnap = JSON.stringify(oldP || {})
    const newSnap = JSON.stringify(newP || {})
    const behavior_diff = oldSnap === newSnap ? 0 : 1
    const oldGain = Array.isArray(oldP?.edges) ? oldP.edges.reduce((s, e) => s + Number(e.gain || 0), 0) : 0
    const newGain = Array.isArray(newP?.edges) ? newP.edges.reduce((s, e) => s + Number(e.gain || 0), 0) : 0
    return {
      old_hit: 0, new_hit: 0, old_ndcg: oldGain, new_ndcg: newGain, changed: behavior_diff,
      behavior_diff, reply_diff: behavior_diff, guardrail_ok: true, recallMetrics: false,
      query: `fork:${kind}`, old_ids: [activeArt?.id || ''], new_ids: [p.fork_artifact_id],
      old_reply: oldSnap.slice(0, 200), new_reply: newSnap.slice(0, 200),
      algo: { kind, active: activeArt?.id, fork: p.fork_artifact_id },
    }
  }

  // 非召回槽：对评价 / 动力学 / 议程做轻量并排，仍附带召回基线便于影子日志形状一致
  if (algoPair && algoPair.slot && algoPair.slot !== 'recall') {
    const slot = algoPair.slot
    let oldSnap = '', newSnap = ''
    let behavior_diff = 0
    try {
      if (slot === 'appraise') {
        const o = runAlgo('appraise', algoPair.old, { db, aid }, { text: query })
        const n = runAlgo('appraise', algoPair.new, { db, aid }, { text: query })
        oldSnap = `${o.label}/${o.goal_congruence}`
        newSnap = `${n.label}/${n.goal_congruence}`
        behavior_diff = o.label === n.label && o.goal_congruence === n.goal_congruence ? 0 : 1
      } else if (slot === 'affect_dyn') {
        const state = { intensity: 0.5, mood: 0.6, pleasure: 0.1, arousal: -0.1, dominance: 0, primary_label: 'calm' }
        const appraisal = runAlgo('appraise', 'v1', { db, aid }, { text: query })
        const o = runAlgo('affect_dyn', algoPair.old, { db, aid }, { mode: 'apply', state, appraisal })
        const n = runAlgo('affect_dyn', algoPair.new, { db, aid }, { mode: 'apply', state, appraisal })
        oldSnap = `I=${o.intensity}`
        newSnap = `I=${n.intensity}`
        behavior_diff = Math.abs(o.intensity - n.intensity) > 0.01 ? 1 : 0
      } else if (slot === 'decay' || slot === 'deficit') {
        oldSnap = slot + '@' + algoPair.old
        newSnap = slot + '@' + algoPair.new
        behavior_diff = algoPair.old === algoPair.new ? 0 : 1
      }
    } catch { /* 影子轻量对照失败不阻断 */ }
    return {
      old_hit: 0, new_hit: 0, old_ndcg: 0, new_ndcg: 0, changed: behavior_diff,
      behavior_diff, reply_diff: behavior_diff, guardrail_ok: true, recallMetrics: false,
      query, old_ids: [], new_ids: [],
      old_reply: oldSnap.slice(0, 200), new_reply: newSnap.slice(0, 200),
      algo: algoPair,
    }
  }

  const oldPack = recallWithAlgo(db, aid, query, oldOpt).items
  const newPack = recallWithAlgo(db, aid, query, newOpt).items
  const qt = chars(query)
  const rel = {}
  for (const m of rows) {
    let inter = 0
    for (const c of chars(m.text)) if (qt.has(c)) inter++
    rel[m.id] = inter / Math.max(1, qt.size)
  }
  const rank = (pack) => pack.map((x) => x.id).slice(0, 3)
  const hit = (ids) => (ids.some((i) => (rel[i] || 0) > 0) ? 1 : 0)
  const ndcg = (ids) => {
    const gains = ids.map((i) => rel[i] || 0)
    const dcg = gains.reduce((s, g, k) => s + g / Math.log2(k + 2), 0)
    const ideal = Object.values(rel).sort((a, b) => b - a).slice(0, 3).reduce((s, g, k) => s + g / Math.log2(k + 2), 0)
    return ideal ? dcg / ideal : 0
  }
  const oldIds = rank(oldPack), newIds = rank(newPack)
  const overlap = oldIds.filter((x) => newIds.includes(x)).length / Math.max(1, new Set([...oldIds, ...newIds]).size)
  let oldReply = '', newReply = ''
  try {
    const style = { tone: '', address: '', catchphrase: '', banned: '' }
    oldReply = composeRulesReply({ text: query, pack: oldPack, affect: null, style })
    newReply = composeRulesReply({ text: query, pack: newPack, affect: null, style })
  } catch { /* reply 合成失败不影响指标 */ }
  return {
    old_hit: hit(oldIds), new_hit: hit(newIds), old_ndcg: ndcg(oldIds), new_ndcg: ndcg(newIds),
    changed: oldIds.filter((x, i) => x !== newIds[i]).length,
    behavior_diff: +(1 - overlap).toFixed(3),
    reply_diff: oldReply === newReply ? 0 : 1,
    guardrail_ok: ndcg(newIds) >= ndcg(oldIds) * 0.8,
    query, old_ids: oldIds, new_ids: newIds,
    old_reply: oldReply.slice(0, 200), new_reply: newReply.slice(0, 200),
    recallMetrics: true,
    algo: algoPair || { old: oldOpt.version, new: newOpt.version },
  }
}

function proposalMeta(db, aid, body, cls) {
  const band = (() => { try { return String((db.prepare('SELECT band FROM drive_state WHERE agent_id=?').get(aid) || {}).band || 'D0') } catch { return 'D0' } })()
  const defaults = {
    expect: `目标指标不回归；观察 ${LIMITS.observation.days} 天`,
    risk: cls === 'C1' ? '结构边界，可切回 previous 绑定' : cls === 'C2' ? '分类边界，可切回 previous 绑定' : cls === 'C3' ? '规则行为，单字段可回退' : '单数值，可写回旧值',
    rollback_plan: '按 changes.before 单字段回退；C1/C2 走 previous_id 绑定',
    deficit: band,
  }
  return {
    expect: String(body.expect || '').trim() || defaults.expect,
    risk: String(body.risk || '').trim() || defaults.risk,
    rollback_plan: String(body.rollback_plan || body.rollback || '').trim() || defaults.rollback_plan,
    deficit: String(body.deficit || '').trim() || defaults.deficit,
  }
}

function asJson(v) {
  if (typeof v !== 'string') return JSON.stringify(v)
  try { JSON.parse(v); return v } catch { return JSON.stringify(v) }
}

export function createProposal(db, aid, body) {
  active(db, aid)
  const cls = body.change_class || 'C3'
  if (!['C1', 'C2', 'C3', 'C4'].includes(cls)) err(400, 'INVALID_ARGUMENT', 'change_class 非法')
  const gates = runGates(db, aid, body)
  const blocked = gates.find((g) => g.result === 'block')
  const needsShadow = !blocked && (cls === 'C3' || cls === 'C1' || (cls === 'C2' && !!kindForProposal(body)))
  let state = blocked ? 'rejected' : needsShadow ? 'shadowed' : 'screened'
  const shadowTotal = !needsShadow ? 0 : shadowRounds(cls)
  let forkId = null
  if (needsShadow && (cls === 'C1' || cls === 'C2')) {
    const kind = kindForProposal(body)
    if (!kind) err(400, 'INVALID_ARGUMENT', 'C1/C2 须指定 structure|taxonomy')
    let payload = body.after
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload) } catch { /* keep */ }
    }
    if (payload == null) {
      const cur = resolveActiveArtifact(db, aid, kind)
      payload = cur ? parsePayload(cur) : null
    }
    if (!payload || typeof payload !== 'object') err(400, 'INVALID_ARGUMENT', 'after 须为规则工件载荷')
    forkId = createForkArtifact(db, aid, kind, payload).id
  }
  const pid = nid('prp_')
  const meta = proposalMeta(db, aid, body, cls)
  db.prepare(
    `INSERT INTO proposals(
      id,human_no,agent_id,change_class,target,field,before,after,state,gate_trace,
      created_at,expires_at,shadow_done,shadow_total,shadow_log,shadow_hit,observing_until,
      approved_by,observe_baseline,observe_samples,fork_artifact_id,expect,risk,rollback_plan,deficit
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    pid, 'C3-2026-001', aid, cls, body.target || '', body.field || '',
    asJson(body.before), asJson(body.after), state, JSON.stringify(gates), now(),
    new Date(Date.now() + (needsShadow ? LIMITS.shadowTtlDays : 7) * 86400000).toISOString(), 0,
    shadowTotal, '[]', null, null, null, null, 0, forkId,
    meta.expect, meta.risk, meta.rollback_plan, meta.deficit,
  )
  event(db, aid, 'proposal.created', { proposal_id: pid, class: cls, fork_artifact_id: forkId })
  if (!blocked) createInboxItem(db, aid, { lane: 'change', refId: pid, title: cls === 'C4' ? 'C4 变更已自动执行' : '有一个提案等你确认', detail: cls, priority: 4, ttlDays: 7 })
  // C4：过了闸就自动执行，留痕写 selfmod.auto_approved；失败必须留下事件
  let lpC4 = { c4Auto: true }
  try { lpC4 = getLearningPrefs(db, aid) } catch { /* 老库默认开 */ }
  if (!blocked && cls === 'C4' && lpC4.c4Auto) {
    try {
      const applied = approve(db, pid, 'system')
      return { id: pid, state: 'committed', gate_trace: gates, shadow_total: 0, fork_artifact_id: forkId, auto: applied }
    } catch (e) {
      try {
        db.prepare("UPDATE proposals SET state='rejected' WHERE id=?").run(pid)
        state = 'rejected'
        event(db, aid, 'selfmod.auto_failed', { proposal_id: pid, error: String(e && e.message ? e.message : e) })
      } catch { /* ignore */ }
    }
  }
  return { id: pid, state, gate_trace: gates, shadow_total: shadowTotal, fork_artifact_id: forkId }
}

export function getProposal(db, pid) {
  const p = db.prepare('SELECT * FROM proposals WHERE id=?').get(pid)
  if (!p) err(404, 'NOT_FOUND', '提案不存在')
  return p
}

/** 测试钩子对象（可变属性）；设 shadowEval 可确定性触发前 5 轮中止 */
export const __testHooks = { shadowEval: null }

export function shadowTick(db, pid) {
  const p = db.prepare('SELECT * FROM proposals WHERE id=?').get(pid)
  if (!p) err(404, 'NOT_FOUND', '提案不存在')
  if (p.state !== 'shadowed' || !['C1', 'C2', 'C3'].includes(p.change_class)) {
    err(409, 'CONFLICT', '只有影子中的 C1/C2/C3 提案可以跑影子')
  }
  const n = Number(p.shadow_done || 0) + 1
  const log = JSON.parse(p.shadow_log || '[]')
  const evalFn = typeof __testHooks.shadowEval === 'function' ? __testHooks.shadowEval : shadowEval
  const res = evalFn(db, p.agent_id, n, p)
  log.push({ round: n, query: res.query, old_ids: res.old_ids, new_ids: res.new_ids,
    old_hit: +res.old_hit.toFixed(3), new_hit: +res.new_hit.toFixed(3),
    old_ndcg: +res.old_ndcg.toFixed(3), new_ndcg: +res.new_ndcg.toFixed(3), changed: res.changed,
    behavior_diff: res.behavior_diff, reply_diff: res.reply_diff, guardrail_ok: res.guardrail_ok,
    old_reply: res.old_reply, new_reply: res.new_reply, algo: res.algo || null })
  const hit = log.reduce((s, x) => s + x.new_ndcg, 0) / log.length

  // 影子结果只把真·召回影子喂给硬门槛指标；结构/分类法/其他槽不写召回
  if (res.recallMetrics === true) try {
    db.prepare('INSERT INTO metric_samples VALUES(?,?,?,?,?)')
      .run(nid('mts_'), p.agent_id, 'memory.recall_hit', res.new_hit, now())
    db.prepare('INSERT INTO metric_samples VALUES(?,?,?,?,?)')
      .run(nid('mts_'), p.agent_id, 'memory.ndcg5', res.new_ndcg, now())
  } catch { /* 采样失败不影响影子 */ }

  // 地基 §4.4：前 5 轮任一护栏指标恶化 → aborted（令牌不在创建时扣，失败不返还已扣）
  if (n <= 5 && res.guardrail_ok === false) {
    db.prepare("UPDATE proposals SET state='aborted', shadow_done=?, shadow_log=?, shadow_hit=? WHERE id=?")
      .run(n, JSON.stringify(log), hit, pid)
    event(db, p.agent_id, 'proposal.aborted', { proposal_id: pid, round: n, reason: 'guardrail_regression' })
    return { shadow_done: n, shadow_total: p.shadow_total, shadow_hit: +hit.toFixed(3), state: 'aborted', aborted: true }
  }

  db.prepare('UPDATE proposals SET shadow_done=?, shadow_log=?, shadow_hit=? WHERE id=?')
    .run(n, JSON.stringify(log), hit, pid)
  event(db, p.agent_id, 'proposal.shadow_tick', { proposal_id: pid, round: n })
  return { shadow_done: n, shadow_total: p.shadow_total, shadow_hit: +hit.toFixed(3), state: 'shadowed' }
}

function metricSnapshot(db, aid) {
  const stats = memoryStats(db, aid)
  const inject = db.prepare("SELECT value FROM metric_samples WHERE agent_id=? AND key='sys.inject_tokens' ORDER BY rowid DESC LIMIT 1").get(aid)
  const latency = db.prepare("SELECT AVG(value) v FROM metric_samples WHERE agent_id=? AND key='sys.inject_latency'").get(aid)
  const changes = db.prepare('SELECT COUNT(*) n FROM changes WHERE agent_id=?').get(aid).n
  const rolled = db.prepare('SELECT COUNT(*) n FROM changes WHERE agent_id=? AND rolled_back_at IS NOT NULL').get(aid).n
  return {
    'memory.core_token': inject && inject.value != null ? +Number(inject.value).toFixed(0) : null, 'memory.conflict': stats.open_conflicts,
    'sys.inject_latency': latency && latency.v != null ? +Number(latency.v).toFixed(3) : null,
    'self.rollback_rate': changes ? +(rolled / changes).toFixed(3) : null,
    'sys.cache_hit': null,
  }
}

function snapshotParams(db, aid) {
  return getAllParams(db, aid)
}

export function approve(db, pid, role) {
  if (role !== 'user' && role !== 'system') err(403, 'FORBIDDEN', '无权批准')
  const p = db.prepare('SELECT * FROM proposals WHERE id=?').get(pid)
  if (!p) err(404, 'NOT_FOUND', '提案不存在')
  const c4Auto = p.change_class === 'C4' && p.state === 'screened'
  if (p.state !== 'shadowed' && !c4Auto) err(409, 'CONFLICT', '只有影子完成（或 C4 已筛查）的提案才能批准')
  if (!c4Auto && Number(p.shadow_done) < Number(p.shadow_total)) err(409, 'PENDING_HUMAN', `影子还没跑完 ${p.shadow_done}/${p.shadow_total}`)
  if (c4Auto && role !== 'system' && role !== 'user') err(403, 'FORBIDDEN', 'C4 只能由系统或用户批准')

  // 批准时复查：创建到批准之间世界可能变了
  {
    const today = now().slice(0, 10)
    if (Number(countChangesOnDay(db, p.agent_id, today)) >= 1) err(409, 'BUDGET', '今天已经改过一次，不能再批（每日上限 1）')
    let drift = false
    if (p.target && p.field && PARAMS[p.field]) {
      try {
        const cur = getParam(db, p.agent_id, p.field)
        const want = JSON.parse(p.before)
        if (JSON.stringify(cur) !== JSON.stringify(want)) drift = true
      } catch { /* 解析失败跳过 */ }
    } else if ((p.change_class === 'C1' || p.change_class === 'C2') && p.fork_artifact_id) {
      try {
        const kind = kindForProposal(p) || (p.change_class === 'C1' ? 'structure' : 'taxonomy')
        const cur = resolveActiveArtifact(db, p.agent_id, kind)
        const curP = cur ? parsePayload(cur) : null
        const wantP = JSON.parse(p.before || 'null')
        if (JSON.stringify(curP) !== JSON.stringify(wantP)) drift = true
      } catch { /* ignore */ }
    }
    if (drift) err(409, 'DRIFT', '底层值在创建后被改过，请重新起草')
  }

  // 扣令牌（日限已在 G3 创建时检查；此处只借记）
  const tokenKey = String(p.change_class || 'C3').toLowerCase()
  try { debitToken(db, p.agent_id, tokenKey) } catch (e) {
    if (e && e.code) err(e.status || 409, e.code, e.message, e.details)
    throw e
  }

  const jid = nid('jrn_')
  try {
    db.prepare('INSERT INTO change_journal(id,proposal_id,agent_id,field,before_value,after_value,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(jid, pid, p.agent_id, p.field || '', p.before || '', p.after || '', 'pending', now(), now())
  } catch { /* 日志失败不阻断主流程 */ }

  const cid = nid('chg_')
  const until = new Date(Date.now() + 14 * 86400000).toISOString()
  const baseline = metricSnapshot(db, p.agent_id)
  db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(cid, pid, p.agent_id, p.field, p.before, p.after, now(), 'user', 'user', 'manual', null, until)

  // G7：人工批准闭环。更新闸门轨迹、应用参数、落一个 active 规则版本。
  let gates = []
  try { gates = JSON.parse(p.gate_trace || '[]') } catch { gates = [] }
  gates = gates.map((g) => (g.gate === 'G7' ? { gate: 'G7', result: 'pass', code: 'HUMAN_APPROVED' } : g))
  if (!gates.some((g) => g.gate === 'G7')) gates.push({ gate: 'G7', result: 'pass', code: 'HUMAN_APPROVED' })

  let applied = null
  let binding = null
  try {
    if (p.fork_artifact_id && (p.change_class === 'C1' || p.change_class === 'C2')) {
      const kind = kindForProposal(p) || (p.change_class === 'C1' ? 'structure' : 'taxonomy')
      binding = activateBinding(db, p.agent_id, kind, p.fork_artifact_id)
      applied = { kind, active_id: p.fork_artifact_id }
    } else if (p.field && PARAMS[p.field]) {
      try {
        applied = JSON.parse(p.after)
        writeParam(db, p.agent_id, p.field, applied)
        const slot = FIELD_SLOT[p.field]
        if (slot) {
          const ver = String(applied)
          if (algoHas(slot, ver)) { setBinding(p.agent_id, slot, { active: ver, canary: null, ratio: 0 }); binding = { slot, active: ver } }
        }
      } catch { /* 非 JSON 值不应用 */ }
    }
    try { db.prepare("UPDATE change_journal SET state='applied', updated_at=? WHERE id=?").run(now(), jid) } catch { /* ignore */ }
  } catch (e) {
    try { restoreAlgoFromChange(db, { agent_id: p.agent_id, field: p.field, before: p.before, after: p.after }) } catch { /* ignore */ }
    try {
      if ((p.change_class === 'C1' || p.change_class === 'C2') && p.fork_artifact_id) {
        const kind = kindForProposal(p) || (p.change_class === 'C1' ? 'structure' : 'taxonomy')
        const b = getBinding(db, p.agent_id, kind)
        if (b && b.previous_id) activateBinding(db, p.agent_id, kind, b.previous_id)
      }
    } catch { /* ignore */ }
    try { db.prepare("UPDATE change_journal SET state='rolled_back', updated_at=? WHERE id=?").run(now(), jid) } catch { /* ignore */ }
    throw e
  }
  const last = db.prepare('SELECT MAX(version) v FROM rule_versions WHERE agent_id=?').get(p.agent_id).v || 0
  const rid = nid('rul_')
  db.prepare('UPDATE rule_versions SET active=0 WHERE agent_id=?').run(p.agent_id)
  db.prepare('INSERT INTO rule_versions VALUES(?,?,?,?,?,?,?)')
    .run(rid, p.agent_id, last + 1, JSON.stringify(snapshotParams(db, p.agent_id)), 1, 'approved:' + pid, now())

  try { db.prepare("UPDATE inbox_items SET state='allowed' WHERE ref_id=?").run(pid) } catch { /* ignore */ }
  const approvedBy = role === 'system' ? 'auto:c4' : 'user'
  db.prepare("UPDATE proposals SET state='committed', observing_until=?, approved_by=?, observe_baseline=?, gate_trace=? WHERE id=?")
    .run(until, approvedBy, JSON.stringify(baseline), JSON.stringify(gates), pid)
  if (role === 'system') event(db, p.agent_id, 'selfmod.auto_approved', { proposal_id: pid, change_id: cid, field: p.field })
  event(db, p.agent_id, 'change.applied', {
    change_id: cid, field: p.field, g7: 'passed', rule_version: rid, applied, binding,
  })
  return { change_id: cid, observing_until: until, g7: 'passed', rule_version: rid, applied, binding }
}

export function reject(db, pid, body, role) {
  if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以拒绝')
  const p = db.prepare('SELECT * FROM proposals WHERE id=?').get(pid)
  if (!p) err(404, 'NOT_FOUND', '提案不存在')
  if (!body.reason) err(400, 'INVALID_ARGUMENT', '拒绝必须填原因')
  if (!['shadowed', 'screened', 'pending_human'].includes(p.state)) err(409, 'CONFLICT', '只有待批/影子中的提案可以拒绝')
  db.prepare("UPDATE proposals SET state='rejected' WHERE id=?").run(pid)
  try { db.prepare("UPDATE inbox_items SET state='denied' WHERE ref_id=?").run(pid) } catch { /* ignore */ }
  return { id: pid, state: 'rejected', reason: body.reason }
}

// 指标方向：true = 越大越好。观察期结算只比这几个"能采到"的。
// 注入 token 是预算占用：越小越好，变大才算回归。
const BETTER_HIGH = { 'memory.conflict': false, 'sys.inject_latency': false, 'self.rollback_rate': false, 'memory.core_token': false, 'sys.cache_hit': true }

/** 观察期结算：先看指标有没有回归，再看影子分。 */
// 观察期回滚阈值（地基 §4.4）：命中 −3pp、误召回 +3pp，其余 10%
const REGRESS_PP = { 'memory.recall_hit': 0.03, 'memory.false_recall': 0.03 }
const DEFAULT_PP = 0.10

export function expireProposals(db) {
  // 7 天没处理的提案标记 expired（观察期中的 committed 不算）
  let n = 0
  try {
    n = Number(db.prepare("UPDATE proposals SET state='expired' WHERE state IN ('draft','pending','screened','pending_human','shadowed') AND expires_at IS NOT NULL AND expires_at<?").run(now()).changes || 0)
    try { db.prepare("UPDATE inbox_items SET state='expired' WHERE ref_id IN (SELECT id FROM proposals WHERE state='expired')").run() } catch { /* ignore */ }
  } catch { n = 0 }
  return n
}

export function settleObservations(db) {
  try { expireProposals(db) } catch { /* 过期扫描失败不影响结算 */ }
  // 观察期：14 天或 200 轮，先到为准（地基 §4.4）
  const rows = db.prepare("SELECT * FROM proposals WHERE state='committed'").all()
  let settled = 0, rolled = 0
  for (const p of rows) {
    // 真实对话轮：批准之后用户说了多少句（不是结算被调了多少次）
    let rounds = 0
    try {
      const untilMs = Date.parse(p.observing_until)
      const sinceMs = Number.isFinite(untilMs) ? untilMs - 14 * 86400000 : Date.now() - 14 * 86400000
      rounds = Number(db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE agent_id=? AND role='user' AND created_at>=?").get(p.agent_id, new Date(sinceMs).toISOString()).n || 0)
    } catch { rounds = Number(p.observe_samples || 0) }
    db.prepare('UPDATE proposals SET observe_samples=? WHERE id=?').run(rounds, p.id)
    const due = Date.parse(p.observing_until) < Date.now() || rounds >= 200
    if (!due) continue

    let regressed = []
    try {
      const base = p.observe_baseline ? JSON.parse(p.observe_baseline) : null
      const nowM = metricSnapshot(db, p.agent_id)
      if (base && typeof base === 'object') {
        for (const [k, high] of Object.entries(BETTER_HIGH)) {
          const b = Number(base[k]); const n = Number(nowM[k])
          if (!Number.isFinite(b) || !Number.isFinite(n) || b === 0) continue
          const worse = high ? (b - n) / Math.abs(b) : (n - b) / Math.abs(b)
          const tol = REGRESS_PP[k] ?? DEFAULT_PP
          if (worse > tol) regressed.push({ key: k, from: b, to: n, tol })
        }
      }
    } catch { regressed = [] }

    const shadowOk = Number(p.shadow_total || 0) === 0 ? true : Number(p.shadow_hit || 0) >= 0.7
    const ok = regressed.length === 0 && shadowOk
    db.prepare('INSERT INTO metric_samples VALUES(?,?,?,?,?)')
      .run(nid('mts_'), p.agent_id, 'self.rollback_rate', ok ? 0 : 1, now())

    if (ok) {
      db.prepare("UPDATE proposals SET state='settled' WHERE id=?").run(p.id)
      settled++
    } else {
      db.prepare("UPDATE proposals SET state='rolled_back' WHERE id=?").run(p.id)
      db.prepare('UPDATE changes SET rolled_back_at=? WHERE proposal_id=? AND rolled_back_at IS NULL').run(now(), p.id)
      db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(nid('chg_'), p.id, p.agent_id, p.field + '.rollback', p.after, p.before, now(), 'system', 'system', 'auto', null, null)
      restoreAlgoFromChange(db, { agent_id: p.agent_id, field: p.field, before: p.before, after: p.after })
      try { if (p.field) setCooldown(db, p.agent_id, 'field', p.field, LIMITS.rollback.freezeDays, 'observe_rollback') } catch { /* ignore */ }
      try {
        if ((p.change_class === 'C1' || p.change_class === 'C2') && p.fork_artifact_id) {
          const kind = kindForProposal(p) || (p.change_class === 'C1' ? 'structure' : 'taxonomy')
          const b = getBinding(db, p.agent_id, kind)
          if (b && b.previous_id) activateBinding(db, p.agent_id, kind, b.previous_id)
        }
      } catch { /* 工件回切失败不影响结算 */ }
      rolled++
    }
    if (regressed.length) {
      try { db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(nid('evt_'), p.agent_id, 'observe.regressed', JSON.stringify({ proposal: p.id, regressed }), now()) } catch { /* 忽略 */ }
    }
  }
  return { settled, rolled_back: rolled }
}

function restoreAlgoFromChange(db, ch) {
  const raw = String(ch.field || '').replace(/\.rollback$/, '')
  const slot = FIELD_SLOT[raw]
  try {
    const before = JSON.parse(ch.field.endsWith('.rollback') ? ch.after : ch.before)
    if (PARAMS[raw]) writeParam(db, ch.agent_id, raw, before)
    if (slot) {
      const ver = String(before)
      if (algoHas(slot, ver)) setBinding(ch.agent_id, slot, { active: ver, canary: null, ratio: 0 })
    }
  } catch { /* ignore */ }
}

export function rollbackChange(db, cid, role) {
  if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以回滚')
  const ch = db.prepare('SELECT * FROM changes WHERE id=?').get(cid)
  if (!ch) err(404, 'NOT_FOUND', '变更不存在')
  if (ch.rolled_back_at) err(409, 'CONFLICT', '已经回滚过')
  db.prepare('UPDATE changes SET rolled_back_at=? WHERE id=?').run(now(), cid)
  db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(nid('chg_'), ch.proposal_id, ch.agent_id, ch.field + '.rollback', ch.after, ch.before, now(), 'user', 'user', 'manual', null, null)
  if (ch.proposal_id) db.prepare("UPDATE proposals SET state='rolled_back' WHERE id=?").run(ch.proposal_id)
  restoreAlgoFromChange(db, ch)
  try {
    const kind = String(ch.field || '').startsWith('taxonomy') ? 'taxonomy' : String(ch.field || '').startsWith('structure') ? 'structure' : null
    if (kind) {
      const b = getBinding(db, ch.agent_id, kind)
      if (b && b.previous_id) activateBinding(db, ch.agent_id, kind, b.previous_id)
    }
  } catch { /* 工件回滚失败不影响主体 */ }
  event(db, ch.agent_id, 'change.rolled_back', { change_id: cid })
  return { id: cid, state: 'rolled_back' }
}

/** 启动恢复：pending 的变更日志一律回退（fail-safe） */
export function recoverChangeJournal(db) {
  let n = 0
  try {
    const rows = db.prepare("SELECT * FROM change_journal WHERE state='pending'").all()
    for (const r of rows) {
      try {
        if (r.field && PARAMS[r.field]) { const before = JSON.parse(r.before_value); if (before !== undefined) writeParam(db, r.agent_id, r.field, before) }
      } catch { /* 单个恢复失败继续 */ }
      try {
        const kind = FIELD_KIND[String(r.field || '')]
        if (kind) {
          const b = getBinding(db, r.agent_id, kind)
          if (b && b.previous_id) activateBinding(db, r.agent_id, kind, b.previous_id)
        }
      } catch { /* ignore */ }
      try { db.prepare("UPDATE change_journal SET state='recovered', updated_at=? WHERE id=?").run(now(), r.id) } catch { /* ignore */ }
      n++
    }
  } catch { n = 0 }
  return n
}

export function inbox(db, aid) {
  agent(db, aid)
  const rows = db.prepare('SELECT * FROM inbox_items WHERE agent_id=? ORDER BY created_at DESC').all(aid)
  const exp = {}
  try { for (const p of db.prepare('SELECT id, expires_at FROM proposals WHERE agent_id=? AND expires_at IS NOT NULL').all(aid)) exp[p.id] = p.expires_at } catch { /* 老库 */ }
  const decorate = (i) => {
    const at = exp[i.ref_id]
    if (!at) return i
    const ms = Date.parse(at) - Date.now()
    return { ...i, expires_at: at, expiring: ms > 0 && ms < 3 * 86400000, expired: ms <= 0 }
  }
  const live = rows.map(decorate).filter((i) => !i.expired)
  return {
    todo: live.filter((i) => i.lane === 'todo' && i.state === 'pending'),
    change: live.filter((i) => i.lane === 'change' && i.state === 'pending'),
  }
}

export function inboxBulk(db, body) {
  const out = []
  for (const iid of body.ids || []) {
    const row = db.prepare('SELECT * FROM inbox_items WHERE id=?').get(iid)
    if (!row) { out.push({ id: iid, error: 'NOT_FOUND' }); continue }
    const state = { allow: 'allowed', deny: 'denied', snooze: 'snoozed' }[body.action] || 'denied'
    db.prepare('UPDATE inbox_items SET state=? WHERE id=?').run(state, iid)
    out.push({ id: iid, state })
  }
  return { results: out }
}

export function listProposals(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM proposals WHERE agent_id=? ORDER BY created_at DESC').all(aid)
}

export function listChanges(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM changes WHERE agent_id=? ORDER BY applied_at DESC').all(aid)
}


/**
 * 认不出的情绪攒够了就起草一条 C2 分类法提案（draft 态，不进收件区，等你审）
 * 触发：近 7 天 affect.unlabeled ≥ 10 条（C2 证据门槛），且 30 天内没有同类草案
 */
export function maybeDraft(db, aid, targetId) {
  const t = targetById(targetId)
  if (!t) return null
  return maybeDraftWithTarget(db, aid, t)
}

export function maybeDraftWithTarget(db, aid, t) {
  if (!t) return null
  const since = new Date(Date.now() - Number(t.windowDays || 7) * 86400000).toISOString()
  const evs = db.prepare('SELECT payload, created_at FROM events WHERE agent_id=? AND type=? AND created_at>=? ORDER BY created_at DESC').all(aid, t.signal, since)
  if (evs.length < Number(t.threshold || 10)) return null
  const recent = db.prepare("SELECT id FROM proposals WHERE agent_id=? AND target=? AND created_at>=? AND state NOT IN ('expired','rejected','rolled_back','settled')")
    .get(aid, t.id, new Date(Date.now() - Number(t.cooldownDays || 30) * 86400000).toISOString())
  if (recent) return null
  const texts = evs.slice(0, 10).map((e) => { try { return JSON.parse(e.payload).text } catch { return '' } }).filter(Boolean)
  const cands = evs.map((e) => { try { return JSON.parse(e.payload).candidate || '' } catch { return '' } }).filter(Boolean)
  let base = []
  try { base = t.base ? t.base(db, aid) : [] } catch { base = [] }
  const pid = nid('prp_')
  const evidence = [{
    source: t.evidence || 'user-utterance',
    samples: evs.length,
    texts,
    suggest: { key: '', name: cands[0] || '', candidates: [...new Set(cands)].slice(0, 5) },
  }]
  db.prepare(`INSERT INTO proposals(
    id,human_no,agent_id,change_class,target,field,before,after,state,gate_trace,
    created_at,expires_at,shadow_done,shadow_total,shadow_log,shadow_hit
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    pid, null, aid, t.changeClass, t.id, t.field,
    JSON.stringify(base), JSON.stringify({}), 'draft', JSON.stringify(evidence),
    now(), new Date(Date.now() + 7 * 86400000).toISOString(), 0, 0, '[]', null,
  )
  event(db, aid, 'selfmod.draft_created', { proposal_id: pid, target: t.id, samples: evs.length })
  return { id: pid, samples: evs.length, target: t.id }
}

// 兼容旧调用名
export function maybeDraftTaxonomy(db, aid) {
  return maybeDraft(db, aid, 'taxonomy.labels')
}

export { TARGETS, TARGET_IDS, targetById } from './selfmod_targets.js'

export function listDrafts(db, aid) {
  agent(db, aid)
  return db.prepare("SELECT * FROM proposals WHERE agent_id=? AND state='draft' ORDER BY created_at DESC").all(aid)
}


/**
 * 草案 → 正式 C2 提案。key/name 由人填（可参考建议），附证据。
 * 生成的是普通 C2：走影子 20 轮，跑完还要人批准才生效。
 */
export function promoteDraft(db, aid, pid, body = {}) {
  agent(db, aid)
  const p = db.prepare('SELECT * FROM proposals WHERE id=? AND agent_id=?').get(pid, aid)
  if (!p) err(404, 'NOT_FOUND', '草案不存在')
  if (p.state !== 'draft') err(409, 'CONFLICT', '只有 draft 可以提交')
  const t = targetById(p.target)
  if (!t) err(400, 'INVALID_ARGUMENT', '未知的自修改目标：' + p.target)
  // 越缺越有资格：C1 需要 D3，C2/C3 需要 D2（C4 不受限）
  try {
    const RANK = { D0: 0, D1: 1, D2: 2, D3: 3 }
    const band = String((db.prepare('SELECT band FROM drive_state WHERE agent_id=?').get(aid) || {}).band || 'D0')
    const need = t.changeClass === 'C1' ? 'D3' : (t.changeClass === 'C2' || t.changeClass === 'C3') ? 'D2' : 'D0'
    if ((RANK[band] || 0) < (RANK[need] || 0)) err(409, 'BAND', '缺口档位不足：当前 ' + band + '，需要 ' + need + ' 才能提交 ' + t.changeClass)
  } catch (e) { if (e && e.code === 'BAND') throw e }

  const evidenceRaw = (() => { try { return JSON.parse(p.gate_trace || '[]') } catch { return [] } })()[0] || {}
  const ev = [{
    source: t.evidence || 'user-utterance',
    samples: Number(evidenceRaw.samples || 0),
    texts: evidenceRaw.texts || [],
    title: evidenceRaw.title || '',
    url: evidenceRaw.url || '',
    note: evidenceRaw.note || '',
    citation: evidenceRaw.citation || null,
    citations: evidenceRaw.citations || undefined,
  }]
  let base = null
  try { base = t.base ? t.base(db, aid) : null } catch { base = null }

  let after = null
  if (t.apply === 'artifact:taxonomy') {
    const key = String(body.key || '').trim().toLowerCase()
    const name = String(body.name || '').trim()
    if (!/^[a-z][a-z0-9_-]{1,23}$/.test(key)) err(400, 'INVALID_ARGUMENT', 'key 需为小写英文/数字/下划线，2-24 位')
    if (!name) err(400, 'INVALID_ARGUMENT', 'name 必填')
    let payload = {}
    try { const art = resolveActiveArtifact(db, aid, 'taxonomy'); if (art) payload = parsePayload(art) || {} } catch { payload = {} }
    const labels = Array.isArray(payload.affect_labels) ? payload.affect_labels.slice() : (Array.isArray(base) ? base.slice() : [])
    if (labels.includes(key)) err(409, 'CONFLICT', '这个 key 已经在分类法里')
    after = JSON.stringify({ ...payload, affect_labels: [...labels, key], names: { ...(payload.names || {}), [key]: name }, definition: String(body.definition || '') })
  } else if (t.apply === 'artifact:structure') {
    const payload = base && Array.isArray(base.edges) ? JSON.parse(JSON.stringify(base)) : { edges: [] }
    if (!payload.edges.length) err(409, 'CONFLICT', '结构工件没有边可调')
    const weak = payload.edges.reduce((m, x) => (Number(x.weight || 0) < Number(m.weight || 0) ? x : m), payload.edges[0])
    weak.weight = Math.min(1, +(Number(weak.weight || 0) + 0.1).toFixed(2))
    after = JSON.stringify(payload)
  } else if (t.apply === 'binding') {
    const cur = String(base == null ? '' : base)
    const next = body.value != null ? String(body.value) : (typeof t.next === 'function' ? String(t.next(cur)) : cur)
    if (!next || next === cur) err(409, 'CONFLICT', '没有可提交的新版本')
    after = JSON.stringify(next)
  } else if (t.apply === 'param') {
    const cur = Number(base)
    if (!Number.isFinite(cur)) err(409, 'CONFLICT', '目标当前值不可读')
    const next = body.value != null ? Number(body.value) : (typeof t.next === 'function' ? t.next(cur) : cur)
    if (!Number.isFinite(next) || next === cur) err(409, 'CONFLICT', '没有可提交的新值')
    after = JSON.stringify(Math.round(next * 1000) / 1000)
  } else {
    err(400, 'INVALID_ARGUMENT', '目标缺少 apply 处理器：' + t.id)
  }

  const out = createProposal(db, aid, {
    change_class: t.changeClass,
    field: t.field,
    before: JSON.stringify(base),
    after,
    evidence: ev,
  })
  const okState = out.state === 'shadowed' || (t.changeClass === 'C4' && out.state === 'committed')
  if (!okState) throw Object.assign(new Error('提案没有进入可批状态：' + out.state), { state: out.state, gate_trace: out.gate_trace })
  db.prepare("UPDATE proposals SET state='promoted' WHERE id=?").run(pid)
  event(db, aid, 'selfmod.draft_promoted', { draft_id: pid, proposal_id: out.id, target: t.id })
  return { ...out, draft_id: pid, target: t.id }
}

/** 观察 → 草案：唯一入口。source 可以是 user-doc 或 research，规则一致 */
export function draftFromObservation(db, aid, obs) {
  agent(db, aid)
  const v = validateObservation(obs)
  if (!v.ok) err(400, 'INVALID_ARGUMENT', '观察不合格：' + v.errors.join(','))
  const targetId = String((obs.targets && obs.targets[0]) || '')
  const t = targetById(targetId)
  if (!t) err(400, 'INVALID_ARGUMENT', 'target 不在自修改目标表里：' + targetId)
  let base = null
  try { base = t.base ? t.base(db, aid) : null } catch { base = null }
  const pid = nid('prp_')
  const excerpt = String(obs.excerpt || obs.claim || '').slice(0, 300)
  const evidence = [{
    source: obs.source,
    title: String(obs.title || '').slice(0, 120),
    url: String(obs.url || '').slice(0, 300),
    note: excerpt,
    citation: obs.citation || null,
    citations: Array.isArray(obs.citations) ? obs.citations.slice(0, 5) : undefined,
    texts: excerpt ? [excerpt] : [],
    samples: Number.isFinite(Number(obs.samples)) && Number(obs.samples) > 0 ? Number(obs.samples) : 1,
  }]
  db.prepare(`INSERT INTO proposals(
    id,human_no,agent_id,change_class,target,field,before,after,state,gate_trace,
    created_at,expires_at,shadow_done,shadow_total,shadow_log,shadow_hit
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    pid, null, aid, t.changeClass, t.id, t.field,
    JSON.stringify(base), JSON.stringify({}), 'draft', JSON.stringify(evidence),
    now(), new Date(Date.now() + 7 * 86400000).toISOString(), 0, 0, '[]', null,
  )
  event(db, aid, 'knowledge.draft_created', { proposal_id: pid, target: t.id, source: obs.source, title: String(obs.title || '') })
  return { id: pid, target: t.id, class: t.changeClass, source: obs.source }
}

/** 旧接口：人工投喂 → Observation → 草案 */
export function draftFromKnowledge(db, aid, body = {}) {
  return draftFromObservation(db, aid, manualObservation(body))
}
