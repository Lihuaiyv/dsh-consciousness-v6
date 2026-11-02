/**
 * 拟人化改造的对照基准（A1 / A2 / A3 / B1+B2 / B3 / B4）。
 *
 *   node scripts/bench-humanlike.mjs
 *
 * 同一份库、同一批记忆，跑两遍：
 *   before = 旧行为（不传 decorate、不注入示例、锚点按 importance 直取）
 *   after  = 现在的行为
 * 旧算法（oneLine 的硬切、clampInjection 的旧丢弃顺序）在这里按原样重写了一份，
 * 只用于对照，不参与线上路径。
 *
 * 输出：JSON（机器读）+ markdown 表（人读）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { seedTiers } from '../src/modules/relations.js'
import { retrieve, importanceAnchors } from '../src/modules/retrieve.js'
import { touch } from '../src/modules/tiers.js'
import { packInjection, oneLine } from '../src/modules/pack.js'
import { clampInjection } from '../src/features.js'
import { writeParam } from '../src/kernel.js'
import { consciousnessBlock, recentRecall, packMemoryBlock } from '../index.js'
import { DEFAULT_EXAMPLES } from '../src/modules/examples.js'

const now = () => new Date().toISOString()
const DAY = 86400000
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-bench-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_bench'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())
seedTiers(db)
for (const [p, v] of [['style.tone', '可爱粘人'], ['style.address', '主人'], ['axis.ei', 0.35]]) {
  db.prepare('INSERT INTO persona(agent_id,path,value,updated_at) VALUES(?,?,?,?)').run(aid, p, JSON.stringify(v), now())
}
db.prepare(`INSERT INTO affect_state(agent_id,primary_label,secondary_label,intensity,mood,pleasure,arousal,dominance,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?)`).run(aid, 'curious', null, 0.55, 0.6, 0.2, 0.3, 0.1, now())
db.prepare('INSERT INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)')
  .run(aid, 0.1, 0.2, 0.1, 0.25, now(), now())
db.prepare(`INSERT INTO rel_person(id,agent_id,name,tier,closeness,trust,dependence,salience,status,
  first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('rp_b', aid, '主人', 'owner', 0.92, 0.72, 0.24, 1, 'active', now(), now(), now(), now())

// ---------------------------------------------------------------- 语料
// 长短混着来：短句原样留；长句考的就是「切在哪儿」。
const CORPUS = [
  ['主人说过想去看海。', 0, 0.5],
  ['主人喜欢先给结论再解释。', 1, 0.5],
  ['主人今天在改情绪和记忆的接线，画图那事也还没收尾，等会儿还要再看一遍。', 2, 0.5],
  ['答应主人的事：周末把脚本修好，修完先跑一遍，不出假数据。', 4, 0.85],
  ['主人怕吵，晚上十点以后不要主动放声音。', 7, 0.85],
  ['上次说的那个咖啡店，主人嫌太酸，换了一家新的还没去试。', 12, 0.5],
  ['主人问过记忆的遗忘曲线怎么算，我说是双曲线，不是指数，他想要一张能看懂的图。', 20, 0.6],
  ['主人说这一块看起来有点乱，让我先理清楚再动手，别一边改一边加。', 35, 0.5],
  ['承诺过不主动提那件事。', 60, 0.85],
  ['主人提过想把底色调深一点，又说怕太浓，最后没定。', 95, 0.5],
  ['那次彻底重写了记忆的分层，原文、事实、纪要、日记各走各的路，热度账本单独一张表。', 140, 0.6],
  ['边界：不替主人做决定，也不替他跟别人说话。', 220, 0.9],
  ['最早那版是把整句塞进 FTS，结果一条都召不回来，后来拆成 3-gram 才对。', 330, 0.6],
  ['主人第一次说喜欢鲸鱼娘，是在一个很晚的晚上，具体说了什么我记不太清了。', 420, 0.5],
]
for (const [text, ageDays, imp] of CORPUS) addMemory(db, aid, { text, type: 'fact' })
const rows = db.prepare("SELECT id,text FROM memory_items WHERE agent_id=? ORDER BY created_at").all(aid)
for (const [i, r] of rows.entries()) {
  const [, ageDays, imp] = CORPUS[i]
  db.prepare('UPDATE memory_items SET created_at=?, importance=?, mark=? WHERE id=?')
    .run(new Date(Date.now() - ageDays * DAY).toISOString(), imp, i === 3 ? 'locked' : 'normal', r.id)
}

// ---------------------------------------------------------------- 旧算法（对照用，原样重写）
function oldOneLine(text, max = 60) {
  let s = String(text || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^[-•]\s*/, '').replace(/^\d+\s*[.、)]\s*/, '')
  const end = s.search(/[。！？!?]/)
  if (end >= 0) s = s.slice(0, end)
  s = s.trim()
  const chars = Array.from(s)
  return chars.length > max ? chars.slice(0, max).join('') + '…' : s
}

/** 旧丢弃顺序：proactive → affect → drive → diary → memory …（affect 排第 2） */
function oldClamp(lines, budget = 800) {
  const est = (t) => Math.ceil(String(t).length / 2)
  const parts = lines.slice()
  const order = [
    (l) => l.startsWith('（你之前想主动说一句'),
    (l) => l.startsWith('感觉现在大概') || l.startsWith('我想怎么说'),
    (l) => l.startsWith('需求缺口档位'),
    (l) => l.startsWith('最近我自己写下的'),
    (l) => l.startsWith('关于这句话，你能想起的事'),
  ]
  for (const test of order) {
    if (est(parts.join('\n')) <= budget) break
    const i = parts.findIndex(test)
    if (i >= 0) parts.splice(i, 1)
  }
  let text = parts.join('\n')
  if (est(text) > budget) text = text.slice(0, Math.max(0, budget * 2 - 1)) + '…'
  return { text, tokens: est(text) }
}

/** 旧锚点：直接取 importance 最高的两条，集合恒定 */
function oldAnchors(limit = 2) {
  return db.prepare(`SELECT id FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL
      AND importance>=0.7 AND (mark='locked' OR type IN ('fact','conflict'))
      ORDER BY (mark='locked') DESC, importance DESC, heat DESC, created_at DESC LIMIT ?`)
    .all(aid, limit).map((r) => r.id)
}

// ---------------------------------------------------------------- 1. 切句
// 专挑 60~140 字、逗号位置各不相同的句子：这才看得出「切在哪儿」。
const LONG = [
  '主人今天在改情绪和记忆的接线，画图那事也还没收尾，等会儿还要再看一遍，看完再决定要不要动检索那一段，动之前先把基准跑一遍，不然分不清是变好还是变坏。',
  '上次说的那个咖啡店，主人嫌太酸，换了一家新的还没去试，说等忙完这阵子再一起去看看，顺便把上次没说完的那件事说清楚，别又拖到下个月。',
  '主人问过记忆的遗忘曲线怎么算，我说是双曲线不是指数，他想要一张能看懂的图，最好带上三条不同年龄的曲线，还要在图上标出遗忘阈值那条线。',
  '主人说这一块看起来有点乱，让我先理清楚再动手，别一边改一边加，改完还要把测试跑一遍，跑完把结果贴给他看，不要只说自己觉得好了。',
  '那次彻底重写了记忆的分层，原文、事实、纪要、日记各走各的路，热度账本单独一张表，检索和注入分开算，连锚点该不该轮转都是在代码里一行一行看出来的。',
  '最早那版是把整句塞进 FTS，结果一条都召不回来，后来拆成 3-gram 才对，短问句还得再走一遍 LIKE 兜底，长句子反而不能塞 2-gram，不然召回的全是泛词。',
  '这段故意没有标点也没有停顿就是很长的英文串abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz',
]
const cut = (() => {
  const out = { before: { hard: 0, soft: 0, kept: 0 }, after: { hard: 0, soft: 0, kept: 0 } }
  for (const src of LONG) {
    for (const [key, fn] of [['before', oldOneLine], ['after', oneLine]]) {
      const s = fn(src, 60)
      const bare = s.replace(/…$/, '')
      const n = Array.from(bare).length
      out[key].kept += n
      if (s.endsWith('…')) out[key].hard++
      else if (n < Array.from(src).length && /[，、；：,;:]/.test(src[n] || '')) out[key].soft++
    }
  }
  out.before.kept = Math.round(out.before.kept / LONG.length)
  out.after.kept = Math.round(out.after.kept / LONG.length)
  return out
})()

// ---------------------------------------------------------------- 2. 记忆块
const items = retrieve(db, aid, '主人 记忆 安排', { k: 8 }).items
const memBefore = packInjection({ items }, { budget: 400 })
const memAfter = packMemoryBlock(db, aid, items, 400)
const countTime = (t) => (t.match(/（[^）]*(天前|周前|个月前|一年多前)[^）]*）/g) || []).length
const countHard = (t) => (t.split('\n').filter((l) => l.endsWith('…'))).length
const untagged = (t) => (t.split('\n').filter((l) => l.startsWith('- ') && !/^- （/.test(l))).length
const SPECIAL = /^- （(一直记着的|今天刚发生|已更新，旧说法)）/
const tagged = (t) => {
  const mem = t.split('\n').filter((l) => l.startsWith('- '))
  return { total: mem.length, time: countTime(t), special: mem.filter((l) => SPECIAL.test(l)).length, bare: untagged(t) }
}

// ---------------------------------------------------------------- 3. 整段注入
function buildBlock({ examples, age }) {
  writeParam(db, aid, 'memory.inject.examples', examples ? 'on' : 'off')
  writeParam(db, aid, 'memory.inject.age', age ? 'on' : 'off')
  const mem = age ? packMemoryBlock(db, aid, items, 400) : packInjection({ items }, { budget: 400 })
  recentRecall.set(aid, { at: Date.now(), q: 'bench', text: mem.text })
  return consciousnessBlock(db, aid)
}
const blockBefore = buildBlock({ examples: false, age: false })
const blockAfter = buildBlock({ examples: true, age: true })
const tokens = (t) => Math.ceil(String(t).length / 2)
const linesOf = (t) => t.split('\n').length

// ---------------------------------------------------------------- 4. 预算压力
function pressure(block, budget) {
  return clampInjection(block.split('\n'), budget)
}
function pressureOld(block, budget) {
  return oldClamp(block.split('\n'), budget)
}
const pBefore = [200, 150, 120].map((b) => {
  const r = pressureOld(blockAfter, b)
  return { budget: b, hasAffect: /感觉现在大概/.test(r.text), tokens: r.tokens }
})
const pAfter = [200, 150, 120].map((b) => {
  const r = pressure(blockAfter, b)
  return { budget: b, hasAffect: /感觉现在大概/.test(r.text), tokens: r.tokens }
})

// ---------------------------------------------------------------- 5. 锚点轮转
function simulate(picker, turns = 5, limit = 2) {
  const seen = []
  for (let i = 0; i < turns; i++) {
    const ids = picker(limit)
    seen.push(...ids)
    touch(db, ids)
  }
  return { picked: seen.length, distinct: new Set(seen).size, list: seen }
}
const rotBefore = simulate(() => oldAnchors(2))
const rotAfter = simulate(() => importanceAnchors(db, aid, { limit: 2 }).map((x) => x.id))

// ---------------------------------------------------------------- 6. 示例
const exLines = blockAfter.split('\n').filter((l) => l.startsWith('- 主人：「')).length

// ---------------------------------------------------------------- 输出
const R = {
  sentence: cut,
  memory: {
    before: { tokens: memBefore.tokens, ...tagged(memBefore.text), hardCut: countHard(memBefore.text) },
    after: { tokens: memAfter.tokens, ...tagged(memAfter.text), hardCut: countHard(memAfter.text) },
  },
  block: {
    before: { tokens: tokens(blockBefore), lines: linesOf(blockBefore), examples: 0, timeTags: countTime(blockBefore) },
    after: { tokens: tokens(blockAfter), lines: linesOf(blockAfter), examples: exLines, timeTags: countTime(blockAfter) },
  },
  pressure: { before: pBefore, after: pAfter },
  anchor: { before: { distinct: rotBefore.distinct, picked: rotBefore.picked }, after: { distinct: rotAfter.distinct, picked: rotAfter.picked } },
}
console.log(JSON.stringify(R, null, 2))

const row = (k, b, a, note = '') => `| ${k} | ${b} | ${a} | ${note} |`
console.log('\n## 对照表\n')
console.log('| 指标 | 改前 | 改后 | 说明 |')
console.log('|---|---|---|---|')
console.log(row('超长句硬切（条）', cut.before.hard, cut.after.hard, '停在半个词上的句子数'))
console.log(row('切在标点处（条）', cut.before.soft, cut.after.soft, '读起来还是一句话'))
console.log(row('记忆行带时间标签（条）', R.memory.before.time, R.memory.after.time, `共 ${R.memory.after.total} 行`))
console.log(row('记忆行完全没有时间线索（条）', R.memory.before.bare, R.memory.after.bare, '越少越好'))
console.log(row('记忆块硬切残留（行）', R.memory.before.hardCut, R.memory.after.hardCut, '以「…」结尾的记忆行'))
console.log(row('注入示例条数', 0, R.block.after.examples, `默认 ${DEFAULT_EXAMPLES.length} 条`))
console.log(row('整段注入 tokens', R.block.before.tokens, R.block.after.tokens, '预算 800'))
console.log(row('200 预算下保住情绪', pBefore[0].hasAffect ? '是' : '否', pAfter[0].hasAffect ? '是' : '否', ''))
console.log(row('150 预算下保住情绪', pBefore[1].hasAffect ? '是' : '否', pAfter[1].hasAffect ? '是' : '否', ''))
console.log(row('5 轮锚点去重后条数', `${rotBefore.distinct}/${rotBefore.picked}`, `${rotAfter.distinct}/${rotAfter.picked}`, '越多越不重复'))

db.close()
