/**
 * 模拟对比（第二阶段）：改前 vs 改后，同样 8 个问题 + 1 句「还记得吗」。
 *
 * 两个独立的临时库：一个只有旧库的样子（用户事实 + 第三人称旁白），
 * 一个走新链路（她自己的事 + 模式 + 旁白落冷）。不碰线上数据。
 *
 * 看四件事：
 *   1) 每轮注入里有几条「我自己的事」、旁白漏进来几条；
 *   2) 「我好像就是这样」的模式有没有露脸；
 *   3) 问「还记得吗」时自动翻旧账，注入里有没有那句「刚翻出来的」；
 *   4) 同一个问题连问 4 轮，会不会同一件事反复念。
 *
 * 运行：node scripts/sim-self-memory.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve, deepRecall } from '../src/modules/retrieve.js'
import { packMemoryBlock } from '../index.js'
import { selfTextOk } from '../src/modules/memory_source.js'

const TOPICS = ['潮汐表的排序', '记忆检索的召回', '咖啡的偏好', '考试系统的权限', '日记的写法', '生活流的频率', '情绪的快慢', '注入的预算']
const QUERIES = TOPICS.map((t) => t + ' 怎么弄')
const DEEP_QUERY = '你还记得以前那次把注入层改成分段拼的事吗'
const DAY = 86400000
const SELF_TEXTS = [
  '我把摘要那条默认关掉了，刷新后确认它不再写第三人称',
  '我把召回名额留给自己了，心里踏实一点',
  '我想弄明白潮汐表为什么总是先冒出别人的事',
  '我判断硬刷能解决乱码，因为缓存里还是旧包',
]
const PATTERN_TEXT = '我好像总是先道歉再解释，怕对方觉得我在推责任。'

function build({ withSelf, coldNarration, withPattern }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-'))
  const db = openDb(path.join(dir, 'app.db'))
  attachDb(db)
  const aid = 'agt_sim'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '模拟', 'daily', 'active', new Date().toISOString())
  for (let i = 0; i < 160; i++) {
    addMemory(db, aid, { text: TOPICS[i % TOPICS.length] + '还差第 ' + i + ' 项没处理', type: 'fact', source: 'extract', confidence: 0.7 })
  }
  for (let i = 0; i < 80; i++) {
    addMemory(db, aid, {
      text: '用户正在推进「' + TOPICS[i % TOPICS.length] + '」这件事，偏好先规划后执行（第 ' + i + ' 条旁白）',
      type: 'reflection', source: 'summary',
    })
  }
  let wrote = 0
  if (withSelf) {
    for (const t of SELF_TEXTS) {
      if (!selfTextOk(t)) continue
      addMemory(db, aid, { text: t, type: 'episode', source: 'self', confidence: 0.75, importance: 0.45 })
      wrote++
    }
  }
  if (withPattern) {
    // 三天的素材 + 一条已经攒出来的模式（模拟夜间认自己之后的样子）
    for (const [n, t] of [[1, '我又先道歉了，其实没人怪我'], [2, '我又先道歉了，解释了一堆心里发虚'], [3, '我又先道歉了，明明不是我的错']]) {
      const m = addMemory(db, aid, { text: t, type: 'episode', source: 'self', confidence: 0.75, importance: 0.45 })
      db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(new Date(Date.now() - n * DAY).toISOString(), m.id)
    }
    addMemory(db, aid, {
      text: PATTERN_TEXT, type: 'reflection', source: 'self', confidence: 0.65, importance: 0.6,
      fact_key: 'self.pattern.先道歉再解释',
    })
  }
  if (coldNarration) db.prepare("UPDATE memory_items SET temp_state='cold' WHERE agent_id=? AND source='summary'").run(aid)
  return { db, aid, dir, wrote }
}

const isSelf = (x) => x.source === 'self' || x.source === 'life'
const isPat = (x) => String(x.fact_key || '').startsWith('self.pattern.')

function run(box, opts) {
  let self = 0, narr = 0, pat = 0, rows = 0
  for (const q of QUERIES) {
    const r = retrieve(box.db, box.aid, q, { k: 6, ...opts })
    rows += r.items.length
    self += r.items.filter(isSelf).length
    narr += r.items.filter((x) => x.source === 'summary').length
    pat += r.items.filter(isPat).length
  }
  const n = QUERIES.length
  return {
    avgRows: +(rows / n).toFixed(1),
    avgSelf: +(self / n).toFixed(2),
    avgNarr: +(narr / n).toFixed(2),
    avgPat: +(pat / n).toFixed(2),
  }
}

/** 同一个问题连问 4 轮：看每轮自己的事是哪一条（重复就说明没在换）。 */
function repeatRun(box, opts, rounds = 4) {
  const shown = new Map()
  const seq = []
  for (let i = 0; i < rounds; i++) {
    const r = retrieve(box.db, box.aid, QUERIES[0], { k: 6, ...opts, selfShown: shown, selfRepeatMax: 2 })
    const mine = r.items.filter(isSelf)
    seq.push(mine.map((x) => String(x.id).slice(0, 10)))
    for (const m of mine) shown.set(String(m.id), (shown.get(String(m.id)) || 0) + 1)
  }
  return seq
}

/** 问「还记得吗」：能不能自己翻到旧账，翻到的有没有被标成「刚翻出来的」。 */
function deepRun(box, opts) {
  const d = deepRecall(box.db, box.aid, DEEP_QUERY, { k: 3 })
  const packed = packMemoryBlock(box.db, box.aid, d, 400)
  return {
    hits: d.length,
    noted: packed.text.includes('刚翻旧账翻出来的'),
    rows: d.length,
  }
}

const oldBox = build({ withSelf: false, coldNarration: false, withPattern: false })
const newBox = build({ withSelf: true, coldNarration: true, withPattern: true })
const before = run(oldBox, { selfQuota: 0, summaryInjected: true, patternQuota: 0 })
const after = run(newBox, { selfQuota: 1, summaryInjected: false, patternQuota: 1 })
const repBefore = repeatRun(oldBox, { selfQuota: 0, summaryInjected: true, patternQuota: 0 })
const repAfter = repeatRun(newBox, { selfQuota: 1, summaryInjected: false, patternQuota: 1 })
const dB = deepRun(oldBox, {})
const dA = deepRun(newBox, {})

const uniq = (seq) => new Set(seq.flat()).size
const maxRepeat = (seq) => Math.max(0, ...Object.values(seq.flat().reduce((m, id) => { m[id] = (m[id] || 0) + 1; return m }, {})))

console.log('旧库样本：用户事实 160 条 / 第三人称旁白 80 条 / 她自己的事 0 条')
console.log('新链路补写：她自己的事 ' + newBox.wrote + ' 条 + 模式 1 条（三天素材）；旁白 80 条标冷')
console.log('')
console.log('改前：每轮注入 ' + before.avgRows + ' 条｜自己的事 ' + before.avgSelf + '｜旁白 ' + before.avgNarr + '｜模式 ' + before.avgPat)
console.log('改后：每轮注入 ' + after.avgRows + ' 条｜自己的事 ' + after.avgSelf + '｜旁白 ' + after.avgNarr + '｜模式 ' + after.avgPat)
console.log('')
console.log('连问 4 轮（同一个问题）：')
console.log('  改前：' + JSON.stringify(repBefore) + '（自己没有事可换）')
console.log('  改后：' + JSON.stringify(repAfter) + '（出现 ' + uniq(repAfter) + ' 条不同的自己的事，同一条最多露 ' + maxRepeat(repAfter) + ' 次）')
console.log('')
console.log('问「你还记得吗」：')
console.log('  改前：翻到 ' + dB.hits + ' 条，注入里有没有「刚翻出来的」标注：' + (dB.noted ? '有' : '没有'))
console.log('  改后：翻到 ' + dA.hits + ' 条，注入里有没有「刚翻出来的」标注：' + (dA.noted ? '有' : '没有'))
oldBox.db.close()
newBox.db.close()
