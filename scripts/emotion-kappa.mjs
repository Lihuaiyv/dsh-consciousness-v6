/**
 * 情绪标注一致性（κ）工具
 *
 *   node scripts/emotion-kappa.mjs export [--n 200] [--out file.csv]
 *   node scripts/emotion-kappa.mjs score <file.csv> [--write] [--agent id]
 *
 * 支持 2 人或 3 人标注：label_a / label_b / label_c 三列都可选。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cohenKappa, fleissKappa } from '../src/algo/kappa.js'

const LABELS = {
  joy: '愉悦', peaceful: '安心', curious: '好奇', calm: '平静',
  confused: '困惑', lost: '失落', irritated: '烦躁', frustrated: '挫败',
}
const ALIAS = {}
for (const [en, zh] of Object.entries(LABELS)) { ALIAS[en] = en; ALIAS[zh] = en }

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    } else out._.push(a)
  }
  return out
}
const esc = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((x) => x.trim() !== ''))
}
const dbPath = () => process.env.DSHC_DB || path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const activeAgent = (db) => (db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY COALESCE(last_interaction_at, created_at) DESC LIMIT 1").get() || {}).id || null

function cmdExport(args) {
  const db = new DatabaseSync(dbPath())
  const aid = args.agent || activeAgent(db)
  if (!aid) { console.error('没有 active 意识体'); process.exit(1) }
  const n = Math.max(5, Number(args.n) || 200)
  const rows = db.prepare(`SELECT id, cause, label FROM affect_episodes
    WHERE agent_id=? AND cause IS NOT NULL AND TRIM(cause)<>''
    ORDER BY started_at DESC LIMIT ?`).all(aid, n)
  if (!rows.length) { console.error('还没有 episode'); process.exit(1) }
  const out = args.out || `emotion-labels-${aid.slice(-6)}.csv`
  const lines = ['id,text,system_label,label_a,label_b,label_c']
  for (const r of rows) lines.push([r.id, r.cause, r.label, '', '', ''].map(esc).join(','))
  fs.writeFileSync(out, lines.join('\n'), 'utf8')
  console.log('导出 ' + rows.length + ' 条 → ' + out)
}

function cmdScore(args) {
  const file = args._[0]
  if (!file) { console.error('用法：score <file.csv> [--write]'); process.exit(1) }
  const rows = parseCsv(fs.readFileSync(file, 'utf8'))
  const head = rows.shift().map((s) => s.trim())
  const idx = (n) => head.indexOf(n)
  const iSys = idx('system_label'), iA = idx('label_a'), iB = idx('label_b'), iC = idx('label_c')
  if (iSys < 0 || iA < 0) { console.error('CSV 至少需要 system_label 和 label_a 两列'); process.exit(1) }
  const pick = (r, i) => (i < 0 ? '' : ALIAS[String(r[i] || '').trim()] || String(r[i] || '').trim())
  const sys = [], a = [], b = [], c = [], triple = [], gold = []
  for (const r of rows) {
    const s = pick(r, iSys), x = pick(r, iA), y = pick(r, iB), z = pick(r, iC)
    sys.push(s); a.push(x); b.push(y); c.push(z)
    const votes = [x, y, z].filter((v) => v && v !== 'skip')
    triple.push([x, y, z])
    const count = {}
    for (const v of votes) count[v] = (count[v] || 0) + 1
    const top = Object.entries(count).sort((m, n) => n[1] - m[1])
    gold.push(votes.length && (!top[1] || top[0][1] > top[1][1]) ? top[0][0] : '')
  }
  const ka = cohenKappa(sys, a)
  const kb = iB >= 0 ? cohenKappa(sys, b) : { kappa: null, n: 0 }
  const kc = iC >= 0 ? cohenKappa(sys, c) : { kappa: null, n: 0 }
  const kab = iB >= 0 ? cohenKappa(a, b) : { kappa: null, n: 0 }
  const kac = iC >= 0 ? cohenKappa(a, c) : { kappa: null, n: 0 }
  const kbc = iB >= 0 && iC >= 0 ? cohenKappa(b, c) : { kappa: null, n: 0 }
  const fl = iB >= 0 ? fleissKappa(triple) : { kappa: null, n: 0 }
  const kg = cohenKappa(sys, gold)
  const done = [ka, kb, kc].filter((x) => x.kappa != null)
  const sysKappa = done.length ? +(done.reduce((s, x) => s + x.kappa, 0) / done.length).toFixed(3) : null

  console.log('样本数:', rows.length)
  console.log('系统 vs 甲:', ka.kappa, '(n=' + ka.n + ')')
  if (iB >= 0) console.log('系统 vs 乙:', kb.kappa, '(n=' + kb.n + ')')
  if (iC >= 0) console.log('系统 vs 丙:', kc.kappa, '(n=' + kc.n + ')')
  if (iB >= 0) console.log('甲 vs 乙 :', kab.kappa)
  if (iC >= 0) console.log('甲 vs 丙 :', kac.kappa, ' · 乙 vs 丙:', kbc.kappa)
  if (iB >= 0) console.log('三人 Fleiss κ:', fl.kappa, '(n=' + fl.n + ')')
  console.log('系统 vs 多数票:', kg.kappa, '(n=' + kg.n + ')')
  console.log('系统 κ 平均:', sysKappa, sysKappa != null && sysKappa >= 0.6 ? '达标 (≥0.60)' : '未达标')

  if (args.write && sysKappa != null) {
    const db = new DatabaseSync(dbPath())
    const aid = args.agent || activeAgent(db)
    if (!aid) { console.error('没有 active 意识体'); process.exit(1) }
    db.prepare('INSERT INTO metric_samples VALUES(?,?,?,?,?)')
      .run('mts_' + Math.random().toString(16).slice(2, 12), aid, 'affect.label_kappa', sysKappa, new Date().toISOString())
    console.log('已写入 affect.label_kappa =', sysKappa, '→', aid)
  }
}

const args = parseArgs(process.argv.slice(2))
const cmd = args._.shift()
if (cmd === 'export') cmdExport(args)
else if (cmd === 'score') cmdScore(args)
else {
  console.log('用法：')
  console.log('  node scripts/emotion-kappa.mjs export [--n 200] [--out file.csv]')
  console.log('  node scripts/emotion-kappa.mjs score <file.csv> [--write]')
}
