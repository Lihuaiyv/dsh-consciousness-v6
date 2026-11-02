/**
 * 给历史原话补 turn_id（默认 dry-run，只看不写）。
 *
 *   node scripts/backfill-turn-ids.mjs              # 只看统计 + 抽样
 *   node scripts/backfill-turn-ids.mjs --apply      # 真写
 *   node scripts/backfill-turn-ids.mjs --agent=agt_xxx
 *
 * 配对规则：同一 session 内 seq 紧邻、user 后面紧跟 assistant → 认成同一轮。
 * 其他（连续两条 user、assistant 开头、间隔的行）各自独立一个 turn_id。
 * 只写 turn_id 这一列；正文、时间、seq 一概不动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backfillTurnIds } from '../src/modules/archive.js'

const apply = process.argv.includes('--apply')
const agentArg = process.argv.find((a) => a.startsWith('--agent='))
const agent = agentArg ? agentArg.slice('--agent='.length) : null

const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
const dbPath = path.join(process.env.DSH_HOME || path.join(home, '.dsh'), 'consciousness', 'app.db')
if (!fs.existsSync(dbPath)) { console.error('找不到库：' + dbPath); process.exit(2) }

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout=5000')

function rowsOf(aid) {
  const where = aid ? 'WHERE agent_id=?' : ''
  const st = db.prepare(`SELECT id, agent_id, session_id, seq, role, turn_id, substr(text,1,42) AS t
    FROM raw_turns ${where} ORDER BY session_id, seq`)
  return aid ? st.all(aid) : st.all()
}

const agents = agent
  ? [agent]
  : db.prepare('SELECT DISTINCT agent_id FROM raw_turns').all().map((r) => r.agent_id)

let totalRows = 0, already = 0, paired = 0, single = 0, sessionCount = new Set()
const samples = []

for (const aid of agents) {
  const rows = rowsOf(aid)
  totalRows += rows.length
  for (const r of rows) {
    sessionCount.add(r.session_id)
    if (r.turn_id) already++
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.turn_id) continue
    const nx = rows[i + 1]
    const canPair = nx && !nx.turn_id && nx.session_id === r.session_id
      && Number(nx.seq) === Number(r.seq) + 1 && r.role === 'user' && nx.role === 'assistant'
    if (canPair) {
      paired++
      if (samples.length < 5) {
        samples.push(['成对', r.session_id, r.t, nx.t])
      }
      i++
    } else {
      single++
      if (samples.length < 8 && single % 97 === 0) {
        samples.push([r.role === 'user' ? '单独user' : '单独' + r.role, r.session_id, r.t, ''])
      }
    }
  }
}

console.log('=== 配对预演（不写库）===')
console.log('总行数        ', totalRows)
console.log('已有 turn_id  ', already)
console.log('会配成对      ', paired, '对（' + paired * 2 + ' 行）')
console.log('单独成轮      ', single, '行')
console.log('涉及会话      ', sessionCount.size, '个')
console.log('\n=== 抽样 ===')
for (const [kind, sid, a, b] of samples) {
  console.log(`[${kind}] ${String(sid).slice(0, 12)}`)
  console.log('   user: ' + a)
  if (b) console.log('   asst: ' + b)
}

if (!apply) {
  console.log('\n（dry-run，什么都没改。加 --apply 才写库）')
  db.close()
  process.exit(0)
}

console.log('\n=== 开始写库 ===')
let wrote = 0
for (const aid of agents) {
  const n = backfillTurnIds(db, aid)
  wrote += n
  console.log(' ', aid, '→', n, '行')
}
db.close()
console.log('共写入', wrote, '行')
