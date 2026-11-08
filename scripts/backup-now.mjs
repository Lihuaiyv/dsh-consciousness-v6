// 立刻做一份「一致性快照」备份。
//
// 为什么不是直接拷贝 app.db：
//   - 库在 WAL 模式下，正在写的时候直接拷文件，可能拷到写了一半的状态；
//   - 备份必须是一个能直接打开的库，不是一堆片段。
// 所以用 SQLite 自己的 `VACUUM INTO`——它在一个读事务里把库完整写成一个新文件，
// 主库继续被插件写也不影响；出来的文件自带校验（能打开、能查）。
//
// 用法：node scripts/backup-now.mjs [输出目录]
// 输出：<目录>/app-<时间戳>.db + app-<时间戳>.json（条数、最近一条、sha256）
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { home, dbPath } from '../src/paths.js'

// 库路径只从 src/paths.js 取：DSH_DB → DSH_HOME → 当前用户 ~/.dsh。
// 以前这里写 os.homedir()，换用户或自定义 DSH_HOME 时会备份错库。
const src = dbPath()
if (!fs.existsSync(src)) {
  console.error('找不到库：' + src)
  process.exit(1)
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const outDir = path.resolve(process.argv[2] || path.join(home(), 'consciousness', 'backups'))
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, `app-${stamp}.db`)
if (fs.existsSync(out)) {
  console.error('目标已存在，先挪开：' + out)
  process.exit(1)
}

const db = new DatabaseSync(src)
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`)

const TABLES = ['agents', 'raw_turns', 'episodes', 'memory_items', 'affect_feel', 'diaries', 'chat_turns']
const counts = {}
for (const t of TABLES) {
  try { counts[t] = Number(db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c) } catch { counts[t] = null }
}
function latestOf(table) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name))
    const col = ['created_at', 'at', 'ts', 'time'].find((c) => cols.includes(c))
    if (!col) return null
    const row = db.prepare(`SELECT max(${col}) AS m FROM ${table}`).get()
    return row && row.m != null ? String(row.m) : null
  } catch { return null }
}
const latest = {}
for (const t of ['raw_turns', 'memory_items', 'affect_feel', 'diaries']) latest[t] = latestOf(t)
db.close()

const bytes = fs.readFileSync(out)
const sha = createHash('sha256').update(bytes).digest('hex')
const manifest = { at: new Date().toISOString(), source: src, file: out, bytes: bytes.length, sha256: sha, counts, latest }
const manifestPath = out.replace(/\.db$/, '.json')
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

// 备份要自己验一遍：能打开、条数对得上，才算数。
const check = new DatabaseSync(out, { readOnly: true })
const verify = {}
for (const t of TABLES) {
  try { verify[t] = Number(check.prepare(`SELECT count(*) AS c FROM ${t}`).get().c) } catch { verify[t] = null }
}
check.close()
const bad = TABLES.filter((t) => counts[t] !== verify[t])

console.log('备份完成：' + out)
console.log('大小：' + (bytes.length / 1024 / 1024).toFixed(1) + ' MB')
console.log('sha256：' + sha)
console.log('条数：' + TABLES.map((t) => t + '=' + (counts[t] ?? '无')).join('  '))
console.log('最近一条：' + Object.entries(latest).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join('  '))
console.log(bad.length ? '校验失败：' + bad.join(',') : '校验：新文件能打开，条数与主库一致')
if (bad.length) process.exitCode = 1
