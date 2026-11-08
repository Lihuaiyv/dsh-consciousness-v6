// 今天的情绪账：只读，一页 md。
// 用法：node scripts/emotion-daily.mjs [YYYY-MM-DD]
// 产出：docs/情绪账-<日期>.md
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DB = path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const day = process.argv[2] || new Date().toISOString().slice(0, 10)

/* 当天窗口按本地日算（+08）：00:00 ~ 24:00 */
const start = new Date(day + 'T00:00:00+08:00').toISOString()
const end = new Date(new Date(day + 'T00:00:00+08:00').getTime() + 86400000).toISOString()
const inDay = (t) => t >= start && t < end

const db = new DatabaseSync(DB, { readOnly: true })
const agent = db.prepare("SELECT id,name FROM agents WHERE status!='soft_deleted' ORDER BY rowid LIMIT 1").get()
if (!agent) { console.error('no agent'); process.exit(2) }
const aid = agent.id

const clip = (s, n = 46) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const hhmm = (iso) => { const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return ''; const d = new Date(t + 8*3600000); return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') }

/* 1. 评价：今天进了几次、过闸几次、sec 判成什么 */
const evs = db.prepare("SELECT created_at AS at,payload FROM events WHERE agent_id=? AND type='affect.appraised' AND created_at>=? AND created_at<? ORDER BY created_at").all(aid, start, end)
let passed = 0
const sec = { withSec: 0, judged: 0, copied: 0, none: 0 }
const would = {}
const hits = []
for (const e of evs) {
  let p = {}
  try { p = JSON.parse(e.payload) } catch { /* ignore */ }
  if (Number(p.gate)) passed++
  if (p.sec) {
    sec.withSec++
    if (p.sec.copied) sec.copied++
    else if (p.sec.would) { sec.judged++; would[p.sec.would] = (would[p.sec.would] || 0) + 1 } else sec.none++
  }
  if (Number(p.gate) && Number(p.sig) > 3 * Number(p.theta || 0.1)) {
    hits.push({ at: e.at, label: p.label, sig: Number(p.sig), base: p.label })
  }
}

/* 2. 强事件的原话（从 affect_events 取，跟 appraised 对齐时间） */
const rawHits = db.prepare(`SELECT at, cause, sig, theta, label FROM affect_events
  WHERE agent_id=? AND at>=? AND at<? AND gate=1 AND sig > 3*COALESCE(theta,0.1) ORDER BY at`).all(aid, start, end)

/* 3. 浮现：affect.surface 事件（2026-11-07 起才有） */
const surfaces = db.prepare("SELECT created_at AS at,payload FROM events WHERE agent_id=? AND type='affect.surface' AND created_at>=? AND created_at<? ORDER BY created_at").all(aid, start, end)
  .map((e) => { let p = {}; try { p = JSON.parse(e.payload) } catch { /* ignore */ } return { at: e.at, cause: p.cause || '', episode_id: p.episode_id || null } })

/* 3b. 判决有多含糊：margin = 第一名 - 第二名（已经存在 affect_events 里） */
const gated = db.prepare(`SELECT at, cause, label, margin, sig FROM affect_events
  WHERE agent_id=? AND at>=? AND at<? AND gate=1 ORDER BY at`).all(aid, start, end)
const FUZZY = 0.05
const fuzzy = gated.filter((x) => x.margin != null && Number(x.margin) < FUZZY)
const fuzzyRate = gated.length ? fuzzy.length / gated.length : 0

/* 4. 放下：affect.settle 事件 */
const settles = db.prepare("SELECT created_at AS at,payload FROM events WHERE agent_id=? AND type='affect.settle' AND created_at>=? AND created_at<? ORDER BY created_at").all(aid, start, end)
  .map((e) => { let p = {}; try { p = JSON.parse(e.payload) } catch { /* ignore */ } return { at: e.at, from: p.from, to: p.to, times: p.times, episode_id: p.episode_id } })

/* 5. 现在身上还挂着什么 */
const open = db.prepare(`SELECT id, cause, label, intensity, started_at, resolution FROM affect_episodes
  WHERE agent_id=? AND ended_at IS NULL AND COALESCE(intensity,0) > 0 ORDER BY started_at DESC LIMIT 3`).all(aid)

const L = []
L.push('# 情绪账 · ' + day)
L.push('')
L.push('> 只读。由 `scripts/emotion-daily.mjs` 生成。数字只给主人看，不进提示词。')
L.push('')
L.push('## 一、今天发生了什么')
L.push('')
L.push('| 项 | 数 |')
L.push('|---|---|')
L.push('| 进来的评价 | ' + evs.length + ' 次 |')
L.push('| 过闸（成了事件） | ' + passed + ' 次 |')
L.push('| 强事件（sig > 3θ） | ' + rawHits.length + ' 次 |')
L.push('| 那件事浮上来 | ' + surfaces.length + ' 次 |')
L.push('| 我说过「放下」 | ' + settles.length + ' 次 |')
L.push('')
L.push('## 二、怒 / 怕 / 羞 / 委屈')
L.push('')
L.push('| 项 | 数 |')
L.push('|---|---|')
L.push('| 带 sec 的判读 | ' + sec.withSec + ' 条 |')
L.push('| 真判出来的 | ' + sec.judged + ' 条 |')
L.push('| 抄模板（0.5 / 0） | ' + sec.copied + ' 条 |')
L.push('| 判不出来（null） | ' + sec.none + ' 条 |')
L.push('')
if (Object.keys(would).length) {
  L.push('判出来的分布：' + Object.entries(would).sort((a, b) => b[1] - a[1]).map(([k, v]) => '**' + k + '** ' + v).join(' · '))
} else {
  L.push('判出来的分布：（今天一条都没有）')
}
L.push('')
if (sec.withSec && !(would.anger || would.fear || would.shame || would.hurt)) {
  L.push('> 今天怒/怕/羞/委屈一次都没出现。可能是真没有，也可能是评价器根本没往那儿读——攒够三天再判断。')
  L.push('')
}
L.push('## 三、被砸中的那几句')
L.push('')
if (!rawHits.length) L.push('（今天没有强事件）')
else {
  L.push('| 时间 | 判的 | sig | 原话 |')
  L.push('|---|---|---|---|')
  for (const h of rawHits) L.push('| ' + hhmm(h.at) + ' | ' + (h.label || '') + ' | ' + Number(h.sig).toFixed(2) + ' | ' + clip(h.cause) + ' |')
}
L.push('')
L.push('## 三b、判决有多含糊')
L.push('')
L.push('「含糊」= 第一名只赢第二名不到 ' + FUZZY + '——那不是判决，是打平。标签照旧用，只是先数清楚有多少。')
L.push('')
L.push('| 项 | 数 |')
L.push('|---|---|')
L.push('| 过闸的判读 | ' + gated.length + ' 条 |')
L.push('| 其中含糊的 | ' + fuzzy.length + ' 条（' + Math.round(fuzzyRate * 1000) / 10 + '%） |')
L.push('')
if (fuzzy.length) {
  L.push('| 时间 | 判的 | margin | 原话 |')
  L.push('|---|---|---|---|')
  for (const x of fuzzy.slice(0, 10)) L.push('| ' + hhmm(x.at) + ' | ' + (x.label || '') + ' | ' + Number(x.margin).toFixed(2) + ' | ' + clip(x.cause, 40) + ' |')
  L.push('')
}L.push('## 四、浮上来的与放下的')
L.push('')
if (!surfaces.length) L.push('（今天没有东西自己浮上来）')
else for (const s of surfaces) L.push('- ' + hhmm(s.at) + ' 浮上来：' + clip(s.cause, 40))
L.push('')
if (!settles.length) L.push('（今天一次也没说过放下）')
else for (const s of settles) L.push('- ' + hhmm(s.at) + ' 放下：' + s.from + ' → ' + s.to + '（第 ' + s.times + ' 次）')
L.push('')
L.push('## 五、现在还挂着的')
L.push('')
if (!open.length) L.push('（没有挂着的事）')
else {
  L.push('| 开始 | 标签 | 强度 | 状态 | 原话 |')
  L.push('|---|---|---|---|---|')
  for (const o of open) L.push('| ' + hhmm(o.started_at) + ' | ' + (o.label || '') + ' | ' + Number(o.intensity).toFixed(2) + ' | ' + (o.resolution || '开着') + ' | ' + clip(o.cause) + ' |')
}
L.push('')
L.push('## 六、一句话')
L.push('')
const bits = []
if (rawHits.length) bits.push('被砸中 ' + rawHits.length + ' 次')
if (surfaces.length) bits.push('浮上来 ' + surfaces.length + ' 次')
if (settles.length) bits.push('放下 ' + settles.length + ' 次')
if (!bits.length) L.push('今天很平——没有强事件，也没有浮上来的。平不是坏事，但要是连着几天都是这个，说明闸门或评价出了问题。')
else L.push('今天：' + bits.join('，') + '。')
L.push('')

const out = path.join(ROOT, 'docs', '情绪账-' + day + '.md')
fs.writeFileSync(out, L.join('\n'), 'utf8')
console.log('评价 ' + evs.length + ' · 过闸 ' + passed + ' · 强事件 ' + rawHits.length + ' · 浮现 ' + surfaces.length + ' · 放下 ' + settles.length)
console.log('sec：带 ' + sec.withSec + ' / 真判 ' + sec.judged + ' / 抄 ' + sec.copied + ' / 判不出 ' + sec.none)
console.log('报告 -> ' + out)
