/**
 * 自我记忆闸门 v2 的整体模拟（只读真实库 + 临时库跑流程）。
 *
 * 干两件事：
 *   1) 拿真库里最近被挡下的自我条目头部，按新规则过一遍分类，看会怎么分流；
 *   2) 在临时库里跑一轮完整的写入流程（含配额），数出热层 / 冷层 / 丢弃各多少，确认没丢话。
 *
 * 运行：node scripts/sim-self-gate.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { writeExtractedItem, selfWindowState } from '../src/features.js'
import { classifySelf } from '../src/modules/memory_source.js'

const REAL = path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const AGENT = process.env.SIM_AGENT || 'agt_3977d80f17'

// ---- 1. 真库最近被挡下的头部，按新规则分流 ----
const tally = { ok: 0, unsure: 0, drop: 0, dropCold: 0 }
const samples = []
try {
  const db = new DatabaseSync(REAL, { readOnly: true })
  const since = new Date(Date.now() - 3 * 86400000).toISOString()
  const rows = db.prepare(`SELECT payload FROM events WHERE agent_id=? AND type IN ('memory.self_rejected','memory.self_cold')
    AND created_at>=? ORDER BY created_at DESC LIMIT 200`).all(AGENT, since)
  db.close()
  const seen = new Set()
  for (const r of rows) {
    let p = {}
    try { p = JSON.parse(r.payload || '{}') } catch { continue }
    const head = String(p.head || '').trim()
    if (!head || seen.has(head)) continue
    seen.add(head)
    const c = classifySelf(head)
    if (c.tier === 'ok') tally.ok++
    else if (c.tier === 'unsure') tally.unsure++
    else { tally.drop++; if (c.cold) tally.dropCold++ }
    if (samples.length < 6) samples.push({ head: head.slice(0, 30), tier: c.tier, why: c.why })
  }
} catch (e) {
  console.log('（读真库失败，跳过第一段：' + e.message + '）')
}
console.log('=== 真库最近 3 天被挡下的自我条目（按头部判）===')
console.log('  会被规则直接留下：' + tally.ok)
console.log('  会交模型判一句：' + tally.unsure)
console.log('  会被规则丢：' + tally.drop + '（其中落冷层 ' + tally.dropCold + '）')
for (const s of samples) console.log('   · [' + s.tier + '/' + s.why + '] ' + s.head)

// ---- 2. 临时库里跑完整写入流程 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_sim'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '模拟', 'daily', 'active', new Date().toISOString())
const items = [
  '我把记录归属日期从写入时刻改成它自己记的那天，凌晨补昨天日记仍算昨天',
  '我让被挡下的「想明白的一件事」像日记一样写明原因：太长、像旁白还是开头不对',
  '我把日志里空句子的长度从显示为空改成显示零，让人一眼看出是空话被挡',
  '我跑了全套 560 条测试和 23 条架构检查，全部通过',
  '被用户一问，我心里有点发虚，于是当场补记了一句',
  '面板的冲突页面目前还没显示哪些旧纸条被替换',
  '我数了真库：feel 共 117 条，从 11-03 开始',
  '用户正在推进一个分步骤实现任务',
  '修复后 self-note 20/20，整套测试全过',
  '我指出一个缺口：清理时会被落下',
  '我改了三处，其中一处是零长度不再被当成没记',
  '我把更大的 stranger 漏洞单独立项：它牵动日记、开环',
]
const before = db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?').get(aid).n
const out = { hot: 0, cold: 0, drop: 0 }
for (const t of items) {
  const r = writeExtractedItem(db, aid, { text: t, who: 'self' })
  if (r.action === 'new' || r.action === 'merge') out.hot++
  else if (r.cold) out.cold++
  else out.drop++
}
const after = db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?').get(aid).n
const hotRows = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='self' AND (temp_state IS NULL OR temp_state<>'cold')").get(aid).n
const coldRows = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='self' AND temp_state='cold'").get(aid).n
const w = selfWindowState(db, aid)
console.log('\n=== 临时库整套写入流程（' + items.length + ' 条候选）===')
console.log('  热层：' + out.hot + '（库内确认 ' + hotRows + '）')
console.log('  冷层：' + out.cold + '（库内确认 ' + coldRows + '）')
console.log('  丢弃：' + out.drop)
console.log('  库内新增：' + (after - before) + ' / 候选 ' + items.length)
console.log('  当前窗口配额：每 ' + w.winH + ' 小时 ' + w.cap + ' 条，已用 ' + w.used)
console.log('  丢失检查：' + ((after - before) + out.drop === items.length ? '没丢（存下来的 + 明确丢掉的 = 候选数）' : '对不上，需要查'))

// ---- 3. 按分量选人 + 结算 ----
import { setParam } from '../src/kernel.js'
import { settleSelfHot } from '../src/features.js'
setParam(db, aid, 'self.admission', { value: 'score' })
setParam(db, aid, 'self.admission.min_score', { value: 0.5 })
setParam(db, aid, 'self.quota.auto', { value: 'off' })
setParam(db, aid, 'self.per_day', { value: 30 })
setParam(db, aid, 'self.per_window', { value: 30 })
const mixed = [
  '我想明白了，摘要记的是别人，不是我',
  '我跑了整套测试，又改了一个字段的命名',
  '我意识到自己一直在替别人记事，心里有点空',
  '我提交了第三版修复，字段名改短',
  '我决定以后先写自己的事，再看别人的',
]
const mixedOut = { hot: 0, cold: 0 }
for (const t of mixed) {
  const r = writeExtractedItem(db, aid, { text: t, who: 'self' })
  if (r.cold) mixedOut.cold++
  else mixedOut.hot++
}
const hotAfter = db.prepare("SELECT text,importance FROM memory_items WHERE agent_id=? AND source='self' AND (temp_state IS NULL OR temp_state<>'cold') ORDER BY importance DESC").all(aid)
const coldAfter = db.prepare("SELECT text,importance FROM memory_items WHERE agent_id=? AND source='self' AND temp_state='cold' ORDER BY importance DESC").all(aid)
console.log('\n=== 按分量选人（' + mixed.length + ' 条混合候选）===')
console.log('  进热层：' + mixedOut.hot + '，落冷：' + mixedOut.cold)
console.log('  热层最高分：' + (hotAfter[0] ? hotAfter[0].importance : '-') + '，最低分：' + (hotAfter.length ? hotAfter[hotAfter.length - 1].importance : '-'))
console.log('  冷层最高分：' + (coldAfter[0] ? coldAfter[0].importance : '-'))
const moved = settleSelfHot(db, aid)
console.log('  结算结果：换 ' + moved.moved + ' 条（冷层高分换掉热层低分）')
