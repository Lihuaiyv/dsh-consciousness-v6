/**
 * 冲突回放：把库里真实发生过的冲突，喂给现在的判官，看它判成什么。
 *
 * 只读活库；要跑判官时先复制一份到临时目录（判官会写 memory_pair_judge 缓存，别污染活库）。
 *
 * 用法：
 *   node scripts/replay-conflicts.mjs                 # 只导出对子（不花钱）
 *   node scripts/replay-conflicts.mjs --judge --n 10  # 再跑判官（本地 ollama）
 *   node scripts/replay-conflicts.mjs --judge         # 全量
 *
 * 输出：docs/冲突回放-<日期>.json
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dbPath as defaultDbPath } from '../src/paths.js'
import { judgePair } from '../src/modules/pair_judge.js'
import { createJudgeModel } from '../src/model.js'

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const srcPath = String(arg('db', defaultDbPath()))
const doJudge = !!arg('judge', false)
const limit = Number(arg('n', '0')) || 0
const today = new Date().toISOString().slice(0, 10)
const outPath = String(arg('out', 'docs/冲突回放-' + today + '.json'))

// 活库只读打开，导对子
const ro = new DatabaseSync(srcPath, { readOnly: true })
const aid = ro.prepare("SELECT id FROM agents WHERE name='小汐'").get()?.id
if (!aid) { console.error('找不到 agents.name=小汐'); process.exit(1) }

const one = (id) => {
  try { return ro.prepare('SELECT id,text,type,created_at,invalid_at FROM memory_items WHERE id=?').get(id) || null } catch { return null }
}

let rows = ro.prepare(`SELECT * FROM conflicts WHERE agent_id=? ORDER BY opened_at DESC`).all(aid)
if (limit) rows = rows.slice(0, limit)

const pairs = rows.map((c) => {
  let ev = {}
  try { ev = JSON.parse(c.evidence || '{}') } catch { ev = {} }
  const a = one(c.a_id)
  const b = one(c.b_id)
  return {
    cid: c.id,
    state: c.state,
    resolution: c.resolution || null,
    opened_at: c.opened_at,
    via: ev.via || null,
    kind: c.kind || ev.kind || null,
    similarity: ev.similarity == null ? null : Number(ev.similarity),
    a: { id: c.a_id, text: String((ev.attribute && ev.attribute.sentence_a) || ev.a_text || (a && a.text) || '').slice(0, 200), at: a ? a.created_at : null },
    b: { id: c.b_id, text: String((ev.attribute && ev.attribute.sentence_b) || ev.b_text || (b && b.text) || '').slice(0, 200), at: b ? b.created_at : null },
    verdict: null,
    reason: null,
    ms: null,
  }
})
ro.close()

// 判官：活库会写缓存，拷一份到临时目录
async function judgeAll(list) {
  const model = createJudgeModel()
  if (!model) { console.error('没有独立评委（model.json 缺 judge.url）；只导出，不判。'); return list }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-replay-'))
  const tmp = path.join(dir, 'app.db')
  fs.copyFileSync(srcPath, tmp)
  const db = new DatabaseSync(tmp)
  try {
    for (const p of list) {
      const oldRow = { id: p.a.id, text: p.a.text, created_at: p.a.at, fact_key: null }
      const newerRow = { id: p.b.id, text: p.b.text, created_at: p.b.at, fact_key: null }
      const t0 = Date.now()
      try {
        const r = await judgePair({ db, aid, oldRow, newerRow, complete: (req) => model.complete(req), timeoutMs: 120000, via: 'replay' })
        p.verdict = r.verdict
        p.reason = r.reason || (r.skipped ? 'skipped:' + r.skipped : null)
        p.ms = r.ms != null ? r.ms : Date.now() - t0
      } catch (e) {
        p.verdict = 'error'
        p.reason = String(e && e.message).slice(0, 160)
        p.ms = Date.now() - t0
      }
      console.log(`${p.cid} → ${p.verdict}  ${p.ms}ms  「${p.a.text.slice(0, 24)}」／「${p.b.text.slice(0, 24)}」`)
    }
  } finally {
    db.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清不掉就算了 */ }
  }
  return list
}

if (doJudge) await judgeAll(pairs)

const tally = {}
for (const p of pairs) tally[p.verdict || 'not-judged'] = (tally[p.verdict || 'not-judged'] || 0) + 1

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), db: srcPath, count: pairs.length, tally, pairs }, null, 2), 'utf8')
console.log('\n共', pairs.length, '对 →', outPath)
console.log('分布：', JSON.stringify(tally))
