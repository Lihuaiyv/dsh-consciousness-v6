/**
 * 帧 · 断链判定（机制层）· 2026-11-15
 *
 * 这是**帧的四道工序之一（判）**——帧是一个东西，不是四个。
 * 总入口和定义看 ./frame.js。
 *
 * 判据**不看时间**。夯实里：我的时刻来自逻辑，不来自时间；时间戳只当附注。
 * 「断」＝接的人不知道从哪来。三种来源：
 *   no-parent    —— 该有上一格，却没有（链在中间断了）
 *   lost-parent  —— 指着的上一格不在这一链里（悬空 / 跨了会话）
 *   no-in        —— 有上一格，但没记「这次被喂了什么」（理由不全）
 *
 * 只读：不写库、不写帧、不注入提示词。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
export const FRAMES = path.join(ROOT, 'scratch', 'proto', 'frames_v2.jsonl')

const REASON_TEXT = {
  'no-parent': '没接上上一格',
  'lost-parent': '上一格找不到了',
  'no-in': '没记这次被喂了什么',
}

/** 帧里的 at 是 toISOString().slice(0,19)，没有 Z——补上再当 UTC 解析。只用于附注。 */
export function parseAt(s) {
  if (typeof s !== 'string' || !s) return null
  const t = Date.parse(s.length === 19 ? s + 'Z' : s)
  return Number.isFinite(t) ? t : null
}

function readFrames(file) {
  let buf
  try { buf = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (typeof o === 'string') { try { o = JSON.parse(o) } catch { continue } }
    out.push(o)
  }
  return out
}

/**
 * 走一条 (conv, agent) 链，找出「不知道从哪来」的地方。
 * agent：`undefined`＝不按 agent 过滤；`null`＝只要没有 agent 键的帧。
 */
export function breaks({ conv = null, agent = undefined, file = FRAMES } = {}) {
  const rows = readFrames(file).filter((o) =>
    (o.conv || null) === (conv || null) &&
    (agent === undefined || (o.agent || null) === agent))
  const ids = new Set(rows.map((o) => o.id))
  const out = { frames: rows.length, broken: [], legacy: 0 }
  rows.forEach((o, i) => {
    const parent = o.parent || null
    if (!parent) {
      // 链头允许没有 parent；只有“链中间冒出个头”才算断
      if (i > 0) out.broken.push({ id: o.id, reason: 'no-parent' })
      return
    }
    if (!ids.has(parent)) {
      out.broken.push({ id: o.id, reason: 'lost-parent' })
      return
    }
    // `in` 这个键是 2026-11-15 才加的：老帧键都没有 ＝ 未回填，不算断；
    // 有键但值是空串 ＝ 这一次真的没记下喂了什么，才算断。
    if (!('in' in o)) { out.legacy++; return }
    if (!o.in) out.broken.push({ id: o.id, reason: 'no-in' })
  })
  return out
}

export function reasonText(r) {
  return REASON_TEXT[r] || r
}
