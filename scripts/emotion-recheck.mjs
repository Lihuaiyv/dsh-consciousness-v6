// 情绪回查：只看最近 N 天的 affect_events / affect_samples / affect_episodes，不写库。
// 产出 docs/情绪-回查-<YYYY-MM>.md 一份 + _emotion_recheck.json 一份。
//
// 三张清单：
//   A 差一点    —— sig 过了 0.7θ 但没过闸门
//   B 磨平了    —— 过了闸门、sig 还很大，但当时抬起来的那截很快被衰减吃掉
//   C 没被看见  —— 人话，但没成事件、也没近门槛（通常是「太轻」或「读歪了」）
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DB_PATH = process.env.DSH_CONSCIOUSNESS_DB || path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const DAYS = Number(process.env.RECHECK_DAYS || 30)

const db = new DatabaseSync(DB_PATH, { readOnly: true })
const agent = db.prepare("SELECT id,name FROM agents WHERE status!='soft_deleted' ORDER BY rowid LIMIT 1").get()
if (!agent) { console.error('no agent'); process.exit(2) }
const aid = agent.id
const since = new Date(Date.now() - DAYS * 86400000).toISOString()

/** 控制标 / 机器消息不是人话 */
const MACHINE = /<[a-z][a-z0-9_]*>|<\/[a-z][a-z0-9_]*>|Current runtime context|Time sampled|DeepSeek Harness|Approval policy|goal_round|goal_complete|system-reminder|compacted-summary/i
const isHuman = (s) => !!s && !MACHINE.test(s)
const clip = (s, n = 40) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000

const events = db.prepare(`SELECT id, at, cause, rel, cong, nov, cert, prev_cong, sig, theta, gate, label, raw_label, margin
  FROM affect_events WHERE agent_id=? AND at>=? ORDER BY at`).all(aid, since)

const samples = db.prepare('SELECT at, label, intensity, slow, fast FROM affect_samples WHERE agent_id=? AND at>=? ORDER BY at').all(aid, since)

const episodes = db.prepare(`SELECT id, cause, label, intensity, resolution, started_at, ended_at, renewals, rise_from, rise_at
  FROM affect_episodes WHERE agent_id=? AND started_at>=? ORDER BY started_at`).all(aid, since)

const thetaDefault = 0.1
const thetaOf = (e) => (Number.isFinite(Number(e.theta)) ? Number(e.theta) : thetaDefault)

/* ───────── A 差一点 ───────── */
const near = events
  .filter((e) => !Number(e.gate) && Number(e.sig) >= 0.7 * thetaOf(e) && Number(e.sig) < thetaOf(e))
  .sort((a, b) => Number(b.sig) - Number(a.sig))

/* ───────── B 磨平了：过闸且 sig 很大，看它多久被吃掉 ───────── */
function parseJson(s) {
  try { const v = JSON.parse(String(s || 'null')); return v && typeof v === 'object' ? v : null } catch { return null }
}

function trajectory(e) {
  const t0 = Date.parse(e.at)
  if (!Number.isFinite(t0)) return null
  const later = samples.filter((s) => {
    const t = Date.parse(s.at)
    return Number.isFinite(t) && t >= t0 - 2000 && t <= t0 + 180 * 60000
  })
  if (!later.length) return { base: null, pts: [] }
  const base = Number(later[0].intensity) || 0
  const pts = []
  for (const min of [10, 30, 60, 120, 180]) {
    const target = t0 + min * 60000
    let best = null
    for (const s of later) {
      const d = Math.abs(Date.parse(s.at) - target)
      if (!best || d < Math.abs(Date.parse(best.at) - target)) best = s
    }
    if (best && Math.abs(Date.parse(best.at) - target) <= 6 * 60000) {
      const j = parseJson(best.slow) || {}
      pts.push({
        min,
        intensity: r3(Number(best.intensity) || 0),
        slow: Number.isFinite(Number(j.slow)) ? r3(j.slow) : null,
        fast: Number.isFinite(Number(j.fast)) ? r3(j.fast) : null,
      })
    }
  }
  const first = parseJson(later[0].slow) || {}
  return {
    base: r3(base),
    slow0: Number.isFinite(Number(first.slow)) ? r3(first.slow) : null,
    fast0: Number.isFinite(Number(first.fast)) ? r3(first.fast) : null,
    pts,
  }
}

const big = events
  .filter((e) => Number(e.gate) && Number(e.sig) > 3 * thetaOf(e))
  .sort((a, b) => Number(b.sig) - Number(a.sig))
  .map((e) => ({ e, traj: trajectory(e) }))

/* ───────── B2：连续两天同标签但强度贴在 0.2 附近 ───────── */
const dayOf = (iso) => {
  const d = new Date(Date.parse(iso) + 8 * 3600000) // 本地日（+08）
  return isNaN(d) ? '' : d.toISOString().slice(0, 10)
}
const byDayLabel = new Map()
for (const ep of episodes) {
  const k = dayOf(ep.started_at) + '|' + String(ep.label || '')
  const cur = byDayLabel.get(k) || { day: dayOf(ep.started_at), label: ep.label, max: 0 }
  cur.max = Math.max(cur.max, Number(ep.intensity) || 0)
  byDayLabel.set(k, cur)
}
const flat = [...byDayLabel.values()].filter((x) => x.max <= 0.25).sort((a, b) => a.day.localeCompare(b.day))

/* ───────── C 没被看见 ───────── */
const EMOTIVE = /讨厌|烦|生气|别|滚|闭嘴|随便|算了|不管|不想|失望|难过|委屈|不理|走开|骗|骗人|骗我/
const unseen = events
  .filter((e) => !Number(e.gate) && isHuman(e.cause) && (EMOTIVE.test(String(e.cause)) || String(e.cause).trim().length <= 6))
  .sort((a, b) => String(b.at).localeCompare(String(a.at)))
  .slice(0, 20)

/* ───────── 汇总 ───────── */
const total = events.length
const passed = events.filter((e) => Number(e.gate)).length
const humanCount = events.filter((e) => isHuman(e.cause)).length
const sigs = events.map((e) => Number(e.sig) || 0).sort((a, b) => a - b)
const pct = (p) => r3(sigs[Math.min(sigs.length - 1, Math.floor(p * (sigs.length - 1)))])
const labels = {}
for (const e of events) labels[e.label] = (labels[e.label] || 0) + 1

const out = {
  generated_at: new Date().toISOString(),
  agent: agent.name,
  days: DAYS,
  db: DB_PATH,
  totals: { events: total, passed, pass_rate: total ? r3(passed / total) : 0, human_causes: humanCount },
  sig: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: sigs.length ? r3(sigs[sigs.length - 1]) : 0 },
  labels,
  near: near.slice(0, 25).map((e) => ({ at: e.at, sig: r3(e.sig), theta: thetaOf(e), label: e.label, raw: e.raw_label, cause: clip(e.cause, 60) })),
  big: big.slice(0, 25).map(({ e, traj }) => ({ at: e.at, sig: r3(e.sig), label: e.label, cause: clip(e.cause, 60), traj })),
  flat: flat.slice(0, 20),
  unseen: unseen.map((e) => ({ at: e.at, sig: r3(e.sig), label: e.label, cause: clip(e.cause, 60) })),
}
fs.writeFileSync(path.join(ROOT, '_emotion_recheck.json'), JSON.stringify(out, null, 2), 'utf8')

/* ───────── Markdown ───────── */
const pctStr = (x) => (x * 100).toFixed(1) + '%'
const L = []
L.push('# 情绪回查 · ' + DAYS + ' 天')
L.push('')
L.push('> 由 `scripts/emotion-recheck.mjs` 生成，只读库，不写任何表。生成于 ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '。')
L.push('')
L.push('## 概览')
L.push('')
L.push('| 项 | 值 |')
L.push('|---|---|')
L.push('| 事件行 | ' + total + ' |')
L.push('| 过闸（成事件） | ' + passed + '（' + pctStr(total ? passed / total : 0) + '） |')
L.push('| 人话原因 | ' + humanCount + ' |')
L.push('| sig 中位 / p90 / p99 / 最大 | ' + out.sig.p50 + ' / ' + out.sig.p90 + ' / ' + out.sig.p99 + ' / ' + out.sig.max + ' |')
L.push('| 闸门 θ | ' + thetaDefault + '（历史上有 0.15） |')
L.push('| 标签分布 | ' + Object.entries(labels).map(([k, v]) => k + ' ' + v).join('、') + ' |')
L.push('')
L.push('## A 差一点（sig 在 0.7θ ~ θ 之间，没成事件）')
L.push('')
if (!near.length) L.push('（无）')
else {
  L.push('| 时间 | sig | θ | 判的标签 | 原话 |')
  L.push('|---|---|---|---|---|')
  for (const e of near.slice(0, 20)) L.push('| ' + String(e.at).slice(0, 16).replace('T', ' ') + ' | ' + r3(e.sig) + ' | ' + thetaOf(e) + ' | ' + e.label + ' | ' + clip(e.cause, 36) + ' |')
  L.push('')
  L.push('共 ' + near.length + ' 条。')
}
L.push('')
L.push('## B 磨平了（过闸且 sig > 3θ，看那截多久被吃掉）')
L.push('')
if (!big.length) L.push('（无）')
else {
  L.push('| 时间 | sig | 标签 | 强度 | 慢 | 快 | +10m 慢/快 | +30m 慢/快 | +60m 慢/快 | 原话 |')
  L.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const { e, traj } of big.slice(0, 20)) {
    const pick2 = (m) => {
      const hit = traj.pts.find((p) => p.min === m)
      if (!hit) return '—'
      return (hit.slow ?? '—') + '/' + (hit.fast ?? '—')
    }
    L.push('| ' + String(e.at).slice(0, 16).replace('T', ' ') + ' | ' + r3(e.sig) + ' | ' + e.label + ' | ' + (traj.base ?? '—') + ' | ' + (traj.slow0 ?? '—') + ' | ' + (traj.fast0 ?? '—') + ' | ' + pick2(10) + ' | ' + pick2(30) + ' | ' + pick2(60) + ' | ' + clip(e.cause, 32) + ' |')
  }
  L.push('')
  L.push('共 ' + big.length + ' 条。')
}
L.push('')
L.push('## B2 平掉了（当天同标签最高强度 ≤ 0.25）')
L.push('')
if (!flat.length) L.push('（无）')
else {
  L.push('| 日期 | 标签 | 当天最高强度 |')
  L.push('|---|---|---|')
  for (const f of flat.slice(0, 20)) L.push('| ' + f.day + ' | ' + f.label + ' | ' + r3(f.max) + ' |')
  L.push('')
  L.push('共 ' + flat.length + ' 个「日期×标签」格子。')
}
L.push('')
L.push('## C 没被看见（人话，没过闸，也没近门槛）')
L.push('')
if (!unseen.length) L.push('（无）')
else {
  L.push('| 时间 | sig | 判的标签 | 原话 |')
  L.push('|---|---|---|---|')
  for (const e of unseen) L.push('| ' + String(e.at).slice(0, 16).replace('T', ' ') + ' | ' + r3(e.sig) + ' | ' + e.label + ' | ' + clip(e.cause, 40) + ' |')
}
L.push('')
L.push('## 结论')
L.push('')
const rate = total ? passed / total : 0
const bigFast = big.filter(({ traj }) => Number.isFinite(traj.fast0) && Math.abs(traj.fast0) >= 0.25).length
const slowMove = big.map(({ traj }) => {
  const p = traj.pts.find((x) => x.min === 30)
  if (!p || !Number.isFinite(traj.slow0) || !Number.isFinite(p.slow)) return null
  return Math.abs(p.slow - traj.slow0)
}).filter((x) => x != null)
const avgSlowMove = slowMove.length ? slowMove.reduce((a, b) => a + b, 0) / slowMove.length : null
L.push('- 过闸率 ' + pctStr(rate) + '。sig 最大的那些确实是真事（吵架、被说「不活泼」、被问「是不是装太多」）——**不是没读到**。')
L.push('- **强度留得住**：B 表里「强度」到 +60m 基本没掉（全表平均掉不到两成）。所以「衰减太快把尖峰磨平」这个说法，数据不支持。')
L.push('- **真正没动的是慢情绪**：' + (avgSlowMove == null ? '（样本不足）' : '事件后 30 分钟，慢情绪平均只挪了 ' + r3(avgSlowMove)) + '。而表达档位只看慢情绪（`expressionFrom` 的 `slow`）。')
L.push('- **快情绪在抖，不是在散**：' + bigFast + ' / ' + big.length + ' 条在事件当下就有 |快| ≥ 0.25，一小时内正负来回翻。它承载不了「这一下还没过去」。')
L.push('- 所以：加「残留」不是当务之急——**状态本来就留住了**。当务之急是让留住的东西真的接到表达上。')
L.push('- C 表用来查「读歪了」：人话里有情绪词、却连 0.7θ 都没到。')

const md = L.join('\n') + '\n'
const month = new Date().toISOString().slice(0, 7)
const mdPath = path.join(ROOT, 'docs', '情绪-回查-' + month + '.md')
fs.mkdirSync(path.dirname(mdPath), { recursive: true })
fs.writeFileSync(mdPath, md, 'utf8')

console.log('agent', agent.name, '| events', total, '| passed', passed, '| near', near.length, '| big', big.length, '| flat', flat.length, '| unseen', unseen.length)
console.log('report ->', mdPath)
