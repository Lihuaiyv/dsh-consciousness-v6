/**
 * 补残页：纪要记的轮数比原文少的，全部重压一遍。
 *
 * 起因：夜巡以前是「这条已经建过就跳过」，于是一条在会话中途压过的纪要学会永远冻在那儿。
 * 查下来 256 条里 124 条盖不满，漏掉 2913 轮。夜巡那边已经改成「当天每条会话都重压」，
 * 这份脚本只需要跑一次，把历史补平。
 *
 * 只动 episodes 的 title / summary / turns 这些投影字段；fragments（原文）和 diaries（日记）不碰。
 * 用法：node scripts/rebuild-stale-episodes.mjs [--dry-run]
 */
import path from 'node:path'
import os from 'node:os'
import { openDb } from '../src/db.js'
import { buildEpisode } from '../src/modules/archive.js'

const dry = process.argv.includes('--dry-run')
const db = openDb(path.join(os.homedir(), '.dsh', 'consciousness', 'app.db'))

const rows = db.prepare(`
  SELECT e.id, e.agent_id, e.session_id, e.day, e.turns, e.title,
         (SELECT COUNT(*) FROM episodes x
            WHERE x.agent_id = e.agent_id AND x.session_id IS e.session_id AND x.day = e.day) AS rows_in_group,
         (SELECT COUNT(*) FROM fragments r
            WHERE r.agent_id = e.agent_id AND r.session_id IS e.session_id AND r.day = e.day
              AND r.text IS NOT NULL AND r.text <> '') AS actual
  FROM episodes e`).all()

/* 一组多行是历史分段遗留（老版本按时间切过段），它们的 turns 是按段记的、合起来才对得上原文。
   合并成一条会把几段揉成一团，所以跳过；只补「一组一行」里真正盖不满的。 */
const stale = rows.filter((r) => Number(r.rows_in_group || 0) === 1
  && r.actual && Number(r.actual) > Number(r.turns || 0))
const gap = stale.reduce((s, r) => s + (Number(r.actual) - Number(r.turns || 0)), 0)
console.log(`纪要 ${rows.length} 条，盖不满 ${stale.length} 条，漏掉的轮数合计 ${gap}` + (dry ? '（演练，不写库）' : ''))

let ok = 0
let skipped = 0
let failed = 0
for (const r of stale) {
  const label = `[${r.day}] ${r.turns}→${r.actual} 轮 · ${String(r.title || '').slice(0, 18)}`
  if (dry) { ok++; console.log('  · ' + label); continue }
  try {
    const out = buildEpisode(db, r.agent_id, { session: r.session_id, day: r.day })
    if (out) { ok++; console.log(`  ✔ ${label} → 「${String(out.title || '').slice(0, 18)}」`) }
    else { skipped++; console.log(`  · ${label} → 没有可用的原文了，跳过`) }
  } catch (e) {
    failed++
    console.log(`  ✘ ${label} → ${String((e && e.message) || e).slice(0, 80)}`)
  }
}
console.log(`\n重建 ${ok} 条，跳过 ${skipped}，失败 ${failed}`)
try { db.close() } catch { /* 关不掉也不影响 */ }
