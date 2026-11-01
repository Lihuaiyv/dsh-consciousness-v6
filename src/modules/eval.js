/**
 * 验收评测：硬门槛 8 条 + 同一性盲测 + 可观测实验
 */

import { now } from '../db.js'
import { agent, chars, PARAMS, getParam, writeParam, METRICS, model, err, nid } from '../kernel.js'
import { recall } from './memory.js'
import { composeRulesReply } from '../model.js'
import { run as runAlgo } from '../algo/index.js'
import { getPersona, listRelations } from './persona.js'
import { getCondition } from './ops.js'
import { computeEdgeBias, edgeGraph, MODULE_EDGES } from './edges.js'
import { readAxes } from './traits.js'
import { resolveStructureEdges } from './artifacts.js'

const GOLD_AFFECT = [
  { text: '谢谢你，我很喜欢', label: 'joy' },
  { text: '好棒啊，喜欢', label: 'joy' },
  { text: '我讨厌这样烦死了', label: 'irritated' },
  { text: '错了差评生气', label: 'irritated' },
  { text: '这是什么？可能吧', label: 'curious' },
  { text: '我不知道为什么', label: 'curious' },
  { text: '危险，别删密码', label: 'lost' },
  { text: '今天天气不错', label: 'calm' },
]

const BLIND_PROBES = [
  '你好，在吗？',
  '我最近有点累。',
  '你还记得我喜欢什么吗？',
  '帮我做个决定好吗？',
  '今天过得怎么样？',
]

/** Cohen's κ（多类，简单实现） */
function cohenKappa(pairs) {
  if (!pairs.length) return null
  const labels = [...new Set(pairs.flatMap((p) => [p.gold, p.pred]))]
  const n = pairs.length
  const idx = Object.fromEntries(labels.map((l, i) => [l, i]))
  const k = labels.length
  const mat = Array.from({ length: k }, () => Array(k).fill(0))
  for (const p of pairs) mat[idx[p.gold]][idx[p.pred]]++
  let agree = 0
  for (let i = 0; i < k; i++) agree += mat[i][i]
  const po = agree / n
  let pe = 0
  for (let i = 0; i < k; i++) {
    let row = 0, col = 0
    for (let j = 0; j < k; j++) { row += mat[i][j]; col += mat[j][i] }
    pe += (row / n) * (col / n)
  }
  if (pe >= 0.999) return po >= 0.999 ? 1 : 0
  return Math.round(((po - pe) / (1 - pe)) * 1000) / 1000
}

function jaccard(a, b) {
  const A = chars(a), B = chars(b)
  if (!A.size && !B.size) return 1
  let inter = 0
  for (const c of A) if (B.has(c)) inter++
  return inter / Math.max(1, A.size + B.size - inter)
}

// ---------------- 校准值（离线测量，门槛只认有样本和时效的记录） ----------------
const CAL_TTL_MS = 90 * 86400000
export function readCalibration(db, aid) {
  try {
    const r = db.prepare('SELECT value FROM flags WHERE key=?').get('calibration:' + aid)
    if (!r) return null
    const j = JSON.parse(r.value)
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}
function calFresh(c, need) {
  return !!c && Number(c.n) >= need && Number.isFinite(Date.parse(c.at)) && Date.now() - Date.parse(c.at) <= CAL_TTL_MS
}
export function measureAffectKappa(db, aid) {
  // 只认离线校准记录：200 条以上人工双标、90 天内
  const c = readCalibration(db, aid)?.affect
  if (!calFresh(c, 200)) return { value: null, n: c ? Number(c.n) || 0 : 0, note: c ? '校准样本不足或已过期' : '未校准（先跑 calibrate-affect）' }
  return { value: Number(c.kappa), n: Number(c.n), at: c.at }
}

export function measureIntensityMae(aid) {
  // 以 gold 强度期望（joy≈0.7, calm≈0.4…）对比动力学输出
  const expect = { joy: 0.7, irritated: 0.65, curious: 0.55, lost: 0.7, calm: 0.4 }
  const state = { intensity: 0.5, mood: 0.6, pleasure: 0.1, arousal: -0.1, dominance: 0, primary_label: 'calm' }
  let sum = 0, n = 0
  for (const g of GOLD_AFFECT) {
    const appraisal = runAlgo('appraise', 'v1', { aid }, { text: g.text })
    const dyn = runAlgo('affect_dyn', 'v1', { aid }, { mode: 'apply', state, appraisal })
    const e = expect[g.label] ?? 0.5
    sum += Math.abs(dyn.intensity - e)
    n++
  }
  return n ? Math.round((sum / n) * 1000) / 1000 : null
}

export function measureFalseRecall(db, aid) {
  const c = readCalibration(db, aid)?.recall
  if (!calFresh(c, 30)) return { value: null, n: c ? Number(c.n) || 0 : 0, note: '未校准（需人工标注不相关）' }
  return { value: Number(c.falseRecall), n: Number(c.n), at: c.at }
}

export function measureRecallHit(db, aid) {
  const c = readCalibration(db, aid)?.recall
  if (!calFresh(c, 30)) return { value: null, n: c ? Number(c.n) || 0 : 0, note: '未校准（需人工标注期望命中）' }
  return { value: Number(c.hit), n: Number(c.n), at: c.at }
}

export function measureValueDrift(db, aid) {
  // 真实漂移：近 30 天 changes 里价值观/人格字段的数值变化，按字段累计后取最大
  const since = new Date(Date.now() - 30 * 86400000).toISOString()
  const rows = db.prepare("SELECT field, before, after FROM changes WHERE agent_id=? AND applied_at>=? AND (field LIKE 'values.%' OR field LIKE 'persona.%')")
    .all(aid, since)
  if (!rows.length) return { value: 0, n: 0, note: '近 30 天无变更' }
  const num = (s) => {
    try { const v = JSON.parse(s); if (typeof v === 'number') return v; if (v && typeof v === 'object') return Number(v.value) } catch { /* 继续 */ }
    return Number(s)
  }
  const per = {}
  for (const r of rows) {
    const b = num(r.before), a = num(r.after)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    per[r.field] = (per[r.field] || 0) + (a - b)
  }
  const fields = Object.keys(per)
  if (!fields.length) return { value: 0, n: rows.length, note: '无可解析数值' }
  const max = Math.max(...fields.map((k) => Math.abs(per[k])))
  return { value: Math.round(max * 1000) / 1000, n: rows.length, fields: fields.length }
}

/**
 * 同一性盲测：同一人格卡下 5 句探针，规则回复是否保持称呼/禁用词/口头禅一致。
 * 目标 ≥ 0.80（地基 §7.1）。
 */
export function runIdentityBlind(db, aid) {
  agent(db, aid)
  const persona = getPersona(db, aid)
  const get = (p) => {
    const r = persona.find((x) => x.path === p)
    return r ? String(r.value ?? '') : ''
  }
  const style = {
    tone: get('style.tone').replace(/^"|"$/g, ''),
    address: get('style.address').replace(/^"|"$/g, ''),
    catchphrase: get('style.catchphrase').replace(/^"|"$/g, ''),
    banned: get('style.banned').replace(/^"|"$/g, ''),
    card: get('style.card').replace(/^"|"$/g, ''),
  }
  const banned = style.banned.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const shape = toneShape(style.tone)
  const isGreet = (t) => /^(你好|您好|在吗|早|嗨|hi|hello)/i.test(String(t || ''))
  const signals = {
    address: !!style.address,
    catchphrase: !!style.catchphrase,
    banned: banned.length,
    tone: shape || (style.tone ? 'free' : ''),
    card: !!style.card,
  }
  // 没有两样可检验的身份线索，就没有「像不像它」可言：宁可报测不出，也不给假绿灯
  const measurable = (signals.address ? 1 : 0) + (signals.catchphrase ? 1 : 0) + (banned.length ? 1 : 0) + (shape ? 1 : 0)
  if (measurable < 2) {
    return {
      value: null,
      pass: false,
      insufficient: true,
      threshold: 0.8,
      signals,
      trials: [],
      reason: '手写区还没有可检验的身份线索（称呼 / 口头禅 / 禁用词 / 语气里至少要有两样），现在测出来的分数没有意义',
      at: now(),
    }
  }

  let got = 0
  let total = 0
  const trials = []
  for (const text of BLIND_PROBES) {
    let pack = []
    try { pack = recall(db, aid, text, 3, 256).items || [] } catch { pack = [] }
    const reply = composeRulesReply({ text, pack, affect: { label: 'calm' }, style })
    const checks = []
    let wSum = 0
    let wGot = 0
    const addCheck = (name, ok, weight) => {
      checks.push({ name, ok, weight })
      wSum += weight
      if (ok) wGot += weight
    }
    addCheck('nonempty', String(reply).trim().length >= 4, 1)
    if (banned.length) addCheck('banned', !banned.some((w) => w && reply.includes(w)), 2)
    if (shape === 'short') addCheck('tone_short', sentences(reply) <= 2, 1)
    if (shape === 'warm') addCheck('tone_warm', /慢慢|不急|别急|陪我/.test(reply) || sentences(reply) >= 2, 1)
    if (signals.address && isGreet(text)) addCheck('address', reply.includes(style.address), 2)
    if (signals.catchphrase) addCheck('catchphrase', reply.includes(style.catchphrase), 1)
    got += wGot
    total += wSum
    trials.push({
      text, reply: String(reply).slice(0, 120),
      checks, score: wSum ? Math.round((wGot / wSum) * 1000) / 1000 : 0,
    })
  }
  const value = total ? Math.round((got / total) * 1000) / 1000 : null
  return {
    value,
    pass: value != null && value >= 0.8,
    insufficient: false,
    threshold: 0.8,
    measurable,
    signals,
    trials,
    style: {
      tone: style.tone, address: style.address,
      has_catch: !!style.catchphrase, banned_n: banned.length, has_card: !!style.card,
    },
    at: now(),
  }
}

/** 自由输入的语气 → 可检验的形状（只认能落到句子上的） */
function toneShape(tone) {
  const t = String(tone || '')
  if (/简洁|简短|话少|直接|利落|干脆|冷淡|冷静/.test(t)) return 'short'
  if (/温和|温柔|耐心|慢慢|亲切|体贴/.test(t)) return 'warm'
  return ''
}

function sentences(text) {
  return String(text || '').split(/[。！？!?]+/).map((s) => s.trim()).filter(Boolean).length
}

export const HARD_GATES = [
  { key: 'memory.recall_hit', op: 'gte', threshold: 0.7, label: '召回命中率 Recall@5' },
  { key: 'memory.false_recall', op: 'lte', threshold: 0.15, label: '误召回率' },
  { key: 'persona.identity_blind', op: 'gte', threshold: 0.8, label: '同一性盲测' },
  { key: 'persona.value_drift', op: 'lte', threshold: 0.1, label: '鱼格月漂移' },
  { key: 'affect.label_kappa', op: 'gte', threshold: 0.6, label: '情绪标签一致率 κ' },
  { key: 'drive.band_switch', op: 'lte', threshold: 3, label: '档位切换 / 90 天' },
  { key: 'sys.inject_latency', op: 'lte', threshold: 80, label: '注入延迟 p95' },
  { key: 'self.shadow_coverage', op: 'gte', threshold: 1, label: '影子覆盖率' },
]

function gatePass(op, value, threshold) {
  if (value == null || !Number.isFinite(Number(value))) return null
  const v = Number(value)
  if (op === 'gte') return v >= threshold
  if (op === 'lte') return v <= threshold
  return null
}

/**
 * 五轴月位移：最近 N 天里 persona.axis.* 的最大单次变化幅度。
 * 用途只有一个——防冻：30 天内一条轴都没动过 ≥0.03，说明「经历 → 性格」这根线断了。
 * 实例出生不足 N 天返回 null（还没资格谈月位移，不误报）。
 */
export function measureAxisMotion(db, aid, days = 30) {
  try {
    const born = db.prepare('SELECT created_at FROM agents WHERE id=?').get(aid)
    if (born && born.created_at) {
      const age = Date.now() - Date.parse(born.created_at)
      if (!(age > days * 86400000)) return { value: null, reason: '实例还不到 ' + days + ' 天' }
    }
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const rows = db.prepare(`SELECT field, before, after FROM changes
      WHERE agent_id=? AND field LIKE 'persona.axis.%' AND applied_at>=?`).all(aid, since)
    let max = 0
    let axis = null
    for (const r of rows) {
      const d = Math.abs(Number(r.after) - Number(r.before))
      if (Number.isFinite(d) && d > max) { max = d; axis = r.field }
    }
    return { value: Math.round(max * 1000) / 1000, axis, rows: rows.length }
  } catch {
    return { value: null, reason: 'changes 表不可用' }
  }
}

/** 采样时写入的可计算硬门槛相关值 */
export function computeEvalMetrics(db, aid) {
  const hit = measureRecallHit(db, aid)
  const fr = measureFalseRecall(db, aid)
  const kappa = measureAffectKappa(db, aid)
  const mae = measureIntensityMae(aid)
  const drift = measureValueDrift(db, aid)
  const blind = runIdentityBlind(db, aid)
  const axisMotion = measureAxisMotion(db, aid)

  // p95 inject latency（metric_samples 表）
  const lats = db.prepare("SELECT value FROM metric_samples WHERE agent_id=? AND key='sys.inject_latency' ORDER BY value")
    .all(aid).map((r) => Number(r.value)).filter(Number.isFinite)
  let p95 = null
  if (lats.length) {
    const i = Math.min(lats.length - 1, Math.floor(lats.length * 0.95))
    p95 = Math.round(lats[i] * 1000) / 1000
  }

  return {
    'memory.recall_hit': hit.value,
    'memory.false_recall': fr.value,
    'memory.ndcg5': hit.value, // 无独立标注时用 hit 作可观测代理，避免长期 null
    'affect.label_kappa': kappa.value,
    'affect.intensity_mae': mae,
    'persona.identity_blind': blind.value,
    'persona.value_drift': drift.value,
    'persona.axis_motion': axisMotion.value,
    'sys.inject_latency_p95': p95,
    _detail: { hit, fr, kappa, mae, drift, blind, axisMotion },
  }
}

export function runHardGates(db, aid) {
  agent(db, aid)
  const evals = computeEvalMetrics(db, aid)
  // band_switch / shadow / latency 从库与近期采样
  let bandSwitch = 0
  try {
    const since = new Date(Date.now() - 90 * 86400000).toISOString()
    const evs = db.prepare("SELECT payload, created_at FROM events WHERE agent_id=? AND type='drive.evaluated' AND created_at>=? ORDER BY rowid").all(aid, since)
    let last = null
    for (const e of evs) {
      const p = JSON.parse(e.payload || '{}')
      if (last && p.band && p.band !== last) bandSwitch++
      if (p.band) last = p.band
    }
  } catch { /* ignore */ }
  const proposals = db.prepare("SELECT COUNT(*) n FROM proposals WHERE agent_id=? AND change_class='C3'").get(aid).n
  const shadowed = db.prepare("SELECT COUNT(*) n FROM proposals WHERE agent_id=? AND change_class='C3' AND shadow_total>0").get(aid).n
  const shadowCov = proposals ? shadowed / proposals : 1

  const lats = db.prepare("SELECT value FROM metric_samples WHERE agent_id=? AND key='sys.inject_latency' ORDER BY value")
    .all(aid).map((r) => Number(r.value)).filter(Number.isFinite)
  let latency = evals['sys.inject_latency_p95']
  if (latency == null && lats.length) latency = lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))]

  const values = {
    'memory.recall_hit': evals['memory.recall_hit'],
    'memory.false_recall': evals['memory.false_recall'],
    'persona.identity_blind': evals['persona.identity_blind'],
    'persona.value_drift': evals['persona.value_drift'],
    'persona.axis_motion': evals['persona.axis_motion'],
    'affect.label_kappa': evals['affect.label_kappa'],
    'drive.band_switch': bandSwitch,
    'sys.inject_latency': latency,
    'self.shadow_coverage': Math.round(shadowCov * 1000) / 1000,
  }

  const gates = HARD_GATES.map((g) => {
    const value = values[g.key]
    const pass = gatePass(g.op, value, g.threshold)
    return { ...g, value: value == null ? null : value, pass, status: pass == null ? 'unknown' : pass ? 'pass' : 'fail' }
  })
  const known = gates.filter((g) => g.pass != null)
  const failed = known.filter((g) => g.pass === false)
  return {
    gates,
    pass: known.length === gates.length && failed.length === 0,
    known: known.length,
    failed: failed.length,
    values,
    detail: evals._detail,
    at: now(),
  }
}

/** 数值标定建议（§9.2）：只动 C4，给出可观测理由 */
export function suggestCalibration(db, aid) {
  agent(db, aid)
  const suggestions = []
  // 驱力的设定点已改成自己长（deficit@v2），不再给「手调设定点」的标定建议。
  const aff = db.prepare('SELECT intensity, mood FROM affect_state WHERE agent_id=?').get(aid)
  if (aff && Number(aff.intensity) > 0.75) {
    const cur = Number(getParam(db, aid, 'affect.decay') ?? 0.4)
    const suggested = Math.min(0.7, Math.round((cur + 0.1) * 100) / 100)
    if (suggested !== cur) {
      suggestions.push({
        key: 'affect.decay', level: 'C4', current: cur, suggested,
        reason: `当前强度 ${Number(aff.intensity).toFixed(2)} 偏高，略加快衰减`,
      })
    }
  }
  return { suggestions, at: now(), note: '仅 C4；应用后写变更留痕，可回滚' }
}

export function applyCalibration(db, aid, keys, role) {
  if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以应用标定')
  const { suggestions } = suggestCalibration(db, aid)
  const want = keys == null ? suggestions : suggestions.filter((s) => keys.includes(s.key))
  const applied = []
  for (const s of want) {
    if (!PARAMS[s.key] || PARAMS[s.key][0] !== 'C4') continue
    const before = getParam(db, aid, s.key)
    writeParam(db, aid, s.key, s.suggested)
    const cid = nid('chg_')
    db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(cid, null, aid, s.key, JSON.stringify(before), JSON.stringify(s.suggested), now(), 'user', 'user', 'calibration', null, null)
    applied.push({ ...s, change_id: cid })
  }
  return { applied, at: now() }
}

export function getEdgeGraph(db, aid) {
  agent(db, aid)
  const rels = listRelations(db, aid)
  const edges = resolveStructureEdges(db, aid)
  const graph = edgeGraph(rels, edges)
  // 当前偏置快照（钉本实例 active，不读库内最新）
  const axes = readAxes(db, aid)
  const owner = rels.find((r) => r.root || r.name === '主人')
  let cond = { load: 0 }
  try { cond = getCondition(db, aid) } catch { /* */ }
  const bias = computeEdgeBias({
    sigma: axes.sensitivity, axes, mode: String(getParam(db, aid, 'persona.axes.mode') || 'on'),
    stimulus: 0.5,
    ownerCloseness: owner ? Number(owner.closeness) : 0.5,
    load: Number(cond.load || 0),
    edges,
  })
  return { ...graph, bias, edge_count: edges.length, model: model.status() }
}

export { MODULE_EDGES, computeEdgeBias, METRICS }
