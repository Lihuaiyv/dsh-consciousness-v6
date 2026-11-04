/**
 * P2 召回名额：她自己的事不靠分数抢名额，一条都没有时硬补；48h 内算「还热」。
 * 运行：node test/memory-self-quota.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve, rerank, selfCandidates } from '../src/modules/retrieve.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-quota-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_quota'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '名额', 'daily', 'active', new Date().toISOString())

// 四类用户事实：都跟「潮汐表」有关，够凑满注入名额
for (const t of [
  '潮汐表的顺序还没排，先按风险分类',
  '潮汐表里荒废很久的项目要单独列出来',
  '潮汐表这一栏的分组要按使用频率重排',
  '潮汐表导出的文件名还要带上日期',
]) addMemory(db, aid, { text: t, type: 'fact', source: 'extract', confidence: 0.7 })

// 一条她自己的事：跟查询词对不上，平时抢不过那四条用户事实
addMemory(db, aid, { text: '我今天把召回名额留给自己了，心里踏实一点', type: 'episode', source: 'self', confidence: 0.75, importance: 0.45 })

// 关掉「新近配额」，单独看 self 名额：不然刚写的自己那条会被 fresh 位带进来
const NO_FLOAT = { anchor: 0, fresh: 0 }

const base = retrieve(db, aid, '潮汐表 排序', { k: 6, selfQuota: 0, ...NO_FLOAT })
check('关掉名额时没有自己的事', !base.items.some((x) => x.source === 'self'), base.items.map((x) => x.source))
check('底子够 4 条', base.items.length >= 4, base.items.length)

const on = retrieve(db, aid, '潮汐表 排序', { k: 6, selfQuota: 1, ...NO_FLOAT })
const selfs = on.items.filter((x) => x.source === 'self')
check('开名额后补进来一条', selfs.length === 1, on.items.map((x) => x.source))
check('总数正好 +1', on.items.length === base.items.length + 1, { base: base.items.length, on: on.items.length })
check('补进来的标了 via=self', selfs[0] && selfs[0].via === 'self', selfs[0])

// 已经命中自己的事（查询词直接对上）：不再重复补第二条
addMemory(db, aid, { text: '我想弄明白潮汐表为什么总是先冒出别人的事', type: 'episode', source: 'self', confidence: 0.75, importance: 0.45 })
const hit = retrieve(db, aid, '潮汐表 别人 冒出', { k: 6, selfQuota: 1, ...NO_FLOAT })
check('自己命中时不重复补', hit.items.filter((x) => x.source === 'self').length === 1, hit.items.map((x) => ({ s: x.source, t: String(x.text).slice(0, 12) })))

// 紧预算不抢用户的位
const tight = retrieve(db, aid, '潮汐表 排序', { k: 3, selfQuota: 1, ...NO_FLOAT })
check('紧预算（k=3）不补', !tight.items.some((x) => x.source === 'self'), tight.items.map((x) => x.source))

// 空话轮也能想起自己的事
const empty = retrieve(db, aid, '', { k: 6, selfQuota: 1, anchor: 0, fresh: 0 })
check('空查询也补自己的事', empty.items.some((x) => x.source === 'self' || x.source === 'life'), empty.items.map((x) => x.source))

// 候选函数本身：只看 self / life
const cands = selfCandidates(db, aid, '潮汐表', 2)
check('候选只来自 self/life', cands.length >= 1 && cands.every((x) => x.source === 'self' || x.source === 'life'), cands.map((x) => x.source))

// ---- 48h 新鲜加成 ----
const NOW = Date.now()
const DAY = 86400000
const mk = (id, days, heat) => ({
  id, text: '我' + id, source: 'self', partition: 'T1', rrf: 0.01, e: 0.6, heat,
  created_at: new Date(NOW - days * DAY).toISOString(), type: 'episode',
})
const oldItem = mk('old', 30, 0.1)
const freshItem = mk('fresh', 0.1, 0.1)
const boosted = rerank([oldItem, freshItem], { selfFreshBoost: 0.5 })
check('48h 内的自己的事排前面', boosted[0].id === 'fresh', boosted.map((x) => x.id))
// 同一份数据，只差来源：加成分只给 self
const asUser = { ...freshItem, id: 'not_self', source: 'extract' }
const pair1 = rerank([{ ...freshItem }, asUser], { selfFreshBoost: 0.5 })
check('自己的事加分高于同一份别人的事', pair1[0]._score > pair1[1]._score, pair1.map((x) => [x.id, x._score]))
const pair0 = rerank([{ ...freshItem }, asUser], { selfFreshBoost: 0 })
check('关掉加成两者同分', pair0[0]._score === pair0[1]._score, pair0.map((x) => [x.id, x._score]))

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
