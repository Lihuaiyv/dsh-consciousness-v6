#!/usr/bin/env node
/**
 * 实验 A2：把「反思摘要模板」剥掉再算余弦。
 *
 * 背景：实验 A 发现高余弦主要来自模板骨架——「1. **事实**：用户… 2. **偏好**：用户…」
 * 每条反思都是这个骨架，所以「朋友叫小小」和「朋友叫小绿」也能到 0.87。
 * 这不是 cosine 不行，是语料被模板污染了。
 *
 * 这个脚本对同一批候选算两遍：原样余弦 / 剥模板后余弦，并排打印。
 *
 * 用法：node scripts/exp-sameness-strip.mjs [--n 40] [--db <path>]
 */
import { DatabaseSync } from 'node:sqlite'
import { stampRow, topicOfFactKey, related } from '../src/modules/passport.js'
import { model } from '../src/kernel.js'

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const N = Number(arg('n', '40')) || 40
const dbPath = arg('db', (process.env.DSH_DB || (process.env.DSH_HOME || 'C:/Users/l/.dsh').replace(/\\/g, '/') + '/consciousness/app.db'))

const db = new DatabaseSync(dbPath, { readOnly: true })
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get('小汐').id

/**
 * 剥掉摘要模板：编号、加粗、角色前缀、「事实/偏好/情绪/边界」这些小标题。
 * 只留实际内容。剥完太短（< 8 字）就退回原文——宁可留着骨架，也别变成空串。
 */
export function stripTemplate(text) {
  const raw = String(text || '')
  let t = raw
    .replace(/\*\*/g, '')
    .replace(/^\s*\d+[.、)]\s*/gm, ' ')
    .replace(/\d+[.、)]\s*(?=[\u4e00-\u9fff])/g, ' ')
    .replace(/(用户|助手|对方|我)(的)?\s*(事实|偏好|情绪|边界|情绪与偏好|偏好与情绪|偏好与情绪倾向)\s*[:：]/g, ' ')
    .replace(/(事实|偏好|情绪|边界|情绪与偏好|偏好与情绪|语气|关注点)\s*[:：]/g, ' ')
    .replace(/用户(正在|只|当前|明确|表示|反馈|提到|询问|要求|希望|关注)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 剩下的都是分隔符 / 单字：说明原文本来就不是模板体，别硬剥
  if (t.replace(/[，。、；：,.;:\s]/g, '').length < 8) t = raw.replace(/\*\*/g, '').trim()
  return t
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!na || !nb) return null
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const cache = new Map()
async function vecOf(key, text) {
  if (cache.has(key)) return cache.get(key)
  try {
    const out = await model.embed([String(text || '').slice(0, 500)])
    const arr = Array.isArray(out) ? (Array.isArray(out[0]) ? out[0] : out) : []
    const f = arr.length ? Float32Array.from(arr, Number) : null
    cache.set(key, f)
    return f
  } catch { cache.set(key, null); return null }
}

const rows = db.prepare(`SELECT * FROM memory_items
  WHERE agent_id=? AND status='active' AND invalid_at IS NULL ORDER BY created_at`).all(aid)
const laterStmt = db.prepare(`SELECT id, text, fact_key, created_at FROM memory_items
  WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND id<>?
    AND fact_key IS NOT NULL AND fact_key LIKE ? AND created_at>?
  ORDER BY created_at DESC LIMIT 1`)

const pairs = []
for (const r of rows) {
  const s = stampRow(db, aid, r)
  if (!s.weakLater) continue
  const topic = topicOfFactKey(r.fact_key)
  if (!topic) continue
  let later = null
  try { later = laterStmt.get(aid, r.id, '%' + topic + '%', r.created_at) } catch { later = null }
  if (!later || !related(r.text, later.text)) continue
  pairs.push({ old: r, later })
  if (pairs.length >= N) break
}

const out = []
for (const p of pairs) {
  const oRaw = String(p.old.text || '')
  const nRaw = String(p.later.text || '')
  const oStrip = stripTemplate(oRaw)
  const nStrip = stripTemplate(nRaw)
  const cRaw = cosine(await vecOf(p.old.id + ':raw', oRaw), await vecOf(p.later.id + ':raw', nRaw))
  const cStrip = cosine(await vecOf(p.old.id + ':strip', oStrip), await vecOf(p.later.id + ':strip', nStrip))
  out.push({
    oldId: p.old.id, newId: p.later.id,
    oldType: p.old.type, newType: p.later.type,
    cosRaw: cRaw == null ? null : Number(cRaw.toFixed(4)),
    cosStrip: cStrip == null ? null : Number(cStrip.toFixed(4)),
    delta: cRaw != null && cStrip != null ? Number((cStrip - cRaw).toFixed(4)) : null,
    oldText: oRaw.replace(/\s+/g, ' ').slice(0, 60),
    newText: nRaw.replace(/\s+/g, ' ').slice(0, 60),
    oldStrip: oStrip.slice(0, 50),
  })
}

// 剥模板有没有真把「内容不同」的对压下去？看 delta 的分布
const withBoth = out.filter((x) => x.cosRaw != null && x.cosStrip != null)
const avg = (arr) => arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(4)) : null
const rawVals = withBoth.map((x) => x.cosRaw)
const stripVals = withBoth.map((x) => x.cosStrip)
const std = (v) => {
  if (!v.length) return null
  const m = v.reduce((a, b) => a + b, 0) / v.length
  return Number(Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length).toFixed(4))
}

console.log('== 实验 A2：剥掉模板后再算余弦 ==')
console.log('对:', withBoth.length)
console.log('原样   : avg=' + avg(rawVals), 'std=' + std(rawVals), 'min=' + Math.min(...rawVals), 'max=' + Math.max(...rawVals))
console.log('剥模板 : avg=' + avg(stripVals), 'std=' + std(stripVals), 'min=' + Math.min(...stripVals), 'max=' + Math.max(...stripVals))
console.log('平均变化:', avg(withBoth.map((x) => x.delta)))
console.log('')
console.log('--- 逐对（原样 → 剥后）---')
const sorted = withBoth.slice().sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))
for (const x of sorted) {
  console.log('[' + x.cosRaw + ' → ' + x.cosStrip + ']', '(' + x.oldType + '→' + x.newType + ')')
  console.log('  旧剥后:', x.oldStrip)
  console.log('  新原句:', x.newText)
}
db.close()
