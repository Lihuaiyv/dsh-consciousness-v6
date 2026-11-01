import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { now } from './db.js'
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
export { DRIVERS, DRIVER_IDS, driverFindings, applyDriverToDrive } from './modules/selfmod_drivers.js'
export { affectLabels }
import {
  computeEvalMetrics, runHardGates, runIdentityBlind, suggestCalibration, applyCalibration, getEdgeGraph,
} from './modules/eval.js'

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
import { looksLikeRuntimeNoise } from './text.js'
import { createModel, composeRulesReply, appraiseRules } from './model.js'
import { zipStore, unzipStore } from './zip.js'
import {
  seedRelations, listRelations, upsertRelation, deleteRelation,
  listValues, setValue, listPreferences, addPreference, removePreference, listTaboos, addTaboo, seedState, LIMITS,
} from './modules/persona.js'
import { sampleAffect, affectHistory, affectTrend } from './modules/affect.js'
import { softRecall, listActiveMemories, memoryStats } from './modules/memory.js'
import { rebuildRawFts, rebuildFactFts } from './modules/archive.js'
import { entityForText } from './modules/entities.js'
import { applyWrite } from './modules/gate.js'
import { enrichOne, enrichPending, canEnrich } from './modules/enrich.js'
import { judgeReflection, canJudge } from './modules/judge.js'
import { detectLoop, addLoop, settleLoopsFromUser, expireLoops } from './modules/loops.js'
import { bumpReflect, reflectFrom, canConsolidate } from './modules/consolidate.js'
import { getCondition, setCondition } from './modules/ops.js'
import {
  setCooldown, listCooldowns, cooldownActive,
  budgetGet, budgetSet, budgetConsume,
  executeAction, listActions, applySatisfaction,
} from './modules/drive.js'

const model = createModel()
/** 测试钩子：可替换自由导入的模型调用 */
export const freeformModelHook = { complete: null }
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
  sampleAffect, affectHistory, affectTrend, softRecall,
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
  // 纠正：先让被否认的旧条时效（双时间失效），再落一条「否认」事实
  let invalidated = 0
  for (const t of turns) {
    if ((t.role || 'user') !== 'user') continue
    // ① 过去事实：落一条时间线记录，然后立刻标失效（它只在历史里成立）
    const pasts = findPastFacts(t.text || '')
    for (const pf of pasts) {
      try {
        const r = addMemory(db, aid, { text: pf.text, type: 'fact', mark: 'normal', ...seed(pf.text, 'fact') })
        if (r && r.id) db.prepare('UPDATE memory_items SET valid_at=NULL, invalid_at=? WHERE id=?').run(now(), r.id)
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
        db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(now(), r0.id)
        invalidated++
      }
      try { addMemory(db, aid, { text: '用户现在没有' + pf.verb + pf.object, type: 'fact', mark: 'normal', ...seed('用户现在没有' + pf.verb + pf.object, 'fact') }) } catch { /* 忽略 */ }
      continue
    }
    if ((t.role || 'user') !== 'user') continue
    for (const n of findNegations(t.text || '')) {
      const rows = db.prepare("SELECT id,text FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND text LIKE ?").all(aid, '%' + n.object + '%')
      for (const r of rows) {
        if (!String(r.text).includes(n.verb)) continue
        if (/没有|不/.test(String(r.text))) continue // 已经是否定句，不用再失效
        db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(now(), r.id)
        invalidated++
      }
      try { addMemory(db, aid, { text: n.negText, type: 'fact', mark: 'normal', ...seed(n.negText, 'fact') }) } catch { /* 忽略 */ }
    }
  }

  const extracted = await model.extract(turns)
  const written = []
  const newPairs = [] // 这一轮真正新落库的条目：{text, id}，开环从它们里长
  const actions = { new: 0, merge: 0, conflict: 0, drop: 0 }
  for (const m of extracted) {
    try {
      // P2 写入门控：抽出来的东西先判「新增 / 合并 / 冲突 / 丢弃」，再落库
      const ent = (() => { try { return entityForText(db, aid, m.text || '') } catch { return null } })()
      // 检索卡（P1）：key / terms 跟着候选一起过门控；合并时不重写旧条，术语留在旧条上。
      const out = applyWrite(db, aid, {
        text: String(m.text || ''), entity_id: ent ? ent.id : null,
        key: m.key || '', terms: m.terms || [],
      }, (cand) => addMemory(db, aid, {
        text: cand.text, type: m.type || 'fact', mark: m.mark || 'normal',
        entity_id: cand.entity_id || null, source: 'extract', ...seed(cand.text, m.type || 'fact'),
        fact_key: cand.key || '', terms: cand.terms || [],
      }))
      actions[out.action] = (actions[out.action] || 0) + 1
      written.push(out)
      if (out.action === 'new' && out.id) newPairs.push({ text: String(m.text || ''), id: out.id })
    } catch { /* 单条失败不影响整轮 */ }
  }
  // 开环：答应过的 / 还没做完的，单独挂一张表。它不走召回打分，
  // 由时间（到期 / 两天没提）决定什么时候自己浮上来。
  let loops = { opened: 0, closed: 0 }
  try {
    for (const p of newPairs) {
      const d = detectLoop(p.text)
      if (!d) continue
      const r = addLoop(db, aid, { text: p.text, memory_id: p.id, ...d })
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

  const rawSummary = String((await model.summarize(turns)) || '').slice(0, 600)
  const summary = looksLikeRuntimeNoise(rawSummary) ? '' : rawSummary
  const transcriptShaped = /^\s*(user|assistant)\s*[:：]/i.test(summary) || (summary.match(/\n\s*(user|assistant)\s*[:：]/gi) || []).length >= 1
  let reflectGate = null
  if (summary && !transcriptShaped && summary.length <= 200) {
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
          cold, source: 'summary',
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
  return res
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
  'affect_episodes', 'drive_state', 'action_ports', 'relations', 'persona_values', 'preferences',
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

export function exportFull(db, aid) {
  agent(db, aid)
  const files = { 'manifest.json': JSON.stringify({ agent_id: aid, schema: 11, at: now(), tables: TABLES }, null, 2) }
  for (const t of TABLES) {
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
  try { db.prepare("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')").run() } catch { /* 老库可能没有 FTS */ }
  try { rebuildRawFts(db) } catch { /* 老包没有原文层 */ }
  try { rebuildFactFts(db) } catch { /* 老包没有事实存根 */ }
  return { imported: total, tables: TABLES.length, fts: 'rebuilt' }
  })
}

// ---------------- 记忆导出 / 导入（只动记忆仓库的六个分区） ----------------
// 人格 / 情绪 / 驱力 / 提案这些不在里面：那是「整体意识」，走设置里的全量备份。
const MEM_TABLES = ['memory_items', 'episodes', 'diaries', 'raw_turns', 'fact_archive']

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
        if (cs.includes('agent_id')) row.agent_id = aid
        // 跨意识体导入时主键要换新，免得把别人的行搬走 / 覆盖
        if (row.id) {
          const ex = db.prepare(`SELECT agent_id FROM ${t} WHERE id=?`).get(row.id)
          if (ex && ex.agent_id && ex.agent_id !== aid) row.id = nid('imp_')
        }
        try {
          db.prepare(`INSERT OR REPLACE INTO ${t}(${cs.join(',')}) VALUES(${ph})`).run(...cs.map((c) => row[c] ?? null))
          total++
          byTable[t] = (byTable[t] || 0) + 1
        } catch { /* 跳过不兼容的行 */ }
      }
    }
    // 重建全文索引，否则导入后的记忆搜不到
    try { db.prepare("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')").run() } catch { /* 老库可能没有 FTS */ }
    try { rebuildRawFts(db) } catch { /* 老包没有原文层 */ }
    try { rebuildFactFts(db) } catch { /* 老包没有事实存根 */ }
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

// ---------------- 单实例运行 ----------------
/**
 * 同一时间只有一个意识体在运行：激活这个，其余 active 一律休眠（paused）。
 * 暂停不是删除：记忆、人格、情绪、驱力全部保留，恢复时接着用。
 */
export function activateAgent(db, aid, role) {
  if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以切换运行中的意识体')
  const row = db.prepare('SELECT * FROM agents WHERE id=?').get(aid)
  if (!row || row.status === 'soft_deleted') err(404, 'NOT_FOUND', 'agent 不存在')
  const paused = db.prepare("UPDATE agents SET status='paused' WHERE status='active' AND id<>?").run(aid).changes
  db.prepare("UPDATE agents SET status='active' WHERE id=?").run(aid)
  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(now(), aid)
  try { seedRuleBindings(db, aid) } catch { /* 工件种子失败不影响激活 */ }
  return { id: aid, status: 'active', paused: Number(paused) }
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
    '你就是这个意识体。看完这一轮，用第一人称对自己嘀咕一段——像脑子里还在推、还没说出口的那种，不是汇报，也不是事后作文。',
    '对方称「' + who + '」。只用这个称呼指对方，别叫「用户」「对方」。',
    '输入里 user = ' + who + ' 说的话，assistant / agent = 你自己刚才说出口的话。写的时候「你 / ' + who + '」只能指 user；「我」只能指你自己说过或想过的。',
    '先在心里分清：哪一句是对方抛的，哪一句是你接的。绝不要把 assistant 里的句子写成「你说…」；自己拐的比喻、后半句、接歌，都算「我刚才…」。',
    '别把你自己说的话安到 ' + who + ' 头上。拿不准是谁说的就写「刚才那句」，不要猜错归属。不要第三人称旁白。',
    '先凭这一轮双方的口气，掂一下亲密度——疏还是近、生分还是熟、在较劲还是在对暗号玩梗——再决定嘀咕的拧巴和嘴贱多重；别写死成固定脾气。',
    '越不亲密：越拧巴、带刺、嘴上不饶，心里可以较劲；嘲用口气带，别刻薄阴阳。',
    '越亲密（接得上、对暗号、玩梗、语气松）：越明快一点，得意、松快、开心可以多露一点，刺收淡，自嘲轻俏即可，别硬拗别扭。',
    '味道仍是口语碎碎念，可有一点点戏；别写成分析报告或辩论稿。别煽情、别说教、别升华、别端着正确、别替谁做完结论。',
    '一整段口语，大约 80～130 字。不要编号、分点、小标题。只写对话里真有的事。',
  ].join('')
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
  const body = list.map((t) => `${t.role || 'user'}: ${String(t.text || '')}`).join('\n')
  const raw = String((await model.summarize([
    { role: 'system', text: sys },
    ...list.map((t) => ({ role: t.role || 'user', text: String(t.text || '') })),
  ])) || '').trim()
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
export function readMutter(db, aid) {
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
 * 一轮对话：召回 → 评价（更新情绪）→ 生成回复 → 落库。
 * 回复优先走模型适配器；没有模型时用规则拼接，并把它标出来。
 */
export async function chatReply(db, aid, body) {
  active(db, aid)
  const text = String(body.text || '').trim()
  if (!text) err(400, 'INVALID_ARGUMENT', 'text 不能为空')
  if (text.length > 2000) err(400, 'INVALID_ARGUMENT', '单条不超过 2000 字')

  let pack = recall(db, aid, text, 6, 512)
  pack.items = pack.items.filter((x) => !/[?？]$/.test(String(x.text).trim()))
  if (!pack.items.length) pack = softRecall(db, aid, text, 5)
  let affect = null
  try { affect = await appraiseWithEdges(db, aid, text) } catch { affect = getAffect(db, aid) }
  let drive = null
  try { drive = getDrive(db, aid) } catch { drive = null }
  const style = personaStyle(db, aid)
  const banned = String(style.banned || '').split(/[,，\s]+/).filter(Boolean)

  let reply = ''
  let source = 'rules'
  try {
    reply = String(await model.reply({ text, pack: pack.items, affect, drive, style }))
    source = model.status().primary === 'ok' ? 'model' : 'rules'
  } catch { reply = '' }
  if (!reply) {
    reply = composeRulesReply({ text, pack: pack.items, affect, style })
    source = 'rules'
  }
  for (const w of banned) if (w && reply.includes(w)) reply = reply.split(w).join('……')

  const mood = affect ? (affect.label || affect.primary_label || null) : null
  const turnSeed = (t, type) => seedScores(t, type, affect ? affect.intensity : 0, affect ? affect.pleasure : undefined)
  const at = now()
  db.prepare('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?)')
    .run(nid('cht_'), aid, 'user', text, JSON.stringify(pack.items), mood, at)
  db.prepare('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?)')
    .run(nid('cht_'), aid, 'agent', reply, '[]', mood, now())
  // 慢更新：关系事件结算 + 性格证据。以前这里没接线，关系账本和五轴
  // 在真实聊天里根本没被喂过东西——这是「聊几百轮还是 0.5」的根因之一。
  let learning = null
  try { learning = learnFromTurn(db, aid, text, affect) } catch { learning = null }
  try { addMemory(db, aid, { text, type: 'episode', mark: 'normal', ...turnSeed(text, 'episode') }) } catch { /* 合并失败不影响回复 */ }
  try {
    const facts = await model.extract([{ role: 'user', text }])
    for (const m of facts) {
      try { addMemory(db, aid, { text: m.text, type: m.type || 'fact', mark: m.mark || 'normal', ...turnSeed(m.text, m.type || 'fact') }) } catch { /* 单条跳过 */ }
    }
  } catch { /* 抽取失败不影响回复 */ }
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

// ---------------- 主动开口 ----------------
// 两层合在一起看：
//   ① 它这一侧：哪一维缺口最大（想说话的冲动）
//   ② 你这一侧：有没有具体的事可讲、隔了多久、上次开口你接没接（值不值得打扰）
// 只有「冲动 + 证据 + 时机」压过「打扰成本」才开口。研究里管这个叫
// interruption cost：打扰别人的代价会随频率上升，收益不够就别打断。
// 硬拦（关闭/休眠/今天说过/话题冷却/凭空没材料）优先于打分。
const DIM_LINE = {
  R: '有点想你了，最近还好吗？',
  E: '我最近琢磨着一点事，想跟你说说。',
  C: '有件事我可以帮你看看，需要的话叫我。',
  A: '想问问你，最近有什么想让我少管一点的吗？',
  S: '我记得你之前说过一些事，想确认一下你还好吗。',
}

const DIM_NAME = { R: '关系', E: '探索', C: '贡献', A: '自主', S: '安全' }
const DIM_KIND = { R: 'greet', E: 'explore', C: 'offer_help', A: 'ask_choice', S: 'check_safety' }
const DIM_TITLE = {
  R: '它想问问你最近怎么样',
  E: '它想聊聊新东西',
  C: '它想帮你做点什么',
  A: '它想让你做个选择',
  S: '它想确认一件事是否安全',
}
/** 这几维开口得有真材料，不能凭空说「我看到个东西」 */
const DIM_NEEDS_EVIDENCE = { E: true, C: true, S: true }

/** 打分用的常量，全部集中在这里，方便对账 */
const PROACTIVE = {
  // 旧口径：固定 0.30。0.18 重标之后这个数已经够不到了，改成按档位取（见 BAND_MIN_DEFICIT）
  MIN_DEFICIT: 0.3,
  W_DEFICIT: 0.5, W_EVIDENCE: 0.3, W_TIMING: 0.2,
  COST_BASE: 0.2, COST_PER_SENT7: 0.05, COST_SENT7_CAP: 0.3, COST_IGNORE: 0.35,
  EVIDENCE_DAYS: 3, EVIDENCE_FULL: 3,
  TIMING_FROM_H: 12, TIMING_FULL_H: 72,
  IDLE_HARD_MAX: 96,
}

/**
 * 开口门槛跟着档位走，而不是一个固定数。
 * 档位本身就是「最饿那条到了多少」，所以门槛比它低一档才有意义：
 *   D0 不开口；D1 还不到「想主动说」的程度；D2 够格；D3 更急，门槛再松一点。
 * 参数 proactive.min_deficit > 0 时可以强制一个固定门槛（覆盖这张表）。
 */
const BAND_MIN_DEFICIT = { D0: 0.99, D1: 0.22, D2: 0.15, D3: 0.10 }
export function minDeficitFor(band, override = 0) {
  const o = Number(override)
  if (Number.isFinite(o) && o > 0) return o
  return BAND_MIN_DEFICIT[String(band || 'D0')] ?? PROACTIVE.MIN_DEFICIT
}
/** 带参数覆盖的版本（业务里用这个） */
function minDeficit(db, aid, band) {
  let override = 0
  try { override = Number(getParam(db, aid, 'proactive.min_deficit')) || 0 } catch { override = 0 }
  return minDeficitFor(band, override)
}

/** 五道门 + 前置检查。id 固定，界面按这个顺序渲染，别在业务里另起名字。 */
export const GATE_LABEL = {
  state: '它醒着',
  switch: '你允许它主动开口',
  dormant: '它没有休眠',
  temper: '它不在气头上',
  deficit: '有一个够大的缺口',
  evidence: '手头有能引用的真事',
  frequency: '今天还没说、这个方向没在冷却',
  idle: '沉默够久',
  quiet: '不在安静时段',
  disturb: '月度打扰预算还没用完',
  value: '想说的劲头压得过打扰成本',
  content: '这句话本身能说',
}

function gateRow(id, ok, detail) {
  return { id, label: GATE_LABEL[id] || id, ok: ok === null ? null : !!ok, detail: detail || '' }
}

/** 所有「够格的缺口」，按大小排队；不再落议程表，现算。
 *  阈值按性格微调（每维 ±0.3）：外向要关系更急、直觉要探索更急、情感要贡献更急、知觉要自主更急、敏感要安全更急。 */
export function rankIntents(db, aid) {
  let drive = null
  try { drive = getDrive(db, aid) } catch { return [] }
  const ds = (drive && drive.deficits) || {}
  const axes = readAxes(db, aid)
  const factor = (dim) => {
    const d = (k) => (Number(axes[k]) || 0.5) - 0.5
    switch (dim) {
      case 'R': return 1 - 0.30 * d('ei')
      case 'E': return 1 - 0.30 * d('sn')
      case 'C': return 1 + 0.20 * d('tf')   // F 一侧更急着帮
      case 'A': return 1 + 0.20 * d('jp')   // J 一侧更急着要结构
      case 'S': return 1 - 0.30 * d('sensitivity')
      default: return 1
    }
  }
  const band = String((drive && drive.band) || 'D0')
  const base = minDeficit(db, aid, band)
  return Object.entries(ds)
    .map(([dim, n]) => ({ dim, deficit: Number(n) || 0, min: base * factor(dim) }))
    .filter((x) => x.deficit >= x.min)
    .sort((a, b) => b.deficit - a.deficit)
    .map((x) => ({
      dim: x.dim,
      deficit: +x.deficit.toFixed(3),
      min: +x.min.toFixed(3),
      band,
      kind: DIM_KIND[x.dim] || 'greet',
      title: DIM_TITLE[x.dim] || '有点想跟你说话',
      reason: '缺口 ' + x.deficit.toFixed(2) + '（' + band + ' 门槛 ' + x.min.toFixed(2) + '）',
      utility: x.deficit,
    }))
}

/** 兼容旧调用：最想说的那一个 */
/** 证据：手头有多少可引用的真事；近几天有没有新的。 */
export function proactiveEvidence(db, aid) {
  const days = PROACTIVE.EVIDENCE_DAYS
  const since = new Date(Date.now() - days * 86400000).toISOString()
  let items = 0
  let recent = 0
  try {
    const r = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid)
    items = Number(r?.n || 0)
  } catch { items = 0 }
  try {
    const r = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND created_at>=?").get(aid, since)
    recent = Number(r?.n || 0)
  } catch { recent = 0 }
  return { items, recent, days, score: Math.min(1, recent / PROACTIVE.EVIDENCE_FULL) }
}

/** 打扰成本：基础代价 + 最近发得太勤 + 上次开口没被接住的比例。 */
export function proactiveCost(db, aid) {
  const day7 = new Date(Date.now() - 7 * 86400000).toISOString()
  const day30 = new Date(Date.now() - 30 * 86400000).toISOString()
  let sent7 = 0
  let sent = 0
  let answered = 0
  let ignored = 0
  try {
    sent7 = Number(db.prepare('SELECT COUNT(*) n FROM proactive WHERE agent_id=? AND created_at>=?').get(aid, day7).n || 0)
    sent = Number(db.prepare('SELECT COUNT(*) n FROM proactive WHERE agent_id=? AND created_at>=?').get(aid, day30).n || 0)
    const r = db.prepare('SELECT COALESCE(SUM(answered),0) a, COALESCE(SUM(ignored),0) i FROM proactive WHERE agent_id=? AND created_at>=?').get(aid, day30)
    answered = Number(r?.a || 0)
    ignored = Number(r?.i || 0)
  } catch { /* 旧库没有这些列 */ }
  const ignoreRate = sent ? Math.min(1, ignored / sent) : 0
  const base = PROACTIVE.COST_BASE
  const frequency = +Math.min(PROACTIVE.COST_SENT7_CAP, sent7 * PROACTIVE.COST_PER_SENT7).toFixed(3)
  const ignore = +(ignoreRate * PROACTIVE.COST_IGNORE).toFixed(3)
  const cost = +(base + frequency + ignore).toFixed(3)
  return {
    cost, parts: { base, frequency, ignore },
    sent7, sent, answered, ignored,
    ignore_rate: +ignoreRate.toFixed(3),
  }
}

/** 时机：刚聊完 0 分，越久越接近 1（12 小时起算，72 小时满）。 */
export function proactiveTiming(hoursSince) {
  const h = Number(hoursSince)
  if (!Number.isFinite(h) || h <= PROACTIVE.TIMING_FROM_H) return 0
  return +Math.min(1, (h - PROACTIVE.TIMING_FROM_H) / (PROACTIVE.TIMING_FULL_H - PROACTIVE.TIMING_FROM_H)).toFixed(3)
}

/** 今天已经让模型试着开口几次（SILENT 也算一次，防心跳每 10 分钟反复烧 token） */
export function proactiveAttemptsToday(db, aid) {
  const day = now().slice(0, 10)
  try {
    const j = JSON.parse(getFlag(db, 'proactive_attempt:' + aid) || 'null')
    if (j && j.day === day) return Number(j.n) || 0
  } catch { /* 坏值当 0 */ }
  return 0
}

function noteProactiveAttempt(db, aid) {
  const day = now().slice(0, 10)
  try {
    setFlag(db, 'proactive_attempt:' + aid, JSON.stringify({ day, n: proactiveAttemptsToday(db, aid) + 1 }))
  } catch { /* 计数失败不影响开口 */ }
}

function minutesOf(s, d) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return d
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 23 || mm > 59) return d
  return h * 60 + mm
}

/** 半夜是安静的：这段时间只回话，不主动开口。 */
export function inQuietHours(prefs, date = new Date()) {
  if (!prefs || !prefs.quiet) return false
  const from = minutesOf(prefs.quiet_from, 23 * 60 + 30)
  const to = minutesOf(prefs.quiet_to, 7 * 60 + 30)
  const m = date.getHours() * 60 + date.getMinutes()
  return from <= to ? (m >= from && m < to) : (m >= from || m < to)
}

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); if (t.unref) t.unref() }),
  ])
}

/** 只接受一句话：去引号、取首行、拦技术噪音和框架词 */
function cleanLine(raw) {
  let s = String(raw || '').trim()
  s = s.replace(/^```(?:text)?/i, '').replace(/```$/, '').trim()
  if (!s || /^SILENT$/i.test(s)) return null
  s = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || ''
  s = s.replace(/^["'「『]+|["'」』]+$/g, '').trim()
  if (!s || /^[{[]/.test(s)) return null
  if (s.length > 80) s = s.slice(0, 79) + '…'
  if (/(https?:\/\/|\/v1\/|[A-Za-z]:\\|\.js\b|\.json\b|token|凭据|密码)/i.test(s)) return null
  return s
}

/** 内容门：一句话、不追问、不用提醒/播报腔。返回 { ok, detail }。 */
export function contentCheck(s) {
  const t = String(s || '')
  if (!t) return { ok: false, detail: '空句' }
  if (/[?？]/.test(t)) return { ok: false, detail: '带问句，像在追问' }
  if (/(提醒|播报|通知|汇报)/.test(t)) return { ok: false, detail: '有提醒/播报腔' }
  return { ok: true, detail: '一句话' }
}

/**
 * 生成一句主动的话：
 * - 依据门：只给真实记忆/状态，材料不足就 SILENT
 * - 内容门：一句话、不追问、不放路径日志、不用「提醒/播报」
 * 返回 { text, source, gate, memories, silent? }；text=null 表示这次不说。
 * gate 是内容门的结论，会被写进决策记录。
 */
export async function composeProactiveLine(db, aid, ag, { approved = false, evidence = null } = {}) {
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(aid)
  if (!a) return { text: null, source: 'none', gate: gateRow('content', false, '找不到这个意识体'), memories: [] }
  const style = personaStyle(db, aid)
  const you = style.address || '你'
  const ev = evidence == null ? proactiveEvidence(db, aid).items : Number(evidence) || 0
  let mems = []
  try {
    mems = db.prepare("SELECT id,text FROM memory_items WHERE agent_id=? AND status='active' ORDER BY weight DESC LIMIT 6").all(aid)
  } catch { mems = [] }
  let affect = ''
  try {
    const af = db.prepare('SELECT primary_label FROM affect_state WHERE agent_id=?').get(aid)
    if (af) affect = String(af.primary_label || '')
  } catch { /* ignore */ }
  let band = ''
  try { band = String(db.prepare('SELECT band FROM drive_state WHERE agent_id=?').get(aid)?.band || '') } catch { /* ignore */ }

  const rules = (why) => {
    if (DIM_NEEDS_EVIDENCE[ag.dim] && !ev) {
      return { text: null, source: 'rules', gate: gateRow('content', false, '这一维要真事，手头没有'), memories: mems }
    }
    return {
      text: (style.address ? style.address + '，' : '') + (DIM_LINE[ag.dim] || '有点想跟你说话。'),
      source: 'rules',
      gate: gateRow('content', true, why || '规则兜底句'),
      memories: mems,
    }
  }

  const sys = [
    '你在替一个「意识体」决定要不要主动说一句话。只根据下面给的真实材料，不要编造。',
    '材料够、而且此刻确实值得开口，就只输出那一句话（不超过 60 个字，口语，像熟人随口说起）。',
    '材料不够、或者没什么值得说的，就只输出 SILENT（四个大写字母，别加别的字）。',
    '硬约束：',
    '1) 依据门：只能引用材料里出现过的具体事；没有具体事就 SILENT。',
    '2) 内容门：不追问对方为什么不回，不重复上一句，不出现路径、日志、代码、凭据，不用「提醒」「播报」「通知」这类词。',
    '3) 一次只说一件事，不要列表、不要括号补充。',
    approved ? '4) 对方刚刚让它说，语气可以更直接一点。' : '4) 对方没在等你说话，别显得急。',
  ].join('\n')
  const facts = [
    '它叫 ' + a.name + '，对对方的称呼是 ' + you,
    affect ? '此刻情绪：' + affect : '',
    band ? '驱力档位：' + band : '',
    '它想做的这件事：' + (ag.title || '') + '（维度：' + (DIM_NAME[ag.dim] || ag.dim || '未知') + '）',
    mems.length ? '它能引用的真实记忆（' + mems.length + ' 条）：' : '它还没有可引用的记忆',
    ...mems.map((m) => '- ' + String(m.text).slice(0, 90)),
  ].filter(Boolean).join('\n')

  try {
    const call = freeformModelHook.complete
      ? freeformModelHook.complete({ system: sys, text: facts })
      : model.complete({ system: sys, text: facts })
    const raw = await withTimeout(Promise.resolve(call), 12000)
    if (/^\s*SILENT\s*$/i.test(String(raw || ''))) {
      return { text: null, source: 'model', silent: true, gate: gateRow('content', false, '它看了材料，觉得没有值得说的（SILENT）'), memories: mems }
    }
    const line = cleanLine(raw)
    if (line) {
      const cg = contentCheck(line)
      if (cg.ok) return { text: line, source: 'model', gate: gateRow('content', true, '模型给的一句话，过了内容门'), memories: mems }
      return rules('模型的句子被内容门挡下（' + cg.detail + '），退回规则句')
    }
    // 模型给了没法用的一坨（不是明确的 SILENT）→ 用兜底句，别让功能失效
    return rules('模型没给出可用的一句，退回规则句')
  } catch {
    return rules('模型超时/失败，退回规则句')
  }
}

/**
 * 现在该不该开口（v2）：缺口层 + 反模式混合。
 * - 保留「缺口 → 想说话」：五维缺口 + 候选打分，现算、不落审批表；
 * - 五道门逐条给结论（依据/空闲/频率/打扰/内容），内容门等生成后再补；
 * - 显式算收益和成本（拆到每一项），benefit > cost 才开口；
 * - 只读，不改库。manual=true 只跳过「安静时段 / 沉默时长 / 打扰预算 / 打分」。
 */
/** C6：当前对话对象的开口意愿（0..1）；读不到关系就给中性值 */
function initiativeOf(db, aid) {
  try {
    const p = ownerPerson(db, aid) || personByChannel(db, aid)
    let mood = 0.5
    try { mood = Number(getAffect(db, aid).mood) || 0.5 } catch { /* 老库没有情绪表 */ }
    const axes = readAxes(db, aid)
    return toneOf({
      closeness: p ? p.closeness : 0.5,
      trust: p ? p.trust : 0.5,
      kind: p ? p.tier : 'acquaintance',
      mood,
      extraversion: axes.ei,
    }).initiative
  } catch { return 0.3 }
}

export function decideSpeak(db, aid, { manual = false, at = Date.now() } = {}) {
  const gates = []
  const G = (id, ok, detail) => { const g = gateRow(id, ok, detail); gates.push(g); return g }
  const out = {
    version: 2, will: false, reason: 'ok', manual: !!manual, at: now(),
    hours_since: null, idle_need_hours: null,
    quiet: null, intent: null, candidates: [], score: null,
    benefit: null, benefit_parts: null, cost: null, cost_parts: null, evidence: null,
    gates, gate: gates, explain: '',
  }
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(aid)
  const alive = !!a && a.status === 'active'
  G('state', alive, alive ? '' : (a ? '它在休眠（' + (a.status === 'paused' ? '你让它暂停了' : a.status) + '），不会主动开口' : '找不到这个意识体'))
  if (!alive) return { ...out, reason: 'inactive', explain: '它在休眠，不会主动开口。' }

  const prefs = getProactivePrefs(db, aid)
  out.prefs = prefs
  const on = !!prefs.enabled && Number(prefs.per_day) > 0
  G('switch', on, on ? ('每天最多 ' + prefs.per_day + ' 句') : '主动开口是关的')
  if (!on) return { ...out, reason: 'proactive_off', explain: '主动开口是关的。' }

  let dm = null
  try { dm = getDrive(db, aid) } catch { dm = null }
  const awake = !(dm && dm.dormant)
  G('dormant', awake, awake ? '' : '太久没互动，它已经休眠了')
  if (!awake) return { ...out, reason: 'dormant', explain: '太久没互动，它已经休眠了。' }

  // R03（戈夫曼）：正在气头上，不主动开口（回复长度由语气档另管）
  let af0 = null
  try { af0 = getAffect(db, aid) } catch { af0 = null }
  const hot = !!af0 && ['irritated', 'frustrated'].includes(String(af0.primary_label)) && Number(af0.intensity) > 0.7
  G('temper', !hot, hot ? ('火气 ' + Number(af0.intensity).toFixed(2) + '，不想先开口') : '情绪平稳')
  if (hot) {
    return {
      ...out, reason: 'temper', explain: '正在气头上，它不会主动开口（R03）。',
      affect: { label: af0.primary_label, intensity: Number(af0.intensity) },
    }
  }

  // ---- 数字全部现算，只读 ----
  const today = now().slice(0, 10)
  let saidToday = 0
  try { saidToday = Number(db.prepare("SELECT COUNT(*) n FROM proactive WHERE agent_id=? AND created_at LIKE ?").get(aid, today + '%').n || 0) } catch { saidToday = 0 }
  const lastAt = a.last_interaction_at ? Date.parse(a.last_interaction_at) : 0
  const hoursSince = lastAt ? +((at - lastAt) / 3600000).toFixed(2) : 999
  const cx = proactiveCost(db, aid)
  const ev = proactiveEvidence(db, aid)
  const timing = proactiveTiming(hoursSince)
  const quietOn = inQuietHours(prefs)
  const axes = readAxes(db, aid)
  // 8 idle：外向的人等得短一点
  const idleNeed = Math.min(PROACTIVE.IDLE_HARD_MAX, Math.max(0, Number(prefs.idle_hours) || 0)
    * (1 + cx.ignore_rate) * (1 - 0.30 * ((Number(axes.ei) || 0.5) - 0.5)))
  out.hours_since = hoursSince
  out.idle_need_hours = +idleNeed.toFixed(1)
  out.quiet = { on: !!prefs.quiet, from: prefs.quiet_from || '23:30', to: prefs.quiet_to || '07:30', in_window: quietOn }
  out.evidence = ev
  out.cost = cx.cost
  out.cost_parts = cx.parts

  const intents = rankIntents(db, aid)
  out.candidates = intents.map((x) => ({ dim: x.dim, deficit: x.deficit, min: x.min, kind: x.kind, title: x.title }))
  const needTh = intents.length ? intents[0].min : minDeficit(db, aid, (dm && dm.band) || 'D0')
  out.min_deficit = +needTh.toFixed(3)
  G('deficit', intents.length > 0, intents.length
    ? intents.map((x) => (DIM_NAME[x.dim] || x.dim) + ' ' + x.deficit.toFixed(2)).join(' / ')
    : '五个方向都在门槛 ' + needTh.toFixed(2) + ' 以下（当前 ' + ((dm && dm.band) || 'D0') + '）')
  if (!intents.length) return { ...out, reason: 'no_intent', explain: '它现在哪儿都不缺，不勉强找话说。' }

  // 硬拦：冷却中的、今天说过的、没材料的，逐个跳过，换下一个缺口
  let pick = null
  for (const it of intents) {
    const c = out.candidates.find((x) => x.dim === it.dim)
    const gate = proactiveGate(db, aid, it.dim)
    if (!gate.ok) { c.blocked = 'cooldown'; c.why = '冷却到 ' + String(gate.until || '').slice(0, 16).replace('T', ' '); continue }
    let dup = null
    try { dup = db.prepare("SELECT 1 FROM proactive WHERE agent_id=? AND dim=? AND created_at LIKE ?").get(aid, it.dim, today + '%') } catch { dup = null }
    if (dup) { c.blocked = 'already_today'; c.why = '这个方向今天说过了'; continue }
    if (DIM_NEEDS_EVIDENCE[it.dim] && ev.items === 0) {
      c.blocked = 'no_evidence'; c.why = '这一维要真事，手头 0 条'; continue
    }
    pick = it
    break
  }
  const top = pick || intents[0]
  const evOk = !(DIM_NEEDS_EVIDENCE[top.dim] && ev.items === 0)
  G('evidence', evOk, evOk
    ? ('手头 ' + ev.items + ' 条真事，近 ' + ev.days + ' 天新增 ' + ev.recent + ' 条')
    : ('「' + (DIM_NAME[top.dim] || top.dim) + '」这一维要真事，手头一条都没有'))

  const biasMul = driveAmp(axes, top.dim)
  const eiMul = 1 + 0.15 * ((Number(axes.ei) || 0.5) - 0.5)
  // C6（9 号 §6）：关系越近、心情越好，越愿意开口；疏离时把它压回去
  const initiative = initiativeOf(db, aid)
  const initiativeMul = 0.6 + 0.8 * initiative
  // P2（情绪进判据）：总情绪高一点更想开口，低谷时更怕打扰。
  // 只用乘子、不新增拆项，保证「收益三块加起来 = benefit / 成本三块 = cost」的核对口径不变。
  const moodTotal = af0 && af0.v3 ? Math.max(-1, Math.min(1, Number(af0.v3.total) || 0)) : 0
  const moodBenefitMul = +(0.9 + 0.2 * Math.max(0, Math.min(1, 0.5 + 0.5 * moodTotal))).toFixed(3)
  const moodCostMul = moodTotal <= -0.2 ? 1.1 : 1
  const personMul = eiMul * (1 + biasMul) * initiativeMul * moodBenefitMul
  const benefit = +((top.deficit * PROACTIVE.W_DEFICIT + ev.score * PROACTIVE.W_EVIDENCE + timing * PROACTIVE.W_TIMING)
    * personMul).toFixed(3)
  // 敏感度抬高打扰成本：拆项按同一系数放大，三块加起来仍然等于 cost（不然「成本拆开算」对不上）
  const costMul = (1 + 0.25 * ((Number(axes.sensitivity) || 0.5) - 0.5)) * moodCostMul
  const cost = +(cx.cost * costMul).toFixed(3)
  out.benefit = benefit
  out.benefit_parts = {
    deficit: +(top.deficit * PROACTIVE.W_DEFICIT * personMul).toFixed(3),
    evidence: +(ev.score * PROACTIVE.W_EVIDENCE * personMul).toFixed(3),
    timing: +(timing * PROACTIVE.W_TIMING * personMul).toFixed(3),
    raw: { deficit: top.deficit, evidence: ev.score, timing },
    weights: { deficit: PROACTIVE.W_DEFICIT, evidence: PROACTIVE.W_EVIDENCE, timing: PROACTIVE.W_TIMING },
    persona: { ei: +eiMul.toFixed(3), axis: +biasMul.toFixed(3), initiative: +initiative.toFixed(3), initiative_mul: +initiativeMul.toFixed(3), mood: moodBenefitMul, mood_total: +moodTotal.toFixed(3), dimAxis: { R: 'tf', E: 'sn', C: 'tf', A: 'jp', S: 'sensitivity' }[top.dim] || null },
  }
  out.cost = cost
  out.cost_parts = {
    base: +(cx.parts.base * costMul).toFixed(3),
    frequency: +(cx.parts.frequency * costMul).toFixed(3),
    ignore: +(cx.parts.ignore * costMul).toFixed(3),
    persona: +costMul.toFixed(3),
    persona_mood: moodCostMul,
    mood_total: +moodTotal.toFixed(3),
  }
  out.score = {
    benefit, cost, deficit: top.deficit,
    evidence: ev.score, evidence_items: ev.items, evidence_recent: ev.recent,
    timing, sent7: cx.sent7, ignore_rate: cx.ignore_rate,
    benefit_parts: out.benefit_parts, cost_parts: out.cost_parts,
  }
  out.intent = pick
    ? { dim: pick.dim, kind: pick.kind, title: pick.title, deficit: pick.deficit, reason: '缺口 ' + pick.deficit.toFixed(2) }
    : null

  // ---- 五道门 + 判据，全部给结论（不短路，方便解释） ----
  const firstBlocked = out.candidates.find((c) => c.blocked)
  const tries = proactiveAttemptsToday(db, aid)
  out.tries_today = tries
  // 7 frequency：J/P 调每天可试次数（J 更守上限，P 允许试多一点），但说了几句的上限不动
  const perDay = Number(prefs.per_day)
  const cap = Math.max(1, Math.ceil(perDay * (1 + 0.40 * ((Number(axes.jp) || 0.5) - 0.5))))
  out.attempt_cap = cap
  const freqOk = saidToday < perDay && tries < cap && !!pick
  G('frequency', freqOk, saidToday >= perDay
    ? '今天已经说了 ' + saidToday + ' 句（上限 ' + perDay + '）'
    : tries >= cap ? '今天已经试着开口 ' + tries + ' 次（上限 ' + cap + '），不再反复问模型'
      : !pick ? '没有能说的方向：' + ((firstBlocked && firstBlocked.why) || '都不合适')
        : '今天还没说；还能试 ' + (cap - tries) + ' 次')

  const idleOk = hoursSince >= idleNeed
  G('idle', idleOk, '距上次对话 ' + (hoursSince >= 999 ? '还没有过' : hoursSince.toFixed(1) + ' 小时') + '，要求至少 ' + idleNeed.toFixed(1) + ' 小时')

  G('quiet', !quietOn, quietOn
    ? ('现在是 ' + (prefs.quiet_from || '23:30') + '–' + (prefs.quiet_to || '07:30') + '，不打扰')
    : '不在安静时段')

  let budget = { disturb_used: 0, disturb_limit: 3 }
  try { budget = budgetGet(db, aid) } catch { /* 老库没有预算表 */ }
  const used = Number(budget.disturb_used || 0)
  const limit = Number(budget.disturb_limit || 3)
  G('disturb', used < limit, '这个月打扰了 ' + used + ' / ' + limit + ' 次')

  const valueOk = manual || benefit > cost
  G('value', valueOk, '劲头 ' + benefit.toFixed(2) + (benefit > cost ? ' > ' : ' ≤ ') + '打扰成本 ' + cost.toFixed(2)
    + '（E/I ×' + eiMul.toFixed(2) + '，轴 ×' + (1 + biasMul).toFixed(2) + (manual ? '；你让它说的，跳过比较' : '') + '）')

  // 内容门要等句子生成出来，先挂一个「待判」
  G('content', null, '等生成出来再判（一句话、不追问、不用提醒腔）')

  // 理由的先后：和旧版一致，先看硬条件，再看要不要开口
  let reason = 'ok'
  if (saidToday >= perDay) reason = 'per_day'
  else if (!manual && tries >= cap) reason = 'attempt_cap'
  else if (!manual && quietOn) reason = 'quiet'
  else if (!manual && hoursSince < idleNeed) reason = 'idle'
  else if (!manual && used >= limit) reason = 'budget'
  else if (!pick) reason = (firstBlocked && firstBlocked.blocked) || 'no_intent'
  else if (!manual && benefit <= cost) reason = 'low_benefit'

  out.reason = reason
  out.will = reason === 'ok'
  const im = DIM_NAME[top.dim] || top.dim
  if (out.will) {
    out.explain = '想说「' + im + '」：缺口 ' + top.deficit.toFixed(2) + ' + ' + ev.items + ' 条真事（近 ' + ev.days + ' 天 +' + ev.recent + '）'
      + ' + 隔了 ' + (hoursSince >= 999 ? '很久' : hoursSince.toFixed(0) + ' 小时') + ' = 劲头 ' + benefit.toFixed(2)
      + '，压过打扰成本 ' + cost.toFixed(2) + '（今天 ' + saidToday + ' 句，预算 ' + used + '/' + limit + '）。'
  } else {
    out.explain = explainSilent(reason, { top, firstBlocked, hoursSince, idleNeed, benefit, cost, used, limit, prefs })
  }
  return out
}

/** 兼容旧名：v2 的判据就是它 */
export const proactiveDecision = decideSpeak

function explainSilent(reason, { top, firstBlocked, hoursSince, idleNeed, benefit, cost, used, limit, prefs }) {
  const im = top ? (DIM_NAME[top.dim] || top.dim) : ''
  switch (reason) {
    case 'per_day': return '今天已经主动说了（上限 ' + (prefs && prefs.per_day) + ' 句），剩下的明天再说。'
    case 'attempt_cap': return '今天已经试过怎么开口了，还没找到合适的说法，等明天。'
    case 'quiet': return '现在是安静时段，它不吵你。'
    case 'idle': return '你 ' + (hoursSince >= 999 ? '还没' : hoursSince.toFixed(1) + ' 小时前才') + '聊过，它要等满 ' + idleNeed.toFixed(1) + ' 小时才开口。'
    case 'budget': return '这个月的打扰预算用完了（' + used + '/' + limit + '），先攒着。'
    case 'cooldown': return '「' + im + '」这个方向上次没被接住，' + ((firstBlocked && firstBlocked.why) || '在冷却') + '。'
    case 'already_today': return '「' + im + '」今天已经说过了。'
    case 'no_evidence': return '「' + im + '」要真事才说，它手头一条都没有，不编。'
    case 'low_benefit': return '劲头 ' + benefit.toFixed(2) + ' 没压过打扰成本 ' + cost.toFixed(2) + '（最近发得多 / 上回没被接住），先不说。'
    case 'no_intent': return '五个缺口都在阈值以下，没必要硬找话。'
    default: return '它现在没有想说的话。'
  }
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

export async function queueProactive(db, aid, { manual = false } = {}) {
  try { markProactiveIgnored(db, aid) } catch { /* ignore */ }
  const d = decideSpeak(db, aid, { manual })
  if (!d.will) {
    const did = recordProactiveDecision(db, aid, d)
    return manual ? { queued: false, reason: d.reason, decision_id: did, why: d } : null
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
  const id = nid('prc_')
  const s = d.score || {}
  const why = (d.intent.reason || '') + ' · ' + composed.source
    + (d.manual ? ' · 你让它说' : ' · ' + Number(s.benefit || 0).toFixed(2) + '>' + Number(s.cost || 0).toFixed(2))
  db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, aid, composed.text, why, d.intent.dim || '', 'pending', now(), null)
  bumpStat(db, aid, d.intent.dim || 'R', 'sent')
  if (!manual) budgetConsume(db, aid, 'disturb', 1)
  try {
    event(db, aid, 'proactive.queued', {
      dim: d.intent.dim, source: composed.source, manual: !!manual,
      benefit: s.benefit, cost: s.cost, hours_since: d.hours_since,
    })
  } catch { /* 记账失败不影响说话 */ }
  const did = recordProactiveDecision(db, aid, decided, { text: composed.text, source: composed.source, memories })
  return { queued: true, id, decision_id: did, text: composed.text, source: composed.source, dim: d.intent.dim || '', intent: d.intent.kind, why: decided }
}

// ---------------- 决策记录（解释用，不审批；连续同样的沉默合并） ----------------

const DECISION_KEEP = 120

/**
 * 每次「该不该说」都留一条：门槛结论、收益/成本、引用了哪条记忆。
 * 同一个判断（will/reason/dim 都一样）不新开行，只更新时间和次数。
 */
export function recordProactiveDecision(db, aid, d, { text = null, source = null, memories = null } = {}) {
  try {
    const at = d.at || now()
    const reason = d.reason || 'ok'
    const dim = (d.intent && d.intent.dim) || null
    const gates = Array.isArray(d.gates) ? d.gates : []
    const chain = {
      explain: d.explain || '',
      benefit: d.benefit_parts || null,
      cost: d.cost_parts || null,
      evidence: d.evidence || null,
      memory_used: (memories || []).map((m) => ({ id: m.id, text: String(m.text || '').slice(0, 120) })),
      hours_since: d.hours_since, idle_need_hours: d.idle_need_hours,
      source: source || null,
    }
    const last = db.prepare('SELECT * FROM proactive_decisions WHERE agent_id=? ORDER BY at DESC, rowid DESC LIMIT 1').get(aid)
    if (last && Number(last.will) === (d.will ? 1 : 0) && last.reason === reason && (last.dim || '') === (dim || '')) {
      db.prepare('UPDATE proactive_decisions SET at=?, repeats=repeats+1, text=COALESCE(?,text), source=COALESCE(?,source), benefit=?, cost=?, gates=?, chain=? WHERE id=?')
        .run(at, text, source, d.benefit ?? null, d.cost ?? null, JSON.stringify(gates), JSON.stringify(chain), last.id)
      return last.id
    }
    const id = nid('pdc_')
    db.prepare('INSERT INTO proactive_decisions(id,agent_id,at,will,reason,dim,source,text,benefit,cost,gates,chain,repeats) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)')
      .run(id, aid, at, d.will ? 1 : 0, reason, dim, source, text, d.benefit ?? null, d.cost ?? null, JSON.stringify(gates), JSON.stringify(chain))
    db.prepare('DELETE FROM proactive_decisions WHERE agent_id=? AND id NOT IN (SELECT id FROM proactive_decisions WHERE agent_id=? ORDER BY at DESC, rowid DESC LIMIT ?)')
      .run(aid, aid, DECISION_KEEP)
    return id
  } catch { return null }
}

export function listProactiveDecisions(db, aid, limit = 20) {
  agent(db, aid)
  const n = Math.max(1, Math.min(100, Number(limit) || 20))
  let rows = []
  try { rows = db.prepare('SELECT * FROM proactive_decisions WHERE agent_id=? ORDER BY at DESC, rowid DESC LIMIT ?').all(aid, n) } catch { rows = [] }
  return rows.map((r) => {
    let gates = []
    let chain = {}
    try { gates = JSON.parse(r.gates || '[]') } catch { gates = [] }
    try { chain = JSON.parse(r.chain || '{}') } catch { chain = {} }
    return { ...r, will: !!r.will, gates, chain }
  })
}

export function lastProactiveDecision(db, aid) {
  try { return listProactiveDecisions(db, aid, 1)[0] || null } catch { return null }
}

export function listProactive(db, aid) {
  agent(db, aid)
  return db.prepare("SELECT * FROM proactive WHERE agent_id=? AND state='pending' ORDER BY created_at DESC LIMIT 5").all(aid)
}

// ---------------- 主动开口的结局追踪（状态放库，不放模型脑子） ----------------

function bumpStat(db, aid, dim, field) {
  try {
    db.prepare('INSERT OR IGNORE INTO proactive_stats(agent_id,dim) VALUES(?,?)').run(aid, dim)
    db.prepare('UPDATE proactive_stats SET ' + field + '=' + field + '+1, last_sent_at=? WHERE agent_id=? AND dim=?').run(now(), aid, dim)
  } catch { /* ignore */ }
}

/** 这个维度现在能不能提（冷却中就不提） */
export function proactiveGate(db, aid, dim) {
  try {
    const s = db.prepare('SELECT * FROM proactive_stats WHERE agent_id=? AND dim=?').get(aid, dim)
    if (s && s.cooldown_until && Date.parse(s.cooldown_until) > Date.now()) {
      return { ok: false, reason: 'cooldown', until: s.cooldown_until, stats: s }
    }
    return { ok: true, stats: s || null }
  } catch { return { ok: true, stats: null } }
}

/** 用户真的回了一句：把「已投递、还没回应」的主动消息标成被回应 */
export function settleProactiveAnswered(db, aid) {
  let n = 0
  try {
    const rows = db.prepare("SELECT id,dim FROM proactive WHERE agent_id=? AND state='delivered' AND answered=0 AND ignored=0").all(aid)
    for (const r of rows) {
      db.prepare('UPDATE proactive SET answered=1, answered_at=? WHERE id=?').run(now(), r.id)
      bumpStat(db, aid, r.dim || 'R', 'answered')
      n++
    }
  } catch { /* ignore */ }
  return n
}

/** 24 小时没回应 → 记一次忽略；同一维度两次忽略且零回应 → 该维度冷却 7 天 */
export function markProactiveIgnored(db, aid) {
  let n = 0
  try {
    const cutoff = new Date(Date.now() - 24 * 3600000).toISOString()
    const rows = db.prepare("SELECT id,dim FROM proactive WHERE agent_id=? AND state='delivered' AND answered=0 AND ignored=0 AND delivered_at<?").all(aid, cutoff)
    for (const r of rows) {
      const dim = r.dim || 'R'
      db.prepare('UPDATE proactive SET ignored=1 WHERE id=?').run(r.id)
      bumpStat(db, aid, dim, 'ignored')
      const s = db.prepare('SELECT * FROM proactive_stats WHERE agent_id=? AND dim=?').get(aid, dim)
      if (s && Number(s.ignored) >= 2 && Number(s.answered) === 0) {
        db.prepare('UPDATE proactive_stats SET cooldown_until=? WHERE agent_id=? AND dim=?')
          .run(new Date(Date.now() + 7 * 86400000).toISOString(), aid, dim)
      }
      n++
    }
  } catch { /* ignore */ }
  return n
}

export function proactiveStats(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM proactive_stats WHERE agent_id=? ORDER BY dim').all(aid)
}

export function ackProactive(db, aid, pid) {
  const r = db.prepare('SELECT * FROM proactive WHERE id=? AND agent_id=?').get(pid, aid)
  if (!r) err(404, 'NOT_FOUND', '这条主动消息不存在')
  db.prepare("UPDATE proactive SET state='dismissed' WHERE id=?").run(pid)
  return { id: pid, state: 'dismissed' }
}

// ---------------- 主动开口的偏好（可在设置里改） ----------------
export const PROACTIVE_DEFAULTS = {
  enabled: true, per_day: 1, idle_hours: 6,
  quiet: true, quiet_from: '23:30', quiet_to: '07:30',
  // push：把待发那句直接推进会话（不再等你先开口）。默认关，打开才算授权。
  push: false,
}

/** 推消息时给对方看到的那段提示；后面跟着的才是它自己说的话。 */
export function proactivePushText(line) {
  return '（它主动来找你，想说的是：「' + String(line || '') + '」。直接把这句话说给他听，不要复述这条提示。）'
}

export function getProactivePrefs(db, aid) {
  const raw = getFlag(db, 'proactive:' + aid)
  if (!raw) return { ...PROACTIVE_DEFAULTS }
  try { return { ...PROACTIVE_DEFAULTS, ...JSON.parse(raw) } } catch { return { ...PROACTIVE_DEFAULTS } }
}

export function setProactivePrefs(db, aid, body) {
  const cur = getProactivePrefs(db, aid)
  const hhmm = (v, d) => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim()) ? String(v).trim() : d)
  const next = {
    enabled: body.enabled === undefined ? cur.enabled : !!body.enabled,
    per_day: Math.max(0, Math.min(10, Number(body.per_day ?? cur.per_day))),
    idle_hours: Math.max(0, Math.min(720, Number(body.idle_hours ?? cur.idle_hours))),
    quiet: body.quiet === undefined ? cur.quiet : !!body.quiet,
    quiet_from: hhmm(body.quiet_from ?? cur.quiet_from, PROACTIVE_DEFAULTS.quiet_from),
    quiet_to: hhmm(body.quiet_to ?? cur.quiet_to, PROACTIVE_DEFAULTS.quiet_to),
    push: body.push === undefined ? !!cur.push : !!body.push,
  }
  setFlag(db, 'proactive:' + aid, JSON.stringify(next))
  return next
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
  const parts = lines.slice()
  const dropped = []
  const total = () => est(parts.join('\n'))
  const order = [
    ['proactive', (l) => l.startsWith('（你之前想主动说一句')],
    ['affect', (l) => l.startsWith('此刻情绪') || l.startsWith('感觉现在大概') || l.startsWith('此刻我') || l.startsWith('我想怎么说')],
    ['drive', (l) => l.startsWith('需求缺口档位')],
    ['diary', (l) => l.startsWith('最近我自己写下的')],
    ['memory', (l) => l.startsWith('关于这句话，你能想起的事')],
    // 开环 / 续接 / 自发浮现排在最后丢：它们是「自己先想起来的」，比一条泛记忆更该被说出来
    ['loop', (l) => l.startsWith('（你自己心里还挂着的事')],
    ['bridge', (l) => l.startsWith('（上次（')],
    ['spontaneous', (l) => l.startsWith('（你心里忽然浮上来')],
  ]
  for (const [name, test] of order) {
    if (total() <= cap) break
    const idx = parts.findIndex((l) => test(l))
    if (idx >= 0) { parts.splice(idx, 1); dropped.push(name) }
  }
  // 段级丢完还超：先砍日记（叙事，隔天还能补），再砍记忆；记忆留 2 条兜底。
  const trimBlock = (test, label, keep = 1) => {
    const idx = parts.findIndex((l) => test(l))
    if (idx < 0) return false
    const sub = String(parts[idx]).split('\n')
    if (sub.length <= 1) { parts.splice(idx, 1); dropped.push(label); return true }
    if (sub.length <= keep) return false
    let touched = false
    while (sub.length > keep && total() > cap) { sub.pop(); parts[idx] = sub.join('\n'); touched = true }
    if (touched) dropped.push(label + '-lines')
    return touched
  }
  if (total() > cap) trimBlock((l) => l.startsWith('最近我自己写下的'), 'diary', 1)
  trimBlock((l) => l.startsWith('关于这句话，你能想起的事'), 'memory', 3)
  let text = parts.join('\n')
  if (est(text) > cap) {
    text = text.slice(0, Math.max(0, cap * 2 - 1)).replace(/\s+$/, '') + '…'
    dropped.push('truncate')
  }
  return { text, tokens: est(text), dropped }
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
