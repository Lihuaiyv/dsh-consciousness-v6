/**
 * 用模型打分，和人工标注比（软分布 + 硬 κ）
 *
 *   DSHC_MODEL_URL=... DSHC_MODEL_KEY=... node scripts/score-model-soft.mjs [merged-v2.csv] [--limit N]
 *
 * 规则基线（merged-v2，200 条）：硬 κ 0.403、JS 0.526、余弦 0.560。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModel } from '../src/model.js'
import { cohenKappa } from '../src/algo/kappa.js'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '标注数据')
const KEYS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
const ZH = { joy: '愉悦', peaceful: '安心', curious: '好奇', calm: '平静', confused: '困惑', lost: '失落', irritated: '烦躁', frustrated: '挫败' }
const Z = Object.fromEntries(Object.entries(ZH).map(([k, v]) => [v, k]))

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    else out._.push(a)
  }
  return out
}
function parseCsv(text) {
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const head = rows.shift()
  return rows.filter((r) => r[0]).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] || ''])))
}
const mode = (vals) => {
  const c = {}
  for (const v of vals) if (v && Z[v]) c[v] = (c[v] || 0) + 1
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])
  if (!top.length) return ''
  return top[1] && top[1][1] === top[0][1] ? '' : top[0][0]
}

const args = parseArgs(process.argv.slice(2))
const file = args._[0] || path.join(DATA, 'merged-v2.csv')
if (!fs.existsSync(file)) { console.error('找不到标注文件：' + file); process.exit(1) }
const model = createModel()
const st = model.status()
if (st.primary !== 'ok') {
  console.error('没有可用模型。设置 DSHC_MODEL_URL / DSHC_MODEL_KEY（本地 Ollama 免 key）。')
  console.error('当前状态：' + JSON.stringify(st))
  process.exit(1)
}

const rows = parseCsv(fs.readFileSync(file, 'utf8')).slice(0, args.limit ? Number(args.limit) : undefined)
const sys = [], gold = [], sysScores = [], hums = []
let failed = 0
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]
  let scores = null
  try {
    const res = await model.appraise(r.text)
    scores = res.scores || null
  } catch { failed++ }
  const p = {}
  for (const k of KEYS) p[k] = scores ? Math.max(0, Number(scores[k]) || 0) : 1 / KEYS.length
  if (!scores) for (const k of KEYS) p[k] = 1 / KEYS.length
  sysScores.push(p)
  sys.push(ZH[KEYS.reduce((b, k) => (p[k] > p[b] ? k : b), 'calm')])
  gold.push(mode([r.label_a, r.label_b, r.label_c]))
  const h = {}
  for (const k of KEYS) h[k] = 0
  const vals = [r.label_a, r.label_b, r.label_c].filter((x) => Z[x])
  for (const v of vals) h[Z[v]] += 1 / vals.length
  hums.push(vals.length ? h : null)
  if ((i + 1) % 25 === 0) process.stderr.write(`  ${i + 1}/${rows.length}\n`)
}

let js = 0, cos = 0, n = 0
for (let i = 0; i < rows.length; i++) {
  if (!hums[i]) continue
  let s = 0, d = 0, np = 0, nq = 0
  for (const k of KEYS) {
    const a = sysScores[i][k], b = hums[i][k]
    const m = (a + b) / 2
    if (a > 0) s += 0.5 * a * Math.log2(a / m)
    if (b > 0) s += 0.5 * b * Math.log2(b / m)
    d += a * b; np += a * a; nq += b * b
  }
  js += s; cos += np && nq ? d / Math.sqrt(np * nq) : 0; n++
}
const k = cohenKappa(sys, gold)
console.log('样本', rows.length, '模型失败', failed)
console.log('硬 κ（argmax vs 多数票）:', k.kappa, '（规则 0.403）')
console.log('平均 JS 散度:', (js / n).toFixed(3), '（规则 0.526，越小越好）')
console.log('平均余弦:', (cos / n).toFixed(3), '（规则 0.560，越大越好）')
