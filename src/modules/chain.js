/**
 * 链执行器（2026-11-23）
 *
 * 一句话：**块管「什么时候跑、跟谁抢」；链管「按什么顺序跑、带着什么一路走」。**
 *
 * ── 怎么用（一条链，从定义到跑完）────────────────────────────
 *
 * 1) 定义链——一串步骤，id 唯一，块号单调不减：
 *
 *    const MY_CHAIN = {
 *      id: 'my.chain',          // 链名：日志、防重入都用它
 *      block: 'chat',           // 默认块，只能写 chat / exp / night（别写数字，见下）
 *      onError: 'abort',        // 出错停（默认）；'continue' 则记下错误继续
 *      steps: [
 *        { id: 'prepare', kind: 'code', run: (ctx) => { ctx.x = 1 } },
 *        { id: 'ask', kind: 'local', block: 'chat', label: 'my:ask',
 *          request: (ctx) => ({ system: '…', text: '…', maxTokens: 200 }),
 *          run: (ctx, raw) => { ctx.answer = raw.text } },
 *        { id: 'save', kind: 'code', run: async (ctx) => { await ctx.save() } },
 *      ],
 *    }
 *
 * 2) 注入 runner——引擎自己不认识模型，本地/宿主都由调用方给：
 *
 *    const ctx = {
 *      key: turnId,             // 防重入：一轮一条链，同 key 同时只跑一份
 *      runner: {
 *        local: (req, meta) => localComplete(db, { ...req, block: meta.block, label: meta.label }),
 *        host:  (req, meta) => hostComplete(db, { ...req, block: meta.block, label: meta.label }),
 *      },
 *      ...业务字段（db/aid/turnId 之类，steps 各取所需）
 *    }
 *
 * 3) 跑——失败不抛，按 onError 停或继续；每步结果交给 onStep 记账：
 *
 *    const res = await runChain(MY_CHAIN, ctx, { onStep: (rec) => 记账(rec) })
 *    // res = { ok, chainId, key, ms, steps, stopped?, failedStep?, skipped? }
 *
 * ── 步骤纪律（照这个写，别绕）──────────────────────────────
 *
 * - `code` / `io`：不排队，直接跑；run 可以是 async。
 * - `local` / `host`：必须有 `label` 和 `request`；request 返回 null 表示「这步没东西可做」，
 *   记为 skipped 继续下一步（不是错误）。
 * - 模型步的 `run(ctx, raw)` 只做「解析返回 + 写 ctx」；raw 的形状由 runner 决定
 *   （生产里 localComplete 给 { text }，别的 runner 可能给字符串——调用方自己约定，解析函数要兼容）。
 * - run 返回 `{ stop: true }` = 正常提前收工（比如单句不切、提件空）。不是错误，不触发 onError。
 * - `when(ctx)` 为假：跳过这步继续。适合「有漏句才补判」这种。
 * - `optional: true`：增强型步骤（比如接续）。它失败**不中断链**、不算硬失败：记一条 degraded，
 *   后续步骤靠 `when` 判断前置是否可用（例如塌看 ctx.linksReady），别硬吃半截数据。
 * - 块号只能同块或往上（B1→B1→B3 行；B3→B1 不行），加载时校验，违反直接拒绝。
 * - 引擎不写库（记账走 onStep）、不 import 模型（换本地/宿主只换 runner）。
 *
 * ── 为什么块名不许写数字 ───────────────────────────────────
 * 老代码的 priority 数字（1/2 聊天、3 实验、5/6/7 夜间）和 BLOCK 常量（chat=1/exp=2/night=3）
 * 语义撞车：数字 3 在老语境是「实验」，在新块是「夜间」。所以链定义里只认块名字符串，
 * 写数字直接报错，别留一个跑起来才知道的坑。
 *
 * 设计：docs/功能/8-工程-门禁与文档/设计-链与块-2026-11-23.md
 */
import { blockOf } from './queue_policy.js'

export const STEP_KIND = Object.freeze({
  code: 'code',   // 纯代码：不排队，直接跑
  io: 'io',       // 写事件/发消息：不排队
  local: 'local', // 本地模型：进本地队列，按 block 排
  host: 'host',   // 宿主模型：进宿主队列，按 block 排
})
const KINDS = new Set(Object.values(STEP_KIND))
const BLOCK_NAMES = new Set(['chat', 'exp', 'night'])

// 同一 chain.id + key 同时只跑一份（重载后重放、调用方重试都靠它挡）
const running = new Set()
let anonSeq = 0

// 链定义里的块：只认名字，不认数字（见头部注释「为什么块名不许写数字」）。
function chainBlock(value, where) {
  if (value == null) return 'chat'
  if (typeof value !== 'string' || !BLOCK_NAMES.has(value)) {
    throw Object.assign(new Error(`chain.invalid: ${where} 的块只能是 chat / exp / night，收到：${String(value)}`), { code: 'chain.invalid' })
  }
  return value
}

/** 加载时校验一次，写错直接拒绝，别等运行时乱序。 */
export function validateChain(chain) {
  const err = (m) => {
    const e = new Error('chain.invalid: ' + m)
    e.code = 'chain.invalid'
    throw e
  }
  if (!chain || typeof chain !== 'object') err('chain 不是对象')
  if (!chain.id || typeof chain.id !== 'string') err('缺 id')
  if (!Array.isArray(chain.steps) || chain.steps.length === 0) err('steps 为空')
  if (chain.onError && chain.onError !== 'abort' && chain.onError !== 'continue') err('onError 只能是 abort/continue')

  chainBlock(chain.block, '链 ' + chain.id)
  const seen = new Set()
  let prevBlock = blockOf(chain.block || 'chat')
  for (let i = 0; i < chain.steps.length; i++) {
    const s = chain.steps[i]
    if (!s || typeof s !== 'object') err(`第 ${i + 1} 步不是对象`)
    if (!s.id || typeof s.id !== 'string') err(`第 ${i + 1} 步缺 id`)
    if (seen.has(s.id)) err(`第 ${i + 1} 步 id 重复：${s.id}`)
    seen.add(s.id)
    if (!KINDS.has(s.kind)) err(`第 ${i + 1} 步 kind 非法：${s.kind}`)
    if (typeof s.run !== 'function') err(`第 ${i + 1} 步缺 run`)
    if (s.when != null && typeof s.when !== 'function') err(`第 ${i + 1} 步 when 必须是函数`)
    if (s.optional != null && typeof s.optional !== 'boolean') err(`第 ${i + 1} 步 optional 必须是布尔`)
    if (s.kind === STEP_KIND.local || s.kind === STEP_KIND.host) {
      if (!s.label) err(`第 ${i + 1} 步缺 label`)
      if (typeof s.request !== 'function') err(`第 ${i + 1} 步缺 request`)
    }
    if (s.block != null) chainBlock(s.block, `第 ${i + 1} 步`)
    const b = blockOf(s.block != null ? s.block : (chain.block || 'chat'))
    if (b < prevBlock) err(`第 ${i + 1} 步块号递减：${b} < ${prevBlock}`)
    prevBlock = b
  }
  return true
}

/**
 * 顺序跑一条链（语义见文件头「怎么用」）。
 *
 * @param {object} chain 已定义好的链（每次运行都会校验一遍，成本可忽略）
 * @param {object} ctx   { key, runner:{local,host}, ...业务字段 }
 * @param {object} opts  { onStep(rec) } 每步回调（记账用；rec 含 id/kind/block/ms/ok/skipped/stop/err）
 * @returns {Promise<{ok:boolean, chainId:string, key:string, ms:number, steps:Array,
 *                    stopped?:boolean, failedStep?:string, skipped?:string}>}
 */
export async function runChain(chain, ctx, opts = {}) {
  validateChain(chain)
  // 没给 key 就自动分配：不同的匿名链不互相挡；同 key 才挡。
  const key = String(ctx && ctx.key != null ? ctx.key : '#' + (++anonSeq))
  const runKey = chain.id + ':' + key
  if (running.has(runKey)) {
    return { ok: false, skipped: 'running', chainId: chain.id, key, ms: 0, steps: [] }
  }
  running.add(runKey)

  // 2026-11-23：账。每次执行一个 runId，每步一个 seq。
  // 引擎只负责把每步的输入/输出打包成字符串交给 onStep，**自己不碰 db**——
  // 写不写库、写哪张表由调用方决定（frame 那两条链现在不写，行为不变）。
  const runId = String(opts.runId || ('run_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 6)))
  const INOUT_MAX = 8192
  const pack = (v) => {
    if (v === undefined) return { json: null, truncated: 0 }
    let s
    try { s = JSON.stringify(v) } catch { return { json: null, truncated: 1 } }
    if (s == null) return { json: null, truncated: 0 }
    if (s.length > INOUT_MAX) return { json: s.slice(0, INOUT_MAX), truncated: 1 }
    return { json: s, truncated: 0 }
  }

  const t0 = Date.now()
  const steps = []
  let seq = -1
  let stopped = false
  let failed = false
  let failedStep = null
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : null
  const report = (rec) => {
    if (!onStep) return
    try { onStep(rec) } catch { /* 记账失败不影响链 */ }
  }

  try {
    for (const step of chain.steps) {
      const block = blockOf(step.block != null ? step.block : (chain.block || 'chat'))
      seq++
      const base = { id: step.id, kind: step.kind, block, runId, seq }
      const st0 = Date.now()
      // 这一步吃的东西：在调模型之前就算、就打包——模型没回来，账上也留着它的输入。
      let inPack = { json: null, truncated: 0 }
      try {
        if (typeof step.input === 'function') inPack = pack(step.input(ctx))
      } catch { /* 算输入失败不影响链，账上空着 */ }

      try {
        if (typeof step.when === 'function' && !step.when(ctx)) {
          const rec = { ...base, ok: true, skipped: true, ms: 0, inJson: inPack.json, outJson: null, truncated: inPack.truncated }
          steps.push(rec); report(rec)
          continue
        }

        let res
        if (step.kind === STEP_KIND.code || step.kind === STEP_KIND.io) {
          res = await step.run(ctx)
        } else {
          const req = step.request(ctx)
          if (req == null) {
            const rec = { ...base, ok: true, skipped: true, ms: 0, inJson: inPack.json, outJson: null, truncated: inPack.truncated }
            steps.push(rec); report(rec)
            continue
          }
          const runner = ctx && ctx.runner && ctx.runner[step.kind]
          if (typeof runner !== 'function') throw new Error('没注入 runner.' + step.kind)
          const raw = await runner(req, { block, label: step.label, chain: chain.id, step: step.id })
          res = await step.run(ctx, raw)
        }
        // 后一步能拿到前一步的产出：放 ctx.steps[stepId] 子命名空间。
        // 2026-11-23 踩过：直接 ctx[step.id] = res 会覆盖业务字段（链里有步叫 assign，
        // 而 ctx.assign 本来是分组数据，被覆盖后补判拿不到分组）。
        if (res !== undefined) { if (!ctx.steps) ctx.steps = {}; ctx.steps[step.id] = res }
        const outPack = pack(res)

        if (res && res.stop) {
          const rec = { ...base, ok: true, stop: true, ms: Date.now() - st0, inJson: inPack.json, outJson: outPack.json, truncated: inPack.truncated | outPack.truncated }
          steps.push(rec); report(rec)
          stopped = true
          break
        }
        const rec = { ...base, ok: true, ms: Date.now() - st0, inJson: inPack.json, outJson: outPack.json, truncated: inPack.truncated | outPack.truncated }
        steps.push(rec); report(rec)
      } catch (e) {
        const optional = step.optional === true
        const rec = { ...base, ok: false, optional, degraded: optional, err: String((e && e.message) || e), ms: Date.now() - st0, inJson: inPack.json, outJson: null, truncated: inPack.truncated, status: 'err' }
        steps.push(rec); report(rec)
        if (!optional) { failed = true; failedStep = step.id }
        if ((chain.onError || 'abort') === 'abort' && !optional) break
      }
    }
    return { ok: !failed, runId, chainId: chain.id, key, ms: Date.now() - t0, steps, stopped, failedStep }
  } finally {
    running.delete(runKey)
  }
}

/** 体检/测试用：现在有哪些链在跑。 */
export function runningChains() { return [...running] }

/** 测试用：清掉防重入记录（正常代码不要调）。 */
export function __resetRunning() { running.clear() }
