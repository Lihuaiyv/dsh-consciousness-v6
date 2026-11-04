/**
 * 三条闭环的整体模拟：取/说、来源徽章、关系余量。
 *
 * 同一个进程里用开关做 A/B：
 *   commit_after_pack=on  → 新路：只有真的进注入才落账
 *   commit_after_pack=off → 旧路：取到就落账
 * 这样「改前」不是回忆，是同一套代码跑出来的对照。
 *
 * 运行：node scripts/sim-realness-closure.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { addMemory } from '../src/modules/memory.js'
import { bootstrap, ownerPerson } from '../src/modules/relations.js'
import { recordSelfResidue, settleSelfResidue } from '../src/modules/self_residue.js'
import { consciousnessBlock } from '../index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-realness-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

let seq = 0
const out = { scenarios: {}, provenance: {}, residue: {}, tokens: {} }

function seed({ budget = 800, commit = 'on', provenance = 'on', memorize = true } = {}) {
  seq += 1
  const aid = 'agt_sim_' + seq
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '模拟' + seq, 'daily', 'active', now())
  setParam(db, aid, 'memory.inject.budget', { value: budget })
  setParam(db, aid, 'memory.inject.commit_after_pack', { value: commit })
  setParam(db, aid, 'memory.inject.provenance', { value: provenance })
  bootstrap(db, aid)

  db.prepare('INSERT INTO proactive(id,agent_id,text,reason,state,created_at) VALUES(?,?,?,?,?,?)')
    .run('pc_' + aid, aid, '想跟你说，今天那件事我记着。', 'sim', 'pending', now())

  const past = new Date(Date.now() - 3600000).toISOString()
  db.prepare(`INSERT INTO open_loops(id,agent_id,kind,text,due_at,stale_after,state,fire_count,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('lp_' + aid, aid, 'promise', '答应周末重画记忆面板的图', past, past, 'open', 0, now(), now())

  const evidence = JSON.stringify({ attribute: { sentence_a: '你昨天说喜欢咖啡', sentence_b: '你今天说讨厌咖啡' } })
  db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,evidence) VALUES(?,?,?,?,?,?,?)`)
    .run('cf_' + aid, aid, 'ma_' + aid, 'mb_' + aid, 'open', now(), evidence)

  let memId = null
  if (memorize) {
    const mems = [
      { text: '主人说过窗台那盆花该换位置了。', source: 'manual', confidence: 0.9 },
      { text: '从聊天里记下：主人在改情绪和记忆的接线。', source: 'extract', confidence: 0.7 },
      { text: '我自己总结的：主人催得越紧，我越该先核对。', source: 'consolidate', confidence: 0.5 },
      { text: '我自己看到的：窗外的天从早上就阴着。', source: 'life', confidence: 0.9 },
    ]
    for (const m of mems) {
      const r = addMemory(db, aid, { ...m, type: 'fact' })
      if (!memId) memId = r.id
    }
    db.prepare('INSERT INTO surface_queue(id,agent_id,memory_id,reason,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run('sq_' + aid, aid, memId, 'pulse', 'pending', now(), new Date(Date.now() + 3600000).toISOString())
  }
  return aid
}

function snap(aid, text) {
  const proactive = db.prepare('SELECT state FROM proactive WHERE id=?').get('pc_' + aid)
  const loop = db.prepare('SELECT state,fire_count FROM open_loops WHERE id=?').get('lp_' + aid)
  const subtext = Number(db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='subtext.shown'").get(aid).n || 0)
  const queue = db.prepare('SELECT state FROM surface_queue WHERE id=?').get('sq_' + aid)
  const surfaced = Number(db.prepare("SELECT COUNT(*) n FROM surfaced_items WHERE agent_id=? AND kind='spontaneous'").get(aid).n || 0)
  return {
    tokens: Math.ceil(text.length / 2),
    hasProactive: text.includes('你之前想主动说一句'),
    hasLoop: text.includes('还挂着') || text.includes('最在意'),
    hasSubtext: text.includes('心里其实'),
    hasSpontaneous: text.includes('心里忽然浮上来'),
    proactive: proactive && proactive.state,
    loop: loop && loop.state,
    loopFire: loop && Number(loop.fire_count),
    subtextEvents: subtext,
    queue: queue && queue.state,
    surfaced,
  }
}

// ---- A/B：紧预算下的取 / 说 ----
for (const [name, commit] of [['new', 'on'], ['old', 'off']]) {
  const aid = seed({ budget: 40, commit })
  const text = consciousnessBlock(db, aid, {})
  out.scenarios[name] = snap(aid, text)
}

// ---- 宽预算：正常注入 ----
{
  const aid = seed({ budget: 800, commit: 'on' })
  const text = consciousnessBlock(db, aid, {})
  out.scenarios.wide = snap(aid, text)
  out.tokens.wide = Math.ceil(text.length / 2)
}

// ---- 来源徽章：开 / 关 ----
for (const [name, provenance] of [['on', 'on'], ['off', 'off']]) {
  const aid = seed({ budget: 800, provenance })
  const text = consciousnessBlock(db, aid, {})
  out.provenance[name] = {
    tokens: Math.ceil(text.length / 2),
    own: (text.match(/我自己看到的/g) || []).length,
    fromChat: (text.match(/从聊天里记下的/g) || []).length,
    inferred: (text.match(/我自己想的/g) || []).length,
    uncertain: (text.match(/不一定对/g) || []).length,
  }
}

// ---- 关系余量：记 / 提示 / 结算 ----
{
  const aid = seed({ budget: 800, commit: 'on', memorize: false })
  const before = ownerPerson(db, aid)
  for (let i = 0; i < 3; i++) {
    recordSelfResidue(db, aid, { dir: 'cold', delta: -0.5, warmth: -0.4, expected: 0.1, at: Date.now() - (3 - i) * 60000 })
  }
  const injected = consciousnessBlock(db, aid, {})
  const shown = Number(db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='rel.self_residue.shown'").get(aid).n || 0)
  out.residue.offSettle = { textHasLine: injected.includes('上一句你说得有点硬'), shown, recorded: 3 }
  const off = settleSelfResidue(db, aid)
  const afterOff = ownerPerson(db, aid)
  out.residue.offSettle.settle = off
  out.residue.offSettle.trustDelta = +(Number(afterOff.trust) - Number(before.trust)).toFixed(4)
  setParam(db, aid, 'relation.selfresidue.settle', { value: 'on' })
  const on = settleSelfResidue(db, aid)
  const afterOn = ownerPerson(db, aid)
  out.residue.onSettle = {
    ...on,
    trustDelta: +(Number(afterOn.trust) - Number(before.trust)).toFixed(4),
    closenessDelta: +(Number(afterOn.closeness) - Number(before.closeness)).toFixed(4),
  }
}

// ---- 紧预算余量不消耗 ----
{
  const aid = seed({ budget: 40, commit: 'on', memorize: false })
  recordSelfResidue(db, aid, { dir: 'cold', delta: -0.6, warmth: -0.4, expected: 0.2 })
  const text = consciousnessBlock(db, aid, {})
  out.residue.tight = {
    textHasLine: text.includes('上一句你说得有点硬'),
    shown: Number(db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='rel.self_residue.shown'").get(aid).n || 0),
  }
}

db.close()

const summary = {
  generated_at: new Date().toISOString(),
  scenarios: out.scenarios,
  provenance: out.provenance,
  residue: out.residue,
  tokens: out.tokens,
}
console.log(JSON.stringify(summary, null, 2))

// 顺手写一份 markdown，给报告用
const lines = [
  '# 三条闭环 · 模拟数据（' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '）',
  '',
  '> 同一套代码用开关做 A/B：`commit_after_pack=off` 复现旧路（取到即落账），`on` 是新路。',
  '',
  '## 1. 取 / 说（紧预算 40 token）',
  '',
  '| 指标 | 旧路 off | 新路 on |',
  '|---|---|---|',
  `| 主动消息状态 | ${out.scenarios.old.proactive} | ${out.scenarios.new.proactive} |`,
  `| 开环 fire_count | ${out.scenarios.old.loopFire} | ${out.scenarios.new.loopFire} |`,
  `| 潜台词事件 | ${out.scenarios.old.subtextEvents} | ${out.scenarios.new.subtextEvents} |`,
  `| 自发浮现状态 | ${out.scenarios.old.queue} | ${out.scenarios.new.queue} |`,
  `| 浮现记账 | ${out.scenarios.old.surfaced} | ${out.scenarios.new.surfaced} |`,
  '',
  '## 2. 来源徽章（宽预算 800）',
  '',
  '| 指标 | 关 | 开 |',
  '|---|---|---|',
  `| 注入 tokens | ${out.provenance.off.tokens} | ${out.provenance.on.tokens} |`,
  `| 我自己看到的 | ${out.provenance.off.own} | ${out.provenance.on.own} |`,
  `| 从聊天里记下的 | ${out.provenance.off.fromChat} | ${out.provenance.on.fromChat} |`,
  `| 我自己想的 | ${out.provenance.off.inferred} | ${out.provenance.on.inferred} |`,
  `| 不一定对 | ${out.provenance.off.uncertain} | ${out.provenance.on.uncertain} |`,
  '',
  '## 3. 关系余量',
  '',
  `- 3 条冷余量：注入里出「上一句有点硬」= ${out.residue.offSettle.textHasLine}，提示落账 ${out.residue.offSettle.shown} 条。`,
  `- 结算默认关：${out.residue.offSettle.settle.skipped}，信任变化 ${out.residue.offSettle.trustDelta}。`,
  `- 打开结算：${out.residue.onSettle.dir} / ${out.residue.onSettle.settled} 条，信任变化 ${out.residue.onSettle.trustDelta}，亲近变化 ${out.residue.onSettle.closenessDelta}。`,
  `- 紧预算：余量进注入 = ${out.residue.tight.textHasLine}，提示落账 ${out.residue.tight.shown} 条。`,
  '',
  '## 4. 宽预算整段注入',
  '',
  `- tokens：${out.tokens.wide}（预算 800）`,
  `- 主动消息 / 开环 / 潜台词 / 自发浮现：${out.scenarios.wide.hasProactive} / ${out.scenarios.wide.hasLoop} / ${out.scenarios.wide.hasSubtext} / ${out.scenarios.wide.hasSpontaneous}`,
  '',
].join('\n')
const outFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'realness-closure-data-2026-11-03.md')
try { fs.writeFileSync(outFile, lines, 'utf8') } catch (e) { console.error('write report failed:', e.message) }
console.error('report:', outFile)
