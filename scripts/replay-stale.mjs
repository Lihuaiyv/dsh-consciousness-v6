#!/usr/bin/env node
/**
 * 阶段 F 回放：拿真实库里的「旧说法」逐条走一遍「召回 → 装箱」，
 * 看它会不会**不带任何时间提示**地进注入（这就是「把过去当现在」的风险代理）。
 *
 * 不调模型、不写盘外的库：先复制一份真库到临时文件，所有开关都在副本上拨。
 *
 * 三组对照：
 *   A 当前默认：挤出 on + 时间标注 on
 *   B 不挤    ：挤出 off + 时间标注 on     → 看挤出到底省掉了多少暴露
 *   C 不标时间：挤出 on + 时间标注 off     → 看「带一句时间」到底挡掉了多少裸暴露
 *
 * 指标（每个候选旧条）：
 *   inRecall   这条旧说法在召回结果里吗（不在就不算「注入暴露」，与开关无关）
 *   exposed    注入文本里出现了它
 *   annotated  出现、且带了任何一句时间/更新提示
 *   bare       出现、且一句提示都没有 ← 真正危险的那种
 *
 * 用法：
 *   node scripts/replay-stale.mjs [--db <path>] [--agent <小汐>] [--json <out>] [--limit 200]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { stampRow } from '../src/modules/passport.js'
import { searchFacts } from '../src/modules/retrieve.js'
import { packMemoryBlock } from '../index.js'

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const srcPath = arg('db', 'C:/Users/ygys1/.dsh/consciousness/app.db')
const agentName = arg('agent', '小汐')
const limit = Number(arg('limit', '400')) || 400
const today = new Date().toISOString().slice(0, 10)
const jsonOut = arg('json', 'docs/记忆时态-回放-' + today + '.json')

// 任何一句时间/更新提示都算「不是裸的」。
// 注意必须包含 memoryTag 的年龄徽章（「3 天前」「1 个月前」「有点糊」）——
// 漏掉它会把「带年龄的旧条」误算成裸暴露。
const AGE = /(天前|个月前|周前|小时前|分钟前|今天刚发生|很久以前|有点糊|记不清)/
// 明确说「这条旧了 / 这是当时的」——最强的一档。
const EXPLICIT = /(有更新的说法|当时还没做完|记下的判断)/
// 只说「别处还有说法」——提示更新，但没断言这条旧。
const HINT = /(纪要里聊到|日记里写到|后来你提过|同主题后面)/
const ANNO = new RegExp(EXPLICIT.source + '|' + HINT.source + '|' + AGE.source)
const CUT = 16 // 用正文前 16 字判断「这条在不在注入里」

/**
 * 信号强度（只看「这一条自己那一行」）：
 *   3 = 明确时态（有更新的说法 / 当时还没做完 / 记下的判断）
 *   2 = 提示别处还有说法（纪要里聊到 / 同主题后面还有…）
 *   1 = 只有年龄徽章（3 天前、有点糊）——弱信号，模型仍可能当现状
 *   0 = 什么都没有（裸）
 *  -1 = 没进注入，不参与统计
 */
function levelOfLine(line) {
  if (!line) return -1
  if (EXPLICIT.test(line)) return 3
  if (HINT.test(line)) return 2
  if (AGE.test(line)) return 1
  return 0
}
function lineOfPacked(text, key) {
  const lines = String(text || '').split('\n')
  for (const l of lines) if (l.includes(key)) return l
  return ''
}

const tmp = path.join(os.tmpdir(), 'dsh-replay-' + Date.now() + '.db')
fs.copyFileSync(srcPath, tmp)
const db = new DatabaseSync(tmp)
const agent = db.prepare('SELECT id, name FROM agents WHERE name=?').get(agentName)
if (!agent) { console.error('找不到意识体: ' + agentName); process.exit(1) }
const aid = agent.id

function setParam(key, value) {
  db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
    .run(aid, key, JSON.stringify(value), new Date().toISOString())
}

// ── 收集「旧说法」：现在会被 stampRow 判出 validUntil 的活跃条目 ──
const rows = db.prepare(`SELECT * FROM memory_items
  WHERE agent_id=? AND status='active' AND invalid_at IS NULL ORDER BY created_at`).all(aid)
const cands = []
for (const r of rows) {
  const s = stampRow(db, aid, r)
  // 两类候选：真判旧的（invalid / topic_key / topic_state）+ 只同主题的候选（weak）
  const src = s.validUntil ? (s.source || 'topic_key') : (s.weakLater ? 'weak' : null)
  if (!src) continue
  cands.push({ id: r.id, type: r.type, text: String(r.text || ''), src, slot: s.slot })
  if (cands.length >= limit) break
}

function run({ eject, statement, weak, age = true }) {
  setParam('memory.stale.eject', eject ? 'on' : 'off')
  setParam('memory.passport.statement', statement ? 'on' : 'off')
  setParam('memory.passport.weak', weak ? 'on' : 'off')
  setParam('memory.inject.age', age ? 'on' : 'off')
  const out = []
  for (const c of cands) {
    const q = c.text.slice(0, 10)
    let hits = []
    try { hits = searchFacts(db, aid, q) } catch { hits = [] }
    const inRecall = hits.some((h) => h.id === c.id)
    let packed = { text: '', tokens: 0 }
    if (inRecall) {
      try { packed = packMemoryBlock(db, aid, hits, 400) } catch { packed = { text: '', tokens: 0 } }
    }
    const exposed = inRecall && String(packed.text || '').includes(c.text.slice(0, CUT))
    const annotated = exposed && ANNO.test(packed.text)
    const line = exposed ? lineOfPacked(packed.text, c.text.slice(0, CUT)) : ''
    const level = exposed ? levelOfLine(line) : -1
    out.push({ id: c.id, type: c.type, src: c.src, slot: c.slot, inRecall, exposed, annotated, level, bare: exposed && !annotated, tokens: Number(packed.tokens || 0), snippet: String(packed.text || '').slice(0, 160) })
  }
  return out
}

const GROUPS = [
  { key: 'A_default', label: 'A 当前默认（挤出 on · 时间 on · 弱标 off）', eject: true, statement: true, weak: false },
  { key: 'B_no_eject', label: 'B 不挤（挤出 off）', eject: false, statement: true, weak: false },
  { key: 'C_no_statement', label: 'C 不标时间（时间 off）', eject: true, statement: false, weak: false },
  { key: 'D_weak_on', label: 'D 弱标开（weak on）', eject: true, statement: true, weak: true },
  // E/F 把年龄徽章关掉：用来单独量「陈述时态」自己挡掉了多少裸暴露。
  { key: 'E_no_age_stmt', label: 'E 无年龄徽章 · 时间 on', eject: true, statement: true, weak: false, age: false },
  { key: 'F_no_age_bare', label: 'F 无年龄徽章 · 时间 off', eject: true, statement: false, weak: false, age: false },
]

function summarize(list) {
  const n = list.length
  const inRecall = list.filter((x) => x.inRecall).length
  const exposed = list.filter((x) => x.exposed).length
  const annotated = list.filter((x) => x.annotated).length
  const bare = list.filter((x) => x.bare).length
  const tokens = list.filter((x) => x.inRecall).map((x) => x.tokens)
  const avgTok = tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : 0
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0)
  // 信号强度分布：3 明确时态 / 2 提示别处有说法 / 1 只有年龄 / 0 裸
  const levels = { 0: 0, 1: 0, 2: 0, 3: 0 }
  for (const x of list) if (x.level >= 0) levels[x.level]++
  return {
    candidates: n,
    inRecall,
    exposed,
    annotated,
    bare,
    exposed_rate: pct(exposed, inRecall),
    annotated_rate: pct(annotated, exposed),
    bare_rate: pct(bare, exposed),
    explicit_rate: pct(levels[3], exposed),
    hint_rate: pct(levels[2], exposed),
    levels,
    avg_tokens: avgTok,
  }
}

const results = {}
for (const g of GROUPS) {
  const list = run(g)
  results[g.key] = { label: g.label, ...summarize(list), rows: list }
}

// 按来源分档看裸暴露
const bySource = {}
for (const [k, v] of Object.entries(results)) {
  const m = {}
  for (const r of v.rows) {
    // slot / nonslot 分开看：statement 只对非槽位生效，混在一起会看不出差别。
    const key = r.src + (r.slot ? ':slot' : ':nonslot')
    const s = m[key] = m[key] || { n: 0, exposed: 0, bare: 0, explicit: 0, hint: 0, ages: 0 }
    s.n++
    if (r.exposed) s.exposed++
    if (r.bare) s.bare++
    if (r.level === 3) s.explicit++
    else if (r.level === 2) s.hint++
    else if (r.level === 1) s.ages++
  }
  bySource[k] = m
}

const report = {
  generated_at: new Date().toISOString(),
  agent: agentName,
  source_db: srcPath,
  note: '风险代理：旧说法进注入且不带任何时间提示 = bare。本脚本不调模型。',
  groups: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { ...v, rows: undefined }])),
  by_source: bySource,
  details: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.rows.map((x) => ({ id: x.id, src: x.src, exposed: x.exposed, level: x.level, tokens: x.tokens }))])),
  samples: results.A_default.rows.filter((r) => r.exposed).slice(0, 12),
}

console.log('== 阶段 F 回放（旧说法 → 召回 → 装箱） ==')
console.log('候选旧说法:', cands.length, '| 来源分布:', JSON.stringify(cands.reduce((a, c) => { a[c.src] = (a[c.src] || 0) + 1; return a }, {})))
console.log('')
const pad = (s, n) => String(s).padEnd(n)
console.log(pad('组', 34), pad('进召回', 8), pad('暴露', 8), pad('明确时态', 9), pad('提示', 7), pad('仅年龄', 8), pad('裸', 6), pad('明确率', 8), '平均token')
for (const g of GROUPS) {
  const v = results[g.key]
  console.log(pad(v.label, 34), pad(v.inRecall, 9), pad(v.exposed, 9), pad(v.levels[3], 10), pad(v.levels[2], 8), pad(v.levels[1], 9), pad(v.levels[0], 7), pad(v.explicit_rate + '%', 9), v.avg_tokens)
}
console.log('')
console.log('-- 按来源 + 是否槽位看（A 组）--')
for (const [s, v] of Object.entries(bySource.A_default)) {
  console.log('  ' + pad(s, 18), '候选 ' + v.n, '· 暴露 ' + v.exposed, '· 明确 ' + v.explicit, '· 提示 ' + v.hint, '· 仅年龄 ' + v.ages, '· 裸 ' + v.bare)
}

try {
  const dir = jsonOut.replace(/[\\/][^\\/]+$/, '')
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8')
  console.log('\n回放结果已写入:', jsonOut)
} catch (e) {
  console.error('写回放结果失败:', e && e.message)
}
db.close()
try { fs.unlinkSync(tmp) } catch { /* 临时库删不掉也不影响 */ }
