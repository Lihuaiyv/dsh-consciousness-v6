/**
 * 检索卡回填：给已有记忆补 key / terms / search_text（P1 写入侧卡片）。
 *
 * 用法：
 *   node scripts/backfill-cards.mjs                 最近 50 条缺卡片的
 *   node scripts/backfill-cards.mjs --limit 500     一次补完
 *   node scripts/backfill-cards.mjs --agent agt_x
 *   node scripts/backfill-cards.mjs --dry           只看模型输出，不落库
 *
 * 每条一次模型调用（可 --batch 合并，默认 1）。没有可用模型时什么也不做、退出码 0：
 * 卡片是锦上添花，补不上不影响纯词法召回。
 *
 * 只读写 app.db，不启 DSH、不碰 HTTP。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { model } from '../src/kernel.js'
import { buildSearchText, normalizeTerms } from '../src/modules/memory.js'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  if (i < 0) return def
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DB = String(argOf('db', path.join(home, 'consciousness', 'app.db')))
if (!fs.existsSync(DB)) { console.error('找不到数据库：' + DB); process.exit(1) }

const SYSTEM = [
  '你在为长期记忆写「检索卡」。给定一条记忆原文，输出它以后被问起时可能用到的索引词。',
  '只输出 JSON：{"key":"实体.属性","terms":["词1","词2"]}',
  'key 用「实体.属性」的稳定写法（如「用户.咖啡.偏好」），同一件事换个说法必须给同一个 key；拿不准就给空串。',
  'terms 给 3~6 个，每个 2~8 个字，只写词：同义词、别名、上位词、用户可能的口语问法。',
  '不要解释，不要标点，不要照抄整句。',
].join('')

const db = openDb(DB)
const aid = argOf('agent', '')
  || (() => {
    const row = db.prepare("SELECT id FROM agents WHERE status<>'soft_deleted' ORDER BY COALESCE(last_interaction_at,created_at) DESC LIMIT 1").get()
    return row ? row.id : ''
  })()
if (!aid) { console.error('没有可用的意识体'); process.exit(1) }

const limit = Math.max(1, Math.min(5000, Number(argOf('limit', 50)) || 50))
const dry = !!argOf('dry', false)
const rows = db.prepare(`SELECT id, text, type FROM memory_items
  WHERE agent_id=? AND status='active' AND invalid_at IS NULL
    AND (terms IS NULL OR terms='') ORDER BY created_at DESC LIMIT ?`).all(aid, limit)
if (!rows.length) { console.log('没有需要补卡片的记忆'); db.close(); process.exit(0) }
if (!model.capabilities().complete) {
  console.error('当前没有可用的对话模型（model.json / DSH 宿主 llm 都没有）：跳过')
  db.close()
  process.exit(0)
}

console.log('agent=' + aid + ' 待补 ' + rows.length + ' 条 开始 ' + now())
let done = 0
for (const r of rows) {
  try {
    const raw = await model.complete({ system: SYSTEM, text: String(r.text || '').slice(0, 800) })
    const m = String(raw || '').match(/\{[\s\S]*\}/)
    const data = m ? JSON.parse(m[0]) : null
    if (!data) { console.log('skip(no-json)', r.id); continue }
    const terms = normalizeTerms(data.terms)
    const key = String(data.key || '').trim().slice(0, 120)
    if (!terms.length && !key) { console.log('skip(empty)', r.id); continue }
    if (dry) { console.log(r.id, key, terms.join('/')); continue }
    const searchText = buildSearchText(r.text, key, terms)
    db.prepare('UPDATE memory_items SET fact_key=?, terms=?, search_text=?, version=version+1 WHERE id=?')
      .run(key || null, terms.length ? terms.join(' ') : null, searchText, r.id)
    try {
      db.prepare('DELETE FROM memory_fts WHERE id=?').run(r.id)
      db.prepare('INSERT INTO memory_fts(id,text) VALUES(?,?)').run(r.id, searchText)
    } catch { /* FTS 失败不影响主表 */ }
    done++
  } catch (e) {
    console.log('fail', r.id, String((e && e.message) || e).slice(0, 80))
  }
}
console.log('done: ' + done + ' / ' + rows.length)
db.close()
