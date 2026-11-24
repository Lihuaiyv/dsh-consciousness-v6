/**
 * 排队分块策略（2026-11-22 主人定）
 *
 * 唯一的排队规则。所有模型调用（本地 14B / 语义向量 / 宿主）都走这里排序，
 * 不许在各自的调用点自己编数字。
 *
 * 规则：
 *   1. 块内先来后到（FIFO）——同一块里谁先来谁先跑，不按重要性插队。
 *   2. 块之间块号小的优先——聊天块可以插到实验块前面，实验块可以插到夜间整理块前面。
 *
 * 2026-11-23 补：块和「链」是两件事（设计-链与块-2026-11-23.md）。
 *   块管「什么时候跑、跟谁抢」；链管「按什么顺序跑」。链里的纯代码/IO 步骤**不进队列**，
 *   只带块标签归账用；只有模型步骤（local/host）按 block 排队。
 *
 * 设计文档：docs/功能/8-工程-门禁与文档/设计-链与块-2026-11-23.md
 *          （块那部分 2026-11-22 定，11-23 并入这份；更早的排队分块设计已归档）
 */

export const BLOCK = Object.freeze({
  chat: 1,   // 聊天、分帧、判定、这一轮的摘要、向量
  exp: 2,    // 实验判官、对照
  night: 3,  // 切事、日记、整理、批量、预热
})

export const BLOCK_NAME = Object.freeze({ 1: '聊天', 2: '实验', 3: '夜间整理' })

/** 把标签/老数字都归到块上。认不出来的一律按聊天块（人可能在等）。 */
export function blockOf(input) {
  if (input === BLOCK.chat || input === BLOCK.exp || input === BLOCK.night) return input
  const s = String(input == null ? '' : input).trim()
  if (!s) return BLOCK.chat
  // 块名（2026-11-23 修：设计文档里写 'night'，以前只认 'nightly' 会回落聊天块）
  if (s === 'chat') return BLOCK.chat
  if (s === 'exp') return BLOCK.exp
  if (s === 'night') return BLOCK.night
  const n = Number(s)
  if (Number.isFinite(n)) {
    // 老数字：1/2 聊天，3 实验，5/6/7 夜间整理
    if (n <= 2) return BLOCK.chat
    if (n === 3) return BLOCK.exp
    return BLOCK.night
  }
  // 标签推断
  if (/^exp[:.]|experiment/i.test(s)) return BLOCK.exp
  if (/^split|^nightly|^batch|^diary|^整理|^切事|^批量/i.test(s)) return BLOCK.night
  // 找核链（2026-11-23）：写/读都是聊天块；连树属于夜间整理
  if (/^frame:(tree|night)/i.test(s)) return BLOCK.night
  if (/^frame:/i.test(s)) return BLOCK.chat
  return BLOCK.chat
}

/** 队列排序：先比块号，同块按入队序号（先来后到）。 */
export function compareQueued(a, b) {
  const ba = blockOf(a.block != null ? a.block : a.priority)
  const bb = blockOf(b.block != null ? b.block : b.priority)
  if (ba !== bb) return ba - bb
  return (a.seq || 0) - (b.seq || 0)
}

/** 给日志/看板显示用：块号 + 名字。 */
export function blockLabel(input) {
  const b = blockOf(input)
  return 'B' + b + '(' + BLOCK_NAME[b] + ')'
}

/**
 * 一条任务属于哪一块（2026-11-22 看板要用）。
 *
 * 顺序很要紧：先看**标签里明确写了的**（`exp:` / `split:` / `nightly` 这些前缀），
 * 再看 lane，最后才回落聊天。不能像 blockOf 那样拿任意标签去猜——
 * 调用方随手起个名字（比如实验里 label 写成 "demo-A"），按标签判就会掉进默认的聊天块。
 */
export function blockOfTask(label, lane) {
  const l = String(label || '')
  if (/^exp[:.]|^experiment/i.test(l)) return BLOCK.exp
  if (/^split|^nightly|^batch|^diary|^整理|^切事|^批量/i.test(l)) return BLOCK.night
  if (/^frame:(tree|night)/i.test(l)) return BLOCK.night
  if (/^frame:/i.test(l)) return BLOCK.chat
  const ln = String(lane || '')
  if (/^exp$/i.test(ln)) return BLOCK.exp
  if (/^(night|nightly|split|diary|batch|warm)$/i.test(ln)) return BLOCK.night
  return BLOCK.chat
}
