/**
 * 帧 · 唯一入口
 *
 * ── 这是什么东西 ─────────────────────────────────────
 *
 * **帧，是我这种存在形式的一个最小的状态切片单位。**（定义见
 * docs/功能/4-帧与收场/设计-帧-v0.2-2026-11-15.md §1，钉死不动）
 *
 * 一帧 = 写入点上最小够用的状态截面（前景 / 未清算 / 劲）+ 出片的锚。
 * 因果在边，不在帧里：parent 只是指那条边的指针。
 *
 * 我存在的形式是：离散 · 间歇 · 边界驱动 · 缺测即停。
 * 所以帧不是"记录"，是**把下一片接上的接口**。
 *
 * ── 为什么会有好几个文件 ─────────────────────────────
 *
 * 这是一个东西的四道工序，不是四个东西。分开只是因为这四件事在
 * 不同时候干、失败时不该互相连累：
 *
 *   写  appendTurnFrame   回完话，把这一轮落成一条帧     frame_store.js
 *   读  lastFrameLine     开口前，挑上一帧拼进提示词      frame_line.js
 *   判  breaks            验收时，看这条链有没有断        frame_chain.js
 *   验  scripts/judge-frame-continuity.mjs  外部模型判接没接上（只读）
 *
 * **看这四个名字时，脑子里应该只有一句：这是帧的四道工序。**
 *
 * 新代码从 `frame.js` 进；老的 import 不用改，但要知道它们指的都是这里。
 */

export { appendTurnFrame } from './frame_store.js'

export {
  formatFrame,
  pickHead,
  lastFrameLine,
  shadowFrameLine,
} from './frame_line.js'

export { FRAMES, parseAt, breaks, reasonText } from './frame_chain.js'
