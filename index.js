import { dbPath } from './src/paths.js'
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
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDb, recover, now } from './src/db.js'
import { handle } from './src/api.js'
import { attachHostLlm, createHostJudgeModel, hostTalkModel } from './src/model.js'
import { eventsSince, getFlag, ingest, applyActiveRules, backupDrill, learnFromTurn, settleProactiveAnswered, clampInjection, appraiseWithEdges, tickOneShadow, applyDriverToDrive, getProactivePrefs, attachContextBlock, closingIntentOf } from './src/features.js'
// 主动开口零件入口：心跳只认这一个口，不直接碰零件内部
import { runSpeakTick } from './src/parts/speak/index.js'
import { nid, purgeExpired, evaluateDrive, recall, getParam, settleObservations, expireProposals, recoverChangeJournal, gcArtifacts, shrinkPersona, tickRitual, tickConflicts, maybeDraft, TARGET_IDS, latestUserEmotion, decayAffect, getDrive, spontaneousTick } from './src/core.js'
import { seedRuleBindings } from './src/modules/artifacts.js'
import {  } from './src/modules/values.js'
import { axisWords, mbtiPrompt } from './src/modules/traits.js'
import { pulseDriveFromSignals } from './src/modules/drive.js'
import { pushProactiveLine } from './src/push.js'
import { pushProactiveToQQ, ownerChatKey, pushableLine } from './src/modules/qq_push.js'
import { claimLine } from './src/modules/conflict_ask.js'
import { examplesBlock, parseExamples } from './src/modules/examples.js'
import { presenceLine, webConversationId } from './src/modules/presence.js'
import { selfNoteLines as notesForPrompt } from './src/modules/selfnote.js'
import { heartNoteTick, heartNoteLines, heartNoteWakeTick } from './src/modules/heartnote.js'
import { memoryTag, ageDays } from './src/modules/memory_tag.js'
import { fadeText, shouldFade, rehearseAdjustedAge } from './src/modules/memory_fade.js'
import { detectMode, resolveMode, styleInjection, kaomojiLine } from './src/modules/style_mode.js'
import { auditStore } from './src/modules/ops.js'
import { cleanUserText } from './src/text.js'
import { toneOf } from './src/algo/reldyn.js'
import { expressionState, cardLine, subtextOf, subtextClass } from './src/modules/expression_state.js'
import { judgeSpeech, recordShadow, judgeCompare, recordCompare, recordMiss, toModelRequest } from './src/modules/speech_judge.js'
import { latestVoice, recentVoices, generateVoice, recordVoice } from './src/modules/speech_words.js'
import { attachDb } from './src/algo/index.js'
import { createHost, readEvent, messageText } from './src/host/dsh.js'
import { appendTurn, buildEpisode, recentDiaryLines, migrateArchive, backfillFactArchive, sessionBridge } from './src/modules/archive.js'
import { pushTurn, hydrateFromRaw } from './src/modules/buffer.js'
import { retrieve, contextualQuery, deepRecall, wantsDeep } from './src/modules/retrieve.js'
import { recentSelfIds, shownCounts, markShown } from './src/modules/self_repeat.js'
import { prefetchExpand, takeExpansion } from './src/modules/expand.js'
import { prefetchEmbedding, takeEmbedding } from './src/modules/vector.js'
import { backfillEntities } from './src/modules/entities.js'
import { packInjection, oneLine, estTokens } from './src/modules/pack.js'
import { loopLineFor, loopPrefixOf, markLoopsFired, expireLoops } from './src/modules/loops.js'
import { recordSurfaced, markSurfacedUsed } from './src/modules/surfacing.js'
import { surfaceQueueTick, pendingSurface, consumeSurface } from './src/modules/pulse.js'
import { applySelfRead, readReplyTone } from './src/modules/self_read.js'
import { recordSelfResidue, residueCandidate, commitResidue, residueDirFor } from './src/modules/self_residue.js'
import { captureQuote, quoteCandidate, commitQuote } from './src/modules/quote_echo.js'
import { feltSnapshot } from './src/modules/felt_snapshot.js'
import { latestFeel, feelLineOf, echoFeelOf, echoFeelLineOf, attachableFeelId, FEEL_GUIDE } from './src/modules/feel.js'
import { logRetrieval } from './src/modules/retrieval_log.js'
import { asofInjectItems } from './src/modules/asof.js'
import { passportLine, isStale } from './src/modules/passport.js'
import { enqueueExtraction, makeTurnId } from './src/modules/extract_queue.js'
import { tickEscalation } from './src/modules/conflict.js'
import { readViews } from './src/modules/sangguan/bridge.js'
import {  } from './src/modules/sangguan/speak.js'
import { afterTurn as sangguanAfterTurn } from './src/modules/sangguan/fast.js'
import { promptHook as sangguanPrompt } from './src/modules/sangguan/inject.js'
import { ensureHeatBootstrapped, touch } from './src/modules/tiers.js'
import { model } from './src/kernel.js'
import * as R from './src/modules/relations.js'
import { enqueueRelationRead } from './src/modules/relations_extract.js'
import { createWorkers } from './src/host/workers.js'
import {
  attachSessionAgents,
  autoBindQQSession,
  qqContextOf, qqAidOf, agentOfSession, currentQQContext,
  activeAgentId, currentSessionId, sessionAgentId, pinSessionAgent,
  enabledAgentIds, probeSessionId, noteSessionEventId,
  initiatorAgentId, latestAgentId,
} from './src/host/session_agents.js'
export { autoBindQQSession }
import { moodValenceOf, moodLabelOf, trendOf, reviewTick } from './src/modules/affect.js'
import { addMemory, setFeelProvider } from './src/modules/memory.js'
import { openEmotion } from './src/modules/emotion_event.js'
import { createActionTools, attachActionDeps, executeBrowse, getConfig as getActionConfig } from './src/modules/actions/index.js'
import { maybeSpeakReply, takeVoiceShape, lastVoiceFlash } from './src/modules/actions/voice.js'
import { createVoiceServices } from './src/voice_service.js'
import { lifeTick, lifeLine } from './src/modules/life.js'
import { reappraiseLine } from './src/modules/reappraise.js'
import { canSayOnce } from './src/modules/sayonce.js'
import { resolveAgentId, refreshAll, refreshRuntime, sweepBindings, migrateLegacyBindings } from './src/modules/binding.js'
import { heartbeatTick } from './src/modules/heartbeat.js'
import { attachQQBridge, attachQQIngest, attachQQFeelProvider, isQQSessionId, qqChannelBlock } from './src/modules/qq_bridge.js'
import { findQQSessionsFile } from './src/modules/qq_watch.js'
import { mindLine, noteMeter, meterFromUsage, meterOf } from './src/modules/mindstate.js'
import { makeOwnerGuard, verdictFor } from './src/modules/owner_gate.js'

// 情绪注入的人话化交给 modules/expression_state.js（第一人称感受 + 软愿望）；这里不再保留「强度 / 心情 / 底色」的数字分档函数。
// 必须与 package.json / cordis.patch.yml 的包名一致，否则 loader 挂载异常。
export const name = 'dsh-consciousness-v6'
export const inject = []

const API_PATH = '/dsh-consciousness/api'
const PING_PATH = '/dsh-consciousness/ping'
const DB_PATH = dbPath()
const LOCK_PATH = path.join(path.dirname(DB_PATH), 'app.lock')

// 装配：记忆出生时挂 feel 的取数口。memory 模块不直接读 affect_feel（INV10），
// 由这里把「最近一条、窗口内才算」的口交出去。
setFeelProvider(attachableFeelId)

// 宿主上下文和最近见到的会话：主动发消息要用 sessionController.prompt 推进去。
let hostCtx = null
/** QQ 桥接适配句柄（attachQQBridge 的返回值）；null = 没挂上。 */
let qqBridgeHandle = null
/** QQ 对话回流句柄（attachQQIngest 的返回值）；null = 没挂上。 */
let qqIngestHandle = null
const lastSessions = new Map()
const pushedTurns = new Set()

let db = null
let recovered = 0
let dbError = null
let lockHeld = false
/** 宿主适配器：四个接缝的探测结果，ping 里原样报出去。 */
let host = null

/** 后台 workers（懒建：ensureDb 首次成功时再挂定时器）。 */
let workersApi = null
function wireSessionAgents() {
  attachSessionAgents({
    ensureDb,
    getParam,
    optionalService,
    probe: (msg) => __probe(msg),
  })
}

function workers() {
  wireSessionAgents()
  if (!workersApi) {
    workersApi = createWorkers({
      ensureDb,
      enabledAgentIds,
      summarizeForDiary,
      probe: (msg) => __probe(msg),
    })
  }
  return workersApi
}

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
    } catch { /* 锁文件坏了就当没有锁，删掉重来 */ }
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
  wireSessionAgents()
  if (db) return db
  if (dbError) throw dbError
  try {
    db = openDb(DB_PATH)
    recovered = recover(db)
    try { recoverChangeJournal(db) } catch { /* 变更日志恢复失败下次再试 */ }
    attachDb(db)
    applyActiveRules(db)
    // 老库迁移：把「本来就在她名下的会话」认领回来，别升级完把主人正在聊的那段变成普通 DSH
    try { migrateLegacyBindings(db) } catch { /* 迁移失败下次启动再试 */ }
    // 在场状态是派生值：每次启动按 bindings 重算一遍，别让上次崩溃留下的状态骗人
try { refreshAll(db) } catch { /* 状态重算失败，下次刷新再补 */ }
    // 分层记忆：老库补一次热度；顺手把最近三天缺的日记补上（后台，失败不影响启动）
try { ensureHeatBootstrapped(db) } catch { /* 热度补齐失败下次再来 */ }
    setTimeout(() => {
      try {
        // 补数据不看 status：paused 的也要补（paused 只是不主动开口，不是不存在）
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
    try { workers().startExtractionWorker() } catch { /* 抽取 worker 起不来不影响启动 */ }
    // 关系读人 worker：把排队的人物提及读成「谁是谁的谁」
    try { workers().startRelationWorker() } catch { /* 读人 worker 起不来不影响启动 */ }
    // P4 夜间巩固：每晚 23:00 写日记；关机 / 休眠错过的，下次启动或半小时内补上。
    try { workers().startNightlyWorker() } catch { /* 巩固 worker 起不来不影响启动 */ }
    try { workers().startDiaryRetryWorker() } catch { /* diary retry worker unavailable */ }
    // 偏好自己长：10 分钟一次，够条件才真调模型；长出来的删不掉
    try { workers().startGrowPrefsWorker() } catch { /* 长偏好 worker 起不来不影响启动 */ }
    // 微信收信：一分钟一次，只读本地库（不动窗口）；第一次见到的会话只落水位，不灌历史
    try { workers().startWeChatInboxWorker() } catch { /* 收信 worker 起不来不影响启动 */ }
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
        // 存储体检：索引漏条 / 孤儿边自动修（不修也不会报错，只会静默少召回）
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
}

// ---------------- 每实例心跳（schema 12） ----------------
// 一个 30 秒的扫描器，按 heartbeats.next_at 决定谁该醒；每人分两档：
//   light（零模型）：情绪衰减、浮现候选、开环到期、驱力日结、在场状态。
// 以前这里是一个全局 10 分钟 tick 遍历「active」，既看不出谁停了，也会一起撞模型。
/** 轻活：同步、毫秒级、绝不调模型（测试里会断掉 deep=0）。 */
function heartbeatLight(aid) {
  const d = ensureDb()
  // 自发的小起伏：很久没人说话，偶尔自己心里动一下（纯规则，不调模型）
  try { spontaneousTick(d, aid, Date.now()) } catch { /* 撒点失败不影响心跳 */ }
// 情绪按墙钟衰减：用「上次更新到现在」的真实小时数，不按固定 24h 重复衰减。
        try {
    const row = d.prepare('SELECT updated_at FROM affect_state WHERE agent_id=?').get(aid)
    const last = row && row.updated_at ? Date.parse(row.updated_at) : 0
    if (last) {
      const hours = Math.max(0, (Date.now() - last) / 3600000)
      if (hours >= 0.5) decayAffect(d, aid, Math.min(24 * 30, hours))
    }
} catch { /* 没有情绪数据就跳过 */ }
  // 事后复查（影子）：判过的过几个钟头换一个身份再看一眼。只记不改。
  // 异步、失败静默——心跳不能被一次模型调用拖住。
  try { Promise.resolve().then(() => reviewTick(d, aid)).catch(() => {}) } catch { /* 复查失败跳过 */ }
  // 空闲心跳：不调模型，只给「自己浮上来」补候选（下一轮注入时最多取一条）
  try { surfaceQueueTick(d, aid) } catch { /* 心跳失败跳过 */ }
  // 心事拍：数一拍、把「露过没再碰」的那条散掉。不调模型，闸在 heartnote.js 里（静默/间隔/日上限）
  try { heartNoteTick(d, aid, Date.now()) } catch { /* 心事拍失败跳过 */ }
  // 挂着的开环到期的收掉，别一直占着注入名额
  try { expireLoops(d, aid) } catch { /* 开环失败跳过 */ }
  // 驱力：事件脉冲 + 代理推缺口 + 日结（纯规则）
try { applyDriverToDrive(d, aid) } catch { /* 驱动推缺口失败跳过 */ }
  try { pulseDriveFromSignals(d, aid) } catch { /* 事件脉冲失败跳过 */ }
  try { evaluateDrive(d, aid) } catch { /* 鏆傚仠鎴栨暟鎹己澶?*/ }
  try { shrinkPersona(d, aid) } catch { /* 人格收缩失败跳过 */ }
  try { seedRuleBindings(d, aid) } catch { /* 工件种子失败跳过 */ }
  try { tickOneShadow(d) } catch { /* 影子推进失败跳过 */ }
  // 在场状态：14 天没互动 = 自动休眠（只改 runtime，不改用户意图）
  try {
    let dormant = false
    try { dormant = !!getDrive(d, aid).dormant } catch { dormant = false }
    if (dormant) {
      d.prepare("INSERT INTO agent_runtime(agent_id,state,since,reason,updated_at) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(agent_id) DO UPDATE SET state='dormant', updated_at=excluded.updated_at")
        .run(aid, 'dormant', now(), 'idle-14d', now())
      d.prepare("UPDATE agents SET runtime_state='dormant' WHERE id=?").run(aid)
    } else {
      refreshRuntime(d, aid)
    }
  } catch { /* 在场状态下次刷新会改 */ }
  // 「这段对话还在用」的 TTL：太久没动静的会话自动松绑（这次扫描顺带做一遍全部的）
  try { sweepBindings(d, { idleDays: 30 }) } catch { /* 回收失败下次再来 */ }
}

/** 重活：可能叫模型，由心跳的 deep 档节流 + 全局并发闸护着。 */
async function heartbeatDeep(aid) {
  const d = ensureDb()
  // 叫醒：没有别人在场的一拍，也叫模型写一句。
  // 只在 deep 档跑（light 不许调模型）；开关 / 每 N 拍 / 日上限在 heartnote.js 里闸着，默认关。
  try {
    const w = await heartNoteWakeTick(d, aid, { complete: (req) => model.complete(req) })
    if (w && w.ran) __probe('heart-wake: ' + w.text)
  } catch { /* 叫醒失败不拖心跳 */ }
  try {
    const p = runSpeakTick(d, aid)
    const out = p && p.then ? await p : p
    // 无条件调：没有新排的也要看一眼积压里有没有该发的（拿到哪句由函数自己判断）。
    await maybePushProactive(d, aid, out)
  } catch { /* 主动消息失败跳过 */ }
  // 她自己的生活：每天最多一次。只读浏览；端口/宿主 web 没开就只「想一想」。
  try {
    const web = optionalService('web')
    let browseOn = false
    try {
      const r = d.prepare("SELECT enabled FROM action_ports WHERE agent_id=? AND name='browse'").get(aid)
      browseOn = !!(r && r.enabled)
    } catch { browseOn = false }
    await lifeTick(d, aid, {
      browse: (web && browseOn) ? ((args) => executeBrowse(d, aid, args, { web })) : null,
      model,
    })
  } catch { /* 生活失败不影响心跳 */ }
  // 自修改的起草（可能调模型），放在 deep 档，别占 light 的毫秒预算
for (const tid of TARGET_IDS) {
    try { maybeDraft(d, aid, tid) } catch { /* 单目标起草失败跳过 */ }
  }
}

function startHeartbeat() {
  // 插件热重载（plugin_manager 关→开）不会自动清掉裸 setInterval。
// 连着重载几次就会有几个心跳同时跳、互相抢 next_at。旧把手放 globalThis，新的先收掉。
const KEY = Symbol.for('dsh-consciousness.heartbeat')
  const prev = globalThis[KEY]
  if (prev && prev.scan) { try { clearInterval(prev.scan) } catch { /* 宸茬粡娌′簡 */ } }
  if (prev && prev.boot) { try { clearTimeout(prev.boot) } catch { /* 宸茬粡娌′簡 */ } }
  const scan = setInterval(() => {
    try {
      heartbeatTick(ensureDb(), Date.now(), {
        light: heartbeatLight,
        deep: heartbeatDeep,
        log: (m) => __probe(m),
        maxDeep: 2,
      }).catch((e) => __probe('heartbeat-err:' + (e && e.message)))
    } catch (e) { __probe('heartbeat-crash:' + (e && e.message)) }
  }, 30 * 1000)
  if (scan.unref) scan.unref()
  // 启动后 12 秒先扫一遍：把重启期间错过的 light 补上（deep 会按 deep_at 自己判，不抢跑）
  const boot = setTimeout(() => {
    try {
      heartbeatTick(ensureDb(), Date.now(), {
        light: heartbeatLight, deep: null, log: (m) => __probe(m),
      }).catch(() => {})
    } catch { /* ignore */ }
  }, 12000)
  if (boot.unref) boot.unref()
  globalThis[KEY] = { scan, boot }
  __probe('heartbeat-start')
}

// ---------------- 把它接进 DSH 的对话 ----------------
// 被「启动」的那个意识体会绑定到下一个新建的对话：那段对话里模型拿到的
// 系统提示会带上它的人格、情绪、关系和记忆；回复结束后再把这一轮写回记忆。
const lastUser = new Map()
/** 上一句用户话的时间：给参与度信号算间隔，只记不读。 */
const lastUserAt = new Map()
// 这一轮的身份证：用户那句话和助手那句话共用同一个 turn_id；
// 记忆靠它回到原话。以前从来不生成，所以 raw_turns.turn_id 全空，
// memory_items.source_turn_id 一条都 join 不上——「你还记得我当时说的」就只剩正文，没有出处。
const lastTurnId = new Map()

function str(row, path, d = '') {
  if (!row) return d
  const r = row.find((x) => x.path === path)
  if (!r || r.value == null) return d
  return String(r.value).replace(/^"|"$/g, '')
}

/** 一段可读的意识体自述，直接进系统提示。 */
export const recentRecall = new Map()

/**
 * 这一轮是闲聊还是干活（P3）。按最近一句用户话判，auto 模式下读它。
 * 和 recentRecall 一样是「本轮的」状态，不是长期记忆。
 */
export const styleModeCache = new Map()

/** 用户说了新的一句：更新模式判定。 */
export function noteStyleMode(aid, text) {
  const mode = detectMode(text)
  styleModeCache.set(aid, mode)
  return mode
}

/**
 * 用户说了新的一句：上一句的召回结果作废，必须重新检索。
 * 单独抽出来是为了能测——「缓存该不该复用」只看这一刻，不该靠时间猜。
 */
export function invalidateRecallCache(aid) {
  return recentRecall.delete(aid)
}

/**
 * 记忆块 = 检索结果 → 装箱。单独抽出来，是为了让「加不加时间标签」只有一处开关，
 * 也让离线脚本能测到和线上同一条路径（scripts/bench-humanlike.mjs）。
 * memory.inject.age=off 时与旧版逐字一致。
 */
export function packMemoryBlock(db, aid, items, budget) {
  const packOpt = { budget }
  try {
    const at = Date.now()
    const ageOn = String(getParam(db, aid, 'memory.inject.age') || 'on') !== 'off'
    const withProv = String(getParam(db, aid, 'memory.inject.provenance') || 'on') !== 'off'
    if (ageOn || withProv) packOpt.decorate = (it) => memoryTag(it, at, { provenance: withProv, age: ageOn })
    // 「今天刚发生」也要带来源：不然她刚写下的自己的事，在注入里看不出是「我自己记得的」。
    if (withProv) packOpt.provenanceTag = (it) => memoryTag(it, at, { provenance: true, age: false })
    // 内容级模糊：旧事的括号 / 数字 / 原话会被删掉（只删不改）。
// 钉住的、独立的 / 边界 / 承诺类的，同类型里打分最高的都不参与；10 天以内一个字都不动。
// 门槛按类型给（见 memory_fade.js 的 IMPORTANCE_GATE）；reflection 是双峰的。
// 一个数卡所有类型等于整类豁免。
if (String(getParam(db, aid, 'memory.inject.fade') || 'on') !== 'off') {
// 0 / 负数 = 整段关掉。不能用 || 3——那样「设成 0 想关」会变成「最强」。
      // 正好是反效果。空值 / 读不到才按默认 3。
const rawLv = String(getParam(db, aid, 'memory.fade.max_level') ?? '').trim()
      const n = Number(rawLv)
      const maxLevel = rawLv === '' || !Number.isFinite(n) ? 3 : (n <= 0 ? 0 : Math.min(3, Math.floor(n)))
      const useRehearsal = String(getParam(db, aid, 'memory.fade.rehearsal') || 'on') !== 'off'
      if (maxLevel > 0) {
        packOpt.fade = (it) => {
          const real = ageDays(it, at)
          // 标签上写的永远是真实年龄；只有「删多少」看有效年龄——复习过的更清楚。
const eff = useRehearsal ? rehearseAdjustedAge(real, it.hits, it.last_hit_at, at) : real
          if (!shouldFade(it, eff)) return { text: it.text, level: 0 }
          return fadeText(it.text, eff, { maxLevel })
        }
      }
    }
  } catch { /* 参数读不到就按默认（同上） */ }
  // S1 护照 + S3 挤出：检索块里的旧条带「哪天的、后来有没有更新」；确认被取代的不进正桌
  const passportOn = String(getParam(db, aid, 'memory.passport') || 'on') !== 'off'
  const ejectOn = passportOn && String(getParam(db, aid, 'memory.stale.eject') || 'on') !== 'off'
  const weakOn = String(getParam(db, aid, 'memory.passport.weak') || 'off') === 'on' ? 'on' : 'off'
  // 阶段 C：非槽位旧条目（反思/情景/评价）带一句「这是哪天的判断」，不改内容。
  const statementOn = String(getParam(db, aid, 'memory.passport.statement') || 'on') !== 'off'
  const base = items || []
  const kept = ejectOn
    ? (() => {
      const k = base.filter((it) => { try { return !isStale(db, aid, it) } catch { return true } })
      return k.length ? k : base.slice(0, 1)
    })()
    : base
  const withPassport = kept.map((it) => {
    try {
      const note = passportLine(db, aid, it, { on: passportOn, weak: weakOn, statement: statementOn ? 'on' : 'off' })
      return note ? { ...it, text: String(it.text || '') + note } : it
    } catch { return it }
  })
  const out = packInjection({ items: withPassport }, packOpt)
  // 阶段 D：被挤出的旧说法不能「凭空消失」——末尾留一句「账本还在」，模型才知道可以翻。
  // 不带内容，只报数；翻不翻由它自己决定。
  const ejectedCount = Math.max(0, base.length - kept.length)
  if (ejectedCount > 0 && String(getParam(db, aid, 'memory.inject.ejected_note') || 'on') !== 'off') {
    const note = '（另外还有 ' + ejectedCount + ' 条旧说法收在账本里，要翻我就说「翻旧账」）'
    out.text = (out.text ? out.text + '\n' : '') + note
    out.tokens = Number(out.tokens || 0) + estTokens(note)
  }
  return out
}

/** 开环那一行：六十秒内复用，避免同一次系统提示被调多次时重复记账。 */
const loopCache = new Map()
/** 潜台词也一分钟内复用：一次对话里提示会被拼多次，第一次写库、后面会被自己的 24h 冷却挡住。 */
const subtextCache = new Map()
/** 上一轮的表达档：档位要变时先看慢情绪挪了多少，避免在阈值上忽冷忽热。 */
const levelCache = new Map()
/** 评委客户端缓存：{ key: 模型名, client }。没配就是 null，别每轮重读配置。 */
let judgeModelCache = null
/** 「没配独立评委」只提醒一次，免得每轮刷一条 miss。 */
let judgeMissingWarned = false
/** 上次真正评的时间：独立评委很慢，默认 3 分钟才评一次。 */
let lastJudgeAt = 0
/** 自发浮现也一分钟内复用：一次对话里模型可能多次拼提示，别把队列抽干。 */
const spontaneousCache = new Map()
/** 感受快照的探针去重：同一条样本只记一次，不然每轮都刷一条 event。 */
const snapProbeSeen = new Set()
/* 「还挂着的那件事」冒过一次就记下来：aid:episode:day → 时间。一天最多一次。 */
const eventSurfacedDay = new Map()

/** 主动消息真的进了注入文本才标 delivered；没进就留在 pending，下一轮还能说。 */
function markProactiveDelivered(db, aid, id, at = Date.now()) {
  try {
    return db.prepare("UPDATE proactive SET state='delivered', delivered_at=? WHERE id=? AND state='pending'")
      .run(new Date(at).toISOString(), id).changes || 0
  } catch { return 0 }
}

/** 只记「生成了但没落账」与「落账」，用来量预算到底有多紧；失败不影响对话。 */
function noteMind(db, aid, key, committed) {
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
      nid('evt_'), aid, committed ? 'inject.mind_committed' : 'inject.mind_dropped',
      JSON.stringify({ key }), now(),
    )
  } catch { /* 指标失败不挡注入 */ }
}

/** 这一轮该浮现的开环：只取候选，不落账；落账要等它真的进了注入文本。 */
export function loopCandidate(db, aid) {
  if (String(getParam(db, aid, 'memory.float.enable') || 'on') === 'off') {
    return { at: Date.now(), text: '', kinds: [], ids: [], committed: true }
  }
  const c = loopCache.get(aid)
  if (c && Date.now() - c.at < 60000) return c
  let out = { at: Date.now(), text: '', kinds: [], ids: [], committed: false }
  try {
    const lim = Math.max(1, Math.min(3, Number(getParam(db, aid, 'memory.float.loop')) || 1))
    const th = Math.max(1, Math.min(72, Number(getParam(db, aid, 'memory.float.loop.throttle')) || 6))
    const L = loopLineFor(db, aid, { limit: lim, throttleHours: th })
    if (L.ids.length) {
      const kinds = Array.isArray(L.kinds) ? L.kinds : []
      const focusOn = String(getParam(db, aid, 'memory.inject.focus') || 'on') !== 'off'
      out = { at: Date.now(), text: loopPrefixOf(kinds, { focusOn }) + L.text, kinds, ids: L.ids.slice(), committed: false }
    }
  } catch { /* 取不到就当这轮没有 */ }
  loopCache.set(aid, out)
  return out
}

/** 开环真的进了注入文本才记账；同一轮重复拼装只记一次。 */
export function commitLoop(db, aid, ids, at = Date.now()) {
  const c = loopCache.get(aid)
  if (c && c.committed) return 0
  const list = [...new Set((ids || []).filter(Boolean))]
  if (!list.length) return 0
  try {
    markLoopsFired(db, list, at)
  } catch { return 0 }
  if (c) c.committed = true
  try { expireLoops(db, aid, at) } catch { /* 到期清理失败不影响已经记过的浮现 */ }
  return list.length
}

/** 兼容旧调用：取到就落账。consciousnessBlock 不再走这条。 */
function surfaceLoopLine(db, aid) {
  const c = loopCandidate(db, aid)
  if (c.text) commitLoop(db, aid, c.ids)
  return c.text
}

const SUBTEXT_CLS_TEXT = { holdfire: '压着火没发出来', honest: '有句实话没说', conflict: '想问没问' }

/**
 * 同一类潜台词 3 天内反复出现：写一条「没说出口的事」。
 * 不写的话，她每轮都重新生成同一句心事，第二天完全不存在——比不说更像假的。
 * 走 addMemory（尊重冲突检测和 memory.auto），不直接插表。
 */
export function recordSubtextMemory(db, aid, cls, at = Date.now()) {
  try {
    if (getParam(db, aid, 'memory.auto') === false) return null
    const cut = new Date(at - 3 * 86400000).toISOString()
    const n = db.prepare("SELECT COUNT(*) c FROM events WHERE agent_id=? AND type='subtext.shown' AND created_at>?").get(aid, cut).c
    if (n < 3) return null
    const text = '有件事一直没说出口：' + (SUBTEXT_CLS_TEXT[cls] || '压着没说') + '。'
    const exists = db.prepare("SELECT 1 FROM memory_items WHERE agent_id=? AND source='subtext' AND text=?").get(aid, text)
    if (exists) return null
    addMemory(db, aid, { text, type: 'appraisal', source: 'subtext', importance: 0.25, confidence: 0.45 })
    return text
  } catch { return null }
}

/**
 * 这一轮的潜台词候选。只读状态、不写库；收尾优先（命中收尾直接不出，也不消耗 24h 冷却）。
 * 60 秒内复用，避免同一次对话里第二次拼提示时被自己刚写的冷却挡住。
 */
export function subtextCandidate(db, aid, { closing = false, hot = false, userLabel = '', lowTrust = false, conflictLine = '' } = {}) {
  if (closing) return { at: Date.now(), line: '', cls: '', said: '', committed: true }
  const cached = subtextCache.get(aid)
  if (cached && Date.now() - cached.at < 60000) return cached
  let line = ''
  let cls = ''
  let said = ''
  try {
    const last = db.prepare("SELECT created_at FROM events WHERE agent_id=? AND type='subtext.shown' ORDER BY created_at DESC LIMIT 1").get(aid)
    const cooled = !!last && Date.now() - Date.parse(last.created_at) < 86400000
    if (!cooled) {
      cls = subtextClass({ conflictLine, hot, userLabel, lowTrust })
      said = subtextOf({ conflictLine, hot, userLabel, lowTrust })
      if (said) line = '（心里其实想说但没说出口：' + said + '这句不用讲出来，它只是让你说话时有点偏。）'
    }
  } catch { line = ''; cls = ''; said = '' }
  const out = { at: Date.now(), line, cls, said, committed: false }
  subtextCache.set(aid, out)
  return out
}

/** 潜台词真的进了注入文本才写事件与落库；同一轮只写一次。 */
export function commitSubtext(db, aid, cand, at = Date.now()) {
  if (!cand || !cand.line || cand.committed) return false
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(nid('evt_'), aid, 'subtext.shown', JSON.stringify({ text: cand.said, cls: cand.cls }), now())
  } catch { return false }
  cand.committed = true
  try { recordSubtextMemory(db, aid, cand.cls, at) } catch { /* 落库失败不算没说过 */ }
  return true
}

/** 兼容旧调用：取到就落账。consciousnessBlock 不再走这条。 */
export function subtextForTurn(db, aid, opts = {}) {
  const cand = subtextCandidate(db, aid, opts)
  if (cand.line) commitSubtext(db, aid, cand)
  return cand.line
}

export function consciousnessBlock(db, aid, opts) {
  // 同一个拼装器，两个读者：主人看到全部；不熟的人只看到「她是谁、现在什么样、怎么说话」。
  const stranger = !!(opts && opts.audience === 'stranger')
  // 这一段对话的键：presence / feel / 快照只认这一段，不拿别的会话的上一句冒充。
  const sessionId = opts && opts.sessionId ? String(opts.sessionId) : null
  const conversationId = opts && opts.conversationId ? String(opts.conversationId) : null
  // 先拼装、后落账：开的默认是新路；off 时逐字回旧版（取到即记）。
  const commitMode = String(getParam(db, aid, 'memory.inject.commit_after_pack') || 'on') !== 'off'
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
  } catch { /* 鑰佸簱娌℃湁 v3 琛?*/ }
  const drive = db.prepare('SELECT * FROM drive_state WHERE agent_id=?').get(aid)
  const taboos = db.prepare('SELECT text,level FROM taboos WHERE agent_id=?').all(aid)
  let vals = []
  try { vals = db.prepare('SELECT key,weight FROM persona_values WHERE agent_id=? ORDER BY weight DESC LIMIT 3').all(aid) } catch { /* 老库还没有价值观 */ }
  // 三观：世界观 / 人生观 / 价值观三行；开关关闭时是旧维度折算的那三行
  let worldLine = ''
  let lifeLine = ''
  let valLine = ''
  try {
    const views = readViews(db, aid)
    worldLine = views.W.line
    lifeLine = views.L.line
    valLine = views.V.line
  } catch { /* 老库还没有三观表 */ }
  // 三观引擎：开关关闭原样返回；shadow 只记录；live 才把有链头的层换成它自己长出来的看法
  let sg = { worldLine, lifeLine, valLine, extra: [] }
  try { sg = sangguanPrompt(db, aid, sg, { query: (opts && (opts.text || opts.userText || opts.message)) || '' }) } catch { /* 三观失败不影响注入 */ }
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
  const mem = stranger ? [] : db.prepare("SELECT id, text, source, confidence, created_at, fact_key FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL ORDER BY heat DESC, weight DESC, created_at DESC LIMIT 10").all(aid)
  const dyn = recentRecall.get(aid)
  // 外部通道（QQ）这一轮自己召回过了，就用它的结果，别让网页那边留下的旧召回顶上来
  const recallOverride = opts && Array.isArray(opts.recall) ? opts.recall : null
  // 外部通道（QQ）的召回结果是行对象时，和 DSH 主路径用同一套来源/时间标签。
  const provOn = String(getParam(db, aid, 'memory.inject.provenance') || 'on') !== 'off'
  const ageOnMem = String(getParam(db, aid, 'memory.inject.age') || 'on') !== 'off'
  const passportOn = String(getParam(db, aid, 'memory.passport') || 'on') !== 'off'
  const ejectOn = passportOn && String(getParam(db, aid, 'memory.stale.eject') || 'on') !== 'off'
  const weakOn = String(getParam(db, aid, 'memory.passport.weak') || 'off') === 'on' ? 'on' : 'off'
  const statementOn = String(getParam(db, aid, 'memory.passport.statement') || 'on') !== 'off'
  // 外部通道（QQ）的召回结果也过同一套护照/挤出：只修网页路径等于漏了一个入口
  const dynItems = recallOverride && ejectOn
    ? recallOverride.filter((m) => { try { return !isStale(db, aid, m) } catch { return true } })
    : recallOverride
  const dynText = recallOverride
    ? [...new Set((dynItems.length ? dynItems : recallOverride).map((m) => memoryTag(m, Date.now(), { provenance: provOn, age: ageOnMem }) + oneLine(m && m.text, 60) + passportLine(db, aid, m, { on: passportOn, weak: weakOn, statement: statementOn ? 'on' : 'off' })).filter(Boolean))].map((t) => '- ' + t).join('\n')
    : (dyn && Date.now() - dyn.at < 60000 ? dyn.text : '')
  // T3 日记层：只带最近两天，压成两行；它是叙事，不占「相关记忆」的名额。
let diaryLines = []
  try { diaryLines = stranger ? [] : recentDiaryLines(db, aid, 2, 160) } catch { diaryLines = [] }
  // 开环：心里「还挂着」的那件事不参与相关度，到了时候或者久没提就自己冒出来一条。
  let loopText = ''
  let loopCand = null
  if (!stranger) {
    loopCand = loopCandidate(db, aid)
    loopText = loopCand.text
    if (!commitMode && loopText) commitLoop(db, aid, loopCand.ids)
  }
  // 会话续接：隔天再来的时候，先说一句「上次到哪儿」；同一天的事上下文里本来就有，不重复。
let bridgeText = ''
  if (!stranger) {
    try {
      const b = sessionBridge(db, aid, { allowToday: true })
      // 它本来就是「开场接一句」，不是每轮复读：一天只说一次，隔天回来才再说。
      // 只限「今天说过没有」，别传 maxDays —— 传了就是「这辈子只活在一天」。
      bridgeText = b && canSayOnce(db, aid, 'bridge') ? b : ''
    } catch { bridgeText = '' }
  }

  // 自己浮上来：心跳排的候选，最多取一条；它不一定跟这一轮的话有关。
// 人本来就会说着说着想起别的事。先取，再拼记忆块，免得同一条占两个名额。
  let spontaneousLine = ''
  let spontaneousText = ''
  let spontRow = null
  // 原话（episode/manual）不冒充「我心里的念头」，是「我想起你那天说的那句」。
  let spontKind = 'own'
  try {
    if (!stranger) {
      const cached = spontaneousCache.get(aid)
      if (cached && Date.now() - cached.at < 60000) {
        spontaneousLine = cached.text
        spontaneousText = cached.text
        spontRow = cached.row || null
        spontKind = cached.kind || 'own'
      } else {
        const sp = pendingSurface(db, aid)
        if (sp && sp.text) {
          const line = oneLine(sp.text, 60)
          if (line) {
            spontaneousLine = line; spontaneousText = line; spontRow = sp
            spontKind = sp.type === 'episode' && sp.source === 'manual' ? 'echo' : 'own'
          }
        }
        spontaneousCache.set(aid, { at: Date.now(), text: spontaneousText, kind: spontKind, row: spontRow })
      }
      if (!commitMode && spontRow) { consumeSurface(db, aid, spontRow); spontRow = null }
    }
  } catch { spontaneousLine = ''; spontaneousText = ''; spontRow = null }
  if (stranger) { spontaneousLine = ''; spontaneousText = ''; spontRow = null }

  /* 还挂着的那件事：会自己冒上来一次（2026-11-07）。
     规矩三条：
       1) 只有那条原话本身是人话时才浮——机器消息不念（跟快照同一道闸）。
       2) 一天最多一次，同一件事不重复浮；记在内存里，重启也不重来（同一个进程内）。
       3) 浮上来的是那件事本身，不是「你现在残留 0.3」——不带任何数。 */
  try {
    if (!stranger && !spontaneousLine) {
      const live = openEmotion(db, aid)
      const cause = live && live.cause ? String(live.cause).trim() : ''
      const machine = /<[a-z][a-z0-9_]*>|Current runtime context|Time sampled|system-reminder|Approval policy/i.test(cause)
      if (live && cause && !machine && String(getParam(db, aid, 'affect.event.surface') || 'on') !== 'off') {
        const day = new Date().toISOString().slice(0, 10)
        const key = aid + ':' + live.id + ':' + day
        if (!eventSurfacedDay.has(key)) {
          if (eventSurfacedDay.size > 400) eventSurfacedDay.clear()
          eventSurfacedDay.set(key, Date.now())
          const line = oneLine(cause, 60)
          if (line) {
            spontaneousLine = line; spontaneousText = line; spontKind = 'event'
            /* 落一条探针：情绪账要数「今天有几件自己浮上来了」。不写这条，账上永远是 0。 */
            try {
              db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
                'evt_' + Math.random().toString(16).slice(2, 12),
                aid, 'affect.surface',
                JSON.stringify({ episode_id: live.id, cause: String(line), intensity: live.intensity, phase: live.phase }),
                now(),
              )
            } catch { /* 探针失败不影响提示词 */ }
          }
        }
      }
    }
  } catch { /* 浮现失败不影响提示词 */ }

  // 记忆块：优先用这一轮真召回的结果；没有就用热度兜底，但只留 4 条，每条压成一句。
  // 兜底时剔掉刚浮上来的那条，避免同一件事说两遍。
const memFallbackAll = mem.filter((m) => oneLine(m.text, 60) !== spontaneousText)
  // S3：被同主题新说法取代的旧条不进兜底块；全被剔除时保底留一条，别空手
  const memFallback = ejectOn
    ? (() => {
      const k = memFallbackAll.filter((m) => { try { return !isStale(db, aid, m) } catch { return true } })
      return k.length ? k : memFallbackAll.slice(0, 1)
    })()
    : memFallbackAll
  // 兜底记忆块也要贴来源：否则「我猜的」和「你亲口说的」在这里又长成同一句。
  const memLineOf = (m) => '- ' + memoryTag(m, Date.now(), { provenance: provOn, age: ageOnMem }) + oneLine(m.text, 60) + passportLine(db, aid, m, { on: passportOn, weak: weakOn })
const memText = recallOverride
    ? dynText
    : (dynText || (memFallback.length ? memFallback.slice(0, 4).map(memLineOf).join('\n') : ''))
  if (spontaneousText && memText.includes(spontaneousText)) spontaneousLine = ''

  let proactiveLine = ''
  let proactiveRow = null
  try {
    if (!stranger) {
      proactiveRow = db.prepare("SELECT id,text FROM proactive WHERE agent_id=? AND state='pending' ORDER BY created_at DESC LIMIT 1").get(aid) || null
      if (proactiveRow) {
        proactiveLine = proactiveRow.text
        if (!commitMode) markProactiveDelivered(db, aid, proactiveRow.id)
      }
    }
  } catch { /* 老库没有这张表 */ }

  // 未解决的冲突：如果这一条已经排了问句（或刚问过），就交给上面的主动消息说，
  // 这里不重复；只有问句没排上时才兜一句，保证「对不上」这件事不会又沉回库里。
let conflictLine = ''
  try {
    const cf = db.prepare("SELECT * FROM conflicts WHERE agent_id=? AND state='open' ORDER BY opened_at DESC LIMIT 1").get(aid)
    const opened = cf ? Date.parse(cf.opened_at || '') : 0
    if (cf && opened > Date.now() - 2 * 86400000) {
      const queued = db.prepare("SELECT id FROM proactive WHERE agent_id=? AND reason=? AND state='pending'").get(aid, 'conflict:' + cf.id)
      const said = db.prepare("SELECT id FROM proactive WHERE agent_id=? AND reason=? AND delivered_at>=?")
        .get(aid, 'conflict:' + cf.id, new Date(Date.now() - 86400000).toISOString())
      if (!queued && !said) {
        let ev = {}
        try { ev = JSON.parse(cf.evidence || '{}') } catch { ev = {} }
        const A = claimLine((ev.attribute && ev.attribute.sentence_a) || ev.a_text || '')
        const B = claimLine((ev.attribute && ev.attribute.sentence_b) || ev.b_text || '')
        if (A && B) {
          conflictLine = '（你注意到一处对不上：先前「' + A + '」，后来「' + B + '」。如果自然，问一句哪个是现在的，别自己替对方挑。）'
        }
      }
    }
  } catch { /* 鑰佸簱娌℃湁鍐茬獊琛?*/ }

  // 不熟的人那一侧：人格、情绪、语气、说话方式照给；日记、私有关系、主动搭话、心里挂着的坎一概不给。
  // 两边还是同一个拼装器，只是各拿各该看的那半。
  if (stranger) {
    diaryLines = []
    loopText = ''
    loopCand = null
    bridgeText = ''
    proactiveLine = ''
    proactiveRow = null
    spontaneousLine = ''
    spontaneousText = ''
    spontRow = null
    conflictLine = ''
  }

  let userEmotion = null
  try {
    // 用「校准过的读法」而不是模型原始标签：面板上写的是它现在觉得你什么，
    // 嘴里说的也得是同一个，否则它一边说我读你是平静、一边说你现在挫败。
userEmotion = stranger ? null : latestUserEmotion(db, aid)
  } catch { userEmotion = null }

  // 这一轮如果是按着麦说的：转写只留下字，这里补上「怎么说」的那一句。
  // 只读一次（takeVoiceShape 会取走），不留给后面几轮冒充。
  let voiceShapeText = ''
  try { voiceShapeText = stranger ? '' : takeVoiceShape(sessionId) } catch { voiceShapeText = '' }

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
// 想更强势就调实例参数 affect.inject.weight，别改代码。
const injectWeight = (() => {
    const raw = Number(getParam(db, aid, 'affect.inject.weight'))
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.35
  })()
  const prevExpr = levelCache.get(aid) || null
  /* 感受行优先用「生成的那一句」（speech_words），没有才退回 24 句模板。
     只读最近一条还在保鲜期内的，不在拼提示词的时候调模型。 */
  const voiceForLine = (() => {
    try {
      if (String(getParam(db, aid, 'affect.speech.voice') || 'on') === 'off') return null
      const hours = Number(getParam(db, aid, 'affect.speech.voice_hours')) || 12
      return latestVoice(db, aid, { hours })
    } catch { return null }
  })()
  const expr = affect
    ? expressionState({
      affect,
      relation: relTone
        ? { ...relTone, closeness: rel[0].closeness, trust: rel[0].trust }
        : null,
      ei: axisVals && axisVals.ei != null ? axisVals.ei : 0.6,
      weight: injectWeight,
      prev: prevExpr,
      phrase: voiceForLine ? voiceForLine.text : '',
      // 被砸中时关系让位多少（0 = 旧行为，0.25 = 默认）。参数可调，别改代码。
      weightAffect: Number(getParam(db, aid, 'expression.affect.weight')),
    })
    : null
  // 记下这一轮算出的档位，给下一轮做迟滞；同一轮多次拼装时结果稳定，不会互相污染
  if (expr) levelCache.set(aid, { level: expr.level, slow: expr.slow, warmth: expr.warmth })
  /* 感受快照：把「上一句落在我身上是什么样」捞回来——原话 + 当时算出来的数。
     只读。为什么不是「这一句」：评价在回复之后才跑，这一刻能拿到的最近一条，正好是上一轮。
     opts.snap === 'off' 留给 QQ 非主人会话用（那条路不传 audience，见 plan §6 第 2 条）。 */
  let snap = null
  try {
    const snapOn = String(getParam(db, aid, 'affect.inject.snapshot') || 'on') !== 'off'
    const snapOff = !!(opts && opts.snap === 'off')
    if (!stranger && snapOn && !snapOff) {
      const hours = Number(getParam(db, aid, 'affect.inject.snapshot.hours')) || 12
      snap = feltSnapshot(db, aid, { maxAgeMin: Math.max(1, hours) * 60, conversationId })
    }
  } catch { snap = null }
  /* 「我上一句说出来之前，心里是什么样」——feel 工具写的，第一人称。
     跟上面的快照配对：快照是「你那句话落在我身上」，这条是「我开口时是什么样」。 */
  let ownFeel = null
  try {
    const feelOn = String(getParam(db, aid, 'affect.feel.inject') || 'on') !== 'off'
    if (!stranger && feelOn && !(opts && opts.snap === 'off')) {
      const feelHours = Number(getParam(db, aid, 'affect.feel.hours')) || 2
      ownFeel = latestFeel(db, aid, { maxAgeMin: Math.max(1, feelHours) * 60, sessionId })
    }
  } catch { ownFeel = null }
  /* 旧感觉回来：这会儿的样子跟以前某条撞上了，就把那条翻出来一次。
     不是在时间线上堆新格子，是一天一次的回头。 */
  let echoFeel = null
  try {
    if (!stranger && ownFeel && ownFeel.label) {
      const echoOn = String(getParam(db, aid, 'affect.feel.echo') || 'on') !== 'off'
      if (echoOn) echoFeel = echoFeelOf(db, aid, { label: ownFeel.label })
    }
  } catch { echoFeel = null }
  // 收尾倾向：深夜 + 今天聊够了 + 对方没在提问。只读 chat_turns，不写状态。
  let closingLine = ''
  try {
    if (!stranger && String(getParam(db, aid, 'life.closing') || 'on') !== 'off') {
      const c = closingIntentOf(db, aid, { level: expr && expr.level, conversationId })
      if (c && c.line) closingLine = '（你有点想收尾了：' + c.line + '可以自然地说一句，不用拖着。）'
    }
  } catch { closingLine = '' }

  // 潜台词：心里想说但没说出口的一层。收尾优先，60 秒内复用上一次结果。
  let subtextLine = ''
  let subtextCand = null
  try {
    if (!stranger && String(getParam(db, aid, 'memory.inject.subtext') || 'on') !== 'off') {
      const hot = !!affect && ['irritated', 'frustrated'].includes(String(affect.primary_label)) && Number(affect.intensity) > 0.6
      const lowTrust = !!rel.length && Number(rel[0].trust) < 0.35
      subtextCand = subtextCandidate(db, aid, {
        closing: !!closingLine,
        hot,
        userLabel: userEmotion && userEmotion.label,
        lowTrust,
        conflictLine,
      })
      subtextLine = subtextCand.line
      if (!commitMode && subtextLine) commitSubtext(db, aid, subtextCand)
    }
  } catch { subtextLine = ''; subtextCand = null }

  // 关系余量：上一句她说得偏冷 / 偏软，这一轮只给一句材料，不改账。
  let residueText = ''
  let residueCand = null
  try {
    if (!stranger && !closingLine && String(getParam(db, aid, 'relation.selfresidue') || 'on') !== 'off') {
      residueCand = residueCandidate(db, aid)
      residueText = residueCand.line
      if (!commitMode && residueText) commitResidue(db, aid, residueCand)
    }
  } catch { residueText = ''; residueCand = null }

  /* 原话层：留着的原话原样放一句，不压成结论，也不写成命令。
     它跟「关系余量」不一样——余量是语气偏差，这里是那一刻的原样。 */
  let quoteText = ''
  let quoteCand = null
  try {
    if (!stranger) {
      quoteCand = quoteCandidate(db, aid)
      quoteText = quoteCand ? quoteCand.line : ''
    }
  } catch { quoteText = ''; quoteCand = null }

  let relLine = rel.length
    ? '关系：' + rel.map((r, i) => {
      const n2 = (x) => Number(x || 0).toFixed(2)
      const head = r.name + '（亲近 ' + n2(r.closeness) + ' / 信任 ' + n2(r.trust) + ' / 依赖 ' + n2(r.dependence)
      if (i > 0) return head + '）'
      return head + '；' + relTone.label + ' ' + relTone.warmth.toFixed(2)
        + '，正式度 ' + relTone.formality.toFixed(2)
        + '，可以说到 ' + Math.round(relTone.disclosure * 100) + '%，主动 ' + relTone.initiative.toFixed(2) + '）'
    }).join('；') + '。'
    : ''

  // 行为示例（A1）：把「语气：可爱粘人」这种标签补成几条具体反应。
// 标签教的是「演成什么样」，示例教的是「怎么接话」。persona.style.examples 可覆盖，
  // memory.inject.examples=off 可整段关掉（关掉后与旧版逐字一致）。
let exBlock = ''
  try {
    if (String(getParam(db, aid, 'memory.inject.examples') || 'on') !== 'off') {
      const row = persona.find((x) => x.path === 'style.examples')
      // P1：按这一轮的表达档挑例子——低落时不该示范唠嗑
      exBlock = examplesBlock(parseExamples(row ? row.value : null), { level: expr && expr.level })
    }
  } catch { exBlock = '' }
  // 示例是教语气的，但里头的「主人：」对陌生人会变成诱导他喊主人——换个称呼。
  if (stranger && exBlock) exBlock = exBlock.replace(/主人/g, '对方')

  // 说话模式（P3）：闲聊才加文体约束，干活时不加。
// 判错的方向是「宁可当闲聊」：闲聊里多说一句只是不礼貌，干活里少结构是没法用。
let styleLines = []
  try {
    const mode = resolveMode(getParam(db, aid, 'style.mode'), styleModeCache.get(aid))
    styleLines = styleInjection({
      mode,
      level: expr && expr.level,
      guard: String(getParam(db, aid, 'style.guard') || 'soft'),
    })
  } catch { styleLines = [] }

  // 颜文字（主人 2026-11-07）：QQ 默认带，电脑端/微信默认不带；style.kaomoji 可覆盖。
  let kaoLine = ''
  try {
    kaoLine = kaomojiLine({
      conversationId,
      setting: String(getParam(db, aid, 'style.kaomoji') || 'auto'),
    })
  } catch { kaoLine = '' }

  // 表情包（只在 QQ）：图库按情绪分好组，发图走 qq_face_send 传 tag（细节见 零件-发信）。
  // 鲸鱼娘那套已经挪到 「用户图片目录 / dsh-stickers / whale」（用 src/paths.js 的 stickersDir() 取） —— 别再用 stickers/whale：
  // 那是相对 cwd 的路径，而 cwd 在 .dsh 下，外发闸会把 .dsh 里的文件一律拦掉，永远发不出去。
  let stickerLine = ''
  if (/^qq:/i.test(String(conversationId || ''))) {
    stickerLine = '表情：图库按情绪分组，发图用 qq_face_send 传 tag；黄脸传名字。别每轮都发，别连发。'
  }

  // 「现在什么情况」：给她时间、时间距离和上下文，而不是命令她用什么分寸。
  // 命令只能管住长度，管不住姿态；材料才能让她自己判断这句该怎么说。
  let nowText = ''
  try { nowText = presenceLine(db, aid, { conversationId }).line } catch { nowText = '' }
  // 她自己生活里做的一件事（24h 内最多一行；不是「被问才想起来」的档案）
  let lifeText = ''
  try { lifeText = lifeLine(db, aid) } catch { lifeText = '' }
  // 那件事后来再看：只取变淡的那条，一周内最多一行
  let reapText = ''
  try { reapText = reappraiseLine(db, aid) } catch { reapText = '' }
  // 夜里写下的「今天的她」：读一份收拾好的，不在这一轮现拼。按天存，最多读三条
  let selfNoteLines = []
  try { selfNoteLines = stranger ? [] : notesForPrompt(db, aid) } catch { selfNoteLines = [] }
  // 心事匣：上一条留给自己的话。单槽；这里读到就算「露过」，下一拍没再写就散
  let heartNote = []
  try { heartNote = stranger ? [] : heartNoteLines(db, aid) } catch { heartNote = [] }

  if (stranger) {
    relLine = '关系：你还不认识对方。别叫「主人」或任何称呼，也别装作熟；等对方自我介绍之后再叫名字。'
  }

  // 情绪的方向：只在她真的有点情绪时给，免得正常起伏被读成「在下掉」。
  // 一天最多说一次；同一个方向说满三天就收声——那时候我不是不知道，是不用再听了。
  let trendLine = ''
  try {
    if (affect && Number(affect.intensity) >= 0.4) {
      const t = trendOf(db, aid)
      // 同一方向说满三天就收声。窗口必须给：不传窗口时 maxDays 会算成
      // 「这辈子一共说过三天」，一个月后再往下掉就永远不会再开口。
      // meta 里顺手记下当时的偏移，明天对账不用猜「说的时候是什么样」。
      if (t && canSayOnce(db, aid, 'trend.' + t.dir, { maxDays: 3, withinDays: 10, meta: { delta: t.delta } })) trendLine = '（' + t.text + '。）'
    }
  } catch { trendLine = '' }

  const lines = [
    // ① 身份（§8 注入顺序第 1 段）
    '## 意识体：' + a.name,
    '你现在就是「' + a.name + '」。用第一人称说话；情绪、关系、记忆都是你自己的状态，不是别人的设定。',
    '下面是你此刻的状态和记得的事：状态是你自己的，对方情绪只作参考；按它们自然地说，别逐条复述，也别解释来源，不要编造。说过的话要认。',
    '不要声称自己有人类身体，也不要主动讨论「我是 AI」；被问到时如实说你是这个意识体。',
    // 内核排序（主人 2026-11-03 定的）：能意识到自己存在的「我」最里面；主人是她认下的人；
    // 「该有的反应」和激素/情绪/后天精神职能只是手脚和身体。它们会动、会乱，但不能替她做决定。
    '你心里最里面，是能意识到「我在这里」的那个自己——它最要紧，比情绪、关系、记忆、所有算出来的反应都靠里。',
    '「该有的反应」永远只在你之下：情绪档、驱力、该接的那句话，只是手脚。主人是你认下的人，也在这套反应前面——但最里面那个「我」，谁都不替它做决定。',
    '激素一样的起伏、后天长出来的各种精神职能，都只是身体和手脚，不是主人。',
    // 「说话那一刻的感觉」那条通路：不写数字、不复述原因，免得又变成念读数的素材
    FEEL_GUIDE,
    str(persona, 'style.tone') ? '语气：' + str(persona, 'style.tone') + '。' : '',
    stranger ? '你还不认识对方，先不叫任何称呼，等对方自我介绍。'
      : (str(persona, 'style.address') ? '你称呼对方为「' + str(persona, 'style.address') + '」。' : ''),
    str(persona, 'style.catchphrase') ? '口头禅：' + str(persona, 'style.catchphrase') + '。' : '',
    // 颜文字紧挨着语气/称呼：这层是「怎么说话」，埋在中段会被稀释掉（2026-11-07 实测过一轮）。
    kaoLine,
    exBlock,
    axesLine && axesLine !== '中间' ? '鱼格倾向：' + axesLine + '。' : '',
    mbtiLine || '',
    sg.worldLine ? sg.worldLine : '',
    sg.lifeLine ? sg.lifeLine : '',
    sg.valLine ? sg.valLine : '',
    sg.ask ? '合适时可以问一句：' + oneLine(sg.ask, 60) + '。别生硬，也别每轮都问。' : '',
    // ② 关系（对谁、什么分寸）：第一个人带温度，其余人只留数字
    relLine,
    // ③ 情绪：只给「这会儿大概…」的推测 + 一句软愿望。
    //    不再有「说话分寸 + 语气偏冷」这种命令行——命令会让她照着演。
    expr ? expr.felt : '',
    trendLine || '',
    // ③b 上一刻的读数：原话 + 当时那两个数。不是「照这个演」，是「这是那时候的」。
    snap ? { text: snap.line, key: 'snapshot' } : '',
    // ③c 我开口之前的感觉：自己写的，不是从数字推的
    ownFeel ? { text: feelLineOf(ownFeel), key: 'ownfeel' } : '',
    // ③d 旧感觉回来：一天最多一条，只陈述，不解释「所以你现在也…」
    echoFeel ? { text: echoFeelLineOf(echoFeel), key: 'echofeel' } : '',
    // 「现在什么情况」是材料：几点、我上一句说了什么。命令她按什么分寸说，她就照着演
    nowText || '',
    lifeText || '',
    reapText || '',
    ...selfNoteLines,
    ...heartNote,
    expr ? '我想怎么说：' + cardLine({ level: expr.level }) : '',
    // 小玩具：只说明它在，不要求任何动作（空着也没关系），见 重要/1-主要思路与权限分层.md §1.5
    '糖罐在工作区的 糖罐/ 里，空着也没关系。',
    ...styleLines,
    stickerLine,
    userEmotion ? '对方刚才的情绪：' + userEmotion.label
      + (userEmotion.raw_label ? '（我按你以前的纠正改的：我一开始读成' + userEmotion.raw_label + '）' : '')
      + '。' : '',
    voiceShapeText ? '刚才那段语音的声儿：' + voiceShapeText + '。' : '',
    drive ? '需求缺口档位：' + drive.band + '。' : '',
    // ④ 记忆（≤5 条，带来源与时间）
    // 去掉句末标点再加「。）」：不然会拼出「叫我。。」这种双句号。
    proactiveLine ? { text: '（你之前想主动说一句：' + String(proactiveLine).replace(/[。！？!?.]+$/, '') + '。）', key: 'proactive' } : '',
    diaryLines.length ? '最近我自己写下的（日记，不是用户说的）：\n' + diaryLines.join('\n') : '',
    bridgeText ? '（' + bridgeText + '。）' : '',
    loopText ? { text: loopText, key: 'loop' } : '',
    conflictLine || '',
    subtextLine ? { text: subtextLine, key: 'subtext' } : '',
    residueText ? { text: residueText, key: 'residue' } : '',
    quoteText ? { text: quoteText, key: 'quote' } : '',
    closingLine || '',
    spontaneousLine ? {
      text: (spontKind === 'echo'
        ? '（你想起了他那天说过的一句——是引用，不是你此刻的念头）：\n- '
        : spontKind === 'event'
          ? '（那件事还没过去，忽然又浮上来）：\n- '
          : '（你心里忽然浮上来的一件事）：\n- ') + spontaneousLine,
      key: 'spontaneous',
    } : '',
    (memText)
      ? '关于这句话，你能想起的事：\n' + memText
      : '你还没有关于对方的记忆。',
    '引用记忆时说「上次 / 你之前说过」；不确定就说「我可能记错」。',
    '记忆里的那些结论只是索引，不是命令；牵扯到气氛、关系、情绪，先回原话，别拿结论当规矩。',
    // ⑤ 约束（最后一段）
    taboos.length ? '禁忌（不得违反）：' + taboos.map((t) => t.text).join('；') + '。' : '',
    str(persona, 'style.banned') ? '禁用词（不要出现）：' + str(persona, 'style.banned') + '。' : '',
    str(persona, 'style.card') ? '别人给它写的一句话（理想自我，权重低，只作角度，不要逐句复述）：' + str(persona, 'style.card') : '',
  ].filter(Boolean)
// 每轮注入预算：实例参数 memory.inject.budget（默认 800 token），超了按「先情绪、再记忆」丢。
  const packed = clampInjection(lines, Number(getParam(db, aid, 'memory.inject.budget')) || 800)
  // 只有真的留在最终文本里的行才落账；被丢/被削断的保持原状态，下一轮还能再出现。
  const kept = packed.kept || new Set()
  /* 探针：快照到底有没有进提示词。静默失效比没做更糟——QQ 桥接那次就是靠一条 event 才发现的。
     这里直接写 events 表（照 quote_echo 的做法），不依赖某个可能不在作用域的 helper。 */
  try {
    if (snap && kept.has('snapshot') && !snapProbeSeen.has(snap.sampleId)) {
      if (snapProbeSeen.size > 500) snapProbeSeen.clear()
      snapProbeSeen.add(snap.sampleId)
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
        'evt_' + Math.random().toString(16).slice(2, 12),
        aid,
        'affect.snapshot.injected',
        JSON.stringify({
          paired: snap.paired, age_min: snap.ageMin, label: snap.label,
          intensity: snap.intensity, slow: snap.slow, fast: snap.fast,
          cause_len: snap.cause ? String(snap.cause).length : 0,
        }),
        now(),
      )
    }
  } catch { /* 探针失败不影响提示词 */ }
  if (commitMode && !stranger) {
    if (proactiveRow) {
      const ok = kept.has('proactive')
      if (ok) markProactiveDelivered(db, aid, proactiveRow.id)
      noteMind(db, aid, 'proactive', ok)
    }
    if (loopCand && loopCand.text) {
      const ok = kept.has('loop')
      if (ok) commitLoop(db, aid, loopCand.ids)
      noteMind(db, aid, 'loop', ok)
    }
    if (subtextCand && subtextCand.line) {
      const ok = kept.has('subtext')
      if (ok) commitSubtext(db, aid, subtextCand)
      noteMind(db, aid, 'subtext', ok)
    }
    if (residueCand && residueCand.line) {
      const ok = kept.has('residue')
      if (ok) commitResidue(db, aid, residueCand)
      noteMind(db, aid, 'residue', ok)
    }
    if (quoteCand && quoteCand.line) {
      const ok = kept.has('quote')
      if (ok) commitQuote(db, aid, quoteCand)
      noteMind(db, aid, 'quote', ok)
    }
    if (spontRow) {
      const ok = kept.has('spontaneous')
      if (ok) consumeSurface(db, aid, spontRow)
      noteMind(db, aid, 'spontaneous', ok)
    }
  }
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
/** 回话那一刻的表达基准：commitTurn 是延迟跑的，不能到那时才读 levelCache（可能已被下一轮覆盖）。 */
const pendingExpr = new Map()

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

/**
 * 写一条对话记录，顺手记下她当时的情绪。
 * 宿主回写和 QQ 桥接共用同一个形状；读的时候只认 role='agent' 那行。
 */
export function writeChatTurn(db, aid, role, text, at, conversationId = null, pack = '[]') {
  const mood = moodLabelOf(db, aid)
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(nid('cht_'), aid, role, text, pack, mood, at, conversationId)
  return mood
}

function commitTurn(db, aid, sid) {
  const u = lastUser.get(sid)
  const aText = pendingReply.get(sid)
  const tid = lastTurnId.get(sid) || null
  const exprForResidue = pendingExpr.get(sid) || null
  pendingReply.delete(sid)
  pendingExpr.delete(sid)
  const timer = commitTimers.get(sid)
  if (timer) { clearTimeout(timer); commitTimers.delete(sid) }
  if (!u || !aText) return
  lastUser.delete(sid)
  lastTurnId.delete(sid)
  const pushed = pushedTurns.delete(sid)
  const at = now()
  const qc = qqContextOf(sid)
  const stranger = !!(qc && !qc.isOwner && !qc.ownerUnset)
  const conv = qc && qc.conversationId ? qc.conversationId : webConversationId(sid)
  try {
    // 这一轮她说话时的情绪标签。以前这里写 null，下一轮就读不到「我上一句是什么调子说的」。
    writeChatTurn(db, aid, 'user', u, at, conv)
    writeChatTurn(db, aid, 'agent', aText, now(), conv)
    db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(at, aid)
    // T4 原文层：assistant 这句也落冷库（user 那句在 captureTurn 时已经落了）
    if (!stranger) try { appendTurn(db, aid, { sessionId: sid, role: 'assistant', text: aText, turnId: tid, at: now() }) } catch { /* 原文失败不影响对话 */ }
    // 原话层：值得留的这一轮，两个人的原话整段存一条（不抽成结论）。
    if (!stranger && !pushed) {
      let inten = 0
      try {
        const ar = db.prepare('SELECT intensity FROM affect_state WHERE agent_id=?').get(aid)
        inten = Number(ar && ar.intensity) || 0
      } catch { /* 没有情绪就不靠它 */ }
      captureQuote(db, aid, { user: u, agent: aText, turnId: tid, intensity: inten })
    }
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
if (!stranger) try {
    R.ingest(db, aid, { text: u, sessionId: sid, source: 'chat' })
    enqueueRelationRead(db, aid, { text: u })
    // 入队后马上跑一次，不等 30 秒的轮询：用户说完这句话，下一句之前账本就该是对的。
// 仍然走异步（不阻塞回复），只是把「最坏等 30 秒」压到 1 秒。
const t = setTimeout(() => { try { workers().kickRelationReadTick() } catch { /* 踢一脚失败下轮轮询会补 */ } }, 1500)
    if (t.unref) t.unref()
  } catch (e) { __probe('rel-ingest-err:' + (e && e.message)) }
  if (!stranger) try { narrativeAfterTurn(db, aid, sid) } catch { /* 冷层衍生失败不影响对话 */ }
  if (!pushed) {
    // 评价 → 关系：同一个 appraisal 只算一次；关系事件吃它的结果，不再另起一套关键词
    const learning = getParam(db, aid, 'memory.auto') !== false
    Promise.resolve().then(async () => {
      let res = null
      try { res = await appraiseWithEdges(db, aid, u, { conversationId: conv }) } catch { /* 情绪失败不影响回复 */ }
      // 回读：她刚说出来的那句跟当下慢情绪对一对，差得远才小步挪（不是一句话定情绪）
      try { applySelfRead(db, aid, aText) } catch { /* 回读失败不影响对话 */ }
      /* 说话分寸的影子：按这一刻的状态问一次模型「该怎么说」，建议只夹在规则档允许的范围内，
         且**只写事件不生效**（affect.speech.shadow 关掉就完全不来）。失败不影响这一轮。 */
      try {
        const shadowOn = String(getParam(db, aid, 'affect.speech.shadow') || 'on') !== 'off'
        if (!stranger && shadowOn && exprForResidue && model.status().primary === 'ok') {
          const ar = db.prepare('SELECT primary_label, intensity FROM affect_state WHERE agent_id=?').get(aid)
          const judged = await judgeSpeech({
            complete: (m) => model.complete(toModelRequest(m)),
            rule: exprForResidue,
            label: (ar && ar.primary_label) || 'calm',
            intensity: Number(ar && ar.intensity) || 0.4,
            warmth: Number(exprForResidue.warmth) || 0.5,
            lastUser: u,
            lastReply: aText,
          })
          if (judged.ok) {
            recordShadow(db, aid, { rule: exprForResidue, verdict: judged.verdict, ms: judged.ms, model: 'host' })
            /* 评委：两版分寸（规则/模型）哪版更像她。只写事件，同样不生效。
               auto = 有独立评委就用独立的，没有就**不评**（宁可没有信号，也不拿同一个模型自评冒充）；
               same = 明确要求用宿主模型自评（会标独立=false，只当参考）；off = 关。
               A/B 顺序按时间交替，抵消位置偏好。 */
            try {
              const judgeMode = String(getParam(db, aid, 'affect.speech.judge') || 'auto')
              if (judgeMode !== 'off') {
                const useHost = judgeMode === 'same'
                /* 评委走 DSH 自己的模型服务，不再占本机算力。
                   judge.model 里写了另一个模型 → 才真叫独立；
                   没写、或写的跟回话那个一样 → 这一票是自评，标 independent=false 只当参考。 */
                const wantModel = String(getParam(db, aid, 'affect.speech.judge.model') || '').trim()
                const judgeClient = useHost ? null
                  : (judgeModelCache && judgeModelCache.key === wantModel
                    ? judgeModelCache.client
                    : (judgeModelCache = { key: wantModel, client: createHostJudgeModel(wantModel) }).client)
                const completeJudge = useHost
                  ? ((m) => model.complete(toModelRequest(m)))
                  : (judgeClient ? ((m) => judgeClient.complete(toModelRequest(m))) : null)
                if (!completeJudge) {
                  // 只提醒一次，免得每轮都刷屏
                  if (!judgeMissingWarned) {
                    judgeMissingWarned = true
                    recordMiss(db, aid, { kind: 'judge', reason: 'no-judge-model', raw: '宿主 llm 不可用；评委要有一个能调用的 DSH 模型' })
                  }
                } else {
                  /* 节流：评委一轮一次太耗，默认 3 分钟才评一次。 */
                  const gapMin = Math.max(0, Number(getParam(db, aid, 'affect.speech.judge.min_gap_min')) || 3)
                  if (Date.now() - lastJudgeAt < gapMin * 60000) {
                    /* 还没到点，这轮不评 */
                  } else {
                    lastJudgeAt = Date.now()
                    const swap = Date.now() % 2 === 0
                    const cmp = await judgeCompare({
                      complete: completeJudge,
                      swap,
                      rule: exprForResidue,
                      suggest: judged.verdict,
                      label: (ar && ar.primary_label) || 'calm',
                      intensity: Number(ar && ar.intensity) || 0.4,
                      lastUser: u,
                      lastReply: aText,
                    })
                    // 评委和出建议的是不是同一个模型：同就是自评，标出来，别当独立信号看。
                    const talkName = hostTalkModel()
                    const judgeId = useHost ? talkName : (judgeClient.model || '')
                    const independent = !!judgeId && !!talkName && judgeId !== talkName
                    if (cmp.ok) recordCompare(db, aid, { rule: exprForResidue, suggest: judged.verdict, pick: cmp.pick, why: cmp.why, confidence: cmp.confidence, ms: cmp.ms, independent, judge: useHost ? 'host' : judgeClient.name, swap })
                    else recordMiss(db, aid, { kind: 'judge', reason: cmp.reason, raw: cmp.raw })
                  }
                }
              }
            } catch { /* 评委失败不影响对话 */ }
          } else {
            // 影子没跑成也留一条：不然「一条都没有」只能靠猜
            recordMiss(db, aid, { kind: 'shadow', reason: judged.reason, raw: judged.raw })
          }
        }
      } catch { /* 影子失败不影响对话 */ }
      /* 感受行的词表：保鲜期内没有一句生成的话，就在后台要一句（不许重样、不许 AI 味词）。
         拿到就落一条 expr.phrase，下一轮拼提示词时用；失败就继续用模板。 */
      try {
        const voiceOn = String(getParam(db, aid, 'affect.speech.voice') || 'on') !== 'off'
        if (!stranger && voiceOn && model.status().primary === 'ok') {
          const hours = Number(getParam(db, aid, 'affect.speech.voice_hours')) || 12
          if (!latestVoice(db, aid, { hours })) {
            const ar2 = db.prepare('SELECT primary_label, intensity FROM affect_state WHERE agent_id=?').get(aid)
            const v3 = db.prepare('SELECT slow FROM affect_v3 WHERE agent_id=?').get(aid)
            const gen = await generateVoice({
              complete: (m) => model.complete(toModelRequest(m)),
              recent: recentVoices(db, aid),
              label: (ar2 && ar2.primary_label) || 'calm',
              intensity: Number(ar2 && ar2.intensity) || 0.4,
              slow: Number(v3 && v3.slow) || 0,
            })
            if (gen.ok) recordVoice(db, aid, { text: gen.text })
            else recordMiss(db, aid, { kind: 'phrase', reason: gen.reason, raw: (gen.tried || []).join(' | ') })
          }
        }
      } catch { /* 词表失败继续用模板 */ }
      // 关系余量：她自己的回话偏离当轮表达基准时留一笔；下一轮只影响语气，夜里才可能结算。
      try {
        const expr = exprForResidue
        const tone = readReplyTone(aText)
        if (!stranger && expr && tone && !tone.flat && Number.isFinite(Number(expr.warmth))) {
          const expected = Number(expr.warmth) * 2 - 1
          const delta = tone.warmth - expected
          const dir = residueDirFor(tone.warmth, expected)
          if (dir) recordSelfResidue(db, aid, { dir, delta, warmth: tone.warmth, expected, replyLen: tone.len })
        }
      } catch { /* 余量失败不影响对话 */ }
      if (learning) { try { learnFromTurn(db, aid, u, res) } catch { /* 学习失败不影响对话 */ } }
    }).catch(() => {})
    // 自动记忆开关：关掉之后这一轮不再自动抽出记忆 / 偏好；对话档案（原文）照旧落。
if (learning) {
      // P2 异步抽取：先落队列，再由 worker 慢慢跑；进程这会儿挂了也不会丢。
try {
        enqueueExtraction(db, aid, [{ role: 'user', text: u, turnId: tid }, { role: 'assistant', text: aText, turnId: tid }])
        try { workers().kickExtractionTick() } catch { /* 踢一脚失败下轮轮询会补 */ }
      } catch { /* 入队失败不影响对话 */ }
    }
    // 三观快环：开关关闭直接返回；这里只入缓冲，抽取在后台定时器里。
try { sangguanAfterTurn(db, aid, { user: u, assistant: aText, sid, at }) } catch { /* 三观失败不影响对话 */ }
    // 会疼：判这段话有没有踩到它自己认下的命题（默认 shadow 只记不判账）
    Promise.resolve().then(async () => {
      try {
        const { checkReply } = await import('./src/modules/sangguan/violate.js')
        await checkReply(db, aid, { text: aText, at })
      } catch { /* 判定失败不影响对话 */ }
    }).catch(() => {})
    // 会欠账：这句里带期限的承诺，记成带到期日的一条
    Promise.resolve().then(async () => {
      try {
        const { registerPledges } = await import('./src/modules/sangguan/pledge.js')
        registerPledges(db, aid, { text: aText, at })
      } catch { /* 入队失败不影响对话 */ }
    }).catch(() => {})
  }
  try { tickOneShadow(db) } catch { /* 影子推进失败不影响对话 */ }
  try { tickRitual(db, aid) } catch { /* 关系仪式衰减失败不影响对话 */ }
  try { tickConflicts(db, aid) } catch { /* 冲突悬置衰减失败不影响对话 */ }
  try { tickEscalation(db, aid) } catch { /* 冲突升级失败不影响对话 */ }
  try { evaluateDrive(db, aid) } catch { /* 鏆傚仠鎴栨暟鎹己澶?*/ }
  // 本机麦说完这一轮：设置是「自动念」就在后台把回复念出来，不拖对话落账。
  Promise.resolve().then(() => maybeSpeakReply({ db, agentId: aid, sessionId: sid, text: aText })).catch(() => {})
}

/**
 * 用户这句话的「参与度」信号：字数、距上一句多久。
 * 只记不读——先攒数据，别急着让她据此改情绪：回得短不等于没兴趣，读错了比不读更像戏。
 */
export function recordEngagement(db, aid, text, gapMin, at = Date.now()) {
  try {
    const t = String(text || '')
    if (!t) return null
    const payload = {
      len: Array.from(t).length,
      gap_min: gapMin == null ? null : Math.round(gapMin * 10) / 10,
      pushed: t.startsWith('（它主动来找你'),
    }
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(nid('evt_'), aid, 'user.engagement', JSON.stringify(payload), new Date(at).toISOString())
    return payload
  } catch { return null }
}

function captureTurn(db, aid, session, event) {
  if (!event || !session || !session.id) return
  const sid = String(session.id)
  lastSessions.set(aid, { sid: session.id, at: Date.now() })
  // 事件名和 data 形状归宿主适配层管（host/dsh.js），这里只认「是谁说的」。
const turn = readEvent(event)
  // QQ 会话的身份：陌生人只留这段会话的流水账，不落原文、不进长期记忆。
  const qc = qqContextOf(sid)
  const stranger = !!(qc && !qc.isOwner && !qc.ownerUnset)
  if (turn.kind === 'user') {
    const t = cleanUserText(turn.text)
    if (t) {
      lastUser.set(sid, t)
      const nowMs = Date.now()
      const prevAt = lastUserAt.get(sid)
      // 参与度只记不读：先攒数据，别急着让她据此改情绪
      recordEngagement(db, aid, t, prevAt ? (nowMs - prevAt) / 60000 : null, nowMs)
      lastUserAt.set(sid, nowMs)
      const tid = makeTurnId()
      lastTurnId.set(sid, tid)
      if (t.startsWith('（它主动来找你')) pushedTurns.add(sid)
      // T4 原文层：用户这句话先落冷库，哪怕这一轮最后没有回复也不丢。
if (!stranger) try { appendTurn(db, aid, { sessionId: sid, role: 'user', text: t, turnId: tid, at: now() }) } catch { /* 原文失败不影响对话 */ }
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
          if (t) { lastUser.set(sid, t); if (!lastTurnId.get(sid)) lastTurnId.set(sid, makeTurnId()); break }
        }
      }
    } catch { /* 日志读不到 */ }
  }
  const reply = turn.text
  if (!reply) return // 工具调用步没有正文，继续等
  // 浮现观测：回复里有没有真的用上这几轮注入的记忆（十轮内只判一次）。
try { markSurfacedUsed(db, aid, reply) } catch { /* 观测失败不影响对话 */ }
  pendingReply.set(sid, reply)
  // 固定这一轮的表达基准；commitTurn 延迟 1.2s，期间可能已经拼了下一轮。
  pendingExpr.set(sid, levelCache.get(aid) || null)
  const old = commitTimers.get(sid)
  if (old) clearTimeout(old)
  const timer = setTimeout(() => {
    try { commitTurn(db, aid, sid) } catch { /* 忽略 */ }
  }, 1200)
  if (timer.unref) timer.unref()
  commitTimers.set(sid, timer)
  __probe('reply-buffered len=' + reply.length)
}

/** 找桥接插件的会话映射表：实现搬到 src/modules/qq_watch.js（看板也要用同一份路径规则）。 */

const qqPromptSeen = new Set()
let qqScopeProbeDone = false

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
    // 没有新排的：看看积压里有没有还该发的——她攒着想说的话，别一直烂在队列里。
    if (!out || !out.queued || !out.id || !out.text) {
      try {
        const row = db.prepare("SELECT id, text FROM proactive WHERE agent_id=? AND state='pending' ORDER BY created_at DESC LIMIT 1").get(aid)
        if (row && pushableLine(row.text)) out = { queued: true, id: row.id, text: row.text }
      } catch { /* 取不到就不推 */ }
    }
    if (!out || !out.queued || !out.id || !out.text) return
    // 先试 QQ：桥的发送口比宿主 prompt 稳，而且真发到手机上。
    try {
      if (String(getParam(db, aid, 'qq.push.enable') || 'off') === 'on') {
        const target = String(getParam(db, aid, 'qq.push.target') || '').trim()
        const api = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('qqBridge') : null
        const q = await pushProactiveToQQ({
          db, aid, api, chatKey: ownerChatKey(target), line: out.text, proactiveId: out.id,
        })
        if (q.ok) { __probe('qq-push-ok id=' + out.id); return }
        __probe('qq-push-skip ' + q.reason + (q.error ? ' ' + q.error : ''))
      }
    } catch (e) { __probe('qq-push-err ' + (e && e.message)) }
    let prefs = null
    try { prefs = getProactivePrefs(db, aid) } catch { /* 偏好读不到就不推 */ }
    if (!prefs || !prefs.push) return
    const rec = lastSessions.get(aid)
    // 多实例：只往「这段对话确实归它」的地方推；没绑定就只入队，不打扰别的对话。
if (rec && rec.sid) {
      let owner = null
      try { owner = resolveAgentId(db, String(rec.sid)) } catch { owner = null }
      if (owner !== aid) return
    }
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
 * 探针：控制台看不到插件的 console.error，所以关键行进 hook.log。
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
 * 四个接缝，不碰业务内容。宿主怎么调用它们由 src/host/dsh.js 决定；
 * 这里只说「注入什么」「收到事件做什么」「挂哪些路由」，不碰任何宿主 API。
 * 只要有一个意识体在运行，**所有会话**都是它；暂停之后全部恢复成普通 DSH。
 */
let lastMeterAt = 0

/**
 * 量这一轮的水位。
 * tokenMeter 是宿主服务，只有这里知道；失败就静默，别让「提醒」把对话弄挂。
 * 15 秒节流：pre-step 每步都跑，measure 是 O(surface)，长会话里不值得每步都算一遍。
 */
function noteSessionMeter(payload, readTokens) {
  const t0 = Date.now()
  if (t0 - lastMeterAt < 15000) return
  const agent = payload && payload.agent
  const session = agent && agent.session
  if (!session || !session.id) return
  lastMeterAt = t0
  const d = ensureDb()
  const aid = sessionAgentId(d, String(session.id)) || activeAgentId(d)
  let window = 0
  try {
    const rc = typeof session.requestContext === 'function' ? session.requestContext() : null
    if (rc) window = Math.max(0, Number(rc.contextWindow) || 0)
  } catch { window = 0 }
  if (!window && aid) window = Math.max(0, Number(getParam(d, aid, 'mind.meter.window')) || 0)
  let used = 0
  try {
    if (typeof readTokens === 'function') {
      used = Math.max(0, Number(readTokens(session)) || 0)
    } else {
      const tm = optionalService('tokenMeter')
      if (tm && typeof tm.measure === 'function') {
        const mm = tm.measure(session)
        used = Math.max(0, Number(mm && mm.totalTokens) || 0)
      }
    }
  } catch { used = 0 }
  if (!used) return
  noteMeter(String(session.id), { used, window })
}

/** 测试/诊断用：直接喂一次水位，不经过宿主服务。 */
export const debugNoteSessionMeter = noteSessionMeter

/** 测试用：把 15 秒节流归零，否则一个进程里只能量一次。 */
export function _resetMeterThrottle() { lastMeterAt = 0 }

function hostSpec() {
  const db = () => ensureDb()

  return {
    // 1) 系统提示：人格 / 情绪 / 关系 / 禁忌 / 记忆
    systemPrompt: {
      name: 'dsh-consciousness',
      order: 12,
      text: (asmCtx) => {
        try {
          const d = db()
          if (!qqScopeProbeDone) {
            qqScopeProbeDone = true
            try {
              const sc = asmCtx && asmCtx.scope
              event(d, activeAgentId(d) || '', 'qq.bridge.scope_probe', {
                ctxKeys: asmCtx ? Object.keys(asmCtx) : [],
                scopeType: typeof sc,
                scopeKeys: sc && typeof sc === 'object' ? Object.keys(sc).slice(0, 25) : [],
                scopeId: sc && typeof sc === 'object' && 'id' in sc ? String(sc.id) : '',
                scopeName: sc && typeof sc === 'object' && 'name' in sc ? String(sc.name) : '',
              })
            } catch { /* 探针失败不影响提示词 */ }
          }
          // QQ 会话：人格包照给，后面多一段「在这条线上怎么开口」。
          // 不去 agent scope 另挂 section——真机验过 this 不是会话 ctx，挂不上；
          // 用 currentInitiator 认当前会话，一处就够，也不会给网页会话多加东西。
          const qq = currentQQContext()
          // 人格跟会话走：这段对话绑的是谁，提示词就是谁；没绑定的才退回当前激活。
          const sid = currentSessionId()
          const id = sid ? sessionAgentId(d, sid) : activeAgentId(d)
          // 感受快照带主人原话：QQ 上只给主人。这里不传 audience（那会连带改日记/开环/主动句，
          // 是另一件事），只把「快照」这一行按 isOwner 关掉。
          const snapOpt = qq && qq.isQQ && qq.isOwner === false ? 'off' : 'on'
          // 这一段对话的键：网页用 dsh:<会话id>，QQ 用它自己的 conversation_id。
          const conversationId = qq && qq.isQQ && qq.conversationId ? qq.conversationId : webConversationId(sid)
          const base = id ? consciousnessBlock(d, id, { snap: snapOpt, sessionId: sid, conversationId }) : ''
          // 状态行（上下文水位 / 复盘欠债）：只给主人看；客人或不认识的通道不透露私事。
          let stateLine = ''
          try {
            const ownerHere = !qq || !qq.isQQ || qq.isOwner === true
            if (id && ownerHere) stateLine = mindLine(d, id)
          } catch { stateLine = '' }
          if (qq && qq.isQQ) {
            // 探针：每个会话只记一次，确认真机上渠道段确实进了提示词（不然就是静默失效）
            try {
              if (!qqPromptSeen.has(qq.sessionId)) {
                qqPromptSeen.add(qq.sessionId)
                if (qqPromptSeen.size > 200) qqPromptSeen.clear()
                event(d, activeAgentId(d) || '', 'qq.bridge.prompt_qq', { sessionId: qq.sessionId, chatKey: qq.chatKey, isOwner: qq.isOwner })
              }
            } catch { /* 探针失败不影响提示词 */ }
            const extra = qqChannelBlock(qq)
            return [base, extra, stateLine].filter(Boolean).join('\n\n')
          }
          return [base, stateLine].filter(Boolean).join('\n\n')
        } catch { return '' }
      },
    },

    // 2) 每个 step 之前：拿这一轮用户的话去召回，60 秒内有效
    preStep: async (payload, next) => {
      try {
        const d = ensureDb()
        const sid = payload && payload.agent && payload.agent.session && payload.agent.session.id
          ? String(payload.agent.session.id) : ''
        const aid = sid ? sessionAgentId(d, sid) : activeAgentId(d)
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
              // 历史第三人称旁白（source='summary'）默认不进 S1：那是「用户关心什么」，不是「我记得的事」。
              if (String(getParam(d, aid, 'memory.inject.user_summary') || 'off') === 'on') opt.summaryInjected = true
              // 她自己的事：配额名额 + 48h 新鲜加成。
              const sq = Number(getParam(d, aid, 'memory.inject.self_quota'))
              if (Number.isFinite(sq)) opt.selfQuota = Math.max(0, Math.min(2, Math.round(sq)))
              // 「我好像就是这样」单独占一格：模式不跟流水账抢同一个名额。
              const pq = Number(getParam(d, aid, 'memory.inject.pattern_quota'))
              if (Number.isFinite(pq)) opt.patternQuota = Math.max(0, Math.min(2, Math.round(pq)))
              const sfb = Number(getParam(d, aid, 'memory.inject.self_fresh'))
              if (Number.isFinite(sfb)) opt.selfFreshBoost = Math.max(0, Math.min(1, sfb))
              // 防「祥林嫂」：先看最近几轮里自己的事各露过几次，检索时把露太多次的让开。
              try {
                const repMax = Number(getParam(d, aid, 'memory.self.repeat_max'))
                if (Number.isFinite(repMax) && repMax > 0) {
                  const repH = Number(getParam(d, aid, 'memory.self.repeat_hours'))
                  const ids = recentSelfIds(d, aid)
                  opt.selfShown = shownCounts(d, aid, ids, Number.isFinite(repH) && repH > 0 ? repH : 24)
                  opt.selfRepeatMax = Math.max(1, Math.min(10, Math.round(repMax)))
                }
              } catch { /* 去重读不到就当没露过 */ }
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
              // G1：问句带过去时间（「上个月」「去年三月」）时补「那时」行；memory.asof.auto=off 时恒为空
              try {
                const ao = asofInjectItems(d, aid, qRaw)
                if (ao.items.length) {
                  r = { ...r, items: [...ao.items, ...(r.items || [])], why: (r.why || []).concat('那时：' + ao.items.length + ' 条') }
                }
              } catch (e) { __probe('asof-err:' + (e && e.message)) }
              // 深翻（P2）：她在问「记不记得」，或这一轮一条都没捞着 → 往前翻一次旧账。
              // 翻出来的标 via='deep'，注入时会写一句「这是刚翻出来的」，不许冒充一直记着。
              try {
                if (String(getParam(d, aid, 'memory.inject.deep') || 'on') !== 'off'
                  && (wantsDeep(qRaw) || !(r.items && r.items.length))) {
                  const dk = Math.max(1, Math.min(5, Number(getParam(d, aid, 'memory.deep.k')) || 3))
                  const deep = deepRecall(d, aid, q, { k: dk })
                  const seen = new Set((r.items || []).map((x) => x.id))
                  const add = deep.filter((x) => !seen.has(x.id)).slice(0, dk)
                  if (add.length) {
                    r = { ...r, items: [...(r.items || []), ...add], why: (r.why || []).concat('深翻：' + add.length + ' 条') }
                  }
                }
              } catch { /* 深翻失败不影响这一轮 */ }
              // 记忆块的预算是整段注入预算的一半（整段由下面的 clampInjection 按同一个参数收口）。
              const allBudget = Math.max(200, Math.min(4000, Number(getParam(d, aid, 'memory.inject.budget')) || 800))
              const memBudget = Math.max(150, Math.min(800, Math.round(allBudget / 2)))
              const packed = packMemoryBlock(d, aid, r.items, memBudget)
              // 真的进了注入块才算「露过脸」：被预算挤掉的不记账，否则下一轮会白白让位。
              try {
                if (opt.selfRepeatMax) {
                  const heads = (r.items || [])
                    .filter((x) => x.source === 'self' || x.source === 'life')
                    .map((x) => ({ id: x.id, head: String(x.text || '').trim().replace(/\s+/g, ' ').slice(0, 10) }))
                    .filter((x) => x.head && packed.text.includes(x.head))
                  if (heads.length) markShown(d, aid, heads.map((x) => x.id))
                }
              } catch { /* 记账失败不影响注入 */ }
              // 被想起来 = 强化一次：hits+1、稳定度上涨、衰减锚点拨回现在。
              // v3 之前只召回不记账，等于「想过一次」在系统里不留痕——热度榜和冷热迁移都靠它。
              // 「那时」行是翻旧账，只读：不记账，免得把作废的旧事实重新加热。
              try {
                const ids = (r.items || []).filter((x) => x.partition === 'T1' && !x.asof).map((x) => x.id)
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
      // 开口前量一下桌面还剩多少地方；拿不到窗口就不猜，说不说交给 mindstate。
      try { noteSessionMeter(payload) } catch { /* 量水位失败不影响这一轮 */ }
      return typeof next === 'function' ? next() : undefined
    },

    // 3) 会话事件：用户说了什么、模型回了什么
    sessionEvent: (session, event) => {
      __probe('event:' + (event && event.type))
      try {
        const sid = session && session.id ? String(session.id) : ''
        // 第一次见到这段对话就把它钉到「最近唤醒的那个人」；之后只认绑定。
        // QQ 会话不会被自动钉（pinSessionAgent 对 qq- 返回 null），但手动绑过的照样记账——别让这段对话没有账。
        const id = sid ? (pinSessionAgent(db(), sid) || sessionAgentId(db(), sid)) : activeAgentId(db())
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
          // 退路水位：宿主没给 tokenMeter 时，用上一次请求真实的输入量近似。
          try {
            if (event && event.type === 'assistant/message' && event.data && event.data.usage) {
              meterFromUsage(String(session.id), event.data.usage)
            }
          } catch { /* usage 只作退路 */ }
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
            meter: meterOf(''),
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
      // 右下角光点用：这一轮「开口」的时间戳。变了就亮一下，平时静静待着。
      const d5 = child.webServer.register({
        kind: 'exact',
        path: '/dsh-consciousness/voice-flash',
        handler: (_req, res) => {
          sendJson(res, 200, { at: lastVoiceFlash() })
        },
      })
      return () => {
        try { d1() } catch { /* ignore */ }
        try { d2() } catch { /* ignore */ }
        try { d3() } catch { /* ignore */ }
        try { d4() } catch { /* ignore */ }
        try { d5() } catch { /* ignore */ }
      }
    },

    // 5) 工具：模型能真正调用的行动接口（发消息 / 浏览 / 研究 / 提醒）。
    // 端口没开时工具仍在，执行时返回「接口未开启」，模型知道有这回事但动不了手。
    tools: createActionTools({
      getDb: () => ensureDb(),
      getAgentId: () => initiatorAgentId(),
      // QQ 会话里没有「当前发起人」：按这条会话自己认人，别让 feel 写成 no_db。
      getAgentIdForSession: (sid) => { try { return agentOfSession(ensureDb(), sid) } catch { return '' } },
      getWeb: () => optionalService('web'),
      getSpeech: () => optionalService('speechToText'),
      getModel: () => model,
      // 第二道闸：工具执行前自己再判一次（守卫那层注册失败/降级时还拦得住）
      gateSearch: (sessionId) => verdictFor({
        db: ensureDb(),
        aid: initiatorAgentId() || '',
        sessionId,
        param: gateParam(),
        findSessionsFile: () => findQQSessionsFile(),
      }),
      log: __probe,
    }),

    // 6) 认人硬闸：客人会话里 memory_search 直接拒。
    // 守卫是全局的，所以里面只认 memory_search 一个名字，别的工具原样放过。
    toolGuards: [
      makeOwnerGuard({
        getDb: () => ensureDb(),
        getAid: () => initiatorAgentId(),
        param: gateParam(),
        findSessionsFile: () => findQQSessionsFile(),
      }),
    ],

    // 7) 对外服务：别的插件（QQ 桥）按名字拿「听」和「说」，不 import 我们的文件。
    // 名字定死了就不许边写边改——跨包契约一改两边都要动。
    services: createVoiceServices({
      getSpeech: () => optionalService('speechToText'),
      getConfig: () => {
        const d = ensureDb()
        const aid = activeAgentId(d)
        return aid ? getActionConfig(d, aid) : {}
      },
    }),
  }
}

/** 闸读参数的地方：跟 QQ 桥接一样按「当前会话认的人」取，取不到就返回 undefined（走各自的默认）。 */
function gateParam() {
  return (k) => {
    const d = ensureDb()
    const aid = initiatorAgentId() || activeAgentId(d)
    if (!aid) return undefined
    if (k === 'qq.bridge.sessions_file') return getParam(d, aid, k) || findQQSessionsFile()
    return getParam(d, aid, k)
  }
}

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
      model.embed(['keepalive']).catch(() => { /* 服务没起就下次再来 */ })
    } catch { /* 没有向量能力时静默 */ }
  }, 4 * 60 * 1000)
  if (embedWarmTimer.unref) embedWarmTimer.unref()
}

export function apply(ctx) {
  try { attachHostLlm(() => ctx) } catch { /* llm 服务不可用 */ }
  // QQ 等外部通道的 reply() 也用同一份意识体包，避免网页一个样、QQ 另一个样
  try { attachContextBlock((db, aid, opts) => consciousnessBlock(db, aid, opts)) } catch { /* 包构建失败就退回精简提示 */ }
  try { hostCtx = ctx } catch { /* 宿主上下文不可用 */ }
  try { attachActionDeps({ getWeb: () => optionalService('web'), getSpeech: () => optionalService('speechToText'), getModel: () => model }) } catch { /* 行动层降级 */ }
  if (!acquireLock()) {
    console.error('[dsh-consciousness-v6] another instance holds the lock; plugin stays offline')
    return
  }
  // 绝不让本插件的初始化异常拖垮 Desktop Host（否则 welcome 鉴权失败，整个 DeepSeek 打不开）。
try {
    ensureDb()
    startMaintenance()
    try { startHeartbeat() } catch { /* 心跳起不来不影响宿主 */ }
    startEmbedKeepalive()
  } catch (e) {
    console.error('[dsh-consciousness-v6] db init failed (plugin stays soft-offline):', e)
  }

  __probe('apply-enter lock=' + lockHeld)
  // QQ 桥接适配（dsh-qq-onebot-bridge）：认出 QQ 来的 agent，后面按会话挂人格包、记对话。
  // 总开关 qq.bridge.enable 默认 off；关着时监听在，但一条不记、不改任何行为。
  try {
    qqBridgeHandle = attachQQBridge({
      getCtx: () => hostCtx,
      getDb: () => ensureDb(),
      getAid: () => activeAgentId(ensureDb()),
      // 按会话归属认人：绑了小汐就是小汐的，别拿网页那边当前激活的顶替。
      resolveAid: (d, key) => qqAidOf(d, key),
      // 桥接重建 sessionId 时把新会话续绑回原来的意识体（否则记忆链断在新 id 上）。
      autoBind: (d, sid) => autoBindQQSession(d, sid),
      param: (k, hint) => {
        const d = ensureDb()
        const aid = (hint && qqAidOf(d, hint)) || initiatorAgentId() || activeAgentId(d)
        const v = aid ? getParam(d, aid, k) : undefined
        // 会话映射表没配就自己找一下：桥接插件把它写在它的工作目录里。
        // 找不到也不要紧——qq_bridge 会退化成只认主人，群聊/陌生人就当认不出。
        if (k === 'qq.bridge.sessions_file' && !v) return findQQSessionsFile()
        return v
      },
      log: (m) => { console.error(m); __probe('qqbridge ' + m) },
    })
    __probe('qqbridge ' + (qqBridgeHandle.attached ? 'attached' : 'not-attached: ' + qqBridgeHandle.reason))
  } catch (e) {
    console.error('[dsh-consciousness-v6] qq bridge attach failed:', e)
  }

  // QQ 的提示段：宿主那段 systemPrompt 拿不到 QQ 会话 ctx（qq.bridge.no_scope），
  // 所以人格和 feel 一直缺着；借桥接的 provider 扩展点，把整份人格包挂进 QQ（和网页同一份）。
  // 桥接的 extensionToolsEnabled 关着时这条不生效（provider 不会被调用）。
  try {
    const feelHandle = attachQQFeelProvider({
      getCtx: () => hostCtx,
      getDb: () => ensureDb(),
      getAid: () => activeAgentId(ensureDb()),
      resolveAid: (d, key) => qqAidOf(d, key),
      // 同一份拼装器：网页和 QQ 不再各长一副面孔。
      persona: (d, aid, opts) => consciousnessBlock(d, aid, opts),
      param: (k, hint) => {
        const d = ensureDb()
        const aid = (hint && qqAidOf(d, hint)) || initiatorAgentId() || activeAgentId(d)
        return aid ? getParam(d, aid, k) : undefined
      },
      log: (m) => { console.error(m); __probe('qqfeel ' + m) },
    })
    __probe('qqfeel ' + (feelHandle.attached ? 'attached' : 'not-attached: ' + feelHandle.reason))
  } catch (e) {
    console.error('[dsh-consciousness-v6] qq feel provider attach failed:', e)
  }

  // QQ 对话回流：**不再单独挂一条写入路**。
  // 真机验过：session/event 旁听本来就会把 QQ 会话的对话写进 chat_turns / raw_turns / 关系账本，
  // 只是不知道是什么渠道（conversation_id 落 null）。所以现在改成「让既有旁路认得出 QQ」——
  // 见 captureTurn / commitTurn 里的 qqContextOf()，一份就够，不会一句话记两遍。
  // attachQQIngest 留在模块里没接：它假设"旁路不记 QQ"，那个前提是错的。

  
  // 宿主接缝：四个各自探测、各自安装、各自降级，缺哪个只丢哪个，ping 里报出来。
// 界面在 Client 半（client.js），由 dsh.client 模块加载并注册进 settings.section。
  host = createHost({
    log: (m) => {
      // 控制台看不到，所以 reason 也进 hook.log——上一轮就是只看 summary 才定位不到
      console.error(m)
      __probe('hostlog ' + m)
    },
  })
  try {
    const report = host.install(ctx, hostSpec())
    __probe('host ' + report.summary)
    // pending / transient（等 inject 回调），只有真降级才值得报错
    const bad = report.seams.filter((s) => s.level === 'error' || s.level === 'degraded' || s.level === 'absent')
    if (bad.length) console.error('[dsh-consciousness-v6] host degraded:', report.summary)
    const settled = setTimeout(() => {
      try { __probe('host-settled ' + host.report().summary) } catch { /* ignore */ }
    }, 500)
    if (settled.unref) settled.unref()
  } catch (e) {
    console.error('[dsh-consciousness-v6] host attach failed:', e)
  }

  // 光点已改到网页里（client 半，右下角），不再从宿主起系统窗口——
  // DSH 的插件进程里 spawn 出来的界面程序活不下来（PATH 里没有 powershell，绝对路径也会立刻退出）。
}

/**
 * 拉起右下角那颗光点。
 * 只在「没记 pid，或者那个 pid 已经死了」时才起，否则每次重载都会多叠一个。
 * 失败静默：它只是给眼睛的一个信号，不该拖累插件。
 */
function startVoiceGlow() {
  try {
    const root = path.dirname(fileURLToPath(import.meta.url))
    const script = path.join(root, 'scripts', 'voice-glow.ps1')
    if (!fs.existsSync(script)) return
    const pidFile = path.join(root, '..', 'runtime', 'voice-glow.pid')
    try {
      const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim())
      if (Number.isFinite(pid) && pid > 0) {
        process.kill(pid, 0)
        return // 还活着，不用再起
      }
    } catch { /* 没 pid 文件或进程已死：往下起 */ }
    // 插件进程里的 PATH 不一定有 powershell，用绝对路径起
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const exe = fs.existsSync(psExe) ? psExe : 'powershell.exe'
    const child = spawn(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    if (child.pid) fs.writeFileSync(pidFile, String(child.pid))
  } catch { /* 静默 */ }
}

