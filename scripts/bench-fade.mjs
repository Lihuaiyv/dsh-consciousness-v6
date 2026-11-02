/**
 * 内容级模糊：拿真实库算账（只读）。
 *
 *   node scripts/bench-fade.mjs [db 路径]
 *
 * 只回答三个问题：
 *   1. 真实库里有多少条会被削？
 *   2. 平均削掉多少字（百分比）？
 *   3. 削完还认不认得出这件事？（抽几条给人眼看）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fadeText, shouldFade, fadeLevel } from '../src/modules/memory_fade.js'

const home = process.env.USERPROFILE || process.env.HOME || '.'
const src = process.argv[2] || path.join(home, '.dsh', 'consciousness', 'app.db')
if (!fs.existsSync(src)) { console.error('找不到库：' + src); process.exit(2) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-fade-bench-'))
const copy = path.join(dir, 'app.db')
fs.copyFileSync(src, copy)
for (const ext of ['-wal', '-shm']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, copy + ext)

const db = new DatabaseSync(copy, { readOnly: true })
const rows = db.prepare(`SELECT id,text,created_at,importance,type,mark FROM memory_items
  WHERE status='active' AND invalid_at IS NULL`).all()
db.close()

const nowMs = Date.now()
const DAY = 86400000
const out = []
for (const r of rows) {
  const t = Date.parse(String(r.created_at || ''))
  const days = Number.isFinite(t) ? (nowMs - t) / DAY : null
  const fade = shouldFade(r, days)
  const res = fade ? fadeText(r.text, days) : { text: r.text, level: 0, removed: 0 }
  out.push({ ...r, days, fade, level: res.level, before: String(r.text || '').length, after: res.text.length, after_text: res.text })
}

const faded = out.filter((x) => x.level > 0)
const eligible = out.filter((x) => x.fade)
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0)
const byLevel = [1, 2, 3].map((L) => ({ level: L, count: out.filter((x) => x.level === L).length }))
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0)

const report = {
  db: src,
  total: out.length,
  eligible: eligible.length,
  faded: faded.length,
  fade_rate_of_all: pct(faded.length, out.length) + '%',
  fade_rate_of_aged: pct(faded.length, out.filter((x) => fadeLevel(x.days) > 0).length) + '%',
  chars_before: sum(faded, (x) => x.before),
  chars_after: sum(faded, (x) => x.after),
  chars_saved_pct: pct(sum(faded, (x) => x.before) - sum(faded, (x) => x.after), sum(faded, (x) => x.before)) + '%',
  avg_before: faded.length ? Math.round(sum(faded, (x) => x.before) / faded.length) : 0,
  avg_after: faded.length ? Math.round(sum(faded, (x) => x.after) / faded.length) : 0,
  by_level: byLevel,
}

console.log(JSON.stringify(report, null, 2))
console.log('\n--- 抽样（最长的五条）---')
for (const x of faded.sort((a, b) => b.before - a.before).slice(0, 5)) {
  console.log(`\n[${Math.round(x.days)} 天 / L${x.level}] ${x.before} → ${x.after} 字`)
  console.log('  前：' + String(x.text).replace(/\s+/g, ' ').slice(0, 80))
  console.log('  后：' + x.after_text.replace(/\s+/g, ' ').slice(0, 80))
}

// ---------------------------------------------------------------- 合成语料
// 线上库才几天大，还没有 30 天以上的记忆，真实数据这项目前就是 0。
// 所以另外用一组「各年龄段」的样本，量一下这条规则到底会删多少。
const TEMPLATES = [
  '主人说过想去看海（最好是冬天，人少）。',
  '主人今天在改接线（那部分一直没弄完），说要先跑一遍。',
  '答应过周末把脚本修好，修完先跑一遍不出假数据。',
  '主人说三周后要把那版发出去，先写文档。',
  '主人当时说「这版先放着」，后来又说了别的。',
  '上次那家咖啡店（有点吵）主人嫌太吵，一直没再去。',
]
const AGES = [3, 15, 45, 75, 120, 220, 400, 700]
const BUCKET = [
  { name: '30 天内', test: (d) => d < 30 },
  { name: '30–90 天', test: (d) => d >= 30 && d < 90 },
  { name: '90–180 天', test: (d) => d >= 90 && d < 180 },
  { name: '180 天以上', test: (d) => d >= 180 },
]
const sample = []
for (const a of AGES) for (const t of TEMPLATES) {
  sample.push({ days: a, text: t, ...fadeText(t, a, { maxLevel: 3 }) })
}
console.log('\n--- 合成语料（每个年龄段 6 条）---')
console.log('| 年龄 | 被削条数 | 平均字数 | 削掉 |')
console.log('|---|---|---|---|')
for (const b of BUCKET) {
  const arr = sample.filter((x) => b.test(x.days))
  const fadedN = arr.filter((x) => x.level > 0).length
  const before = arr.reduce((s, x) => s + x.text.length, 0)
  const after = arr.reduce((s, x) => s + x.text.length - x.removed, 0)
  const saved = before ? Math.round(((before - after) / before) * 1000) / 10 : 0
  console.log(`| ${b.name} | ${fadedN}/${arr.length} | ${Math.round(after / arr.length)} | ${saved}% |`)
}
