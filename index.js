/**
 * dsh-consciousness 鈥?鎰忚瘑浣擄細瀹夸富鍗娿€? *
 * 数据库和业务都在插件进程内，界面是独立的 Client 半（client.js），
 * 閫氳繃 settings.section 娉ㄥ唽鎴愩€岃缃?鈫?鎰忚瘑銆嶄竴鏁撮〉锛屼笉寮€娴眰銆佷笉寮€ iframe銆? *
 * 鎺ュ彛锛歅OST /dsh-consciousness/api锛圝SON 淇″皝锛? * 鏁版嵁锛殈/.dsh/consciousness/app.db锛坣ode:sqlite锛? *
 * 璁板繂鏁寸悊锛堢敤妯″瀷鍚堝苟閲嶅鑷渷锛夛細POST /v1/agents/:id/memory/consolidate锛宒ry_run=1 鍙湅鏂规銆? * 瀛橀噺鍒嗙骇锛堟寜瑁佸垽鎶婁綆鍒嗚嚜鐪佹墦杩涘喎灞傦級锛歅OST /v1/agents/:id/memory/demote锛宒ry_run=1 鍙粺璁°€? */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, recover, now } from './src/db.js'
import { handle } from './src/api.js'
import { attachHostLlm } from './src/model.js'
import { eventsSince, getFlag, ingest, applyActiveRules, backupDrill, learnFromTurn, queueProactive, settleProactiveAnswered, clampInjection, appraiseWithEdges, tickOneShadow, applyDriverToDrive, getProactivePrefs, autoGrowPreferences, attachContextBlock, closingIntentOf } from './src/features.js'
import { nid, purgeExpired, evaluateDrive, recall, getParam, settleObservations, expireProposals, recoverChangeJournal, gcArtifacts, shrinkPersona, tickRitual, tickConflicts, maybeDraft, TARGET_IDS, latestUserEmotion, decayAffect, getDrive, spontaneousTick } from './src/core.js'
import { seedRuleBindings } from './src/modules/artifacts.js'
import { DIMS } from './src/modules/values.js'
import { axisWords, mbtiPrompt } from './src/modules/traits.js'
import { pulseDriveFromSignals } from './src/modules/drive.js'
import { pushProactiveLine } from './src/push.js'
import { claimLine } from './src/modules/conflict_ask.js'
import { examplesBlock, parseExamples } from './src/modules/examples.js'
import { presenceLine } from './src/modules/presence.js'
import { selfNoteLines as notesForPrompt } from './src/modules/selfnote.js'
import { memoryTag, ageDays } from './src/modules/memory_tag.js'
import { fadeText, shouldFade, rehearseAdjustedAge } from './src/modules/memory_fade.js'
import { detectMode, resolveMode, styleInjection } from './src/modules/style_mode.js'
import { auditStore } from './src/modules/ops.js'
import { cleanUserText } from './src/text.js'
import { toneOf } from './src/algo/reldyn.js'
import { expressionState, cardLine, subtextOf, subtextClass } from './src/modules/expression_state.js'
import { attachDb } from './src/algo/index.js'
import { createHost, readEvent, messageText } from './src/host/dsh.js'
import { appendTurn, buildEpisode, recentDiaryLines, migrateArchive, backfillFactArchive, sessionBridge } from './src/modules/archive.js'
import { pushTurn, hydrateFromRaw } from './src/modules/buffer.js'
import { retrieve, contextualQuery, deepRecall, wantsDeep } from './src/modules/retrieve.js'
import { recentSelfIds, shownCounts, markShown } from './src/modules/self_repeat.js'
import { prefetchExpand, takeExpansion } from './src/modules/expand.js'
import { prefetchEmbedding, takeEmbedding } from './src/modules/vector.js'
import { backfillEntities } from './src/modules/entities.js'
import { packInjection, oneLine } from './src/modules/pack.js'
import { loopLineFor, loopPrefixOf, markLoopsFired, expireLoops } from './src/modules/loops.js'
import { recordSurfaced, markSurfacedUsed } from './src/modules/surfacing.js'
import { surfaceQueueTick, pendingSurface, consumeSurface } from './src/modules/pulse.js'
import { applySelfRead, readReplyTone } from './src/modules/self_read.js'
import { recordSelfResidue, residueCandidate, commitResidue, residueDirFor } from './src/modules/self_residue.js'
import { captureQuote, quoteCandidate, commitQuote } from './src/modules/quote_echo.js'
import { feltSnapshot } from './src/modules/felt_snapshot.js'
import { latestFeel, feelLineOf } from './src/modules/feel.js'
import { logRetrieval } from './src/modules/retrieval_log.js'
import { asofInjectItems } from './src/modules/asof.js'
import { enqueueExtraction, tickExtraction, makeTurnId } from './src/modules/extract_queue.js'
import { tickEscalation } from './src/modules/conflict.js'
import { runNightly, dueDiaryDays, hasDiaryMaterial } from './src/modules/nightly.js'
import { repairPending, repairOldDiaries, defaultDiaryChat } from './src/modules/diary.js'
import { readViews } from './src/modules/sangguan/bridge.js'
import { speakTurn, selfInquiry } from './src/modules/sangguan/speak.js'
import { afterTurn as sangguanAfterTurn } from './src/modules/sangguan/fast.js'
import { promptHook as sangguanPrompt } from './src/modules/sangguan/inject.js'
import { ensureHeatBootstrapped, touch } from './src/modules/tiers.js'
import { model } from './src/kernel.js'
import * as R from './src/modules/relations.js'
import { enqueueRelationRead, tickRelationRead } from './src/modules/relations_extract.js'
import { moodValenceOf, moodLabelOf, trendOf, reviewTick } from './src/modules/affect.js'
import { addMemory } from './src/modules/memory.js'
import { createActionTools, attachActionDeps, executeBrowse } from './src/modules/actions/index.js'
import { lifeTick, lifeLine } from './src/modules/life.js'
import { reappraiseLine } from './src/modules/reappraise.js'
import { resolveAgentId, touchSession, peekPending, bindingsOf, runningAgentIds, maxRunning, refreshAll, refreshRuntime, sweepBindings, migrateLegacyBindings } from './src/modules/binding.js'
import { heartbeatTick } from './src/modules/heartbeat.js'
import { attachQQBridge, attachQQIngest, resolveQQContext, isQQSessionId, parseOwnerQq, loadSessionMap, qqChannelBlock } from './src/modules/qq_bridge.js'
import { mindLine, noteMeter, meterFromUsage, meterOf } from './src/modules/mindstate.js'
import { makeOwnerGuard, verdictFor } from './src/modules/owner_gate.js'

// 情绪注入的人话化交给 modules/expression_state.js（第一人称感受 + 软愿望）；这里不再保留「强度 / 心情 / 底色」的数字分档函数。
// 蹇呴』涓?package.json / cordis.patch.yml 鐨勫寘鍚嶄竴鑷达紝鍚﹀垯 loader 鎸傝浇寮傚父銆?
export const name = 'dsh-consciousness-v6'
export const inject = []

const API_PATH = '/dsh-consciousness/api'
const PING_PATH = '/dsh-consciousness/ping'
const DB_PATH = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'consciousness', 'app.db')
const LOCK_PATH = path.join(path.dirname(DB_PATH), 'app.lock')

// 瀹夸富涓婁笅鏂囧拰鏈€杩戣鍒扮殑浼氳瘽锛氫富鍔ㄥ彂娑堟伅瑕佺敤 sessionController.prompt 鎺ㄨ繘鍘汇€?
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
/** 瀹夸富閫傞厤鍣細鍥涗釜鎺ョ紳鐨勬帰娴嬬粨鏋滐紝ping 閲屽師鏍锋姤鍑哄幓銆?*/
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
    } catch { /* 鍧忛攣褰撻檲鏃?*/ }
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
    // 鑰佸簱杩佺Щ锛氭妸銆屾湰鏉ュ氨鍦ㄥス鍚嶄笅鐨勪細璇濄€嶈棰嗗洖鏉ワ紝鍒崌绾у畬鎶婁富浜烘鍦ㄨ亰鐨勯偅娈靛彉鎴愭櫘閫?DSH
    try { migrateLegacyBindings(db) } catch { /* 杩佺Щ澶辫触涓嬫鍚姩鍐嶈瘯 */ }
    // 鍦ㄥ満鐘舵€佹槸娲剧敓鍊硷細姣忔鍚姩鎸?bindings 閲嶇畻涓€閬嶏紝鍒涓婃宕╂簝鐣欎笅鐨勭姸鎬侀獥浜?
try { refreshAll(db) } catch { /* 鐘舵€侀噸绠楀け璐ヤ笅娆″埛鏂颁細琛?*/ }
    // 鍒嗗眰璁板繂锛氳€佸簱琛ヤ竴娆＄儹搴︼紱椤烘墜鎶婃渶杩戜笁澶╃己鐨勬棩璁拌ˉ涓婏紙鍚庡彴锛屽け璐ヤ笉褰卞搷鍚姩锛?
try { ensureHeatBootstrapped(db) } catch { /* 鐑害琛ラ綈澶辫触涓嬫鍐嶆潵 */ }
    setTimeout(() => {
      try {
        // 琛ユ暟鎹笉鎸?status锛歱aused 鐨勪篃瑕佽ˉ锛坧aused 鍙槸涓嶄富鍔ㄥ紑鍙ｏ紝涓嶆槸涓嶅瓨鍦級
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
        // 缂撳啿锛氶噸鍚悗浠?T4 鎶婃渶杩戜竴涓細璇濈殑灏惧反鎹炲洖鏉?
try { hydrateFromRaw(db, aid) } catch { /* 閲嶆斁澶辫触涓嶅奖鍝嶅惎鍔?*/ }
      } catch { /* 启动补数据失败不影响启动 */ }
    }, 5000)
    // P2 鎶藉彇 worker锛氭瘡 30 绉掔湅涓€鐪奸槦鍒楋紝30 绉掑墠鍏堣窇涓€娆★紙閲嶅惎鍚庢妸绉帇娓呮帀锛?
try { startExtractionWorker() } catch { /* worker 璧蜂笉鏉ヤ笉褰卞搷鍚姩 */ }
    // 鍏崇郴璇讳汉 worker锛氭妸鎺掗槦鐨勪汉鐗╂彁鍙婅鎴愩€岃皝鏄皝鐨勮皝銆?
try { startRelationWorker() } catch { /* worker 璧蜂笉鏉ヤ笉褰卞搷鍚姩 */ }
    // P4 澶滈棿宸╁浐锛氭瘡澶?23:00 鍐欐棩璁帮紱鍏虫満 / 浼戠湢閿欒繃鐨勶紝涓嬫鍚姩鎴栧崐灏忔椂鍐呰ˉ涓娿€?
try { startNightlyWorker() } catch { /* 宸╁浐 worker 璧蜂笉鏉ヤ笉褰卞搷鍚姩 */ }
    try { startDiaryRetryWorker() } catch { /* diary retry worker unavailable */ }
    // 偏好自己长：10 分钟一次，够条件才真调模型；长出来的删不掉
    try { startGrowPrefsWorker() } catch { /* 闀垮亸濂?worker 璧蜂笉鏉ヤ笉褰卞搷鍚姩 */ }
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
        try { settleObservations(ensureDb()) } catch { /* 瑙傚療鏈熺粨绠楀け璐ヨ烦杩?*/ }
  try { gcArtifacts(ensureDb()) } catch { /* 版本清理失败跳过 */ }
        // 瀛樺偍浣撴锛氱储寮曟紡琛?/ 瀛ゅ効杈硅嚜鍔ㄤ慨锛堜笉淇篃涓嶄細鎶ラ敊锛屽彧浼氶潤榛樺皯鍙洖锛?
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

// ---------------- 姣忓疄渚嬪績璺筹紙schema 12锛?----------------
// 涓€涓?30 绉掔殑鎵弿鍣紝鎸?heartbeats.next_at 鍐冲畾璋佽閱掞紱姣忎汉鍒嗕袱妗ｏ細
//   light（零模型）：情绪衰减、浮现候选、开环到期、驱力日结、在场状态。
// 浠ュ墠杩欓噷鏄€屽叏灞€ 10 鍒嗛挓 tick 閬嶅巻鎵€鏈?active銆嶏紝鏃㈢湅涓嶅嚭璋佸仠浜嗭紝涔熶細涓€璧锋挒妯″瀷銆?
/** 杞绘椿锛氬悓姝ャ€佹绉掔骇銆佺粷涓嶈皟妯″瀷锛堟祴璇曢噷浼氭柇瑷€ deep=0锛夈€?*/
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
  // 绌洪棽蹇冭烦锛氫笉璋冩ā鍨嬶紝鍙粰銆岃嚜宸辨诞涓婃潵銆嶈ˉ鍊欓€夛紙涓嬩竴杞敞鍏ユ椂鏈€澶氬彇涓€鏉★級
  try { surfaceQueueTick(d, aid) } catch { /* 蹇冭烦澶辫触璺宠繃 */ }
  // 鎸傜潃鐨勫紑鐜埌鏈熺殑鏀舵帀锛屽埆涓€鐩村崰鐫€娉ㄥ叆鍚嶉
  try { expireLoops(d, aid) } catch { /* 寮€鐜け璐ヨ烦杩?*/ }
  // 椹卞姏锛氫簨浠惰剦鍐?+ 浠ｇ悊鎺ㄧ己鍙?+ 鏃ョ粨锛堢函瑙勫垯锛?
try { applyDriverToDrive(d, aid) } catch { /* 椹卞姩鎺ㄧ己鍙ｅけ璐ヨ烦杩?*/ }
  try { pulseDriveFromSignals(d, aid) } catch { /* 浜嬩欢鑴夊啿澶辫触璺宠繃 */ }
  try { evaluateDrive(d, aid) } catch { /* 鏆傚仠鎴栨暟鎹己澶?*/ }
  try { shrinkPersona(d, aid) } catch { /* 浜烘牸鏀剁缉澶辫触璺宠繃 */ }
  try { seedRuleBindings(d, aid) } catch { /* 宸ヤ欢绉嶅瓙澶辫触璺宠繃 */ }
  try { tickOneShadow(d) } catch { /* 褰卞瓙鎺ㄨ繘澶辫触璺宠繃 */ }
  // 鍦ㄥ満鐘舵€侊細14 澶╂病浜掑姩 = 鑷姩浼戠湢锛堝彧鍐?runtime锛屼笉鏀圭敤鎴锋剰鍥撅級
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
  } catch { /* 鍦ㄥ満鐘舵€佷笅娆″埛鏂颁細琛?*/ }
  // 銆岃繖娈靛璇濊繕鍦ㄧ敤銆嶇殑 TTL锛氬お涔呮病鍔ㄩ潤鐨勪細璇濊嚜鍔ㄦ澗缁戯紙涓€娆℃壂鎻忛『甯﹀仛涓€閬嶅叏灞€鐨勶級
  try { sweepBindings(d, { idleDays: 30 }) } catch { /* 鍥炴敹澶辫触涓嬫鍐嶆潵 */ }
}

/** 閲嶆椿锛氬彲鑳藉彨妯″瀷锛岀敱蹇冭烦鐨?deep 妗ｈ妭娴?+ 鍏ㄥ眬骞跺彂闂告姢鐫€銆?*/
async function heartbeatDeep(aid) {
  const d = ensureDb()
  try {
    const p = queueProactive(d, aid)
    const out = p && p.then ? await p : p
    if (out) await maybePushProactive(d, aid, out)
  } catch { /* 涓诲姩娑堟伅澶辫触璺宠繃 */ }
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
  // 鑷慨鏀圭殑璧疯崏锛堝彲鑳借皟妯″瀷锛夛紝鏀惧湪 deep 妗ｏ紝鍒崰 light 鐨勬绉掗绠?
for (const tid of TARGET_IDS) {
    try { maybeDraft(d, aid, tid) } catch { /* 鍗曠洰鏍囪捣鑽夊け璐ヨ烦杩?*/ }
  }
}

function startHeartbeat() {
  // 鎻掍欢鐑噸杞斤紙plugin_manager 鍏斥啋寮€锛変笉浼氳嚜鍔ㄦ竻鎺夎８ setInterval锛?
// 杩炵潃閲嶈浇鍑犳灏变細鏈夊嚑涓績璺冲悓鏃惰烦銆佷簰鐩告姠 next_at銆傛棫鎶婃墜鎸?globalThis锛屾柊鐨勫厛鏀舵帀銆?
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
  // 鍚姩鍚?12 绉掑厛鎵竴閬嶏細鎶婇噸鍚湡闂撮敊杩囩殑 light 琛ヤ笂锛坉eep 浼氭寜 deep_at 鑷繁鍒わ紝涓嶆姠璺戯級
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

// ---------------- 鎶婂畠鎺ヨ繘 DSH 鐨勫璇?----------------
// 琚€屽惎鍔ㄣ€嶇殑閭ｄ釜鎰忚瘑浣撲細缁戝畾鍒颁笅涓€涓柊寤虹殑瀵硅瘽锛氶偅娈靛璇濋噷妯″瀷鎷垮埌鐨?// 绯荤粺鎻愮ず浼氬甫涓婂畠鐨勪汉鏍笺€佹儏缁€佸叧绯诲拰璁板繂锛涘洖澶嶇粨鏉熷悗鍐嶆妸杩欎竴杞啓鍥炶蹇嗐€?
const lastUser = new Map()
/** 上一句用户话的时间：给参与度信号算间隔，只记不读。 */
const lastUserAt = new Map()
// 杩欎竴杞殑韬唤璇侊細鐢ㄦ埛閭ｅ彞璇濆拰鍔╂墜閭ｅ彞璇濆叡鐢ㄥ悓涓€涓?turn_id銆?// 璁板繂闈犲畠鍥炲埌鍘熻瘽銆備互鍓嶄粠鏉ヤ笉鐢熸垚锛屾墍浠?raw_turns.turn_id 鍏ㄧ┖銆?// memory_items.source_turn_id 涓€鏉￠兘 join 涓嶄笂鈥斺€斻€屼綘杩樿寰楁垜褰撴椂璇寸殑銆嶅氨鍙墿姝ｆ枃锛屾病鏈夊嚭澶勩€?
const lastTurnId = new Map()

function str(row, path, d = '') {
  if (!row) return d
  const r = row.find((x) => x.path === path)
  if (!r || r.value == null) return d
  return String(r.value).replace(/^"|"$/g, '')
}

/** 涓€娈靛彲璇荤殑鎰忚瘑浣撹嚜杩帮紝鐩存帴杩涚郴缁熸彁绀恒€?*/
export const recentRecall = new Map()

/**
 * 杩欎竴杞槸闂茶亰杩樻槸骞叉椿锛圥3锛夈€傛寜鏈€杩戜竴鍙ョ敤鎴疯瘽鍒わ紝auto 妯″紡涓嬭瀹冦€? * 鍜?recentRecall 涓€鏍锋槸銆屾湰杞殑銆嶇姸鎬侊紝涓嶆槸闀挎湡璁板繂銆? */
export const styleModeCache = new Map()

/** 鐢ㄦ埛璇翠簡鏂扮殑涓€鍙ワ細鏇存柊妯″紡鍒ゅ畾銆?*/
export function noteStyleMode(aid, text) {
  const mode = detectMode(text)
  styleModeCache.set(aid, mode)
  return mode
}

/**
 * 鐢ㄦ埛璇翠簡鏂扮殑涓€鍙ワ細涓婁竴鍙ョ殑鍙洖缁撴灉浣滃簾锛屽繀椤婚噸鏂版绱€? * 鍗曠嫭鎶藉嚭鏉ユ槸涓轰簡鑳芥祴鈥斺€斻€岀紦瀛樿涓嶈澶嶇敤銆嶅彧鐪嬭繖涓€鍒伙紝涓嶈闈犳椂闂寸寽銆? */
export function invalidateRecallCache(aid) {
  return recentRecall.delete(aid)
}

/**
 * 璁板繂鍧?= 妫€绱㈢粨鏋?鈫?瑁呯銆傚崟鐙娊鍑烘潵锛屾槸涓轰簡璁┿€屽姞涓嶅姞鏃堕棿鏍囩銆嶅彧鏈変竴澶勫紑鍏筹紝
 * 涔熻绂荤嚎鑴氭湰鑳芥祴鍒板拰绾夸笂鍚屼竴鏉¤矾寰勶紙scripts/bench-humanlike.mjs锛夈€? * memory.inject.age=off 鏃朵笌鏃х増閫愬瓧涓€鑷淬€? */
export function packMemoryBlock(db, aid, items, budget) {
  const packOpt = { budget }
  try {
    const at = Date.now()
    const ageOn = String(getParam(db, aid, 'memory.inject.age') || 'on') !== 'off'
    const withProv = String(getParam(db, aid, 'memory.inject.provenance') || 'on') !== 'off'
    if (ageOn || withProv) packOpt.decorate = (it) => memoryTag(it, at, { provenance: withProv, age: ageOn })
    // 「今天刚发生」也要带来源：不然她刚写下的自己的事，在注入里看不出是「我自己记得的」。
    if (withProv) packOpt.provenanceTag = (it) => memoryTag(it, at, { provenance: true, age: false })
    // 鍐呭绾фā绯婏細鏃т簨鐨勬嫭鍙?/ 鏁板瓧 / 鍘熻瘽浼氳鍒犳帀锛堝彧鍒犱笉鏀癸級銆?
// 閽変綇鐨勩€佺珛鍦?/ 杈圭晫 / 鎵胯绫汇€佸悓绫诲瀷閲屾墦鍒嗘渶楂樼殑閮戒笉鍙備笌锛?0 澶╀互鍐呬竴涓瓧閮戒笉鍔ㄣ€?
// 闂ㄦ鎸夌被鍨嬬粰锛堣 memory_fade.js 鐨?IMPORTANCE_GATE锛夆€斺€攔eflection 鏄弻宄扮殑锛?
// 涓€涓暟鍗℃墍鏈夌被鍨嬬瓑浜庢暣绫昏眮鍏嶃€?
if (String(getParam(db, aid, 'memory.inject.fade') || 'on') !== 'off') {
// 0 / 负数 = 整段关掉。不能用 || 3——那样「设成 0 想关」会变成「最强」。
      // 姝ｅソ鏄弽鏁堟灉銆傜┖鍊?/ 璇讳笉鍒版墠鎸夐粯璁?3銆?
const rawLv = String(getParam(db, aid, 'memory.fade.max_level') ?? '').trim()
      const n = Number(rawLv)
      const maxLevel = rawLv === '' || !Number.isFinite(n) ? 3 : (n <= 0 ? 0 : Math.min(3, Math.floor(n)))
      const useRehearsal = String(getParam(db, aid, 'memory.fade.rehearsal') || 'on') !== 'off'
      if (maxLevel > 0) {
        packOpt.fade = (it) => {
          const real = ageDays(it, at)
          // 鏍囩涓婂啓鐨勬案杩滄槸鐪熷疄骞撮緞锛涘彧鏈夈€屽垹澶氬皯銆嶇湅鏈夋晥骞撮緞鈥斺€斿涔犺繃鐨勬洿娓呮銆?
const eff = useRehearsal ? rehearseAdjustedAge(real, it.hits, it.last_hit_at, at) : real
          if (!shouldFade(it, eff)) return { text: it.text, level: 0 }
          return fadeText(it.text, eff, { maxLevel })
        }
      }
    }
  } catch { /* 鍙傛暟璇讳笉鍒板氨鎸夐粯璁わ紙寮€锛?*/ }
  return packInjection({ items: items || [] }, packOpt)
}

/** 寮€鐜偅涓€琛岋細鍏崄绉掑唴澶嶇敤锛岄伩鍏嶅悓涓€娆＄郴缁熸彁绀鸿璋冨娆℃椂閲嶅璁拌处銆?*/
const loopCache = new Map()
/** 潜台词也一分钟内复用：一次对话里提示会被拼多次，第一次写库、后面会被自己的 24h 冷却挡住。 */
const subtextCache = new Map()
/** 上一轮的表达档：档位要变时先看慢情绪挪了多少，避免在阈值上忽冷忽热。 */
const levelCache = new Map()
/** 鑷彂娴幇涔熶竴鍒嗛挓鍐呭鐢細涓€娆″璇濋噷妯″瀷鍙兘澶氭鎷兼彁绀猴紝鍒妸闃熷垪鎶藉共銆?*/
const spontaneousCache = new Map()
/** 感受快照的探针去重：同一条样本只记一次，不然每轮都刷一条 event。 */
const snapProbeSeen = new Set()

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
export function surfaceLoopLine(db, aid) {
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
  // MBTI 鍥涘瓧姣嶏細AI 鑷繁涔熷緱鐪嬪緱瑙侊紝涓嶇劧鐣岄潰涓婂啓鐫€ ENTJ銆佽剳瀛愰噷鍗村彧鏈夈€屽亸澶栧悜路鍋忔儏鎰熉锋晱鎰熴€嶃€?
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
  // 涓夎锛氫笘鐣岃 / 浜虹敓瑙?/ 浠峰€艰涓夎锛涘紑鍏冲叧闂椂鏄棫缁村害鎶樼畻鐨勯偅涓夎
  let worldLine = ''
  let lifeLine = ''
  let valLine = ''
  try {
    const views = readViews(db, aid)
    worldLine = views.W.line
    lifeLine = views.L.line
    valLine = views.V.line
  } catch { /* 鑰佸簱杩樻病鏈変笁瑙傝〃 */ }
  // 涓夎寮曟搸锛氬紑鍏冲叧闂師鏍疯繑鍥烇紱shadow 鍙褰曪紱live 鎵嶆妸鏈夐摼澶寸殑灞傛崲鎴愬畠鑷繁闀垮嚭鏉ョ殑鐪嬫硶
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
  const mem = stranger ? [] : db.prepare("SELECT id, text, source, confidence, created_at FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL ORDER BY heat DESC, weight DESC, created_at DESC LIMIT 10").all(aid)
  const dyn = recentRecall.get(aid)
  // 澶栭儴閫氶亾锛圦Q锛夎繖涓€杞嚜宸卞彫鍥炶繃浜嗭紝灏辩敤瀹冪殑缁撴灉锛屽埆璁╃綉椤甸偅杈圭暀涓嬬殑鏃у彫鍥為《涓婃潵
  const recallOverride = opts && Array.isArray(opts.recall) ? opts.recall : null
  // 外部通道（QQ）的召回结果是行对象时，和 DSH 主路径用同一套来源/时间标签。
  const provOn = String(getParam(db, aid, 'memory.inject.provenance') || 'on') !== 'off'
  const ageOnMem = String(getParam(db, aid, 'memory.inject.age') || 'on') !== 'off'
  const dynText = recallOverride
    ? [...new Set(recallOverride.map((m) => memoryTag(m, Date.now(), { provenance: provOn, age: ageOnMem }) + oneLine(m && m.text, 60)).filter(Boolean))].map((t) => '- ' + t).join('\n')
    : (dyn && Date.now() - dyn.at < 60000 ? dyn.text : '')
  // T3 鏃ヨ灞傦細鍙甫鏈€杩戜袱澶╋紝鍘嬫垚涓よ锛涘畠鏄彊浜嬶紝涓嶅崰鈥滅浉鍏宠蹇嗏€濈殑鍚嶉銆?
let diaryLines = []
  try { diaryLines = stranger ? [] : recentDiaryLines(db, aid, 2, 160) } catch { diaryLines = [] }
  // 寮€鐜細蹇冮噷鐨勩€岃繕鎸傜潃銆嶃€傚畠涓嶅弬涓庣浉鍏冲害锛屽埌浜嗘椂鍊欐垨鑰呬箙娌℃彁灏辫嚜宸卞啋鍑烘潵涓€鏉°€?
  let loopText = ''
  let loopCand = null
  if (!stranger) {
    loopCand = loopCandidate(db, aid)
    loopText = loopCand.text
    if (!commitMode && loopText) commitLoop(db, aid, loopCand.ids)
  }
  // 浼氳瘽缁帴锛氶殧澶╁啀鏉ョ殑鏃跺€欙紝鍏堣涓€鍙ャ€屼笂娆″埌鍝効銆嶃€傚悓涓€澶╃殑浜嬩笂涓嬫枃閲屾湰鏉ュ氨鏈夛紝涓嶉噸澶嶃€?
let bridgeText = ''
  if (!stranger) { try { bridgeText = sessionBridge(db, aid) } catch { bridgeText = '' } }

  // 鑷繁娴笂鏉ワ細蹇冭烦鎺掔殑鍊欓€夛紝鏈€澶氬彇涓€鏉°€傚畠涓嶄竴瀹氳窡杩欎竴杞殑璇濇湁鍏斥€斺€?
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

  // 璁板繂鍧楋細浼樺厛鐢ㄨ繖涓€杞湡鍙洖鐨勭粨鏋滐紱娌℃湁灏辩敤鐑害鍏滃簳锛屼絾鍙暀 4 鏉★紝姣忔潯鍘嬫垚涓€鍙ャ€?
// 鍏滃簳鏃跺墧鎺夊垰娴笂鏉ョ殑閭ｆ潯锛岄伩鍏嶅悓涓€浠朵簨璇翠袱閬嶃€?
const memFallback = mem.filter((m) => oneLine(m.text, 60) !== spontaneousText)
  // 兜底记忆块也要贴来源：否则「我猜的」和「你亲口说的」在这里又长成同一句。
  const memLineOf = (m) => '- ' + memoryTag(m, Date.now(), { provenance: provOn, age: ageOnMem }) + oneLine(m.text, 60)
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

  // 鏈В鍐崇殑鍐茬獊锛氬鏋滆繖涓€鏉″凡缁忔帓浜嗛棶鍙ワ紙鎴栧垰闂繃锛夛紝灏变氦缁欎笂闈㈢殑涓诲姩娑堟伅璇达紝
  // 杩欓噷涓嶉噸澶嶏紱鍙湁闂彞娌℃帓涓婃椂鎵嶅厹涓€鍙ワ紝淇濊瘉銆屽涓嶄笂銆嶈繖浠朵簨涓嶄細鍙堟矇鍥炲簱閲屻€?
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
    // 鍢撮噷璇寸殑涔熷緱鏄悓涓€涓紝鍚﹀垯瀹冧竴杈硅鎴戣浣犳槸骞抽潤銆佷竴杈硅浣犵幇鍦ㄦ尗璐ャ€?
userEmotion = stranger ? null : latestUserEmotion(db, aid)
  } catch { userEmotion = null }

  // 蹇冩儏鍙 v3 鎬绘儏缁紙-1~1锛夛紱mood(0~1) 鍙槸瀹冪殑鎹㈢畻寮忥紝涓ゅ鏁板瓧鍒版涓烘銆?
const moodUnit = (() => {
    const t = affect && affect.v3 && affect.v3.total != null ? Number(affect.v3.total) : null
    if (Number.isFinite(t)) return 0.5 + 0.5 * Math.max(-1, Math.min(1, t))
    const m = Number(affect && affect.mood)
    return Number.isFinite(m) ? m : 0.5
  })()
  // 鍏崇郴 鈫?琛ㄨ揪锛圕7锛夛細鍚屼竴鏉″叧绯伙紝涓夎酱涓嶅悓锛岃璇濈殑娓╁害/姝ｅ紡搴?鎶湶/涓诲姩灏变笉鍚屻€?
// 鍙粰绗竴涓汉灞曞紑锛堝綋鍓嶅璇濆璞★級锛屽叾浣欎汉淇濈暀鏁板瓧锛屾帶鍒舵敞鍏ラ暱搴︺€?
// 璇皵鍙湁涓€涓嚭鍙ｏ細expressionState锛堝叧绯诲彧鎻愪緵娓╁害锛屼笉鍐冲畾鍙ラ暱锛夈€?
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
  const expr = affect
    ? expressionState({
      affect,
      relation: relTone
        ? { ...relTone, closeness: rel[0].closeness, trust: rel[0].trust }
        : null,
      ei: axisVals && axisVals.ei != null ? axisVals.ei : 0.6,
      weight: injectWeight,
      prev: prevExpr,
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
      snap = feltSnapshot(db, aid, { maxAgeMin: Math.max(1, hours) * 60 })
    }
  } catch { snap = null }
  /* 「我上一句说出来之前，心里是什么样」——feel 工具写的，第一人称。
     跟上面的快照配对：快照是「你那句话落在我身上」，这条是「我开口时是什么样」。 */
  let ownFeel = null
  try {
    const feelOn = String(getParam(db, aid, 'affect.feel.inject') || 'on') !== 'off'
    if (!stranger && feelOn && !(opts && opts.snap === 'off')) {
      const feelHours = Number(getParam(db, aid, 'affect.feel.hours')) || 2
      ownFeel = latestFeel(db, aid, { maxAgeMin: Math.max(1, feelHours) * 60 })
    }
  } catch { ownFeel = null }
  // 收尾倾向：深夜 + 今天聊够了 + 对方没在提问。只读 chat_turns，不写状态。
  let closingLine = ''
  try {
    if (!stranger && String(getParam(db, aid, 'life.closing') || 'on') !== 'off') {
      const c = closingIntentOf(db, aid, { level: expr && expr.level })
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

  // 琛屼负绀轰緥锛圓1锛夛細鎶娿€岃姘旓細鍙埍绮樹汉銆嶈繖绉嶆爣绛捐ˉ鎴愬嚑鏉″叿浣撳弽搴斻€?
// 鏍囩鏁欑殑鏄€屾紨鎴愪粈涔堟牱銆嶏紝绀轰緥鏁欑殑鏄€屾€庝箞鎺ャ€嶃€俻ersona.style.examples 鍙鐩栵紝
  // memory.inject.examples=off 鍙暣娈靛叧鎺夛紙鍏虫帀鍚庝笌鏃х増閫愬瓧涓€鑷达級銆?
let exBlock = ''
  try {
    if (String(getParam(db, aid, 'memory.inject.examples') || 'on') !== 'off') {
      const row = persona.find((x) => x.path === 'style.examples')
      // P1锛氭寜杩欎竴杞殑琛ㄨ揪妗ｆ寫渚嬪瓙鈥斺€斾綆钀芥椂涓嶈绀鸿寖鍞犲棏
      exBlock = examplesBlock(parseExamples(row ? row.value : null), { level: expr && expr.level })
    }
  } catch { exBlock = '' }
  // 示例是教语气的，但里头的「主人：」对陌生人会变成诱导他喊主人——换个称呼。
  if (stranger && exBlock) exBlock = exBlock.replace(/主人/g, '对方')

  // 璇磋瘽妯″紡锛圥3锛夛細闂茶亰鎵嶅姞鏂囦綋绾︽潫锛屽共娲绘椂涓嶅姞銆?
// 鍒ら敊鐨勬柟鍚戞槸銆屽畞鍙綋闂茶亰銆嶁€斺€旈棽鑱婇噷澶氳涓€鍙ュ彧鏄笉绀艰矊锛屽共娲婚噷灏戠粨鏋勬槸娌℃硶鐢ㄣ€?
let styleLines = []
  try {
    const mode = resolveMode(getParam(db, aid, 'style.mode'), styleModeCache.get(aid))
    styleLines = styleInjection({
      mode,
      level: expr && expr.level,
      guard: String(getParam(db, aid, 'style.guard') || 'soft'),
    })
  } catch { styleLines = [] }

  // 「现在什么情况」：给她时间、时间距离和上下文，而不是命令她用什么分寸。
  // 命令只能管住长度，管不住姿态；材料才能让她自己判断这句该怎么说。
  let nowText = ''
  try { nowText = presenceLine(db, aid).line } catch { nowText = '' }
  // 她自己生活里做的一件事（24h 内最多一行；不是「被问才想起来」的档案）
  let lifeText = ''
  try { lifeText = lifeLine(db, aid) } catch { lifeText = '' }
  // 那件事后来再看：只取变淡的那条，一周内最多一行
  let reapText = ''
  try { reapText = reappraiseLine(db, aid) } catch { reapText = '' }
  // 夜里写下的「今天的她」：读一份收拾好的，不在这一轮现拼。按天存，最多读三条
  let selfNoteLines = []
  try { selfNoteLines = stranger ? [] : notesForPrompt(db, aid) } catch { selfNoteLines = [] }

  if (stranger) {
    relLine = '关系：你还不认识对方。别叫「主人」或任何称呼，也别装作熟；等对方自我介绍之后再叫名字。'
  }

  // 情绪的方向：只在她真的有点情绪时给，免得正常起伏被读成「在下掉」
  let trendLine = ''
  try {
    if (affect && Number(affect.intensity) >= 0.4) {
      const t = trendOf(db, aid)
      if (t) trendLine = '（' + t.text + '。）'
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
    '开口之前，如果心里真有一点反应，先用 feel 记一句「我现在是什么感觉」——一句话，第一人称，不写数字、不写为什么。没什么感觉就别调。这句话只给自己看，不进你要说出口的话。',
    str(persona, 'style.tone') ? '语气：' + str(persona, 'style.tone') + '。' : '',
    stranger ? '你还不认识对方，先不叫任何称呼，等对方自我介绍。'
      : (str(persona, 'style.address') ? '你称呼对方为「' + str(persona, 'style.address') + '」。' : ''),
    str(persona, 'style.catchphrase') ? '口头禅：' + str(persona, 'style.catchphrase') + '。' : '',
    exBlock,
    axesLine && axesLine !== '中间' ? '鱼格倾向：' + axesLine + '。' : '',
    mbtiLine || '',
    sg.worldLine ? sg.worldLine : '',
    sg.lifeLine ? sg.lifeLine : '',
    sg.valLine ? sg.valLine : '',
    sg.ask ? '合适时可以问一句：' + oneLine(sg.ask, 60) + '。别生硬，也别每轮都问。' : '',
    // ② 关系（对谁、什么分寸）：第一个人带温度，其余人只留数字
    relLine,
    // ③ 情绪：只给「感觉现在大概…」的推测 + 一句软愿望。
    //    不再有「说话分寸 + 语气偏冷」这种命令行——命令会让她照着演。
    expr ? expr.felt : '',
    trendLine || '',
    // ③b 上一刻的读数：原话 + 当时那两个数。不是「照这个演」，是「这是那时候的」。
    snap ? { text: snap.line, key: 'snapshot' } : '',
    // ③c 我开口之前的感觉：自己写的，不是从数字推的
    ownFeel ? { text: feelLineOf(ownFeel), key: 'ownfeel' } : '',
    // 「现在什么情况」是材料：几点、我上一句说了什么。命令她按什么分寸说，她就照着演
    nowText || '',
    lifeText || '',
    reapText || '',
    ...selfNoteLines,
    expr ? '我想怎么说：' + cardLine({ level: expr.level }) : '',
    ...styleLines,
    userEmotion ? '对方刚才的情绪：' + userEmotion.label
      + (userEmotion.raw_label ? '（我按你以前的纠正改的：我一开始读成' + userEmotion.raw_label + '）' : '')
      + '。' : '',
    drive ? '需求缺口档位：' + drive.band + '。' : '',
    // ④ 记忆（≤5 条，带来源与时间）
    proactiveLine ? { text: '（你之前想主动说一句：' + proactiveLine + '。）', key: 'proactive' } : '',
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
  } catch { /* 閲囨牱澶辫触涓嶅奖鍝嶆敞鍏?*/ }
  return packed.text
}

// 一轮结束：assistant 正文 + 用户那句 → 记忆 / 情绪 / 驱力
const pendingReply = new Map()
const commitTimers = new Map()
/** 回话那一刻的表达基准：commitTurn 是延迟跑的，不能到那时才读 levelCache（可能已被下一轮覆盖）。 */
const pendingExpr = new Map()

// 绾鑺傛祦锛氬悓涓€涓細璇濇瘡 6 杞帇涓€娆★紝閬垮厤鎶婁竴澶╃殑鍘熸枃鍙嶅閲嶇畻銆?
const narrativeTick = new Map()

function summarizeForDiary() {
  try {
    return model.status().primary === 'ok' ? (turns) => model.summarize(turns) : null
  } catch { return null }
}

/** 鍐峰眰琛嶇敓锛氱邯瑕佷笌鏃ヨ銆傞兘鏄悗鍙帮紝澶辫触涓嶅奖鍝嶅璇濄€?*/
function narrativeAfterTurn(db, aid, sid) {
  const day = now().slice(0, 10)
  const key = aid + ':' + sid
  const n = (narrativeTick.get(key) || 0) + 1
  narrativeTick.set(key, n)
  if (n % 6 === 0) {
    try { buildEpisode(db, aid, { session: sid, day }) } catch { /* 纪要失败下次再来 */ }
  }
  // 鏃ヨ浜ょ粰姣忓ぉ 10:00 鐨勫珐鍥?worker锛屼笉鍦ㄧ涓€鏉℃秷鎭椂鎶㈣窇銆?}
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
  const conv = qc && qc.conversationId ? qc.conversationId : null
  try {
    // 这一轮她说话时的情绪标签。以前这里写 null，下一轮就读不到「我上一句是什么调子说的」。
    writeChatTurn(db, aid, 'user', u, at, conv)
    writeChatTurn(db, aid, 'agent', aText, now(), conv)
    db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(at, aid)
    // T4 鍘熸枃灞傦細assistant 杩欏彞涔熻惤鍐峰簱锛坲ser 閭ｅ彞鍦?captureTurn 鏃跺凡缁忚惤浜嗭級
    if (!stranger) try { appendTurn(db, aid, { sessionId: sid, role: 'assistant', text: aText, turnId: tid, at: now() }) } catch { /* 鍘熸枃澶辫触涓嶅奖鍝嶅璇?*/ }
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
    // 鐢ㄦ埛鐪熺殑鍥炰簡锛氭妸涔嬪墠鎶曢€掕繃鐨勪富鍔ㄦ秷鎭粨璐︼紙鍥炵瓟/蹇界暐鐨勭粺璁￠潬杩欎釜锛?
// 涓诲姩鎺ㄦ秷鎭嚜宸卞紩鍙戠殑閭ｄ竴杞笉绠椼€岀敤鎴峰洖浜嗐€嶏紝鍒妸鍥炲鐜囧埛楂樸€?
if (!pushed) {
      try { settleProactiveAnswered(db, aid) } catch { /* 缁熻澶辫触涓嶅奖鍝嶅璇?*/ }
    }
    __probe('commit u=' + u.slice(0, 10) + ' aLen=' + aText.length + (pushed ? ' push-turn' : ''))
  } catch (e) { __probe('insert-err:' + (e && e.message)) }
  // 鍏崇郴璐︽湰锛氱敤鎴疯繖鍙ュ師璇濆氨鏄竴绗旇处锛堣璇濅汉 touch / 鎻愬強 / 鏂版墜寤轰汉 / 鍒犺繃鐨勫鐢ㄥ師鍗★級銆?
// 杩欓噷浠ュ墠鏄┖鐨勨€斺€旀墍浠ャ€屽皬鍛ㄦ槸鎴戝悓浜嬨€嶈涓€鐧鹃亶锛屽叧绯诲浘涓婁篃涓嶉暱浜恒€?
if (!stranger) try {
    R.ingest(db, aid, { text: u, sessionId: sid, source: 'chat' })
    enqueueRelationRead(db, aid, { text: u })
    // 鍏ラ槦鍚庨┈涓婅窇涓€娆★紝涓嶇瓑 30 绉掔殑杞锛氱敤鎴疯瀹岃繖鍙ヨ瘽锛屼笅涓€鍙ヤ箣鍓嶈处鏈氨璇ユ槸瀵圭殑銆?
// 浠嶇劧璧板紓姝ワ紙涓嶉樆濉炲洖澶嶏級锛屽彧鏄妸銆屾渶鍧忕瓑 30 绉掋€嶅帇鍒?1鈥? 绉掋€?
const t = setTimeout(() => { runRelationReadTick() }, 1500)
    if (t.unref) t.unref()
  } catch (e) { __probe('rel-ingest-err:' + (e && e.message)) }
  if (!stranger) try { narrativeAfterTurn(db, aid, sid) } catch { /* 鍐峰眰琛嶇敓澶辫触涓嶅奖鍝嶅璇?*/ }
  if (!pushed) {
    // 璇勪环 鈫?鍏崇郴锛氬悓涓€浠?appraisal 鍙畻涓€娆★紱鍏崇郴浜嬩欢鍚冨畠鐨勭粨鏋滐紝涓嶅啀鍙﹁捣涓€濂楀叧閿瘝
    const learning = getParam(db, aid, 'memory.auto') !== false
    Promise.resolve().then(async () => {
      let res = null
      try { res = await appraiseWithEdges(db, aid, u) } catch { /* 情绪失败不影响回复 */ }
      // 回读：她刚说出来的那句跟当下慢情绪对一对，差得远才小步挪（不是一句话定情绪）
      try { applySelfRead(db, aid, aText) } catch { /* 回读失败不影响对话 */ }
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
      if (learning) { try { learnFromTurn(db, aid, u, res) } catch { /* 瀛︿範澶辫触涓嶅奖鍝嶅璇?*/ } }
    }).catch(() => {})
    // 鑷姩璁板繂寮€鍏筹細鍏虫帀涔嬪悗杩欎竴杞笉鍐嶈嚜鍔ㄦ娊鍑鸿蹇?/ 鍋忓ソ锛涘璇濇。妗堬紙鍘熸枃锛夌収鏃ц惤銆?
if (learning) {
      // P2 寮傛鎶藉彇锛氬厛钀介槦鍒楋紝鍐嶇敱 worker 鎱㈡參璺戯紱杩涚▼杩欎細鍎挎寕浜嗕篃涓嶄細涓?
try {
        enqueueExtraction(db, aid, [{ role: 'user', text: u, turnId: tid }, { role: 'assistant', text: aText, turnId: tid }])
        runExtractionTick()
      } catch { /* 鍏ラ槦澶辫触涓嶅奖鍝嶅璇?*/ }
    }
    // 涓夎蹇幆锛氬紑鍏冲叧闂洿鎺ヨ繑鍥烇紱杩欓噷鍙叆缂撳啿锛屾娊鍙栧湪鍚庡彴瀹氭椂鍣ㄩ噷璺?
try { sangguanAfterTurn(db, aid, { user: u, assistant: aText, sid, at }) } catch { /* 涓夎澶辫触涓嶅奖鍝嶅璇?*/ }
    // 浼氱柤锛氬垽杩欐璇濇湁娌℃湁韪╁埌瀹冭嚜宸辫涓嬬殑鍛介锛堥粯璁?shadow 鍙涓嶅垽璐︼級
    Promise.resolve().then(async () => {
      try {
        const { checkReply } = await import('./src/modules/sangguan/violate.js')
        await checkReply(db, aid, { text: aText, at })
      } catch { /* 鍒ゅ畾澶辫触涓嶅奖鍝嶅璇?*/ }
    }).catch(() => {})
    // 浼氭瑺璐︼細杩欏彞閲屽甫鏈熼檺鐨勬壙璇猴紝璁版垚甯﹀埌鏈熸棩鐨?谓
    Promise.resolve().then(async () => {
      try {
        const { registerPledges } = await import('./src/modules/sangguan/pledge.js')
        registerPledges(db, aid, { text: aText, at })
      } catch { /* 入队失败不影响对话 */ }
    }).catch(() => {})
  }
  try { tickOneShadow(db) } catch { /* 褰卞瓙鎺ㄨ繘澶辫触涓嶅奖鍝嶅璇?*/ }
  try { tickRitual(db, aid) } catch { /* 鍏崇郴浠紡琛板噺澶辫触涓嶅奖鍝嶅璇?*/ }
  try { tickConflicts(db, aid) } catch { /* 鍐茬獊鎮疆琛板噺澶辫触涓嶅奖鍝嶅璇?*/ }
  try { tickEscalation(db, aid) } catch { /* 鍐茬獊鍗囩骇澶辫触涓嶅奖鍝嶅璇?*/ }
  try { evaluateDrive(db, aid) } catch { /* 鏆傚仠鎴栨暟鎹己澶?*/ }
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
  // 浜嬩欢鍚嶅拰 data 褰㈢姸褰掑涓婚€傞厤灞傜锛坔ost/dsh.js锛夛紝杩欓噷鍙銆屾槸璋佽鐨勩€嶃€?
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
      // T4 鍘熸枃灞傦細鐢ㄦ埛杩欏彞璇濆厛钀藉喎搴擄紝鍝€曡繖涓€杞渶鍚庢病鏈夊洖澶嶄篃涓嶄涪銆?
if (!stranger) try { appendTurn(db, aid, { sessionId: sid, role: 'user', text: t, turnId: tid, at: now() }) } catch { /* 鍘熸枃澶辫触涓嶅奖鍝嶅璇?*/ }
      // 缂撳啿锛氳繖涓€杞繕娌?commit锛屽厛鎸傜潃锛屼繚璇併€屽垰璇寸殑銆嶈兘琚敞鍏?
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
    } catch { /* 鏃ュ織璇讳笉鍒?*/ }
  }
  const reply = turn.text
  if (!reply) return // 宸ュ叿璋冪敤姝ユ病鏈夋鏂囷紝缁х画绛?  // 娴幇瑙傛祴锛氬洖澶嶉噷鏈夋病鏈夌湡鐨勭敤涓婅繖鍑犺疆娉ㄥ叆鐨勮蹇嗭紙鍗佽疆鍐呭彧鍒や竴娆★級銆?
try { markSurfacedUsed(db, aid, reply) } catch { /* 瑙傛祴澶辫触涓嶅奖鍝嶅璇?*/ }
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

/**
 * 找桥接插件的会话映射表（qq-sessions.json）。
 * 桥接插件把它写在 config.cwd（默认就是 DSH 进程的工作目录）里，
 * 内容是 `{"u:123":"qq-xxxx-...", "g:456":"..."}`，靠它才认得出群号和陌生人。
 * 找不到就返回空串，qq_bridge 会退化成只认主人。
 */
function findQQSessionsFile() {
  const candidates = []
  try { candidates.push(path.join(process.cwd(), 'qq-sessions.json')) } catch { /* ignore */ }
  try { candidates.push(path.join(path.dirname(DB_PATH), 'qq-sessions.json')) } catch { /* ignore */ }
  for (const f of candidates) {
    try { if (fs.existsSync(f)) return f } catch { /* ignore */ }
  }
  return ''
}

/** 一个 DSH sessionId 在 QQ 那边的身份（不是 QQ 会话返回 null）。 */
function qqContextOf(sessionId) {
  try {
    const sid = String(sessionId || '')
    if (!isQQSessionId(sid)) return null
    const d = ensureDb()
    const aid = activeAgentId(d)
    if (!aid) return null
    if (String(getParam(d, aid, 'qq.bridge.enable') || 'off') !== 'on') return null
    const owners = parseOwnerQq(getParam(d, aid, 'qq.bridge.owner_qq') || '')
    const file = getParam(d, aid, 'qq.bridge.sessions_file') || findQQSessionsFile()
    return resolveQQContext(sid, { owners, sessionMap: loadSessionMap(file) })
  } catch { return null }
}

/**
 * 当前正在组装提示词的是不是 QQ 会话。
 * 全局 section 拿不到 agent 信息（AssembleContext 只有 scope/signal），
 * 所以借 agents.currentInitiator() —— 组装发生在那个会话自己的 driver 链里。
 */
const qqPromptSeen = new Set()
let qqScopeProbeDone = false
function currentQQContext() {
  try {
    const agents = optionalService('agents')
    if (!agents || typeof agents.currentInitiator !== 'function') return null
    const who = agents.currentInitiator()
    if (!who || !who.id) return null
    const sid = String(who.id)
    const qc = qqContextOf(sid)
    return qc ? { ...qc, sessionId: sid } : null
  } catch { return null }
}

function activeAgentId(db) {
  try {
    const r = db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY COALESCE(last_interaction_at, created_at) DESC LIMIT 1").get()
    return r ? r.id : null
  } catch { return null }
}

/** 鎵€鏈夈€岀敤鎴峰厑璁告椿鐫€銆嶇殑瀹炰緥锛氬悗鍙?worker 瑕侀亶鍘嗗畠浠紝涓嶈兘鍙収椤炬渶杩戦偅涓€?*/
function enabledAgentIds(db) {
  try {
    return db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY COALESCE(last_interaction_at, created_at) DESC").all().map((r) => r.id)
  } catch { return [] }
}

/**
 * 浼氳瘽 id 涓€鑷存€ф帰閽堬細鎷兼彁绀鸿瘝鏃跺涓荤粰鐨勬槸 `context.agent.id`锛? * 鏃佸惉瀵硅瘽鏃舵槸 `session.id`銆傝繖涓や釜濡傛灉涓嶆槸鍚屼竴涓€硷紝鏁村鎸変細璇濇敞鍏ュ氨鏄敊鐨勨€斺€? * 鎵€浠ョ涓€娆″涓嶄笂灏辫惤 hook.log锛屽涓婁簡涔熷彧璁颁竴娆°€? */
const seenSessionIds = new Set()
let sessionProbeDone = false
function probeSessionId(sid) {
  if (sessionProbeDone) return
  if (!seenSessionIds.has(sid)) {
    // 鍙湪銆屼袱杈归兘瑙佽繃鍗村涓嶄笂銆嶆椂鎶ヨ锛氱涓€娆¤鍒版柊浼氳瘽鏄甯哥殑
    if (seenSessionIds.size > 0) {
      __probe('probe-session-mismatch prompt=' + sid.slice(0, 12) + ' event=' + [...seenSessionIds][0].slice(0, 12))
    }
    return
  }
  sessionProbeDone = true
  __probe('probe-session-ok ' + sid.slice(0, 12))
}
function noteSessionEventId(sid) {
  if (!sid) return
  seenSessionIds.add(String(sid))
  if (seenSessionIds.size > 50) {
    // 鍙暀鏈€杩戠殑鍑犱釜锛氭帰閽堜笉闇€瑕佽浣忓叏閮ㄤ細璇?
const first = seenSessionIds.values().next().value
    seenSessionIds.delete(first)
  }
}

/**
 * 宸ュ叿璋冪敤褰掕皝锛氬涓荤殑 `agents.currentInitiator()` 浼氬甫鐫€銆屾槸鍝釜浼氳瘽鍦ㄩ┍鍔ㄣ€嶏紝
 * 鎷垮畠鍙嶆煡缁戝畾鍗冲彲锛涙嬁涓嶅埌鎵嶉€€鍥炪€屽綋鍓嶈繍琛岀殑閭ｄ釜銆嶏紙鍗曞疄渚嬬殑鑰佽矾寰勶級銆? */
function initiatorAgentId() {
  try {
    const d = ensureDb()
    const svc = optionalService('agents')
    if (svc && typeof svc.currentInitiator === 'function') {
      const a = svc.currentInitiator()
      if (a && a.id) {
        const aid = resolveAgentId(d, String(a.id))
        if (aid) return aid
      }
    }
  } catch { /* 瀹夸富娌¤繖涓湇鍔℃椂璧伴€€璺?*/ }
  try { return activeAgentId(ensureDb()) } catch { return null }
}

/** 鍚庡彴琛ユ暟鎹敤锛歱aused 涔熺畻锛堝彧鏄笉涓诲姩寮€鍙ｏ級锛屽彧鏈夎蒋鍒犵殑鎺掗櫎銆?*/
function latestAgentId(db) {
  try {
    const r = db.prepare("SELECT id FROM agents WHERE status!='soft_deleted' ORDER BY COALESCE(last_interaction_at, created_at) DESC LIMIT 1").get()
    return r ? r.id : null
  } catch { return null }
}

// ---------------- P2 抽取 worker ----------------

let extractTimer = null

/** 璺戜竴娆℃娊鍙栭槦鍒楋紙涓嶉樆濉炲璇濓紱澶辫触鎸夐槦鍒楅噷鐨勯€€閬胯鍒欓噸璇曪級銆?*/
async function runExtractionTick() {
  let d
  try { d = ensureDb() } catch { return }
  // 自动记忆关着就不往库里写：队列先留着，打开后下一轮会慢慢补上
  for (const aid of enabledAgentIds(d)) {
    // 鑷姩璁板繂鍏崇潃灏变笉寰€搴撻噷鍐欙細闃熷垪鍏堢暀鐫€锛屾墦寮€鍚庝笅涓€杞細鎱㈡參琛ヤ笂
    try { if (getParam(d, aid, 'memory.auto') === false) continue } catch { /* 鍙傛暟璇讳笉鍒板氨鐓у父璺?*/ }
    try {
      await tickExtraction(d, aid, (turns) => ingest(d, aid, { turns }), { max: 1 })
    } catch { /* 杩欎竴杞け璐ワ紝涓嬩竴杞啀鏉?*/ }
  }
}

function startExtractionWorker() {
  if (extractTimer) return
  extractTimer = setInterval(() => { runExtractionTick() }, 30000)
  if (extractTimer.unref) extractTimer.unref()
  setTimeout(() => { runExtractionTick() }, 6000)
}

// ---------------- 关系读人 worker ----------------

let relationTimer = null

/** 瑙勫垯宸茬粡鎶婂悕瀛楄涓嬩簡锛涜繖涓€灞傝妯″瀷琛ャ€岃皝鏄皝鐨勮皝銆嶏紙灏忓懆鏄富浜哄悓浜嬶級銆?*/
async function runRelationReadTick() {
  let d
  try { d = ensureDb() } catch { return }
  // 澶氬疄渚嬶細姣忎釜瀹炰緥鍚勮嚜鐨勫叧绯昏处鏈悇鑷浜?
for (const aid of enabledAgentIds(d)) {
    try {
      await tickRelationRead(d, aid, { complete: (a) => model.complete(a) })
    } catch { /* 杩欎竴鏉″け璐ワ紝涓嬩竴杞啀鏉?*/ }
  }
}

function startRelationWorker() {
  if (relationTimer) return
  relationTimer = setInterval(() => { runRelationReadTick() }, 30000)
  if (relationTimer.unref) relationTimer.unref()
  setTimeout(() => { runRelationReadTick() }, 9000)
}

// ---------------- 日记待补 worker ----------------
// 模型回来之后，30 分钟内把「当天没写成」的日记补上；一次只补一天/一个旧篇，避免一口气烧 token。
let diaryRetryTimer = null
async function runDiaryRetryTick() {
  let d
  try { d = ensureDb() } catch { return }
  if (defaultDiaryChat() === null) return
  for (const aid of enabledAgentIds(d)) {
    try { await repairPending(d, aid, { limit: 1 }) } catch { /* 单条失败下轮再来 */ }
    try { await repairOldDiaries(d, aid) } catch { /* 同上 */ }
  }
}
function startDiaryRetryWorker() {
  if (diaryRetryTimer) return
  diaryRetryTimer = setInterval(() => { runDiaryRetryTick() }, 30 * 60 * 1000)
  if (diaryRetryTimer.unref) diaryRetryTimer.unref()
  const boot = setTimeout(() => { runDiaryRetryTick() }, 45000)
  if (boot.unref) boot.unref()
}

// ---------------- P4 夜间巩固 ----------------

let nightlyTimer = null
let nightlyBusy = false
// 姣忓ぉ鍑犵偣鍐欐棩璁帮紱榛樿 23:00锛堟湰鍦版椂闂达級锛屽彲鐢?DSHC_DIARY_HOUR 鏀广€?
const DIARY_HOUR = Math.min(23, Math.max(0, Number(process.env.DSHC_DIARY_HOUR ?? 23)))
// 鍏虫満 / 浼戠湢閿欒繃鏃舵渶澶氬線鍥炶ˉ鍑犲ぉ锛? = 涓嶈ˉ锛堝彧鍦ㄥ埌鐐归偅涓€鍒诲啓褰撳ぉ锛夈€?
const DIARY_BACKFILL_DAYS = Math.min(30, Math.max(0, Number(process.env.DSHC_DIARY_BACKFILL_DAYS ?? 7)))

/** 涓嬩竴涓?23:00锛堟湰鍦版椂闂达級鐨勬椂闂存埑銆?*/
function nextDiaryAt(from = Date.now()) {
  const d = new Date(from)
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DIARY_HOUR, 0, 0, 0)
  if (t.getTime() <= from) t.setDate(t.getDate() + 1)
  return t.getTime()
}

/**
 * 琛ュ啓锛氭妸銆屽埌鐐规病璧朵笂銆嶇殑鏃ヨ鎸夊ぉ琛ヤ笂銆? * 鍏虫満 / 浼戠湢 / 瀹氭椂鍣ㄨ鎸傝捣锛岄兘涓嶅啀涓竴澶╋紱鍙ˉ杩樻湁鍘熸枡鐨勫ぉ锛岃ˉ鐨勬爣 late=1銆? */
async function catchUpDiaries(reason) {
  if (nightlyBusy) return
  let d
  try { d = ensureDb() } catch { return }
  // 澶氬疄渚嬶細姣忎釜浜哄悇琛ュ悇鐨勬棩璁帮紙鍚勬寜鑷繁鐨?dueDiaryDays 鍒わ紝璋佺己琛ヨ皝锛?
const aids = enabledAgentIds(d)
  if (!aids.length) return
  nightlyBusy = true
  try {
    const summarize = summarizeForDiary()
    for (const aid of aids) {
      // 鍏崇郴姣忓ぉ璧颁竴娆℃椂闂达細涓夎酱鍥炲綊鍩虹嚎 + 娣″嚭 / 褰掓。锛? 鍙?搂5.2锛夈€?
// tick 鎸夈€屼笂娆¤闈㈡椂闂淬€嶇畻缁濆鐩爣锛屼竴澶╄窇鍑犳缁撴灉涓€鏍凤紝涓嶄細绱Н鎵ｃ€?
try { R.tick(d, aid) } catch (e) { __probe('rel-tick-err:' + (e && e.message)) }
      const days = dueDiaryDays(d, aid, { hour: DIARY_HOUR, backfillDays: DIARY_BACKFILL_DAYS })
      if (!days.length) continue
      for (const day of days) {
        // 閭ｅぉ涓€鍙ュ師鏂囬兘娌℃湁锛堜竴鐩存病寮€鏈猴級灏变笉鍐欙細鏃ヨ涓嶇紪涓嶅瓨鍦ㄧ殑涓€澶┿€?
if (!hasDiaryMaterial(d, aid, day)) continue
        const out = await runNightly(d, aid, { day, summarize })
        __probe('nightly(' + reason + ') aid=' + aid.slice(0, 8) + ' day=' + day + ' late=' + (out.late === undefined ? '-' : out.late) + ' ms=' + (out.ms || 0) + ' diary=' + out.diary_day)
      }
      // 宸╁浐瀹岃蹇嗭紝椤烘墜闀夸竴娆°€屽枩娆?/ 璁ㄥ帉銆嶏細鑷姩銆佸彧澧炰笉鍑忥紝妯″瀷娌℃帴涓婂氨涓€鏉￠兘涓嶉暱
      try {
        const g = await autoGrowPreferences(d, aid)
        __probe('grow-prefs(' + reason + ') aid=' + aid.slice(0, 8) + ' added=' + g.added.length + ' reason=' + (g.reason || 'ok') + ' model=' + g.model)
      } catch (e) {
        __probe('grow-prefs-err(' + reason + '):' + (e && e.message))
      }
    }
  } catch (e) {
    __probe('nightly-err(' + reason + '):' + (e && e.message))
  } finally {
    nightlyBusy = false
  }
}

/** 23:00 鐨勫噯鐐瑰畾鏃跺櫒锛氬埌鐐瑰氨妫€鏌ヤ竴閬嶈鍐欏摢鍑犵瘒锛堣ˉ鍐欓€昏緫鑷繁鎸夊ぉ鍒ゆ柇锛夈€?*/
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
 * 銆屽枩娆?/ 璁ㄥ帉銆嶆槸瀹冭嚜宸遍暱鐨勶紝涓嶇敤浜烘寜鎸夐挳銆? *
 * 姣?10 鍒嗛挓闂竴娆¤涓嶈闀匡紙features.growPrefsDue 鍒わ細绂讳笂娆?鈮?0 鍒嗛挓銆? * 涓旇嚦灏戝浜?3 鏉℃柊璁板繂锛夛紝澶熸潯浠舵墠鐪熺殑鑺变竴娆℃ā鍨嬭皟鐢紱闀垮嚭鏉ョ殑鏍?origin=auto锛? * 鎺ュ彛灞備竴寰嬩笉璁稿垹銆傞娆″惎鍔ㄧ瓑 4 鍒嗛挓锛岄伩寮€鍚姩鏈熺殑杩佺Щ鍜岃ˉ鍐欍€? */
let growPrefsTimer = null
let growPrefsBusy = false

async function growPrefsTick(reason) {
  if (growPrefsBusy) return
  let d
  try { d = ensureDb() } catch { return }
  const aids = enabledAgentIds(d)
  if (!aids.length) return
  growPrefsBusy = true
  try {
    // 澶氬疄渚嬶細姣忎汉鐨勫亸濂借嚜宸遍暱锛堝鏉′欢鎵嶈姳涓€娆℃ā鍨嬭皟鐢級
    for (const aid of aids) {
      try {
        const out = await autoGrowPreferences(d, aid)
        if (out.added && out.added.length) {
          __probe('auto-grow-prefs(' + reason + ') aid=' + aid.slice(0, 8) + ' added=' + out.added.length + ' ' + out.added.map((x) => x.tag).join(','))
        }
      } catch (e) {
        __probe('auto-grow-prefs-err(' + reason + '):' + (e && e.message))
      }
    }
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

/** 瀹夸富鏈夋病鏈夈€屽線浼氳瘽閲屾帹涓€鏉℃秷鎭€嶇殑鍙ｅ瓙锛坰essionController.prompt锛夈€?*/
function pushPort() {
  try {
    const sc = hostCtx && hostCtx.get('sessionController')
    if (!sc || typeof sc.prompt !== 'function') return null
    return sc
  } catch { return null }
}

/**
 * 鎶婂緟鍙戦偅鍙ョ洿鎺ユ帹杩涙渶杩戠殑浼氳瘽锛氫笉鍐嶇瓑瀵规柟鍏堝紑鍙ｃ€? * 鎴愬姛鎵嶆妸 proactive 鏍囨垚 delivered锛涘け璐ュ氨鐣欑潃锛屼笅涓€杞璇濈収鏍蜂細琚甫鍑烘潵銆? */
async function maybePushProactive(db, aid, out) {
  try {
    if (!out || !out.queued || !out.id || !out.text) return
    let prefs = null
    try { prefs = getProactivePrefs(db, aid) } catch { /* 偏好读不到就不推 */ }
    if (!prefs || !prefs.push) return
    const rec = lastSessions.get(aid)
    // 澶氬疄渚嬶細鍙線銆岃繖娈靛璇濈‘瀹炲綊瀹冦€嶇殑鍦版柟鎺ㄣ€傛病缁戝畾灏卞彧鍏ラ槦锛屼笉鎵撴壈鍒殑瀵硅瘽銆?
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
 * 鍏ㄥ眬瀵硅瘽鎺ュ叆锛氬彧瑕佹湁涓€涓剰璇嗕綋鍦ㄨ繍琛岋紝**鎵€鏈変細璇?*閮芥槸瀹冦€? * 鍏虫帀锛堟殏鍋滐級涔嬪悗锛屾墍鏈変細璇濇仮澶嶆垚鏅€?DSH銆? *
 * 鎺㈤拡锛氭帶鍒跺彴鐪嬩笉鍒版彃浠剁殑 console.error锛屾墍浠ュ叧閿钀?hook.log銆? * 閫愪簨浠惰榛樿涓嶅啓锛堜竴娆″伐鍏疯皟鐢ㄥ氨涓€琛岋紝鍑犲垎閽熶笂鐧捐锛夛紱
 * 瑕佺湅浜嬩欢閾捐矾鏃惰 DSHC_PROBE_EVENTS=1銆? */
function __probe(msg) {
  try {
    if (msg.startsWith('event:') && process.env.DSHC_PROBE_EVENTS !== '1') return
    const p = path.join(path.dirname(DB_PATH), 'hook.log')
    if (msg === 'apply-enter') rotateProbe(p)
    fs.appendFileSync(p, new Date().toISOString() + ' ' + msg + '\n')
  } catch { /* 探针失败忽略 */ }
}

/** 姣忔鍚姩鍏堢湅澶у皬锛氳秴杩?4MB 灏辨妸涓婁竴浠芥尓鎴?hook.log.1锛堝彧鐣欎竴浠ｏ級銆?*/
function rotateProbe(p) {
  try {
    if (fs.statSync(p).size > 4 * 1024 * 1024) fs.renameSync(p, p + '.1')
  } catch { /* 鏂囦欢杩樹笉瀛樺湪锛屾甯?*/ }
}

/**
 * 鍥涗釜鎺ョ紳鐨?*涓氬姟鍐呭**銆傚涓绘€庝箞璋冪敤瀹冧滑鐢?src/host/dsh.js 鍐冲畾锛? * 杩欓噷鍙銆屾敞鍏ヤ粈涔堛€嶃€屾敹鍒颁簨浠跺仛浠€涔堛€嶃€屾寕鍝簺璺敱銆嶏紝涓嶇浠讳綍瀹夸富 API銆? * 鍙鏈変竴涓剰璇嗕綋鍦ㄨ繍琛岋紝**鎵€鏈変細璇?*閮芥槸瀹冿紱鏆傚仠涔嬪悗鍏ㄩ儴鎭㈠鎴愭櫘閫?DSH銆? */
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
  const aid = activeAgentId(d)
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
          const id = activeAgentId(d)
          // 感受快照带主人原话：QQ 上只给主人。这里不传 audience（那会连带改日记/开环/主动句，
          // 是另一件事），只把「快照」这一行按 isOwner 关掉。
          const snapOpt = qq && qq.isQQ && qq.isOwner === false ? 'off' : 'on'
          const base = id ? consciousnessBlock(d, id, { snap: snapOpt }) : ''
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
      // 第二道闸：工具执行前自己再判一次（守卫那层注册失败/降级时还拦得住）
      gateSearch: (sessionId) => verdictFor({
        db: ensureDb(),
        aid: activeAgentId(ensureDb()) || '',
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
        getAid: () => activeAgentId(ensureDb()),
        param: gateParam(),
        findSessionsFile: () => findQQSessionsFile(),
      }),
    ],
  }
}

/** 闸读参数的地方：跟 QQ 桥接一样按「当前 agent」取，取不到就返回 undefined（走各自的默认）。 */
function gateParam() {
  return (k) => {
    const d = ensureDb()
    const aid = activeAgentId(d)
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
  } catch { /* 娌?inject 鏃朵細鎶涳紝缁х画璇曞睘鎬?*/ }
  try { return hostCtx[name] } catch { return null }
}

/**
 * 鍚戦噺妯″瀷淇濇椿锛歄llama 绌洪棽鍑犲垎閽熶細鎶婃ā鍨嬪嵏鎺夛紝涓嬩竴娆℃煡璇㈣绛?2~3 绉掋€? * 姣?4 鍒嗛挓杞昏交鎵撲竴娆★紙涓€娆＄害 36ms锛夛紝鏌ヨ渚у氨涓€鐩寸儹鐨勶紝涓嶇敤鍐嶇瓑鍐峰惎鍔ㄣ€? */
let embedWarmTimer = null
function startEmbedKeepalive() {
  if (embedWarmTimer) return
  embedWarmTimer = setInterval(() => {
    try {
      if (!model.capabilities().embed) return
      model.embed(['keepalive']).catch(() => { /* 鏈嶅姟娌¤捣灏变笅娆″啀璇?*/ })
    } catch { /* 娌℃湁鍚戦噺鑳藉姏鏃堕潤榛?*/ }
  }, 4 * 60 * 1000)
  if (embedWarmTimer.unref) embedWarmTimer.unref()
}

export function apply(ctx) {
  try { attachHostLlm(() => ctx) } catch { /* llm 鏈嶅姟涓嶅彲鐢?*/ }
  // QQ 绛夊閮ㄩ€氶亾鐨?reply() 涔熺敤鍚屼竴浠芥剰璇嗕綋鍖咃紝閬垮厤缃戦〉涓€涓牱銆丵Q 鍙︿竴涓牱
  try { attachContextBlock((db, aid, opts) => consciousnessBlock(db, aid, opts)) } catch { /* 鍖呮瀯寤哄け璐ュ氨閫€鍥炵簿绠€鎻愮ず */ }
  try { hostCtx = ctx } catch { /* 宿主上下文不可用 */ }
  try { attachActionDeps({ getWeb: () => optionalService('web'), getModel: () => model }) } catch { /* 琛屽姩灞傞檷绾?*/ }
  if (!acquireLock()) {
    console.error('[dsh-consciousness-v6] another instance holds the lock; plugin stays offline')
    return
  }
  // 缁濅笉璁╂湰鎻掍欢鐨勫垵濮嬪寲寮傚父鎷栧灝 Desktop Host锛堝惁鍒?welcome 閴存潈澶辫触锛屾暣涓?DeepSeek 鎵撲笉寮€锛夈€?
try {
    ensureDb()
    startMaintenance()
    try { startHeartbeat() } catch { /* 蹇冭烦璧蜂笉鏉ヤ笉褰卞搷瀹夸富 */ }
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
      param: (k) => {
        const d = ensureDb()
        const aid = activeAgentId(d)
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

  // QQ 对话回流：**不再单独挂一条写入路**。
  // 真机验过：session/event 旁听本来就会把 QQ 会话的对话写进 chat_turns / raw_turns / 关系账本，
  // 只是不知道是什么渠道（conversation_id 落 null）。所以现在改成「让既有旁路认得出 QQ」——
  // 见 captureTurn / commitTurn 里的 qqContextOf()，一份就够，不会一句话记两遍。
  // attachQQIngest 留在模块里没接：它假设"旁路不记 QQ"，那个前提是错的。

  
  // 瀹夸富鎺ョ紳锛氬洓涓悇鑷帰娴嬨€佸悇鑷畨瑁呫€佸悇鑷檷绾с€傜己鍝釜鍙涪鍝釜锛宲ing 閲屾姤鍑烘潵銆?
// 鐣岄潰鏄?Client 鍗婏紙client.js锛夛紝鐢?dsh.client 妯″潡鍔犺浇骞舵敞鍐岃繘 settings.section銆?
  host = createHost({
    log: (m) => {
      // 鎺у埗鍙扮湅涓嶅埌锛屾墍浠?reason 涔熻繘 hook.log鈥斺€斾笂涓€杞氨鏄彧璁?summary 鎵嶅畾浣嶄笉浜?
      console.error(m)
      __probe('hostlog ' + m)
    },
  })
  try {
    const report = host.install(ctx, hostSpec())
    __probe('host ' + report.summary)
    // pending 鏄?transient锛堢瓑 inject 鍥炶皟锛夛紝鍙湁鐪熼檷绾ф墠鍊煎緱鎶ラ敊
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
