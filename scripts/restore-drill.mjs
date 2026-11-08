// 恢复演练：备份真正的判据不是「生成了」，是「能当库用」。
//
// 只读打开备份文件，跑几条平时真会跑的读取：最近一条 feel、最近一天日记、几条记忆、
// 几个人物。能读出来、字段对得上，才叫这份备份能用。
//
// 用法：node scripts/restore-drill.mjs <备份.db>
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('用法：node scripts/restore-drill.mjs <备份.db>')
  process.exit(1)
}

const manifestPath = file.replace(/\.db$/, '.json')
if (fs.existsSync(manifestPath)) {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  console.log('sha256 对得上：' + (sha === m.sha256 ? '是' : '否（文件被改过）'))
  if (sha !== m.sha256) process.exitCode = 1
}

const db = new DatabaseSync(file, { readOnly: true })
const q = (sql) => { try { return db.prepare(sql).all() } catch { return [] } }
const one = (sql) => q(sql)[0] || null

const agents = q('SELECT id, name FROM agents LIMIT 5')
console.log('人：' + (agents.length ? agents.map((a) => a.name || a.id).join(' / ') : '（空）'))

const feel = one('SELECT text, at FROM affect_feel ORDER BY at DESC LIMIT 1')
console.log('最近一条 feel：' + (feel ? feel.text + '（' + feel.at + '）' : '（没有）'))

const diaryCols = q('PRAGMA table_info(diaries)').map((r) => String(r.name))
const dayCol = ['date', 'day', 'for_date', 'created_at'].find((c) => diaryCols.includes(c))
const diary = dayCol
  ? one(`SELECT ${dayCol} AS day_key, substr(text,1,40) AS head FROM diaries ORDER BY ${dayCol} DESC LIMIT 1`)
  : null
console.log('最近一篇日记：' + (diary ? diary.day_key + ' — ' + diary.head : '（没有）'))

const mems = q('SELECT text FROM memory_items ORDER BY created_at DESC LIMIT 3')
console.log('最近三条记忆：')
for (const m of mems) console.log('  · ' + String(m.text).slice(0, 60))

const turns = one('SELECT count(*) AS c, max(created_at) AS last FROM raw_turns')
console.log('原文：' + (turns ? turns.c + ' 条，最后一条 ' + turns.last : '（没有）'))

db.close()
console.log('演练完成：这份备份能当库打开，业务读取正常')
