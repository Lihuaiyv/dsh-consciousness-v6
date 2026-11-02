/**
 * 真机预演：拿活库的副本，把当初混进来的那几句话重新走一遍完整落地通路。
 * 目的：证明重启之后同一段对话不会再污染三观——不是靠单测，是靠跑真状态。
 *
 * 只读副本，不碰原件。
 * 用法：node scripts/probe-stance-live.mjs [db路径] [aid]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const src = process.argv[2] || path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const aid = process.argv[3] || 'agt_3977d80f17'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-stance-'))
const dst = path.join(tmp, 'app.db')
fs.copyFileSync(src, dst)
for (const s of ['-wal', '-shm']) { try { fs.copyFileSync(src + s, dst + s) } catch { /* ignore */ } }
process.env.DSH_HOME = tmp

const { openDb } = await import('../src/db.js')
const { placeOne } = await import('../src/modules/sangguan/fast.js')

const db = openDb(dst)
const at = new Date().toISOString()

// 当初从对话里混进 W / L 的原话
const BAD = [
  { layer: 'W', kind: 'obs', text: '电脑关机或插件没开，这套服务就不存在，微信也发不出去。' },
  { layer: 'W', kind: 'obs', text: '线上 dsh-consciousness-v6 的 536 个测试全过，代码本身没有问题。' },
  { layer: 'W', kind: 'belt', text: '项目真正乱的地方在于同一份东西存在多份，而不在代码质量。' },
  { layer: 'W', kind: 'belt', text: '桌面 dsh-plugin 是一份过期副本，比线上少 255 个文件，而且两边互有缺失。' },
  { layer: 'L', kind: 'chapter', text: '先做开机自启和后台守护，把本机长时间在线跑顺，再考虑上服务器。' },
]
// 真立场：应该照常放行（不一定变成核心，但不该被立场闸拒）
const GOOD = [
  { layer: 'W', kind: 'belt', text: '人多数时候愿意讲道理，只是要先被听完' },
  { layer: 'V', kind: 'norm', text: '我更看重把话说清楚，而不是说得漂亮' },
]

const out = []
out.push('库：' + dst)
out.push('agent：' + aid)
out.push('')
for (const x of BAD) {
  const r = await placeOne({ db, aid, at: new Date().toISOString() }, x, ['probe'])
  out.push('[该拒] ' + x.layer + ' ' + x.text.slice(0, 40) + ' → ' + r.cls + (r.reason ? ' (' + r.reason + ')' : ''))
}
out.push('')
for (const x of GOOD) {
  const r = await placeOne({ db, aid, at: new Date().toISOString() }, x, ['probe'])
  const bad = r.cls === 'REJECT' && r.reason === 'not_stance'
  out.push('[该放] ' + x.layer + ' ' + x.text.slice(0, 40) + ' → ' + r.cls + (r.reason ? ' (' + r.reason + ')' : '') + (bad ? '  << 误杀' : ''))
}
const text = out.join('\n')
fs.writeFileSync(path.join(process.cwd(), '_probe_stance.txt'), text, 'utf8')
console.log(text)
db.close()
fs.rmSync(tmp, { recursive: true, force: true })
