// 手动重新生成「可读版」文件（不重启 DSH 时用）
// 用法: node scripts/regen-docs.mjs [agentId]
import { DatabaseSync } from 'node:sqlite'
import { exportDocs, getDocsRoot } from '../src/modules/vault.js'

const DB = process.env.DSH_DB || 'C:/Users/ygys1/.dsh/consciousness/app.db'
const db = new DatabaseSync(DB, { readOnly: true })

const aid = process.argv[2] || db.prepare(
  'SELECT agent_id AS a, COUNT(*) AS n FROM raw_turns GROUP BY agent_id ORDER BY n DESC LIMIT 1'
).get()?.a

if (!aid) { console.error('没有找到 agent'); process.exit(1) }

const root = getDocsRoot(db)
console.log('agent :', aid)
console.log('root  :', root)
const out = exportDocs(db, aid, { root })
console.log('files :', out.files, ' days:', out.days)
db.close()
