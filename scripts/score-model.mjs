/**
 * 用模型打分，和人工标注比 κ（情绪 κ 的「模型版」回归）
 *
 *   DSHC_MODEL_URL=... DSHC_MODEL_KEY=... node scripts/score-model.mjs [file.csv] [--write] [--limit N]
 *
 * 规则适配器的基线是 0.364（merged-v2，系统 vs 多数票），这个脚本用来验证「换模型能不能到 0.60」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createModel } from '../src/model.js'
import { cohenKappa, fleissKappa } from '../src/algo/kappa.js'

const LAB = { joy: '愉悦', peaceful: '安心', curious: '好奇', calm: '平静', confused: '困惑', lost: '失落', irritated: '烦躁', frustrated: '挫败' }

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
const major = (v) => {
  const c = {}
  for (const x of v) if (x && x !== '跳过') c[x] = (c[x] || 0) + 1
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])
  if (!top.length) return ''
  if (top[1] && top[1][1] === top[0][1]) return ''
  return top[0][0]
}

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '标注数据')
const args = parseArgs(process.argv.slice(2))
const file = args._[0] || path.join(DATA, 'merged-v2.csv')
if (!fs.existsSync(file)) { console.error('找不到标注文件：' + file); process.exit(1) }

const model = createModel()
const st = model.status()
if (st.primary !== 'ok') {
  console.error('没有可用的模型适配器。先设置 DSHC_MODEL_URL / DSHC_MODEL_KEY（可选 DSHC_MODEL_NAME）。')
  console.error('当前状态：' + JSON.stringify(st))
  process.exit(1)
}

const rows = parseCsv(fs.readFileSync(file, 'utf8'))
const limit = args.limit ? Number(args.limit) : rows.length
const pick = rows.slice(0, limit)
const sys = [], a = [], b = [], c = [], gold = [], tri = []
let failed = 0

for (let i = 0; i < pick.length; i++) {
  const r = pick[i]
  let label = '平静'
  try {
    const res = await model.appraise(r.text)
    label = LAB[res.label] || '平静'
  } catch (e) {
    failed++
  }
  sys.push(label)
  a.push(r.label_a); b.push(r.label_b); c.push(r.label_c)
  tri.push([r.label_a, r.label_b, r.label_c])
  gold.push(major([r.label_a, r.label_b, r.label_c]))
  if ((i + 1) % 25 === 0) process.stderr.write(`  ${i + 1}/${pick.length}\n`)
}

const k = (x, y) => cohenKappa(x, y).kappa
const done = [k(sys, a), k(sys, b), k(sys, c)].filter((x) => x != null)
const avg = +(done.reduce((s, x) => s + x, 0) / done.length).toFixed(3)
console.log('样本', pick.length, '模型失败', failed)
console.log('模型 vs 甲', k(sys, a), '| 乙', k(sys, b), '| 丙', k(sys, c))
console.log('模型 vs 多数票', k(sys, gold), '| 三人 Fleiss', fleissKappa(tri).kappa)
console.log('模型 κ 平均', avg, avg >= 0.6 ? '达标 (≥0.60)' : '未达标')
console.log('规则基线（merged-v2）：系统 vs 多数票 0.364，平均 0.289')

if (args.write && avg >= 0.6) {
  const db = new DatabaseSync(process.env.DSHC_DB || path.join(os.homedir(), '.dsh', 'consciousness', 'app.db'))
  const active = db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY COALESCE(last_interaction_at, created_at) DESC LIMIT 1").get()
  if (active) {
    db.prepare('INSERT INTO metric_samples VALUES(?,?,?,?,?)')
      .run('mts_' + Math.random().toString(16).slice(2, 12), active.id, 'affect.label_kappa', avg, new Date().toISOString())
    console.log('已写入 affect.label_kappa =', avg, '→', active.id)
  }
} else if (args.write) {
  console.log('未达 0.60，不写指标。')
}
