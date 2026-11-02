/**
 * 说话质感：拿真实对话库算基线，不看感觉看数字。
 *
 *   node scripts/style-stats.mjs               # 默认读 ~/.dsh/consciousness/app.db
 *   node scripts/style-stats.mjs <db 路径>
 *
 * 只读：先把库拷到临时目录再开，绝不碰线上的库。
 *
 * 五个指标（都能被一次改动直接影响）：
 *   字均长     —— 一条回复多少字
 *   分点率     —— 用「- / 1. / •」列点的比例（报告体的最强信号）
 *   总结句率   —— 结尾出现「总之 / 综上 / 以上 / 希望…」
 *   语气词密度 —— 呀啦呢吧嗯欸 每百字
 *   改口痕迹   —— ——、……、「不对」「算了」每百字
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const arg = process.argv[2]
const home = process.env.USERPROFILE || process.env.HOME || '.'
const src = arg || path.join(home, '.dsh', 'consciousness', 'app.db')
if (!fs.existsSync(src)) {
  console.error('找不到库：' + src)
  process.exit(2)
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-style-'))
const copy = path.join(dir, 'app.db')
fs.copyFileSync(src, copy)
for (const ext of ['-wal', '-shm']) {
  const f = src + ext
  if (fs.existsSync(f)) fs.copyFileSync(f, copy + ext)
}

const db = new DatabaseSync(copy, { readOnly: true })
let rows = []
try {
  rows = db.prepare("SELECT text FROM chat_turns WHERE role='agent' AND length(text) > 0 ORDER BY created_at DESC LIMIT 400").all()
} catch (e) {
  console.error('读不到 chat_turns：' + e.message)
  process.exit(2)
}
db.close()

const texts = rows.map((r) => String(r.text || '')).filter(Boolean)
const N = texts.length
if (!N) {
  console.log('库里还没有 assistant 回复，没法算基线。')
  process.exit(0)
}

const chars = (s) => Array.from(s).length
const BULLET = /(^|\n)\s*(?:[-•*]|\d+[.)、])\s+/m
const SUMMARY = /(总之|综上所述|综上|以上|希望(这|能|对你)|如果需要|要不要我|我可以帮你)/
const PARTICLE = /[呀啦呢吧嘛欸嗯哦噢诶]/g
const RETRACT = /(——|……|不对|算了|或者说|其实)/g
// 干活回合：带代码块 / 路径 / 命令 / 测试字样。用来把「闲聊」和「干活」分开算，
// 不然一堆长报告会把「说话质感」的账算歪。
const WORK = /```|(^|\s)(git|npm|pnpm|node|cd|ls|pwsh)\s|C:\\|\/|\.mjs|\.js\b|\.ts\b|测试|报错|编译|接口|函数/

function rate(re, s) {
  const m = String(s).match(re)
  return m ? m.length : 0
}

/** 一组回复的全部指标。 */
function stats(list) {
  const N = list.length
  if (!N) return null
  const lens = list.map(chars).sort((a, b) => a - b)
  const sum = lens.reduce((a, b) => a + b, 0)
  const avg = sum / N
  const variance = lens.reduce((s, x) => s + (x - avg) ** 2, 0) / N
  const totalChars = sum || 1
  return {
    turns: N,
    avg_chars: Math.round(avg),
    median_chars: lens[Math.floor(N / 2)],
    std_chars: Math.round(Math.sqrt(variance)),
    p90_chars: lens[Math.floor(N * 0.9)],
    short_rate: Math.round((list.filter((t) => chars(t) <= 60).length / N) * 1000) / 10 + '%',
    bullet_rate: Math.round((list.filter((t) => BULLET.test(t)).length / N) * 1000) / 10 + '%',
    summary_rate: Math.round((list.filter((t) => SUMMARY.test(String(t).slice(-60))).length / N) * 1000) / 10 + '%',
    particle_per100: Math.round((list.reduce((s, t) => s + rate(PARTICLE, t), 0) / totalChars) * 10000) / 100,
    retract_per100: Math.round((list.reduce((s, t) => s + rate(RETRACT, t), 0) / totalChars) * 10000) / 100,
  }
}

const chat = texts.filter((t) => !WORK.test(t))
const work = texts.filter((t) => WORK.test(t))

console.log(JSON.stringify({
  db: src,
  all: stats(texts),
  chat: stats(chat),
  work: stats(work),
}, null, 2))
