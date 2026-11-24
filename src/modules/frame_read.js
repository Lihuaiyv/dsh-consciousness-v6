/**
 * 找核读链（frame.read，2026-11-23）
 *
 * 一句话：把 `frame_shadow` 里的行，读成「最近在走的事」一行。
 *
 * 为什么是链：读口以后要加「多条链时挑最该说的那条」，插一步就行；现在全是纯代码、零模型。
 * 树不落表：这一行是每次从 `under_id` 连出来的，不是存出来的（原始设计：树不落表，under_id 就是边）。
 *
 * 链步（固定顺序）：
 *   findTurn  找最近有帧的一轮（可按会话过滤）          输入：db
 *   loadChain 从这轮的目的沿 under_id 往上，最多 3 跳    输入：最近一轮
 *   compose   拼一行；动作去重（与目的同名就丢）、截断     输入：目的 + 动作 + 链
 *
 * 失败策略：onError='continue'——读口坏了不该影响对话；每步自己兜底，最差返回空串。
 * 设计：docs/功能/8-工程-门禁与文档/设计-链与块-2026-11-23.md（链框架）
 * 改动：docs/功能/4-帧与收场/改动-帧读链-2026-11-23.md
 */
import { runChain } from './chain.js'

const MAX_HOPS = 3   // 往上前几跳就够了：再往上就越过「这一段事」，进了「这几个月的事」
const MAX_TURNS = 6  // 只扫最近几轮，避免拿整库

function rowsOf(db, conversationId) {
  try {
    if (conversationId) {
      // frame_shadow 没有会话列，用 turn_id 反查（同一轮 chat_turns 记了会话）
      return db.prepare(`SELECT * FROM frame_shadow WHERE turn_id IN (
        SELECT turn_id FROM chat_turns WHERE conversation_id=? AND turn_id IS NOT NULL
      ) ORDER BY rowid`).all(String(conversationId))
    }
    return db.prepare('SELECT * FROM frame_shadow ORDER BY rowid').all()
  } catch { return [] }
}

function groupTurns(rows) {
  const by = new Map()
  for (const r of rows) {
    if (!by.has(r.turn_id)) by.set(r.turn_id, { id: r.turn_id, at: r.created_at, rows: [] })
    by.get(r.turn_id).rows.push(r)
  }
  return [...by.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

// 第 1 步：最近有帧的一轮
function findTurnStep(ctx) {
  ctx.rows = rowsOf(ctx.db, ctx.conversationId)
  ctx.turns = groupTurns(ctx.rows).slice(-MAX_TURNS)
  ctx.last = ctx.turns.length ? ctx.turns[ctx.turns.length - 1] : null
  if (!ctx.last) return { stop: true }
  return null
}

// 第 2 步：主核 + 卫星 + 往上的段
function loadChainStep(ctx) {
  const rows = ctx.last.rows
  const byId = new Map(ctx.rows.map((r) => [r.id, r]))
  // 新数据：主核 role='nucleus'；老数据：没有 role，取「under 为空且没子」的那行。
  ctx.goal = rows.find((r) => r.role === 'nucleus')
    || rows.find((r) => !r.under_id && !rows.some((x) => x.under_id === r.id))
    || rows[0] || null
  // 卫星：新数据是段行上的 sat（补话原话）；老数据是 head_id/under 指向主核的行
  ctx.satSents = ctx.goal && ctx.goal.sat ? String(ctx.goal.sat).split(/(?<=[。！？!?])/).filter(Boolean) : []
  ctx.actions = ctx.goal
    ? rows.filter((r) => r.id !== ctx.goal.id && ((r.head_id || r.under_id) === ctx.goal.id))
    : []
  const chain = []
  const seen = new Set()
  let cur = ctx.goal
  while (cur && chain.length < MAX_HOPS && !seen.has(cur.id)) {
    seen.add(cur.id)
    let parentId = null
    // 新数据：段间边（frame_edges, rel=continue）；老数据：under_id 往上
    try {
      const e = ctx.db.prepare("SELECT to_id FROM frame_edges WHERE from_id=? AND rel='continue' ORDER BY rowid DESC LIMIT 1").get(cur.id)
      if (e && e.to_id) parentId = e.to_id
    } catch { /* 没有边表就退旧路 */ }
    if (!parentId) parentId = cur.under_id || null
    if (!parentId) break
    const p = byId.get(parentId)
    if (!p) break
    chain.push(p)
    cur = p
  }
  ctx.chain = chain
  return null
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

// 第 3 步：拼一行。动作去重：与目的同名、或彼此同名，都只留一个。
function composeStep(ctx) {
  if (!ctx.goal) return { stop: true }
  const parts = [`在成：${clip(ctx.goal.core, 14)}`]
  // 补话：新数据取段里的卫星句；老数据取卫星核的名字。都要去重（与核名同名、彼此同名）。
  const rawSat = (ctx.satSents && ctx.satSents.length) ? ctx.satSents : ctx.actions.map((a) => a.core)
  const seen = new Set([String(ctx.goal.core || '').trim()])
  const sat = []
  for (const x of rawSat) {
    const k = String(x || '').trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    sat.push(k)
    if (sat.length >= 2) break
  }
  if (sat.length) parts.push(`补话：${sat.map((x) => clip(x, 10)).join('、')}`)
  // 「接着」和「在成」同名就不重复（真库实测会读到「在成：X；接着：X」）
  const parentCore = ctx.chain.length ? String(ctx.chain[0].core || '').trim() : ''
  if (parentCore && parentCore !== String(ctx.goal.core || '').trim()) parts.push(`接着：${clip(parentCore, 12)}`)
  ctx.line = clip(parts.join('；'), Number(ctx.max) || 60)
  return { stop: true }
}

export const FRAME_READ_CHAIN = {
  id: 'frame.read',
  block: 'chat',
  onError: 'continue',
  steps: [
    { id: 'findTurn', kind: 'code', run: findTurnStep },
    { id: 'loadChain', kind: 'code', run: loadChainStep },
    { id: 'compose', kind: 'code', run: composeStep },
  ],
}

/**
 * 读一行「最近在走的事」。空库/没帧/出错都返回 ''。
 * @param {object} db
 * @param {string} aid
 * @param {{conversationId?: string|null, max?: number}} opts
 */
export async function buildReadLine(db, aid, { conversationId = null, max = 60 } = {}) {
  const ctx = {
    db, aid, conversationId, max,
    rows: [], turns: [], last: null, goal: null, chain: [], actions: [], line: '',
    // 读口不防重入（同一毫秒连读两次也该都读到），key 只用来让 runChain 记账
    key: 'frame.read:' + (conversationId || 'all') + ':' + (++readSeq),
  }
  await runChain(FRAME_READ_CHAIN, ctx)
  return ctx.line || ''
}

let readSeq = 0

/**
 * 同步版：给提示词组装用（preStep 里不能等链）。
 * 三步全纯代码，直接顺序跑；空库/出错返回 ''。和 buildReadLine 共用同一套函数。
 */
export function buildReadLineSync(db, aid, { conversationId = null, max = 60 } = {}) {
  try {
    const ctx = { db, aid, conversationId, max, rows: [], turns: [], last: null, goal: null, chain: [], actions: [], line: '' }
    if ((findTurnStep(ctx) || {}).stop) return ''
    if ((loadChainStep(ctx) || {}).stop) return ''
    composeStep(ctx)
    return ctx.line || ''
  } catch { return '' }
}
