/**
 * 一次性清理（2026-10-30）：
 *   1) 孤儿参数 drive.setpoint.R/E/C/A/S —— 代码早就不读它们了（setpoint 现在从
 *      drive_state.setpoint 学），库里还留着五行，改它们完全没有效果，只会误导。
 *   2) changes.rolled_back_at 里的说明性文字（'手调' / 'shrink'）—— 这个字段是时间戳，
 *      写文字进去等于把「有人动过」当成了「被回滚」。代码已经只认 ISO 了，数据也一起洗干净。
 *
 * 跑之前先整库备份。只删/改上面点名的行，别的一概不动。
 *   node scripts/fix-orphans-20261030.mjs [--dry]
 */
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dry = process.argv.includes('--dry')
const file = path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
if (!fs.existsSync(file)) { console.error('找不到库：' + file); process.exit(1) }

const ORPHANS = ['drive.setpoint.R', 'drive.setpoint.E', 'drive.setpoint.C', 'drive.setpoint.A', 'drive.setpoint.S']
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

if (!dry) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const bak = file + '.bak-orphans-' + stamp
  fs.copyFileSync(file, bak)
  console.log('备份 → ' + bak)
}

const db = new DatabaseSync(file)
const q = (sql, ...a) => db.prepare(sql).all(...a)

const before = q(`SELECT agent_id, key, value FROM agent_params WHERE key IN (${ORPHANS.map(() => '?').join(',')}) ORDER BY agent_id, key`, ...ORPHANS)
console.log('孤儿参数 ' + before.length + ' 行：')
for (const r of before) console.log('  ' + r.agent_id + '  ' + r.key + ' = ' + r.value)

const dirty = q("SELECT id, agent_id, rolled_back_at FROM changes WHERE rolled_back_at IS NOT NULL AND rolled_back_at NOT LIKE '20%'")
console.log('脏 rolled_back_at ' + dirty.length + ' 行：')
for (const r of dirty) console.log('  ' + r.id + '  ' + JSON.stringify(r.rolled_back_at))

if (dry) { console.log('\n--dry：什么都没改'); process.exit(0) }

const d1 = db.prepare(`DELETE FROM agent_params WHERE key IN (${ORPHANS.map(() => '?').join(',')})`).run(...ORPHANS)
let d2 = 0
for (const r of dirty) d2 += db.prepare('UPDATE changes SET rolled_back_at=NULL WHERE id=? AND rolled_back_at=?').run(r.id, r.rolled_back_at).changes

console.log('\n删掉参数 ' + Number(d1.changes) + ' 行；洗掉 rolled_back_at ' + d2 + ' 行')

const after1 = q(`SELECT COUNT(*) c FROM agent_params WHERE key IN (${ORPHANS.map(() => '?').join(',')})`, ...ORPHANS)[0].c
const after2 = q("SELECT COUNT(*) c FROM changes WHERE rolled_back_at IS NOT NULL AND rolled_back_at NOT LIKE '20%'")[0].c
const kept = q('SELECT COUNT(*) c FROM agent_params')[0].c
console.log('复查：孤儿参数 ' + after1 + ' 行（应为 0），脏时间戳 ' + after2 + ' 行（应为 0），其余参数还有 ' + kept + ' 行')
