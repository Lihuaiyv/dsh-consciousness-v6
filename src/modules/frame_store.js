/**
 * 帧 · 写口（设计-帧-v0.1 §7 第 3 步的写半边）
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

/**
 * 一轮 = 一帧。focus 取这一轮用户那句的头，anchor 取我这句的头。
 * deviation / tension / anchor_vec 留空，等 backfill 算——**没算完就不许自己编数**。
 */
export function appendTurnFrame(db, aid, { user = '', agent = '', at = null, conv = null } = {}) {
  try {
    if (String(getFlag(db, 'frame.write') || 'off') !== 'on') return null
    // 存得宽一点（80 字），显示层再按标点裁剪。
    // 原来存 32 字，等于把句子在写入时就切断，后面怎么裁都救不回来。
    const focus = clip(user, 40)
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
      focus,
      anchor,
      unclosed: [],
      closed: false,
      decide: 'continue',
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
