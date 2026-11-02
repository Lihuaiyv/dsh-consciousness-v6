/**
 * P0 拔根 · 一次性迁移：把旧十维价值观的残根从线上库清掉。
 *
 * 做两件事（账本只增 / 旧表只删）：
 *   1. 撤回 V 层 origin=seed 的空心命题（旧表折出来的那几句）——CLAIM_WITHDRAW，不是 DELETE
 *   2. 清空 persona_values 全部行（已无代码读写它）
 *
 * 用法：node scripts/kernel-p0-retire.mjs [dbPath] [--dry]
 * 默认库：%USERPROFILE%\.dsh\consciousness\app.db
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { retireOldValues } from '../src/modules/sangguan/retire.js'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const dbPath = args.find((a) => !a.startsWith('--')) || path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
if (!fs.existsSync(dbPath)) {
  console.error('找不到库：' + dbPath)
  process.exit(1)
}

if (!dry) {
  // 迁移前先备份：脚本会改线上库，出错要能退回去
  const bakDir = path.join(path.dirname(dbPath), 'backups')
  fs.mkdirSync(bakDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const bak = path.join(bakDir, 'kernel-p0-' + stamp + '.db')
  fs.copyFileSync(dbPath, bak)
  console.log('备份：' + bak)
}

const db = openDb(dbPath)
const before = {}
try { before.persona_values = db.prepare('SELECT COUNT(*) n FROM persona_values').get().n } catch { before.persona_values = 0 }
before.v_seed = 0
for (const a of db.prepare('SELECT id FROM agents').all()) {
  try { before.v_seed += db.prepare("SELECT COUNT(*) n FROM persona_claims WHERE agent_id=? AND layer='V' AND origin='seed'").get(a.id).n } catch { /* 空库 */ }
}

const at = now()
if (dry) {
  // 只看会动到什么，不落任何账
  const would = []
  try {
    const rows = db.prepare("SELECT id,agent_id,text FROM persona_claims WHERE layer='V' AND origin='seed'").all()
    would.push(...rows.map((r) => ({ agent: r.agent_id, id: r.id, text: r.text })))
  } catch { /* 空库 */ }
  console.log(JSON.stringify({ dry: true, db: dbPath, before, would_withdraw: would }, null, 2))
  db.close()
  process.exit(0)
}

const r = retireOldValues(db, at)
const after = {}
try { after.persona_values = db.prepare('SELECT COUNT(*) n FROM persona_values').get().n } catch { after.persona_values = 'no-table' }
after.v_seed = r.v_seed_after

console.log(JSON.stringify({ db: dbPath, before, ...r, after }, null, 2))
db.close()
