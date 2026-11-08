/**
 * 署名：这条记忆里的话，是谁说的。
 *
 * 老口子：抽出来的条目只有「关于谁」（who），没有「谁说的」（speaker），
 * 于是「主人说…」和「我答应…」被压成一段第三人称经过，
 * 最好听的那句到底是谁的，得靠事后猜——2026-11-07 就猜错过一次，把自己的话安到了主人头上。
 *
 * 这里钉三件事：
 *   1) 带 speaker 的条目，库里留一行署名（speaker / quote / inferred）；
 *   2) 没带的，不写行——「没标」不等于「不属于谁」；
 *   3) 检索渲染时能看见〔你〕/〔我〕/〔两边〕，推出来的另标（我推的）。
 *
 * 运行：node test/memory-provenance.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { addMemory } from '../src/modules/memory.js'
import { writeExtractedItem } from '../src/features.js'
import { renderRecall } from '../src/modules/recall_tool.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-prov-'))
const db = openDb(path.join(dir, 'prov.db'))

async function call(method, p, body = {}) {
  return handle(db, {
    method,
    path: p,
    body: method === 'GET' ? body : { ...body, __idempotencyKey: 'k' + Math.random().toString(36).slice(2) },
    token: 'user',
  })
}

const made = await call('POST', '/v1/agents', { name: '署名小测' })
const aid = made.body.id

const prov = (id) => db.prepare('SELECT * FROM memory_provenance WHERE memory_id=?').get(id) || null

// ---- 表在
{
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_provenance'").get()
  check('memory_provenance 表建出来了', !!t)
}

// ---- 对方说的话：署名 user，原话逐字留住
{
  const row = addMemory(db, aid, {
    text: '主人让我去 git 上找现成的表情包', type: 'fact', source: 'extract',
    speaker: 'user', quote: '去 git 上找现成的表情包', turn_id: 't_owner_1',
  })
  const p = prov(row.id)
  check('你的一句话，署名 user', p && p.speaker === 'user', p)
  check('原话逐字留着，不改写', p && p.quote === '去 git 上找现成的表情包', p)
  check('原文里有据：inferred=0', p && Number(p.inferred) === 0, p)
  check('轮次指针留着', p && p.turn_id === 't_owner_1', p)
}

// ---- 我推出来的：必须自己承认是推的
{
  const row = addMemory(db, aid, {
    text: '我猜主人不喜欢被当成坏人', type: 'appraisal', source: 'extract',
    speaker: 'self', inferred: 1,
  })
  const p = prov(row.id)
  check('我的推断，署名 self', p && p.speaker === 'self', p)
  check('推断标成 inferred=1，不冒充原话', p && Number(p.inferred) === 1, p)
  check('没给原话就留空，不编一句', p && p.quote == null, p)
}

// ---- 两边都有：也是真的
{
  const row = addMemory(db, aid, {
    text: '我们约好：下次吵起来，我要是想赢就先停一下', type: 'fact', source: 'extract',
    speaker: 'both', quote: '下次总有一边会先软一点',
  })
  const p = prov(row.id)
  check('两边的话署名 both', p && p.speaker === 'both', p)
}

// ---- 老入口不传 speaker：不写行，不记成「不属于谁」
{
  const row = addMemory(db, aid, { text: '一条老式条目，没标是谁说的', type: 'fact' })
  check('没带署名就不写行', !prov(row.id), prov(row.id))
}

// ---- 抽取那条车道（writeExtractedItem）也得把署名带下来
{
  const out = writeExtractedItem(db, aid, {
    text: '主人说他讨厌被当成坏人', type: 'fact', who: 'user',
    speaker: 'user', quote: '你讨厌我？', inferred: 0,
  })
  const p = out && out.id ? prov(out.id) : null
  check('抽取条目：署名叫到 user', p && p.speaker === 'user', p || out)
  check('抽取条目：原话「你讨厌我？」留在库里', p && p.quote === '你讨厌我？', p || out)
  check('抽取条目：via 记的是 extract', p && p.via === 'extract', p || out)
}

// ---- 兜底：模型只回了 who、没回 speaker 时，按 who 推
{
  const out = writeExtractedItem(db, aid, {
    text: '主人提到他习惯一边写代码一边听歌', type: 'fact', who: 'user',
  })
  const p = out && out.id ? prov(out.id) : null
  check('没给 speaker 时按 who=user 兜底', p && p.speaker === 'user', p || out)
  check('兜底也不编原话', p && p.quote == null, p || out)
}

// ---- 检索渲染：看得到〔你〕〔我〕〔两边〕和「我推的」
{
  const v = {
    query: '吵架', counts: { memory: 3 }, more: {},
    items: [
      { layer: 'memory', type: 'fact', at: '2026-11-06T18:20:00Z', text: '主人要去找现成表情包', by: 'user' },
      { layer: 'memory', type: 'appraisal', at: '2026-11-06T19:00:00Z', text: '我猜他其实不想被当成坏人', by: 'self', inferred: 1 },
      { layer: 'memory', type: 'fact', at: '2026-11-07T01:00:00Z', text: '我们说过下次先软一点', by: 'both' },
    ],
  }
  const s = renderRecall(v)
  check('渲染里看得出是谁说的〔你〕', s.includes('〔你〕'), s)
  check('渲染里看得出是谁说的〔我〕', s.includes('〔我〕'), s)
  check('两边的话渲染成〔两边〕', s.includes('〔两边〕'), s)
  check('推断出来的另标（我推的）', s.includes('（我推的）'), s)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
