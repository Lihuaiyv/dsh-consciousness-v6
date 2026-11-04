#!/usr/bin/env node
/**
 * 日记 v1 → v2 对比：材料量 / 成文形态 / 质检结果。
 * 在真实库的临时副本上算，不写原库。
 *
 *   node scripts/diary-compare.mjs --agent agt_xxx --days 2026-10-29,...,2026-11-02 \
 *     --fixture scripts/fixtures/diary-fixtures.json --out docs/diary-v2-compare.md
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { listEpisodes } from '../src/modules/archive.js'
import { prepareDiary, checkDiary } from '../src/modules/diary.js'

const argv = process.argv.slice(2)
function flag(n, d) { const i = argv.indexOf('--' + n); if (i < 0) return d; const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true }

const SRC = String(flag('db', path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'consciousness', 'app.db')))
const OUT = String(flag('out', 'docs/diary-v2-compare.md'))
const FIX = JSON.parse(fs.readFileSync(String(flag('fixture', 'scripts/fixtures/diary-fixtures.json')), 'utf8'))
const days = String(flag('days', '')).split(',').map((s) => s.trim()).filter(Boolean)
if (!days.length) { console.error('需要 --days'); process.exit(1) }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-diacmp-'))
const dbPath = path.join(tmpDir, 'app.db')
fs.copyFileSync(SRC, dbPath)
const db = openDb(dbPath)
attachDb(db)
const aid = String(flag('agent', '') || (db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY created_at LIMIT 1").get() || {}).id || '')

const clip = (s, n) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x }
function metrics(text) {
  const body = String(text || '').replace(/^\d{4}-\d{2}-\d{2}[^\n]*\n+/, '').trim()
  const paras = body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  return {
    chars: body.replace(/\s/g, '').length,
    paragraphs: paras.length,
    enumWords: (body.match(/首先|其次|然后|接着|另外|还有一件事|第一|第二/g) || []).length,
    reportWords: (body.match(/处理了|完成了|优化了|修复了|接好了|改好了|搞定了/g) || []).length,
  }
}

const rows = []
for (const day of days) {
  const old = db.prepare('SELECT text,source FROM diaries WHERE agent_id=? AND day=?').get(aid, day)
  // v1 材料：最多 20 条纪要 summary + 12 条事实 + 36 句原话（每句 trim 120）
  const eps = listEpisodes(db, aid, { day, limit: 20 })
  const facts = db.prepare(`SELECT text FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL
    AND substr(created_at,1,10)=? ORDER BY importance DESC, created_at LIMIT 12`).all(aid, day)
  const raw = db.prepare(`SELECT text FROM raw_turns WHERE agent_id=? AND day=? AND role IN ('user','assistant') ORDER BY created_at, seq`).all(aid, day)
  const sample = []
  if (raw.length <= 36) sample.push(...raw)
  else for (let i = 0; i < 36; i++) sample.push(raw[Math.round(i * (raw.length - 1) / 35)])
  const oldMaterial = eps.reduce((n, e) => n + String(e.summary || '').length, 0)
    + facts.reduce((n, f) => n + String(f.text || '').length, 0)
    + sample.reduce((n, r) => n + clip(r.text, 120).length, 0)

  const prep = await prepareDiary(db, aid, day, { chat: null })
  const scenes = prep ? prep.scenes : []
  const newMaterial = scenes.reduce((n, s) => n + s.lines.reduce((m, l) => m + String(l.text || '').length, 0), 0)
  const rawScenes = scenes.filter((s) => s.grounding === 'raw').length
  const newText = FIX[day] || FIX.__default || ''
  const gm = newText ? metrics(newText) : null
  const gate = newText ? checkDiary(newText, { episodeTitles: (prep ? prep.cands : []).map((c) => c.title) }) : null
  rows.push({
    day,
    old: old ? { source: old.source, ...metrics(old.text) } : null,
    oldMaterial, oldEpisodes: eps.length, oldFacts: facts.length, oldRawTurns: raw.length,
    new: gm ? { scenes: scenes.length, rawScenes, material: newMaterial, ...gm, gate: gate.ok } : null,
  })
}

const num = (a) => Math.round(a * 10) / 10
const avg = (arr) => (arr.length ? num(arr.reduce((a, b) => a + b, 0) / arr.length) : 0)
const withOld = rows.filter((r) => r.old)
const withNew = rows.filter((r) => r.new)

const md = []
md.push('# 日记 v1 → v2 对比（真实库 5 天）')
md.push('')
md.push(`- agent：${aid}`)
md.push(`- 时间：${now()}`)
md.push(`- 说明：旧数据取库里已有的日记；新数据用固定夹具走 v2 管线（选料/取原话/质检都是真的，正文是夹具，不是真模型）。`)
md.push('')
md.push('## 逐日')
md.push('')
md.push('| 日期 | 旧来源 | 旧材料字 | 旧纪要数 | 旧原话轮 | 旧字数/段 | 新场景 | 新原话场 | 新材料字 | 新字数/段 | 新质检 |')
md.push('|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) {
  md.push(`| ${r.day} | ${r.old ? r.old.source : '-'} | ${r.oldMaterial} | ${r.oldEpisodes} | ${r.oldRawTurns} | ${r.old ? r.old.chars + '/' + r.old.paragraphs : '-'} | ${r.new ? r.new.scenes : '-'} | ${r.new ? r.new.rawScenes : '-'} | ${r.new ? r.new.material : '-'} | ${r.new ? r.new.chars + '/' + r.new.paragraphs : '-'} | ${r.new ? (r.new.gate ? '过' : '不过') : '-'} |`)
}
md.push('')
md.push('## 汇总')
md.push('')
md.push(`- 旧：平均材料 ${avg(rows.map((r) => r.oldMaterial))} 字（每条日记最多吃 20 条纪要、12 条事实、36 句原话）`)
md.push(`- 新：平均材料 ${avg(withNew.map((r) => r.new.material))} 字（只吃 1–2 个场景的原话）`)
md.push(`- 旧：平均 ${avg(withOld.map((r) => r.old.chars))} 字 / ${avg(withOld.map((r) => r.old.paragraphs))} 段`)
md.push(`- 新：平均 ${avg(withNew.map((r) => r.new.chars))} 字 / ${avg(withNew.map((r) => r.new.paragraphs))} 段`)
md.push(`- 旧：列举词 ${avg(withOld.map((r) => r.old.enumWords))} 个 / 汇报词 ${avg(withOld.map((r) => r.old.reportWords))} 个`)
md.push(`- 新：列举词 ${avg(withNew.map((r) => r.new.enumWords))} 个 / 汇报词 ${avg(withNew.map((r) => r.new.reportWords))} 个`)
md.push(`- 新：${withNew.filter((r) => r.new.gate).length}/${withNew.length} 篇过质检；选中的场景里 ${withNew.reduce((n, r) => n + r.new.rawScenes, 0)}/${withNew.reduce((n, r) => n + r.new.scenes, 0)} 场有原话`)
md.push('')

fs.writeFileSync(OUT, md.join('\n') + '\n', 'utf8')
fs.writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify(rows, null, 1), 'utf8')
console.log(md.join('\n'))
console.log('\n写到 ' + OUT)
