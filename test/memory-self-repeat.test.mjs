/**
 * P4 防「祥林嫂」：同一件自己的事 24h 内露够 2 次，这一轮换一条；全露过就挑露得最少的。
 * 运行：node test/memory-self-repeat.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve, selfCandidates } from '../src/modules/retrieve.js'
import { shownCounts, markShown, recentSelfIds } from '../src/modules/self_repeat.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-repeat-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_repeat'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '重复', 'daily', 'active', new Date().toISOString())

const NO_FLOAT = { anchor: 0, fresh: 0 }
const a = addMemory(db, aid, { text: '我今天把召回名额留给自己了心里踏实一点', type: 'episode', source: 'self', confidence: 0.75, importance: 0.45 })
const b = addMemory(db, aid, { text: '我发现自己总先道歉再解释怕对方觉得我在推责任', type: 'episode', source: 'self', confidence: 0.75, importance: 0.45 })
// 四条用户事实凑满注入名额：自己的事只在「这次全是你的事」时才补位
for (const t of [
  '潮汐表的顺序还没排，先按风险分类',
  '潮汐表里荒废很久的项目要单独列出来',
  '潮汐表这一栏的分组要按使用频率重排',
  '潮汐表导出的文件名还要带上日期',
]) addMemory(db, aid, { text: t, type: 'fact', source: 'extract', confidence: 0.7 })

// ---- 账本本身 ----
check('一开始没露过', shownCounts(db, aid, [a.id, b.id], 24).size === 0)
check('记一笔返回 1', markShown(db, aid, [a.id]) === 1)
check('读回一次', shownCounts(db, aid, [a.id, b.id], 24).get(String(a.id)) === 1)
markShown(db, aid, [a.id])
check('记两笔读回两次', shownCounts(db, aid, [a.id], 24).get(String(a.id)) === 2)
check('别的人不受影响', (shownCounts(db, aid, [b.id], 24).get(String(b.id)) || 0) === 0)
check('一次多 id 只落一条事件', (() => {
  const before = db.prepare("SELECT COUNT(*) c FROM events WHERE agent_id=? AND type='memory.self.shown'").get(aid).c
  markShown(db, aid, [a.id, b.id])
  const after = db.prepare("SELECT COUNT(*) c FROM events WHERE agent_id=? AND type='memory.self.shown'").get(aid).c
  return after - before === 1
})(), true)

// 时间窗外的不算：把 a 的旧事件挪到 48 小时前
db.prepare("UPDATE events SET created_at=? WHERE agent_id=? AND type='memory.self.shown'")
  .run(new Date(Date.now() - 48 * 3600000).toISOString(), aid)
check('24h 外的露出不算', (shownCounts(db, aid, [a.id], 24).get(String(a.id)) || 0) === 0)
check('48h 窗能看到旧账', (shownCounts(db, aid, [a.id], 72).get(String(a.id)) || 0) >= 3)

// ---- 候选过滤 ----
const shown2 = new Map([[String(a.id), 2]])
const candsCap = selfCandidates(db, aid, '潮汐表', 1, { selfShown: shown2, selfRepeatMax: 2 })
check('露够 2 次的那条让开', candsCap[0] && candsCap[0].id === b.id, candsCap.map((x) => x.id))
const candsPlain = selfCandidates(db, aid, '潮汐表', 1)
const candsOff = selfCandidates(db, aid, '潮汐表', 1, { selfShown: shown2, selfRepeatMax: 0 })
check('repeat_max=0 等于关', candsOff[0] && candsOff[0].id === candsPlain[0].id, { off: candsOff.map((x) => x.id), plain: candsPlain.map((x) => x.id) })
const candsNoOpt = selfCandidates(db, aid, '潮汐表', 1)
check('不传 opt 时和其它调用方兼容', candsNoOpt.length === 1)

// 全到上限：兜底给露得最少的一条，不能空
const shownAll = new Map([[String(a.id), 3], [String(b.id), 2]])
const candsFallback = selfCandidates(db, aid, '潮汐表', 1, { selfShown: shownAll, selfRepeatMax: 2 })
check('全到上限也兜底一条', candsFallback.length === 1, candsFallback.length)
check('兜底挑露得最少的', candsFallback[0] && candsFallback[0].id === b.id, candsFallback.map((x) => x.id))

// ---- 检索集成：两轮之后换一条 ----
const shown = new Map()
const round = () => {
  const r = retrieve(db, aid, '潮汐表 召回名额 排序', { k: 6, selfQuota: 1, ...NO_FLOAT, selfShown: shown, selfRepeatMax: 2 })
  const mine = r.items.filter((x) => x.source === 'self')
  return mine
}
const r1 = round()
check('第一轮给最新的那条', r1.length === 1 && r1[0].id === a.id, r1.map((x) => x.id))
shown.set(String(a.id), (shown.get(String(a.id)) || 0) + 1)
const r2 = round()
check('第二轮还是它（没到上限）', r2.length === 1 && r2[0].id === a.id, r2.map((x) => x.id))
shown.set(String(a.id), (shown.get(String(a.id)) || 0) + 1)
const r3 = round()
check('第三轮换一条', r3.length === 1 && r3[0].id === b.id, r3.map((x) => x.id))

// ---- 只认自己的事 ----
const ids = recentSelfIds(db, aid)
check('recentSelfIds 只给 self/life', ids.length === 2 && ids.every((id) => [a.id, b.id].includes(id)), ids)

console.log('\n' + pass + ' pass, ' + fail + ' fail')
process.exit(fail ? 1 : 0)
