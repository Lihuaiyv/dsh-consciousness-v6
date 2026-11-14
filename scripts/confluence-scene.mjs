#!/usr/bin/env node
/**
 * 记忆汇流 · 手动入口「回到那天」/ 自己发起（P4）
 *
 *   node scripts/confluence-scene.mjs --at "2026-11-05 15:00"
 *   node scripts/confluence-scene.mjs --at 2026-11-08T22:18 --level L0
 *   node scripts/confluence-scene.mjs --at "2026-11-05 15:00" --level L2
 *   node scripts/confluence-scene.mjs --self-tick [--force]
 *
 * 看现场：只读打开库，不落账。
 * 自己发起：会写 confluence_log / revisit，属于真的动一下，先看清楚再用。
 */
import { DatabaseSync } from 'node:sqlite'
import { dbPath } from '../src/paths.js'
import { sceneView, selfReturnTick } from '../src/modules/confluence.js'

const args = process.argv.slice(2)
const has = (k) => args.includes('--' + k)
const arg = (k, d) => {
  const i = args.indexOf('--' + k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const pickAgent = (db) => db.prepare("SELECT id FROM agents ORDER BY (status='active') DESC, created_at LIMIT 1").all()[0]?.id

// ---- 自己发起（P4）：要写库，单独开一个可写连接 ----
if (has('self-tick')) {
  const db = new DatabaseSync(dbPath())
  const aid = pickAgent(db)
  const out = selfReturnTick(db, aid, { force: has('force'), gapDays: Number(arg('gap-days', 0)) || undefined })
  if (!out.ok) {
    console.log('没开：' + out.reason + (out.days != null ? '（' + out.days + ' 天）' : ''))
    process.exit(0)
  }
  console.log(out.system)
  console.log(`\n--- 自己发起：${out.at.slice(0, 10)} · 预算 ${out.budget.tokens} / ${out.budget.cap}`)
  process.exit(0)
}

const at = arg('at', arg('day', ''))
if (!at) {
  console.error('用法：node scripts/confluence-scene.mjs --at "2026-11-05 15:00" [--level L1] [--session …]')
  process.exit(2)
}

const db = new DatabaseSync(dbPath(), { readOnly: true })
const aid = pickAgent(db)
if (!aid) {
  console.error('库里没有意识体')
  process.exit(1)
}

const v = sceneView(db, aid, {
  at,
  level: arg('level', 'L1'),
  ask: arg('ask', ''),
  sessionId: arg('session', '') || undefined,
  budget: Number(arg('budget', 0)) || undefined,
})
if (!v.ok) {
  console.error('重建失败：' + (v.reason === 'forgotten-anchor' ? '这一轮说好要忘的，不重建' : v.reason))
  process.exit(1)
}
console.log(v.system)
const sess = v.session || {}
console.log(`\n--- 会话 ${sess.id || '（全库）'}${sess.filtered ? '（只看这条）' : ''}${sess.fallback ? ' · 退回全库' : ''}`)
console.log(`--- 预算 ${v.budget.tokens} / ${v.budget.cap}${v.dropped && v.dropped.length ? '；裁掉 ' + v.dropped.length + ' 段' : ''}`)
