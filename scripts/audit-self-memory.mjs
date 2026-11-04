/**
 * 存量记忆体检（P4）：看看「我记住的」里有多少是对方的档案、多少是我自己的。
 *
 * 默认只读。--apply 只做一件事：把「第三人称旁白」标成冷层（temp_state='cold'），
 * 不删、不改正文；apply 前先整库备份，并打印备份路径。
 *
 * 用法：
 *   node scripts/audit-self-memory.mjs
 *   node scripts/audit-self-memory.mjs --agent 小汐 --limit 12
 *   node scripts/audit-self-memory.mjs --agent 小汐 --apply
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const has = (k) => args.includes(k)
const val = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const ROOT = path.join(os.homedir(), '.dsh', 'consciousness')
const dbPath = val('--db', path.join(ROOT, 'app.db'))
const onlyAgent = val('--agent', '')
const limit = Math.max(1, Math.min(50, Number(val('--limit', 5)) || 5))
const apply = has('--apply')
const verify = has('--verify')

if (!fs.existsSync(dbPath)) {
  console.error('找不到库：' + dbPath)
  process.exit(1)
}

// 旁白判定：和 memory_source.narrationOnly 同口径（脚本不引 src，避免把插件整包拉起来）
const NARRATION = [
  /^(用户|对方|他|她|助手|对话)(正在|要求|偏好|已|只|想|关注|提到|询问|希望|表示|指出|确认|在)/,
  /^(用户|对方|助手)的(事实|偏好|情绪|需求|请求|意图)/,
  /对话中没有|未被明确表达|事实层面|从对话中可确认/,
]
const isNarration = (t) => NARRATION.some((re) => re.test(String(t || '').trim()))

if (apply) {
  const dir = path.join(ROOT, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = path.join(dir, 'audit-self-' + stamp + '.db')
  // 库开着 WAL，copyFileSync 只拿主文件会漏掉 -wal 里最近的写；VACUUM INTO 出一致快照。
  const snap = new DatabaseSync(dbPath)
  snap.exec('PRAGMA busy_timeout=8000')
  try {
    snap.exec("VACUUM INTO '" + bak.replace(/'/g, "''") + "'")
  } finally {
    snap.close()
  }
  console.log('已备份：' + bak)
}

const db = new DatabaseSync(dbPath, { readOnly: !apply })
if (apply) db.exec('PRAGMA busy_timeout=8000')
const rows = db.prepare(`SELECT id, agent_id, text, source, type, temp_state, created_at, importance
  FROM memory_items WHERE deleted_at IS NULL AND status='active'`).all()

const byAgent = new Map()
for (const r of rows) {
  if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, [])
  byAgent.get(r.agent_id).push(r)
}

const names = new Map()
try {
  for (const a of db.prepare('SELECT id,name FROM agents').all()) names.set(a.id, a.name)
} catch { /* 老库没有 agents 表 */ }

const pct = (n, d) => d ? (n * 100 / d).toFixed(1) + '%' : '0%'

let applied = 0
for (const [aid, list] of byAgent) {
  const name = names.get(aid) || aid
  if (onlyAgent && onlyAgent !== aid && onlyAgent !== name) continue
  const n = list.length
  const narrator = list.filter((r) => isNarration(r.text) || (r.source === 'summary' && /^用户/.test(String(r.text))))
  const self = list.filter((r) => r.source === 'self')
  const life = list.filter((r) => r.source === 'life')
  const summary = list.filter((r) => r.source === 'summary')
  const withUser = list.filter((r) => String(r.text).includes('用户'))
  const firstPerson = list.filter((r) => String(r.text).trim().startsWith('我'))
  console.log('\n=== ' + name + '（' + aid + '）===')
  console.log('存活记忆 ' + n)
  console.log('  旁白（用户正在/要求/偏好…）' + narrator.length + '  ' + pct(narrator.length, n))
  console.log('  含「用户」两个字           ' + withUser.length + '  ' + pct(withUser.length, n))
  console.log('  以「我」开头               ' + firstPerson.length + '  ' + pct(firstPerson.length, n))
  console.log('  summary 来源               ' + summary.length + '  ' + pct(summary.length, n))
  console.log('  self（我自己记得的）       ' + self.length + '  ' + pct(self.length, n))
  console.log('  life（我自己看到的）       ' + life.length + '  ' + pct(life.length, n))
  console.log('  自己的占比                 ' + pct(self.length + life.length, n))
  if (verify) {
    const cold = list.filter((r) => r.temp_state === 'cold')
    const coldNarr = cold.filter((r) => isNarration(r.text) || (r.source === 'summary' && /^用户/.test(String(r.text))))
    const warmNarr = narrator.filter((r) => r.temp_state !== 'cold')
    console.log('  冷层（temp_state=cold）    ' + cold.length + '  ' + pct(cold.length, n))
    console.log('  冷层里的旁白（已退下）     ' + coldNarr.length)
    console.log('  还露在外面的旁白           ' + warmNarr.length + (warmNarr.length ? '  ← 还有漏网' : '  ← 已清干净'))
  }

  if (limit) {
    console.log('  -- 旁白样本 --')
    for (const r of narrator.slice(0, limit)) console.log('   · ' + String(r.text).replace(/\s+/g, ' ').slice(0, 60))
    if (self.length) {
      console.log('  -- 她自己的样本 --')
      for (const r of self.slice(0, limit)) console.log('   · ' + String(r.text).replace(/\s+/g, ' ').slice(0, 60))
    }
  }

  if (apply && narrator.length) {
    const upd = db.prepare("UPDATE memory_items SET temp_state='cold', state_since=? WHERE id=? AND (temp_state IS NULL OR temp_state<>'cold')")
    const nowIso = new Date().toISOString()
    for (const r of narrator) { upd.run(nowIso, r.id); applied++ }
  }
}

if (apply) console.log('\n已标冷（不删、正文不动）：' + applied + ' 条')
else if (verify) console.log('\n复检完成：「冷层里的旁白」应接近 0，说明旁白都退到深查层了（回看/深查仍翻得到）。')
else console.log('\n这是只读体检。要标冷跑：node scripts/audit-self-memory.mjs --agent 小汐 --apply')
db.close()
