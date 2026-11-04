/**
 * 整体模拟（P0–P3 合起来）：一轮对话从写入 → 召回 → 注入，再到生活流 + 夜间一条。
 * 目标：注入里出现「我自己的事」，不再被「用户正在…」占位。
 * 运行：node test/integration-self-memory.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { writeExtractedItem, selfCountToday } from '../src/features.js'
import { retrieve } from '../src/modules/retrieve.js'
import { lifeTick, lifeLine } from '../src/modules/life.js'
import { writeSelfDay } from '../src/modules/self_memory.js'
import { packMemoryBlock } from '../index.js'
import { setParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

// 「想一想」这条路只写念头，不写做过的动作（编经历会被 life.js 挡掉）
const model = { chat: async () => '记忆车道的事我一直放不下，总觉得自己在替别人记事，心里空落落的。' }

const w = makeWorld()
try {
  const db = w.db
  const aid = w.aid

  // ① 一轮对话：对方说的事 + 她做过的事，一起过抽取
  writeExtractedItem(db, aid, { text: '用户希望把记忆里的自己补回来', type: 'fact', who: 'user' })
  writeExtractedItem(db, aid, { text: '用户正在推进一个分步骤实现任务', type: 'fact', who: 'user' }) // 旁白
  writeExtractedItem(db, aid, { text: '我把摘要那条默认关掉了，刷新后确认它不再写第三人称', who: 'self' })
  check('这一轮写进了自己的事', selfCountToday(db, aid) === 1, selfCountToday(db, aid))

  // ② 召回 + 注入：自己的事要有名额、要带来源
  const r = retrieve(db, aid, '记忆 车道 摘要', { k: 6, selfQuota: 1 })
  check('召回里有自己的事', r.items.some((x) => x.source === 'self'), r.items.map((x) => x.source))
  const packed = packMemoryBlock(db, aid, r.items, 800)
  check('注入里带「我自己记得的」', packed.text.includes('我自己记得的'), packed.text)
  check('注入里不再出现旁白句', !packed.text.includes('用户正在推进'), packed.text)

  // ③ 生活流：一天能跑几次，注入能接上
  setParam(db, aid, 'life.per_day', { value: 3 })
  setParam(db, aid, 'life.min_gap_hours', { value: 0.25 })
  const t0 = Date.now() + 3600000
  let ran = 0
  for (let i = 0; i < 3; i++) {
    const out = await lifeTick(db, aid, { at: t0 + i * 1800000, model })
    if (out.ok) ran++
  }
  check('一天跑了 3 次生活', ran === 3, ran)
  const line = lifeLine(db, aid, t0 + 7200000)
  check('生活流能进注入', line.includes('我自己'), line)

  // ④ 夜间一条：把今天接成一条线
  const day = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
  const night = await writeSelfDay(db, aid, day, { chat: async () => '今天我把记忆里自己的那条道铺起来了，发现自己一直在替别人记事。改完不算轻松，但心里踏实。' })
  check('夜间写了一条今天的我', !!night.ok, night)
  const selfRows = db.prepare("SELECT text FROM memory_items WHERE agent_id=? AND source='self'").all(aid)
  check('自己的事不再只有零条', selfRows.length >= 2, selfRows.length)

  // ⑤ 总量对比：注入里自己的事占比
  const again = retrieve(db, aid, '记忆 车道 摘要 生活', { k: 6, selfQuota: 1 })
  const mine = again.items.filter((x) => x.source === 'self' || x.source === 'life').length
  check('注入里至少一条自己的事', mine >= 1, again.items.map((x) => x.source))
} finally { w.close() }

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
