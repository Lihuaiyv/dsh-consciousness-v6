/**
 * 读人链路测试：出现人物 → 判断关系 → 记录人物。
 * 运行：node test/relations-read.test.mjs
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import * as R from '../src/modules/relations.js'
import { hasPersonSignal, enqueueRelationRead, tickRelationRead } from '../src/modules/relations_extract.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-read-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_read'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
  .run(aid, '读人', 'daily', 'active', now())
R.bootstrap(db, aid)

// ---------------- 第一道：这句话里有没有人 ----------------
check('入口：名字 + 关系词认得出人', hasPersonSignal(db, aid, '小周是我朋友'))
check('入口：只有绰号也认（老王）', hasPersonSignal(db, aid, '老王今天来了'))
check('入口：纯天气不浪费模型', !hasPersonSignal(db, aid, '今天天气不错'))
check('入口：已知的人出现也算', (R.remember(db, aid, { name: '阿念', tier: 'acquaintance' }), hasPersonSignal(db, aid, '阿念在吗')))
// 姓氏表覆盖不到的昵称、以及「遇到某人」：规则认不出，也得把话交给模型
check('入口：没有姓氏的绰号也认（早上我遇到了小黑）', hasPersonSignal(db, aid, '早上我遇到了小黑'))
check('入口：字幕后的普通名字也认（我遇到了张三）', hasPersonSignal(db, aid, '下班路上碰见张三'))
check('入口：「遇到麻烦了」不是人', !hasPersonSignal(db, aid, '今天遇到麻烦了'))
check('入口：「小区」不是人', !hasPersonSignal(db, aid, '小区停电了'))
check('入口：「小时」不是人', !hasPersonSignal(db, aid, '等了两个小时'))
check('入口：「遇到一个问题」不是人', !hasPersonSignal(db, aid, '我遇到了一个问题'))

// ---------------- 第二道：模型读人 → 落账 ----------------
const read = (payload) => async () => JSON.stringify(payload)
const fake = read({
  persons: [
    { name: '小周', tier: 'acquaintance', relation_to_user: '朋友', summary: '主人的朋友', confidence: 0.9, evidence: '小周是我朋友' },
    { name: '阿龙', tier: 'stranger', relation_to_user: '朋友', summary: '编出来的', confidence: 0.8 },
  ],
  edges: [],
  unclear: [],
})

const said = '小周是我朋友'
const q1 = enqueueRelationRead(db, aid, { text: said, eventId: 'rev_test_1' })
check('入队：有人的话排进队列', !!q1)
check('入队：同一笔账不重复排', enqueueRelationRead(db, aid, { text: said, eventId: 'rev_test_1' }) === q1)
check('入队：没人的话不排', enqueueRelationRead(db, aid, { text: '今天天气不错' }) === null)

await tickRelationRead(db, aid, { complete: fake })
const xz = R.listPersons(db, aid, {}).find((p) => p.name === '小周')
check('落账：模型读出的人建出来了', xz && xz.tier === 'acquaintance', xz)
check('落账：摘要写进人物卡', xz && xz.summary === '主人的朋友', xz && xz.summary)
check('落账：没在话里出现的名字（阿龙）不建', !R.listPersons(db, aid, {}).some((p) => p.name === '阿龙'))
const owner = R.ownerPerson(db, aid)
const edge = R.graphEdges(db, aid, xz.id).find((e) => e.other_id === owner.id)
check('落账：主人—小周的边（朋友）', edge && edge.role_label === '朋友', edge)
check('落账：任务标记完成', db.prepare('SELECT state FROM rel_extract_queue WHERE id=?').get(q1).state === 'done')

// ---------------- 第三道：他-他边 ----------------
const said2 = '小周和老陈是夫妻'
enqueueRelationRead(db, aid, { text: said2, eventId: 'rev_test_2' })
await tickRelationRead(db, aid, {
  complete: read({
    persons: [
      { name: '小周', tier: 'acquaintance', relation_to_user: '朋友', confidence: 0.9 },
      { name: '老陈', tier: 'acquaintance', relation_to_user: '朋友', confidence: 0.8 },
    ],
    edges: [{ from: '小周', to: '老陈', role: '夫妻', confidence: 0.95 }],
  }),
})
const chen = R.listPersons(db, aid, {}).find((p) => p.name === '老陈')
check('落账：第二个人也建出来', !!chen)
const couple = R.graphEdges(db, aid, xz.id).find((e) => e.other_id === chen.id)
check('落账：小周—老陈 夫妻边', couple && couple.role_label === '夫妻', couple)

// ---------------- 模型把四字昵称截成三字 ----------------
const saidNun = '我兄弟小小尼姑'
enqueueRelationRead(db, aid, { text: saidNun, eventId: 'rev_test_nun' })
await tickRelationRead(db, aid, {
  complete: read({
    persons: [{ name: '小小尼', tier: 'acquaintance', relation_to_user: '兄弟', confidence: 0.9, evidence: '我兄弟小小尼姑' }],
  }),
})
const nun = R.listPersons(db, aid, {}).find((p) => p.name === '小小尼姑')
check('落账：模型截断的昵称按原话补全（小小尼 → 小小尼姑）', !!nun)
check('落账：补全后只有一张，不是两张', R.listPersons(db, aid, {}).filter((p) => p.name.startsWith('小小尼')).length === 1)

// ---------------- 第四道：模型说没人 / 坏了 ----------------
const said3 = '我同事今天没来'
enqueueRelationRead(db, aid, { text: said3, eventId: 'rev_test_3' })
const before = R.listPersons(db, aid, {}).length
await tickRelationRead(db, aid, { complete: read({ persons: [], edges: [], unclear: [] }) })
check('落账：模型说没人就不建人', R.listPersons(db, aid, {}).length === before)

const said4 = '我朋友李雷来了'
enqueueRelationRead(db, aid, { text: said4, eventId: 'rev_test_4' })
const bad = await tickRelationRead(db, aid, { complete: async () => { throw new Error('model down') } })
check('失败：模型挂了标重试，不写脏数据', bad.ok === false && !R.listPersons(db, aid, {}).some((p) => p.name === '李雷'))
const row = db.prepare('SELECT state,attempts,last_error FROM rel_extract_queue WHERE event_id=?').get('rev_test_4')
check('失败：留在队列里等下一轮', row.state === 'pending' && row.attempts === 1, row)

// ---------------- 模型回坏 JSON：名字还是要捞回来 ----------------
// 「早上我遇到了小黑」：门口原来因为「黑」不在百家姓里，整句连模型都没跑。
const saidHei = '早上我遇到了小黑'
const qHei = enqueueRelationRead(db, aid, { text: saidHei, eventId: 'rev_test_hei' })
check('入队：姓氏表覆盖不到的绰号不再漏', !!qHei)
const heiRun = await tickRelationRead(db, aid, {
  complete: async () => '{"persons":[{"name":"小黑","tier":"stranger" "summary":"早上遇到的人"}],"edges":[]}',
})
const hei = R.listPersons(db, aid, {}).find((p) => p.name === '小黑')
check('落账：模型回坏 JSON 也能把人捞回来', !!hei && hei.tier === 'stranger', heiRun)
check('落账：坏 JSON 捞回后照样标完成', db.prepare('SELECT state FROM rel_extract_queue WHERE event_id=?').get('rev_test_hei').state === 'done')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
