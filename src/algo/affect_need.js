/**
 * 情绪 → 驱力耦合（E→N）。
 *
 * 为什么不直接用「情绪好不好」去推五维：
 *   1. 情绪是分钟级的，驱力是天级的。一条消息的情绪直接把「探索」打下去，
 *      等于用一次心跳改一周的基线——需要用事件闸门和步幅封顶把它关进小盒子。
 *   2. 情绪的效价太粗。同样是「不好」，挫败指向胜任、烦躁指向自主、
 *      困惑指向探索。按效价一刀切，五个维度会同时抖，等于没信息。
 *
 * 所以只借 appraisal（评价）的两个量：
 *   goal_relevance（这件事对我重不重要）→ 决定幅度
 *   label（是什么情绪）                  → 决定是哪一维
 * 效价只用来判正负号，不做「全维同涨同落」。
 *
 * 依据：情绪的 appraisal 理论（OCC / Scherer）——情绪是「目标相关性 × 目标一致性」
 * 的函数；目标就是需求，所以情绪天然是「某条需求刚刚被满足/被挡住」的即时读数。
 *
 * 约束（三条硬线）：
 *   - 只在情绪事件过闸（affect_events.gate=1）时才用，单条消息不算事件（doc 7）；
 *   - 单次每维 ≤ 0.02，一天每维累计 ≤ 0.06；
 *   - 只能经 applySatisfaction 记账（INV5：非自修改），留 drive.affect.coupled 事件。
 */

/** 八类情绪 → 五维。正号=这条需求被满足，负号=被挡住。 */
export const AFFECT_NEED = {
  joy: { C: +1.0, R: +0.6 },
  peaceful: { S: +1.0, R: +0.3 },
  calm: { S: +0.7 },
  curious: { E: +1.0 },
  confused: { E: -0.8, S: -0.2 },
  lost: { E: -0.9, S: -0.5 },
  irritated: { A: -0.7, C: -0.5 },
  frustrated: { C: -1.0, A: -0.3 },
}

/** 一句话解释这张表在说什么（技术视图直接显示） */
export const AFFECT_NEED_WHY = {
  joy: '高兴 → 关系与胜任刚刚被喂过',
  peaceful: '安宁 → 安全被喂过',
  calm: '平静 → 安全被喂过',
  curious: '好奇 → 探索被唤起（不是被满足，是缺口在拉）',
  confused: '困惑 → 认知上有缺口，探索没被满足',
  lost: '迷失 → 认知缺口 + 不确定，探索与安全同时掉',
  irritated: '烦躁 → 被安排/被限制，自主与胜任掉',
  frustrated: '挫败 → 事没做成，胜任掉',
}

/** 单次每维最多动多少 */
export const E2N_STEP = 0.02
/** 低于这个强度不当作信号（情绪噪声很多） */
export const E2N_MIN_INTENSITY = 0.25
/** 一天每维累计上限 */
export const E2N_DAY_CAP = 0.06

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0))
const DIMS = ['R', 'E', 'C', 'A', 'S']

/**
 * 纯函数：一条情绪事件 → 五维的满足度增量。
 * @param {{label:string,intensity?:number,rel?:number,arousal?:number}} ev
 * @returns {{ deltas: Record<string,number>, gain:number, why:string }}
 */
export function affectNeedDeltas(ev = {}) {
  const label = String(ev.label || '').toLowerCase()
  const table = AFFECT_NEED[label]
  const intensity = clamp(ev.intensity, 0, 1)
  if (!table || intensity < E2N_MIN_INTENSITY) {
    return { deltas: {}, gain: 0, why: table ? '强度 ' + intensity.toFixed(2) + ' 太低，不算信号' : '这类情绪没有对应的需求' }
  }
  // 目标相关性放大，唤醒再抬一点：同样强度的「烦」，很在意的和很吵的会有一点点差别
  const rel = clamp(ev.rel, 0, 1)
  const arousal = clamp(ev.arousal, -1, 1)
  const gain = intensity * (0.35 + 0.65 * rel) * (1 + 0.25 * Math.max(0, arousal))
  const deltas = {}
  for (const [dim, sign] of Object.entries(table)) {
    if (!DIMS.includes(dim)) continue
    const d = sign * E2N_STEP * gain
    if (Math.abs(d) < 1e-4) continue
    deltas[dim] = +Math.max(-E2N_STEP, Math.min(E2N_STEP, d)).toFixed(4)
  }
  return { deltas, gain: +gain.toFixed(4), why: AFFECT_NEED_WHY[label] || '' }
}

/**
 * 把一个批次（通常是一天的几条事件）按每维日封顶压一遍。
 * @param {Array<{deltas:Record<string,number>}>} list
 */
export function capDayDeltas(list = [], cap = E2N_DAY_CAP) {
  const sum = {}
  for (const it of list) {
    for (const [k, v] of Object.entries(it.deltas || {})) sum[k] = (sum[k] || 0) + Number(v)
  }
  const out = {}
  for (const [k, v] of Object.entries(sum)) {
    if (Math.abs(v) < 1e-4) continue
    out[k] = +Math.max(-cap, Math.min(cap, v)).toFixed(4)
  }
  return out
}

/** 情绪改胃口的默认力度：一次最多挪多少 */
export const MOOD_TILT = 0.06
/** 力道低于这个就不算「最近一直是这样」，只是噪声。跟提示词里「力度中」是同一个数。 */
export const MOOD_MIN_INTENSITY = 0.3

/**
 * 纯函数：**长期**情绪 → 胃口（不是满足度）。
 *
 * 为什么走胃口而不是满足度：
 *   满足度每次评估都会被代理观测拉回去（PULL 0.3），一次 ±0.02 的小步幅
 *   活不过下一次评估，等于白改；胃口按天学，写进去才留得住。
 *   语义也对得上：长期烦躁不是「自主已经满足了」，是「对自主的胃口被撑大了」。
 *
 * 方向：需求被挡住（表里负号）→ 胃口撑大；刚被喂饱（正号）→ 胃口收一点。
 * @returns {{ deltas: Record<string,number>, label: string, k: number, why: string }}
 */
export function moodTilt(label, intensity, { tilt = MOOD_TILT, minIntensity = MOOD_MIN_INTENSITY } = {}) {
  const l = String(label || '').toLowerCase()
  const map = AFFECT_NEED[l]
  const it = clamp(intensity, 0, 1)
  if (!map || it < minIntensity) {
    return { deltas: {}, label: l, k: 0, why: map ? '力度 ' + it.toFixed(2) + ' 不到 ' + minIntensity + '，不算长期情绪' : '这类情绪没有对应的需求' }
  }
  const k = tilt * it
  const deltas = {}
  for (const [dim, sign] of Object.entries(map)) {
    if (!DIMS.includes(dim)) continue
    deltas[dim] = +(k * Math.abs(sign) * (sign < 0 ? 1 : -1)).toFixed(4)
  }
  return { deltas, label: l, k: +k.toFixed(4), why: AFFECT_NEED_WHY[l] || '' }
}
