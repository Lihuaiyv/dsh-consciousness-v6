/**
 * 三观 · 按情境召回与常驻宪章。
 * 运行：node test/sangguan-recall.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append } from '../src/modules/sangguan/ledger.js'
import { recall, coreIds, similarity, grams } from '../src/modules/sangguan/recall.js'
import { buildConstitution } from '../src/modules/sangguan/constitution.js'
import { loadState } from '../src/modules/sangguan/projection.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgrecall-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sgrecall'
const T = '2026-11-03T06:00:00.000Z'

const add = (layer, kind, text, meta) => {
  const r = append(db, aid, [{ type: 'CLAIM_EXP', layer, actor: 'sys', at: T, payload: { claims: [{ layer, kind, text, origin: 'extract', meta }] } }])
  return r.entities.claims[0]
}
const w = add('W', 'belt', '人难受的时候多数不是要一个答案，是要有人先把话接住', {
  scene: ['你说难受的时候', '你说累的时候', '你半夜说睡不着的时候'], expectation: '你倒苦水时我给方案你会更冷', observe: '回复变短',
})
const v1 = add('V', 'norm', '数据不对的时候宁可从头再跑一遍，也不交一个大概对的数')
const v2 = add('V', 'norm', '陪你的时候手机先扣着，不看别的')
const l1 = add('L', 'role', '汐是夜里涨落的潮水，退得再远也会再回来一次')

// ---------- 相似度 ----------
check('相似度：同句为 1', Math.abs(similarity('数据不对就重跑', '数据不对就重跑') - 1) < 1e-9)
check('相似度：不相干接近 0', similarity('你喜欢吃什么', '接口报错要重试') === 0)
check('相似度：部分重叠', similarity('数据不对就重跑', '数据不对的时候重跑一遍') > 0.3)
check('二元组：短句也能出组', grams('你好').size === 1)

// ---------- 核心：每层一条 ----------
const s = loadState(db, aid)
const core = coreIds(s)
check('核心：三层各一条', core.length === 3, core)
check('核心：W 是那条世界看法', core.includes(w))

// ---------- 召回 ----------
// 每层只留一条核心：V 的那条核心不参与召回，另一条才该被捞起来
const coreV = [v1, v2].find((id) => core.includes(id))
const otherV = coreV === v1 ? v2 : v1
// 用这条命题自己的话当 query：相似度接近 1，必须被捞起来
const selfQuery = (id) => (id === v1 ? '数据不对的时候宁可从头再跑一遍也不交一个大概对的数' : '陪你的时候手机先扣着不看别的')

const r1 = recall(db, aid, selfQuery(otherV))
check('召回：带核心', r1.core.length === 3)
check('召回：捞到非核心的那条', r1.picked.some((x) => x.id === otherV), r1.picked)
check('召回：最多两条', r1.picked.length <= 2)

const r2 = recall(db, aid, selfQuery(coreV))
check('召回：核心那条不再重复捞', !r2.picked.some((x) => x.id === coreV), r2.picked)

const r3 = recall(db, aid, '')
check('召回：空 query 只给核心', r3.picked.length === 0 && r3.reason === 'no_query')

const r4 = recall(db, aid, '量子色动力学的渐近自由')
check('召回：不相关不硬塞', r4.picked.length === 0, r4.picked)

// ---------- 常驻宪章 ----------
const con = buildConstitution(db, aid)
check('宪章：三行', con.lines.length === 3, con.lines)
check('宪章：有前缀且零术语', con.lines.every((x) => /^(你看世界的方式|你的人生观|你更看重)：/.test(x)), con.lines)
check('宪章：预算内', con.tokens <= 400, con.tokens)
check('宪章：指得出对应的命题', con.ids.length === 3, con.ids)

// 预算很小时按顺序丢，不会超
const tiny = buildConstitution(db, aid, { tokenCap: 20 })
check('宪章：小预算不超', tiny.tokens <= 20, tiny.tokens)
check('宪章：丢了要记账', tiny.skipped.length >= 1 || tiny.lines.length === 1, tiny)

// ---------- 接进注入 ----------
const { injectView } = await import('../src/modules/sangguan/inject.js')
const { setSangguanConfig } = await import('../src/modules/sangguan/config.js')
await setSangguanConfig(db, aid, { enabled: true })

const offView = injectView(db, aid, { now: '2026-11-03T06:10:00.000Z', query: selfQuery(v1) })
check('注入：三列关着时仍是旧取法', !offView.text.includes('你看世界的方式：'), offView.text.slice(0, 120))

await setSangguanConfig(db, aid, { lanes: { W: true, L: true, V: true } })
const onView = injectView(db, aid, { now: '2026-11-03T06:11:00.000Z', query: selfQuery(otherV) })
check('注入：三列打开后走宪章+召回', onView.text.includes('你看世界的方式：') && onView.text.includes('你更看重：'), onView.text)
check('注入：按这一句捞到的那条也在', onView.text.includes('这一会儿：'), onView.text)

const noQueryView = injectView(db, aid, { now: '2026-11-03T06:12:00.000Z' })
check('注入：没有 query 时退回旧取法', !noQueryView.text.includes('你看世界的方式：'), noQueryView.text.slice(0, 120))

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
