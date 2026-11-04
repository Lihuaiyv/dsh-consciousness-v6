/**
 * 三观 · 草稿器：聚类、五道闸、人批入库。
 * 运行：node test/sangguan-draft.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { kindOfForegone, clusterByForegone, gatesOf, buildDrafts, commitDraft } from '../src/modules/sangguan/draft.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
function throwsAny(name, fn) {
  try { fn(); check(name, false, '没有抛错') } catch { check(name, true) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgdraft-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sgdraft'
const at = (d) => '2026-11-0' + d + 'T10:00:00.000Z'

// ---------- 放弃物归类 ----------
check('归类：时间', kindOfForegone('多花了两天重跑') === '时间')
check('归类：准确', kindOfForegone('交了一个大概对的数') === '准确')
check('归类：被喜欢', kindOfForegone('你会觉得我在敷衍') === '被喜欢')
check('归类：认不出就给其他', kindOfForegone('说不清') === '其他')

// ---------- 聚类 ----------
const ann = [
  { ref: 'e1', at: at(1), alt: '按趋势补个数', foregone: '多花了两天', cost_to: '对方' },
  { ref: 'e2', at: at(3), alt: '先交一半', foregone: '又拖了一晚', cost_to: '自己' },
  { ref: 'e3', at: at(4), alt: '糊过去', foregone: '你会觉得我在敷衍', cost_to: '关系' },
]
const cl = clusterByForegone(ann)
check('聚类：时间簇成立（2 条、跨 2 天）', cl.some((c) => c.kind === '时间' && c.items.length === 2), cl)
check('聚类：只有 1 条的不成簇', !cl.some((c) => c.kind === '被喜欢'), cl)
const sameDay = clusterByForegone([
  { ref: 'a', at: at(1), alt: 'x', foregone: '多花了两天' },
  { ref: 'b', at: at(1), alt: 'y', foregone: '多花了一小时' },
])
check('聚类：同一天两条不算', sameDay.length === 0, sameDay)

// ---------- 五道闸 ----------
const goodDraft = { text: '数据不对的时候我会从头再跑一遍，哪怕你已经在催了', alt: '按趋势补个数交差', foregone: '多花了两天', exclusion: '不会拿一个大概对的数交差' }
const g = gatesOf(goodDraft, { items: ann.slice(0, 2) })
check('闸：全过', g.pass === true, g)
check('闸：缺排除被拒', gatesOf({ ...goodDraft, exclusion: '' }, { items: ann.slice(0, 2) }).g3 === false)
check('闸：代价写「没什么」被拒', gatesOf({ ...goodDraft, foregone: '没什么' }, { items: ann.slice(0, 2) }).g2 === false)
check('闸：任务句被拒', gatesOf({ ...goodDraft, text: '数据有问题就先查接口再说' }, { items: ann.slice(0, 2) }).g4 === false)
check('闸：只有一条证据被拒', gatesOf(goodDraft, { items: ann.slice(0, 1) }).g5 === false)

// ---------- 起草（注入 stub） ----------
const drafts = await buildDrafts(db, aid, cl, {
  at: at(5),
  ask: async (input) => ({
    ok: true,
    out: {
      drafts: [
        { text: '数据不对的时候我会从头再跑一遍，哪怕你已经在催了', exclusion: '不会拿一个大概对的数交差', boundary: ['你明确说只要估算时'] },
        { text: '我重视准确', exclusion: '', boundary: [] },
      ],
    },
  }),
})
check('起草：出两条', drafts.length === 2, drafts.length)
check('起草：第一条过闸', drafts[0].gates.pass === true, drafts[0].gates)
check('起草：第二条缺排除，过不了闸', drafts[1].gates.pass === false)
check('起草：带上证据与原话', drafts[0].evidence.length === 2 && drafts[0].evidence[0].ref === 'e1')
check('起草：状态是 draft', drafts[0].status === 'draft')

// ---------- 入库：必须人批 + 过闸 ----------
throwsAny('入库：没人批直接拒', () => commitDraft(db, aid, drafts[0], { at: at(5) }))
throwsAny('入库：没过闸拒', () => commitDraft(db, aid, drafts[1], { at: at(5), human: true }))
const cid = commitDraft(db, aid, drafts[0], { at: at(5), human: true })
const s = loadState(db, aid)
const c = s.claims[cid]
check('入库：V 层 norm', c && c.layer === 'V' && c.kind === 'norm')
check('入库：origin=user（不再被自动清）', c.origin === 'user')
check('入库：带取舍', c.meta && c.meta.foregone === '多花了两天')
check('入库：带来源阶段', c.meta.lane_phase === 'V-draft')
check('入库：只写了一条', Object.keys(s.claims).length === 1)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
