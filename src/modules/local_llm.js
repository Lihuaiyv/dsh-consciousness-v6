/**
 * 本地 Ollama 适配（兼容层）。真正的通道在 `local_gateway.js`。
 *
 * ⚠️ 2026-11-22 主人钉的规矩：**参数不许改！**（url / model / num_ctx / num_gpu / keep_alive / exe / home / models）
 *   改一次 ollama 就当成换了份模型：先卸再载（40 秒起），还会把已经全放进显卡的那份顶回 CPU。
 *   现在这些参数写死在 `local_gateway.js` 的 GATEWAY 里，这里连读 flag 的口子都不留。
 *
 * 为什么这个文件还在：老调用方都 import 这里的名字（localComplete / localQueueInfo / localBegin…）。
 * 全部转成对网关的薄封装，行为统一成一条队列，谁也不许绕过去直连 11434。
 */
import * as gw from './local_gateway.js'
import { getFlag } from '../kernel.js'

/** 切事走本地模型的开关（这是开关，不是模型参数，还留着）。 */
export function localCutOn(db) {
  try {
    return String(getFlag(db, 'memory.cut.work.local') || '').trim() === '1'
  } catch { return false }
}

/** daily 主模型失败时用本地兜底：默认 off，线上设 memory.cut.daily.local_fallback=1。 */
export function localDailyFallbackOn(db) {
  try {
    return String(getFlag(db, 'memory.cut.daily.local_fallback') || '').trim() === '1'
  } catch { return false }
}

/** 本地通道配置：写死，只读。想改去 local_gateway.js 改，并跟主人申请。 */
export function localCutConfig(_db) {
  return { url: gw.GATEWAY.url, model: gw.GATEWAY.chat.model }
}

export function localServerConfig(_db) {
  return gw.serverConfig()
}

export async function localAvailable(_db, timeoutMs = 3000) {
  return gw.gatewayPing(timeoutMs)
}

export async function ensureLocalServer(_db, opts = {}) {
  return gw.ensureServer(opts)
}

export async function warmLocalModels(db) {
  return gw.warmResident(db)
}

export function localNumCtx(_db) {
  return gw.GATEWAY.chat.numCtx
}

/** 优先级（数字小先跑）：1 聊天 / 2 向量 / 3 实验 / 5 切事 / 6 普通 / 7 批量兜底。对话 > 实验 > 事后整理。 */
export const LOCAL_PRIORITY = gw.PRIORITY

/** 排队执行一个本地任务（老名字，转发到网关）。 */
export function scheduleLocalTask(db, opts = {}) {
  return gw.enqueue(db, {
    lane: opts.lane || 'normal',
    label: opts.label || '',
    priority: Number.isFinite(Number(opts.priority)) ? Number(opts.priority) : gw.PRIORITY.normal,
    timeoutMs: opts.timeoutMs,
    run: opts.run,
  })
}

/* 切事据此让路：看模型真的在被用，不是猜人可能在等。 */
export function localBusy() { return gw.gatewayBusy() }
export function localBegin() { gw.localBegin() }
export function localEnd() { gw.localEnd() }
export function localPending() { return gw.gatewayPending() }

/** 队列快照（local_llm_status 工具用）。同步：不 ping 服务，只报队列。 */
export function localQueueInfo(_db) {
  return gw.quickStatus()
}

/**
 * 对外入口：所有本地模型调用都从这儿过。
 * 注意 `req.model` 现在**会被忽略**——通道只认常驻的 14B。实验请用 gatewayExperiment（/local/exp）。
 */
export async function localComplete(db, req = {}) {
  const priority = Number.isFinite(Number(req.priority)) ? Number(req.priority) : gw.PRIORITY.normal
  // 2026-11-22 三块排队：block 必须一路透传，不许在这里丢掉
  return gw.gatewayChat(db, { ...req, priority, block: req.block })
}
