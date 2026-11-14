#!/usr/bin/env node
/**
 * 记忆汇流 · 体检（只读）
 *
 *   node scripts/confluence-health.mjs
 *
 * 看：四张表在不在、有多少行、占多少字节、最早的/最新的一条、
 * 以及「按现在的保留策略会清掉多少」。用来决定 180 天 / 2 万行这两个数合不合适。
 */
import { DatabaseSync } from 'node:sqlite'
import { dbPath } from '../src/paths.js'

const db = new DatabaseSync(dbPath(), { readOnly: true })
const all = (s, ...a) => db.prepare(s).all(...a)
const one = (s, ...a) => all(s, ...a)[0] || null
const aidRow = one("SELECT id FROM agents ORDER BY (status='active') DESC, created_at LIMIT 1")
if (!aidRow) {
  console.error('库里没有意识体')
  process.exit(1)
}
const aid = aidRow.id
const nb = (x) => (Number(x || 0) / 1024).toFixed(1) + ' KB'
const mb = (x) => (Number(x || 0) / 1048576).toFixed(2) + ' MB'

const tables = ['state_scene', 'scene_archive', 'confluence_log', 'revisit']
const have = new Set(all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name))

console.log('# 记忆汇流 · 体检\n')
console.log('主体：' + aid)
console.log('')

for (const t of tables) {
  if (!have.has(t)) { console.log(`- ${t}：**没有这张表**（插件还没重启到新版本？）`); continue }
  const n = one(`SELECT COUNT(*) n FROM ${t} WHERE agent_id=?`, aid).n
  console.log(`- ${t}：${n} 行`)
}

if (have.has('state_scene')) {
  const light = one("SELECT COUNT(*) n FROM state_scene WHERE agent_id=? AND tier='light'", aid).n
  const heavy = one("SELECT COUNT(*) n FROM state_scene WHERE agent_id=? AND tier='heavy'", aid).n
  const first = one('SELECT at FROM state_scene WHERE agent_id=? ORDER BY at LIMIT 1', aid)
  const last = one('SELECT at FROM state_scene WHERE agent_id=? ORDER BY at DESC LIMIT 1', aid)
  console.log('')
  console.log(`- 截面：轻 ${light} 条 / 重 ${heavy} 条`)
  console.log(`- 起止：${first ? first.at : '—'} → ${last ? last.at : '—'}`)
  const bytes = one(`SELECT SUM(LENGTH(COALESCE(affect_json,''))+LENGTH(COALESCE(drive_json,''))+
    LENGTH(COALESCE(relation_json,''))+LENGTH(COALESCE(persona_json,''))+LENGTH(COALESCE(life_json,''))+
    LENGTH(COALESCE(loops_json,''))) s FROM state_scene WHERE agent_id=?`, aid)
  console.log(`- 截面正文：${nb(bytes && bytes.s)}`)
}

if (have.has('scene_archive')) {
  const bytes = one('SELECT SUM(bytes) s FROM scene_archive WHERE agent_id=?', aid)
  console.log(`- 注入块留底：${nb(bytes && bytes.s)}`)
  const days0 = Number(one("SELECT value v FROM agent_params WHERE key='scene.retain.days'")?.v ?? 0)
  const cap0 = Number(one("SELECT value v FROM agent_params WHERE key='scene.retain.max_archive'")?.v ?? 0)
  console.log(`- 保留：${days0 > 0 ? '最多 ' + days0 + ' 天' : '永不删（按天）'} / ${cap0 > 0 ? '最多 ' + cap0 + ' 行' : '不限行数'}`)
  if (days0 > 0) {
    const old = one("SELECT COUNT(*) n FROM scene_archive WHERE agent_id=? AND at<?", aid, new Date(Date.now() - days0 * 86400000).toISOString()).n
    console.log(`- 按 ${days0} 天回收：会清 ${old} 行`)
  }
}

if (have.has('confluence_log')) {
  const n = one('SELECT COUNT(*) n FROM confluence_log WHERE agent_id=?', aid).n
  const last = one('SELECT at, level, mode FROM confluence_log WHERE agent_id=? ORDER BY at DESC LIMIT 1', aid)
  console.log(`- 审计账：${n} 条${last ? '（最近 ' + last.at + ' · ' + last.level + ' · ' + last.mode + '）' : ''}`)
}

console.log('')
console.log('判据：0 行 = 重启后还没有一次走 chatReply 的对话；有行但很慢 = 不是每轮都写，查 scene.archive / canLearn。')
console.log('一年粗算（5000 轮）：轻 ~1.75 MB + 重 ~0.15 MB + 注入块 10–30 MB。')
