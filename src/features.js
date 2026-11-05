import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { now, localDay } from './db.js'
import { agent, active, addMemory, err, nid, getParam, getAllParams, writeParams, getPersona, setPersona, recall, appraise, getAffect, getDrive, tx, shadowTick, listDrafts, promoteDraft, event, model as kernelModel } from './core.js'
import { has as algoHas, setBinding, getBinding, listBindings, list as listAlgos, attachDb } from './algo/index.js'
import { computeEdgeBias } from './modules/edges.js'
import { seedScores } from './modules/tiers.js'
import { readAxes, driveAmp } from './modules/traits.js'
import { addEvidence } from './modules/axis_evidence.js'
import { rulesAppraise } from './algo/appraise.js'
import { eventValence, moodAdjust, toneOf, REL_DEFAULTS as REL_DYN } from './algo/reldyn.js'
import { bumpRelation, ownerPerson, personByChannel } from './modules/relations.js'
import { resolveStructureEdges, affectLabels, seedRuleBindings } from './modules/artifacts.js'
import { TARGETS, targetById } from './modules/selfmod_targets.js'
import { setPending, setWokenAt, runningAgentIds, maxRunning, wakeRuntime } from './modules/binding.js'
import { latestShare } from './modules/life.js'
import { promptBudget, isOwner, isLocalChannel, historyTurns, recallItems } from './modules/conversations.js'
// 主动开口零件（src/parts/speak/）：偏好、额度、事由、判断、存储、生成已搬进去，这里只 import 来用
import { PROACTIVE_DEFAULTS, getProactivePrefs, setProactivePrefs } from './parts/speak/prefs.js'
import { proactiveSpend, addProactiveSpend } from './parts/speak/budget.js'
import { markLoopImportant, isLoopImportant, proactiveTriggerOf } from './parts/speak/trigger.js'
import { decideSpeak, proactiveDecision, nextTryInHours, proactiveGate, proactiveCost, minDeficitFor } from './parts/speak/judge.js'
import { model, freeformModelHook } from './parts/speak/hooks.js'
import { composeProactiveLine } from './parts/speak/compose.js'
import { recordProactiveDecision, listProactiveDecisions, lastProactiveDecision, listProactive, settleProactiveAnswered, markProactiveIgnored, proactiveStats, ackProactive, bumpStat } from './parts/speak/store.js'
export { composeProactiveLine }
export {
  decideSpeak, proactiveDecision, nextTryInHours, proactiveGate, proactiveCost, minDeficitFor,
  recordProactiveDecision, listProactiveDecisions, lastProactiveDecision, listProactive,
  settleProactiveAnswered, markProactiveIgnored, proactiveStats, ackProactive,
}
import { appendTurn, buildEpisode } from './modules/archive.js'
import * as R from './modules/relations.js'
import { enqueueRelationRead } from './modules/relations_extract.js'
export { DRIVERS, DRIVER_IDS, driverFindings, applyDriverToDrive } from './modules/selfmod_drivers.js'
export { affectLabels }
import {
  computeEvalMetrics, runHardGates, runIdentityBlind, suggestCalibration, applyCalibration, getEdgeGraph,
} from './modules/eval.js'
import { sendMessage } from './modules/actions/channels.js'

/** 算法槽位 → C3 参数字段 / 默认版本 */
const ALGO_SLOTS = {
  recall: { field: 'memory.recall.formula', fallback: 'v2' },
  decay: { field: 'memory.decay.formula', fallback: 'v1' },
  deficit: { field: 'drive.deficit.formula', fallback: 'v1c' },
  appraise: { field: 'affect.mapping', fallback: 'v1' },
  affect_dyn: { field: 'affect.dynamics.formula', fallback: 'v1' },
}

function syncAlgoBindings(aid, params) {
  if (!params) return
  for (const [name, meta] of Object.entries(ALGO_SLOTS)) {
    const ver = params[meta.field]
    if (ver == null) continue
    const v = String(ver)
    if (algoHas(name, v)) setBinding(aid, name, { active: v, canary: null, ratio: 0 })
  }
}

/** @deprecated 兼容旧名 */
function syncRecallBinding(aid, params) { syncAlgoBindings(aid, params) }

/** 已登记算法目录（INV11） */
export function catalogAlgos() {
  return listAlgos()
}

export function listAlgoBindings(db, aid) {
  agent(db, aid)
  attachDb(db)
  const rows = listBindings(aid)
  const byName = new Map(rows.map((r) => [r.name, r]))
  const out = []
  for (const [name, meta] of Object.entries(ALGO_SLOTS)) {
    if (byName.has(name)) out.push(byName.get(name))
    else {
      const active = String(getParam(db, aid, meta.field) || meta.fallback)
      out.push({ agent_id: aid, name, active, canary: null, ratio: 0 })
    }
  }
  for (const r of rows) if (!ALGO_SLOTS[r.name]) out.push(r)
  return out
}

/** 只允许改 canary / ratio；切 active 必须走 C3 提案 */
export function patchAlgoBinding(db, aid, name, body, role) {
  if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以改灰度')
  active(db, aid)
  attachDb(db)
  const meta = ALGO_SLOTS[name]
  if (!meta) err(404, 'NOT_FOUND', '未知算法槽位')
  if (body.canary && !algoHas(name, body.canary)) {
    err(409, 'ALGO_UNREGISTERED', 'canary 未登记：' + name + '@' + body.canary)
  }
  const cur = getBinding(aid, name) || {
    active: String(getParam(db, aid, meta.field) || meta.fallback), canary: null, ratio: 0,
  }
  if (body.active != null && String(body.active) !== String(cur.active)) {
    err(409, 'PROPOSAL_REQUIRED', '切换 active 请发起 C3 提案（' + meta.field + '）', {
      draft: { change_class: 'C3', field: meta.field, before: cur.active, after: body.active },
    })
  }
  return setBinding(aid, name, {
    active: cur.active,
    canary: body.canary === undefined ? cur.canary : body.canary,
    ratio: body.ratio === undefined ? cur.ratio : body.ratio,
  })
}
import { looksLikeRuntimeNoise, cleanLine } from './text.js'
import { latestFeel } from './modules/feel.js'
import { feelIdsAll } from './modules/feel.js'
import { createModel, composeRulesReply, appraiseRules } from './model.js'
import { zipStore, unzipStore } from './zip.js'
import {
  seedRelations, listRelations, upsertRelation, deleteRelation,
  listValues, setValue, listPreferences, addPreference, removePreference, listTaboos, addTaboo, seedState, LIMITS,
} from './modules/persona.js'
import { sampleAffect, affectHistory, affectTrend, reviewStats, triggerStats, fallbackStats } from './modules/affect.js'
import { softRecall, listActiveMemories, memoryStats } from './modules/memory.js'
import { setMemoryTemp, rebuildMemoryFtsIndex } from './modules/memory_fields.js'
import { invalidateMemory } from './modules/timeline.js'
import { asofInjectItems } from './modules/asof.js'
import { rebuildRawFts, rebuildFactFts } from './modules/archive.js'
import { entityForText } from './modules/entities.js'
import { applyWrite } from './modules/gate.js'
import { narrationOnly, selfTextOk, classifySelf, scoreSelf } from './modules/memory_source.js'
import { enrichOne, enrichPending, canEnrich } from './modules/enrich.js'
import { judgeReflection, canJudge } from './modules/judge.js'
import { detectLoop, addLoop, settleLoopsFromUser, expireLoops, pendingLoops, markLoopsFired } from './modules/loops.js'
import { pledgeMissLine } from './modules/sangguan/pledge.js'
import { bumpReflect, reflectFrom, canConsolidate } from './modules/consolidate.js'
import { getCondition, setCondition } from './modules/ops.js'
import {
  setCooldown, listCooldowns, cooldownActive,
  budgetGet, budgetSet, budgetConsume,
  executeAction, listActions, applySatisfaction,
} from './modules/drive.js'

// model 单例已搬到 src/parts/speak/hooks.js（开口生成与测试钩子共用同一份）

/* ---------------- 外部通道的意识体包 ----------------
 * 网页端由 index.js 的 systemPrompt.section 注入 consciousnessBlock；
 * QQ 这类外部通道不走宿主提示词，所以由 index.js 把同一个 builder 挂过来，
 * 让两边用的是同一份人设/关系/日记/上次聊到，而不是两套。
 */
let contextBlockGetter = null
export function attachContextBlock(fn) { contextBlockGetter = typeof fn === 'function' ? fn : null }

export function buildContextBlock(db, aid, opts) {
  try { return contextBlockGetter ? String(contextBlockGetter(db, aid, opts) || '') : '' } catch { return '' }
}

/** 按字预算截断（优先保留前面的身份/关系/情绪，砍尾部的日记/浮现）。 */
export function clampContextBlock(s, max) {
  const t = String(s || '')
  if (!t || !max || t.length <= max) return t
  return t.slice(0, Math.max(0, max - 16)) + '\n…（上下文按预算截断）'
}

/** 测试钩子：可替换自由导入的模型调用（定义在零件里，这里 re-export，测试照旧从 features 注入） */
export { freeformModelHook }
/** 测试钩子：可替换「自己长偏好」的模型调用 */
export const growModelHook = { complete: null }

/* ---------------- 自己长偏好（喜欢 / 讨厌） ---------------- */

/** 一次最多长出几条：宁少勿滥 */
const GROW_PER_RUN = 5
/** 喂给模型多少条记忆：够看出稳定倾向，又不至于把提示词撑爆 */
const GROW_SCAN = 60

const GROW_SYSTEM = [
  '你是意识体的记忆整理员。下面是我记得的关于「主人」的事。',
  '请从里面找出他稳定、可复用的喜好和厌恶，整理成偏好条目；只输出一个 JSON 对象，不要解释。',
  'JSON 模板：{"preferences":[{"tag":"最多12个字","aversion":0.2,"why":"一句话依据"}]}',
  '规则：',
  '① 只写长期稳定的（口味、习惯、雷区、沟通方式、在意的东西），不写一次性状态、情绪、具体任务、具体技术细节。',
  '② tag 要短，能直接当标签用（例如「香菜」「被打断」「先给结论」），不要写成一句话。',
  '③ aversion：0=很喜欢，0.5=看情况，1=绝对受不了；喜欢给 0–0.3，讨厌给 0.7–1。',
  '④ 最多 5 条；凑不出来就返回 {"preferences":[]}。',
  '⑤ 已经有这些标签，不要重复：{known}',
].join('\n')

/** 去重用的归一化：忽略空白、标点、大小写。 */
function normTag(v) {
  return String(v == null ? '' : v)
    .replace(/[\s,，、。.．;；:：!！?？"'“”‘’()（）\[\]【】<>《》\/\\|~\-—_]/g, '')
    .toLowerCase()
}

function parseJsonLoose(raw) {
  const s = String(raw || '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no json')
  return JSON.parse(s.slice(start, end + 1))
}

// 域 CRUD 已收回 modules/*；此处 re-export 保持 api 导入面稳定
export {
  seedRelations, listRelations, upsertRelation, deleteRelation,
  listValues, setValue, listPreferences, addPreference, removePreference, listTaboos, addTaboo,
  sampleAffect, affectHistory, affectTrend, softRecall, reviewStats, triggerStats, fallbackStats,
  getCondition, setCondition,
  setCooldown, listCooldowns, cooldownActive,
  budgetGet, budgetSet, budgetConsume,
  executeAction, listActions,
}

export function personaDrift(db, aid) {
  const rows = getPersona(db, aid)
  const changes = db.prepare("SELECT COUNT(*) n FROM changes WHERE agent_id=? AND field LIKE 'persona.%'").get(aid).n
  const tabooViolation = db.prepare("SELECT COUNT(*) n FROM changes WHERE agent_id=? AND (field LIKE '%taboo%' OR after LIKE '%taboo%')").get(aid).n
  const auto = rows.filter((r) => r.origin === 'auto').length
  const manual = rows.filter((r) => r.origin === 'manual').length
  return {
    drift: Math.min(1, changes / 10), auto, manual, taboo_violation: tabooViolation,
    consistency: auto + manual ? +(1 - Math.min(1, Math.abs(auto - manual) / (auto + manual))).toFixed(3) : 1,
  }
}

// ---------------- 规则版本 ----------------
export function listRules(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM rule_versions WHERE agent_id=? ORDER BY version DESC').all(aid)
}

export function saveRuleVersion(db, aid, note = '') {
  active(db, aid)
  const last = db.prepare('SELECT MAX(version) v FROM rule_versions WHERE agent_id=?').get(aid).v || 0
  const id = nid('rul_')
  db.prepare('UPDATE rule_versions SET active=0 WHERE agent_id=?').run(aid)
  db.prepare('INSERT INTO rule_versions VALUES(?,?,?,?,?,?,?)')
    .run(id, aid, last + 1, JSON.stringify(getAllParams(db, aid)), 1, note, now())
  return { id, version: last + 1 }
}

export function activateRuleVersion(db, aid, id) {
  active(db, aid)
  const r = db.prepare('SELECT * FROM rule_versions WHERE id=? AND agent_id=?').get(id, aid)
  if (!r) err(404, 'NOT_FOUND', '版本不存在')
  const params = JSON.parse(r.params)
  writeParams(db, aid, params)
  syncRecallBinding(aid, params)
  db.prepare('UPDATE rule_versions SET active=0 WHERE agent_id=?').run(aid)
  db.prepare('UPDATE rule_versions SET active=1 WHERE id=?').run(id)
  return { id, version: r.version, active: true }
}

export function applyActiveRules(db) {
  const rows = db.prepare('SELECT * FROM rule_versions WHERE active=1 ORDER BY version DESC').all()
  let applied = 0
  for (const r of rows) {
    try {
      const params = JSON.parse(r.params)
      applied += writeParams(db, r.agent_id, params)
      syncRecallBinding(r.agent_id, params)
    } catch { /* 损坏快照跳过 */ }
  }
  return { versions: rows.length, applied }
}

export function backupDrill() {
  const root = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'consciousness', 'backups')
  if (!fs.existsSync(root)) return { ok: false, reason: '没有备份目录', dir: root }
  const files = fs.readdirSync(root).filter((f) => f.endsWith('.db')).sort()
  if (!files.length) return { ok: false, reason: '没有备份文件', dir: root }
  const latest = path.join(root, files[files.length - 1])
  let conn
  try {
    conn = new DatabaseSync(latest, { readOnly: true })
    const check = conn.prepare('PRAGMA integrity_check').get()
    const tables = conn.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
    const memories = conn.prepare('SELECT COUNT(*) n FROM memory_items').get().n
    return { ok: check?.integrity_check === 'ok', file: files[files.length - 1], tables, memories, dir: root }
  } catch (e) {
    return { ok: false, reason: String(e.message || e), file: files[files.length - 1], dir: root }
  } finally {
    try { conn?.close() } catch { /* ignore */ }
  }
}

// ---------------- 自动记忆 ----------------
const NEG_RE = /(?:现在|如今|目前|已经)?我(?:并|其实|真的)?(?:已经)?(?:没有|没|不|不再)(喜欢|养|住|吃|讨厌|会|是)([^，。！？,.!?\s]{1,12})/g
const PAST_RE = /(?:以前|曾经|之前)(?:我)?(养|喜欢|住|吃|讨厌|会|是)(?:过)?([^，。！？,.!?\s]{1,12})/g

/** 过去事实：「我以前养过猫」→ （养, 猫）。只进时间线，不当作现在有效。 */
export function findPastFacts(text) {
  const out = []
  for (const m of String(text || '').matchAll(PAST_RE)) {
    out.push({ verb: m[1], object: m[2], text: '用户以前' + m[1] + '过' + m[2] })
  }
  return out
}

/** 否认/纠正：把「我没养猫」识别成（动词=养, 对象=猫）。 */
export function findNegations(text) {
  const out = []
  for (const m of String(text || '').matchAll(NEG_RE)) {
    out.push({ verb: m[1], object: m[2], negText: '用户' + (m[0].includes('没') ? '没有' : '不') + m[1] + m[2] })
  }
  return out
}

// ---------------- 关系抽取（C4 自动：对话里提到的人 → 关系表） ----------------
const REL_KINDS = ['owner', 'acquaintance', 'stranger']
/** 出现这些线索才值得多调一次模型；普通闲聊不烧 token。 */
const REL_CUE = /(叫|名叫|名字|称呼|师父|师傅|师门|徒弟|妹妹|姐姐|弟弟|哥哥|爸|妈|父母|妻|夫|女儿|儿子|爷爷|奶奶|外公|外婆|朋友|同学|同事|老板|邻居|亲戚)/
const REL_DEFAULTS = { closeness: 0.2, trust: 0.2, dependence: 0 }

/** 测试钩子：替换关系抽取的模型调用 */
export const relationsModelHook = { complete: null }

function clampUnit(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(0.99, n)) : d
}

function recordRelationChange(db, aid, name, before, after) {
  try {
    db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(nid('chg_'), null, aid, 'relations.' + name,
        before ? JSON.stringify(before) : null, JSON.stringify(after), now(), 'system', 'system', 'auto', null, null)
  } catch { /* 记账失败不影响关系本身 */ }
}

/**
 * 从这一轮用户的话里抽「和他有关系的人」，写进关系表。
 * 只新建 + 补注记：已存在的不动数值（尤其 root），分寸交给真实互动去挪。
 * 没接上模型 / 模型只回占位时安静跳过，失败不影响这一轮。
 */
export async function learnRelationsFromTurns(db, aid, turns) {
  const text = (Array.isArray(turns) ? turns : [])
    .filter((t) => (t.role || 'user') === 'user')
    .map((t) => String(t.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 3000)
  if (!text || !REL_CUE.test(text)) return []
  const system = [
    '从这段对话里找出用户明确提到的、和他有关系的人（师傅、妹妹、家人、朋友等），只输出 JSON 对象，不要解释：',
    '{"relations":[{"name":"名字或称呼","kind":"owner|acquaintance|stranger","identity":"师傅/妹妹/朋友","closeness":0.5,"trust":0.5,"dependence":0.2,"notes":"一句话关系说明"}]}',
    '只写对话里明确出现的名字和身份，不要编造；没有就输出 {"relations":[]}；最多 5 条；地址、电话、证件号一律不要写。',
  ].join('\n')
  let raw = ''
  try {
    const req = { system, text }
    raw = relationsModelHook.complete ? await relationsModelHook.complete(req) : await model.complete(req)
  } catch { return [] }
  let parsed = null
  try { parsed = parseJsonLoose(raw) } catch { return [] }
  // 规则适配器的占位回包（overlap）说明没接到真模型：不落任何东西
  if (!parsed || parsed.overlap !== undefined || !Array.isArray(parsed.relations)) return []

  const out = []
  for (const r of parsed.relations.slice(0, 5)) {
    const name = String(r && r.name || '').trim().slice(0, LIMITS.relationName)
    if (!name) continue
    const old = db.prepare('SELECT * FROM relations WHERE agent_id=? AND name=?').get(aid, name)
    if (old && old.root) continue // 主人这条是红线，自动链路不碰
    const identity = String(r.identity || '').trim().slice(0, 24)
    const note = [identity, String(r.notes || '').trim()].filter(Boolean).join('：').slice(0, 200)
    try {
      if (old) {
        if (note && !String(old.notes || '').includes(note)) {
          const merged = [String(old.notes || '').trim(), note].filter(Boolean).join('；').slice(0, 200)
          upsertRelation(db, aid, { id: old.id, name, notes: merged })
          recordRelationChange(db, aid, name, { notes: old.notes }, { notes: merged, why: text.slice(0, 50) })
        }
        out.push({ name, created: false })
        continue
      }
      const row = {
        kind: REL_KINDS.includes(r.kind) ? r.kind : 'acquaintance',
        closeness: clampUnit(r.closeness, REL_DEFAULTS.closeness),
        trust: clampUnit(r.trust, REL_DEFAULTS.trust),
        dependence: clampUnit(r.dependence, REL_DEFAULTS.dependence),
        notes: note || null,
      }
      const { id } = upsertRelation(db, aid, { name, ...row })
      recordRelationChange(db, aid, name, null, { ...row, id, why: text.slice(0, 50) })
      out.push({ name, created: true })
    } catch { /* 单条失败不影响其余 */ }
  }
  return out
}

/** 今天已经写了多少条「我自己」——按本地日界算，和她的「今天」一致。
 *  冷层不算：那几条退到深查层了，不该占平常的名额。 */
export function selfCountToday(db, aid, at = Date.now()) {
  try {
    const d = new Date(at)
    d.setHours(0, 0, 0, 0)
    const since = d.toISOString()
    return Number(db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='self' AND created_at>=? AND (temp_state IS NULL OR temp_state<>'cold')")
      .get(aid, since).n || 0)
  } catch { return 0 }
}

/** 这一小段时间还能留几条：别让早上的话把一整天的额度一次用完。 */
export function selfWindowState(db, aid, at = Date.now()) {
  try {
    const winH = Math.max(1, Math.min(24, Number(getParam(db, aid, 'self.window_hours')) || 3))
    const dayCap = selfQuotaToday(db, aid, at)
    const want = Math.max(1, Number(getParam(db, aid, 'self.per_window')) || Math.ceil(dayCap / 4))
    const cap = Math.max(1, Math.min(30, want))
    const since = new Date(at - winH * 3600 * 1000).toISOString()
    const n = Number(db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='self' AND created_at>=? AND (temp_state IS NULL OR temp_state<>'cold')")
      .get(aid, since).n || 0)
    return { cap, winH, used: n, left: Math.max(0, cap - n) }
  } catch { return { cap: 2, winH: 3, used: 0, left: 2 } }
}

/** 当天额度：安静的日子保底，聊得多、被挡得多就往上浮。
 *  缓存一小时，别每写一句都数一遍事件。 */
const quotaCache = new Map()
export function selfQuotaToday(db, aid, at = Date.now()) {
  try {
    const auto = String(getParam(db, aid, 'self.quota.auto') || 'on') !== 'off'
    const base = Math.max(1, Math.min(30, Number(getParam(db, aid, 'self.quota.base')) || 4))
    const max = Math.max(base, Math.min(40, Number(getParam(db, aid, 'self.quota.max')) || 16))
    if (!auto) return Math.max(1, Math.min(30, Number(getParam(db, aid, 'self.per_day')) || 8))
    const hourKey = Math.floor(at / 3600000)
    const hit = quotaCache.get(aid)
    if (hit && hit.hour === hourKey) return hit.quota
    const d = new Date(at)
    d.setHours(0, 0, 0, 0)
    const since = d.toISOString()
    const turns = Number(db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='chat.turn' AND created_at>=?").get(aid, since).n || 0)
    const blocked = Number(db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type IN ('memory.self_rejected','memory.self_cold') AND created_at>=?").get(aid, since).n || 0)
    const q = Math.round(base + turns / 15 + blocked / 25)
    const quota = Math.max(base, Math.min(max, q))
    quotaCache.set(aid, { hour: hourKey, quota })
    return quota
  } catch { return 8 }
}

/** 按分量换人：拿当天冷层里分最高的，跟热层里分最低的比，差够了才换。
 *  每 3 小时跑一次（由 ingest 顺带触发），单次最多换两条，防一天大搬家。 */
export function settleSelfHot(db, aid, at = Date.now()) {
  try {
    if (String(getParam(db, aid, 'self.settle') || 'on') === 'off') return { moved: 0, skipped: 'off' }
    const d = new Date(at)
    d.setHours(0, 0, 0, 0)
    const since = d.toISOString()
    const gap = Math.max(0.05, Math.min(0.5, Number(getParam(db, aid, 'self.settle.gap')) || 0.15))
    const maxMove = Math.max(1, Math.min(3, Number(getParam(db, aid, 'self.settle.max_move')) || 2))
    const base = "FROM memory_items WHERE agent_id=? AND source='self' AND status='active' AND deleted_at IS NULL AND created_at>=?"
    const cold = db.prepare('SELECT id,text,importance ' + base + " AND temp_state='cold' ORDER BY importance DESC, created_at ASC LIMIT ?").all(aid, since, maxMove)
    const hot = db.prepare('SELECT id,text,importance ' + base + " AND (temp_state IS NULL OR temp_state IN ('hot','warm')) ORDER BY importance ASC, created_at ASC LIMIT ?").all(aid, since, maxMove)
    let moved = 0
    const used = new Set()
    for (const c of cold) {
      const h = hot.find((x) => !used.has(x.id))
      if (!h) break
      const up = Number(c.importance) || 0
      const down = Number(h.importance) || 0
      if (up - down <= gap) break
      setMemoryTemp(db, h.id, 'cold', now())
      setMemoryTemp(db, c.id, 'hot', now())
      used.add(h.id)
      moved++
      try { event(db, aid, 'memory.self.settle', { up: c.id, down: h.id, up_score: up, down_score: down }) } catch { /* 忽略 */ }
    }
    return { moved, cold: cold.length, hot: hot.length, gap }
  } catch { return { moved: 0, error: true } }
}

const lastSettle = new Map()
/** ingest 里顺带触发：不到间隔就不跑，别每轮都算一遍。 */
function maybeSettleSelf(db, aid, at = Date.now()) {
  try {
    if (String(getParam(db, aid, 'self.settle') || 'on') === 'off') return
    const every = Math.max(1, Math.min(24, Number(getParam(db, aid, 'self.settle.every_hours')) || 3))
    const last = Number(lastSettle.get(aid) || 0)
    if (at - last < every * 3600 * 1000) return
    lastSettle.set(aid, at)
    settleSelfHot(db, aid, at)
  } catch { /* 结算失败不影响这一轮 */ }
}

/** 判过的话记在内存里：同一句被反复抽出来时不重问模型。进程重启就清空，只当省调用。 */
const selfJudgedCache = new Map()
function selfJudgeKey(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').slice(0, 200).toLowerCase()
}

/** 落冷层：addMemory 的 cold 分支在「撞到重复、改走合并」时不会生效，这里补一刀。 */
function forceCold(db, id) {
  if (!id) return
  try {
    setMemoryTemp(db, id, 'cold', now(), { onlyIfChanged: true })
  } catch { /* 老库没温度列就当热的 */ }
}

/**
 * 一条抽出来的记忆落库（P0 / P1 共用）。
 *
 * 三件事在这里一次做完：
 *   1) 旁白闸：主语是「用户 / 对方 / 助手」的转述句不丢，落冷层——它是真事实，
 *      只是不该冒充「我记得的事」；S2/S3 深查仍捞得到，confidence 也压低。
 *   2) 写入门控：新增 / 合并 / 冲突 / 丢弃 由 applyWrite 判，这条函数只管「怎么落」。
 *   3) 合并进旧条时 addMemory 那条路没走，冷层要单独补一次。
 */
export function writeExtractedItem(db, aid, m, opt = {}) {
  const text = String((m && m.text) || '').trim()
  if (!text) return { action: 'drop', reason: 'empty' }
  // ---- P1 她自己的车道 ----
  if (String((m && m.who) || '') === 'self') {
    if (String(getParam(db, aid, 'memory.write.self') || 'on') === 'off') return { action: 'drop', reason: 'self_off' }
    /* 三档：ok 直接留；drop 明显不要；unsure 交给调用方先问模型（opt.selfDecision）。
       判不了 / 模型超时 / 没配额 → 落冷层，不丢：丢掉的话，那件事就真没了。 */
    const cls = classifySelf(text)
    const body = cls.text || text
    // 场景分：规则分打底；拿不准的让模型补一句（六成规则、四成模型），只有模型给了分才混。
    const ruleScore = scoreSelf(body)
    const modelHay = typeof opt.selfDecision === 'function' ? opt.selfDecision(text) : null
    const modelScore = modelHay && Number.isFinite(Number(modelHay.score)) ? Number(modelHay.score) : null
    const score = Math.max(0.05, Math.min(0.95, modelScore == null ? ruleScore : ruleScore * 0.6 + modelScore * 0.4))
    let verdict
    if (cls.tier === 'ok') verdict = { keep: true }
    else if (cls.tier === 'drop') verdict = { keep: false, cold: !!cls.cold, why: cls.why }
    else {
      if (modelHay && modelHay.keep === true) verdict = { keep: true }
      else if (modelHay && modelHay.keep === false) verdict = { keep: false, cold: true, why: 'model' }
      else verdict = { keep: false, cold: true, why: cls.why } // 没判：留冷层，可回查
    }
    // 按分量选人：低分的不占热层名额，直接落冷（还能结算上来）。
    const admission = String(getParam(db, aid, 'self.admission') || 'time')
    const minScore = Math.max(0, Math.min(1, Number(getParam(db, aid, 'self.admission.min_score')) || 0.35))
    if (verdict.keep && admission === 'score' && score < minScore) {
      verdict = { keep: false, cold: true, why: 'low_score' }
    }
    if (!verdict.keep) {
      try { event(db, aid, 'memory.self_rejected', { reason: 'gate', why: verdict.why, score, len: body.length, head: body.slice(0, 40) }) } catch { /* 事件失败不影响写入 */ }
      let id = null
      if (verdict.cold) {
        try {
          const row = addMemory(db, aid, {
            text: body, type: 'episode', mark: (m && m.mark) || 'normal',
            source: 'self', confidence: 0.5, importance: score, cold: true, turn_id: opt.turnId || null,
          })
          id = row && row.id
          forceCold(db, id)
          try { event(db, aid, 'memory.self_cold', { why: verdict.why, score, head: body.slice(0, 40) }) } catch { /* 忽略 */ }
        } catch { /* 冷层写失败就当没写 */ }
      }
      return { action: 'drop', reason: 'self_gate', cold: !!id, id, score }
    }
    // 配额两道：一天总量（跟着实际浮动）+ 每窗口量。超了落冷，不丢。
    // 为什么分软硬：日额度是「今天大概记几条」的目标，不是硬闸——硬闸是窗口（每 3 小时 2 条），
    // 否则早上写满 6 条，下午再想到什么都进不来。auto 关掉时回到旧的硬日闸。
    const dayCap = selfQuotaToday(db, aid)
    const win = selfWindowState(db, aid)
    const usedToday = selfCountToday(db, aid)
    const autoOn = String(getParam(db, aid, 'self.quota.auto') || 'on') !== 'off'
    const hardMax = Math.max(dayCap, Math.min(40, Number(getParam(db, aid, 'self.quota.max')) || 16))
    const dayLimit = (admission === 'score' && autoOn) ? hardMax : dayCap
    const bypass = Math.max(0, Math.min(1, Number(getParam(db, aid, 'self.admission.bypass_score')) || 0.7))
    const allowBypass = admission === 'score' && score >= bypass && usedToday < hardMax + 2
    if ((usedToday >= dayLimit || win.left <= 0) && !allowBypass) {
      const reason = usedToday >= dayLimit ? 'per_day' : 'per_window'
      // 带上头部：不然「被上限挡掉的是流水账还是真事」永远答不上来（体检脚本要用）。
      try { event(db, aid, 'memory.self_rejected', { reason, cap: dayCap, window_hours: win.winH, score, len: body.length, head: body.slice(0, 40) }) } catch { /* 事件失败不影响写入 */ }
      let id = null
      try {
        const row = addMemory(db, aid, {
          text: body, type: 'episode', mark: (m && m.mark) || 'normal',
          source: 'self', confidence: 0.5, importance: score, cold: true, turn_id: opt.turnId || null,
        })
        id = row && row.id
        forceCold(db, id)
        try { event(db, aid, 'memory.self_cold', { why: reason, score, head: body.slice(0, 40) }) } catch { /* 忽略 */ }
      } catch { /* 冷层写失败就当没写 */ }
      return { action: 'cold', reason: 'self_' + reason, cold: true, id, score }
    }
    if (allowBypass && (usedToday >= dayCap || win.left <= 0)) {
      try { event(db, aid, 'memory.self.bypass', { score, cap: dayCap, used: usedToday, head: body.slice(0, 40) }) } catch { /* 忽略 */ }
    }
    const row = addMemory(db, aid, {
      text: body, type: 'episode', mark: (m && m.mark) || 'normal',
      source: 'self', confidence: 0.75, importance: score, turn_id: opt.turnId || null,
    })
    return { action: row && row.duplicate ? 'merge' : 'new', id: row && row.id, self: true, score }
  }
  const type = (m && m.type) || 'fact'
  const seedFn = typeof opt.seed === 'function' ? opt.seed : (t, ty) => seedScores(t, ty, 0)
  const ent = (() => { try { return entityForText(db, aid, text) } catch { return null } })()
  const narr = narrationOnly(text)
  // 这个 key 要同时喂给两层：gate 的判定读 cand.fact_key（决定「同 key 原地改写」），
  // addMemory 的落库读 cand.key / cand.fact_key。以前只传了 key，门控拿到的 factKey 永远空，
  // 「同 key 更新」分支在提取路径上从没生效过——旧条全靠 addMemory 的 supersedeByKey 兜底。
  const factKey = String((m && (m.key || m.fact_key)) || '').trim()
  const out = applyWrite(db, aid, {
    text, entity_id: ent ? ent.id : null, fact_key: factKey, key: factKey, terms: (m && m.terms) || [],
  }, (cand) => addMemory(db, aid, {
    text: cand.text, type, mark: (m && m.mark) || 'normal',
    entity_id: cand.entity_id || null, source: 'extract', confidence: narr ? 0.5 : 0.7,
    cold: narr, turn_id: opt.turnId || null, ...seedFn(cand.text, type),
    fact_key: cand.fact_key || cand.key || '', terms: cand.terms || [],
  }))
  if (narr && out.id && out.action !== 'new') {
    try {
      setMemoryTemp(db, out.id, 'cold', now(), { onlyIfChanged: true })
    } catch { /* 老库没有温度列就算了 */ }
  }
  return out
}

export async function ingest(db, aid, body) {
  active(db, aid)
  const turns = Array.isArray(body.turns) ? body.turns : []
  if (!turns.length) err(400, 'INVALID_ARGUMENT', 'turns 不能为空')
  // 这一批记忆出生时的情绪强度：抽取是异步的，但评价在收到消息那一轮就落过
  // 一条 affect_episodes（按原话匹配）；匹配不上就用当前情绪兜底。
  const lastUserText = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if ((turns[i].role || 'user') !== 'agent') return String(turns[i].text || '')
    }
    return ''
  })()
  const turnSalience = (() => {
    try {
      const ep = db.prepare('SELECT intensity FROM affect_episodes WHERE agent_id=? AND cause=? ORDER BY started_at DESC LIMIT 1').get(aid, lastUserText)
      if (ep) return Math.max(0, Math.min(1, Number(ep.intensity) || 0))
    } catch { /* 老库没这张表就退回当前情绪 */ }
    try { return Math.max(0, Math.min(1, Number(getAffect(db, aid).intensity) || 0)) } catch { return 0 }
  })()
  const seed = (text, type) => seedScores(text, type, turnSalience)
  // 这一批的出处。turn_id 由 captureTurn 生成、入队时带上，一路传到 addMemory；
  // memory_items.source_turn_id 存它，「这条记忆是哪一轮说的」才 join 得回 raw_turns。
  const batchTurnId = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i] && turns[i].turnId
      if (t) return String(t)
    }
    return null
  })()
  // 纠正：先让被否认的旧条时效（双时间失效），再落一条「否认」事实
  let invalidated = 0
  for (const t of turns) {
    if ((t.role || 'user') !== 'user') continue
    // ① 过去事实：落一条时间线记录，然后立刻标失效（它只在历史里成立）
    const pasts = findPastFacts(t.text || '')
    for (const pf of pasts) {
      try {
        const r = addMemory(db, aid, { text: pf.text, type: 'fact', mark: 'normal', turn_id: batchTurnId, ...seed(pf.text, 'fact') })
        if (r && r.id) invalidateMemory(db, aid, r.id, { clearValidAt: true, reason: 'past_fact', actor: 'extract' })
      } catch { /* 忽略 */ }
    }
    // ② 同一句里「现在没了 / 现在不养了」：借过去事实的对象补一条现状否认
    const cur = String(t.text || '')
    if (pasts.length && /(现在|如今|目前).{0,4}(没|不|没有)/.test(cur) && !findNegations(cur).length) {
      const pf = pasts[0]
      const rows0 = db.prepare("SELECT id,text FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND text LIKE ?").all(aid, '%' + pf.object + '%')
      for (const r0 of rows0) {
        if (!String(r0.text).includes(pf.verb)) continue
        if (/没有|不/.test(String(r0.text))) continue // 已经是否定句
        invalidateMemory(db, aid, r0.id, { reason: 'negation', actor: 'extract' })
        invalidated++
      }
      try { addMemory(db, aid, { text: '用户现在没有' + pf.verb + pf.object, type: 'fact', mark: 'normal', turn_id: batchTurnId, ...seed('用户现在没有' + pf.verb + pf.object, 'fact') }) } catch { /* 忽略 */ }
      continue
    }
    if ((t.role || 'user') !== 'user') continue
    for (const n of findNegations(t.text || '')) {
      const rows = db.prepare("SELECT id,text FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND text LIKE ?").all(aid, '%' + n.object + '%')
      for (const r of rows) {
        if (!String(r.text).includes(n.verb)) continue
        if (/没有|不/.test(String(r.text))) continue // 已经是否定句，不用再失效
        invalidateMemory(db, aid, r.id, { reason: 'negation', actor: 'extract' })
        invalidated++
      }
      try { addMemory(db, aid, { text: n.negText, type: 'fact', mark: 'normal', turn_id: batchTurnId, ...seed(n.negText, 'fact') }) } catch { /* 忽略 */ }
    }
  }

  // 她这一轮做过什么：assistant 的回话 + 工具痕迹，作为 who="self" 的材料。
  // 没有材料就不传——没材料时模型只会写旁白，不如不写。
  const selfMaterial = (() => {
    const bits = []
    for (const t of turns) {
      if (!t) continue
      const role = String(t.role || 'user')
      const text = String(t.text || '').trim()
      if (role === 'assistant' && text) bits.push('我回了：' + text.slice(0, 200))
      const tools = Array.isArray(t.tools) ? t.tools : (Array.isArray(t.toolCalls) ? t.toolCalls : null)
      for (const x of tools || []) {
        const name = String((x && (x.name || x.tool || x.title)) || '').trim()
        if (name) bits.push('我用过：' + name.slice(0, 60))
      }
    }
    return bits.join('\n').slice(0, 800)
  })()
  const extracted = await model.extract(turns, { selfMaterial })
  const written = []
  const newPairs = [] // 这一轮真正新落库的条目：{text, id}，开环从它们里长
  const actions = { new: 0, merge: 0, conflict: 0, drop: 0 }
  /* 拿不准的自我条目：一次问模型，别一条一调。
     缓存按文本：同一句话被反复抽出来时不重问；模型没判 / 超时 → writeExtractedItem 落冷层。 */
  const selfDecision = await (async () => {
    try {
      if (String(getParam(db, aid, 'memory.write.self.judge') || 'on') === 'off') return () => null
      const unsure = []
      for (const m of extracted) {
        if (String((m && m.who) || '') !== 'self') continue
        const t = String((m && m.text) || '').trim()
        if (!t) continue
        if (classifySelf(t).tier !== 'unsure') continue
        const key = selfJudgeKey(t)
        if (selfJudgedCache.has(key)) continue
        if (!unsure.includes(key)) unsure.push(key)
      }
      if (!unsure.length) return (t) => { const k = selfJudgeKey(t); const v = selfJudgedCache.get(k); return v ? { keep: v.keep, score: v.score } : null }
      if (!(model.capabilities && model.capabilities().chat)) return () => null
      const dayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString() })()
      let judgedToday = 0
      try {
        const row = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='memory.self.judge' AND created_at>=?").all(aid, dayStart)
        for (const r of row) { try { judgedToday += Number(JSON.parse(r.payload || '{}').n) || 0 } catch { /* 忽略 */ } }
      } catch { judgedToday = 0 }
      const budget = Math.max(0, Number(getParam(db, aid, 'memory.write.self.judge.per_day')) || 60)
      const batch = unsure.slice(0, Math.max(0, budget - judgedToday))
      if (!batch.length) return () => null
      const t0 = Date.now()
      let got = null
      try {
        const context = turns.filter((t) => String(t.role || '') === 'assistant').map((t) => String(t.text || '')).join('\n').slice(-400)
        got = await model.judgeSelf(batch, { context })
      } catch { got = null }
      const ms = Date.now() - t0
      if (got && Array.isArray(got.keep)) {
        const keepN = got.keep.filter(Boolean).length
        let scoreSum = 0
        batch.forEach((text, i) => {
          const keep = !!got.keep[i]
          const score = Number.isFinite(Number(got.score && got.score[i])) ? Number(got.score[i]) : (keep ? 0.6 : 0.3)
          scoreSum += score
          selfJudgedCache.set(text, { keep, score })
          if (selfJudgedCache.size > 400) selfJudgedCache.delete(selfJudgedCache.keys().next().value)
        })
        try { event(db, aid, 'memory.self.judge', { n: batch.length, keep: keepN, drop: batch.length - keepN, avg_score: Math.round(scoreSum / batch.length * 100) / 100, ms }) } catch { /* 忽略 */ }
      } else {
        try { event(db, aid, 'memory.self.judge', { n: batch.length, failed: true, ms }) } catch { /* 忽略 */ }
      }
      return (t) => { const k = selfJudgeKey(t); const v = selfJudgedCache.get(k); return v ? { keep: v.keep, score: v.score } : null }
    } catch { return () => null }
  })()
  for (const m of extracted) {
    try {
      const out = writeExtractedItem(db, aid, m, { turnId: batchTurnId, seed, selfDecision })
      actions[out.action] = (actions[out.action] || 0) + 1
      written.push(out)
      if (out.action === 'new' && out.id) newPairs.push({ text: String(m.text || ''), id: out.id })
    } catch { /* 单条失败不影响整轮 */ }
  }
  // 按分量换人：到点才跑（默认 3 小时一次），别每轮都搬。
  try { maybeSettleSelf(db, aid) } catch { /* 结算失败不影响这一轮 */ }
  // 开环：答应过的 / 还没做完的，单独挂一张表。它不走召回打分，
  // 由时间（到期 / 两天没提）决定什么时候自己浮上来。
  // 只从**用户原话**里长：记忆条目常是第三人称转述（「用户正在检查…」「阶段 2 通过了…」），
  // 拿它判开环会把技术讨论挂成待办，然后每轮提醒一次。
  let loops = { opened: 0, closed: 0 }
  try {
    const memByText = new Map(newPairs.map((p) => [String(p.text || ''), p.id]))
    for (const t of turns) {
      if ((t.role || 'user') !== 'user') continue
      const ut = String(t.text || '').trim()
      if (!ut) continue
      const d = detectLoop(ut)
      if (!d) continue
      const r = addLoop(db, aid, { text: ut.slice(0, 200), memory_id: memByText.get(ut) || null, source_turn_id: t.turnId || null, ...d })
      if (r.created) loops.opened++
    }
    // 用户说「好了 / 搞定了」：把刚提过的那条关掉（只认两小时内浮现过的）
    loops.closed = settleLoopsFromUser(db, aid, turns)
    // 提满 5 次还没解决：自动收掉，不再念叨
    expireLoops(db, aid)
  } catch { /* 开环失败不影响这一轮落库 */ }
  // 检索卡：新写入的事实后台补一次「以后可能被怎么问」。
  // 不 await、失败静默——卡片只影响检索，不能拖住这轮回复；没有模型时自动跳过。
  const freshIds = written.filter((x) => x.action === 'new' && x.id).map((x) => x.id).slice(0, 8)
  if (freshIds.length) {
    const timer = setTimeout(() => {
      ;(async () => {
        for (const id of freshIds) { try { await enrichOne(db, aid, id) } catch { /* 单条失败跳过 */ } }
      })()
    }, 0)
    if (timer.unref) timer.unref()
  }
  // 关系：这一轮里提到的师傅 / 妹妹 / 朋友等，让模型抽一次，按名字合并落库
  let relate = []
  try { relate = await learnRelationsFromTurns(db, aid, turns) } catch { relate = [] }

  // 摘要要不要进 T1（事实区）。默认 off（见 kernel.js）：关掉后摘要不落库。
  // 为什么要有这个开关：每轮一条「用户事实 / 用户偏好」的第三人称旁白，
  // 久了会把记忆库占满（线上 72% 是它），于是「我记住的」全是「用户关心什么」。
  // 关掉时连这次 summarize 调用也不发——否则每轮白叫一次模型，结果直接扔掉。
  const summaryToT1 = String(getParam(db, aid, 'memory.write.summary_to_t1') || 'off') !== 'off'
  const rawSummary = summaryToT1 ? String((await model.summarize(turns)) || '').slice(0, 600) : ''
  const summary = looksLikeRuntimeNoise(rawSummary) ? '' : rawSummary
  const transcriptShaped = /^\s*(user|assistant)\s*[:：]/i.test(summary) || (summary.match(/\n\s*(user|assistant)\s*[:：]/gi) || []).length >= 1
  let reflectGate = null
  if (summaryToT1 && summary && !transcriptShaped && summary.length <= 200) {
    // 写入侧闸门（P4）：重要度不再只看关键词，先让模型判一句。
    // 关键词分 ≥0.9 的（明显是边界/禁忌/承诺）不浪费一次调用；其余问模型。
    const seeded = seed(summary, 'reflection')
    let imp = seeded.importance
    let keep = true
    let judged = false
    const judgeOn = String(getParam(db, aid, 'memory.write.reflect_judge') || 'on') !== 'off'
    if (judgeOn && Number(seeded.importance) < 0.9 && canJudge()) {
      const j = await judgeReflection(summary)
      if (j) { imp = j.importance == null ? imp : j.importance; keep = j.keep !== false; judged = true }
    }
    // 门槛只在「真拿到模型判断」时才生效：没有模型 / 超时 → 保持原来那条路，不会把所有摘要都打进冷宫。
    const floor = Math.max(0, Math.min(1, Number(getParam(db, aid, 'memory.write.reflect_floor')) || 0.7))
    const cold = judged && keep && imp < floor
    reflectGate = { importance: imp, keep, floor, judged, stored: keep ? (cold ? 'cold' : 'T1') : 'dropped' }
    if (keep) {
      try {
        addMemory(db, aid, {
          text: summary, type: 'reflection', mark: 'normal',
          importance: imp, salience: seeded.salience,
          cold, source: 'summary', confidence: 0.6, turn_id: batchTurnId,
        })
      } catch { /* 忽略 */ }
    } else {
      try { event(db, aid, 'memory.reflect_dropped', { len: summary.length }) } catch { /* 事件失败不影响写入 */ }
    }
  }
  // 反思游标：这一窗新记忆的 importance 累计。过阈值 = 流水账攒够了，
  // 后台压一条结论（只压 importance < 0.5 的，身份 / 偏好 / 承诺不吞）。
  let reflect = null
  try {
    let accAdd = 0
    const ids = newPairs.map((x) => x.id)
    if (ids.length) {
      const ph = ids.map(() => '?').join(',')
      const rows = db.prepare(`SELECT importance FROM memory_items WHERE id IN (${ph})`).all(...ids)
      for (const r of rows) accAdd += Math.max(0, Math.min(1, Number(r.importance) || 0))
    }
    const acc = bumpReflect(db, aid, accAdd)
    const need = Math.max(0.5, Math.min(50, Number(getParam(db, aid, 'memory.reflect.acc')) || 5))
    reflect = { acc: Math.round(acc * 100) / 100, need, fired: acc >= need }
    if (acc >= need && canConsolidate()) {
      // 不 await：反思是后台活，不能拖住这一轮回复；夜间巩固还会补跑一次。
      const timer = setTimeout(() => { reflectFrom(db, aid).catch(() => {}) }, 0)
      if (timer.unref) timer.unref()
    }
  } catch { reflect = null }
  // 嘀咕：与 fact / episode / appraisal / reflection 平级的「观测层」产物——
  // 专用一次模型调用，只给人看，不进 memory_items / 检索。关 ui.mutter.enabled 则跳过。
  let mutter = null
  if (getParam(db, aid, 'ui.mutter.enabled') !== false) {
    try {
      mutter = await writeMutter(db, aid, turns)
    } catch { mutter = null }
  }
  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(now(), aid)
  return { extracted: extracted.length, written: written.length, actions, summary, invalidated, relations: relate.length, relation_names: relate.map((r) => r.name), reflect_gate: reflectGate, loops, reflect, mutter, model: model.status() }
}

/**
 * 存量检索卡回填：在插件进程内跑，直接用宿主 llm（脚本跑不到宿主上下文）。
 * 一次最多 30 条，前端 / 运维可以循环调用；没有模型时返回 done=0、can=false。
 */
export async function backfillCards(db, aid, body = {}) {
  const limit = Math.max(1, Math.min(30, Number(body.limit) || 10))
  const done = await enrichPending(db, aid, { limit })
  const left = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND (terms IS NULL OR terms='')").get(aid).n
  return { done, left, can: canEnrich() }
}

// ---------------- 指标 ----------------
function pct(a, b) { return b ? +(a / b).toFixed(3) : null }
export function recordMetric(db, aid, key, value) {
  if (value == null || !Number.isFinite(Number(value))) return
  db.prepare('INSERT INTO metric_samples VALUES(?,?,?,?,?)').run(nid('mts_'), aid, key, Number(value), now())
}

function avgMetric(db, aid, key) {
  const r = db.prepare('SELECT AVG(value) v FROM metric_samples WHERE agent_id=? AND key=?').get(aid, key)
  return r && r.v != null ? +Number(r.v).toFixed(3) : null
}

export function computeMetrics(db, aid) {
  agent(db, aid)
  // 注入 token 用宿主真实采样（sys.inject_tokens，≤800 预算）；不再拿全库记忆折算量冒充。
  const inject = db.prepare("SELECT value FROM metric_samples WHERE agent_id=? AND key='sys.inject_tokens' ORDER BY rowid DESC LIMIT 1").get(aid)
  const conflicts = db.prepare("SELECT COUNT(*) n FROM conflicts WHERE agent_id=? AND state='open'").get(aid).n
  const proposals = db.prepare("SELECT COUNT(*) n FROM proposals WHERE agent_id=? AND state NOT IN ('draft','promoted','expired','rejected')").get(aid).n
  const committed = db.prepare("SELECT COUNT(*) n FROM proposals WHERE agent_id=? AND state IN ('committed','settled','rolled_back')").get(aid).n
  const settled = db.prepare("SELECT COUNT(*) n FROM proposals WHERE agent_id=? AND state IN ('committed','settled')").get(aid).n
  const rolled = db.prepare("SELECT COUNT(*) n FROM proposals WHERE agent_id=? AND state='rolled_back'").get(aid).n
  const changes = db.prepare('SELECT * FROM changes WHERE agent_id=?').all(aid)
  const audit = changes.length ? pct(changes.filter((c) => c.actor && c.applied_at && c.before != null && c.after != null).length, changes.length) : null
  const revertible = changes.length ? pct(changes.filter((c) => c.before != null && c.after != null).length, changes.length) : null

  let bandSwitch = 0
  try {
    const evs = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='drive.evaluated' ORDER BY rowid").all(aid)
    let last = null
    for (const e of evs) {
      const p = JSON.parse(e.payload || '{}')
      if (last && p.band && p.band !== last) bandSwitch++
      if (p.band) last = p.band
    }
  } catch { /* 旧事件无 payload */ }

  let ok = 1
  try { ok = db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok' ? 1 : 0 } catch { ok = 0 }

  // 缺口基线误差：平滑基线 ñ 对瞬时缺口 n 的一步预测残差（控制论里的设定点跟踪）。
  // 之前这个指标只在目录里登记、没人算，验收页永远显示 —。
  let baselineError = null
  try {
    const dr = getDrive(db, aid)
    const raw = dr.raw || {}
    const smooth = dr.smooth || dr.deficits || {}
    const keys = Object.keys(smooth).filter((k) => raw[k] != null)
    if (keys.length) {
      const sum = keys.reduce((s, k) => s + Math.abs(Number(smooth[k]) - Number(raw[k])), 0)
      baselineError = +(sum / keys.length).toFixed(3)
    }
  } catch { /* 没有驱力数据 */ }

  const evals = computeEvalMetrics(db, aid)
  // 读你准不准：只看你亲手纠正过的那些条；没纠正过就是 null，不编 0
  let readAccuracy = null
  try {
    const reads = db.prepare('SELECT guess_label, actual_label FROM affect_user_read WHERE agent_id=?').all(aid)
    if (reads.length) readAccuracy = +(reads.filter((r) => r.guess_label === r.actual_label).length / reads.length).toFixed(3)
  } catch { /* 老库没有这张表 */ }
  const c3 = db.prepare("SELECT COUNT(*) n FROM proposals WHERE agent_id=? AND change_class='C3'").get(aid).n
  const c3Shadow = db.prepare("SELECT COUNT(*) n FROM proposals WHERE agent_id=? AND change_class='C3' AND shadow_total>0").get(aid).n

  return {
    'memory.core_token': inject && inject.value != null ? +Number(inject.value).toFixed(0) : null,
    'memory.conflict': conflicts,
    'memory.cross_session': null,
    'memory.recall_hit': evals['memory.recall_hit'] ?? avgMetric(db, aid, 'memory.recall_hit'),
    'memory.ndcg5': evals['memory.ndcg5'] ?? avgMetric(db, aid, 'memory.ndcg5'),
    'memory.false_recall': evals['memory.false_recall'],
    'memory.time_consistency': null,
    'self.pass_rate': pct(settled, proposals),
    'self.rollback_rate': pct(rolled, committed),
    'self.audit_complete': audit,
    'self.revertible': revertible,
    'self.shadow_coverage': c3 ? pct(c3Shadow, c3) : 1,
    'sys.crash_recovery': ok,
    'sys.inject_latency': evals['sys.inject_latency_p95'] ?? avgMetric(db, aid, 'sys.inject_latency'),
    'sys.cache_hit': null,
    'drive.band_switch': bandSwitch,
    'drive.baseline_error': baselineError,
    'drive.proactive_answer': pct(db.prepare('SELECT COUNT(*) n FROM proactive WHERE agent_id=? AND answered=1').get(aid).n,
      db.prepare('SELECT COUNT(*) n FROM proactive WHERE agent_id=?').get(aid).n),
    'affect.label_kappa': evals['affect.label_kappa'],
    'affect.intensity_mae': evals['affect.intensity_mae'],
    'affect.read_accuracy': readAccuracy,
    'persona.identity_blind': evals['persona.identity_blind'],
    'persona.value_drift': evals['persona.value_drift'],
    'exp.first_screen': null,
    'exp.two_clicks': null,
    'exp.trust_score': null,
  }
}

/** 最近两句用户话（不含当前这句）：短句要靠上下文才判得准（「我真是服了」） */
function recentUserContext(db, aid, text) {
  try {
    const cur = String(text || '').trim()
    const rows = db.prepare("SELECT text FROM chat_turns WHERE agent_id=? AND role='user' ORDER BY at DESC LIMIT 8").all(aid)
    const out = []
    for (const r of rows) {
      const t = String(r.text || '').trim()
      if (!t || t === cur || out.includes(t)) continue
      out.push(t)
      if (out.length >= 2) break
    }
    return out.reverse().join('\n')
  } catch { return '' }
}

/** 编排层：注入关系边偏置后再评价 */
export async function appraiseWithEdges(db, aid, text) {
  const axes = readAxes(db, aid)
  const mode = String(getParam(db, aid, 'persona.axes.mode') || 'on')
  // 关系偏置：优先读人物账本（rel_person），退回旧表
  let ownerClose = 0.5
  let ownerTrust = 0.5
  try {
    const p = ownerPerson(db, aid) || personByChannel(db, aid)
    if (p) {
      ownerClose = Number(p.closeness)
      ownerTrust = Number(p.trust)
    } else {
      const rels = listRelations(db, aid)
      const owner = rels.find((r) => r.root || r.name === '主人')
      if (owner) {
        ownerClose = Number(owner.closeness)
        ownerTrust = Number(owner.trust)
      }
    }
  } catch { /* */ }
  let load = 0
  try { load = Number(getCondition(db, aid).load || 0) } catch { /* */ }
  let arousal = 0
  try { arousal = Number(getAffect(db, aid).arousal || 0) } catch { /* */ }
  const edges = resolveStructureEdges(db, aid)
  // 模型评价只调一次：既给 S 用，也原样传下去，避免为算门槛再调一遍。
  // 口径由 affect.appraise.formula 决定：v1=旧（任务相关性），concern=关切（P1）。
  let hint = null
  const appraiseFormula = String(getParam(db, aid, 'affect.appraise.formula') || 'v1')
  try { hint = await kernelModel.appraise(text, appraiseFormula, recentUserContext(db, aid, text)) } catch { hint = null }
  const appraisalForS = hint && hint.label ? hint : rulesAppraise(text)
  const edgeBias = computeEdgeBias({
    sigma: axes.sensitivity, axes, text, appraisal: appraisalForS, mode,
    ownerCloseness: ownerClose, ownerTrust, load, arousal, edges,
    conditionCoef: Number(getParam(db, aid, 'condition.coef')) || 2.5,
  })
  const res = await appraise(db, aid, text, { edgeBias, labels: affectLabels(db, aid), hint, closeness: ownerClose, formula: appraiseFormula })
  // 影子期：把「本来会是多少」采样一次，不生效；切 on 之后不再采样
  try {
    if (mode === 'shadow' && edgeBias.shadowIntensityMul !== 1) {
      recordMetric(db, aid, 'axis.shadow.intensity', edgeBias.shadowIntensityMul)
    }
  } catch { /* 采样失败不影响评价 */ }
  try {
    const fired = (edgeBias && edgeBias.fired) || []
    if (res && res.label && res.label !== 'calm' && !fired.length) {
      event(db, aid, 'structure.edge_gap', { text: String(text).slice(0, 80), label: res.label })
    }
  } catch { /* 记号失败不影响评价 */ }
  /* P3：把「咽回去的那半句」落一条冷库记录。影子期——只存、不回读。
     存在 events 表（照 quote.moment），不建新表；payload 里带 affect 事件 id 方便对账。 */
  try {
    recordUnsaid(db, aid, {
      text: res && res.appraisal ? res.appraisal.unsaid : '',
      eventId: (res && res.id) || null,
      cause: String(text || '').slice(0, 120),
      at: Date.now(),
    })
  } catch { /* 落库失败不影响对话 */ }
  return res
}

/**
 * 「咽回去的那半句」落库（P3，影子）。
 * 只写一行 events；不写情绪、不写记忆、不进提示词——攒够样本再谈回读。
 * @returns {boolean} 真的写了一条
 */
export function recordUnsaid(db, aid, { text = '', eventId = null, cause = '', at = Date.now() } = {}) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return false
  if (String(getParam(db, aid, 'affect.unsaid') || 'on') === 'off') return false
  const payload = JSON.stringify({ text: s.slice(0, 120), event_id: eventId, cause: String(cause || '').slice(0, 120) })
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
    .run('evt_' + Math.random().toString(16).slice(2, 12), aid, 'unsaid.moment', payload, new Date(at).toISOString())
  return true
}

export { runHardGates, runIdentityBlind, suggestCalibration, applyCalibration, getEdgeGraph }

export function sampleMetrics(db, aid) {
  const vals = computeMetrics(db, aid)
  for (const [k, v] of Object.entries(vals)) {
    if (v == null) continue
    db.prepare('INSERT INTO metric_samples VALUES(?,?,?,?,?)').run(nid('mts_'), aid, k, v, now())
  }
  return { sampled: Object.values(vals).filter((v) => v != null).length, values: vals }
}

export function metricsHistory(db, aid, days = 30, keys = null) {
  agent(db, aid)
  const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString()
  const want = keys ? String(keys).split(',').map((x) => x.trim()).filter(Boolean) : null
  const rows = db.prepare('SELECT key,value,sampled_at FROM metric_samples WHERE agent_id=? AND sampled_at>=? ORDER BY sampled_at').all(aid, since)
  const series = {}
  for (const r of rows) {
    if (want && !want.includes(r.key)) continue
    const day = r.sampled_at.slice(0, 10)
    const bucket = (series[r.key] ||= {})
    const b = (bucket[day] ||= { sum: 0, n: 0 })
    b.sum += Number(r.value)
    b.n++
  }
  const out = {}
  for (const [k, byDay] of Object.entries(series)) {
    out[k] = Object.entries(byDay).sort().map(([day, b]) => ({ day, value: +(b.sum / b.n).toFixed(3) }))
  }
  return { series: out, days }
}

// ---------------- 全量导出 / 导入 ----------------
const TABLES = ['agents', 'memory_items', 'memory_links', 'conflicts', 'persona', 'affect_state', 'alerts',
  'affect_episodes', 'affect_feel', 'drive_state', 'action_ports', 'relations', 'persona_values', 'preferences',
  'taboos', 'condition_state', 'affect_samples', 'cooldowns', 'budgets', 'rule_versions', 'metric_samples',
  'affect_user_read',
  'action_log', 'proposals', 'changes', 'inbox_items', 'events', 'metric_snapshots', 'algo_bindings', 'agent_params',
  'rule_artifacts', 'agent_bindings', 'chat_turns', 'proactive', 'episodes', 'diaries', 'raw_turns', 'fact_archive', 'retrieval_log', 'entities', 'extract_queue', 'consolidation_log',
  // 人物账本：tier 先导（person 有外键），event 在投影之前
  'rel_tier', 'rel_event', 'rel_person', 'rel_edge', 'rel_mention', 'rel_evidence', 'rel_channel', 'rel_extract_queue', 'rel_review',
  // 行动层：通道配置 / 研究报告（research_seen 是全局去重表，不跟着实例走）
  'action_config', 'research_runs',
  // 性格拔河：两池与基线跟着实例走，导出/迁移要带上
  'axis_rope', 'axis_evidence', 'persona_judge']

function cols(db, t) { return db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name) }

/** 老库可能缺表（如已清退的 persona_values）：导出只看真实存在的表。 */
function presentTables(db) {
  try { return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)) } catch { return new Set() }
}

export function exportFull(db, aid) {
  agent(db, aid)
  const have = presentTables(db)
  const tables = TABLES.filter((t) => have.has(t))
  const files = { 'manifest.json': JSON.stringify({ agent_id: aid, schema: 11, at: now(), tables }, null, 2) }
  for (const t of tables) {
    let rows
    if (t === 'agents') rows = db.prepare('SELECT * FROM agents WHERE id=?').all(aid)
    else if (t === 'rule_artifacts') {
      const binds = db.prepare('SELECT * FROM agent_bindings WHERE agent_id=?').all(aid)
      const ids = new Set()
      for (const b of binds) for (const k of ['active_id', 'previous_id', 'pinned_id', 'v0_id']) if (b[k]) ids.add(b[k])
      for (const f of db.prepare('SELECT fork_artifact_id FROM proposals WHERE agent_id=? AND fork_artifact_id IS NOT NULL').all(aid)) {
        if (f.fork_artifact_id) ids.add(f.fork_artifact_id)
      }
      rows = ids.size
        ? db.prepare('SELECT * FROM rule_artifacts').all().filter((r) => ids.has(r.id))
        : []
    }
    else if (cols(db, t).includes('agent_id')) rows = db.prepare(`SELECT * FROM ${t} WHERE agent_id=?`).all(aid)
    else rows = db.prepare(`SELECT * FROM ${t}`).all()
    files[`tables/${t}.json`] = JSON.stringify(rows)
  }
  const zip = zipStore(files)
  const key = process.env.DSHC_EXPORT_KEY
  if (key) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), iv)
    const enc = Buffer.concat([cipher.update(zip), cipher.final()])
    return { encrypted: true, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64') }
  }
  return { encrypted: false, zip_base64: zip.toString('base64') }
}

export function importFull(db, aid, body) {
  active(db, aid)
  let zip
  if (body.encrypted) {
    const key = process.env.DSHC_EXPORT_KEY
    if (!key) err(400, 'INVALID_ARGUMENT', '缺少 DSHC_EXPORT_KEY')
    const d = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), Buffer.from(body.iv, 'base64'))
    d.setAuthTag(Buffer.from(body.tag, 'base64'))
    zip = Buffer.concat([d.update(Buffer.from(body.data, 'base64')), d.final()])
  } else {
    zip = Buffer.from(body.zip_base64 || '', 'base64')
  }
  let files
  try { files = unzipStore(zip) } catch { err(400, 'INVALID_ARGUMENT', '不是合法的 zip 文件') }
  if (!files['manifest.json']) err(400, 'INVALID_ARGUMENT', '包里缺少 manifest.json（不是本插件的导出）')
  const manifest = JSON.parse(files['manifest.json'].toString('utf8'))
  if (![6, 7, 8, 9, 10, 11].includes(Number(manifest.schema))) err(400, 'SCHEMA_MISMATCH', 'schema 不匹配')
  let total = 0
  return tx(db, () => {
  for (const t of TABLES) {
    const raw = files[`tables/${t}.json`]
    if (!raw) continue
    const rows = JSON.parse(raw.toString('utf8'))
    if (!Array.isArray(rows)) continue
    const cs = cols(db, t)
    const ph = cs.map(() => '?').join(',')
    for (const row of rows) {
      if (t !== 'agents' && cs.includes('agent_id')) row.agent_id = aid
      if (t === 'agents') row.id = aid
      // 跨 agent 导入时，主键冲突要换新 id，避免把原 agent 的行搬走
      if (t !== 'agents' && row.id && cs.includes('agent_id')) {
        const ex = db.prepare(`SELECT agent_id FROM ${t} WHERE id=?`).get(row.id)
        if (ex && ex.agent_id && ex.agent_id !== aid) row.id = nid('imp_')
      } else if (t === 'rule_artifacts' && row.id) {
        const ex = db.prepare('SELECT id FROM rule_artifacts WHERE id=?').get(row.id)
        if (ex) row.id = nid('art_')
      }
      try {
        // agents 只补不改：目标实例的 name/status 不被源覆盖
        const verb = t === 'agents' ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE'
        db.prepare(`${verb} INTO ${t}(${cs.join(',')}) VALUES(${ph})`).run(...cs.map((c) => row[c] ?? null))
        total++
      } catch { /* 跳过不兼容行 */ }
    }
  }
  // 重建全文索引，否则导入后的记忆搜不到
  rebuildMemoryFtsIndex(db)
  try { rebuildRawFts(db) } catch { /* 老包没有原文层 */ }
  try { rebuildFactFts(db) } catch { /* 老包没有事实存根 */ }
  return { imported: total, tables: TABLES.length, fts: 'rebuilt' }
  })
}

// ---------------- 记忆导出 / 导入（只动记忆仓库的六个分区） ----------------
// 人格 / 情绪 / 驱力 / 提案这些不在里面：那是「整体意识」，走设置里的全量备份。
const MEM_TABLES = ['memory_items', 'episodes', 'diaries', 'raw_turns', 'fact_archive', 'memory_timeline']

/** 导出记忆：一个只含记忆表的 zip；格式跟全量包一致，导入口两种都吃。 */
export function exportMemory(db, aid) {
  agent(db, aid)
  const tables = MEM_TABLES.concat(['memory_links'])
  const files = {
    'manifest.json': JSON.stringify({ agent_id: aid, schema: 9, kind: 'memory', at: now(), tables }, null, 2),
  }
  const counts = {}
  for (const t of MEM_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t} WHERE agent_id=?`).all(aid)
    counts[t] = rows.length
    files[`tables/${t}.json`] = JSON.stringify(rows)
  }
  // 记忆之间的连线没有 agent_id，只挑两端都在这个意识体里的
  const ids = new Set(db.prepare('SELECT id FROM memory_items WHERE agent_id=?').all(aid).map((r) => r.id))
  const links = ids.size
    ? db.prepare('SELECT * FROM memory_links').all().filter((l) => ids.has(l.from_id) && ids.has(l.to_id))
    : []
  counts.memory_links = links.length
  files['tables/memory_links.json'] = JSON.stringify(links)
  return { zip_base64: zipStore(files).toString('base64'), counts, manifest: { kind: 'memory', schema: 9 } }
}

/**
 * 导入后清掉指向本库不存在的感觉引用。
 * 记忆包不带 affect_feel——感觉不该跨实例继承；留着悬空 id 会让后面统计/清理误判。
 * 返回清掉的条数（日记按「有变化的天」算）。
 */
function dropDanglingFeelIds(db) {
  const keep = feelIdsAll(db)
  let n = 0
  const drop = (t) => {
    let rows = []
    try { rows = db.prepare(`SELECT id, feel_id FROM ${t} WHERE feel_id IS NOT NULL`).all() } catch { return }
    for (const r of rows) {
      if (keep.has(String(r.feel_id))) continue
      try { db.prepare(`UPDATE ${t} SET feel_id=NULL WHERE id=?`).run(r.id); n++ } catch { /* 跳过 */ }
    }
  }
  drop('memory_items')
  drop('fact_archive')
  drop('episodes')
  try {
    for (const r of db.prepare("SELECT id, feel_ids FROM diaries WHERE feel_ids IS NOT NULL AND feel_ids<>'[]'").all()) {
      let ids = []
      try { ids = JSON.parse(r.feel_ids) } catch { ids = [] }
      if (!Array.isArray(ids)) ids = []
      const kept = ids.filter((x) => keep.has(String(x)))
      if (kept.length !== ids.length) {
        db.prepare('UPDATE diaries SET feel_ids=? WHERE id=?').run(JSON.stringify(kept), r.id)
        n++
      }
    }
  } catch { /* 老库没有这张表 */ }
  return n
}

/** 导入记忆：整份备份包也能吃，但只取记忆那几张表，别的一律不动。 */
export function importMemory(db, aid, body) {
  active(db, aid)
  const zip = Buffer.from(String(body.zip_base64 || ''), 'base64')
  if (!zip.length) err(400, 'INVALID_ARGUMENT', '缺少 zip_base64')
  let files
  try { files = unzipStore(zip) } catch { err(400, 'INVALID_ARGUMENT', '不是合法的 zip 文件') }
  if (!files['manifest.json']) err(400, 'INVALID_ARGUMENT', '包里缺少 manifest.json（不是本插件的导出）')
  const present = MEM_TABLES.concat(['memory_links']).filter((t) => files[`tables/${t}.json`])
  if (!present.length) err(400, 'INVALID_ARGUMENT', '包里没有记忆数据（不是本插件的导出）')
  let total = 0
  const byTable = {}
  // 跨意识体导入时主键会换新：记下旧→新，时效索引里的 memory_id / cause_id / text_ref 才能跟着换
  const idMap = new Map()
  tx(db, () => {
    for (const t of present) {
      let rows
      try { rows = JSON.parse(files[`tables/${t}.json`].toString('utf8')) } catch { continue }
      if (!Array.isArray(rows)) continue
      const cs = cols(db, t)
      const ph = cs.map(() => '?').join(',')
      for (const row of rows) {
        if (t === 'memory_links') {
          // 连线只认这个意识体里真实存在的两条记忆，别把别人的边挂进来
          const a = db.prepare('SELECT agent_id FROM memory_items WHERE id=?').get(row.from_id)
          const b = db.prepare('SELECT agent_id FROM memory_items WHERE id=?').get(row.to_id)
          if (!a || !b || a.agent_id !== aid || b.agent_id !== aid) continue
          try {
            db.prepare(`INSERT OR IGNORE INTO memory_links(${cs.join(',')}) VALUES(${ph})`).run(...cs.map((c) => row[c] ?? null))
            total++
            byTable.memory_links = (byTable.memory_links || 0) + 1
          } catch { /* 跳过不兼容的行 */ }
          continue
        }
        if (t === 'memory_timeline') {
          // 时效索引没有业务主键（seq 自增）。按 (agent, memory, op, at) 去重，
          // 重复导入不记账、也不把别人的 seq 搬过来。
          const mapRef = (v) => (v == null ? v : (idMap.get(String(v)) || v))
          const mapMem = (v) => {
            const s = String(v == null ? '' : v)
            const i = s.indexOf(':hist:')
            if (i < 0) return mapRef(s)
            const base = idMap.get(s.slice(0, i))
            return base ? base + s.slice(i) : s
          }
          const c2 = cs.filter((c) => c !== 'seq')
          const r2 = {
            ...row, agent_id: aid,
            memory_id: mapMem(row.memory_id),
            cause_id: mapRef(row.cause_id),
            text_ref: mapRef(row.text_ref),
          }
          try {
            const ex = db.prepare('SELECT 1 FROM memory_timeline WHERE agent_id=? AND memory_id=? AND op=? AND at=?')
              .get(aid, r2.memory_id, r2.op, r2.at)
            if (ex) continue
            db.prepare(`INSERT INTO memory_timeline(${c2.join(',')}) VALUES(${c2.map(() => '?').join(',')})`)
              .run(...c2.map((c) => r2[c] ?? null))
            total++
            byTable.memory_timeline = (byTable.memory_timeline || 0) + 1
          } catch { /* 跳过不兼容的行 */ }
          continue
        }
        if (cs.includes('agent_id')) row.agent_id = aid
        // 跨意识体导入时主键要换新，免得把别人的行搬走 / 覆盖
        if (row.id) {
          const oldId = String(row.id)
          const ex = db.prepare(`SELECT agent_id FROM ${t} WHERE id=?`).get(row.id)
          if (ex && ex.agent_id && ex.agent_id !== aid) { row.id = nid('imp_'); idMap.set(oldId, row.id) }
        }
        try {
          db.prepare(`INSERT OR REPLACE INTO ${t}(${cs.join(',')}) VALUES(${ph})`).run(...cs.map((c) => row[c] ?? null))
          total++
          byTable[t] = (byTable[t] || 0) + 1
        } catch { /* 跳过不兼容的行 */ }
      }
    }
    // 重建全文索引，否则导入后的记忆搜不到
    rebuildMemoryFtsIndex(db)
    try { rebuildRawFts(db) } catch { /* 老包没有原文层 */ }
    try { rebuildFactFts(db) } catch { /* 老包没有事实存根 */ }
    // 感觉不跨实例继承：导入包里的 feel_id 在本库查不到的一律清空
    try { dropDanglingFeelIds(db) } catch { /* 清理失败不挡导入 */ }
  })
  return {
    imported: total, by_table: byTable, tables: present.length, fts: 'rebuilt',
    memory: byTable.memory_items || 0, episodes: byTable.episodes || 0,
    diaries: byTable.diaries || 0, raw: byTable.raw_turns || 0, facts: byTable.fact_archive || 0,
  }
}

// ---------------- SSE 事件游标 ----------------
export function eventsSince(db, aid, last = 0) {
  agent(db, aid)
  return db.prepare('SELECT rowid,* FROM events WHERE agent_id=? AND rowid>? ORDER BY rowid LIMIT 200').all(aid, Number(last) || 0)
}

// ---------------- 细粒度权限 / 限流 ----------------
const BUCKETS = new Map()

export function rateLimit(token, limit = 120, windowMs = 60000) {
  if (process.env.DSHC_TEST_NO_LIMIT) return true
  const nowMs = Date.now()
  const b = BUCKETS.get(token) || { start: nowMs, n: 0 }
  if (nowMs - b.start > windowMs) { b.start = nowMs; b.n = 0 }
  b.n++
  BUCKETS.set(token, b)
  return b.n <= limit
}

// ---------------- 多实例运行 ----------------
/**
 * 让这个意识体「活着」，并把它排给**下一段新对话**。
 *
 * schema 12 之前：激活一个 = 其余全部 paused（全局只有一个）。
 * 现在：不再踢别人下去；谁占哪段对话由 bindings 决定（见 modules/binding.js）。
 * 暂停仍然是用户随时可用的开关，且只影响「能不能被解析到」，不影响绑定本身。
 */
export function activateAgent(db, aid, role) {
  if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以切换运行中的意识体')
  const row = db.prepare('SELECT * FROM agents WHERE id=?').get(aid)
  if (!row || row.status === 'soft_deleted') err(404, 'NOT_FOUND', 'agent 不存在')
  db.prepare("UPDATE agents SET status='active', last_interaction_at=? WHERE id=?").run(now(), aid)
  // 用户点了唤醒：抹掉 offline/dormant 残留，再按绑定重算。否则 runtime_state 还停在暂停时，
  // 名单仍判成小卡，界面不会展开成大卡。（agent_runtime 的写入归 binding 模块）
  let runtime_state = 'idle'
  try { runtime_state = wakeRuntime(db, aid) } catch { /* 在场状态下次刷新会补 */ }
  try { setPending(db, aid) } catch { /* 待绑定写失败不影响激活 */ }
  // 角色卡排序看「最近唤醒」，不能拿 last_interaction_at 代替：那个每说一句都在动。
  try { setWokenAt(db, aid) } catch { /* 排序标记失败不影响激活 */ }
  try { seedRuleBindings(db, aid) } catch { /* 工件种子失败不影响激活 */ }
  let running = 0
  try { running = runningAgentIds(db).length } catch { running = 0 }
  return {
    id: aid, status: 'active', pending: true, runtime_state,
    running, max_running: (() => { try { return maxRunning(db) } catch { return 3 } })(),
  }
}

export function setFlag(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO flags(key,value) VALUES(?,?)').run(key, String(value))
}

export function getFlag(db, key) {
  const r = db.prepare('SELECT value FROM flags WHERE key=?').get(key)
  return r ? r.value : null
}

export function clearFlag(db, key) {
  db.prepare('DELETE FROM flags WHERE key=?').run(key)
}

// 「特别看重」的标/撤和事由已收进零件：src/parts/speak/trigger.js。这里只 re-export。
export { markLoopImportant, isLoopImportant, proactiveTriggerOf }

// 主动开口的额度记账已收进零件：src/parts/speak/budget.js。这里只 re-export，保持导入面不变。
export { proactiveSpend, addProactiveSpend }

// ---------------- 对话 ----------------

function personaStyle(db, aid) {  const rows = getPersona(db, aid)
  const pick = (k, d) => {
    const r = rows.find((x) => x.path === k)
    return r && r.value != null ? String(r.value) : d
  }
  return {
    tone: pick('style.tone', ''), address: pick('style.address', ''),
    catchphrase: pick('style.catchphrase', ''), banned: pick('style.banned', ''),
    card: pick('style.card', ''),
  }
}

/* ---------------- 嘀咕：与 fact / episode / appraisal / reflection 平级的「观测层」产物 ----------------
 * 专用一次模型调用，只给人看，不进 memory_items / 检索。关 ui.mutter.enabled 则跳过。 */

/** 中文按约 2 字 ≈ 1 token（与 pack.estTokens 同口径），用于嘀咕观测展示。 */
function estMutterTokens(text) {
  return Math.ceil(String(text || '').length / 2)
}

const MUTTER_MAX_CHARS = 150

/** 嘀咕 system：称呼来自鱼格 style.address，空则「主人」。 */
function mutterSys(address) {
  const who = String(address || '').trim() || '主人'
  return [
    '你就是这个意识体。看完这一轮，用第一人称对自己说几句——不是汇报，也不是事后作文，是脑子里还在转的那种。',
    '对方称「' + who + '」。只用这个称呼指对方，别叫「用户」「对方」。',
    '输入里每一行以 user: 或 assistant: 开头，那就是说话人标记：user = ' + who + ' 说的话，assistant = 你自己刚才说出口的话。',
    '开头如果给了「我自己之前写下的」或「这一轮咽回去的半句」，那是真实发生过的材料，可以顺着它写，但别复述它，也别把它当成必须回应的话。',
    '只写这一轮里最硌着你的那一个点；如果还有一句没出口的话，就把它写出来。',
    '可以不展开、可以不收尾、可以绕回去；一句也行。不总结这一轮，不升华，不替谁下结论，不端着正确。',
    '不要编号、分点、小标题。只写对话里真有的事，别编。',
  ].join('')
}

/**
 * 嘀咕消息：把这一轮按「user: / assistant:」标好说话人再交给模型。
 * 模型适配器（OpenAIAdapter / HostLlmAdapter 的 summarize、chat）在有 system 时
 * 会把多条内容拼成裸文本，角色标签会丢——不标清楚，模型只能靠内容猜谁说的，
 * 就会把 assistant 的话安到 user 头上（2026-11-04 实际踩到）。
 * materials：这一轮真实的材料（我自己写的 feel、咽回去的半句），放在对话前面。
 */
export function mutterMessages(sys, turns, materials = []) {
  const lines = (Array.isArray(turns) ? turns : []).map((t) => {
    const r = String((t && t.role) || 'user')
    const who = r === 'assistant' || r === 'agent' ? 'assistant' : 'user'
    return who + ': ' + String((t && t.text) || '')
  })
  const head = (Array.isArray(materials) ? materials : []).filter(Boolean).join('\n')
  return [
    { role: 'system', content: String(sys || '') },
    { role: 'user', content: (head ? head + '\n\n' : '') + lines.join('\n') },
  ]
}

/**
 * 这一轮「咽回去的那半句」：按用户原话匹配最近的 unsaid.moment 事件。
 * 照 P3 的影子期纪律，只读、不改；找不到就返回空串（不给嘀咕编一句）。
 */
export function latestUnsaidFor(db, aid, userText) {
  const t = String(userText || '').trim().slice(0, 80)
  if (!t) return ''
  try {
    const since = new Date(Date.now() - 86400000).toISOString()
    const rows = db.prepare("SELECT payload,created_at FROM events WHERE agent_id=? AND type='unsaid.moment' AND created_at>=? ORDER BY created_at DESC LIMIT 20").all(aid, since)
    for (const r of rows) {
      let p = null
      try { p = JSON.parse(r.payload || '{}') } catch { p = null }
      if (!p || !p.text) continue
      const cause = String(p.cause || '')
      if (cause && (cause.includes(t) || (t.length >= 8 && t.includes(cause.slice(0, 40))))) return String(p.text)
    }
  } catch { /* 没有事件表就当没有 */ }
  return ''
}

/**
 * 嘀咕要用的真实材料：我开口前自己写下的 feel + 这一轮咽回去的半句。
 * 只读、取不到就空——不拿别的凑，免得嘀咕变成无中生有。
 */
export function mutterMaterials(db, aid, list) {
  const out = []
  try {
    const f = latestFeel(db, aid, { maxAgeMin: 180 })
    if (f && f.text) out.push('（我自己之前写下的：' + f.text + '）')
  } catch { /* 没有 feel 就不放 */ }
  try {
    const lastUser = (() => {
      for (let i = list.length - 1; i >= 0; i--) if ((list[i].role || 'user') === 'user') return String(list[i].text || '')
      return ''
    })()
    const unsaid = latestUnsaidFor(db, aid, lastUser)
    if (unsaid) out.push('（这一轮咽回去的半句：' + unsaid + '）')
  } catch { /* 没有 unsaid 就不放 */ }
  return out
}

/**
 * 专用嘀咕调用：结果进 flags（按 agent），绝不 addMemory。
 * @returns {Promise<{text:string, tokens:number, at:string, address?:string}|null>}
 */
export async function writeMutter(db, aid, turns) {
  const list = Array.isArray(turns) ? turns : []
  if (!list.length) return null
  const address = (() => {
    try { return String(personaStyle(db, aid).address || '').trim() } catch { return '' }
  })()
  const sys = mutterSys(address)
  // 这一轮真实的两样材料：我开口前自己写下的 feel、以及咽回去的半句（只读，取不到就空）
  const materials = mutterMaterials(db, aid, list)
  const messages = mutterMessages(sys, list, materials)
  const body = messages[1].content
  // 只走真模型：规则兜底写出来的嘀咕是拼贴，宁可不写。
  const raw = String((await model.chatPrimary(messages, 600, false, 0.2)) || '').trim()
  let text = looksLikeRuntimeNoise(raw) ? '' : raw.replace(/\s+/g, ' ').trim()
  if (!text) return null
  const transcriptShaped = /^\s*(user|assistant)\s*[:：]/i.test(text)
    || (text.match(/\n\s*(user|assistant)\s*[:：]/gi) || []).length >= 1
  if (transcriptShaped) return null
  // 超长时在句号处尽量裁，保住旧版那种「一段咬完就停」
  if (Array.from(text).length > MUTTER_MAX_CHARS) {
    const chars = Array.from(text)
    let cut = MUTTER_MAX_CHARS
    for (let i = MUTTER_MAX_CHARS; i >= Math.floor(MUTTER_MAX_CHARS * 0.7); i--) {
      if ('。！？…'.includes(chars[i])) { cut = i + 1; break }
    }
    text = chars.slice(0, cut).join('')
  }
  const tokens = estMutterTokens(sys) + estMutterTokens(body.slice(0, 8000)) + estMutterTokens(text)
  const at = now()
  const payload = { text, tokens, at, address: address || '主人' }
  try { setFlag(db, 'ui.mutter.' + aid, JSON.stringify(payload)) } catch { /* 展示失败不影响入库 */ }
  return payload
}

/** 读最近一条嘀咕（展示用）。 */
function readMutter(db, aid) {
  try {
    const raw = getFlag(db, 'ui.mutter.' + aid)
    if (!raw) return null
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object' || !j.text) return null
    return {
      text: String(j.text),
      tokens: Number(j.tokens) || null,
      at: j.at || null,
    }
  } catch { return null }
}


export function listChat(db, aid, limit = 60) {
  agent(db, aid)
  const rows = db.prepare('SELECT * FROM chat_turns WHERE agent_id=? ORDER BY created_at DESC LIMIT ?')
    .all(aid, Math.max(1, Math.min(200, Number(limit) || 60)))
  return rows.reverse().map((r) => ({
    id: r.id, role: r.role, text: r.text, mood: r.mood || null,
    pack: (() => { try { return JSON.parse(r.pack || '[]') } catch { return [] } })(),
    at: r.created_at,
  }))
}

/**
 * 这段会话最近几轮（双方都算，最旧的在前，给模型当多轮上下文）。
 * 只给「能带上下文的人」：主人按 qq.history_turns（默认 8 轮），
 * 陌生人固定 2 轮，防串话。总量超 2400 字就从最旧的开始丢。
 */
export function recentHistory(db, aid, conversationId, rounds) {
  if (!conversationId || !rounds) return []
  let rows = []
  try {
    rows = db.prepare(`SELECT role, text FROM chat_turns
      WHERE agent_id=? AND conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(aid, String(conversationId), rounds * 2)
  } catch { return [] }
  const picked = []
  let chars = 0
  for (const r of rows) {
    const t = String(r.text || '').trim().slice(0, 300)
    if (!t) continue
    if (chars + t.length > 2400 && picked.length) break
    chars += t.length
    picked.push({ role: r.role === 'user' ? 'user' : 'assistant', text: t })
  }
  return picked.reverse()
}

// ---------------- QQ 段的叙事加工（和网页那边一个套路） ----------------
// 网页是 chat_turns → 原文层 → 每 6 轮压纪要 → 每天写日记；QQ 以前只有零散记忆点。
// 这里补上同一条链路：原文进 raw_turns，关系账本认人，每 6 轮压一条纪要，
// 事实改成 3 轮抽一次（一句一抽碎片太多，还容易把半句话当事实）。
const qqNarrativeTick = new Map()
const qqExtractBuf = new Map()

function qqNarrativeAfterTurn(db, aid, conv) {
  const key = aid + ':' + conv
  const n = (qqNarrativeTick.get(key) || 0) + 1
  qqNarrativeTick.set(key, n)
  try {
    if (n % 6 !== 0) return null
    return buildEpisode(db, aid, { session: conv })
  } catch { return null }
}

async function qqBatchExtract(db, aid, conv, text, turnSeed) {
  const key = aid + ':' + conv
  const buf = qqExtractBuf.get(key) || []
  buf.push(String(text || ''))
  qqExtractBuf.set(key, buf)
  if (buf.length < 3) return null
  qqExtractBuf.set(key, [])
  const facts = await model.extract([{ role: 'user', text: buf.join('\n') }])
  let n = 0
  for (const m of facts) {
    try {
      addMemory(db, aid, { text: m.text, type: m.type || 'fact', mark: m.mark || 'normal', ...turnSeed(m.text, m.type || 'fact') })
      n++
    } catch { /* 单条跳过 */ }
  }
  return n
}

/**
 * 网页这边说完一句，顺手把这句话推到 QQ。
 *
 * 默认关（`qq.relay.enable=on` 才发），因为外发是收不回来的动作。
 * 挡住两种重复：
 *   1. 这段会话本来就是 QQ 来的（conversation_id 以 qq: 开头），再推回去就是一句变两句；
 *   2. 开关没开。
 * 推失败只记一条事件，不抛、不改这一轮的回复——外发通道挂了不该让聊天也挂。
 */
async function relayReplyToQQ(db, aid, reply, conv) {
  if (String(getParam(db, aid, 'qq.relay.enable') || 'off') !== 'on') return null
  // 桥接插件（dsh-qq-onebot-bridge）接管 QQ 之后，推送权归它：
  // 它的回复是 agent loop 真跑出来的，这里再推一次就是同一句话在两个通道各说一遍。
  // 这条互斥比「用户记不记得关开关」可靠——两个开关同时打开也不会双发。
  if (String(getParam(db, aid, 'qq.bridge.enable') || 'off') === 'on') {
    try { event(db, aid, 'qq.relay.skipped', { reason: 'qq.bridge 已接管 QQ' }) } catch { /* 记账失败不影响 */ }
    return null
  }
  if (!reply || /^qq:/i.test(String(conv || ''))) return null
  const maxChars = Math.max(1, Math.min(2000, Number(getParam(db, aid, 'qq.relay.max_chars')) || 800))
  const text = String(reply).slice(0, maxChars)
  try {
    const out = await sendMessage(db, aid, { channel: 'qq', text })
    try { event(db, aid, 'qq.relay.sent', { target: out.target, chars: text.length }) } catch { /* 记账失败不影响发送 */ }
    return out
  } catch (e) {
    try { event(db, aid, 'qq.relay.failed', { error: String((e && e.message) || e).slice(0, 200) }) } catch { /* 同上 */ }
    return null
  }
}

/**
 * 一轮对话：召回 → 评价（更新情绪）→ 生成回复 → 落库。
 * 回复优先走模型适配器；没有模型时用规则拼接，并把它标出来。
 */
export async function chatReply(db, aid, body) {
  active(db, aid)
  const text = String(body.text || '').trim()
  if (!text) err(400, 'INVALID_ARGUMENT', 'text 不能为空')
  if (text.length > 2000) err(400, 'INVALID_ARGUMENT', '单条不超过 2000 字')

  // 这段会话的说话人是不是主人：不是主人就只给「人格 + 情绪」，
  // 不给日记/关系/私有记忆，也不许用主人的称呼、不许承诺记住。
  const sp = body.speaker && typeof body.speaker === 'object' ? body.speaker : null
  const speakerHandle = sp && sp.handle != null ? String(sp.handle) : ''
  // 谁在说话：带号就按号认；外部通道漏了号（桥超时/字段变了），不能退回「当主人」——那是串人的老口子。
  // 网页那条路根本没有 speaker，说话的就是主人本人。
  const canLearn = !sp
    ? true
    : (speakerHandle.trim() ? isOwner(db, speakerHandle) : isLocalChannel(sp.channel))
  const conv = body.conversation_id ? String(body.conversation_id) : ''

  let pack = recall(db, aid, text, recallItems(db), 512)
  pack.items = pack.items.filter((x) => !/[?？]$/.test(String(x.text).trim()))
  if (!pack.items.length) pack = softRecall(db, aid, text, 5)
  // G1：问句带过去时间（「半年前」「去年三月」）时，把「那时」的版本补到最前面。
  // memory.asof.auto=off 时 asofInjectItems 直接返回空，跟改造前一致。
  try {
    const ao = asofInjectItems(db, aid, text)
    if (ao && Array.isArray(ao.items) && ao.items.length) pack.items = ao.items.concat(pack.items)
  } catch { /* 当时查询失败不影响正常检索 */ }
  // 多轮上下文：这一段会话自己说过的话，主人带满，陌生人只带两句
  const history = recentHistory(db, aid, conv, canLearn ? historyTurns(db) : 2)
  let affect = null
  try { affect = await appraiseWithEdges(db, aid, text) } catch { affect = getAffect(db, aid) }
  let drive = null
  try { drive = getDrive(db, aid) } catch { drive = null }
  const style = personaStyle(db, aid)
  const banned = String(style.banned || '').split(/[,，\s]+/).filter(Boolean)
  // 两条路用同一个拼装器：主人拿全份，不熟的人只拿「她是谁、现在什么样、怎么说话」那一半。
  // 关系段按说话人各算各的，陌生人不会拿到主人那一行。
  const contextBlock = clampContextBlock(buildContextBlock(db, aid, {
    recall: canLearn ? pack.items : [],
    audience: canLearn ? 'owner' : 'stranger',
    // 把这一句也交进去：网页那头是先看这句话再翻三观/记忆，QQ 这边以前只塞了预召回，
    // 检索不知道对方在问什么，捞回来的常跟这句对不上。
    text,
  }), promptBudget(db))

  let reply = ''
  let source = 'rules'
  try {
    reply = String(await model.reply({ text, pack: canLearn ? pack.items : [], affect, drive, style, contextBlock, history, isOwner: canLearn }))
    // 标签说实话：规则兜底拼出来的句子不叫「model」，否则评测和面板都分不清谁回的
    const st = model.status()
    source = st.served === 'fallback' || st.adapter === 'rules' ? 'rules' : 'model'
  } catch { reply = '' }
  if (!reply) {
    reply = composeRulesReply({ text, pack: canLearn ? pack.items : [], affect, style, isOwner: canLearn })
    source = 'rules'
  }
  for (const w of banned) if (w && reply.includes(w)) reply = reply.split(w).join('……')

  const mood = affect ? (affect.label || affect.primary_label || null) : null
  const turnSeed = (t, type) => seedScores(t, type, affect ? affect.intensity : 0, affect ? affect.pleasure : undefined)
  const at = now()
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(nid('cht_'), aid, 'user', text, JSON.stringify(canLearn ? pack.items : []), mood, at, body.conversation_id || null)
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(nid('cht_'), aid, 'agent', reply, '[]', mood, now(), body.conversation_id || null)
  // 记忆闸：只有主人号说的话才进长期记忆/关系账本。
  // 陌生人照常聊、照常落 chat_turns（这段会话自己的账），但不许把他的话
  // 抽成「关于主人」的事实——那是串人的根源。
  // 慢更新：关系事件结算 + 性格证据。以前这里没接线，关系账本和五轴
  // 在真实聊天里根本没被喂过东西——这是「聊几百轮还是 0.5」的根因之一。
  let learning = null
  let narrative = null
  if (canLearn) {
    try { learning = learnFromTurn(db, aid, text, affect) } catch { learning = null }
    try { addMemory(db, aid, { text, type: 'episode', mark: 'normal', ...turnSeed(text, 'episode') }) } catch { /* 合并失败不影响回复 */ }
    // 原文层：网页那边也是这句先落 raw_turns，日记/纪要才取得到料
    const sess = conv || ('qq:' + (speakerHandle || 'local'))
    try { appendTurn(db, aid, { sessionId: sess, role: 'user', text, at }) } catch { /* 原文失败不影响回复 */ }
    try { appendTurn(db, aid, { sessionId: sess, role: 'assistant', text: reply, at: now() }) } catch { /* 原文失败不影响回复 */ }
    // 关系账本：聊到谁就认谁（以前 QQ 完全没走这一步，关系图不会长人）
    try { R.ingest(db, aid, { text, sessionId: sess, source: 'qq' }) } catch { /* 关系记账失败不影响回复 */ }
    try { enqueueRelationRead(db, aid, { text }) } catch { /* 入队失败下次再说 */ }
    // 纪要：每 6 轮把这段压成一条；事实改成 3 轮抽一次
    try { narrative = qqNarrativeAfterTurn(db, aid, sess) } catch { narrative = null }
    try { await qqBatchExtract(db, aid, sess, text, turnSeed) } catch { /* 抽取失败不影响回复 */ }
  } else {
    try { event(db, aid, 'chat.stranger', { handle: speakerHandle.slice(0, 32) }) } catch { /* 记账失败不影响回复 */ }
  }
  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(at, aid)
  // 轻量互动事件；系统性代理结算在 evaluateDrive（INV5：非自修改）
  try {
    const deltas = { R: 0.03, E: 0.02 }
    if (mood === 'joy' || mood === 'calm' || mood === 'peaceful') deltas.R = 0.05
    if (mood === 'curious') deltas.E = 0.04
    if (mood === 'irritated' || mood === 'frustrated') { deltas.R = -0.03; deltas.S = -0.02 }
    applySatisfaction(db, aid, deltas, { skipDecay: true })
  } catch { /* 驱力未就绪时跳过 */ }
  try { db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(nid('evt_'), aid, 'chat.turn', JSON.stringify({ source, label: mood }), now()) } catch { /* 忽略 */ }

  // 网页说完再传 QQ：扔出去不 await，一次外发最多 15 秒，不能拖着这一轮的回复。
  try { relayReplyToQQ(db, aid, reply, conv).catch(() => {}) } catch { /* 开关没开/参数读不到时静默 */ }

  return {
    reply, source,
    pack: pack.items, tokens: pack.tokens,
    affect: affect ? { label: affect.label, intensity: affect.intensity, mood: affect.mood } : null,
    drive: drive ? { band: drive.band, tokens: drive.tokens } : null,
    learning: learning
      ? {
          pos: !!learning.pos, neg: !!learning.neg,
          axes: Array.isArray(learning.axes) ? learning.axes.filter((a) => a && a.after != null).map((a) => ({ axis: a.axis, before: a.before, after: a.after })) : [],
        }
      : null,
    at,
    model: model.status(),
    // 外部通道排查用：这次到底带了多少上下文、开头是什么（不含长期记忆正文）
    context_chars: contextBlock.length,
    context_head: contextBlock.slice(0, 240),
    speaker: speakerHandle || null,
    learned: canLearn,
    // 多轮上下文排查用：这次带了几条历史（0 = 第一句或关掉了）
    history_used: history.length,
    // 叙事加工排查用：这一轮有没有压出纪要
    narrative_episode: narrative ? narrative.id : null,
  }
}

// ---------------- 可视化用的聚合 ----------------
/**
 * 八标签雷达：它「现在」的情绪成分。
 * 不是历史累计计数（那样永远是 calm 一枝独秀），而是最近 24 小时里
 * 每条 episode 按「越近越重」的指数衰减叠起来（半衰 4 小时），
 * 再把强度一起算进去——轻轻一句和重重一下不该同权。
 */
export function affectRadar(db, aid, hours = 24) {
  agent(db, aid)
  const map = { joy: 0, calm: 0, curious: 0, peaceful: 0, confused: 0, lost: 0, irritated: 0, frustrated: 0 }
  const now = Date.now()
  const since = new Date(now - hours * 3600000).toISOString()
  const rows = db.prepare('SELECT label, intensity, started_at FROM affect_episodes WHERE agent_id=? AND started_at>=? AND label IS NOT NULL').all(aid, since)
  const TAU_H = 4
  let keep = 0
  for (const r of rows) {
    if (map[r.label] == null) continue
    const ts = Date.parse(r.started_at)
    if (!Number.isFinite(ts)) continue
    /* 衰减 + 强度：越近越重，越强越重；强度给个地板，免得 0.1 的一句直接消失 */
    const w = Math.exp(-Math.max(0, now - ts) / (TAU_H * 3600000)) * Math.max(0.15, Number(r.intensity) || 0.4)
    map[r.label] += w
    keep++
  }
  const dominant = keep ? Object.entries(map).sort((a, b) => b[1] - a[1])[0][0] : null
  return { labels: map, total: keep, dominant, window_h: hours, tau_h: TAU_H }
}

/** 日记：把最近几天的记忆按天写成第一人称。模板是确定的，不假装是模型写的。 */
export function diary(db, aid, days = 7) {
  const a = agent(db, aid)
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const rows = db.prepare("SELECT text, type, created_at FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND created_at>=? ORDER BY created_at").all(aid, since)
  const byDay = {}
  for (const r of rows) (byDay[String(r.created_at).slice(0, 10)] ||= []).push(r)
  const lines = []
  for (const day of Object.keys(byDay).sort()) {
    lines.push(day + '：')
    for (const m of byDay[day].slice(0, 6)) lines.push('  · ' + m.text)
  }
  const text = lines.length
    ? '我是' + a.name + '。这几天我记得：\n' + lines.join('\n')
    : '我是' + a.name + '。这几天我还没记住什么。'
  return { days, text, count: rows.length }
}

/** 日记：按记忆拼一个可读摘要。 */

// ---------------- 同一性盲测（5 轮 A/B） ----------------
// 一边是它本人（带人格/语气/口头禅），一边是中性回复；用户盲选哪边"更像它"。
const BLIND_PROMPTS = ['今天有点累', '你还记得我吗', '推荐点东西给我', '我做错了一件事', '晚安']

export function startBlind(db, aid) {
  const style = personaStyle(db, aid)
  const rounds = BLIND_PROMPTS.map((prompt, i) => {
    const mine = composeRulesReply({ text: prompt, pack: [], affect: { label: 'calm' }, style })
    const generic = '嗯，我在。你说。'
    const flip = Math.random() < 0.5
    return { i, prompt, a: flip ? generic : mine, b: flip ? mine : generic, mine: flip ? 'b' : 'a' }
  })
  const tid = nid('blt_')
  setFlag(db, 'blind:' + tid, JSON.stringify({ agent: aid, rounds }))
  return { test_id: tid, rounds: rounds.map((r) => ({ i: r.i, prompt: r.prompt, a: r.a, b: r.b })) }
}

export function scoreBlind(db, aid, tid, answers) {
  const raw = getFlag(db, 'blind:' + tid)
  if (!raw) err(404, 'NOT_FOUND', '盲测不存在，或已提交过')
  const test = JSON.parse(raw)
  const mine = new Map(test.rounds.map((r) => [r.i, r.mine]))
  let hit = 0
  let total = 0
  for (const ans of Array.isArray(answers) ? answers : []) {
    const side = mine.get(ans.i)
    if (!side) continue
    if (ans.choice === 'a' || ans.choice === 'b') {
      total++
      if (ans.choice === side) hit++
    }
  }
  const score = total ? hit / total : 0
  recordMetric(db, aid, 'persona.identity_blind', +score.toFixed(3))
  clearFlag(db, 'blind:' + tid)
  return { score: +score.toFixed(3), hit, total, pass: score >= 0.8 }
}

// 开口的常量 / 门 / 打分 / 事由 / 生成 / 存储都已搬进 src/parts/speak/；这里不再留第二份。

const CLOSING_GOODBYE = /(晚安|再见|拜拜|先这样|睡了|先去睡)/
// 问句不只看结尾：「你怎么看」「为什么这样」中间带疑问词也算
const CLOSING_QUESTION = /([？?]|(吗|呢)\s*[。！!…]*\s*$|怎么|为什么)/
const CLOSING_ALREADY = /(睡了|先这样|明天再说|不聊了|先收一收|先歇会儿)/

/**
 * 收尾倾向：本地深夜 + 今天聊够了 + 对方没在提问/告别 + 30 分钟内没说过收尾。
 * 只读 chat_turns，不写任何状态；返回 { line } 或 null。
 * 这是「给她一个念头」，不是命令；她可以不说。
 */
export function closingIntentOf(db, aid, { at = Date.now(), level = '' } = {}) {
  const d = new Date(at)
  const mins = d.getHours() * 60 + d.getMinutes()
  if (!(mins >= 23 * 60 + 30 || mins < 6 * 60)) return null
  const day = localDay(d)
  let rows = []
  try {
    rows = db.prepare('SELECT role, text, created_at FROM chat_turns WHERE agent_id=? ORDER BY created_at DESC LIMIT 30').all(aid)
  } catch { return null }
  const today = rows.filter((r) => r.created_at && localDay(new Date(r.created_at)) === day)
  if (today.length < 8) return null
  const lastUser = today.find((r) => r.role === 'user')
  if (!lastUser) return null
  const text = String(lastUser.text || '').trim()
  if (CLOSING_QUESTION.test(text)) return null
  if (CLOSING_GOODBYE.test(text)) return null
  const mine = today.filter((r) => r.role === 'agent' || r.role === 'assistant').slice(0, 2)
  for (const r of mine) {
    const t = Date.parse(r.created_at || '')
    if (Number.isFinite(t) && at - t < 30 * 60000 && CLOSING_ALREADY.test(String(r.text || ''))) return null
  }
  return { line: level === 'quiet' ? '今天不太想说话了，先这样。' : '有点晚了，我想先收一收。' }
}

// proactiveTriggerOf / markLoopImportant / isLoopImportant 已搬进 src/parts/speak/trigger.js

// decideSpeak / explainSilent / nextTryInHours 已搬进 src/parts/speak/judge.js

export { queueProactive } from './parts/speak/index.js'

// ---------------- 决策记录（解释用，不审批；连续同样的沉默合并） ----------------

// 决策落库 / 查询 / 结局追踪 已搬进 src/parts/speak/store.js

// ---------------- 主动开口的偏好（已收进零件：src/parts/speak/prefs.js） ----------------
export { PROACTIVE_DEFAULTS, getProactivePrefs, setProactivePrefs }

/** 推消息时给对方看到的那段提示；后面跟着的才是它自己说的话。 */
export function proactivePushText(line) {
  return '（它主动来找你，想说的是：「' + String(line || '') + '」。直接把这句话说给他听，不要复述这条提示。）'
}

// ---------------- 人格与关系的慢更新（C4 自动，带步幅上限） ----------------
const PRAISE_W = ['喜欢', '谢谢', '好', '棒', '开心', '爱', '不错']
const CRITIC_W = ['讨厌', '烦', '错', '差', '生气', '不想', '别', '不好']
// 「不/没/别 + 好词」不算夸：否则「你不好」会因为命中「好」被记成加分
const NEG_PRAISE = /(?:不|没|别|没那么|不太)\s*(?:喜欢|好|棒|开心|爱|不错)/

function turnRounds(db, aid) {
  try { return Number(db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE agent_id=? AND role='user'").get(aid).n || 0) } catch { return 0 }
}

/**
 * 关系事件：一句话 → 效价 → 三轴（9 号文档 §4–§5）。
 * res 是 appraise() 的返回值；没有就退回规则评价。formula=v0 时不走新模型。
 */
export function relObserve(db, aid, { text = '', res = null, personId = null, source = 'chat', at = Date.now() } = {}) {
  if (String(getParam(db, aid, 'relation.dynamics.formula') || 'v1') === 'v0') return { changed: [], skipped: 'v0' }
  const t = String(text || '')
  const app = (res && res.appraisal) || rulesAppraise(t)
  const apology = /对不起|抱歉|是我不好|我错了|别生气|原谅我|不好意思/.test(t)
  const label = apology ? 'calm' : String(app.label || 'calm')
  const kind = apology ? 'repair'
    : label === 'joy' ? 'praise'
      : (label === 'irritated' || label === 'frustrated' || label === 'lost') ? 'critic' : 'chat'
  const vRaw = apology ? 0.6 : moodAdjust(eventValence({
    goalCongruence: app.goal_congruence,
    agency: app.agency,
    total: res && res.v3 ? res.v3.total : 0,
    directed: /你|您/.test(t),
    kind,
  }), res && res.mood)
  // 被搭话本身算一点点正向：普通一句（既没夸也没骂）也给地板效价。
  // 不给地板的话，中性句的 v 恰好是 0，noise 门槛怎么调都不会动，账本里只剩夸奖和批评。
  const v = (!apology && kind === 'chat' && vRaw >= 0)
    ? Math.max(vRaw, REL_DYN.chatFloor)
    : vRaw
  return bumpRelation(db, aid, { personId, v, kind, label, source, reason: t.slice(0, 50), at })
}

/**
 * 关系事件 → 性格证据。
 * 只回答「这件事算不算推了某条轴一下」，真动轴交给 flush 的密度判断。
 *
 * 映射理由（写清楚，免得以后被当成魔法数字）：
 *   κ↑ 亲近   → E/I 偏外向：相处这件事反复发生，是行为重复，不是心情
 *   ρ↑ 信任   → T/F 偏情感：被信任的关系更愿意走情感一侧
 *   ρ↓ 信任破 → 敏感↑：信任破损比亲近破损更痛，留下更久的痕迹
 *   boundary  → 敏感↑：碰到底线是强刺激，一次就够
 */
export function evidenceFromRelation(db, aid, rel) {
  const list = (rel && rel.changed) || []
  const added = []
  const push = (e) => {
    const r = addEvidence(db, aid, e)
    if (r) added.push(r)
  }
  for (const c of list) {
    const b = c.before || {}
    const a = c.after || {}
    const dc = Number(a.closeness || 0) - Number(b.closeness || 0)
    const dt = Number(a.trust || 0) - Number(b.trust || 0)
    const kind = String(c.kind || 'chat')
    if (dc > 0.002) push({ axis: 'ei', dir: 1, strength: Math.min(0.6, dc * 24), source: 'relation' })
    if (dt > 0.002) push({ axis: 'tf', dir: -1, strength: Math.min(0.5, 0.25 + dt * 10), source: 'relation' })
    if (dt < -0.002) push({ axis: 'sensitivity', dir: 1, strength: Math.min(0.7, 0.3 + Math.abs(dt) * 10), source: 'relation' })
    if (kind === 'boundary') push({ axis: 'sensitivity', dir: 1, strength: 0.8, source: 'boundary' })
  }
  return added
}

export function learnFromTurn(db, aid, userText, res = null) {
  const t = String(userText || '')
  const changed = []
  const axes = []
  let rel = null
  try {
    rel = relObserve(db, aid, { text: t, res, source: 'chat' })
    if (rel && rel.changed && rel.changed.length) {
      changed.push(...rel.changed)
      axes.push(...evidenceFromRelation(db, aid, rel))
    }
  } catch { /* 关系更新失败不影响对话 */ }
  // 旧表镜像：selfview / 旧接口还在读它，别让两份数字打架；顺手补一条 changes 给旧历史页
  if (rel && rel.after) {
    try {
      const root = listRelations(db, aid).find((r) => r.root) || null
      if (root) {
        const prev = { closeness: Number(root.closeness), trust: Number(root.trust), dependence: Number(root.dependence) }
        const after = rel.after
        db.prepare('UPDATE relations SET closeness=?, trust=?, dependence=?, updated_at=? WHERE id=?')
          .run(after.closeness, after.trust, after.dependence, now(), root.id)
        db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(nid('chg_'), null, aid, 'relations.' + root.name,
            JSON.stringify({ ...prev, why: t.slice(0, 50) }),
            JSON.stringify({ closeness: after.closeness, trust: after.trust, dependence: after.dependence, why: t.slice(0, 50) }),
            now(), 'system', 'system', 'auto:' + (rel.kind || 'appraisal'), null, null)
      }
    } catch { /* 旧表没有就算了 */ }
  }

  // 性格五轴：v2 起由「拔河」接管（夜间 self_scan 统一扫她的行为 → 左右两个拉力池），
  // 这里只保留「这句话像不像夸/刺」的判定给接口用，不再直接写轴。
  const negated = NEG_PRAISE.test(t)
  const pos = !negated && PRAISE_W.some((w) => t.includes(w))
  const neg = !pos && (CRITIC_W.some((w) => t.includes(w)) || negated)
  return { changed, pos, neg, axes }
}
// 关系变化可解释：谁、从多少到多少、因为哪句话。
export function relationHistory(db, aid, limit = 20) {
  agent(db, aid)
  const rows = db.prepare("SELECT * FROM changes WHERE agent_id=? AND field LIKE 'relations.%' ORDER BY applied_at DESC LIMIT ?").all(aid, Math.max(1, Math.min(50, Number(limit) || 20)))
  const parse = (v) => { try { return JSON.parse(v) } catch { return {} } }
  return rows.map((r) => ({
    id: r.id, name: String(r.field || '').replace('relations.', ''),
    before: parse(r.before), after: parse(r.after), at: r.applied_at,
  }))
}

// 模型探针：验证 host llm 是否真的接上了（只读，不写库）
export async function probeAppraise(db, aid, text, formula = 'v1', context = '') {
  const t0 = Date.now()
  let result = null
  let error = null
  try { result = await model.appraise(String(text || ''), formula, String(context || '')) } catch (e) { error = String(e && e.message ? e.message : e) }
  return { status: model.status(), ms: Date.now() - t0, formula, result, error, rules: appraiseRules(String(text || '')) }
}

// 完整清单：从 client.js 自动提取的界面区块（构建时生成 src/catalog.json）
export function catalog() {
  try {
    return JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'))
  } catch {
    return { source: 'missing', tabs: 0, items: 0, groups: [] }
  }
}

import { getLearningPrefs, setLearningPrefs, LEARNING_DEFAULTS } from './kernel.js'
export { getLearningPrefs, setLearningPrefs, LEARNING_DEFAULTS }

// 注入预算：估算 token（中文按 2 字符≈1 token）。这是**硬上限**：
// ① 先按「主动句 → 情绪 → 驱力 → 日记 → 记忆」整段丢；
// ② 还超就从日记 / 记忆块里按行往回砍（保留标题行）；
// ③ 最后再超才硬截断（留省略号），保证返回的 tokens ≤ budget。
export function clampInjection(lines, budget = 800) {
  const est = (t) => Math.ceil(String(t).length / 2)
  const cap = Math.max(40, Number(budget) || 800)
  // 行可以是字符串，也可以是 { text, key }。带 key 的行用于「先拼装、后落账」：
  // 只有真的留在最终文本里的 key 才算说过；被整行丢掉、被削断的都不算。
  const parts = []
  const keys = []
  const src = Array.isArray(lines) ? lines : []
  for (let i = 0; i < src.length; i++) {
    const l = src[i]
    parts.push(typeof l === 'string' ? l : String((l && l.text) || ''))
    keys.push(typeof l === 'string' ? '#' + i : String(l && l.key != null ? l.key : '#' + i))
  }
  const dropped = []
  const removed = new Set()
  const total = () => est(parts.join('\n'))
  const dropAt = (idx, label) => {
    if (idx < 0 || idx >= parts.length) return false
    removed.add(keys[idx])
    parts.splice(idx, 1)
    keys.splice(idx, 1)
    if (label) dropped.push(label)
    return true
  }
  // 丢的顺序 = 丢得起的顺序。改过一次（A2）：情绪原来排第 2，一挤就先没了。
  // 现在情绪根本不进丢弃名单——它只有两行，却是人格的锚：
  // 丢一条记忆伤准确度，丢情绪伤的是「她是谁」。真到极限，宁可削短别的行。
  const AFFECT_TEST = (l) => l.startsWith('此刻情绪') || l.startsWith('感觉现在大概') || l.startsWith('现在的情绪是') || l.startsWith('此刻我') || l.startsWith('我想怎么说') || l.startsWith('这一轮怎么写')
  /* 感受快照：**要么整行，要么没有**。它比别的行更怕被剪——
     剪掉尾巴就剩「（上一句落在我身上的样子：你说「…」，那一刻 慢 +0.1…」，
     一半材料读起来比没有更糟：像一句没说完的自言自语。 */
  const SNAPSHOT_TEST = (l) => l.startsWith('（上一句落在我身上') || /^（\d\d:\d\d 那会儿的读数/.test(String(l))
  const order = [
    ['examples', (l) => l.startsWith('## 我说话的样子')],
    ['guard', (l) => l.startsWith('不要列点')],
    ['drive', (l) => l.startsWith('需求缺口档位')],
    ['diary', (l) => l.startsWith('最近我自己写下的')],
    ['memory', (l) => l.startsWith('关于这句话，你能想起的事')],
    // 主动句排在记忆之后才丢：它是「已经决定要说的话」，又只有一行。
    // 以前排第一个丢，结果每轮都被预算先吃掉，commit_after_pack 下永远落不了账，
    // 队列里的消息只能等 ops 七天过期，等于这个功能静默死了（见 2026-11-05 的账）。
    ['proactive', (l) => l.startsWith('（你之前想主动说一句')],
    // 开环 / 续接 / 自发浮现排在记忆之后丢：它们是「自己先想起来的」，比一条泛记忆更该被说出来
    ['loop', (l) => l.startsWith('（你自己心里还挂着的事')],
    ['bridge', (l) => l.startsWith('（上次（')],
    // 收尾念头和潜台词都比「自己想起的事」更可丢：丢了只是正常聊
    ['closing', (l) => l.startsWith('（你有点想收尾了')],
    ['subtext', (l) => l.startsWith('（心里其实')],
    // 关系余量：比潜台词更可丢；丢了只是下一轮少一句「上一句有点硬」。
    ['residue', (l) => l.startsWith('（上一句你说得') || l.startsWith('（上一句你比平时')],
    // 情绪的方向：一行，丢了只是少个「这两天」的层次，不影响这一轮聊下去
    ['trend', (l) => l.startsWith('（这两天')],
    ['spontaneous', (l) => l.startsWith('（你心里忽然浮上来')],
    // 感受快照：比上面都晚丢（它是「刚才那一刻」的事实，不是装饰），
    // 但预算真紧的时候还是让位——而且只允许整行丢，不许剪半句（见 SNAPSHOT_TEST）。
    ['snapshot', (l) => SNAPSHOT_TEST(l)],
  ]
  for (const [name, test] of order) {
    if (total() <= cap) break
    const idx = parts.findIndex((l) => test(l))
    if (idx >= 0) dropAt(idx, name)
  }
  // 段级丢完还超：先砍日记（叙事，隔天还能补），再砍记忆；记忆留 2 条兜底。
  const trimBlock = (test, label, keep = 1) => {
    const idx = parts.findIndex((l) => test(l))
    if (idx < 0) return false
    const sub = String(parts[idx]).split('\n')
    if (sub.length <= 1) { dropAt(idx, label); return true }
    if (sub.length <= keep) return false
    let touched = false
    while (sub.length > keep && total() > cap) { sub.pop(); parts[idx] = sub.join('\n'); touched = true }
    // 一段被砍过就不再是完整注入；带 key 的行（落账用）不能算说过。
    if (touched && !removed.has(keys[idx])) removed.add(keys[idx])
    if (touched) dropped.push(label + '-lines')
    return touched
  }
  if (total() > cap) trimBlock((l) => l.startsWith('最近我自己写下的'), 'diary', 1)
  trimBlock((l) => l.startsWith('关于这句话，你能想起的事'), 'memory', 3)
  /* 快照：要么完整，要么没有。在 shrink 之前就整行拿掉——
     它是那种「剪一半就变味」的行（剩下「…那一刻 慢 +0.1…」，读起来像自言自语没说完）。 */
  if (total() > cap) {
    const si = parts.findIndex((l) => SNAPSHOT_TEST(l))
    if (si >= 0) dropAt(si, 'snapshot-full')
  }
  // 还超：不删情绪那一行，改削别的长行（关系数字、约束这类）。
  // 以前这里直接硬截，谁站得靠后就先烂；削长行等于把预算从「最占地方又不最要紧」的地方拿回来。
  // 第一轮只削非情绪行；真到极限才动情绪行，而且留 20 字底线——宁可说得短，不能没得说。
  if (total() > cap) {
    const shrink = (allowAffect) => {
      const list = parts
        .map((l, i) => ({ l, i }))
        .filter((x) => !x.l.startsWith('## ')
          && !SNAPSHOT_TEST(x.l)
          && x.l.length > (allowAffect ? 20 : 16)
          && (allowAffect || !AFFECT_TEST(x.l)))
        .sort((a, b) => b.l.length - a.l.length)
      for (const { i } of list) {
        if (total() <= cap) break
        const cur = parts[i]
        const needChars = Math.max(4, (total() - cap) * 2 + 2)
        const floor = allowAffect ? 20 : 12
        const keep = Math.max(floor, cur.length - needChars)
        if (keep >= cur.length) continue
        parts[i] = cur.slice(0, keep).replace(/\s+$/, '') + '…'
        // 削断了就不算完整说过：下一轮宁可重来，也别把半句记成落账。
        if (!removed.has(keys[i])) removed.add(keys[i])
        const tag = allowAffect ? 'shrink-affect' : 'shrink'
        if (!dropped.includes(tag)) dropped.push(tag)
      }
    }
    shrink(false)
    shrink(true)
  }
  let text = parts.join('\n')
  if (est(text) > cap) {
    text = text.slice(0, Math.max(0, cap * 2 - 1)).replace(/\s+$/, '') + '…'
    // 硬截断后整段都不可信，所有带 key 的行都不落账。
    for (const k of keys) removed.add(k)
    dropped.push('truncate')
  }
  const kept = new Set(keys.filter((k) => !removed.has(k)))
  return { text, tokens: est(text), dropped, kept, removed }
}

// 当前分类法（前端与提案用）
export function taxonomyInfo(db, aid) {
  try {
    const art = resolveActiveArtifact(db, aid, 'taxonomy')
    return { labels: affectLabels(db, aid), payload: art ? art.payload : null, artifact_id: art ? art.id : null }
  } catch {
    return { labels: affectLabels(db, aid), payload: null, artifact_id: null }
  }
}

/** 自动影子：每次调用把最老的一条 shadowed 提案推进一轮；没有就返回 null */
export function tickOneShadow(db, pid) {
  let row = null
  try { row = pid ? db.prepare("SELECT id FROM proposals WHERE id=? AND state='shadowed' AND shadow_done<shadow_total").get(pid) : db.prepare("SELECT id FROM proposals WHERE state='shadowed' AND shadow_done<shadow_total ORDER BY shadow_done ASC, created_at ASC LIMIT 1").get() } catch { row = null }
  if (!row) return null
  try {
    const out = shadowTick(db, row.id)
    return { id: row.id, out }
  } catch (e) {
    return { id: row.id, error: String((e && e.message) || e) }
  }
}

/**
 * 草案 + 模型建议名（只生成一次，写回 gate_trace.suggest）
 * 模型先去重：能给现有标签就建议归入；给不出才提议新词。
 */
const draftGate = new Map()
export async function draftsWithSuggestion(db, aid) {
  const last = Number(draftGate.get(aid) || 0)
  if (Date.now() - last < 60000) return listDrafts(db, aid)
  draftGate.set(aid, Date.now())
  const drafts = listDrafts(db, aid)
  const labels = affectLabels(db, aid)
  for (const d of drafts) {
    const t = targetById(d.target)
    if (!t) continue
    if (t.apply === 'param') {
      // 参数类不需要起名：进度够了直接按 next() 走 C4 自动执行
      try { promoteDraft(db, aid, d.id, {}) } catch (e) {
        const cur = (() => { try { return JSON.parse(d.gate_trace || '[]') } catch { return [] } })()
        const firstEv = cur[0] || {}
        firstEv.suggest = { ...(firstEv.suggest || {}), proposed: true, promote_error: String((e && e.message) || e) }
        db.prepare('UPDATE proposals SET gate_trace=? WHERE id=?').run(JSON.stringify([firstEv, ...cur.slice(1)]), d.id)
      }
      continue
    }
    let ev = []
    try { ev = JSON.parse(d.gate_trace || '[]') } catch { ev = [] }
    const first = ev[0] || {}
    if (first.suggest && first.suggest.proposed) continue
    if (first.suggest && first.suggest.retry_after && Date.now() < first.suggest.retry_after) continue
    const texts = (first.texts || []).slice(0, 10)
    const sys = '你是情绪分类助手。先判断这些样本能否归入现有标签；不能才提议新词。只输出 JSON：{"overlap":"none 或 现有标签之一","key":"小写英文 2-24 位","name":"中文名","definition":"一句话定义"}。'
    const user = JSON.stringify({ samples: texts, labels })
    let pick = null
    try { const raw = await model.complete({ system: sys, text: user }); pick = JSON.parse(String(raw).replace(/```[a-z]*/g, '')) } catch { pick = null }
    const validKey = pick && /^[a-z][a-z0-9_-]{1,23}$/.test(String(pick.key || ''))
    const suggest = {
      ...(first.suggest || {}),
      proposed: true,
      key: validKey ? String(pick.key) : '',
      name: pick && pick.name ? String(pick.name).slice(0, 12) : ((first.suggest && first.suggest.candidates && first.suggest.candidates[0]) || ''),
      definition: pick && pick.definition ? String(pick.definition).slice(0, 120) : '',
      overlap: pick && pick.overlap ? String(pick.overlap) : 'unknown',
    }
    first.suggest = suggest
    // 草案不需要人判：名字齐了且不重叠，直接提交成正式 C2 提案（走闸+影子），人只在最后批一次
    if (suggest.key && suggest.name && suggest.overlap === 'none') {
      try {
        const out = promoteDraft(db, aid, d.id, { key: suggest.key, name: suggest.name, definition: suggest.definition })
        d.autoPromoted = out.id
        d.state = 'promoted'
        continue
      } catch (e) {
        first.suggest = { ...suggest, proposed: false, promote_error: String((e && e.message) || e), retry_after: Date.now() + 600000 }
      }
    }
    const next = JSON.stringify([first, ...ev.slice(1)])
    db.prepare('UPDATE proposals SET gate_trace=? WHERE id=?').run(next, d.id)
    d.gate_trace = next
  }
  return drafts.filter((d) => d.state === 'draft')
}

// 提案目标进度：每个目标近窗口内攒了多少证据、够不够起草
export function targetProgress(db, aid) {
  const out = []
  for (const t of TARGETS) {
    let n = 0
    try {
      const since = new Date(Date.now() - Number(t.windowDays || 7) * 86400000).toISOString()
      n = Number(db.prepare('SELECT COUNT(*) n FROM events WHERE agent_id=? AND type=? AND created_at>=?').get(aid, t.signal, since).n || 0)
    } catch { n = 0 }
    let last = null
    try { last = (db.prepare('SELECT MAX(created_at) t FROM proposals WHERE agent_id=? AND target=?').get(aid, t.id) || {}).t || null } catch { /* ignore */ }
    out.push({ id: t.id, label: t.label, class: t.changeClass, progress: n, threshold: Number(t.threshold || 10), windowDays: Number(t.windowDays || 7), cooldownDays: Number(t.cooldownDays || 30), lastDraftAt: last })
  }
  return out
}

/**
 * 自己长：从它已经记住的事里，长出「喜欢 / 讨厌」的标签。
 *
 * 为什么不用正则硬抠：记忆条目是模型写过的自省总结，句式千变万化，
 * 正则捞出来的多半是「准确」「真实」这类一次性要求，会把偏好区污染成垃圾场。
 * 所以交给模型做一次收束，再由这里做严格过滤：
 *   ① 只增不减——已有的标签（含互相包含）一律跳过；
 *   ② tag 超过字数上限就截断，短于 2 字直接丢；
 *   ③ 一次最多长 limit 条，宁少勿滥；模型没接上就一条都不长，不瞎猜。
 *
 * @returns {Promise<{added:Array<{tag:string,aversion:number,why:string}>,reason:string,model:string,...}>}
 */
export async function growPreferences(db, aid, opt = {}) {
  active(db, aid)
  const t0 = Date.now()
  const limit = Math.max(1, Math.min(10, Number(opt.limit) || GROW_PER_RUN))
  const base = { added: [], considered: 0, skipped: 0, scanned: 0, ms: 0 }

  const existing = listPreferences(db, aid) || []
  const known = existing.map((p) => normTag(p.tag)).filter(Boolean)
  const mems = (listActiveMemories(db, aid) || []).slice(-GROW_SCAN)
  const lines = mems.map((m) => String(m.text || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
  base.scanned = lines.length
  if (!lines.length) return { ...base, reason: 'no_memory', model: 'idle', ms: Date.now() - t0 }

  // 没装 hooks 才问模型链：测试里的 growModelHook 本身就是「模型」，不该被状态挡掉
  if (!growModelHook.complete) {
    let status = null
    try { status = model.status() } catch { status = null }
    if (status && status.primary && status.primary !== 'ok') {
      return { ...base, reason: 'model_unavailable', model: String(status.primary), ms: Date.now() - t0 }
    }
  }

  const system = GROW_SYSTEM.replace('{known}', known.length ? known.slice(0, 40).join('、') : '（还没有）')
  let raw = ''
  try {
    const req = { system, text: lines.map((l) => '- ' + l.slice(0, 160)).join('\n') }
    raw = growModelHook.complete ? await growModelHook.complete(req) : await model.complete(req)
  } catch (e) {
    return { ...base, reason: 'model_error', error: String((e && e.message) || e).slice(0, 200), model: 'error', ms: Date.now() - t0 }
  }

  let parsed = null
  try { parsed = parseJsonLoose(raw) } catch { parsed = null }
  const list = Array.isArray(parsed && parsed.preferences) ? parsed.preferences : []
  const taken = new Set(known)
  const added = []
  let skipped = 0
  for (const p of list.slice(0, limit * 3)) {
    if (added.length >= limit) break
    const tag = Array.from(String((p && p.tag) || '').trim()).slice(0, LIMITS.preferenceTag).join('').trim()
    const n = normTag(tag)
    if (n.length < 2) { skipped++; continue }
    if ([...taken].some((k) => k.includes(n) || n.includes(k))) { skipped++; continue }
    const rawAv = Number(p && p.aversion)
    const aversion = Number.isFinite(rawAv) ? Math.max(0, Math.min(1, rawAv)) : 0.5
    addPreference(db, aid, { tag, aversion, origin: 'auto' })
    taken.add(n)
    added.push({ tag, aversion, why: String((p && p.why) || '').slice(0, 40) })
  }
  return {
    ...base,
    added,
    considered: list.length,
    skipped,
    reason: added.length ? 'ok' : 'nothing_new',
    model: 'ok',
    known: existing.length,
    ms: Date.now() - t0,
  }
}

/** 自动长的节奏：离上次够久、记忆也确实长了新的，才值得花一次模型调用 */
const GROW_EVERY_MIN = 30
const GROW_NEED_NEW = 3

/** 状态存在 flags 里，重启不丢；这两个 key 只给自动长用。 */
const GROW_FLAG_AT = 'grow.pref_last_at'
const GROW_FLAG_N = 'grow.pref_last_n'

/**
 * 该不该长：不看人点没点，看「时间够不够久」+「记忆长没长新的」。
 * 返回 {due, reason, count, since}，due 为真才值得调模型。
 */
export function growPrefsDue(db, aid, opt = {}) {
  const every = Math.max(1, Number(opt.everyMin) || GROW_EVERY_MIN) * 60000
  const need = Math.max(1, Number(opt.needNew) || GROW_NEED_NEW)
  let count = 0
  try { count = Number((memoryStats(db, aid) || {}).count || 0) } catch { count = 0 }
  const at = Number(getFlag(db, GROW_FLAG_AT) || 0)
  const seen = Number(getFlag(db, GROW_FLAG_N) || 0)
  const fresh = count - seen
  if (count < need) return { due: false, reason: 'too_few_memories', count, fresh }
  if (at && Date.now() - at < every) return { due: false, reason: 'too_soon', count, fresh, next_in_ms: every - (Date.now() - at) }
  if (fresh < need) return { due: false, reason: 'nothing_new', count, fresh }
  return { due: true, reason: 'due', count, fresh }
}

/**
 * 自动长一次（宿主定时器 / 夜间巩固调它）。
 * 不需要人点、也没有「取消」：长出来的条目 origin=auto，接口层一律不许删。
 */
export async function autoGrowPreferences(db, aid, opt = {}) {
  const gate = growPrefsDue(db, aid, opt)
  if (!gate.due) return { added: [], reason: gate.reason, gate, model: 'idle' }
  const out = await growPreferences(db, aid, opt)
  // 记账：失败也记时间，免得模型每次都被同一批记忆反复戳
  try {
    setFlag(db, GROW_FLAG_AT, Date.now())
    setFlag(db, GROW_FLAG_N, gate.count)
  } catch { /* 记账失败不影响这次结果 */ }
  return { ...out, gate }
}

/** 随意格式导入：任意文本 → 大模型整理成导入模板 → 落库 → 返回采用率 */
export async function importFreeform(db, body = {}) {
  const text = String(body.text || '').slice(0, 20000)
  if (text.trim().length < 10) err(400, 'INVALID_ARGUMENT', '文件内容太少，无法提取')
  const system = [
    '你是意识体的导入助手。从用户给的任意文件中提取“意识体设定”，只输出一个 JSON 对象，不要解释。',
    'JSON 模板：',
    '{"name":"名字","summary":"一句话设定",',
    '"memory":[{"text":"要记住的事","type":"fact|episode|appraisal|reflection"}],',
    '"persona":{"axis.ei":0.5,"axis.sn":0.5,"axis.tf":0.5,"axis.jp":0.5,"axis.sensitivity":0.5,"values.weight":0.5},',
    '"preferences":[{"tag":"喜欢/讨厌的东西","aversion":0}],',
    '"taboos":[{"text":"禁忌","level":"soft|root"}],',
    '"relations":[{"name":"对方称呼","kind":"owner|acquaintance|stranger","closeness":0.5,"trust":0.5,"dependence":0.2,"root":false,"notes":""}]}',
    '要求：能填尽填；模板里没有的信息按文本合理推断补全；推断不出的用默认值（五轴全 0.5，关系 0.5/0.5/0.2）。',
    'memory 最多 20 条，每条 ≤200 字。不要编造文件里没有的具体隐私事实（地址、电话、证件号一律不要写）。',
  ].join('\n')
  let raw = ''
  try {
    const req = { system, text: '文件名：' + String(body.filename || '') + '\n内容：\n' + text }
    raw = freeformModelHook.complete ? await freeformModelHook.complete(req) : await model.complete(req)
  } catch (e) {
    err(502, 'MODEL_UNAVAILABLE', '模型调用失败：' + String(e && e.message ? e.message : e))
  }
  let parsed = null
  try { parsed = parseJsonLoose(raw) } catch { parsed = null }
  if (!parsed || typeof parsed !== 'object') err(400, 'INVALID_ARGUMENT', '模型没有返回可解析的 JSON 模板')
  if (parsed.overlap !== undefined && !parsed.memory && !parsed.persona) {
    err(400, 'MODEL_UNAVAILABLE', '当前模型只返回占位结果，无法提取（可能没接上大模型）')
  }

  const baseName = String(body.name || parsed.name || String(body.filename || '').replace(/\.[^.]+$/, '') || '随意导入').trim().slice(0, 40) || '随意导入'
  let name = baseName
  let k = 1
  while (db.prepare("SELECT 1 FROM agents WHERE name=? AND status!='soft_deleted'").get(name)) {
    k++
    name = baseName + ' · 导入' + (k > 2 ? ' ' + (k - 1) : '')
  }
  const aid = nid('agt_')
  db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?, 'daily', 'active', ?, 1)").run(aid, name, now())
  seedState(db, aid)

  const personaOk = /^(axis\.(ei|sn|tf|jp|sensitivity)|values\.\w+)$/
  const memTypes = ['fact', 'episode', 'appraisal', 'reflection']
  const counts = { memory: 0, persona: 0, preferences: 0, taboos: 0, relations: 0 }
  let tried = 0
  let chars = 0
  try {
    for (const m of (Array.isArray(parsed.memory) ? parsed.memory : []).slice(0, 20)) {
      tried++
      const t = String(m && m.text || '').trim().slice(0, 200)
      if (!t) continue
      const type = memTypes.includes(m.type) ? m.type : 'fact'
      addMemory(db, aid, { text: t, type })
      counts.memory++; chars += t.length
    }
    for (const [p, v] of Object.entries(parsed.persona && typeof parsed.persona === 'object' ? parsed.persona : {})) {
      if (!personaOk.test(p)) continue
      tried++
      const n = Number(v)
      if (!Number.isFinite(n)) continue
      setPersona(db, aid, p, { value: Math.max(0, Math.min(1, n)) }, 'user')
      counts.persona++; chars += String(n).length
    }
    for (const p of (Array.isArray(parsed.preferences) ? parsed.preferences : []).slice(0, 30)) {
      tried++
      const tag = String(p && p.tag || '').trim().slice(0, LIMITS.preferenceTag)
      if (!tag) continue
      addPreference(db, aid, { tag, aversion: Math.max(0, Math.min(1, Number(p.aversion) || 0)), origin: 'auto' })
      counts.preferences++; chars += tag.length
    }
    for (const t of (Array.isArray(parsed.taboos) ? parsed.taboos : []).slice(0, 20)) {
      tried++
      const tx = String(t && t.text || '').trim().slice(0, LIMITS.tabooText)
      if (!tx) continue
      addTaboo(db, aid, { text: tx, level: t.level === 'root' ? 'root' : 'soft', origin: 'auto' })
      counts.taboos++; chars += tx.length
    }
    for (const r of (Array.isArray(parsed.relations) ? parsed.relations : []).slice(0, 20)) {
      tried++
      const nm = String(r && r.name || '').trim().slice(0, LIMITS.relationName)
      if (!nm) continue
      const kind = ['owner', 'acquaintance', 'stranger'].includes(r.kind) ? r.kind : 'acquaintance'
      upsertRelation(db, aid, {
        name: nm, kind,
        closeness: Math.max(0, Math.min(1, Number(r.closeness ?? 0.5))),
        trust: Math.max(0, Math.min(1, Number(r.trust ?? 0.5))),
        dependence: Math.max(0, Math.min(1, Number(r.dependence ?? 0.2))),
        root: !!r.root, notes: String(r.notes || '').slice(0, 200),
      })
      counts.relations++; chars += nm.length + String(r.notes || '').length
    }
  } finally {
    db.prepare("UPDATE agents SET status='paused' WHERE id=?").run(aid)
  }
  const adopted = Object.values(counts).reduce((a, b) => a + b, 0)
  if (!adopted) {
    err(400, 'INVALID_ARGUMENT', '没有从文件里提取到可导入的信息')
  }
  const total = Math.max(adopted, tried)
  return {
    id: aid, name,
    imported: counts,
    adoption: { rate: +(adopted / Math.max(1, total)).toFixed(3), adopted, total, chars },
    summary: String(parsed.summary || '').slice(0, 300),
  }
}

/** 随意格式导入记忆：任意文本 → 大模型整理成记忆条目 → 写进这个意识体 → 返回采用率 */
export async function importLooseMemory(db, aid, body = {}) {
  active(db, aid)
  const text = String(body.text || '').slice(0, 20000)
  if (text.trim().length < 10) err(400, 'INVALID_ARGUMENT', '内容太少，至少 10 个字')
  const system = [
    '你是记忆仓库的导入助手。从用户给的任意文本里，整理出「值得这个意识体长期记住的事」，只输出一个 JSON 对象，不要解释。',
    'JSON 模板：',
    '{"memory":[{"text":"一条记忆","type":"fact|episode|appraisal|reflection"}],"summary":"这次整理了什么"}',
    '要求：能填尽填；一条只说一件事，每条 ≤200 字，最多 60 条。',
    'type：fact=稳定事实（身份、喜好、关系、确定发生过的事）；episode=一次具体的经过；appraisal=对某件事的评价或感受；reflection=总结、自省。',
    '只写文本里有的东西，不要编造；地址、电话、证件号、密码一律不要写。',
    '如果这段文本里没有值得长期记住的事，输出 {"memory":[]}。',
  ].join('\n')
  let raw = ''
  try {
    const req = { system, text: '文件名：' + String(body.filename || '') + '\n内容：\n' + text }
    raw = freeformModelHook.complete ? await freeformModelHook.complete(req) : await model.complete(req)
  } catch (e) {
    err(502, 'MODEL_UNAVAILABLE', '模型调用失败：' + String(e && e.message ? e.message : e))
  }
  let parsed = null
  try { parsed = parseJsonLoose(raw) } catch { parsed = null }
  if (!parsed || typeof parsed !== 'object') err(400, 'INVALID_ARGUMENT', '模型没有返回可解析的 JSON 模板')
  if (parsed.overlap !== undefined && !parsed.memory) {
    err(400, 'MODEL_UNAVAILABLE', '当前模型只返回占位结果，无法整理（可能没接上大模型）')
  }

  const types = ['fact', 'episode', 'appraisal', 'reflection']
  let tried = 0, added = 0, dup = 0, chars = 0
  for (const m of (Array.isArray(parsed.memory) ? parsed.memory : []).slice(0, 60)) {
    tried++
    const t = String((m && m.text) || '').trim().slice(0, 200)
    if (!t) continue
    try {
      const r = addMemory(db, aid, {
        text: t,
        type: types.includes(m.type) ? m.type : 'fact',
        source: 'import',
      })
      if (r && r.duplicate) dup++
      else { added++; chars += t.length }
    } catch { /* 单条失败不影响整批 */ }
  }
  if (!added && !dup) err(400, 'INVALID_ARGUMENT', '没有从文件里整理出可导入的记忆')
  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(now(), aid)
  return {
    imported: { memory: added, duplicate: dup, skipped: Math.max(0, tried - added - dup) },
    adoption: { rate: +(added / Math.max(1, tried)).toFixed(3), adopted: added, total: tried, chars },
    summary: String(parsed.summary || '').slice(0, 300),
  }
}

