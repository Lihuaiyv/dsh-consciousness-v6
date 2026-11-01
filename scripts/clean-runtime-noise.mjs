/**
 * 清理「把 DSH 运行环境说明当成用户消息」留下的脏数据。
 *
 *   node scripts/clean-runtime-noise.mjs           # 只看，不改
 *   node scripts/clean-runtime-noise.mjs --apply   # 真的改（先备份 db）
 *
 * 规则：
 *  · chat_turns 里 role=user 且清洗后为空 → 删除（它是合成消息，不是用户数据）
 *  · memory_items 里命中样板特征 → 软删（status='soft_deleted'，7 天后由 purgeExpired 物理清）
 *  · 每个受影响的 agent 记一条 change 留痕
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cleanUserText, looksLikeRuntimeNoise } from '../src/text.js'

const apply = process.argv.includes('--apply')
const file = process.env.DSHC_DB || path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
if (!fs.existsSync(file)) {
  console.error('找不到数据库：' + file)
  process.exit(1)
}

const NOISE_HINT = /Time sampled while preparing|Current runtime context|This snapshot supersedes earlier/i
const isNoiseMemory = (text) => NOISE_HINT.test(String(text || '')) || looksLikeRuntimeNoise(text)
const now = () => new Date().toISOString()

const db = new DatabaseSync(file)

const badTurns = db.prepare("SELECT rowid, agent_id, text FROM chat_turns WHERE role='user'").all()
  .filter((r) => cleanUserText(r.text) === '')

const badMemories = db.prepare("SELECT id, agent_id, text FROM memory_items WHERE status='active'").all()
  .filter((r) => isNoiseMemory(r.text))

console.log('数据库：' + file)
console.log('待删 chat_turns 行：' + badTurns.length)
console.log('待软删 memory_items：' + badMemories.length)
for (const r of badMemories.slice(0, 5)) console.log('  · ' + String(r.text).slice(0, 80).replace(/\n/g, ' '))

if (!apply) {
  console.log('\n未加 --apply，什么都没改。')
  process.exit(0)
}

// 先备份
const dir = path.join(path.dirname(file), 'backups')
fs.mkdirSync(dir, { recursive: true })
const bak = path.join(dir, 'before-clean-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db')
fs.copyFileSync(file, bak)
console.log('\n已备份：' + bak)

const byAgent = new Map()
db.exec('BEGIN IMMEDIATE')
try {
  for (const r of badTurns) {
    db.prepare('DELETE FROM chat_turns WHERE rowid=?').run(r.rowid)
    byAgent.set(r.agent_id, (byAgent.get(r.agent_id) || 0) + 1)
  }
  for (const m of badMemories) {
    try { db.prepare('DELETE FROM memory_fts WHERE id=?').run(m.id) } catch { /* 可能没有 fts 行 */ }
    db.prepare("UPDATE memory_items SET status='soft_deleted', deleted_at=? WHERE id=?").run(now(), m.id)
    byAgent.set(m.agent_id, (byAgent.get(m.agent_id) || 0) + 1)
  }
  for (const [aid, n] of byAgent) {
    db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('chg_clean_' + Math.random().toString(16).slice(2, 10), null, aid,
        'memory.cleanup.runtime_noise', String(n), '0', now(), 'system', 'system', 'auto', null, null)
  }
  db.exec('COMMIT')
} catch (e) {
  try { db.exec('ROLLBACK') } catch { /* ignore */ }
  console.error('失败，已回滚：' + e.message)
  process.exit(1)
}
console.log('完成：删除 ' + badTurns.length + ' 行对话，软删 ' + badMemories.length + ' 条记忆，影响 ' + byAgent.size + ' 个意识体。')
