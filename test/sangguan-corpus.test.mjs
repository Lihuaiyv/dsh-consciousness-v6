/**
 * 环开头的语料：原话留着，道理要能从事实里抽出来。复述不算。
 * 运行：node test/sangguan-corpus.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { factLine, spreadFacts, isRetelling, acceptPrinciples, buildCorpus, fileValuePrinciples } from '../src/modules/sangguan/corpus.js'
import { listDrafts } from '../src/modules/sangguan/draftstore.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const facts = [
  { at: '2026-11-05T10:00:00.000Z', text: '你说难受，我先给了方案，你半天没回' },
  { at: '2026-11-06T10:00:00.000Z', text: '你说累，我问要不要休息，你说了很多' },
  { at: '2026-11-07T10:00:00.000Z', text: '你半夜说睡不着，我陪你聊到困' },
]
const principle = '人难受的时候多数不是要一个答案，是要有人先把话接住'

check('原话：一句留住', factLine('你说难受，我先给了方案，你半天没回') === '你说难受，我先给了方案，你半天没回')
check('原话：客套丢掉', factLine('好的') === '')
check('原话：长段不掐', factLine('甲'.repeat(200)) === '')
check('原话：代码整段丢掉', factLine('function foo() { return 1 }\n然后说完') === '')

check('道理：三件事实撑得住', isRetelling(principle, facts) === false, principle)
check('复述：把原话缩短不算道理', isRetelling('你说难受，我先给了方案，你半天没回', facts) === true)
check('流水：今天开头的丢掉', isRetelling('今天你说难受，我给了方案，后来又聊到很晚', facts) === true)

const acc = acceptPrinciples([
  { principle, layer: 'W', facts: [0, 1, 2] },
  { principle: '你说难受，我先给了方案', layer: 'W', facts: [0, 1] },
  { principle: '只有一天的不算', layer: 'L', facts: [0, 0] },
], facts)
check('留下：跨天的那句', acc.items.length === 1 && acc.items[0].principle === principle, acc.items)
check('丢掉：复述', acc.dropped.some((d) => d.reason === 'retelling'))
check('丢掉：同一天', acc.dropped.some((d) => d.reason === 'facts_too_few'))

const spread = spreadFacts([
  { at: '2026-11-05T01:00:00.000Z', text: 'a1' },
  { at: '2026-11-05T02:00:00.000Z', text: 'a2' },
  { at: '2026-11-06T01:00:00.000Z', text: 'b1' },
], 2)
check('取料：两天轮流，不并成一句', spread.map((x) => x.text).join(',') === 'a1,b1', spread)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgcorp-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_corp'
const NOW = '2026-11-10T15:00:00.000Z'
const turn = db.prepare(`INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day)
  VALUES(?,?,?,?,?,?,?,?,?)`)
facts.forEach((f, i) => turn.run('t' + i, aid, 's', 't' + i, i, 'user', f.text, f.at, f.at.slice(0, 10)))

const built = await buildCorpus(db, aid, NOW, {
  ask: async (input) => {
    check('模型：看见的是原话编号', input.facts.length === 3 && input.facts[0].text === facts[0].text)
    return { ok: true, out: { items: [
      { principle, layer: 'W', facts: [0, 1, 2] },
      { principle: '你催的时候我宁可做完再交，也不先丢一个大概过去', layer: 'V', facts: [0, 2], alt: '先交一个大概', foregone: '多花了两天', exclusion: '不会先丢一个大概过去' },
    ] } }
  },
})
check('语料：一句世界观', built.items.filter((x) => x.layer === 'W').length === 1, built)
const filed = fileValuePrinciples(db, aid, NOW, built)
check('价值观：道理进草稿', filed.created === 1, filed)
const drafts = listDrafts(db, aid)
check('草稿：五闸过了', drafts.length === 1 && drafts[0].gates.pass === true, drafts[0] && drafts[0].gates)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
