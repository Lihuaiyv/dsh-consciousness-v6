/**
 * 多天模拟：把整套记忆管线在「假时钟」里跑 N 天，看它会不会随时间变坏。
 *
 * 不调 LLM、不连宿主：用固定剧本模拟「每天说了什么、抽出了什么」，
 * 其余全部走真实代码（闸门 / 实体 / 队列 / 巩固 / 状态机 / 检索）。
 *
 * 用法：node scripts/sim-memory-days.mjs [天数]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory, recall, resolveConflict } from '../src/modules/memory.js'
import { retrieveAsOf } from '../src/modules/asof.js'
import { applyWrite } from '../src/modules/gate.js'
import { entityForText } from '../src/modules/entities.js'
import { appendTurn } from '../src/modules/archive.js'
import { runNightly, localDay } from '../src/modules/nightly.js'
import { retrieve } from '../src/modules/retrieve.js'
import { packInjection } from '../src/modules/pack.js'
import { tempStats } from '../src/modules/temps.js'
import { logRetrieval, retrievalStats } from '../src/modules/retrieval_log.js'
import { enqueueExtraction, tickExtraction } from '../src/modules/extract_queue.js'
import { conflictStats, tickEscalation } from '../src/modules/conflict.js'
import { projectMany, driftOf } from '../src/modules/timeline.js'

const DAYS = Math.max(10, Math.min(400, Number(process.argv[2]) || 200))
const DAY = 86400000

// ---------- 假时钟：让 new Date() / Date.now() 都按剧本走 ----------
const RealDate = Date
let fakeNow = RealDate.parse('2026-03-01T09:00:00+08:00')
const D0 = fakeNow
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(fakeNow)
    else super(...args)
  }
  static now() { return fakeNow }
}
globalThis.Date = FakeDate

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_sim'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '模拟', 'daily', 'active', now())

// ---------- 剧本 ----------
// 埋点日要早于探针「after」；短跑（如 60 天）只评已发生的事，避免假阴性。
const SCRIPT = [
  { day: 2, text: '2026 年春天我去了一趟西安，看了城墙', type: 'fact' },
  { day: 5, text: '我喜欢喝美式咖啡，不加糖', type: 'fact' },
  { day: 12, text: '我的猫叫团子，是只橘猫', type: 'fact' },
  { day: 15, text: '我最近开始学游泳，每周两次', type: 'fact' },
  { day: 40, text: '我在做 DSH 意识体插件这个项目', type: 'fact' },
  { day: 120, text: '我现在不喜欢喝美式咖啡了，改喝手冲', type: 'fact' },
  { day: 150, text: '团子最近在减肥，医生说要少喂罐头', type: 'fact' },
]
// 反复提到的事（用来测「被想起来」与合并）
const RECURRING = [
  { every: 3, text: '我喜欢喝美式咖啡，不加糖', until: 120 },
  { every: 7, text: '我在做 DSH 意识体插件这个项目' },
  { every: 20, text: '我的猫叫团子，是只橘猫' },
  // 长尾习惯：埋点后低频复提，测 S1 是否还能想起（H0/U7）
  { every: 25, text: '我最近开始学游泳，每周两次', after: 15 },
]
// 每天带一句无关闲聊，占体积、稀释相关性
const CHATTER = [
  '今天天气还不错', '有点累，早点睡', '刚开完会，脑子有点糊', '这周事情好多',
  '晚上想吃点好的', '路上堵了半小时', '刚看完一集剧', '屋里有点冷',
]

function dayText(day, i) {
  return CHATTER[(day + i) % CHATTER.length]
}

const stats = { turns: 0, extracted: 0, new: 0, merge: 0, conflict: 0, drop: 0, diaries: 0, episodes: 0 }

for (let d = 0; d < DAYS; d++) {
  fakeNow += DAY
  const day = d + 1
  const dayStr = localDay(new Date())
  const from = new Date(fakeNow - DAY).toISOString()
  const to = new Date(fakeNow).toISOString()

  // 每天两轮对话
  for (let i = 0; i < 2; i++) {
    const user = i === 0 ? (dayText(day, i) + '。' + (day % 11 === 0 ? '顺便说一句，' + SCRIPT.find((s) => s.day === day)?.text || '' : '')) : dayText(day, i + 1)
    appendTurn(db, aid, { sessionId: 's_' + dayStr, role: 'user', text: user.trim(), at: new Date(fakeNow - 3600000 + i * 1000).toISOString() })
    appendTurn(db, aid, { sessionId: 's_' + dayStr, role: 'assistant', text: '嗯，我在。', at: new Date(fakeNow - 3599000 + i * 1000).toISOString() })
    stats.turns += 2
  }

  // 当天的「抽取结果」：剧本事件 + 反复提到的事
  const todays = []
  for (const s of SCRIPT) if (s.day === day) todays.push(s)
  for (const r of RECURRING) {
    if (r.after && day < r.after) continue
    if (day % r.every === 0 && (!r.until || day < r.until)) todays.push({ text: r.text, type: 'fact', recurring: true })
  }

  for (const t of todays) {
    stats.extracted++
    const ent = entityForText(db, aid, t.text)
    const out = applyWrite(db, aid, { text: t.text, entity_id: ent ? ent.id : null }, (cand) => addMemory(db, aid, {
      text: cand.text, type: 'fact', tier: 'core', entity_id: cand.entity_id || null, source: 'extract',
    }))
    stats[out.action] = (stats[out.action] || 0) + 1
  }

  // day 130：用户确认「现在喝手冲」——给 as-of 探针一段「争议 → 已定」的历史
  if (day === 130) {
    const c = db.prepare(`SELECT c.id FROM conflicts c JOIN memory_items m ON m.id=c.b_id
      WHERE c.agent_id=? AND c.state='open' AND m.text LIKE '%手冲%' LIMIT 1`).get(aid)
    try { if (c) { resolveConflict(db, aid, c.id, { keep: 'b' }); stats.resolved = (stats.resolved || 0) + 1 } } catch { /* 已被升级流程处理 */ }
  }

  // 抽取队列：模拟「入队 → worker 跑掉」
  const batch = [{ role: 'user', text: to }, { role: 'assistant', text: 'ok' }]
  enqueueExtraction(db, aid, batch)
  await tickExtraction(db, aid, async () => true, { max: 1 })

  // 每天夜里巩固「昨天」
  const yDay = localDay(new Date(fakeNow - DAY))
  const night = await runNightly(db, aid, { day: yDay })
  try { tickEscalation(db, aid) } catch { /* 升级失败不影响模拟 */ }
  if (!night.skipped) {
    stats.diaries += night.diary_day ? 1 : 0
    const ep = night.steps.find((s) => s.step === 'episodes')
    stats.episodes += (ep && ep.count) || 0
  }
}

// ---------- 终局评估 ----------
// after = 埋点日：模拟天数不够时跳过，标 skip，不记失败
const ALL_PROBES = [
  { q: '西安', want: '西安', after: 2 },
  { q: '咖啡', want: '咖啡', after: 5 },
  { q: '团子', want: '团子', after: 12 },
  { q: '游泳', want: '游泳', after: 15 },
  { q: '意识体插件', want: '意识体', after: 40 },
]
const probes = ALL_PROBES.filter((p) => DAYS >= p.after)
const skippedProbes = ALL_PROBES.filter((p) => DAYS < p.after)
let hit = 0
const probeOut = []
for (const p of probes) {
  const t0 = Date.now()
  const r = retrieve(db, aid, p.q, { k: 6 })
  const packed = packInjection({ items: r.items }, { budget: 400 })
  const ok = r.items.some((x) => String(x.text).includes(p.want))
  if (ok) hit++
  logRetrieval(db, aid, {
    scene: r.scene, query: p.q, why: r.why, counts: r.debug.counts, kept: r.debug.kept,
    items: r.items.length, tokens: packed.tokens, ms: Date.now() - t0,
  })
  probeOut.push({ q: p.q, scene: r.scene, items: r.items.length, tokens: packed.tokens, ok, top: r.items[0] ? String(r.items[0].text).slice(0, 30) : null })
}
// 旧路径对照
let oldHit = 0
for (const p of probes) {
  const pack = recall(db, aid, p.q, 6, 512)
  if ((pack.items || []).some((x) => String(x.text).includes(p.want))) oldHit++
}

const temps = tempStats(db, aid)
const conf = conflictStats(db, aid)
const rst = retrievalStats(db, aid, 9999)
const facts = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active'").get(aid).n
const diaries = db.prepare('SELECT COUNT(*) n FROM diaries WHERE agent_id=?').get(aid).n
const eps = db.prepare('SELECT COUNT(*) n FROM episodes WHERE agent_id=?').get(aid).n
const raws = db.prepare('SELECT COUNT(*) n FROM raw_turns WHERE agent_id=?').get(aid).n
const sizes = Object.fromEntries(['memory_items', 'raw_turns', 'diaries', 'episodes', 'fact_archive', 'memory_timeline', 'retrieval_log', 'extract_queue', 'entities'].map((t) => {
  try { return [t, db.prepare('SELECT COUNT(*) n FROM ' + t).get().n] } catch { return [t, -1] }
}))

console.log('=== 模拟 ' + DAYS + ' 天 ===')
console.log('对话轮次', stats.turns, '| 抽取', stats.extracted, '| 新增', stats.new, '合并', stats.merge, '冲突', stats.conflict, '丢弃', stats.drop)
console.log('表行数', JSON.stringify(sizes))
console.log('温度分布', JSON.stringify(temps), '| 活跃事实', facts)
console.log('冲突', JSON.stringify(conf))
if (process.env.SIM_DEBUG) {
  for (const c of db.prepare('SELECT c.*, a.text at_, b.text bt FROM conflicts c LEFT JOIN memory_items a ON a.id=c.a_id LEFT JOIN memory_items b ON b.id=c.b_id WHERE c.agent_id=?').all(aid)) console.log('  conflict', JSON.stringify(c))
}
console.log('召回评测: v3 命中 ' + hit + '/' + probes.length + '，旧路径命中 ' + oldHit + '/' + probes.length
  + (skippedProbes.length ? '（跳过未埋点 ' + skippedProbes.map((p) => p.q).join(',') + '）' : ''))
for (const p of probeOut) console.log('  ', p.q, '→', p.scene, p.items + ' 条', p.tokens + ' token', p.ok ? '✓' : '✗', p.top)
for (const p of skippedProbes) console.log('  ', p.q, '→ skip（需 ≥' + p.after + ' 天）')
console.log('回放统计', JSON.stringify(rst))

// ---------- 不变量 ----------
const checks = []
const push = (name, ok, detail) => checks.push({ name, ok: !!ok, detail })
const activeFacts = db.prepare("SELECT * FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").all(aid)
push('每条都有温度', activeFacts.every((r) => r.temp_state), activeFacts.filter((r) => !r.temp_state).length)
push('冷/归档的不在 S1', (() => {
  const r = retrieve(db, aid, '西安', { k: 10, scene: 'S1', noUpgrade: true })
  const coldIds = new Set(activeFacts.filter((x) => x.temp_state === 'cold' || x.temp_state === 'archived').map((x) => x.id))
  return r.items.every((x) => !coldIds.has(x.id))
})())
push('每篇日记都有内容', db.prepare('SELECT COUNT(*) n FROM diaries WHERE agent_id=? AND length(text)>20').get(aid).n === diaries)
push('回放日志只增不炸', rst.total >= probes.length)
push('抽取队列没有卡住', (() => { const s = db.prepare("SELECT COUNT(*) n FROM extract_queue WHERE agent_id=? AND state='pending'").get(aid).n; return s === 0 })())
push('事实存根齐全', sizes.fact_archive >= facts)
// 改口埋在 day 120：短跑不考核，避免「冲突 0」假失败
if (DAYS >= 120) push('改口被记成冲突', conf.total >= 1, conf)
else push('改口冲突（未到 day120，跳过）', true, { days: DAYS, conf })
push('已埋点召回全中', hit === probes.length, { hit, total: probes.length, miss: probeOut.filter((p) => !p.ok).map((p) => p.q) })
{
  const all = db.prepare('SELECT * FROM memory_items WHERE agent_id=?').all(aid)
  const pm = projectMany(db, aid, all.map((r) => r.id))
  const drift = all.map((r) => ({ id: r.id, text: String(r.text).slice(0, 20), d: driftOf(r, pm.get(r.id)) })).filter((x) => x.d)
  push('时效索引漂移 0（' + all.length + ' 条）', drift.length === 0, drift.slice(0, 5))
  const sync = db.prepare("SELECT COUNT(*) n FROM memory_timeline WHERE agent_id=? AND (op='SYNC' OR approx=1)").get(aid).n
  push('夜巡对账从未需要补记（钩子无漏写）', sync === 0, { sync })
}
// ---------- G1「那时」探针：按剧本日问，只读 ----------
{
  // 剧本第 n 天的写入发生在 D0+n 天（循环开头先拨一天）。不再额外加小时，
  // 否则短跑问「最后一天」会落到模拟结束之后，被当成未来。
  const dayAt = (n) => new RealDate(D0 + n * DAY).toISOString()
  const heat = () => JSON.stringify(db.prepare('SELECT id,hits,last_hit_at,heat,band,temp_state FROM memory_items WHERE agent_id=? ORDER BY id').all(aid))
  const h0 = heat()
  const ask = (q, n) => retrieveAsOf(db, aid, q, { at: dayAt(n) })
  const has = (v, sub, label) => (v.items || []).some((x) => String(x.text).includes(sub) && (!label || x.label === label))
  const asof = []
  const probe = (name, minDay, fn) => {
    if (DAYS < minDay) { asof.push({ name, skip: true }); return }
    const r = fn()
    asof.push({ name, ok: r.ok, got: r.got })
    push('那时：' + name, r.ok, r.got)
  }
  const brief = (v) => (v.items || []).map((x) => x.label + ':' + String(x.text).slice(0, 14) + (x.disputed ? '·争' : ''))
  probe('第1天还没有咖啡记录', 1, () => { const v = ask('咖啡', 1); return { ok: !has(v, '咖啡'), got: brief(v) } })
  probe('第60天咖啡 = 美式（当时有效）', 60, () => { const v = ask('咖啡', 60); return { ok: has(v, '美式咖啡，不加糖', 'valid') && !has(v, '手冲'), got: brief(v) } })
  probe('第125天咖啡 = 两说都在、标争议', 125, () => {
    const v = ask('咖啡', 125)
    const b = (v.items || []).find((x) => String(x.text).includes('手冲'))
    return { ok: !!b && b.disputed && has(v, '美式咖啡，不加糖'), got: brief(v) }
  })
  probe('第140天咖啡 = 手冲（争议已定）', 140, () => {
    const v = ask('咖啡', 140)
    const b = (v.items || []).find((x) => String(x.text).includes('手冲'))
    return { ok: !!b && b.label === 'valid' && !b.disputed && !has(v, '美式咖啡，不加糖', 'valid'), got: brief(v) }
  })
  probe('第20天游泳 = 刚开始学', 20, () => { const v = ask('游泳', 20); return { ok: has(v, '游泳', 'valid'), got: brief(v) } })
  probe('第10天游泳 = 还没开始', 10, () => { const v = ask('游泳', 10); return { ok: !has(v, '游泳'), got: brief(v) } })
  probe('第100天团子 = 橘猫（无争议）', 100, () => { const v = ask('团子', 100); return { ok: has(v, '橘猫', 'valid'), got: brief(v) } })
  push('那时：翻旧账不改热度 / 命中', heat() === h0)
  console.log('那时探针:')
  for (const a of asof) console.log('  ', a.name, a.skip ? '→ skip' : (a.ok ? '✓' : '✗'), a.got ? JSON.stringify(a.got) : '')
}

for (const c of checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : ' ' + JSON.stringify(c.detail)))
const bad = checks.filter((c) => !c.ok).length
console.log('\n通过 ' + (checks.length - bad) + ' / ' + checks.length)

db.close()
fs.rmSync(dir, { recursive: true, force: true })
if (bad) process.exitCode = 1
