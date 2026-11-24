/**
 * 情绪链的账（2026-11-23）。
 *
 * 干什么：把 `appraiseTurnNow` 里每一段（读上一轮 / 事层 / 判断层 / 位置 / 挑词 / 落表）的
 * 输入和输出落到 `chain_steps`，整条链落到 `chain_runs`。这样「这一轮数据怎么变的」能按 seq 讲出来。
 *
 * 为什么不是 runChain：`appraiseTurnNow` 一千多行，一次拆成六节风险太大。
 * 这一版**不改控制流**（还是原来的 await 顺序），只加账；账跑稳之后再把控制流换到 runChain，
 * 那时账的字段不用动，只是由引擎来写。
 *
 * 铁律：
 *   - 账写失败绝不影响情绪链（全部 try/catch）。
 *   - in / out 只收纯数据，能 JSON 化；超 8KB 截断并标 truncated。
 *   - 开关 `affect.chain.record`（默认 on）；off 时整条不记账，行为与记账前完全一致。
 */
import { getFlag } from '../kernel.js'

const INOUT_MAX = 8192

function pack(v) {
  if (v === undefined) return { json: null, truncated: 0 }
  let s
  try { s = JSON.stringify(v) } catch { return { json: null, truncated: 1 } }
  if (s == null) return { json: null, truncated: 0 }
  if (s.length > INOUT_MAX) return { json: s.slice(0, INOUT_MAX), truncated: 1 }
  return { json: s, truncated: 0 }
}

function on(db) {
  try { return String(getFlag(db, 'affect.chain.record') || 'on') !== 'off' } catch { return true }
}

/** 开一条链的账。返回 runId；关着或失败返回 null（调用方不用管）。 */
export function beginRun(db, { aid = null, cid = null, turnId = null, chainId = 'affect.turn' } = {}) {
  if (!on(db)) return null
  try {
    const id = 'run_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 6)
    db.prepare(
      'INSERT INTO chain_runs(id, chain_id, agent_id, conversation_id, turn_id, key, started_at, ok) VALUES(?,?,?,?,?,?,?,NULL)'
    ).run(id, String(chainId), aid ?? null, cid ? String(cid) : null, turnId ? String(turnId) : null, turnId ? String(turnId) : null, new Date().toISOString())
    return id
  } catch { return null }
}

/** 记一步。seq 由调用方递增（0 起）。返回下一个 seq，方便链式写。 */
export function step(db, runId, seq, { id, kind = 'code', block = 1, label = '', input, output, ms = 0, status = 'ok', err = '' } = {}) {
  const next = seq + 1
  if (!runId) return next
  try {
    const pin = pack(input)
    const pout = pack(output)
    const sid = 'step_' + String(runId).slice(4) + '_' + seq
    db.prepare(
      'INSERT INTO chain_steps(id, run_id, seq, step_id, kind, block, label, in_json, out_json, truncated, ms, status, err) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      sid, runId, seq, String(id), String(kind), Number(block) || 1, label ? String(label).slice(0, 40) : null,
      pin.json, pout.json, (pin.truncated | pout.truncated) ? 1 : 0,
      Math.max(0, Number(ms) || 0), String(status || 'ok'), err ? String(err).slice(0, 300) : null
    )
  } catch { /* 账失败不影响链 */ }
  return next
}

/** 收尾：回填 run 行。 */
export function endRun(db, runId, { ok = true, failedStep = null, ms = 0 } = {}) {
  if (!runId) return
  try {
    db.prepare('UPDATE chain_runs SET ended_at=?, ok=?, failed_step=?, ms=? WHERE id=?')
      .run(new Date().toISOString(), ok ? 1 : 0, failedStep ? String(failedStep) : null, Math.max(0, Number(ms) || 0), runId)
  } catch { /* 账失败不影响链 */ }
}

/** 只读：取一条链的全部步骤（给诊断脚本/面板用）。 */
export function readRun(db, runId) {
  try {
    const run = db.prepare('SELECT * FROM chain_runs WHERE id=?').get(runId)
    if (!run) return null
    const steps = db.prepare('SELECT * FROM chain_steps WHERE run_id=? ORDER BY seq ASC').all(runId)
    return { run, steps }
  } catch { return null }
}

/**
 * 单步重放（2026-11-23）：拿一条历史步骤的 in_json，重跑那一节。
 *
 * 引擎只干两件事：把当时的输入读出来、把这次的结果记成一行新账（seq + 1000，标 `:replay`）。
 * **跑什么由调用方给**——不然这里要 import JUDGE_SYS/TOPIC_SYS，跟 affect_v4_shadow 循环依赖。
 * 重放**不改任何业务表**：只出账，不落 frames/state/affairs。
 *
 * @param run (inObj) => Promise<any>  用存档输入重跑这一步，返回这一节的产出
 * @returns { ok, reason?, runId, stepId, ms, out, err }
 */
export async function replayStep(db, { runId, stepId, run } = {}) {
  let src = null
  try {
    src = db.prepare('SELECT * FROM chain_steps WHERE run_id=? AND step_id=? AND seq < 1000 ORDER BY seq ASC LIMIT 1').get(runId, stepId)
  } catch { return { ok: false, reason: 'no-db' } }
  if (!src) return { ok: false, reason: 'no-step' }
  if (Number(src.truncated)) return { ok: false, reason: 'truncated-input', runId, stepId }
  if (typeof run !== 'function') return { ok: false, reason: 'no-runner', runId, stepId }
  let inObj = {}
  try { inObj = src.in_json ? JSON.parse(src.in_json) : {} } catch { return { ok: false, reason: 'bad-in-json', runId, stepId } }

  const t0 = Date.now()
  let out = null
  let err = ''
  try { out = await run(inObj) } catch (e) { err = String((e && e.message) || e) }
  const ms = Date.now() - t0
  const seq = Number(src.seq) + 1000
  try {
    const pout = pack(out)
    db.prepare(
      'INSERT OR REPLACE INTO chain_steps(id, run_id, seq, step_id, kind, block, label, in_json, out_json, truncated, ms, status, err) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      'step_' + String(runId).slice(4) + '_r' + seq, runId, seq, src.step_id, src.kind, src.block,
      (src.label ? src.label + ':replay' : 'replay'), src.in_json, pout.json, pout.truncated ? 1 : 0,
      ms, err ? 'err' : 'ok', err ? err.slice(0, 300) : null
    )
  } catch { /* 账失败不影响*/ }
  return { ok: !err, runId, stepId, ms, out, err }
}
