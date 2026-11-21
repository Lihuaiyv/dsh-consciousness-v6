/**
 * 第 1 层：事 → 方向（设计-事到情绪的自洽映射-2026-11-19）
 *
 * 判断层不再给三个连续小数，只给三个标签：
 *   谁做的  by      ：me / other / world
 *   得失    gain    ：gain / loss / none
 *   意外    surprise：0 预料内 / 1 撞上来的
 * 幅度由 severity 给（none / strong / existence），不用模型估小数。
 *
 * 代码按定稿表把标签换成三根轴的方向（值域 -1~+1）：
 *   安 ← 得失 ? +1 : -1
 *   觉 ← 意外
 *   欲 ← 谁做的 == 'other' ? +1 : -1      // 对方做的往外使，自己和世界往回收
 *
 * 2026-11-21 为什么这么改：之前模型直接给三个小数，讨论里被指出错了就被判成
 * goal=-0.15，几十轮累积下来 s 被压到 0.08~0.20，选出来的全是思念/乡愁/嫉妒/怨气。
 * 标签法不会每句推一小格，幅度只由严重程度决定，形状才不会被单句攒到底。
 */

/** 三档严重程度 → 幅度。存在的档留给 applyShock，这里只取前两档。 */
export const MAGNITUDE = { none: 0.22, strong: 0.55, existence: 1 }

const clamp11 = (v) => Math.max(-1, Math.min(1, Number(v) || 0))

/** 把标签判成三根轴的「方向」（不是位置）。拿不到标签返回 null，调用方退回旧路。 */
export function labelsToDeltas(j = {}) {
  const by = String(j.by || '').trim().toLowerCase()
  if (!['me', 'other', 'world', 'self'].includes(by)) return null
  const g = String(j.gain || '').trim().toLowerCase()
  if (!['gain', 'loss', 'none'].includes(g)) return null
  const sp = j.surprise
  const surprise = sp === true || sp === 1 || sp === '1' || String(sp).toLowerCase() === 'true'
  const mag = MAGNITUDE[String(j.severity || '').toLowerCase()] ?? MAGNITUDE.none

  const who = by === 'self' ? 'me' : by
  // 得失：得了 +，失了 −，「两清」不动。这一列决定安。
  const sign = g === 'gain' ? 1 : g === 'loss' ? -1 : 0
  // 欲这一列按定稿表：
  //   对方做的 → 一律往外使（+），哪怕我失（恼火、想顶回去）
  //   我自己弄的 → 往回收（−），愧疚
  //   世界给的 → 得了是中（庆幸，没处使也不缩）、失了是低（认了、无力）
  const dSign = sign === 0 ? 0 : who === 'other' ? 1 : who === 'world' ? (sign > 0 ? 0 : -1) : -1
  return {
    // 字段名对齐 deltasOf()：s/n/d 就是三根轴的「方向」
    s: clamp11(sign * mag),
    // 意外：撞上来的才抬觉，预料内不动（NE 只报「没料到」那一下）
    n: clamp11(surprise ? mag : 0),
    d: clamp11(dSign * mag),
    // 派生：给对账和 why 用
    by: who,
    gain: g,
    surprise: surprise ? 1 : 0,
    magnitude: mag,
  }
}

/** 反向：从三个 delta 猜回三标签。只用于对账旧数据，不参与判定。 */
export function deltasToLabels(j = {}) {
  const g = Number(j.goal_delta) || 0
  const e = Number(j.expect_delta) || 0
  const d = Number(j.future_delta) || 0
  return {
    by: d > 0.02 ? 'other' : d < -0.02 ? 'me' : 'world',
    gain: g > 0.02 ? 'gain' : g < -0.02 ? 'loss' : 'none',
    surprise: e > 0.02,
  }
}
