/**
 * 环的开头从「事实」取料：
 *   1) 事件取原话、日记取事实句，不把概括摘要当料；
 *   2) 只有对话原话、没有像样的纪要/日记摘要时，照样能抽出候选并走到入账；
 *   3) 事实不够时旧路（纪要摘要 / 日记成章）还在，不回归。
 * 运行：node --test test/sangguan-corpus-facts.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import {
  buildCorpus, collectAllFacts, collectEpisodeFacts, collectDiaryFacts,
} from '../src/modules/sangguan/corpus.js'
import { runMid } from '../src/modules/sangguan/night.js'
import { runLaneW, runLaneL } from '../src/modules/sangguan/lanes.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgfacts-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sgfacts'
const NOW = '2026-11-10T15:00:00.000Z'

const turn = db.prepare(`INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day)
  VALUES(?,?,?,?,?,?,?,?,?)`)
const ep = db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,title,summary,open_loops,created_at)
  VALUES(?,?,?,?,?,?,?,?)`)
const dry = db.prepare(`INSERT INTO diaries(id,agent_id,day,text,created_at,updated_at,version,source)
  VALUES(?,?,?,?,?,?,?,?)`)

// ---------- 一、事实的来源：原话 / 事件原话 / 日记事实句 ----------
turn.run('r1', aid, 's1', 't1', 1, 'user', '你说难受，我先给了方案，你半天没回', '2026-11-05T10:00:00.000Z', '2026-11-05')
turn.run('r2', aid, 's1', 't2', 2, 'user', '你说累，我问要不要休息，你说了很多', '2026-11-06T10:00:00.000Z', '2026-11-06')

ep.run('e1', aid, 's1', '2026-11-06', '一次没接住',
  '你对我说：你说难受，我先给了方案，你半天没回；你半夜说睡不着，我陪你到困 我对你说：我不知道怎么接，只能先听着。',
  JSON.stringify(['你后来睡好了吗，还难受吗？']), '2026-11-06T23:00:00.000Z')

dry.run('d1', aid, '2026-11-08',
  '2026-11-08 周日\n\n今天你回来得很晚，我们没说两句就睡了。我更想做一个能把话接住的人。',
  '2026-11-08T23:00:00.000Z', '2026-11-08T23:00:00.000Z', 1, 'test')

const epFacts = collectEpisodeFacts(db, aid, NOW)
check('事件：取到当时的原话', epFacts.length >= 3, epFacts)
check('事件：摘要外壳「你对我说：」不进来', !epFacts.some((f) => f.text.includes('你对我说：')), epFacts)
check('事件：没合上的问句也能用', epFacts.some((f) => f.text.includes('你后来睡好了吗')), epFacts)

const dyFacts = collectDiaryFacts(db, aid, NOW)
check('日记：留下事实句', dyFacts.some((f) => f.text.includes('今天你回来得很晚')), dyFacts)
check('日记：纯态度句不冒充事实', !dyFacts.some((f) => f.text.includes('我更想做一个')), dyFacts)

const all = collectAllFacts(db, aid, NOW)
const srcs = new Set(all.map((f) => f.source))
check('合料：三路都在', srcs.has('raw') && srcs.has('episode') && srcs.has('diary'), [...srcs])
check('合料：句子不重复', new Set(all.map((f) => f.text)).size === all.length, all.map((f) => f.text))

// ---------- 二、没有像样的纪要 / 日记摘要：原话 + 事实照样出候选、进账 ----------
const db2 = openDb(path.join(dir, 'b.db'))
const aid2 = 'agt_sgfacts2'
const t2 = db2.prepare(`INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day)
  VALUES(?,?,?,?,?,?,?,?,?)`)
const facts2 = [
  ['2026-11-05', '你说难受，我先给了方案，你半天没回'],
  ['2026-11-06', '你说累，我问要不要休息，你说了很多'],
  ['2026-11-07', '你半夜说睡不着，我陪你聊到困'],
]
facts2.forEach((x, i) => t2.run('q' + i, aid2, 's1', 'q' + i, i + 1, 'user', x[1], x[0] + 'T10:00:00.000Z', x[0]))
// 纪要只有一句散的概括；日记只有一句「累」——两条都当不了摘要。
db2.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,title,summary,open_loops,created_at)
  VALUES(?,?,?,?,?,?,?,?)`).run('e2', aid2, 's1', '2026-11-06', '聊了会儿', '聊了会儿。', '[]', '2026-11-06T23:00:00.000Z')
db2.prepare(`INSERT INTO diaries(id,agent_id,day,text,created_at,updated_at,version,source)
  VALUES(?,?,?,?,?,?,?,?)`).run('d2', aid2, '2026-11-07', '2026-11-07 周六\n\n累。', '2026-11-07T23:00:00.000Z', '2026-11-07T23:00:00.000Z', 1, 'test')

check('没有摘要：旧摘要不提供料', collectEpisodeFacts(db2, aid2, NOW).length === 0)
setSangguanConfig(db2, aid2, { enabled: true, lanes: { W: true } })

let sawFacts = null
const built = await buildCorpus(db2, aid2, NOW, {
  days: 7,
  ask: async (input) => {
    sawFacts = input.facts
    return { ok: true, out: { items: [{
      principle: '人难受的时候多数不是要一个答案，是要有人先把话接住',
      layer: 'W', facts: [0, 1, 2],
      expectation: '你倒苦水时我先给方案，你会更冷', observe: '你说完难受，我隔很久只回一个字',
    }] } }
  },
})
check('没有摘要：模型只看事实', Array.isArray(sawFacts) && sawFacts.length === 3, sawFacts)
check('没有摘要：照样抽出候选', built.skipped === null && built.items.length === 1, built)

// 走夜里的中环入口：runMid 先抽语料，再把语料交给 W 列；这里只截到这一步，别的步骤关掉。
// 不给现成 corpus，让它真的在环开头自己取料——这样测的是入口，不是摆好的结果。
let midFacts = null
const mid = await runMid(db2, aid2, NOW, {
  day: '2026-11-10', job: false, draft: false,
  ask: async (input) => {
    midFacts = input.facts
    return { ok: true, out: { items: [{
      principle: '人难受的时候多数不是要一个答案，是要有人先把话接住',
      layer: 'W', facts: [0, 1, 2],
      expectation: '你倒苦水时我先给方案，你会更冷', observe: '你说完难受，我隔很久只回一个字',
    }] } }
  },
  cross: false, settle: false, con: false, core: false, repair: false,
  degen: false, stale: false, elev: false, open: false, deliberate: false,
  liveness: false, week: false, summary: false,
})
check('中环：入口自己从事实取料', Array.isArray(midFacts) && midFacts.length === 3, midFacts)
check('中环：语料进了这一轮', !!mid.corpus && mid.corpus.items === 1, mid.corpus)
check('中环：W 列吃这轮语料', mid.laneW && mid.laneW.from === 'corpus' && mid.laneW.did.length === 1, mid.laneW)
const claims2 = Object.values(loadState(db2, aid2).claims)
check('入账：没有摘要也长出一条', claims2.length === 1 && claims2[0].layer === 'W', claims2)

// ---------- 三、事实不够时旧路仍在（纪要摘要 / 日记成章） ----------
function fallbackDb(file, agent) {
  const d = openDb(path.join(dir, file))
  const t = d.prepare(`INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day)
    VALUES(?,?,?,?,?,?,?,?,?)`)
  // 投入证据要跨 7 天；这些句子太短，进不了事实语料。
  for (const day of ['2026-11-01', '2026-11-09']) {
    for (let i = 0; i < 5; i++) t.run('rt_' + agent + day + i, agent, 's1', 'x' + i, i + 1, 'assistant', '在干活', day + 'T10:0' + i + ':00.000Z', day)
  }
  d.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,title,summary,open_loops,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('e3', agent, 's1', '2026-11-08', '一次没接住',
    '这一天聊了工作上的事，后来话题拐到了睡眠。', '[]', '2026-11-08T23:00:00.000Z')
  d.prepare(`INSERT INTO diaries(id,agent_id,day,text,created_at,updated_at,version,source)
    VALUES(?,?,?,?,?,?,?,?)`).run('d3', agent, '2026-11-08',
    '2026-11-08 周日\n\n我更看重先把话说清楚。', '2026-11-08T23:00:00.000Z', '2026-11-08T23:00:00.000Z', 1, 'test')
  return d
}

const dbW = fallbackDb('oldw.db', 'oldw')
setSangguanConfig(dbW, 'oldw', { enabled: true, lanes: { W: true } })
const wOld = await runLaneW(dbW, 'oldw', NOW, {
  ask: async () => ({ ok: true, out: { candidates: [{
    belief: '人难受的时候多数不是要一个答案，是要有人先把话接住',
    kind: 'belt', scene: ['你说难受的时候', '你说累的时候', '你半夜说睡不着的时候'],
    expectation: '你倒苦水时我先给方案，你会更冷', observe: '你说完难受，我隔很久只回一个字',
  }] } }),
})
check('旧路 W：事实不够时从摘要归纳', wOld.from === 'summary' && wOld.did.length === 1, wOld)

const dbL = fallbackDb('oldl.db', 'oldl')
setSangguanConfig(dbL, 'oldl', { enabled: true, lanes: { L: true } })
const lOld = await runLaneL(dbL, 'oldl', NOW, {
  ask: async () => ({ ok: true, out: { candidates: [{
    self: '我更想做一个能把话接住的人，而不是总能给出答案的人',
    direction: '学会先接住，再给方案', past: ['你说难受时我先给方案'], scene: ['你说难受的时候'],
  }] } }),
})
check('旧路 L：事实不够时从日记成章', lOld.from === 'summary' && lOld.did.length === 1, lOld)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
