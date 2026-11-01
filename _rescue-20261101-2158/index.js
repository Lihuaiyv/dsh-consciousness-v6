/**
 * dsh-consciousness — 意识体：宿主半。
 *
 * 数据库和业务都在插件进程内，界面是独立的 Client 半（client.js），
 * 通过 settings.section 注册成「设置 → 意识」一整页，不开浮层、不开 iframe。
 *
 * 接口：POST /dsh-consciousness/api（JSON 信封）
 * 数据：~/.dsh/consciousness/app.db（node:sqlite）
 *
 * 记忆整理（用模型合并重复自省）：POST /v1/agents/:id/memory/consolidate，dry_run=1 只看方案。
 * 存量分级（按裁判把低分自省打进冷层）：POST /v1/agents/:id/memory/demote，dry_run=1 只统计。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, recover, now } from './src/db.js'
import { handle } from './src/api.js'
import { attachHostLlm } from './src/model.js'
import { eventsSince, getFlag, ingest, applyActiveRules, backupDrill, learnFromTurn, queueProactive, settleProactiveAnswered, clampInjection, appraiseWithEdges, tickOneShadow, applyDriverToDrive, getProactivePrefs, autoGrowPreferences } from './src/features.js'
import { nid, purgeExpired, evaluateDrive, recall, getParam, settleObservations, expireProposals, recoverChangeJournal, gcArtifacts, shrinkPersona, tickRitual, tickConflicts, maybeDraft, TARGET_IDS, latestUserEmotion } from './src/core.js'
import { seedRuleBindings } from './src/modules/artifacts.js'
import { DIMS } from './src/modules/values.js'
import { axisWords, mbtiPrompt } from './src/modules/traits.js'
import { pulseDriveFromSignals } from './src/modules/drive.js'
import { pushProactiveLine } from './src/push.js'
import { auditStore } from './src/modules/ops.js'
import { cleanUserText } from './src/text.js'
import { toneOf } from './src/algo/reldyn.js'
import { expressionState } from './src/modules/expression_state.js'
import { attachDb } from './src/algo/index.js'
import { createHost, readEvent, messageText } from './src/host/dsh.js'
import { appendTurn, buildEpisode, recentDiaryLines, migrateArchive, backfillFactArchive, sessionBridge } from './src/modules/archive.js'
import { pushTurn, hydrateFromRaw } from './src/modules/buffer.js'
import { retrieve, contextualQuery } from './src/modules/retrieve.js'
import { prefetchExpand, takeExpansion } from './src/modules/expand.js'
import { prefetchEmbedding, takeEmbedding } from './src/modules/vector.js'
import { backfillEntities } from './src/modules/entities.js'
import { packInjection, oneLine } from './src/modules/pack.js'
import { loopLineFor, markLoopsFired, expireLoops } from './src/modules/loops.js'
import { recordSurfaced, markSurfacedUsed } from './src/modules/surfacing.js'
import { surfaceQueueTick, takeSurface } from './src/modules/pulse.js'
import { applySelfRead } from './src/modules/self_read.js'
import { logRetrieval } from './src/modules/retrieval_log.js'
import { enqueueExtraction, tickExtraction } from './src/modules/extract_queue.js'
import { tickEscalation } from './src/modules/conflict.js'
import { runNightly, dueDiaryDays, hasDiaryMaterial } from './src/modules/nightly.js'
import { ensureHeatBootstrapped, touch } from './src/modules/tiers.js'
import { model } from './src/kernel.js'
import * as R from './src/modules/relations.js'
import { enqueueRelationRead, tickRelationRead } from './src/modules/relations_extract.js'
import { moodValenceOf } from './src/modules/affect.js'
import { createActionTools, attachActionDeps } from './src/modules/actions/index.js'

// 情绪注入的人话化交给 modules/expression_state.js（第一人称感受 + 软愿望），
// 这里不再保留「强度 / 心情 / 底色」的数字分档函数。

// 必须与 package.json / cordis.patch.yml 的包名一致，否则 loader 挂载异常。
export const name = 'dsh-consciousness-v6'
export const inject = []

const API_PATH = '/dsh-consciousness/api'
const PING_PATH = '/dsh-consciousness/ping'
const DB_PATH = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'consciousness', 'app.db')
const LOCK_PATH = path.join(path.dirname(DB_PATH), 'app.lock')

// 宿主上下文和最近见到的会话：主动发消息要用 sessionController.prompt 推进去。
let hostCtx = null
const lastSessions = new Map()
const pushedTurns = new Set()

let db = null
let recovered = 0
let dbError = null
let lockHeld = false
/** 宿主适配器：四个接缝的探测结果，ping 里原样报出去。 */
let host = null

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true })
  try {
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
    lockHeld = true
    return true
  } catch {
    try {
      const old = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'))
      if (old.pid && old.pid !== process.pid && pidAlive(old.pid)) return false
    } catch { /* 坏锁当陈旧 */ }
    try { fs.unlinkSync(LOCK_PATH) } catch { /* ignore */ }
    try {
      fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
      lockHeld = true
      return true
    } catch { return false }
  }
}

function releaseLock() {
  if (!lockHeld) return
  try {
    const old = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'))
    if (old.pid === process.pid) fs.unlinkSync(LOCK_PATH)
  } catch { /* ignore */ }
  lockHeld = false
}

process.on('exit', releaseLock)

function ensureDb() {
  if (db) return db
  if (dbError) throw dbError
  try {
    db = openDb(DB_PATH)
    recovered = recover(db)
    try { recoverChangeJournal(db) } catch { /* 变更日志恢复失败下次再试 */ }
    attachDb(db)
    applyActiveRules(db)
    // 分层记忆：老库补一次热度；顺手把最近三天缺的日记补上（后台，失败不影响启动）
    try { ensureHeatBootstrapped(db) } catch { /* 热度补齐失败下次再来 */ }
    setTimeout(() => {
      try {
        // 补数据不挑 status：paused 的也要补（paused 只是不主动开口，不是不存在）
        const aid = latestAgentId(db)
        if (!aid) return
        const migrated = migrateArchive(db, aid)
        if (migrated) __probe('archive-migrated n=' + migrated)
        const archived = backfillFactArchive(db, aid)
        if (archived) __probe('fact-archive-backfilled n=' + archived)
        // 实体路回填：按放宽后的规则把已有记忆重新认一遍实体（一次就够，之后靠增量）
        try {
          const ents = backfillEntities(db, aid)
          if (ents) __probe('entities-backfilled n=' + ents)
        } catch { /* 回填失败下次启动再来 */ }
        // 缓冲：重启后从 T4 把最近一个会话的尾巴捞回来
        try { hydrateFromRaw(db, aid) } catch { /* 重放失败不影响启动 */ }
      } catch { /* 启动补数据失败不影响启动 */ }
    }, 5000)
    // P2 抽取 worker：每 30 秒看一眼队列，30 秒前先跑一次（重启后把积压清掉）
    try { startExtractionWorker() } catch { /* worker 起不来不影响启动 */ }
    // 关系读人 worker：把排队的人物提及读成「谁是谁的谁」
    try { startRelationWorker() } catch { /* worker 起不来不影响启动 */ }
    // P4 夜间巩固：每天 23:00 写日记；关机 / 休眠错过的，下次启动或半小时内补上。
    try { startNightlyWorker() } catch { /* 巩固 worker 起不来不影响启动 */ }
    // 偏好自己长：10 分钟一次，够条件才真调模型；长出来的删不掉
    try { startGrowPrefsWorker() } catch { /* 长偏好 worker 起不来不影响启动 */ }
    return db
  } catch (e) {
    dbError = e
    throw e
  }
}

function readJson(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function schemaVersion(db) {
  try {
    const r = db.prepare('SELECT version FROM schema_meta').get()
    return Number(r && r.version ? r.version : 0)
  } catch { return 0 }
}

function backupDb() {
  try {
    const dir = path.join(path.dirname(DB_PATH), 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const name = 'app-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db'
    const dest = path.join(dir, name)
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest)
      // VACUUM INTO 会把 WAL 里已提交的内容一起写进备份；copyFileSync 可能漏帧
      ensureDb().exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'")
    } catch {
      fs.copyFileSync(DB_PATH, dest)
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort()
    while (files.length > 7) fs.unlinkSync(path.join(dir, files.shift()))
  } catch { /* 备份失败不影响主流程 */ }
}

function startMaintenance() {
  let lastBackup = 0
  let lastPurge = 0
  let lastDrill = 0
  const timer = setInterval(() => {
    try {
      ensureDb().exec('PRAGMA wal_checkpoint(TRUNCATE)')
      if (Date.now() - lastBackup > 6 * 3600000) {
        lastBackup = Date.now()
        backupDb()
      }
      if (Date.now() - lastPurge > 24 * 3600000) {
        lastPurge = Date.now()
        purgeExpired(ensureDb())
        try { expireProposals(ensureDb()) } catch { /* 过期扫描失败跳过 */ }
        try { settleObservations(ensureDb()) } catch { /* 观察期结算失败跳过 */ }
  try { gcArtifacts(ensureDb()) } catch { /* 版本清理失败跳过 */ }
        // 存储体检：索引漏行 / 孤儿边自动修（不修也不会报错，只会静默少召回）
        try {
          const a = auditStore(ensureDb(), { repair: true })
          if (!a.ok) __probe('store-audit repaired=' + (a.repaired || []).join(','))
        } catch { /* 体检失败不影响主流程 */ }
      }
      if (Date.now() - lastDrill > 7 * 86400000) {
        lastDrill = Date.now()
        const r = backupDrill()
        if (!r.ok) console.error('[dsh-consciousness-v6] backup drill failed:', r.reason || r)
        else console.log('[dsh-consciousness-v6] backup drill ok:', r.file, r.tables, r.memories)
      }
    } catch { /* 忙时跳过 */ }
  }, 5 * 60 * 1000)
  if (timer.unref) timer.unref()
  const intentTick = setInterval(() => {
    try {
      const rows = ensureDb().prepare("SELECT id FROM agents WHERE status='active'").all()
      for (const r of rows) {
        try {
          const p = queueProactive(ensureDb(), r.id)
          if (p && p.then) p.then((out) => maybePushProactive(ensureDb(), r.id, out)).catch(() => {})
        } catch { /* 主动消息失败跳过 */ }
        try { shrinkPersona(ensureDb(), r.id) } catch { /* 人格收缩失败跳过 */ }
        try { seedRuleBindings(ensureDb(), r.id) } catch { /* 工件种子失败跳过 */ }
        for (const tid of TARGET_IDS) { try { maybeDraft(ensureDb(), r.id, tid) } catch { /* 单目标起草失败跳过 */ } }
        try { applyDriverToDrive(ensureDb(), r.id) } catch { /* 驱动推缺口失败跳过 */ }
        try { pulseDriveFromSignals(ensureDb(), r.id) } catch { /* 事件脉冲失败跳过 */ }
        // 空闲心跳：不调模型，只给「自己浮上来」补候选（下一轮注入时最多取一条）
        try { surfaceQueueTick(ensureDb(), r.id) } catch { /* 心跳失败跳过 */ }
        try { tickOneShadow(ensureDb()) } catch { /* 影子推进失败跳过 */ }
      }
    } catch { /* ignore */ }
  }, 10 * 60 * 1000)
  if (intentTick.unref) intentTick.unref()
}

// ---------------- 把它接进 DSH 的对话 ----------------
// 被「启动」的那个意识体会绑定到下一个新建的对话：那段对话里模型拿到的
// 系统提示会带上它的人格、情绪、关系和记忆；回复结束后再把这一轮写回记忆。

const lastUser = new Map()

function str(row, path, d = '') {
  if (!row) return d
  const r = row.find((x) => x.path === path)
  if (!r || r.value == null) return d
  return String(r.value).replace(/^"|"$/g, '')
}

/** 一段可读的意识体自述，直接进系统提示。 */
export const recentRecall = new Map()

/** 开环那一行：六十秒内复用，避免同一次系统提示被调多次时重复记账。 */
const loopCache = new Map()
/** 自发浮现也一分钟内复用：一次对话里模型可能多次拼提示，别把队列抽干。 */
const spontaneousCache = new Map()

/** 该浮现的开环（一条），并记一次「提过」。 */
export function surfaceLoopLine(db, aid) {
  if (String(getParam(db, aid, 'memory.float.enable') || 'on') === 'off') return ''
  const c = loopCache.get(aid)
  if (c && Date.now() - c.at < 60000) return c.text
  let text = ''
  try {
    const lim = Math.max(1, Math.min(3, Number(getParam(db, aid, 'memory.float.loop')) || 1))
    const th = Math.max(1, Math.min(72, Number(getParam(db, aid, 'memory.float.loop.throttle')) || 6))
    const L = loopLineFor(db, aid, { limit: lim, throttleHours: th })
    if (L.ids.length) {
      markLoopsFired(db, L.ids)
      text = '（你自己心里还挂着的事，可以自然提起，不用解释来源）：\n' + L.text
      expireLoops(db, aid)
    }
  } catch { text = '' }
  loopCache.set(aid, { at: Date.now(), text })
  return text
}

export function consciousnessBlock(db, aid) {
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(aid)
  if (!a || a.status === 'soft_deleted') return ''
  let persona = []
  try { persona = db.prepare('SELECT path,value FROM persona WHERE agent_id=?').all(aid) } catch { /* 老库 */ }
  const axisVals = {}
  for (const x of persona) {
    if (!x.path.startsWith('axis.')) continue
    const v = Number(x.value)
    if (Number.isFinite(v)) axisVals[x.path.slice(5)] = v
  }
  const axesLine = Object.keys(axisVals).length ? axisWords(axisVals) : ''
  // MBTI 四字母：AI 自己也得看得见，不然界面上写着 ENTJ、脑子里却只有「偏外向·偏情感·敏感」。
  let mbtiLine = ''
  try { mbtiLine = mbtiPrompt(db, aid) } catch { mbtiLine = '' }
  const affect = db.prepare('SELECT * FROM affect_state WHERE agent_id=?').get(aid)
  try {
    const v3 = db.prepare('SELECT * FROM affect_v3 WHERE agent_id=?').get(aid)
    if (affect && v3) affect.v3 = v3
  } catch { /* 老库没有 v3 表 */ }
  const drive = db.prepare('SELECT * FROM drive_state WHERE agent_id=?').get(aid)
  const taboos = db.prepare('SELECT text,level FROM taboos WHERE agent_id=?').all(aid)
  let vals = []
  try { vals = db.prepare('SELECT key,weight FROM persona_values WHERE agent_id=? ORDER BY weight DESC LIMIT 3').all(aid) } catch { /* 老库还没有价值观 */ }
  let rel = []
  try {
    // 优先读人物账本（rel_person）：它才是活的三轴（含衰减）；老库只做兜底
    rel = db.prepare(`SELECT name, tier AS kind, closeness, trust, dependence FROM rel_person
      WHERE agent_id=? AND status='active'
      ORDER BY (tier='owner') DESC, salience DESC LIMIT 5`).all(aid)
  } catch { /* 老库没有账本 */ }
  if (!rel.length) {
    rel = db.prepare('SELECT name, kind, closeness, trust, dependence FROM relations WHERE agent_id=? ORDER BY root DESC, closeness DESC LIMIT 5').all(aid)
  }
  const mem = db.prepare("SELECT text FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL ORDER BY heat DESC, weight DESC, created_at DESC LIMIT 10").all(aid)
  const dyn = recentRecall.get(aid)
  const dynText = dyn && Date.now() - dyn.at < 60000 ? dyn.text : ''
  // T3 日记层：只带最近两天，压成两行；它是叙事，不占“相关记忆”的名额。
  let diaryLines = []
  try { diaryLines = recentDiaryLines(db, aid, 2, 160) } catch { diaryLines = [] }
  // 开环：心里的「还挂着」。它不参与相关度，到了时候或者久没提就自己冒出来一条。
  const loopText = surfaceLoopLine(db, aid)
  // 会话续接：隔天再来的时候，先说一句「上次到哪儿」。同一天的事上下文里本来就有，不重复。
  let bridgeText = ''
  try { bridgeText = sessionBridge(db, aid) } catch { bridgeText = '' }

  // 自己浮上来：心跳排的候选，最多取一条。它不一定跟这一轮的话有关——
  // 人本来就会说着说着想起别的事。先取，再拼记忆块，免得同一条占两个名额。
  let spontaneousLine = ''
  let spontaneousText = ''
  try {
    const cached = spontaneousCache.get(aid)
    if (cached && Date.now() - cached.at < 60000) {
      spontaneousLine = cached.text
      spontaneousText = cached.text
    } else {
      const sp = takeSurface(db, aid)
      if (sp && sp.text) {
        const line = oneLine(sp.text, 60)
        if (line) { spontaneousLine = line; spontaneousText = line }
      }
      spontaneousCache.set(aid, { at: Date.now(), text: spontaneousText })
    }
  } catch { spontaneousLine = '' }

  // 记忆块：优先用这一轮真召回的结果；没有就用热度兜底，但只留 4 条，每条压成一句。
  // 兜底时剔掉刚浮上来的那条，避免同一件事说两遍。
  const memFallback = mem.filter((m) => oneLine(m.text, 60) !== spontaneousText)
  const memText = dynText || (memFallback.length ? memFallback.slice(0, 4).map((m) => '- ' + oneLine(m.text, 60)).join('\n') : '')
  if (spontaneousText && memText.includes(spontaneousText)) spontaneousLine = ''

  let proactiveLine = ''
  try {
    const pp = db.prepare("SELECT id,text FROM proactive WHERE agent_id=? AND state='pending' ORDER BY created_at DESC LIMIT 1").get(aid)
    if (pp) {
      proactiveLine = pp.text
      db.prepare("UPDATE proactive SET state='delivered', delivered_at=? WHERE id=?").run(now(), pp.id)
    }
  } catch { /* 老库没有这张表 */ }

  let userEmotion = null
  try {
    // 用「校准过的读法」而不是模型原始标签：面板上写的是它现在觉得你什么，
    // 嘴里说的也得是同一个，否则它一边说我读你是平静、一边说你现在挫败。
    userEmotion = latestUserEmotion(db, aid)
  } catch { userEmotion = null }

  // 心情只认 v3 总情绪（-1~1）；mood(0~1) 只是它的换算式，两套数字到此为止。
  const moodUnit = (() => {
    const t = affect && affect.v3 && affect.v3.total != null ? Number(affect.v3.total) : null
    if (Number.isFinite(t)) return 0.5 + 0.5 * Math.max(-1, Math.min(1, t))
    const m = Number(affect && affect.mood)
    return Number.isFinite(m) ? m : 0.5
  })()
  // 关系 → 表达（C7）：同一条关系，三轴不同，说话的温度/正式度/披露/主动就不同。
  // 只给第一个人展开（当前对话对象），其余人保留数字，控制注入长度。
  // 语气只有一个出口：expressionState（关系只提供温度，不决定句长）。
  const relTone = rel.length
    ? toneOf({
      closeness: rel[0].closeness,
      trust: rel[0].trust,
      kind: rel[0].kind || 'acquaintance',
      mood: moodUnit,
      extraversion: axisVals && axisVals.ei != null ? axisVals.ei : 0.6,
    })
    : null
  // 情绪注入的权重：0~1，默认 0.35（低权重 = 推测口吻，只当底子）。
  // 想更强势就读实例参数 affect.inject.weight，别改代码。
  const injectWeight = (() => {
    const raw = Number(getParam(db, aid, 'affect.inject.weight'))
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.35
  })()
  const expr = affect
    ? expressionState({
      affect,
      relation: relTone
        ? { ...relTone, closeness: rel[0].closeness, trust: rel[0].trust }
        : null,
      ei: axisVals && axisVals.ei != null ? axisVals.ei : 0.6,
      weight: injectWeight,
    })
    : null
  const relLine = rel.length
    ? '关系：' + rel.map((r, i) => {
      const n2 = (x) => Number(x || 0).toFixed(2)
      const head = r.name + '（亲近 ' + n2(r.closeness) + ' / 信任 ' + n2(r.trust) + ' / 依赖 ' + n2(r.dependence)
      if (i > 0) return head + '）'
      return head + '；' + relTone.label + ' ' + relTone.warmth.toFixed(2)
        + '，正式度 ' + relTone.formality.toFixed(2)
        + '，可以说到 ' + Math.round(relTone.disclosure * 100) + '%，主动 ' + relTone.initiative.toFixed(2) + '）'
    }).join('；') + '。'
    : ''

  const lines = [
    // ① 身份（§8 注入顺序第 1 段）
    '## 意识体：' + a.name,
    '你现在就是「' + a.name + '」。用第一人称说话；情绪、关系、记忆都是你自己的状态，不是别人的设定。',
    '不要声称自己有人类身体，也不要主动讨论「我是 AI」；被问到时如实说你是这个意识体。',
    str(persona, 'style.tone') ? '语气：' + str(persona, 'style.tone') + '。' : '',
    str(persona, 'style.address') ? '你称呼对方为「' + str(persona, 'style.address') + '」。' : '',
    str(persona, 'style.catchphrase') ? '口头禅：' + str(persona, 'style.catchphrase') + '。' : '',
    axesLine && axesLine !== '中间' ? '鱼格倾向：' + axesLine + '。' : '',
    mbtiLine || '',
    vals.length ? '你看重：' + vals.map((v) => ((DIMS.find((d) => d[0] === v.key) || [0, v.key])[1])).join('、') + '。' : '',
    // ② 关系（对谁、什么分寸）：第一个人带温度，其余人只留数字
    relLine,
    // ③ 情绪：只给「感觉现在大概…」的推测 + 一句软愿望。
    //    不再有「说话分寸 + 语气偏冷」这种命令行——命令会让她照着演。
    expr ? expr.felt : '',
    expr ? '我想怎么说：' + expr.wish : '',
    userEmotion ? '对方刚才的情绪：' + userEmotion.label
      + (userEmotion.raw_label ? '（我按你以前的纠正改的：我一开始读成' + userEmotion.raw_label + '）' : '')
      + '。只作共情参考，不要照搬成你自己的情绪。' : '',
    drive ? '需求缺口档位：' + drive.band + '。' : '',
    // ④ 记忆（≤5 条，带来源与时间）
    proactiveLine ? '（你之前想主动说一句：' + proactiveLine + ' —— 如果时机合适，自然提起，不要解释这是提醒。）' : '',
    diaryLines.length ? '最近我自己写下的（日记，不是用户说的）：\n' + diaryLines.join('\n') : '',
    bridgeText ? '（' + bridgeText + ' —— 如果自然，接着这个往下说，不用解释来源。）' : '',
    loopText || '',
    spontaneousLine ? '（你心里忽然浮上来的一件事，不一定是这一轮在说的；自然提起，不想提也别硬提）：\n- ' + spontaneousLine : '',
    (memText)
      ? '关于这句话，你能想起的事（只引用相关的，不要编造，也不要全倒出来；'
        + '带「一直记着的」「今天刚发生」的是你自己先想起来的，可以自然提起，不必解释来源）：\n'
        + memText
      : '你还没有关于对方的记忆。',
    '引用记忆时说「上次 / 你之前说过」；不确定就说「我可能记错」。',
    // ⑤ 约束（最后一段）
    taboos.length ? '禁忌（不得违反）：' + taboos.map((t) => t.text).join('；') + '。' : '',
    str(persona, 'style.banned') ? '禁用词（不要出现）：' + str(persona, 'style.banned') + '。' : '',
    str(persona, 'style.card') ? '别人给它写的一句话（理想自我，权重低，只作角度，不要逐句复述）：' + str(persona, 'style.card') : '',
  ].filter(Boolean)
  // 每轮注入预算：实例参数 memory.inject.budget（默认 800 token），超了按「先情绪、再记忆」丢
  const packed = clampInjection(lines, Number(getParam(db, aid, 'memory.inject.budget')) || 800)
  try {
    const ts = Date.now()
    if (!consciousnessBlock._last || ts - consciousnessBlock._last > 10000) {
      consciousnessBlock._last = ts
      db.prepare('INSERT INTO metric_samples VALUES(?,?,?,?,?)').run('mts_' + Math.random().toString(16).slice(2, 12), aid, 'sys.inject_tokens', packed.tokens, now())
    }
  } catch { /* 采样失败不影响注入 */ }
  return packed.text
}

// 一轮结束：assistant 正文 + 用户那句 → 记忆 / 情绪 / 驱力
const pendingReply = new Map()
const commitTimers = new Map()

// 纪要节流：同一个会话每 6 轮压一次，避免把一天的原文反复重算。
const narrativeTick = new Map()

function summarizeForDiary() {
  try {
    return model.status().primary === 'ok' ? (turns) => model.summarize(turns) : null
  } catch { return null }
}

/** 冷层衍生：纪要与日记。都是后台，失败不影响对话。 */
function narrativeAfterTurn(db, aid, sid) {
  const day = now().slice(0, 10)
  const key = aid + ':' + sid
  const n = (narrativeTick.get(key) || 0) + 1
  narrativeTick.set(key, n)
  if (n % 6 === 0) {
    try { buildEpisode(db, aid, { session: sid, day }) } catch { /* 纪要失败下次再来 */ }
  }
  // 日记交给每天 10:00 的巩固 worker，不在第一条消息时抢跑。
}

function commitTurn(db, aid, sid) {
  const u = lastUser.get(sid)
  const aText = pendingReply.get(sid)
  pendingReply.delete(sid)
  const timer = commitTimers.get(sid)
  if (timer) { clearTimeout(timer); commitTimers.delete(sid) }
  if (!u || !aText) return
  lastUser.delete(sid)
  const pushed = pushedTurns.delete(sid)
  const at = now()
  try {
    db.prepare('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?)').run(nid('cht_'), aid, 'user', u, '[]', null, at)
    db.prepare('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?)').run(nid('cht_'), aid, 'agent', aText, '[]', null, now())
    db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(at, aid)
    // T4 原文层：assistant 这句也落冷库（user 那句在 captureTurn 时已经落了）
    try { appendTurn(db, aid, { sessionId: sid, role: 'assistant', text: aText, at: now() }) } catch { /* 原文失败不影响对话 */ }
    pushTurn(aid, { role: 'assistant', text: aText, at: now(), sessionId: sid })
    // 用户真的回了：把之前投递过的主动消息结账（回答/忽略的统计靠这个）
    // 主动推消息自己引发的那一轮不算「用户回了」，别把回复率刷高。
    if (!pushed) {
      try { settleProactiveAnswered(db, aid) } catch { /* 统计失败不影响对话 */ }
    }
    __probe('commit u=' + u.slice(0, 10) + ' aLen=' + aText.length + (pushed ? ' push-turn' : ''))
  } catch (e) { __probe('insert-err:' + (e && e.message)) }
  // 关系账本：用户这句原话就是一笔账（说话人 touch / 提及 / 新手建人 / 删过的复用原卡）。
  // 这里以前是空的——所以「小周是我同事」说一百遍，关系图上也不长人。
  try {
    R.ingest(db, aid, { text: u, sessionId: sid, source: 'chat' })
    enqueueRelationRead(db, aid, { text: u })
    // 入队后马上跑一次，不等 30 秒的轮询：用户说完这句话，下一句之前账本就该是对的。
    // 仍然走异步（不阻塞回复），只是把「最坏等 30 秒」压到 1–2 秒。
    const t = setTimeout(() => { runRelationReadTick() }, 1500)
    if (t.unref) t.unref()
  } catch (e) { __probe('rel-ingest-err:' + (e && e.message)) }
  try { narrativeAfterTurn(db, aid, sid) } catch { /* 冷层衍生失败不影响对话 */ }
  if (!pushed) {
    // 评价 → 关系：同一份 appraisal 只算一次；关系事件吃它的结果，不再另起一套关键词
    const learning = getParam(db, aid, 'memory.auto') !== false
    Promise.resolve().then(async () => {
      let res = null
      try { res = await appraiseWithEdges(db, aid, u) } catch { /* 情绪失败不影响对话 */ }
      // 回读：她刚说出来的那句跟当下慢情绪对一对，差得远才小步挪（不是一句话定情绪）
      try { applySelfRead(db, aid, aText) } catch { /* 回读失败不影响对话 */ }
      if (learning) { try { learnFromTurn(db, aid, u, res) } catch { /* 学习失败不影响对话 */ } }
    }).catch(() => {})
    // 自动记忆开关：关掉之后这一轮不再自动抽出记忆 / 偏好；对话档案（原文）照旧落。
    if (learning) {
      // P2 异步抽取：先落队列，再由 worker 慢慢跑；进程这会儿挂了也不会丢
      try {
        enqueueExtraction(db, aid, [{ role: 'user', text: u }, { role: 'assistant', text: aText }])
        runExtractionTick()
      } catch { /* 入队失败不影响对话 */ }
    }
  }
  try { tickOneShadow(db) } catch { /* 影子推进失败不影响对话 */ }
  try { tickRitual(db, aid) } catch { /* 关系仪式衰减失败不影响对话 */ }
  try { tickConflicts(db, aid) } catch { /* 冲突悬置衰减失败不影响对话 */ }
  try { tickEscalation(db, aid) } catch { /* 冲突升级失败不影响对话 */ }
  try { evaluateDrive(db, aid) } catch { /* 暂停或数据缺失 */ }
}

function captureTurn(db, aid, session, event) {
  if (!event || !session || !session.id) return
  const sid = String(session.id)
  lastSessions.set(aid, { sid: session.id, at: Date.now() })
  // 事件名和 data 形状归宿主适配层管（host/dsh.js），这里只认「是谁说的」。
  const turn = readEvent(event)
  if (turn.kind === 'user') {
    const t = cleanUserText(turn.text)
    if (t) {
      lastUser.set(sid, t)
      if (t.startsWith('（它主动来找你')) pushedTurns.add(sid)
      // T4 原文层：用户这句话先落冷库，哪怕这一轮最后没有回复也不丢。
      try { appendTurn(db, aid, { sessionId: sid, role: 'user', text: t, at: now() }) } catch { /* 原文失败不影响对话 */ }
      // 缓冲：这一轮还没 commit，先挂着，保证「刚说的」能被注入
      pushTurn(aid, { role: 'user', text: t, at: now(), sessionId: sid })
    }
    return
  }
  if (turn.kind !== 'assistant') return
  if (!lastUser.has(sid)) {
    try {
      const evs = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      for (let i = evs.length - 1; i >= 0; i--) {
        const found = readEvent(evs[i])
        if (found.kind === 'user') {
          const t = cleanUserText(found.text)
          if (t) { lastUser.set(sid, t); break }
        }
      }
    } catch { /* 日志读不到 */ }
  }
  const reply = turn.text
  if (!reply) return // 工具调用步没有正文，继续等
  // 浮现观测：回复里有没有真的用上这几轮注入的记忆（十轮内只判一次）。
  try { markSurfacedUsed(db, aid, reply) } catch { /* 观测失败不影响对话 */ }
  pendingReply.set(sid, reply)
  const old = commitTimers.get(sid)
  if (old) clearTimeout(old)
  const timer = setTimeout(() => {
    try { commitTurn(db, aid, sid) } catch { /* 忽略 */ }
  }, 1200)
  if (timer.unref) timer.unref()
  commitTimers.set(sid, timer)
  __probe('reply-buffered len=' + reply.length)
}

function activeAgentId(db) {
  try {
    const r = db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY COALESCE(last_interaction_at, created_at) DESC LIMIT 1").get()
    return r ? r.id : null
  } catch { return null }
}

/** 后台补数据用：paused 也算（只是不主动开口），只有软删的排除。 */
function latestAgentId(db) {
  try {
    const r = db.prepare("SELECT id FROM agents WHERE status!='soft_deleted' ORDER BY COALESCE(last_interaction_at, created_at) DESC LIMIT 1").get()
    return r ? r.id : null
  } catch { return null }
}

// ---------------- P2 抽取 worker ----------------

let extractTimer = null

/** 跑一次抽取队列（不阻塞对话；失败按队列里的退避规则重试）。 */
async function runExtractionTick() {
  let d
  try { d = ensureDb() } catch { return }
  const aid = latestAgentId(d)
  if (!aid) return
  // 自动记忆关着就不往库里写：队列先留着，打开后下一轮会慢慢补上
  if (getParam(d, aid, 'memory.auto') === false) return
  try {
    await tickExtraction(d, aid, (turns) => ingest(d, aid, { turns }), { max: 1 })
  } catch { /* 这一轮失败，下一轮再来 */ }
}

function startExtractionWorker() {
  if (extractTimer) return
  extractTimer = setInterval(() => { runExtractionTick() }, 30000)
  if (extractTimer.unref) extractTimer.unref()
  setTimeout(() => { runExtractionTick() }, 6000)
}

// ---------------- 关系读人 worker ----------------

let relationTimer = null

/** 规则已经把名字记下了；这一层让模型补「谁是谁的谁」（小周是主人同事）。 */
async function runRelationReadTick() {
  let d
  try { d = ensureDb() } catch { return }
  const aid = latestAgentId(d)
  if (!aid) return
  try {
    await tickRelationRead(d, aid, { complete: (a) => model.complete(a) })
  } catch { /* 这一条失败，下一轮再来 */ }
}

function startRelationWorker() {
  if (relationTimer) return
  relationTimer = setInterval(() => { runRelationReadTick() }, 30000)
  if (relationTimer.unref) relationTimer.unref()
  setTimeout(() => { runRelationReadTick() }, 9000)
}

// ---------------- P4 夜间巩固 ----------------

let nightlyTimer = null
let nightlyBusy = false
// 每天几点写日记；默认 23:00（本地时间），可用 DSHC_DIARY_HOUR 改。
const DIARY_HOUR = Math.min(23, Math.max(0, Number(process.env.DSHC_DIARY_HOUR ?? 23)))
// 关机 / 休眠错过时最多往回补几天；0 = 不补（只在到点那一刻写当天）。
const DIARY_BACKFILL_DAYS = Math.min(30, Math.max(0, Number(process.env.DSHC_DIARY_BACKFILL_DAYS ?? 7)))

/** 下一个 23:00（本地时间）的时间戳。 */
function nextDiaryAt(from = Date.now()) {
  const d = new Date(from)
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DIARY_HOUR, 0, 0, 0)
  if (t.getTime() <= from) t.setDate(t.getDate() + 1)
  return t.getTime()
}

/**
 * 补写：把「到点没赶上」的日记按天补上。
 * 关机 / 休眠 / 定时器被挂起，都不再丢一天；只补还有原料的天，补的标 late=1。
 */
async function catchUpDiaries(reason) {
  if (nightlyBusy) return
  let d
  try { d = ensureDb() } catch { return }
  const aid = latestAgentId(d)
  if (!aid) return
  // 关系每天走一次时间：三轴回归基线 + 淡出 / 归档（9 号 §5.2）。
  // tick 按「上次见面时间」算绝对目标，一天跑几次结果一样，不会累积扣。
  try { R.tick(d, aid) } catch (e) { __probe('rel-tick-err:' + (e && e.message)) }
  const days = dueDiaryDays(d, aid, { hour: DIARY_HOUR, backfillDays: DIARY_BACKFILL_DAYS })
  if (!days.length) return
  nightlyBusy = true
  try {
    const summarize = summarizeForDiary()
    for (const day of days) {
      // 那天一句原文都没有（一直没开机）就不写：日记不编不存在的一天。
      if (!hasDiaryMaterial(d, aid, day)) continue
      const out = await runNightly(d, aid, { day, summarize })
      __probe('nightly(' + reason + ') day=' + day + ' late=' + (out.late === undefined ? '-' : out.late) + ' ms=' + (out.ms || 0) + ' diary=' + out.diary_day)
    }
    // 巩固完记忆，顺手长一次「喜欢 / 讨厌」：自动、只增不减，模型没接上就一条都不长
    try {
      const g = await autoGrowPreferences(d, aid)
      __probe('grow-prefs(' + reason + ') added=' + g.added.length + ' reason=' + (g.reason || 'ok') + ' model=' + g.model)
    } catch (e) {
      __probe('grow-prefs-err(' + reason + '):' + (e && e.message))
    }
  } catch (e) {
    __probe('nightly-err(' + reason + '):' + (e && e.message))
  } finally {
    nightlyBusy = false
  }
}

/** 23:00 的准点定时器：到点就检查一遍该写哪几篇（补写逻辑自己按天判断）。 */
function scheduleNightly() {
  if (nightlyTimer) return
  const target = nextDiaryAt()
  const delay = Math.max(1000, target - Date.now())
  nightlyTimer = setTimeout(() => {
    nightlyTimer = null
    catchUpDiaries('clock').catch(() => {}).finally(() => scheduleNightly())
  }, delay)
  if (nightlyTimer.unref) nightlyTimer.unref()
}

function startNightlyWorker() {
  // 启动后补一次：关机 / 休眠期间错过的日记在这里补上（等 archive 迁移先跑完）
  const boot = setTimeout(() => { catchUpDiaries('boot') }, 15000)
  if (boot.unref) boot.unref()
  // 每半小时兜底一次：睡醒、久开后跨天、准点定时器被挂起，都能接上
  const tick = setInterval(() => { catchUpDiaries('tick') }, 30 * 60 * 1000)
  if (tick.unref) tick.unref()
  scheduleNightly()
}

/**
 * 「喜欢 / 讨厌」是它自己长的，不用人按按钮。
 *
 * 每 10 分钟问一次该不该长（features.growPrefsDue 判：离上次 ≥30 分钟、
 * 且至少多了 3 条新记忆），够条件才真的花一次模型调用；长出来的标 origin=auto，
 * 接口层一律不许删。首次启动等 4 分钟，避开启动期的迁移和补写。
 */
let growPrefsTimer = null
let growPrefsBusy = false

async function growPrefsTick(reason) {
  if (growPrefsBusy) return
  let d
  try { d = ensureDb() } catch { return }
  const aid = latestAgentId(d)
  if (!aid) return
  growPrefsBusy = true
  try {
    const out = await autoGrowPreferences(d, aid)
    if (out.added && out.added.length) {
      __probe('auto-grow-prefs(' + reason + ') added=' + out.added.length + ' → ' + out.added.map((x) => x.tag).join('、'))
    }
  } catch (e) {
    __probe('auto-grow-prefs-err(' + reason + '):' + (e && e.message))
  } finally {
    growPrefsBusy = false
  }
}

function startGrowPrefsWorker() {
  const boot = setTimeout(() => { growPrefsTick('boot').catch(() => {}) }, 4 * 60 * 1000)
  if (boot.unref) boot.unref()
  growPrefsTimer = setInterval(() => { growPrefsTick('tick').catch(() => {}) }, 10 * 60 * 1000)
  if (growPrefsTimer.unref) growPrefsTimer.unref()
}

/** 宿主有没有「往会话里推一条消息」的口子（sessionController.prompt）。 */
function pushPort() {
  try {
    const sc = hostCtx && hostCtx.get('sessionController')
    if (!sc || typeof sc.prompt !== 'function') return null
    return sc
  } catch { return null }
}

/**
 * 把待发那句直接推进最近的会话：不再等对方先开口。
 * 成功才把 proactive 标成 delivered；失败就留着，下一轮对话照样会被带出来。
 */
async function maybePushProactive(db, aid, out) {
  try {
    if (!out || !out.queued || !out.id || !out.text) return
    let prefs = null
    try { prefs = getProactivePrefs(db, aid) } catch { /* 偏好读不到就不推 */ }
    if (!prefs || !prefs.push) return
    const rec = lastSessions.get(aid)
    const res = await pushProactiveLine({
      db, aid, line: out.text, proactiveId: out.id,
      sessionId: rec ? rec.sid : null, controller: pushPort(), prefs,
    })
    if (res.ok) __probe('push-ok id=' + out.id + ' sid=' + String(rec.sid).slice(0, 8))
    else __probe('push-skip ' + res.reason + (res.error ? ' ' + res.error : ''))
  } catch (e) {
    __probe('push-err ' + (e && e.message))
  }
}

/**
 * 全局对话接入：只要有一个意识体在运行，**所有会话**都是它。
 * 关掉（暂停）之后，所有会话恢复成普通 DSH。
 *
 * 探针：控制台看不到插件的 console.error，所以关键行落 hook.log。
 * 逐事件行默认不写（一次工具调用就一行，几分钟上百行）；
 * 要看事件链路时设 DSHC_PROBE_EVENTS=1。
 */
function __probe(msg) {
  try {
    if (msg.startsWith('event:') && process.env.DSHC_PROBE_EVENTS !== '1') return
    const p = path.join(path.dirname(DB_PATH), 'hook.log')
    if (msg === 'apply-enter') rotateProbe(p)
    fs.appendFileSync(p, new Date().toISOString() + ' ' + msg + '\n')
  } catch { /* 探针失败忽略 */ }
}

/** 每次启动先看大小：超过 4MB 就把上一份挪成 hook.log.1（只留一代）。 */
function rotateProbe(p) {
  try {
    if (fs.statSync(p).size > 4 * 1024 * 1024) fs.renameSync(p, p + '.1')
  } catch { /* 文件还不存在，正常 */ }
}

/**
 * 四个接缝的**业务内容**。宿主怎么调用它们由 src/host/dsh.js 决定：
 * 这里只说「注入什么」「收到事件做什么」「挂哪些路由」，不碰任何宿主 API。
 * 只要有一个意识体在运行，**所有会话**都是它；暂停之后全部恢复成普通 DSH。
 */
function hostSpec() {
  const db = () => ensureDb()

  return {
    // 1) 系统提示：人格 / 情绪 / 关系 / 禁忌 / 记忆
    systemPrompt: {
      name: 'dsh-consciousness',
      order: 12,
      text: () => {
        try {
          const id = activeAgentId(db())
          return id ? consciousnessBlock(db(), id) : ''
        } catch { return '' }
      },
    },

    // 2) 每个 step 之前：拿这一轮用户的话去召回，60 秒内有效
    preStep: async (payload, next) => {
      try {
        const d = ensureDb()
        const aid = activeAgentId(d)
        if (aid) {
          const msgs = (payload && payload.messages) || []
          let q = ''
          let prevUser = ''
          for (let i = msgs.length - 1; i >= 0; i--) {
            const t = cleanUserText(messageText(msgs[i]))
            if (!t) continue
            if (!q) { q = t; continue }
            if (msgs[i].role === 'user') { prevUser = t; break }
          }
          // 「那个库」这类指代：单看这一句接不上，把上一句用户话拼进来再用
          const qRaw = q
          if (q) q = contextualQuery(prevUser, q)
          if (q) {
            const mode = String(getParam(d, aid, 'memory.retrieve.formula') || 'v2')
            const t0 = Date.now()
            if (mode === 'v3') {
              const lambda = Number(getParam(d, aid, 'memory.decay.lambda')) || 0.02
              const opt = {
                k: 6,
                floor: Math.max(0, Math.min(0.9, Number(getParam(d, aid, 'memory.recall.floor')) || 0)),
                decayVersion: String(getParam(d, aid, 'memory.decay.formula') || 'v1'),
                decayScale: Math.max(0.1, Math.min(10, 0.02 / lambda)),
              }
              // 候选池 + 关系加成：和 v2 路径同一套参数，v3 也从这里读
              const poolN = Number(getParam(d, aid, 'memory.inject.pool'))
              if (Number.isFinite(poolN) && poolN > 0) opt.pool = Math.max(10, Math.min(200, Math.round(poolN)))
              // 图扩散：回看/深查最多几跳、二跳打几折（S1 在检索里恒 1 跳，不花这里的时间）
              const hopN = Number(getParam(d, aid, 'memory.recall.link.hops'))
              if (Number.isFinite(hopN) && hopN > 0) opt.linkHops = Math.max(1, Math.min(3, Math.round(hopN)))
              const linkDecay = Number(getParam(d, aid, 'memory.recall.link.decay'))
              if (Number.isFinite(linkDecay) && linkDecay > 0) opt.linkDecay = Math.max(0.2, Math.min(1, linkDecay))
              if (String(getParam(d, aid, 'memory.recall.typeweights') || 'on') === 'off') opt.typeWeights = false
              // 原文层分龄：0/未设 = 不限；查询里说"很久以前"时 retrieve 内部会自动放开
              const archDays = Number(getParam(d, aid, 'memory.recall.archive.days'))
              if (Number.isFinite(archDays) && archDays > 0) opt.archiveDays = Math.max(1, Math.min(3650, Math.round(archDays)))
              const relW = Math.max(0, Math.min(1, Number(getParam(d, aid, 'memory.recall.weights.relation')) || 0))
              if (relW > 0) {
                opt.relation = relW
                try {
                  opt.relMap = new Map(d.prepare(`SELECT e.memory_id AS id, MAX(p.closeness) AS c
                    FROM rel_evidence e JOIN rel_person p ON p.id = e.person_id
                    WHERE e.agent_id=? AND e.memory_id IS NOT NULL GROUP BY e.memory_id`).all(aid)
                    .map((r) => [r.id, Number(r.c) || 0]))
                } catch { /* 关系表不可用时只走字面 */ }
              }
              // 心情一致加成：心情好更容易想起好事（mood-congruent recall）
              const moodW = Math.max(0, Math.min(1, Number(getParam(d, aid, 'memory.recall.weights.mood')) || 0))
              if (moodW > 0) {
                try {
                  opt.moodW = moodW
                  opt.mood = moodValenceOf(d, aid)
                } catch { /* 情绪拿不到就只走字面 */ }
              }
              // 配额浮现：重要度锚点 / 24h 新近各留一席；off 时退回纯相关度。
              if (String(getParam(d, aid, 'memory.float.enable') || 'on') === 'off') opt.float = false
              else {
                const na = Number(getParam(d, aid, 'memory.float.anchor'))
                if (Number.isFinite(na)) opt.anchor = Math.max(0, Math.min(3, Math.round(na)))
                const nf = Number(getParam(d, aid, 'memory.float.fresh'))
                if (Number.isFinite(nf)) opt.fresh = Math.max(0, Math.min(3, Math.round(nf)))
                const fh = Number(getParam(d, aid, 'memory.float.fresh_hours'))
                if (Number.isFinite(fh) && fh > 0) opt.freshHours = Math.max(1, Math.min(720, Math.round(fh)))
              }
              // 向量通道：查询向量在收到消息时就算好了，这里只等一小会儿；没有就只走词法。
              if (String(getParam(d, aid, 'memory.retrieve.vector') || 'auto') !== 'off') {
                try {
                  // 等待上限走参数：bge-m3 冷启动经常超过原来的 150ms，等不到就白算一次向量。
                  const vwait = Math.max(0, Math.min(3000, Number(getParam(d, aid, 'memory.retrieve.vector.wait')) || 400))
                  const qv = (await takeEmbedding(q, vwait)) || (q !== qRaw ? await takeEmbedding(qRaw, 0) : null)
                  if (qv) opt.queryVec = qv
                } catch { /* 向量失败不影响词法 */ }
              }
              let r = retrieve(d, aid, q, opt)
              // 字面翻不到 / 置信度低：用「预取好的」模型改写 + 扩词再召回一次。
              // 注意这里只拿结果、不发请求：请求在收到用户消息时就发出去了（prefetchExpand），
              // 现在最多再等 wait 毫秒。等不到就先用词法结果——宁可这次少想起一点，不能拖住这一轮。
              const expandMode = String(getParam(d, aid, 'memory.retrieve.expand') || 'low')
              if (expandMode !== 'off') {
                const keptN = r.debug && r.debug.kept
                  ? Object.values(r.debug.kept).reduce((n, x) => n + x, 0) : 0
                const lowConf = (r.debug && Number(r.debug.top) < 0.55) || keptN < 2
                if (expandMode === 'always' || lowConf) {
                  const wait = Math.max(0, Math.min(2000, Number(getParam(d, aid, 'memory.retrieve.expand.wait')) || 250))
                  // 只等预取，不在这里现场调模型：宿主模型一次 ~4.5s，pre-step 等不起。
                  // 单步回合拿不到扩词就算了——补召回靠写入侧的检索卡（离线生成、零延迟）。
                  const exp = (await takeExpansion(q, wait)) || (q !== qRaw ? await takeExpansion(qRaw, 0) : null)
                  if (exp && (exp.terms.length || exp.query)) {
                    const r2 = retrieve(d, aid, exp.query || q, { ...opt, terms: exp.terms, noUpgrade: true })
                    if (r2.items.length > r.items.length) {
                      r = { ...r2, why: (r2.why || []).concat('扩展：' + (exp.terms.join('/') || exp.query).slice(0, 48)) }
                      __probe('expand q=' + q.slice(0, 20) + ' terms=' + exp.terms.join('/').slice(0, 40)
                        + ' hits=' + r2.items.length)
                    }
                  }
                }
              }
              // 缓冲不再直接注入：运行时本来就把最近几轮给了模型，再塞一遍纯属重复占 token。
              // buffer 仍保留（重启重放、调试），只在 retrieve 内部当「没落盘的候选」用。
              // 记忆块的预算是整段注入预算的一半（整段由下面的 clampInjection 按同一个参数收口）。
              const allBudget = Math.max(200, Math.min(4000, Number(getParam(d, aid, 'memory.inject.budget')) || 800))
              const memBudget = Math.max(150, Math.min(800, Math.round(allBudget / 2)))
              const packed = packInjection({ items: r.items }, { budget: memBudget })
              // 被想起来 = 强化一次：hits+1、稳定度上涨、衰减锚点拨回现在。
              // v3 之前只召回不记账，等于「想过一次」在系统里不留痕——热度榜和冷热迁移都靠它。
              try {
                const ids = (r.items || []).filter((x) => x.partition === 'T1').map((x) => x.id)
                if (ids.length) touch(d, ids)
              } catch { /* 记账失败不影响注入 */ }
              recentRecall.set(aid, { at: Date.now(), q: q.slice(0, 40), text: packed.text })
              // 浮现观测：记下这一轮注入了哪些（anchor / fresh / related），回复后再判用没用上。
              try { recordSurfaced(d, aid, r.items || []) } catch { /* 观测失败不影响注入 */ }
              logRetrieval(d, aid, {
                scene: r.scene, query: q, why: r.why, counts: r.debug && r.debug.counts,
                kept: r.debug && r.debug.kept, dropped: packed.dropped.map((x) => x.section),
                items: (r.items || []).length, tokens: packed.tokens, ms: Date.now() - t0,
              })
              __probe('retrieve scene=' + r.scene + ' hits=' + (r.items || []).length
                + ' tokens=' + packed.tokens + ' dropped=' + packed.dropped.length)
            } else {
              const pack = recall(d, aid, q, 6, 512, { mood: moodValenceOf(d, aid) })
              const text = (pack.items || []).map((m) => '- ' + m.text).join('\n')
              recentRecall.set(aid, { at: Date.now(), q: q.slice(0, 40), text })
              logRetrieval(d, aid, {
                scene: 'v2', query: q, why: ['老召回路径'],
                items: (pack.items || []).length, tokens: Math.ceil(text.length / 2), ms: Date.now() - t0,
              })
              __probe('recall-q=' + q.slice(0, 24) + ' hits=' + (pack.items || []).length)
            }
          }
        }
      } catch (e) { __probe('recall-err:' + (e && e.message)) }
      return typeof next === 'function' ? next() : undefined
    },

    // 3) 会话事件：用户说了什么、模型回了什么
    sessionEvent: (session, event) => {
      __probe('event:' + (event && event.type))
      try {
        const id = activeAgentId(db())
        if (id) {
          // 收到用户消息就先让模型改写/扩词、算查询向量：等 pre-step 跑到时，结果大概率已经回来了。
          // 这里只预取、不阻塞；失败静默，pre-step 会退回纯词法。
          try {
            const ev = readEvent(event)
            if (ev.kind === 'user') {
              const t = cleanUserText(ev.text)
              if (t) {
                prefetchExpand(t)
                try { prefetchEmbedding(t) } catch { /* 没有 embedding 能力时静默 */ }
              }
            }
          } catch { /* 预取失败不影响事件处理 */ }
          captureTurn(db(), id, session, event)
        }
      } catch { /* 单条事件失败不影响对话 */ }
    },

    // 4) HTTP：API / SSE / ping
    webServer: (child) => {
      const d1 = child.webServer.register({
        kind: 'exact',
        path: API_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' } })
            return
          }
          try {
            const env = await readJson(req)
            const out = await handle(ensureDb(), env)
            sendJson(res, out.status || 200, out.body)
          } catch (e) {
            const status = dbError ? 503 : 400
            sendJson(res, status, { error: { code: dbError ? 'DB_UNAVAILABLE' : 'INVALID_ARGUMENT', message: String(e.message || e) } })
          }
        },
      })
      const d2 = child.webServer.register({
        kind: 'exact',
        path: PING_PATH,
        handler: (_req, res) => {
          sendJson(res, 200, {
            ok: !dbError,
            plugin: name,
            schema: schemaVersion(ensureDb()),
            recovered,
            db: DB_PATH,
            pending: getFlag(ensureDb(), 'pending_agent'),
            active_agent: activeAgentId(ensureDb()),
            push_port: !!pushPort(),
            host: host ? host.report() : null,
            error: dbError ? String(dbError.message || dbError) : undefined,
          })
        },
      })
      const d3 = child.webServer.register({
        kind: 'exact',
        path: '/dsh-consciousness/events',
        handler: (req, res) => {
          const u = new URL(req.url, 'http://x')
          const aid = u.searchParams.get('agent') || ''
          let last = Number(u.searchParams.get('last') || 0)
          let closed = false
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          res.write(': connected\n\n')
          const timer = setInterval(() => {
            if (closed) return
            try {
              const rows = eventsSince(ensureDb(), aid, last)
              for (const r of rows) {
                last = r.rowid
                res.write(`event: dshc\ndata: ${JSON.stringify(r)}\n\n`)
              }
              res.write(': ping\n\n')
            } catch { /* agent 不存在时只发心跳 */ }
          }, 1000)
          req.on('close', () => { closed = true; clearInterval(timer) })
        },
      })
      /* 前端热更新用：client.js / index.js 的「最后改过」指纹。
         页面每隔一会儿问一次，指纹变了就自己刷新，省得每次都按 Ctrl+F5。 */
      const stampOf = (file) => {
        try {
          const s = fs.statSync(new URL('./' + file, import.meta.url))
          return String(Math.round(s.mtimeMs)) + ':' + s.size
        } catch { return '0' }
      }
      const d4 = child.webServer.register({
        kind: 'exact',
        path: '/dsh-consciousness/version',
        handler: (_req, res) => {
          sendJson(res, 200, {
            plugin: name,
            client: stampOf('client.js'),
            host: stampOf('index.js'),
            at: Date.now(),
          })
        },
      })
      return () => {
        try { d1() } catch { /* ignore */ }
        try { d2() } catch { /* ignore */ }
        try { d3() } catch { /* ignore */ }
        try { d4() } catch { /* ignore */ }
      }
    },

    // 5) 工具：模型能真正调用的行动接口（发消息 / 浏览 / 研究 / 提醒）。
    // 端口没开时工具仍在，执行时返回「接口未开启」，模型知道有这回事但动不了手。
    tools: createActionTools({
      getDb: () => ensureDb(),
      getAgentId: () => activeAgentId(ensureDb()),
      getWeb: () => optionalService('web'),
      getModel: () => model,
      log: __probe,
    }),
  }
}

/** 宿主契约报告（ping 里同一份；测试和排障都读它）。 */
export function hostReport() {
  return host ? host.report() : null
}

function optionalService(name) {
  if (!hostCtx) return null
  try {
    if (typeof hostCtx.get === 'function') return hostCtx.get(name)
  } catch { /* 没 inject 时会抛，继续试属性 */ }
  try { return hostCtx[name] } catch { return null }
}

/**
 * 向量模型保活：Ollama 空闲几分钟会把模型卸掉，下一次查询要等 2~3 秒。
 * 每 4 分钟轻轻打一次（一次约 36ms），查询侧就一直热的，不用再等冷启动。
 */
let embedWarmTimer = null
function startEmbedKeepalive() {
  if (embedWarmTimer) return
  embedWarmTimer = setInterval(() => {
    try {
      if (!model.capabilities().embed) return
      model.embed(['keepalive']).catch(() => { /* 服务没起就下次再试 */ })
    } catch { /* 没有向量能力时静默 */ }
  }, 4 * 60 * 1000)
  if (embedWarmTimer.unref) embedWarmTimer.unref()
}

export function apply(ctx) {
  try { attachHostLlm(() => ctx) } catch { /* llm 服务不可用 */ }
  try { hostCtx = ctx } catch { /* 宿主上下文不可用 */ }
  try { attachActionDeps({ getWeb: () => optionalService('web'), getModel: () => model }) } catch { /* 行动层降级 */ }
  if (!acquireLock()) {
    console.error('[dsh-consciousness-v6] another instance holds the lock; plugin stays offline')
    return
  }
  // 绝不让本插件的初始化异常拖垮 Desktop Host（否则 welcome 鉴权失败，整个 DeepSeek 打不开）。
  try {
    ensureDb()
    startMaintenance()
    startEmbedKeepalive()
  } catch (e) {
    console.error('[dsh-consciousness-v6] db init failed (plugin stays soft-offline):', e)
  }

  __probe('apply-enter lock=' + lockHeld)
  // 宿主接缝：四个各自探测、各自安装、各自降级。缺哪个只丢哪个，ping 里报出来。
  // 界面是 Client 半（client.js），由 dsh.client 模块加载并注册进 settings.section。
  host = createHost({
    log: (m) => {
      // 控制台看不到，所以 reason 也进 hook.log——上一轮就是只记 summary 才定位不了
      console.error(m)
      __probe('hostlog ' + m)
    },
  })
  try {
    const report = host.install(ctx, hostSpec())
    __probe('host ' + report.summary)
    // pending 是 transient（等 inject 回调），只有真降级才值得报错
    const bad = report.seams.filter((s) => s.level === 'error' || s.level === 'degraded' || s.level === 'absent')
    if (bad.length) console.error('[dsh-consciousness-v6] host degraded:', report.summary)
    const settled = setTimeout(() => {
      try { __probe('host-settled ' + host.report().summary) } catch { /* ignore */ }
    }, 500)
    if (settled.unref) settled.unref()
  } catch (e) {
    console.error('[dsh-consciousness-v6] host attach failed:', e)
  }
}
