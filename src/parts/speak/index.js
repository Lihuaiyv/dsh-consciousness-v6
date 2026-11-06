/**
 * 主动开口 · 零件入口（src/parts/speak/）
 *
 * 对外只有这一个口：runSpeakTick(db, aid, { manual, at, trigger })。
 * 内部顺序：偏好 → 事由（trigger）→ 判断（decideSpeak）→ 生成并入队（queueProactive）。
 *
 * 零件内：prefs / budget / trigger / judge / compose / store / hooks。
 * 共享件只 import：情绪、驱力、人格、关系、开环、模型、记忆、参数、flags、事件、预算服务。
 * 链外接线（把已入队那句推进会话）由宿主层调，不在零件内。
 */
import { now } from '../../db.js'
import { event } from '../../core.js'
import { enqueueProactive } from '../../modules/proactive.js'
import { budgetConsume } from '../../modules/drive.js'
import { markLoopsFired } from '../../modules/loops.js'
import { getProactivePrefs, setProactivePrefs, PROACTIVE_DEFAULTS } from './prefs.js'
import { proactiveSpend, addProactiveSpend } from './budget.js'
import { proactiveTriggerOf, markLoopImportant, isLoopImportant } from './trigger.js'
import { decideSpeak, proactiveDecision, nextTryInHours, proactiveGate, noteProactiveAttempt } from './judge.js'
import { composeProactiveLine } from './compose.js'
import { recordProactiveDecision, listProactiveDecisions, lastProactiveDecision, listProactive, settleProactiveAnswered, markProactiveIgnored, proactiveStats, ackProactive, bumpStat } from './store.js'

export {
  getProactivePrefs, setProactivePrefs, PROACTIVE_DEFAULTS,
  proactiveSpend, addProactiveSpend,
  proactiveTriggerOf, markLoopImportant, isLoopImportant,
  decideSpeak, proactiveDecision, nextTryInHours, proactiveGate,
  composeProactiveLine,
  recordProactiveDecision, listProactiveDecisions, lastProactiveDecision, listProactive,
  settleProactiveAnswered, markProactiveIgnored, proactiveStats, ackProactive,
}

/** 同一句话不要反复说：去掉标点再比。 */
function sameLine(a, b) {
  const norm = (s) => String(s || '').replace(/[\s，。！？、,.!?~～…"'「」『』]/g, '')
  return norm(a) === norm(b)
}

/** 把生成阶段的内容门结论补进理由链（替换那条「待判」）。 */
function withContentGate(d, gate) {
  if (!gate) return d
  const gates = (d.gates || []).map((g) => (g.id === 'content' ? gate : g))
  if (!gates.some((g) => g.id === 'content')) gates.push(gate)
  return { ...d, gates, gate: gates }
}

/** 判断 → 生成 → 去重 → 入队 → 记账。返回 null 表示这次不开口（非手动）。 */
export async function queueProactive(db, aid, opt = {}) {
  const { manual = false } = opt
  try { markProactiveIgnored(db, aid) } catch { /* ignore */ }
  // 事由优先：有到期开环就拿它当方向；调用方也可以显式传 trigger（测试 / 手动）
  const trigger = opt.trigger !== undefined ? opt.trigger : proactiveTriggerOf(db, aid)
  const d = decideSpeak(db, aid, { manual, trigger })
  if (!d.will) {
    const did = recordProactiveDecision(db, aid, d)
    if (!manual) return null
    // 手动叫她开口、她不想回：不硬顶，给一个「大概要安静多久」的钟头数（只出文案，不写冷却）
    const hours = nextTryInHours(d)
    return {
      queued: false, reason: d.reason, decision_id: did, why: d,
      next_try_in_hours: hours,
      note: '它现在不想先开口，想安静大概 ' + hours + ' 小时。',
    }
  }
  // 真正要叫模型了：先占掉今天的尝试次数（SILENT 也算，避免心跳每 10 分钟重问）
  noteProactiveAttempt(db, aid)
  const composed = await composeProactiveLine(db, aid, d.intent, { approved: manual, evidence: d.score ? d.score.evidence_items : null })
  const decided = withContentGate(d, composed && composed.gate)
  const memories = (composed && composed.memories) || []
  if (!composed || composed.text == null) {
    const reason = composed && composed.silent ? 'silent' : ((composed && composed.source === 'rules') ? 'no_evidence' : 'nothing_to_say')
    const silentDecision = { ...decided, will: false, reason, explain: (composed && composed.gate && composed.gate.detail) || '它想了想，没什么可说的。' }
    const did = recordProactiveDecision(db, aid, silentDecision, { text: null, source: composed ? composed.source : null })
    return manual ? { queued: false, reason, decision_id: did, why: silentDecision } : null
  }
  const day30 = new Date(Date.now() - 30 * 86400000).toISOString()
  let recent = []
  try { recent = db.prepare('SELECT text FROM proactive WHERE agent_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 3').all(aid, day30).map((r) => r.text) } catch { recent = [] }
  if (recent.some((t) => sameLine(t, composed.text))) {
    const rep = { ...decided, will: false, reason: 'repeat', explain: '它想说的跟之前那句一样，不重复了。' }
    const did = recordProactiveDecision(db, aid, rep, { text: composed.text, source: composed.source })
    return manual ? { queued: false, reason: 'repeat', decision_id: did, why: rep } : null
  }
  const s = d.score || {}
  const why = (d.intent.reason || '') + ' · ' + composed.source
    + (d.manual ? ' · 你让它说' : ' · ' + Number(s.benefit || 0).toFixed(2) + '>' + Number(s.cost || 0).toFixed(2))
  // 分享要按生活 id 记住「排过队没有」，否则下一轮心跳还会想分享同一件事。
  const reason = (d.trigger && d.trigger.kind === 'share' && d.trigger.id) ? ('share:' + d.trigger.id + ' · ' + why) : why
  const id = enqueueProactive(db, aid, { text: composed.text, reason, dim: d.intent.dim || '', at: now() })
  // 说出来之后，这件事就不再「挂着」了；不提的话会每轮重复
  if (d.trigger && d.trigger.kind === 'loop' && d.trigger.id) {
    try { markLoopsFired(db, [d.trigger.id]) } catch { /* 记账失败不影响说话 */ }
  }
  bumpStat(db, aid, d.intent.dim || 'R', 'sent')
  if (!manual && !(d.trigger && d.trigger.owed)) {
    // 「问得好」也便宜一点：有真事的开口算 1；没真事、纯凑数算 2
    const ev = Number(d.score && d.score.evidence_items) || 0
    const weight = ev > 0 ? 1 : 2
    budgetConsume(db, aid, 'disturb', weight)
    try { addProactiveSpend(db, aid, weight) } catch { /* 记账失败不影响说话 */ }
  }
  try {
    event(db, aid, 'proactive.queued', {
      dim: d.intent.dim, source: composed.source, manual: !!manual,
      benefit: s.benefit, cost: s.cost, hours_since: d.hours_since,
      trigger: d.trigger ? d.trigger.kind : null,
    })
  } catch { /* 记账失败不影响说话 */ }
  const did = recordProactiveDecision(db, aid, decided, { text: composed.text, source: composed.source, memories })
  return { queued: true, id, decision_id: did, text: composed.text, source: composed.source, dim: d.intent.dim || '', intent: d.intent.kind, why: decided }
}

export async function runSpeakTick(db, aid, { manual = false, at = Date.now(), trigger = undefined } = {}) {
  const trig = trigger !== undefined ? trigger : proactiveTriggerOf(db, aid, at)
  const out = await queueProactive(db, aid, { manual, at, trigger: trig })
  return {
    queued: !!(out && out.queued),
    reason: (out && out.reason) || (out && out.queued ? 'ok' : 'nothing'),
    text: (out && out.text) || null,
    id: (out && out.id) || null,
    why: out && out.why,
    next_try_in_hours: (out && out.next_try_in_hours) || null,
    spend: proactiveSpend(db, aid),
  }
}
