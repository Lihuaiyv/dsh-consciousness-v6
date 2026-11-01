/**
 * 一次性迁移：把被标成 manual 的性格轴交回 auto（可重复跑，幂等）。
 *
 * 背景：旧 big5.* → axis.* 迁移时只改了 path、没改 origin，
 * 于是「曾经自动漂过」的轴被记成了 manual，setAxisAuto 直接跳过，永久冻住。
 *
 * 用法：
 *   node dsh-plugin/scripts/axis-unlock.mjs            # 只处理默认库
 *   node dsh-plugin/scripts/axis-unlock.mjs --dry      # 只看会改什么
 *   node dsh-plugin/scripts/axis-unlock.mjs --db <file>
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const dbIdx = argv.indexOf('--db')
const def = path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const file = dbIdx >= 0 && argv[dbIdx + 1] ? argv[dbIdx + 1] : def

if (!fs.existsSync(file)) {
  console.error('找不到数据库：' + file)
  process.exit(1)
}

const AXES = ['ei', 'sn', 'tf', 'jp', 'sensitivity']

// 先备份三件套（-wal / -shm 可能是最新数据）
if (!dry) {
  const dir = path.join(path.dirname(file), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = path.join(dir, 'axis-unlock-' + stamp + '.db')
  fs.copyFileSync(file, base)
  for (const ext of ['-wal', '-shm']) {
    try { fs.copyFileSync(file + ext, base + ext) } catch { /* 没有也正常 */ }
  }
  console.log('备份 → ' + base)
}

const db = new DatabaseSync(file)
const now = new Date().toISOString()
const nid = () => 'chg_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

let total = 0
const agents = db.prepare("SELECT DISTINCT agent_id FROM persona WHERE path LIKE 'axis.%'").all()
for (const { agent_id: aid } of agents) {
  for (const key of AXES) {
    const p = 'axis.' + key
    const row = db.prepare('SELECT value, origin FROM persona WHERE agent_id=? AND path=?').get(aid, p)
    if (!row || row.origin !== 'manual') continue
    console.log(`${dry ? '[dry] ' : ''}${aid} ${p}: ${row.value} manual → auto`)
    total++
    if (dry) continue
    db.prepare('UPDATE persona SET origin=?, updated_at=? WHERE agent_id=? AND path=?').run('auto', now, aid, p)
    // 留痕：changes 表 12 列
    db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(nid(), null, aid, 'persona.' + p, String(row.value), String(row.value), now, 'system', 'user', 'manual:unlock', null, null)
  }
}
console.log((dry ? '会改 ' : '已改 ') + total + ' 条轴')
db.close()
