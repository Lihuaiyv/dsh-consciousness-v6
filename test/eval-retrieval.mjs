/**
 * 检索离线评估：真 NDCG / Recall，不再拿别的指标冒充。
 *
 * 用法：
 *   node test/eval-retrieval.mjs                 用内置示例标注，跑当前库
 *   node test/eval-retrieval.mjs 我的标注.jsonl   用自己的标注
 *   node test/eval-retrieval.mjs --dump          从 retrieval_log 导出 query 清单（must 留空，供你填）
 *
 * 标注格式（一行一个 JSON）：
 *   {"query":"小周最近怎么样","must":["篮球","城东"]}
 *
 * 判定：某条召回文本包含 must 里某个子串 → 这条对该子串是相关的。
 * 只读打开数据库（retrieve 本身不写库，touch 在 index.js 里）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { retrieve } from '../src/modules/retrieve.js'

const DB = path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'consciousness', 'app.db')
const arg = process.argv[2] || ''

function dumpQueries(db) {
  const rows = db.prepare("SELECT query, COUNT(*) n, SUM(items) hits FROM retrieval_log WHERE query<>'' GROUP BY query ORDER BY n DESC LIMIT 100").all()
  const lines = rows.map((r) => JSON.stringify({ query: r.query, must: [], seen: Number(r.n), hits: Number(r.hits) || 0 }))
  console.log(lines.join('\n'))
  console.error('\n共 ' + rows.length + ' 条 query。填好 must 后：node test/eval-retrieval.mjs 文件名.jsonl')
  return []
}

const EXAMPLES = [
  { query: '记忆仓库', must: ['记忆', '仓库'] },
  { query: '关系图', must: ['关系'] },
  { query: '咖啡', must: ['咖啡'] },
]
if (!fs.existsSync(DB)) {
  console.error('找不到数据库：' + DB)
  process.exit(1)
}
const db = new DatabaseSync(DB, { readOnly: true })
if (arg === '--dump') {
  dumpQueries(db)
  db.close()
  process.exit(0)
}

let labels = EXAMPLES
if (arg) {
  if (!fs.existsSync(arg)) { console.error('标注文件不存在：' + arg); process.exit(1) }
  labels = fs.readFileSync(arg, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}
const K = 6
const agent = db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY COALESCE(last_interaction_at, created_at) DESC LIMIT 1").get()
if (!agent) { console.error('没有活跃意识体'); process.exit(1) }

function dcg(gains) {
  return gains.reduce((s, g, i) => s + (i < K ? g / Math.log2(i + 2) : 0), 0)
}
function idealDcg(n) {
  return dcg(Array.from({ length: n }, () => 1))
}

let sumNdcg = 0
let sumRecall = 0
let empty = 0
const rows = []
for (const lab of labels) {
  const must = (lab.must || []).filter(Boolean)
  if (!lab.query || !must.length) { rows.push({ q: lab.query, skip: true }); continue }
  const r = retrieve(db, agent.id, lab.query, { k: K, floor: 0 })
  const texts = r.items.map((x) => String(x.text || ''))
  // 每个 must 只记一次分：同一主题被多条命中不重复加分，否则 NDCG 会 >1
  const coveredSet = new Set()
  const gains = texts.map((t) => {
    let hit = 0
    for (const m of must) {
      if (!coveredSet.has(m) && t.includes(m)) { coveredSet.add(m); hit = 1 }
    }
    return hit
  })
  const ndcg = idealDcg(must.length) > 0 ? dcg(gains) / idealDcg(must.length) : 0
  const recall = must.length ? coveredSet.size / must.length : 0
  if (!r.items.length) empty++
  sumNdcg += ndcg
  sumRecall += recall
  rows.push({ q: lab.query, scene: r.scene, n: r.items.length, covered: coveredSet.size, must: must.length, ndcg: +ndcg.toFixed(3), recall: +recall.toFixed(3) })
}

const valid = rows.filter((x) => !x.skip)
console.log(JSON.stringify(rows, null, 2))
console.log('\n== 汇总 ==')
console.log('query 数:', valid.length, ' 空手:', empty)
console.log('Recall@' + K + ':', valid.length ? (sumRecall / valid.length).toFixed(3) : 'n/a')
console.log('NDCG@' + K + ':', valid.length ? (sumNdcg / valid.length).toFixed(3) : 'n/a')
db.close()
