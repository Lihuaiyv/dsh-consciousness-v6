/**
 * 时间距离：她得知道「刚才说的」和「三天前说的」不是一回事。
 * 运行：node test/presence.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { describeGap, partOfDay, presenceLine, lastTurnOf } from '../src/modules/presence.js'
import { consciousnessBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const now = new Date(2026, 10, 2, 15, 0, 0)
const mins = (n) => n * 60000
const hours = (n) => n * 3600000
const days = (n) => n * 86400000

// ---- 措辞：宁粗不编精确数字
{
  const cases = [
    [mins(0.2), '几秒前'],
    [mins(1), '一两分钟前'],
    [mins(5), '刚才'],
    [mins(45), '不到一小时前'],
    [hours(5), '今天早些时候'],
    [hours(30), '昨天'],
    [days(3), '三天前'],
    [days(6), '六天前'],
    [days(10), '一个多星期前'],
    [days(20), '半个多月前'],
    [days(60), '一两个月前'],
    [days(200), '好久以前'],
  ]
  for (const [ms, want] of cases) {
    const got = describeGap(ms, now)
    check('间隔 ' + ms + ' → ' + want, got.includes(want), got)
  }
  check('负数当刚才', describeGap(-1000, now).includes('刚才'))
  check('跨日不算今天', describeGap(hours(20), now).includes('昨天') || describeGap(hours(20), now).includes('今天'),
    describeGap(hours(20), now))
}

// ---- 时段
{
  const at = (h) => new Date(2026, 10, 2, h, 0, 0)
  check('凌晨算夜里', partOfDay(at(3)) === '还在夜里')
  check('早上', partOfDay(at(8)) === '早上')
  check('下午', partOfDay(at(15)) === '下午')
  check('快到半夜', partOfDay(at(23)) === '快到半夜')
}

// ---- 没有对话：不瞎说
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(w.aid)
    check('空库读不到上一句', lastTurnOf(w.db, w.aid) === null)
    const p = presenceLine(w.db, w.aid)
    check('空库说没说过话', p.line.includes('还没跟他说过话'), p.line)
    check('空库也给时段', p.line.startsWith('现在：'), p.line)
  } finally { w.close() }
}

// ---- 三天前她说的 / 你說的
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(w.aid)
    const at = new Date(Date.now() - days(3)).toISOString()
    w.db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
      .run('cht_a', w.aid, 'agent', '嗯，我在听。', '[]', null, at, 'ui:sess-eval')
    const p = presenceLine(w.db, w.aid)
    check('三天前认得出', p.phrase.includes('三天前'), p.phrase)
    check('她说的标成「我上一句」', p.line.includes('我上一句说的是「嗯，我在听'), p.line)
    const block = consciousnessBlock(w.db, w.aid)
    check('注入里带着时间距离', block.includes('三天前'), block.slice(0, 120))

    // 换成你说的那句
    w.db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(w.aid)
    w.db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
      .run('cht_b', w.aid, 'user', '我先去忙', '[]', null, at, 'ui:sess-eval')
    const p2 = presenceLine(w.db, w.aid)
    check('你说的标成「你上一句」', p2.line.includes('你上一句说的是「我先去忙'), p2.line)
  } finally { w.close() }
}

// ---- 刚刚说过：不装陌生
{
  const w = makeWorld()
  try {
    w.db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
      .run('cht_c', w.aid, 'agent', '在。', '[]', null, new Date(Date.now() - 120000).toISOString(), 'ui:sess-eval')
    const p = presenceLine(w.db, w.aid)
    check('两分钟前算刚才', p.phrase.includes('刚才'), p.phrase)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
