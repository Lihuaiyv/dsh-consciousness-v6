#!/usr/bin/env node
/**
 * 日记 v3 材料回放：在真实库的【临时副本】上打印某一天的成文提示词，
 * 重点看 moments（当天的 feel + 情绪尖峰原话）有没有真的进材料。
 * 不调模型，不写原库。
 *
 *   node scripts/diary-moments-replay.mjs 2026-11-04
 *   node scripts/diary-moments-replay.mjs 2026-11-04 agt_3977d80f17
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { prepareDiary, writePrompt, collectMoments, weekday } from '../src/modules/diary.js'

const src = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'consciousness', 'app.db')
const DAY = process.argv[2] || new Date().toISOString().slice(0, 10)
const AID = process.argv[3] || 'agt_3977d80f17'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-moments-'))
const dst = path.join(dir, 'app.db')
fs.copyFileSync(src, dst)
const db = openDb(dst)
attachDb(db)

console.log('=== collectMoments ===')
console.log(JSON.stringify(collectMoments(db, AID, DAY), null, 2))

const prep = await prepareDiary(db, AID, DAY, { chat: null })
if (!prep) { console.log('\n这天没有可写的材料。'); db.close(); process.exit(0) }

console.log('\n=== scenes ===')
for (const s of prep.scenes) console.log('-', s.title, '(' + s.grounding + ')')

const date = `${DAY.slice(0, 4)}年${Number(DAY.slice(5, 7))}月${Number(DAY.slice(8, 10))}日 ${weekday(DAY)}`
const p = writePrompt({
  name: prep.name, day: prep.day, date,
  other: prep.other, tone: prep.tone, mood: prep.mood, mood_source: prep.ctx.mood_source,
  arc: prep.picked.arc, insight: prep.picked.insight, maxChars: prep.params.maxChars,
  moments: prep.moments,
  scenes: prep.scenes.map((s) => ({
    when: String(s.start_at || s.created_at || '').slice(11, 16),
    gist: String(s.title || '').slice(0, 40),
    moments: (s.moments || []).map((m) => ({ at: m.at, text: m.text })),
    lines: s.lines.map((l) => ({ who: l.who === 'user' ? prep.other : '我', text: l.text })),
  })),
})

console.log('\n=== SYSTEM ===')
console.log(p.system)
console.log('\n=== USER（前 1600 字）===')
console.log(p.user.slice(0, 1600))
db.close()
