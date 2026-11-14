/**
 * 把切好的事件 JSON 写进事件库（cold_events + 可选的 hot_events 初版 born）。
 *
 * 用法：
 *   node scripts/import-cold-events.mjs scratch/events-1112-clean.json
 *   node scripts/import-cold-events.mjs scratch/events-1112-clean.json --hot    顺带生成热库初版
 *   node scripts/import-cold-events.mjs scratch/events-1112-clean.json --dry    只看会写什么
 *
 * 规矩（照 docs/设计-事件库-最终版-2026-11-12.md）：
 *   - 冷库只追加：同一个 id 已存在就跳过，绝不覆盖
 *   - 入库前再校验一遍：quotes 必须原文子串、turn_ids 必须存在，不合格的整条不进
 *   - 热库初版：op=born、来源=一条冷库 id、想头按 w 给起点
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { openDb, now } from '../src/db.js'
import { dbPath } from '../src/paths.js'
import { nid } from '../src/kernel.js'

const args = process.argv.slice(2)
const files = args.filter((a) => !a.startsWith('--'))
const has = (f) => args.includes('--' + f)
const dry = has('dry')
const alsoHot = has('hot')
const agentArg = (() => { const i = args.indexOf('--agent'); return i >= 0 ? args[i + 1] : '' })()
if (!files.length) { console.error('用法：node scripts/import-cold-events.mjs <events.json> [--hot] [--dry]'); process.exit(1) }

const DB = process.env.DSH_DB || dbPath()
const db = openDb(DB)
const aid = agentArg
  || (() => { const r = db.prepare("SELECT id FROM agents WHERE status<>'soft_deleted' ORDER BY COALESCE(last_interaction_at,created_at) DESC LIMIT 1").get(); return r ? r.id : '' })()
if (!aid) { console.error('没有可用的意识体'); process.exit(1) }

// 原文：拿来做引文校验
const allText = db.prepare('SELECT text FROM fragments WHERE agent_id=?').all(aid).map((r) => String(r.text || '')).join('\n')
const turnExists = (id) => !!db.prepare('SELECT 1 ok FROM fragments WHERE turn_id=? LIMIT 1').get(id)
const coldExists = (id) => !!db.prepare('SELECT 1 ok FROM cold_events WHERE id=?').get(id)

const stamp = now()
let added = 0, skipped = 0, rejected = 0
const rejects = []
const coldIds = []

for (const f of files) {
  const list = JSON.parse(fs.readFileSync(f, 'utf8'))
  for (const ev of list) {
    const quotes = (ev.quotes || []).filter((q) => q && allText.includes(String(q)))
    const turns = (ev.turn_ids || []).filter((id) => turnExists(String(id)))
    if (!quotes.length || !turns.length) {
      rejected++
      rejects.push({ title: ev.title, quotes: (ev.quotes || []).length - quotes.length, turns: (ev.turn_ids || []).length - turns.length })
      continue
    }
    // 稳定 id：同一份文件重复导入不会写两遍
    const id = 'cev_' + crypto.createHash('sha1')
      .update([aid, ev.title, String(ev.started_at), turns[0], turns[turns.length - 1]].join('\u0001'))
      .digest('hex').slice(0, 20)
    if (coldExists(id)) { skipped++; coldIds.push(id); continue }
    if (!dry) {
      db.prepare(`INSERT INTO cold_events(id,agent_id,title,story,who,start_at,end_at,turn_ids,quotes,cues,status,weight,cut_rev,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, aid, String(ev.title || '').slice(0, 60), String(ev.story || ''),
        String(ev.who || ''), String(ev.started_at || ''), String(ev.ended_at || ''),
        JSON.stringify(turns), JSON.stringify(quotes),
        (Array.isArray(ev.cues) && ev.cues.length) ? JSON.stringify(ev.cues) : null,
        String(ev.status || ''), Number(ev.weight) || 0.5, 1, stamp,
      )
    }
    added++
    coldIds.push(id)
  }
}

// 热库初版：一条冷事件 → 一条热事件（op=born）。只给还没进过热库的冷事件生成。
let hotAdded = 0
if (alsoHot) {
  for (const cid of coldIds) {
    const has2 = db.prepare("SELECT 1 ok FROM hot_events WHERE source_cold_ids LIKE ? LIMIT 1").get('%' + cid + '%')
    if (has2) continue
    const c = db.prepare('SELECT * FROM cold_events WHERE id=?').get(cid)
    if (!c) continue
    const w = Number(c.weight) || 0.5
    const want = Math.min(0.35, 0.2 + 0.1 * w)   // 想头起点：重的事起点略高
    if (!dry) {
      db.prepare(`INSERT INTO hot_events(id,agent_id,title,story,cues,source_cold_ids,op,reason,version,active,state,want,ceiling,mentions,created_at,changed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        nid('hev_'), aid, c.title, c.story, c.cues || null, JSON.stringify([cid]), 'born', '夜里第一刀切出来', 1, 1, '台面',
        want, 1.0, 0, stamp, stamp,
      )
    }
    hotAdded++
  }
}

db.close()
console.log(JSON.stringify({
  db: DB, agent: aid, dry,
  files: files.map((f) => path.basename(f)),
  cold: { added, skipped, rejected, rejects },
  hot: alsoHot ? { added: hotAdded } : '没要（加 --hot 才生成）',
}, null, 1))
