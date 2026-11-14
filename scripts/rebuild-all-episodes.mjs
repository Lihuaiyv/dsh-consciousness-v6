/**
 * 全量重压纪要：把「一组一行」的旧口气换成新口气，把「一组多行」的历史分段按各自时间窗重算。
 *
 * 为什么要分两种：
 *   - 一组一行：buildEpisode 按「会话+哪天」就能取到全部原文。
 *   - 一组多行：那是老版本按时间切过的段，一行只该吃自己 start_at～end_at 的原文；
 *     用「会话+哪天」去压会把几段揉成一句。所以按窗口重算，并用 episodeId 指定写回哪一行。
 *
 * 不动的：source='model' 的（那是模型精修过的，重压会把它降回规则版）。
 * 不动的：fragments（原文）和 diaries（日记）。
 *
 * 用法：node scripts/rebuild-all-episodes.mjs [--dry-run]
 */
import path from 'node:path'
import os from 'node:os'
import { openDb } from '../src/db.js'
import { buildEpisode } from '../src/modules/archive.js'

const dry = process.argv.includes('--dry-run')
const db = openDb(path.join(os.homedir(), '.dsh', 'consciousness', 'app.db'))

const all = db.prepare(`
  SELECT e.id, e.agent_id, e.session_id, e.day, e.start_at, e.end_at, e.turns, e.source,
         (SELECT COUNT(*) FROM episodes x WHERE x.agent_id=e.agent_id
            AND x.session_id IS e.session_id AND x.day=e.day) AS rows_in_group
  FROM episodes e ORDER BY e.day, e.start_at`).all()

const seg = all.filter((r) => Number(r.rows_in_group) > 1)
const single = all.filter((r) => Number(r.rows_in_group) === 1)

const segDo = seg.filter((r) => String(r.source || '') !== 'model')
const singleDo = single.filter((r) => String(r.source || '') !== 'model')

console.log(`纪要 ${all.length} 条｜分段 ${seg.length}（要重算 ${segDo.length}）｜单行 ${single.length}（要重压 ${singleDo.length}）` + (dry ? '（演练）' : ''))

let ok = 0
let skip = 0
let fail = 0
const samples = []

for (const r of segDo) {
  if (dry) { ok++; continue }
  try {
    const out = buildEpisode(db, r.agent_id, {
      session: r.session_id, day: r.day, from: r.start_at, to: r.end_at, episodeId: r.id,
    })
    if (!out) { skip++; continue }
    ok++
    if (samples.length < 6 && String(out.summary || '') !== '') samples.push(`[分段 ${r.day}] ${String(out.summary).slice(0, 120)}`)
  } catch (e) { fail++; console.log('  ✘ 分段 ' + r.day + ' ' + String((e && e.message) || e).slice(0, 60)) }
}

for (const r of singleDo) {
  if (dry) { ok++; continue }
  try {
    const out = buildEpisode(db, r.agent_id, { session: r.session_id, day: r.day })
    if (!out) { skip++; continue }
    ok++
    if (samples.length < 12 && /你对我说|我对你说/.test(String(out.summary || ''))) samples.push(`[单行 ${r.day}] ${String(out.summary).slice(0, 120)}`)
  } catch (e) { fail++; console.log('  ✘ 单行 ' + r.day + ' ' + String((e && e.message) || e).slice(0, 60)) }
}

console.log(`重建 ${ok} 条，跳过 ${skip}，失败 ${fail}`)

// 核验：分段行的轮数应等于自己窗口里的原文条数；单行不该再有盖不满的
const bad = db.prepare(`
  SELECT COUNT(*) n FROM episodes e
  WHERE e.source <> 'model' AND e.turns <> (
    SELECT COUNT(*) FROM fragments r WHERE r.agent_id=e.agent_id
      AND r.session_id IS e.session_id
      AND r.created_at >= e.start_at AND r.created_at <= e.end_at)`).get().n
console.log(`轮数与原文对不上的行：${bad}`)

if (samples.length) {
  console.log('--- 抽样 ---')
  for (const s of samples) console.log('  ' + s)
}
try { db.close() } catch { /* 关不掉也不影响 */ }
