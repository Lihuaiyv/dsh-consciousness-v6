/**
 * 离线切事（第 1 步）：把一个「清醒段」里的碎片交给**宿主模型**切成「事」。
 *
 * 2026-11-12 定：只写文件，不建表、不写库。
 * 用法：POST /v1/agents/:aid/events/split  { day: "2026-11-12", dry: true }
 *
 * 为什么在插件里做、不在命令行脚本里做：
 *   `model.complete` 在插件进程里靠宿主注入的 llm（attachHostLlm）才是通的；
 *   独立 node 进程里 hostLlmGetter 为 null，capabilities().complete 恒为 false。
 *   （这条在 docs/记忆时态-模型窄门-修改计划-2026-11-04.md §73 写过，别再踩。）
 *
 * 规则来自 docs/设计-事件库-最终版-2026-11-12.md：
 *   - 清醒段：相邻两句间隔 ≥ 4 小时就断开
 *   - 边界：换目的 / 换话题主体 / 告一段落；同一件里的情绪起伏不算
 *   - quotes 必须原文一字不差，对不上的那条丢
 *   - 宁可少，不可编；说不清就给 3 件
 *   - 喂模型前剔掉机器消息
 */
import { oneLine } from './pack.js'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from '../paths.js'
import { now } from '../db.js'
import { model, getFlag, setFlag } from '../kernel.js'
import { looksLikeRuntimeNoise } from '../text.js'
import { localCutOn, localDailyFallbackOn, localComplete } from './local_llm.js'

const GAP_MS = 4 * 3600 * 1000     // 清醒段：≥4 小时没人说话
const CHUNK_CHARS = 3000           // 单次喂模型的正文上限（2026-11-12 实测后收紧：12000 会 fetch failed）
const MAX_TOKENS = 3000            // 单次输出上限（1500 常把长 story 截断成非法 JSON）
const RETRY = 3                    // 空回重试次数：模型偶尔一次不回字，别把「空」当成「没有」
const MAX_EVENTS = 30

const SYSTEM = [
  '你在一段真实的聊天记录里，把这段切成「事」。',
  '一段 = 从睡醒到睡着；中间换了目的、换了话题主体、告一段落，才切新的一件。同一件里的情绪起伏（恼一下又松下来）不算换事。',
  '宁可少切，不可硬编。说不清就给 3 件。通常 5~18 件。',
  '只输出 JSON 数组，不要解释、不要 markdown 代码块。每条字段：',
  'title（一句话，≤20 字）、who（主人/我/别人）、started_at、ended_at（ISO 时间）、',
  'turn_ids（数组，必须是输入里出现过的 turn_id）、quotes（数组，原文里能一字不差找到的句子）、',
  'status（"没过去" 或 "过去了"）、weight（0~1）、story（起因经过结果，带当时的语气和细节；只写发生过的，不写这说明什么）。',
  'weight：0.8 以上 = 关乎我/关乎我们/关乎存在；0.5 左右 = 一次经过；0.3 以下 = 流水账。',
].join('\n')

/** 本地日 → UTC 区间（+08:00） */
function dayBounds(day) {
  const lo = new Date(day + 'T00:00:00+08:00').toISOString()
  const hi = new Date(day + 'T23:59:59.999+08:00').toISOString()
  return [lo, hi]
}

/** B2 去重：同一天里「同角色 + 同正文」的重复碎片只留第一条；切事按内容走，重复读不产生新信息。 */
function dedupeCleanRows(rows) {
  const seen = new Set()
  const out = []
  for (const r of rows) {
    const key = String(r.role || '') + '\u0001' + String(r.text || '').trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/** 取这一天的碎片，剔机器消息；重复正文只留第一条（B2）。 */
export function loadCleanRows(db, aid, day) {
  const [lo, hi] = dayBounds(day)
  const rows = db.prepare(`SELECT id, turn_id, role, text, created_at, session_id
    FROM fragments WHERE agent_id=? AND role IN ('user','assistant') AND created_at BETWEEN ? AND ?
    ORDER BY created_at`).all(aid, lo, hi)
  const clean = []
  for (const r of rows) {
    const t = String(r.text || '').trim()
    if (!t) continue
    if (looksLikeRuntimeNoise(t)) continue
    if (/^You are the Team Lead named/.test(t)) continue
    clean.push({ ...r, text: t })
  }
  return { rows, clean: dedupeCleanRows(clean) }
}

/** 按 ≥4h 断成清醒段 */
export function toSegments(clean) {
  const segs = []
  let cur = []
  for (const r of clean) {
    const prev = cur[cur.length - 1]
    if (prev && (Date.parse(r.created_at) - Date.parse(prev.created_at)) >= GAP_MS) { segs.push(cur); cur = [] }
    cur.push(r)
  }
  if (cur.length) segs.push(cur)
  return segs
}

/** 一段太长 → 按最长静默点分成若干块（不按字数硬切，切点落在真断开处） */
function chunkSegment(seg) {
  const out = []
  let cur = seg.slice()
  while (cur.length) {
    let body = cur.map((r) => `[${r.turn_id || r.id}] ${r.role === 'user' ? '主人' : '我'}：${r.text}`).join('\n')
    if (body.length <= CHUNK_CHARS || cur.length <= 4) { out.push(cur); break }
    // 找最长的 gap，切在那儿
    let bestAt = -1, bestGap = -1
    for (let i = 1; i < cur.length; i++) {
      const gap = Date.parse(cur[i].created_at) - Date.parse(cur[i - 1].created_at)
      if (gap > bestGap) { bestGap = gap; bestAt = i }
    }
    if (bestAt <= 0) { out.push(cur); break }
    out.push(cur.slice(0, bestAt))
    cur = cur.slice(bestAt)
  }
  return out
}

const WIN_ROWS = 20          // 一次读多少轮（2026-11-13：30 → 20，短一点少空回/少截断）
const WIN_GROW = 15          // 这一件还没完，就再续几轮
const WIN_MAX = 120          // 一扇窗最多读到多少轮（防跑飞）

/** 逐件模式：只输出「开头那一件」。窗口不够长就回 incomplete，让调用方扩窗。 */
const ONE_SYSTEM = [
  '你在一段真实的聊天记录里，只做一件很窄的事：**输出开头那一件完整的事**。',
  '规则：',
  '1. 从输入第一轮开始读，一直读到「换了目的 / 换了话题主体 / 告一段落」为止——那之前都算同一件。',
  '2. 同一件里的情绪起伏（恼一下又松下来）不算换事。',
  '3. 如果读到输入末尾这件都还没结束，只回 {"incomplete":true}，不要编。',
  '4. 否则只回一个 JSON 对象（不要数组、不要解释、不要代码块）：',
  '   {"title":"≤20字","who":"主人/我/别人","started_at":ISO,"ended_at":ISO,',
  '    "turn_ids":["输入里出现过的 turn_id"],"quotes":["原文里一字不差的句子"],',
  '    "cues":["3~5个抓手词"],"status":"没过去/过去了","weight":0.5,"last_turn_id":"这一件的最后一个轮次",',
  '    "story":"起因、经过、结果，带当时的语气和细节；只写发生过的，不写这说明什么"}',
  '5. cues 是「以后聊天里出现哪个词，这件事会自然地浮上来」——3~5 个，每个 2~6 个字。',
  '   ① 专名优先（文件名、作品名、人名、地名）——标题里出现过的专名，必须列进去；',
  '   ② 其次是一个具体的物件或动作；',
  '   ③ 不要列：语气词、内部结构词、泛词——列了也撞不上，撞上也不知道是这件。',
  '   ④ 具象优先于抽象：要「那串脚印、那道压痕、那口冰可乐」，不要「一次沟通、一个流程」。',
  '      人记的是一样东西，不是一个概念；概念撞一万件事，东西只撞一件。',
  '   ⑤ 短而能沾：两三个字才可能被半句沾到。',
  '   ⑥ 得是能被人说出口的：只有当事人懂的说法不要列，别人不会那么说。',
  '   检验：如果现在有人说起这个词，我会真的想起这件事吗？不会，就别列。',
  '6. quotes 必须能在原文里一字不差找到；last_turn_id 必须是输入里出现过的。',
  '7. 宁可少切，不可硬编。',
].join('\n')

function parseJsonObject(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const tryObj = (txt) => {
    try { const v = JSON.parse(txt); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null }
  }
  const direct = tryObj(s)
  if (direct) return direct
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) { const v = tryObj(fence[1].trim()); if (v) return v }
  const obj = s.match(/\{[\s\S]*\}/)
  if (obj) { const v = tryObj(obj[0]); if (v) return v }
  return null
}

/**
 * 事件时间门（A2）：模型写的 started_at/ended_at 不可信。
 * 只要给了 rows，就按这条事件 turn_ids 的首末碎片时间兜底：
 * 解析失败、或落在 [首-1h, 末+1h] 之外，一律换成真实碎片时间。
 */
function clampEventTime(ev, rows = null) {
  if (!rows || !rows.length) return ev
  const ids = new Set((Array.isArray(ev.turn_ids) ? ev.turn_ids : []).map(String))
  const times = rows
    .filter((r) => ids.has(String(r.turn_id)) && r.created_at)
    .map((r) => Date.parse(r.created_at))
    .filter(Number.isFinite)
  if (!times.length) return ev
  const lo = Math.min(...times)
  const hi = Math.max(...times)
  const t0 = Date.parse(ev.started_at)
  const t1 = Date.parse(ev.ended_at)
  const out = { ...ev }
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 < lo - 3600e3 || t1 > hi + 3600e3) {
    out.started_at = new Date(lo).toISOString()
    out.ended_at = new Date(hi).toISOString()
  }
  return out
}

/** 校验一条：引文必须原文子串；turn_ids 必须在这块里出现过。不合格就丢。 */
function checkEvent(ev, textAll, turnSet, rows = null) {
  if (!ev || !ev.title) return null
  const quotes = (Array.isArray(ev.quotes) ? ev.quotes : []).filter((q) => q && textAll.includes(String(q)))
  const turnIds = (Array.isArray(ev.turn_ids) ? ev.turn_ids : []).filter((id) => turnSet.has(String(id)))
  if (!quotes.length) return null
  return clampEventTime({
    title: String(ev.title).slice(0, 40),
    who: String(ev.who || '').slice(0, 10),
    started_at: ev.started_at || null,
    ended_at: ev.ended_at || null,
    turn_ids: turnIds,
    quotes,
    // 抓手词：出生时顺手给（模型刚读完整段，最懂什么话会把它带回来）
    cues: (Array.isArray(ev.cues) ? ev.cues : []).map((x) => String(x).trim()).filter((x) => x && Array.from(x).length <= 12).slice(0, 6),
    status: String(ev.status || '').slice(0, 8),
    weight: Number(ev.weight) || 0.5,
    story: String(ev.story || '').slice(0, 1500),
  }, rows)
}

/**
 * 通道实测：用不同长度的正文各问一句短的，看从哪一档开始打不回来。
 * 不切事、不写文件，只回答「模型到底能喂多少」。
 * 2026-11-12 加：之前 12000 字 + 6000 输出的请求直接 fetch failed，得先把上限量出来。
 */
export async function probeModel({ sizes = [1000, 3000, 6000, 12000], maxOut = 40, complete = null } = {}) {
  let usable = false
  try { usable = !!model.capabilities().complete } catch { usable = false }
  const callModel = complete || (usable ? (req) => model.complete(req) : null)
  if (!callModel) return { ok: false, reason: 'no-model', sizes: [] }
  // 填充文本用真实句子的样子，别用「啊啊啊」，否则测出来的不是同一个东西
  const FILL = '这是一段用来测长度的填充。今天在改碎片表和事件库，凌晨三点还在看日志。'
  const out = []
  for (const n of sizes) {
    const filler = FILL.repeat(Math.ceil(n / FILL.length)).slice(0, Math.max(0, n - 20))
    const text = `下面是 ${n} 字的填充文本。读完只回一句「收到」，别做别的事。\n` + filler
    const t0 = Date.now()
    let got = '', err = null
    try {
      got = String(await callModel({ system: '你只做一件事：收到长文后回一句「收到」。', text, maxTokens: maxOut }) || '')
    } catch (e) { err = String((e && e.message) || e).slice(0, 200) }
    out.push({ chars: text.length, ok: !!got.trim(), outLen: got.trim().length, outHead: got.trim().slice(0, 40), ms: Date.now() - t0, err })
    if (!got.trim()) break  // 这一档已经打不回来，再长没意义
  }
  return { ok: true, at: now(), sizes: out, note: 'ok=true 表示模型真回了字；到第一档 ok=false 就停。' }
}

export async function splitDay(db, aid, day, { dry = false, maxTokens = MAX_TOKENS, complete = null } = {}) {
  if (!day) return { ok: false, reason: 'no-day', day: '' }
  let usable = false
  try { usable = !!model.capabilities().complete } catch { usable = false }
  // 测试时可以塞一个假模型进来（命令行 / 单测）；没塞就走宿主模型。
  const callModel = complete || (usable ? (req) => model.complete(req) : null)
  if (!callModel) return { ok: false, reason: 'no-model', day }

  const { rows, clean } = loadCleanRows(db, aid, day)
  const segs = toSegments(clean)
  const results = []
  let totalEvents = 0

  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si]
    let cursor = 0
    let guard = 0
    // 逐件模式：每次只让模型输出「开头那一件」。窗口不够就扩，切出边界再往下走。
    // 好处：单次输出永远只有一件，不会把模型的力气耗在「一次写十几件」上；
    // 而且下一件从上一件的结尾接着判，边界不会被窗口硬切开。
    while (cursor < seg.length && guard++ < 300) {
      let end = Math.min(cursor + WIN_ROWS, seg.length)
      let event = null
      let rawHead = ''
      let lastErr = null
      let tries = 0
      let raw = ''
      let shrunk = false
      while (tries++ < 10) {
        const win = seg.slice(cursor, end)
        const body = win.map((r) => `[${r.turn_id || r.id}] ${r.role === 'user' ? '主人' : '我'}：${r.text}`).join('\n')
        raw = ''
        for (let attempt = 0; attempt <= RETRY; attempt++) {
          try {
            raw = await callModel({ system: ONE_SYSTEM, text: body, maxTokens: Math.min(maxTokens, MAX_TOKENS) })
          } catch (e) { lastErr = String((e && e.message) || e).slice(0, 200) }
          if (raw) break
          // 空回不是「模型说没有」，多半是这一下没吐字；隔一下再试，别直接当空
          await new Promise((r) => setTimeout(r, 600))
        }
        if (raw) rawHead = String(raw).slice(0, 300)
        const obj = raw ? parseJsonObject(raw) : null
        // 空回 / 解析失败：把窗口砍半再试一次（长窗口最容易出这两种）
        if ((!raw || !obj) && !shrunk && win.length > 4) {
          shrunk = true
          end = cursor + Math.max(4, Math.floor(win.length / 2))
          continue
        }
        if (!raw) break
        if (!obj) break
        if (obj.incomplete === true) {
          if (end >= seg.length) { event = null; break }   // 到段尾还没完：这一扇窗收一件兜底
          end = Math.min(end + WIN_GROW, seg.length)
          continue
        }
        event = obj
        break
      }
      const t0 = Date.now()
      const win = seg.slice(cursor, end)
      const textAll = win.map((r) => String(r.text || '')).join('\n')
      const turnSet = new Set(win.map((r) => r.turn_id).filter(Boolean))
      const kept = []
      let nextFrom = cursor + win.length
      let drop = null
      if (event) {
        const c = checkEvent(event, textAll, turnSet, win)
        if (c) {
          kept.push(c)
          totalEvents++
          // 这一件到哪一轮为止：优先用模型给的 last_turn_id，找不到就退回 turn_ids 里最后能对上的那轮
          let idx = -1
          const lastId = String(event.last_turn_id || '')
          for (let i = win.length - 1; i >= 0 && idx < 0; i--) if (String(win[i].turn_id || '') === lastId) idx = i
          for (let k = (c.turn_ids || []).length - 1; k >= 0 && idx < 0; k--) {
            for (let i = win.length - 1; i >= 0 && idx < 0; i--) if (String(win[i].turn_id || '') === String(c.turn_ids[k])) idx = i
          }
          nextFrom = cursor + (idx >= 0 ? idx + 1 : win.length)
        } else {
          // 丢件要留原因：没标题 / 没证据 / 引文对不上 / 轮次对不上
          const qs = (Array.isArray(event.quotes) ? event.quotes : []).filter((q) => q && textAll.includes(String(q)))
          const ts = (Array.isArray(event.turn_ids) ? event.turn_ids : []).filter((id) => turnSet.has(String(id)))
          drop = !event.title ? 'no-title'
            : (!qs.length && !ts.length) ? 'no-evidence'
              : (!qs.length ? 'no-quotes' : 'no-turn-ids')
        }
      }
      // 有回包、但解析不出对象：记成 parse-fail 而不是悄悄空着
      if (!event && raw && !drop) drop = 'parse-fail'
      if (nextFrom <= cursor) nextFrom = cursor + 1   // 防死循环
      results.push({
        segment: si + 1, from: win[0].created_at, to: win[win.length - 1].created_at,
        rows: win.length, fromRow: cursor, toRow: cursor + win.length,
        kept: kept.length, ms: Date.now() - t0,
        rawHead, error: lastErr && !rawHead ? lastErr : null,
        empty: !raw, drop,
        events: kept,
      })
      cursor = nextFrom
    }
  }

  const out = {
    ok: true, at: now(), agent: aid, day,
    gapHours: 4, rows: rows.length, clean: clean.length,
    segments: segs.length, events: totalEvents, results,
    note: '只写文件，不建表。校验规则：引文必须原文子串、turn_ids 必须存在；不合格的那条丢掉。',
  }
  if (!dry) {
    const dir = path.join(dataDir(), 'events')
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `cold-${day}-${Date.now()}.json`)
    fs.writeFileSync(f, JSON.stringify(out, null, 1), 'utf8')
    out.savedTo = f
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// B2 批量切事（2026-11-13 下午）：分两个标准、按字数切块、一块一落、断了续切。
//
// 和上面 splitDay 的关系：
//   - splitDay：逐件模式，一次只要一件，质量最稳，但次数多（一天约 13~40 次）；
//   - splitDayBatch：日常段一次要 3~8 件、工作段只要一条 digest，按字数切块，
//     每块切完立刻回调落库，进度写 flags，断了从断点续——不再一次赌到底。
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_CHARS = 8000        // 一块正文的字数上限（≈4k~6k token；跑 10-27 对照再调）
const BATCH_MAX_EVENTS = 8      // 日常段一块最多要几件（多了输出容易截断）
const WORK_MAX_TOKENS = 500     // 工作段输出上限：一条 digest + 几个抓手

const DAILY_BATCH_SYSTEM = [
  '你在真实的聊天记录里，把这段切成「事」。',
  '规则：从第一轮开始读；换了目的、换了话题主体、告一段落，才切新的一件；同一件里的情绪起伏（恼一下又松下来）不算换事。',
  '宁可少切，不可硬编。通常 3~8 件；这一段读不出 3 件就照实给。',
  '只输出 JSON 数组，不要解释、不要 markdown 代码块。每条字段：',
  'title（一句话，≤20 字）、who（主人/我/别人）、started_at、ended_at（ISO 时间）、',
  'turn_ids（数组，必须是输入里出现过的 turn_id）、quotes（数组，原文里一字不差的句子）、',
  'cues（3~5 个抓手词，每个 2~6 字，专名优先）、status（没过去/过去了）、weight（0~1）、',
  'story（起因经过结果，带当时的语气和细节；≤400 字；只写发生过的，不写这说明什么）。',
].join('\n')

const WORK_SYSTEM = [
  '你在读一段工作聊天记录（主人在干活，不是日常闲聊）。',
  '只输出一个 JSON 对象，不要解释、不要 markdown 代码块：',
  '{"digest":"≤100 字，说清这段在做什么、做到哪了","cues":["3~5 个抓手词，每个 2~6 字，专名优先"]}',
  '只写发生过的；说不清就给一句更短的 digest，不要编。',
].join('\n')

/** 读一天，带出每行的 mode（按 turn_id 连 chat_turns；老数据没标签 → 日常，不猜）。 */
export function loadCleanRowsWithMode(db, aid, day) {
  const [lo, hi] = dayBounds(day)
  const rows = db.prepare(`SELECT f.id, f.turn_id, f.role, f.text, f.created_at, f.session_id,
      (SELECT c.mode FROM chat_turns c WHERE c.agent_id = f.agent_id AND c.turn_id = f.turn_id LIMIT 1) AS mode
    FROM fragments f
    WHERE f.agent_id = ? AND f.role IN ('user','assistant') AND f.created_at BETWEEN ? AND ?
    ORDER BY f.created_at`).all(aid, lo, hi)
  const clean = []
  for (const r of rows) {
    const t = String(r.text || '').trim()
    if (!t) continue
    if (looksLikeRuntimeNoise(t)) continue
    if (/^You are the Team Lead named/.test(t)) continue
    clean.push({ ...r, text: t, mode: String(r.mode || '') === 'work' ? 'work' : 'daily' })
  }
  return { rows, clean: dedupeCleanRows(clean) }
}

/** 一个清醒段里再按 mode 连续块分：工作段 / 日常段各走各的标准。 */
export function splitRunsByMode(seg) {
  const runs = []
  let cur = null
  for (const r of seg) {
    const m = r.mode === 'work' ? 'work' : 'daily'
    if (!cur || cur.mode !== m) { cur = { mode: m, rows: [] }; runs.push(cur) }
    cur.rows.push(r)
  }
  return runs
}

/** 按字数预算切块。块边界只在两行之间，不劈开一句话。 */
export function chunkByChars(rows, limit = BATCH_CHARS) {
  const out = []
  let cur = []
  let len = 0
  for (const r of rows) {
    const add = String(r.text || '').length + 16
    if (cur.length >= 4 && len + add > limit) { out.push(cur); cur = []; len = 0 }
    cur.push(r)
    len += add
  }
  if (cur.length) out.push(cur)
  return out
}

function chunkBody(rows) {
  return rows.map((r) => `[${r.turn_id || r.id}] ${r.role === 'user' ? '主人' : '我'}：${r.text}`).join('\n')
}

function parseJsonArray(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const tryArr = (txt) => { try { const v = JSON.parse(txt); return Array.isArray(v) ? v : null } catch { return null } }
  const direct = tryArr(s)
  if (direct) return direct
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) { const v = tryArr(fence[1].trim()); if (v) return v }
  const arr = s.match(/\[[\s\S]*\]/)
  if (arr) { const v = tryArr(arr[0]); if (v) return v }
  return null
}

function checkBatchEvent(ev, textAll, turnSet, rows = null) {
  if (!ev || !ev.title) return null
  const quotes = (Array.isArray(ev.quotes) ? ev.quotes : []).filter((q) => q && textAll.includes(String(q)))
  const turnIds = (Array.isArray(ev.turn_ids) ? ev.turn_ids : []).filter((id) => turnSet.has(String(id)))
  if (!quotes.length) return null
  return clampEventTime({
    title: String(ev.title).slice(0, 40),
    who: String(ev.who || '').slice(0, 10),
    started_at: ev.started_at || null,
    ended_at: ev.ended_at || null,
    turn_ids: turnIds,
    quotes,
    cues: (Array.isArray(ev.cues) ? ev.cues : []).map((x) => String(x).trim()).filter((x) => x && Array.from(x).length <= 12).slice(0, 6),
    status: String(ev.status || '').slice(0, 8),
    weight: Number(ev.weight) || 0.5,
    story: String(ev.story || '').slice(0, 1200),
  }, rows)
}

/** 从原文里抽「能撞上的专名」：文件名、模块名、版本号、英文标识符。给 work 摘要补抓手用。 */
function extractNameCues(text) {
  const s = String(text || '')
  const out = []
  const stop = new Set(['http', 'https', 'json', 'true', 'false', 'null', 'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'was'])
  const push = (x) => {
    const v = String(x || '').trim()
    const n = Array.from(v).length
    if (!v || n < 2 || n > 12) return
    if (stop.has(v.toLowerCase())) return
    out.push(v)
  }
  for (const m of s.matchAll(/[A-Za-z0-9_\-./\\]+\.(?:js|mjs|cjs|ts|json|md|py|db|txt|ps1|yaml|yml)\b/g)) {
    push(m[0].split(/[\\/]/).pop())
  }
  for (const m of s.matchAll(/\bv?\d+\.\d+(?:\.\d+)?\b/g)) push(m[0])
  for (const m of s.matchAll(/\b[A-Za-z][A-Za-z0-9_.\-]{2,}\b/g)) push(m[0])
  return out
}

/** 词法抓手：从原话里切 2~8 字的短段（去掉常见虚词开头），比只靠英文/文件名多几个能撞的词。 */
function lexicalCues(texts) {
  const out = []
  for (const raw of texts) {
    for (const seg of String(raw).split(/[\s，。！？、；：,.!?;:()（）\[\]{}「」『』"'…~～]+/)) {
      const v = seg.trim().replace(/^[和跟与把被的了是在有就都也又还我你他她它这那]+/, '')
      const n = Array.from(v).length
      if (n >= 2 && n <= 8) out.push(v)
    }
  }
  return out
}

/** 词法摘要：不连模型，直接从碎片现拼。给 work 段在本地连不上时兜底用。 */
function lexicalDigest(rows) {
  const users = rows.filter((r) => r.role === 'user').map((r) => String(r.text || '').trim()).filter(Boolean)
  const texts = rows.map((r) => String(r.text || '').trim()).filter(Boolean)
  const norm = (s) => s.replace(/\s+/g, ' ')
  const first = norm(users[0] || texts[0] || '').slice(0, 50)
  const last = norm(users[users.length - 1] || texts[texts.length - 1] || '').slice(0, 40)
  if (!first) return null
  const cues = mergeNameCues(lexicalCues(texts), texts.join('\n')).slice(0, 5)
  const digest = (last && last !== first ? `${first}；后来：${last}` : first).slice(0, 110)
  return { digest, cues }
}

/** 工作段：只产一条「工作段」摘要事件（低信心、可检索，不写细节）。 */
function makeWorkEvent(parsed, rows, quality = 'local') {
  const digest = String((parsed && parsed.digest) || '').trim().slice(0, 120)
  if (!digest) return null
  const textAll = rows.map((r) => String(r.text || '')).join('\n')
  // 14B 的 digest 有人味，但 cues 常是「A段/三件」这种内部词；
  // 规则从原文补一层文件名/模块/版本，保证以后真能撞上（软联想也要有钩子）。
  const cues = mergeNameCues(parsed?.cues, textAll)
  return {
    title: '工作段：' + oneLine(digest, 18),
    who: '主人',
    started_at: rows[0].created_at,
    ended_at: rows[rows.length - 1].created_at,
    turn_ids: rows.map((r) => r.turn_id).filter(Boolean).slice(0, 12),
    quotes: [String(rows[0].text || '').slice(0, 60)].filter(Boolean),
    cues,
    status: '过去了',
    weight: quality === 'lexical' ? 0.25 : 0.35,
    quality,
    story: digest,
  }
}

/** cues 合并：模型给的 + 规则从原文抽的专名（去重、2~12 字、最多 6 个）。 */
function mergeNameCues(cues, text) {
  const merged = [...(Array.isArray(cues) ? cues : []), ...extractNameCues(text)]
  return [...new Set(merged.map((x) => String(x).trim()).filter((x) => {
    const n = Array.from(x).length
    return x && n >= 2 && n <= 12
  }))].slice(0, 6)
}

/**
 * daily 主模型失败时的本地兜底：用逐件提示（ONE_SYSTEM）按 20 轮窗口跑。
 * 不用批切提示——14B 对「JSON 数组」不听话，批切会吐一个对象直接归零。
 * 产出的事件是低信心的：调用方会把 weight 压到 ≤0.35。
 */
async function localDailyEvents(db, rows, localFn) {
  const events = []
  for (let i = 0; i < rows.length; i += 20) {
    const win = rows.slice(i, i + 20)
    const winText = win.map((r) => String(r.text || '')).join('\n')
    const turnSet = new Set(win.map((r) => r.turn_id).filter(Boolean))
    let raw = ''
    try {
      const out = await localFn({ system: ONE_SYSTEM, text: chunkBody(win), maxTokens: 1800 })
      raw = String((out && out.text) || out || '')
    } catch { continue }
    const obj = raw ? parseJsonObject(raw) : null
    if (!obj || obj.incomplete === true) continue
    const ev = checkEvent(obj, winText, turnSet, win)
    if (ev) events.push({ ...ev, cues: mergeNameCues(ev.cues, winText) })
  }
  return events
}

/**
 * 批量切一天。onEvents(events, meta) 每切完一块回调一次，调用方在这里落库；
 *
 * 进度存在 flags：
 *   events.cut.<day>.pos   最后一块的最后一轮（turn_id），断了从这里续
 *   events.cut.<day>.calls 已花次数（由调用方累加）
 *
 * 空回：不前进、不落库，停下等下一轮重试同一块（别把「没吐字」当「没有」）。
 */
export async function splitDayBatch(db, aid, day, { complete = null, limit = BATCH_CHARS, maxCalls = Infinity, onEvents = null, localCut = null } = {}) {
  if (!day) return { ok: false, reason: 'no-day', day }
  let usable = false
  try { usable = !!model.capabilities().complete } catch { usable = false }
  const callModel = complete || (usable ? (req) => model.complete(req) : null)
  // 只有 work 段能完全靠本地；daily 仍要主模型。
  const hasLocal = typeof localCut === 'function' || localCutOn(db)
  if (!callModel && !hasLocal) return { ok: false, reason: 'no-model', day }

  const { rows, clean } = loadCleanRowsWithMode(db, aid, day)
  const segs = toSegments(clean)
  const chunks = []
  for (const seg of segs) {
    for (const run of splitRunsByMode(seg)) {
      for (const c of chunkByChars(run.rows, limit)) chunks.push({ mode: run.mode, rows: c })
    }
  }

  const posFlag = `events.cut.${day}.pos`
  const savedPos = String(getFlag(db, posFlag) || '')
  let startIdx = 0
  if (savedPos) {
    // 进度存的是「最后切完那一块的最后一轮」：找到它所在的块，从下一块续。
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].rows.some((r) => String(r.turn_id || r.id) === savedPos)) { startIdx = i + 1; break }
    }
  }

  let calls = 0
  let stopped = null
  const results = []

  /**
   * 切一块；空回且这块还够长，就对半再切（和逐件模式同样的「砍半重试」）。
   * 进度只在「整块切完」时存，避免断了以后从半块中间续（重切一块的代价可以接受，幂等兜得住）。
   * 返回 { stop:true } 表示没切成、别再往后走。
   */
  async function processChunk(c, i, { savePos = true } = {}) {
    const body = chunkBody(c.rows)
    const textAll = c.rows.map((r) => String(r.text || '')).join('\n')
    const turnSet = new Set(c.rows.map((r) => r.turn_id).filter(Boolean))
    let raw = ''
    let lastErr = null
    let usedLocal = false
    let localMs = 0
    // work 段先走本地（开关默认 off；注入 localCut 时按注入走）。失败/空回 → 回退主模型。
    const wantLocal = c.mode === 'work' && (typeof localCut === 'function' || localCutOn(db))
    if (wantLocal) {
      try {
        const out = await (typeof localCut === 'function' ? localCut : (req) => localComplete(db, req))({
          system: WORK_SYSTEM,
          text: body,
          maxTokens: WORK_MAX_TOKENS,
        })
        raw = String((out && out.text) || out || '')
        localMs = Number(out && out.ms) || 0
        usedLocal = !!String(raw).trim()
      } catch (e) { lastErr = String((e && e.message) || e).slice(0, 200) }
    }
    // work 本地试过但没回：不花主模型的钱，直接走词法（读碎片现拼摘要）。
    let lexicalPack = null
    if (wantLocal && !String(raw).trim() && c.mode === 'work') lexicalPack = lexicalDigest(c.rows)

    if (!String(raw).trim() && !lexicalPack) {
      if (calls >= maxCalls) { stopped = 'cap'; return { stop: true } }
      raw = ''
      if (callModel) {
        try {
          raw = String(await callModel({
            system: c.mode === 'work' ? WORK_SYSTEM : DAILY_BATCH_SYSTEM,
            text: body,
            maxTokens: c.mode === 'work' ? WORK_MAX_TOKENS : 5000,
          }) || '')
        } catch (e) { lastErr = String((e && e.message) || e).slice(0, 200) }
      }
      calls++
    }

    // daily 主模型失败/空回：本地逐件兜底（低信心，但比丢掉一天强）。
    let fallbackEvents = null
    if (!String(raw).trim() && c.mode !== 'work' && localDailyFallbackOn(db)) {
      try {
        const evs = await localDailyEvents(db, c.rows, typeof localCut === 'function' ? localCut : (req) => localComplete(db, req))
        if (evs.length) fallbackEvents = evs
      } catch (e) { lastErr = String((e && e.message) || e).slice(0, 200) }
    }

    if (!raw && !fallbackEvents && !lexicalPack) {
      // 空回不是「没有」：这块还够长就砍半再试（大块最容易空）。2026-11-13 10-27 实测：92 行一块直接空回。
      if (c.rows.length > 4) {
        const mid = Math.max(2, Math.floor(c.rows.length / 2))
        const r1 = await processChunk({ mode: c.mode, rows: c.rows.slice(0, mid) }, i, { savePos: false })
        if (r1.stop) return r1
        const r2 = await processChunk({ mode: c.mode, rows: c.rows.slice(mid) }, i, { savePos: false })
        if (r2.stop) return r2
        if (savePos) {
          const last = c.rows[c.rows.length - 1]
          try { setFlag(db, posFlag, String(last.turn_id || last.id)) } catch { /* 下一轮重切这块 */ }
        }
        return { stop: false }
      }
      results.push({ chunk: i, mode: c.mode, rows: c.rows.length, empty: true, error: lastErr })
      return { stop: true }
    }

    let events = []
    if (fallbackEvents) {
      // 本地兜底：低信心，weight 压到 ≤0.35；日期已由时间门兜过
      events = fallbackEvents.map((ev) => ({ ...ev, weight: Math.min(Number(ev.weight) || 0.3, 0.35), quality: 'local_fallback' }))
    } else if (c.mode === 'work') {
      const ev = lexicalPack
        ? makeWorkEvent(lexicalPack, c.rows, 'lexical')
        : makeWorkEvent(parseJsonObject(raw), c.rows, 'local')
      if (ev) events = [ev]
    } else {
      const arr = parseJsonArray(raw) || []
      events = arr.slice(0, BATCH_MAX_EVENTS)
        .map((ev) => {
          const c2 = checkBatchEvent(ev, textAll, turnSet, c.rows)
          return c2 ? { ...c2, quality: 'model' } : null
        })
        .filter(Boolean)
    }
    if (onEvents && events.length) {
      try {
        await onEvents(events, { chunk: i, mode: c.mode, rows: c.rows })
      } catch (e) {
        results.push({ chunk: i, mode: c.mode, rows: c.rows.length, events: 0, writeError: String((e && e.message) || e).slice(0, 200) })
        return { stop: true }
      }
    }
    if (savePos) {
      const last = c.rows[c.rows.length - 1]
      try { setFlag(db, posFlag, String(last.turn_id || last.id)) } catch { /* 进度没存上：下一轮重切这块，靠幂等兜 */ }
    }
    results.push({ chunk: i, mode: c.mode, rows: c.rows.length, events: events.length, local: usedLocal, localMs, fallbackLocal: !!fallbackEvents, lexical: !!lexicalPack, rawHead: raw.slice(0, 200), error: lastErr })
    return { stop: false }
  }

  for (let i = startIdx; i < chunks.length; i++) {
    const r = await processChunk(chunks[i], i)
    if (r.stop) break
  }

  const lastOk = results.length && !results[results.length - 1].empty && !results[results.length - 1].writeError
  const finished = lastOk && results[results.length - 1].chunk === chunks.length - 1
  return {
    ok: true, at: now(), day,
    rows: rows.length, clean: clean.length, chunks: chunks.length,
    startedAt: startIdx, calls, stopped, finished,
    localCalls: results.filter((r) => r.local).length,
    fallbackCalls: results.filter((r) => r.fallbackLocal).length,
    lexicalCalls: results.filter((r) => r.lexical).length,
    events: results.reduce((n, r) => n + Number(r.events || 0), 0),
    results,
    note: '按 mode 分段、按字数切块；每块落库后才存进度，断了从断点续。',
  }
}

// 供 event_write 用：把 batch 里 work/daily 的标准也导出去，方便以后改一处。
export { DAILY_BATCH_SYSTEM, WORK_SYSTEM, BATCH_CHARS, BATCH_MAX_EVENTS }
