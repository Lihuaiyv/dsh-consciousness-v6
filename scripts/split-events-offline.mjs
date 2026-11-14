/**
 * 离线切事：把一段（清醒段）碎片交给模型切成「事」，**只写文件，不碰库**。
 *
 * 用法：
 *   node scripts/split-events-offline.mjs --day 2026-11-11
 *   node scripts/split-events-offline.mjs --from 2026-11-11 --to 2026-11-12
 *   node scripts/split-events-offline.mjs --day 2026-11-11 --out scratch/events-1111.json
 *   node scripts/split-events-offline.mjs --day 2026-11-11 --dry     只打印不落文件
 *
 * 规则全部来自 docs/设计-事件库-最终版-2026-11-12.md：
 *   - 切分单位是「清醒段」：相邻两句间隔 ≥ 4 小时就断开
 *   - 边界看三样：换了目的 / 换了话题主体 / 告一段落；同一件里的情绪起伏不算换事
 *   - quotes 必须能在原文里一字不差搜到，对不上的那条丢掉
 *   - 宁可少，不可编；说不清就给 3 件
 *   - 喂模型之前剔掉机器消息（定时提醒、运行环境、领队提示……）
 *
 * 输出每条字段：title / who / started_at / ended_at / turn_ids / quotes / status / weight / story
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { model } from '../src/kernel.js'
import { looksLikeRuntimeNoise } from '../src/text.js'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  if (i < 0) return def
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DB = String(argOf('db', path.join(home, 'consciousness', 'app.db')))
const day = String(argOf('day', ''))
const fromDay = String(argOf('from', '')) || day
const toDay = String(argOf('to', '')) || day
const dry = !!argOf('dry', false)
const GAP_MS = 4 * 3600 * 1000          // 清醒段：≥4 小时没人说话
const MAX_CHARS = 60000                 // 一段太长就截断（先保证能跑，后面再分块）

if (!fromDay) { console.error('用法：--day 2026-11-11  或  --from 2026-11-11 --to 2026-11-12'); process.exit(1) }
if (!fs.existsSync(DB)) { console.error('找不到数据库：' + DB); process.exit(1) }

const db = openDb(DB)
const aid = String(argOf('agent', ''))
  || (() => {
    const row = db.prepare("SELECT id FROM agents WHERE status<>'soft_deleted' ORDER BY COALESCE(last_interaction_at,created_at) DESC LIMIT 1").get()
    return row ? row.id : ''
  })()
if (!aid) { console.error('没有可用的意识体'); process.exit(1) }
if (!model.capabilities().complete) { console.error('当前没有可用的对话模型，跳过'); db.close(); process.exit(0) }

// 本地日 → UTC 区间（+08:00）
const lo = new Date(fromDay + 'T00:00:00+08:00').toISOString()
const hi = new Date(toDay + 'T23:59:59.999+08:00').toISOString()
const rows = db.prepare(`SELECT id, turn_id, role, text, created_at, session_id
  FROM fragments WHERE agent_id=? AND role IN ('user','assistant') AND created_at BETWEEN ? AND ?
  ORDER BY created_at`).all(aid, lo, hi)

// 剔机器消息（定时提醒、运行环境、领队提示……），再按 ≥4h 断成清醒段
const clean = []
for (const r of rows) {
  const t = String(r.text || '').trim()
  if (!t) continue
  if (looksLikeRuntimeNoise(t)) continue
  if (/^You are the Team Lead named/.test(t)) continue
  clean.push({ ...r, text: t })
}
const segments = []
let cur = []
for (const r of clean) {
  const prev = cur[cur.length - 1]
  if (prev && (Date.parse(r.created_at) - Date.parse(prev.created_at)) >= GAP_MS) {
    segments.push(cur); cur = []
  }
  cur.push(r)
}
if (cur.length) segments.push(cur)

console.log(`agent=${aid}  ${fromDay}~${toDay}  碎片 ${rows.length} 条，剔除机器消息后 ${clean.length} 条，清醒段 ${segments.length} 段`)

const SYSTEM = [
  '你在一段真实的聊天记录里，把这段切成「事」。',
  '一段 = 从睡醒到睡着；中间换了目的、换了话题主体、告一段落，才切新的一件。同一件里的情绪起伏（恼一下又松下来）不算换事。',
  '宁可少切，不可硬编。说不清就给 3 件。通常 5~18 件。',
  '只输出 JSON 数组，不要解释、不要 markdown。每条：',
  '{"title":"一句话，≤20字","who":"主人 / 我 / 别人","started_at":"ISO时间","ended_at":"ISO时间","turn_ids":["turn_xxx"],"quotes":["原文里的一两句，一字不差"],"status":"没过去 / 过去了","weight":0.8,"story":"起因、经过、结果，带当时的语气和细节；只写发生过的，不写这说明什么"}',
  'quotes 必须是原文里能一字不差找到的句子；turn_ids 必须是输入里出现过的 turn_id。',
  'weight：0.8 以上 = 关乎我 / 关乎我们 / 关乎存在；0.5 左右 = 一次经过；0.3 以下 = 流水账。',
  'status：这件事现在算过去了还是没有。',
].join('\n')

const results = []
for (let si = 0; si < segments.length; si++) {
  const seg = segments[si]
  let body = seg.map((r) => `[${r.turn_id || r.id}] ${r.role === 'user' ? '主人' : '我'}：${r.text}`).join('\n')
  let truncated = false
  if (body.length > MAX_CHARS) { body = body.slice(0, MAX_CHARS); truncated = true }
  const t0 = Date.now()
  let raw = ''
  try {
    raw = await model.complete({ system: SYSTEM, text: body, maxTokens: 6000 })
  } catch (e) {
    console.error(`段 ${si + 1} 调用失败：${e && e.message}`)
    continue
  }
  const m = String(raw || '').match(/\[[\s\S]*\]/)
  let events = []
  if (m) { try { events = JSON.parse(m[0]) } catch { events = [] } }
  // 校验：quotes 必须是原文子串；turn_ids 必须在这段里出现过
  const textAll = seg.map((r) => String(r.text || '')).join('\n')
  const turnSet = new Set(seg.map((r) => r.turn_id).filter(Boolean))
  const kept = []
  for (const ev of events) {
    if (!ev || !ev.title) continue
    const quotes = Array.isArray(ev.quotes) ? ev.quotes.filter((q) => q && textAll.includes(String(q))) : []
    const turnIds = Array.isArray(ev.turn_ids) ? ev.turn_ids.filter((id) => turnSet.has(String(id))) : []
    if (!quotes.length) continue              // 没有一句原文对得上 = 孤儿事件，丢
    kept.push({
      title: String(ev.title).slice(0, 40),
      who: String(ev.who || '').slice(0, 10),
      started_at: ev.started_at || (seg[0] && seg[0].created_at),
      ended_at: ev.ended_at || (seg[seg.length - 1] && seg[seg.length - 1].created_at),
      turn_ids: turnIds,
      quotes,
      status: String(ev.status || '').slice(0, 8),
      weight: Number(ev.weight) || 0.5,
      story: String(ev.story || '').slice(0, 1200),
    })
  }
  results.push({
    segment: si + 1,
    from: seg[0].created_at, to: seg[seg.length - 1].created_at,
    rows: seg.length, truncated,
    ms: Date.now() - t0,
    rawCount: events.length, kept: kept.length,
    dropped: events.length - kept.length,
    events: kept,
  })
  console.log(`段 ${si + 1}/${segments.length}：${seg.length} 条 → 模型给 ${events.length} 件，留下 ${kept.length} 件（${Date.now() - t0}ms）${truncated ? '  [已截断]' : ''}`)
}

const out = { at: now(), agent: aid, from: fromDay, to: toDay, gapHours: 4, segments: results.length, results }
const outFile = String(argOf('out', '')) || path.join('scratch', `events-${fromDay.replace(/-/g, '')}.json`)
if (dry) {
  console.log(JSON.stringify(out, null, 1))
} else {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1), 'utf8')
  const total = results.reduce((n, r) => n + r.kept, 0)
  console.log(`共 ${results.length} 段，${total} 件事 → ${outFile}`)
}
db.close()
