/**
 * 「浮上来」整体模拟：同一批记忆、同一批问句，比「只按相关度」和「配额浮现」。
 *
 * 不调 LLM：记忆直接用 addMemory 落、开环直接 addLoop 挂、问句写死。
 * 量三件事：
 *   1. 跟这句话无关、但很重要的东西（身份 / 答应过的事）有没有被想起来；
 *   2. 相关的那几条有没有被挤掉（配额不是白拿的）；
 *   3. 空话轮（「嗯」「好」）有没有东西可浮。
 *
 * 用法：node scripts/sim-float.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve } from '../src/modules/retrieve.js'
import { packInjection } from '../src/modules/pack.js'
import { detectLoop, addLoop, pendingLoops, loopLineFor, markLoopsFired, loopStats } from '../src/modules/loops.js'
import { bumpReflect, reflectCursor } from '../src/modules/consolidate.js'
import { recordSurfaced, markSurfacedUsed, surfacingStats } from '../src/modules/surfacing.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-float-sim-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_float_sim'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '浮', 'daily', 'active', now())

const NOW = Date.now()

// ---------- 语料：相关度能命中的 + 重要但跟话无关的 ----------
const RELATED = [
  ['我喜欢喝美式咖啡，不加糖', 0.5],
  ['我在西安看过城墙，春天去的', 0.5],
  ['我的猫叫团子，是只橘猫', 0.5],
  ['我在做 DSH 意识体插件这个项目', 0.6],
  ['我学游泳，每周两次', 0.45],
  ['我最近在减脂，医生说少喝全糖', 0.45],
]
const ANCHORS = [
  ['我的生日是三月三号，主人要记得', 0.95],
  ['答应周日之前把记忆面板的图重画一遍', 0.9],
]
const FRESH = [['今天主人在调插件里的浮现代码', 0.55]]

for (const [text, imp] of [...RELATED, ...ANCHORS]) addMemory(db, aid, { text, type: 'fact', importance: imp })
for (const [text, imp] of FRESH) addMemory(db, aid, { text, type: 'fact', importance: imp })

// 把「今天刚发生」那条之外的时间都拨到三天前，避免新近通道把它当今天
db.prepare("UPDATE memory_items SET created_at=? WHERE agent_id=? AND text NOT LIKE '%调插件里%'")
  .run(new Date(NOW - 3 * 86400000).toISOString(), aid)

// ---------- 开环：一条到期、一条还早 ----------
const due = addLoop(db, aid, { text: '答应周日之前把记忆面板的图重画一遍', kind: 'promise', due_at: new Date(NOW - 3600000).toISOString(), at: NOW - 2 * 86400000 })
addLoop(db, aid, { text: '回头把那份季度报告写完', at: NOW - 3600000 })
markLoopsFired(db, [due.id], NOW - 8 * 3600000) // 跨过节流

const QUERIES = ['咖啡', '西安', '猫', '游泳', '插件', '减脂', '量子色动力学', '今天上午发生了什么', '嗯', '好']
const K = 6

function runOnce(opts) {
  const out = []
  for (const q of QUERIES) {
    const r = retrieve(db, aid, q, { k: K, ...opts })
    const pack = packInjection({ items: r.items }, { budget: 400 })
    out.push({ q, r, pack, items: r.items.map((x) => ({ text: x.text, via: x.via })) })
  }
  return out
}

const off = runOnce({ float: false })
const on = runOnce({})

// 相关通道命中：问句里的关键词在该条记忆正文里
const KW = { 咖啡: '咖啡', 西安: '城墙', 猫: '团子', 游泳: '游泳', 插件: 'DSH', 减脂: '减脂' }
function hit(rows, kw) {
  return rows.some((x) => kw && x.text.includes(kw))
}
function anchorHit(rows) {
  return rows.some((x) => /生日|记忆面板/.test(x.text))
}

let relOff = 0; let relOn = 0; let anchOff = 0; let anchOn = 0; let freshOn = 0
for (let i = 0; i < QUERIES.length; i++) {
  const kw = KW[QUERIES[i]]
  if (kw) { if (hit(off[i].items, kw)) relOff++; if (hit(on[i].items, kw)) relOn++ }
  if (anchorHit(off[i].items)) anchOff++
  if (anchorHit(on[i].items)) anchOn++
  if (on[i].items.some((x) => x.via === 'fresh')) freshOn++
}

// 空话轮
const emptyOff = off.filter((x) => !x.q.trim() || String(x.q).length <= 1)
const emptyOn = on.filter((x) => !x.q.trim() || String(x.q).length <= 1)
const emptyOffItems = emptyOff.reduce((s, x) => s + x.items.length, 0)
const emptyOnItems = emptyOn.reduce((s, x) => s + x.items.length, 0)

// 观测：把「有配额」的那轮记进 surfaced_items，模拟一次引用判定
for (const x of on) recordSurfaced(db, aid, x.r.items, NOW)
const mentioned = markSurfacedUsed(db, aid, '我记得你生日是三月三号，咖啡也不加糖。', NOW)
const stats = surfacingStats(db, aid, 7)

// 开环
const pend = pendingLoops(db, aid, { at: NOW, limit: 5, throttleHours: 0 })
const line = loopLineFor(db, aid, { at: NOW, limit: 2, throttleHours: 0 })
const lstats = loopStats(db, aid)

// 反思游标
let acc = 0
for (const imp of [0.4, 0.5, 0.6, 0.5, 0.4]) acc = bumpReflect(db, aid, imp, NOW)
const cur = reflectCursor(db, aid)

const sum = (rows) => rows.reduce((s, x) => s + x.pack.tokens, 0)
const cnt = (rows) => rows.reduce((s, x) => s + x.items.length, 0)

console.log('=== 浮上来模拟（同语料、同问句）===')
console.log(`问句 ${QUERIES.length} 条 · k=${K}`)
console.log('')
console.log('                关（只按相关度）    开（配额浮现）')
console.log(`相关命中         ${relOff}/${Object.keys(KW).length}              ${relOn}/${Object.keys(KW).length}`)
console.log(`锚点浮现轮次      ${anchOff}/${QUERIES.length}              ${anchOn}/${QUERIES.length}`)
console.log(`今日新近轮次      0/${QUERIES.length}              ${freshOn}/${QUERIES.length}`)
console.log(`空话轮有东西可浮   ${emptyOffItems} 条              ${emptyOnItems} 条`)
console.log(`总注入条数        ${cnt(off)}                 ${cnt(on)}`)
console.log(`总估算 token      ${sum(off)}                 ${sum(on)}`)
console.log('')
console.log('开环：', JSON.stringify({ open: lstats.open, fired: pend.length, line: line.text.split('\n')[0] }))
console.log('反思游标：', JSON.stringify({ acc: cur.acc, window: !!cur.window_start }))
console.log('浮现观测：', JSON.stringify({ surfaced: stats.surfaced, used: stats.used, rate: stats.rate, mentioned }))
console.log('')
const ok = anchOff === 0 && anchOn === QUERIES.length && relOn >= relOff
console.log(ok ? 'PASS 配额浮现：重要的东西自己浮上来，相关度没被挤掉' : 'FAIL 配额浮现：有指标不达标')
process.exit(ok ? 0 : 1)
