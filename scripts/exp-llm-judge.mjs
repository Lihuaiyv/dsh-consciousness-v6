#!/usr/bin/env node
/**
 * 实验 B：让模型判「这两条是不是同一件事」。
 *
 * 背景：cosine 在这个语料上分不开（「小小 vs 小绿」0.867）。要回答的是——
 * 这是「相似度不行」，还是「模型也判不了」？
 *
 * 注意：本机 ollama 的 gemma4:12b 是 thinking 模型，走 OpenAI 兼容层
 * （/v1/chat/completions）时会把 token 全花在思考上、content 返回空。
 * 走原生 /api/chat 并 think:false 才拿得到正文，所以这里直连原生端点，
 * 不经过插件的 model.complete。
 *
 * 用法：
 *   node scripts/exp-llm-judge.mjs [--n 12] [--url http://127.0.0.1:11434] [--model gemma4:12b]
 */
import { DatabaseSync } from 'node:sqlite'
import { stampRow, topicOfFactKey, related } from '../src/modules/passport.js'
import { dbPath as defaultDbPath } from '../src/paths.js'

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const N = Number(arg('n', '12')) || 12
const dbPath = arg('db', defaultDbPath())
const base = String(arg('url', 'http://127.0.0.1:11434')).replace(/\/$/, '')
const modelName = arg('model', 'gemma4:12b')

const SYS = [
  '你在判断两条记忆之间是什么关系。',
  '只输出三个词之一，不要解释，不要 JSON，不要标点：',
  '同一件事 —— 后一条是前一条的进展、补充或改口（说的是同一个问题）',
  '不同的事 —— 两条只是共用了一些词，实际在说不同的事',
  '不确定 —— 拿不准',
].join('\n')

async function judge(system, text) {
  const t0 = Date.now()
  const r = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
      stream: false,
      think: false,
      options: { num_predict: 60, temperature: 0 },
    }),
  })
  const j = await r.json()
  const content = String((j.message && j.message.content) || '').trim()
  return { content, ms: Date.now() - t0 }
}

function normJudge(raw) {
  const t = String(raw || '')
  if (/同一件事/.test(t)) return '同一件事'
  if (/不同的事|不同的|无关/.test(t)) return '不同的事'
  if (/不确定|拿不准/.test(t)) return '不确定'
  return '（无法解析）' + t.slice(0, 24)
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get('小汐').id

const vecBy = new Map()
try {
  for (const r of db.prepare('SELECT memory_id, dim, vec FROM memory_vec WHERE agent_id=?').all(aid)) {
    try { vecBy.set(r.memory_id, Float32Array.from(new Float32Array(r.vec.buffer, r.vec.byteOffset, Number(r.dim) || 1024))) } catch { /* 坏的跳过 */ }
  }
} catch { /* 没向量表 */ }
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : null
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
  const c = cosine(vecBy.get(r.id), vecBy.get(later.id))
  pairs.push({ old: r, later, cos: c == null ? null : Number(c.toFixed(3)) })
  if (pairs.length >= 200) break
}

// 固定抽样：按余弦降序（null 排最后），等距取 N 条
pairs.sort((a, b) => (b.cos ?? -1) - (a.cos ?? -1))
const gap = Math.max(1, Math.floor(pairs.length / N))
const picked = []
for (let i = 0; i < pairs.length && picked.length < N; i += gap) picked.push(pairs[i])

console.log('== 实验 B：模型判同一件事 ==')
console.log('候选总数:', pairs.length, '| 抽样:', picked.length, '| 模型:', modelName, '| 端点:', base + '/api/chat')
console.log('')

const results = []
for (let i = 0; i < picked.length; i++) {
  const p = picked[i]
  const text = '旧：' + String(p.old.text || '').replace(/\s+/g, ' ').slice(0, 180)
    + '\n新：' + String(p.later.text || '').replace(/\s+/g, ' ').slice(0, 180)
  let raw = ''
  let ms = 0
  try { const r = await judge(SYS, text); raw = r.content; ms = r.ms } catch (e) { raw = 'ERR ' + String(e && e.message || e).slice(0, 40) }
  const judgeWord = normJudge(raw)
  results.push({ i, cos: p.cos, judge: judgeWord, raw, ms })
  console.log('#' + (i + 1) + ' cos=' + p.cos + ' | 模型=' + judgeWord + ' | ' + ms + 'ms')
  console.log('  旧:', String(p.old.text || '').replace(/\s+/g, ' ').slice(0, 92))
  console.log('  新:', String(p.later.text || '').replace(/\s+/g, ' ').slice(0, 92))
}

const tally = {}
for (const r of results) tally[r.judge] = (tally[r.judge] || 0) + 1
console.log('')
console.log('判断分布:', JSON.stringify(tally))
console.log('平均耗时:', Math.round(results.reduce((s, r) => s + r.ms, 0) / Math.max(1, results.length)) + 'ms')
db.close()
