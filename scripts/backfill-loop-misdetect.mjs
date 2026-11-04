/**
 * 回填：把「按新规则根本不会挂」的历史开环标成 misdetect。
 *   node scripts/backfill-loop-misdetect.mjs            # 只看看，不写
 *   node scripts/backfill-loop-misdetect.mjs --apply    # 真写（先自动备份）
 *
 * 只改 closed_by 一个字段，不删行、不动 state、不动别的表。
 * 为什么留着：这些行是「以前误判的证据」，删掉就不知道以前为什么错；
 * 标一个 misdetect，后面算误关率时能把它们排掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDb } from '../src/db.js'
import { detectLoop } from '../src/modules/loops.js'

const APPLY = process.argv.includes('--apply')
const DB = process.env.DSHC_DB || path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
if (!fs.existsSync(DB)) {
  console.error('找不到库：' + DB)
  process.exit(2)
}

const db = openDb(DB)
const agents = db.prepare('SELECT id,name FROM agents').all()

/**
 * 「当年为什么错」的四个特征：虚词钓上来、问句、状态汇报、技术噪音。
 * 只标**同时**满足「新规则不会挂」+「说得出错在哪」的——否则会把真待办也标成误判。
 */
const SUSPICIOUS = /(之后|再说|剩下|收尾|最后一步)|[？?]\s*$|(吗|呢)\s*[。！!…]*$|(是不是|有没有|要不要|能不能|可不可以|对不对)/
/** 但句子里明摆着在给她派活（给自己 / 帮我 / 你去问）的，就算命中上面也别标——那是真待办。 */
const REAL_TASK = /(给我|帮我|你去|替我|麻烦你|请你|给自己|你问)/

let scanned = 0
const misdetect = []
for (const a of agents) {
  const rows = db.prepare('SELECT id,kind,text,state,closed_by,created_at FROM open_loops WHERE agent_id=?').all(a.id)
  for (const r of rows) {
    scanned++
    const t = String(r.text || '')
    if (detectLoop(t) !== null) continue      // 新规则会挂：不是误判
    if (!SUSPICIOUS.test(t)) continue         // 说得出错在哪：才算误判
    if (REAL_TASK.test(t)) continue           // 明摆着在派活：不标
    misdetect.push({ agent: a.name, ...r })
  }
}

console.log('库：' + DB)
console.log('扫描开环 ' + scanned + ' 条，标为误判的：' + misdetect.length + ' 条')
for (const r of misdetect.slice(0, 20)) {
  console.log('  [' + r.state + '/' + (r.closed_by || '—') + '] ' + String(r.text).slice(0, 40))
}
if (misdetect.length > 20) console.log('  …还有 ' + (misdetect.length - 20) + ' 条')

if (!APPLY) {
  console.log('\n（没写。加 --apply 才真改）')
  process.exit(0)
}

// 先备份：用 VACUUM INTO 拿一份一致快照（运行中的库直接复制 .db 会缺 WAL）
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const bak = path.join(os.homedir(), '.dsh', 'consciousness', 'backups', 'loop-misdetect-' + stamp + '.db')
fs.mkdirSync(path.dirname(bak), { recursive: true })
if (!fs.existsSync(bak)) {
  db.exec("VACUUM INTO '" + bak.replace(/'/g, "''") + "'")
}
console.log('备份：' + bak)

const upd = db.prepare("UPDATE open_loops SET closed_by='misdetect', updated_at=? WHERE id=?")
const at = new Date().toISOString()
let n = 0
for (const r of misdetect) {
  upd.run(at, r.id)
  n++
}
console.log('已标 misdetect：' + n + ' 条')

const by = db.prepare("SELECT COALESCE(closed_by,'—') b, COUNT(*) n FROM open_loops GROUP BY b").all()
console.log('closed_by 分布：' + JSON.stringify(by))
