/**
 * 帧 · 写口（设计-帧-v0.1 §7 第 3 步的写半边）
 *
 * 这是**帧的四道工序之一（写）**——帧是一个东西，不是四个。
 * 总入口和定义看 ./frame.js。
 *
 * 只做一件事：每轮对话落一条**原始帧**（不含向量）。
 * 向量由 python 那边 5 分钟一次的 backfill 补上——node 里不调 embedding，
 * 免得每轮多背一次模型加载。
 *
 * 开关：frame.write，默认 off（`getFlag(db,'frame.write') === 'on'` 才写）。
 * 写失败一律吞掉：记账坏了不能连累回话。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getFlag } from '../kernel.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const FRAMES = path.join(ROOT, 'scratch', 'proto', 'frames_v2.jsonl')

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) : t
}

function lastId(conv, agent) {
  try {
    const buf = fs.readFileSync(FRAMES, 'utf8')
    const lines = buf.split('\n').filter((x) => x.trim())
    // 倒着找：同一条会话 + 同一个 agent 的最后那一帧。
    // 跨会话会把别人的话当自己的上一帧；跨 agent 会把别人的链接给自己的。
    for (let i = lines.length - 1; i >= 0; i--) {
      let o
      try { o = JSON.parse(lines[i]) } catch { continue }
      if (typeof o === 'string') { try { o = JSON.parse(o) } catch { continue } }
      if ((o.conv || null) !== (conv || null)) continue
      if (agent && o.agent && o.agent !== agent) continue
      return o.id || null
    }
    return null
  } catch {
    return null
  }
}

/** 同一条链上**已编号**帧里最大的 k；没有编号的返回 0（老帧不占号）。 */
function lastK(conv, agent) {
  try {
    const lines = fs.readFileSync(FRAMES, 'utf8').split('\n')
    let max = 0
    for (const line of lines) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (typeof o === 'string') { try { o = JSON.parse(o) } catch { continue } }
      if ((o.conv || null) !== (conv || null)) continue
      if (agent && o.agent && o.agent !== agent) continue
      if (typeof o.k === 'number' && o.k > max) max = o.k
    }
    return max
  } catch {
    return 0
  }
}

/**
 * 一轮 = 一帧。focus 取这一轮用户那句的头（显示用），anchor 取我这句的头。
 * **步轴 k**（2026-11-15）：同一条链上第几步。它是逻辑刻度，不是时间——
 *   文件顺序会被乱序污染（实测 11-13 的帧排在 11-14 后面），k 不会。
 *   老帧没有 k ＝ 未编号，不补假值；新帧从"已编号的最大 k + 1"接着数。
 * **入边两条**（2026-11-15 夯实：f 不固定，所以"从哪来"不够，还要"这次被喂了什么"）：
 *   parent —— 从哪一帧来；
 *   in     —— 这一次被喂进来的那句（用户原话，截 120 字；不是我的状态，别混）。
 * deviation / tension / anchor_vec 留空，等 backfill 算——**没算完就不许自己编数**。
 */
export function appendTurnFrame(db, aid, { user = '', agent = '', at = null, conv = null, turnId = null } = {}) {
  try {
    if (String(getFlag(db, 'frame.write') || 'off') !== 'on') return null
    // 存得宽一点（80 字），显示层再按标点裁剪。
    // 原来存 32 字，等于把句子在写入时就切断，后面怎么裁都救不回来。
    const focus = clip(user, 40)
    const input = clip(user, 120)
    const anchor = clip(agent, 80)
    if (!focus && !anchor) return null
    const id = 'frm_' + Math.random().toString(16).slice(2, 12)
    const rec = {
      id,
      at: at || new Date().toISOString().slice(0, 19),
      // 同一段对话一条链：parent 只在同一 conv 里找，跨会话不串
      conv: conv || null,
      // agent 键：同会话里换人说话，不串别人的帧（2026-11-14 补）
      agent: aid || null,
      parent: lastId(conv, aid),
      // 指针：这一轮在 chat_turns / fragments 里的 turn_id。
      // 夯实里那句「不存全文，只存指针」——帧只管指路，原文去碎片表取（fragments.text 是逐字原文）。
      turn_id: turnId || null,
      // 步轴：同一链上第几步（逻辑刻度，不是时间；老帧没有这个键＝未编号）
      k: lastK(conv, aid) + 1,
      // 入边第二半：这一次被喂进来的那句（不是我的状态；focus 只是它的显示摘要）
      in: input,
      focus,
      anchor,
      unclosed: [],
      // 2026-11-15 去掉 closed / decide：
      // 夯实里「停＝没有下一步」属于机制（断链判定），不是这一格能写的；
      // 「继续/停」要等后面出现才知道。写死在帧里＝把未来塞进现在（805 帧实测恒为 false / continue）。
      // 要恢复断链判定，做在机制层，别再往帧里塞。
      deviation: null,
      tension: null,
      engine: 'pending',
      anchor_vec: null,
    }
    fs.mkdirSync(path.dirname(FRAMES), { recursive: true })
    fs.appendFileSync(FRAMES, JSON.stringify(rec) + '\n', 'utf8')
    // 回读校验：写失败是唯一会骗人的失败
    const back = fs.readFileSync(FRAMES, 'utf8').split('\n').filter(Boolean)
    const ok = back.length && JSON.parse(back[back.length - 1]).id === id
    return ok ? id : null
  } catch {
    return null
  }
}
