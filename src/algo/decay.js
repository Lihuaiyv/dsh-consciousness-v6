/**
 * 记忆可提取性 / 衰减：decay@v1（现行 FSRS-lite R）与 decay@v1b（对照）
 * 输入：{ row } 或 { last_decay_at, stability, now? }
 * 输出：{ R, age_days, stability }
 */

function ageDays(lastDecayAt, nowMs) {
  const t = Date.parse(lastDecayAt)
  return Number.isFinite(t) ? Math.max(0, (nowMs - t) / 86400000) : 0
}

function makeDecay(version, scale) {
  return {
    name: 'decay',
    version,
    kind: 'decay',
    metrics: ['memory.forget_fit', 'sys.algo_switch'],
    run(_ctx, input = {}) {
      const row = input.row || input
      const nowMs = input.now != null ? Number(input.now) : Date.now()
      const age = ageDays(row.last_decay_at, nowMs)
      const s = Math.max(0.1, Number(row.stability || 1))
      // input.scale 是「时间倍数」：越小于 1 忘得越快（memory.decay.lambda 越大 → 倍数越小）。
      // 只作用在可提取性 R 的斜率上，不改档位、不改写入。
      const mul = Number(input.scale)
      const k = scale * (Number.isFinite(mul) && mul > 0 ? Math.max(0.1, Math.min(10, mul)) : 1)
      // R(t) = (1 + t / (9·S·k))^(-1)；v1b 略加快遗忘以证明可切换
      const R = 1 / (1 + age / (9 * s * k))
      return {
        R: Math.round(R * 10000) / 10000,
        age_days: Math.round(age * 1000) / 1000,
        stability: s,
        algo: { name: 'decay', version },
      }
    },
  }
}

/** 现行：scale=1，对齐原 recall 内嵌 retrievability */
export const decayV1 = makeDecay('v1', 1)

/** 对照：scale=0.7 → 同等年龄下 R 更低 */
export const decayV1b = makeDecay('v1b', 0.7)
