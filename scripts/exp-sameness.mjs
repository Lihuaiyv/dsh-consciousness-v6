#!/usr/bin/env node
/**
 * 实验 A：嵌入相似度 vs 2-gram，谁更能认出「同一件事」。
 *
 * 只读 + 只调用 embed（不写库外的东西）。输出 40 对候选给人工判读。
 * 用法：node scripts/exp-sameness.mjs [--n 40] [--db <path>]
 */
import { DatabaseSync } from 'node:sqlite'
import { stampRow, topicOfFactKey, related, bigrams } from '../src/modules/passport.js'
import { model } from '../src/kernel.js'

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const N = Number(arg('n', '40')) || 40
const dbPath = arg('db', (process.env.DSH_DB || (process.env.DSH_HOME || 'C:/Users/l/.dsh').replace(/\\/g, '/') + '/consciousness/app.db'))

const db = new DatabaseSync(dbPath, { readOnly: true })
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get('小汐').id

// 已有向量：Uint8Array(4096) = 1024 × float32
const vecBy = new Map()
try {
  for (const r of db.prepare('SELECT memory_id, dim, vec FROM memory_vec WHERE agent_id=?').all(aid)) {
    try {
      const f = new Float32Array(r.vec.buffer, r.vec.byteOffset, Number(r.dim) || 1024)
      vecBy.set(r.memory_id, Float32Array.from(f))
    } catch { /* 单条坏了不挡整体 */ }
  }
} catch { /* 老库没有向量表 */ }

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!na || !nb) return null
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function vecOf(id, text) {
  if (vecBy.has(id)) return vecBy.get(id)
  try {
    const out = await model.embed([String(text || '').slice(0, 500)])
    const arr = Array.isArray(out) ? (Array.isArray(out[0]) ? out[0] : out) : []
    if (!arr.length) return null
    const f = Float32Array.from(arr, Number)
    vecBy.set(id, f)
    return f
  } catch { return null }
}

/** 两条正文共享多少个 2-gram（passport 里 related 用的是 ≥3）。 */
function gramHits(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return n
}

// 候选：同主题 + 2-gram 过线 + key 不同（= 现在被判成 weakLater 的那些）
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
  const va = await vecOf(p.old.id, p.old.text)
  const vb = await vecOf(p.later.id, p.later.text)
  out.push({
    oldId: p.old.id,
    newId: p.later.id,
    oldType: p.old.type,
    newType: p.later.type,
    gram: gramHits(p.old.text, p.later.text),
    cos: va && vb ? Number(cosine(va, vb).toFixed(4)) : null,
    oldText: String(p.old.text || '').replace(/\s+/g, ' ').slice(0, 70),
    newText: String(p.later.text || '').replace(/\s+/g, ' ').slice(0, 70),
  })
}

// 分布先看：余弦排序后打印，人工判读时从两头看更省力
const withCos = out.filter((x) => x.cos != null).sort((a, b) => b.cos - a.cos)
const missing = out.length - withCos.length
const stat = (arr) => {
  if (!arr.length) return null
  const v = arr.map((x) => x.cos)
  return { n: v.length, max: Math.max(...v), min: Math.min(...v), avg: Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)) }
}

console.log('== 实验 A：同一件事判定 ==')
console.log('候选对:', out.length, '| 有向量:', withCos.length, '| 缺向量:', missing)
console.log('余弦分布:', JSON.stringify(stat(withCos)))
const buckets = { '>=0.9': 0, '0.8-0.9': 0, '0.7-0.8': 0, '0.6-0.7': 0, '<0.6': 0 }
for (const x of withCos) {
  if (x.cos >= 0.9) buckets['>=0.9']++
  else if (x.cos >= 0.8) buckets['0.8-0.9']++
  else if (x.cos >= 0.7) buckets['0.7-0.8']++
  else if (x.cos >= 0.6) buckets['0.6-0.7']++
  else buckets['<0.6']++
}
console.log('分桶:', JSON.stringify(buckets))
console.log('')
console.log('--- 按余弦从高到低（人工判读用）---')
for (const x of withCos) {
  console.log('[' + x.cos + '] gram=' + x.gram, '|', x.oldType, '→', x.newType)
  console.log('  旧:', x.oldText)
  console.log('  新:', x.newText)
}
if (missing) console.log('\n（缺向量的 ' + missing + ' 对没打印）')
db.close()
