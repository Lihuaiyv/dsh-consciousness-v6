/**
 * 环的开头：料的最小单位是「一件事怎么走下来的」。
 * 成弧：她先说 → 主人顶一句（纠正，不是问句）→ 她改成。
 * 不成弧：疑问句、她没换说法、中间隔太久。
 * 运行：node --test test/sangguan-corpus-arcs.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { collectArcs, collectAllFacts, buildCorpus } from '../src/modules/sangguan/corpus.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgarcs-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sgarcs'
const NOW = '2026-11-10T15:00:00.000Z'

const turn = db.prepare(`INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day)
  VALUES(?,?,?,?,?,?,?,?,?)`)
function addTurn(id, session, seq, role, text, at, day) {
  turn.run(id, aid, session, id, seq, role, text, at, day)
}

// 一、真弧：11-05
addTurn('a1', 's1', 1, 'assistant', '我先给你列了个改法清单，觉得问题不大。', '2026-11-05T10:00:00.000Z', '2026-11-05')
addTurn('u1', 's1', 2, 'user', '不对，我要的不是修，是它别再这样。', '2026-11-05T10:02:00.000Z', '2026-11-05')
addTurn('a2', 's1', 3, 'assistant', '明白了：不是把漏洞补上，而是让它一开始就不往那条路上走。', '2026-11-05T10:04:00.000Z', '2026-11-05')

// 二、真弧：11-07
addTurn('b1', 's1', 4, 'assistant', '我把这句写成了结论，直接放进页面。', '2026-11-07T21:00:00.000Z', '2026-11-07')
addTurn('u2', 's1', 5, 'user', '别这样，你根本没看我这周在干嘛。', '2026-11-07T21:02:00.000Z', '2026-11-07')
addTurn('b2', 's1', 6, 'assistant', '我收回那条，先把你这一周说过的事摆出来，再写。', '2026-11-07T21:05:00.000Z', '2026-11-07')

// 三、不是弧：顶的是问句
addTurn('q1', 's2', 1, 'assistant', '我把世界观那格填上了。', '2026-11-08T09:00:00.000Z', '2026-11-08')
addTurn('u3', 's2', 2, 'user', '你是不是又没看日记？', '2026-11-08T09:01:00.000Z', '2026-11-08')
addTurn('q2', 's2', 3, 'assistant', '看了，只是没对上。', '2026-11-08T09:03:00.000Z', '2026-11-08')

// 四、不是弧：她没换说法
addTurn('n1', 's3', 1, 'assistant', '今天先把服务起来再说，别的都放一放。', '2026-11-09T09:00:00.000Z', '2026-11-09')
addTurn('u4', 's3', 2, 'user', '不行。', '2026-11-09T09:01:00.000Z', '2026-11-09')
addTurn('n2', 's3', 3, 'assistant', '今天先把服务起来再说，别的都放一放。', '2026-11-09T09:03:00.000Z', '2026-11-09')

// 五、不是弧：中间隔了一小时
addTurn('m1', 's4', 1, 'assistant', '我先按老办法把它塞进日记里。', '2026-11-10T08:00:00.000Z', '2026-11-10')
addTurn('u5', 's4', 2, 'user', '重来，那不是我说的意思。', '2026-11-10T08:05:00.000Z', '2026-11-10')
addTurn('m2', 's4', 3, 'assistant', '那我改成先问你，再说我打算怎么写。', '2026-11-10T09:15:00.000Z', '2026-11-10')

const arcs = collectArcs(db, aid, NOW, 7, 12)
check('成弧：先说 → 被顶 → 改成', arcs.length === 2, arcs.map((a) => a.ref))
check('弧里带三步原话', arcs.every((a) => a.lines && a.lines.length >= 3))
check('弧留整句，不是只留第一句', arcs.some((a) => a.text.includes('不是把漏洞补上')))
check('疑问句不当成被顶', !arcs.some((a) => a.text.includes('你是不是')))
check('她没换说法不算弧', !arcs.some((a) => a.text.includes('今天先把服务起来')))
check('隔太久的顶不算弧', !arcs.some((a) => a.text.includes('那不是我说的意思')))
check('弧的来源标成 arc', arcs.every((a) => a.source === 'arc'))

const all = collectAllFacts(db, aid, NOW)
check('合料里有弧', all.some((f) => f.source === 'arc'), all.map((f) => f.source))
check('两条弧都进了窗口', all.filter((f) => f.source === 'arc').length === 2, all.map((f) => f.source))

// 假模型：交给它两句弧，它能抽出一句道理（跨两天，字数不像复述）
const arcIdx = all.map((f, i) => (f.source === 'arc' ? i : -1)).filter((i) => i >= 0)
const askGood = async () => ({
  ok: true,
  out: { items: [{ principle: '她更在意这件事会不会重演，而不在意这一次补没补上。', layer: 'W', facts: [arcIdx[0], arcIdx[1]] }] },
})
const good = await buildCorpus(db, aid, NOW, { ask: askGood })
check('两句弧能抽出一条道理并入账', good.items.length === 1, { items: good.items, dropped: good.dropped })
check('入账的那条带两条证据', good.items[0] && good.items[0].facts.length === 2)

// 假模型：把原话换个说法交回来 → 丢
const askRetell = async () => ({
  ok: true,
  out: { items: [{ principle: '明白了，不是把漏洞补上，而是让它一开始就不往那条路上走。', layer: 'W', facts: [arcIdx[0], arcIdx[1]] }] },
})
const retell = await buildCorpus(db, aid, NOW, { ask: askRetell })
check('复述原话的道理被丢掉', retell.items.length === 0 && retell.dropped.some((d) => d.reason === 'retelling'), retell.dropped)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
