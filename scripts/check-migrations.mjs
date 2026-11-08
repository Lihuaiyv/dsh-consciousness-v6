// 迁移断言的界桩：每件零件写一句「表 / 读 / 回退」，这里查它是不是真的。
// 运行：node scripts/check-migrations.mjs
//
// 查四件事（对应术语表「换要带迁移断言：旧数据能读、能切回」）：
//   1. assert 非空，格式是「表：…；读：…；回退：…」
//   2. 表名在 schema 里真的存在（写「无」表示不落表）
//   3. 读的公开函数真在零件文件里导出着
//   4. 回退 tag 就是零件册里那个，且真的存在
//
// 注意它不证明「旧行读得出」——那要等第一次真换、有旧版本数据可回放时才验；
// 这里先钉住「表 / 读 / 回退」三样没有漂。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { PARTS } from '../src/modules/parts.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-migrations-'))
const db = openDb(path.join(dir, 'app.db'))
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name)))

let fail = 0
const red = (msg) => { fail++; console.log('FAIL ' + msg) }

for (const p of PARTS) {
  const tag = p.id || '(缺 id)'
  const a = String(p.assert || '').trim()
  const m = a.match(/^表：(.+?)；读：(.+?)；回退：(\S+)$/)
  if (!m) { red(tag + '：assert 要写成「表：…；读：…；回退：…」'); continue }
  const tableNames = m[1].split('/').map((s) => s.trim()).filter(Boolean)
  const readers = m[2].split('/').map((s) => s.trim()).filter(Boolean)
  const pointer = m[3].trim()

  if (tableNames[0] !== '无') {
    for (const t of tableNames) if (!tables.has(t)) red(tag + '：assert 里的表不存在 ' + t)
  }
  const src = (p.files || []).map((f) => {
    try { return fs.readFileSync(path.join(root, f), 'utf8') } catch { return '' }
  }).join('\n')
  // 非 JS 零件（比如画板是 python + html）没有 JS 导出可查：读函数写在那里是给人看的文档，
  // 只校验「名字写在册子里」，不校验「export 出来」（那是 JS 零件才有的约束）。
  const jsFiles = (p.files || []).filter((f) => /\.(js|mjs|cjs)$/.test(f))
  if (jsFiles.length > 0) {
    for (const n of readers) {
      const re = new RegExp('export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+' + n + '\\b|export\\s*\\{[^}]*\\b' + n + '\\b')
      if (!re.test(src)) red(tag + '：assert 里的读函数 ' + n + ' 不在零件文件里导出着')
    }
  }
  const want = String(p.rollback && p.rollback.pointer || '')
  if (pointer !== want) red(tag + '：assert 回退点 ' + pointer + ' 和零件册里的 ' + (want || '(空)') + ' 不一致')
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', pointer], { cwd: root, stdio: 'ignore', timeout: 20000 })
  if (r.status !== 0) red(tag + '：回退 tag 不存在 ' + pointer)
}

console.log(fail ? '\n迁移断言界桩：' + fail + ' 条红' : '\n迁移断言界桩：全绿（' + PARTS.length + ' 个零件）')
if (fail) process.exitCode = 1
