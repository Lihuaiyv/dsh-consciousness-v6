/**
 * 冲突兜底句：不替我说话，而且一条只浮一次。
 * 运行：node test/conflict-surface.test.mjs
 *
 * 11-08 现场：库里挂着一条 open 冲突，问句没排上，于是每轮都在开头塞
 * 「（你注意到一处对不上：…）」——第一人称，像我自己在纠结；连着两个会话都在念。
 * 现在：第三人称说清这是库里的记录；只浮一次；已经排过问句的压根不走这条兜底。
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { consciousnessBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const MARK = '记忆库里挂着一条没结的冲突'
const OLD = '我好像没有get到哎'
const NEW = '哦，我我好像能get到了'

function world() {
  const w = makeWorld()
  w.db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,evidence)
    VALUES(?,?,?,?, 'open', ?, 'high', 'polarity', ?)`)
    .run('cfl_surf', w.aid, 'm_a', 'm_b', iso(60000), JSON.stringify({ a_text: OLD, b_text: NEW, similarity: 0.618 }))
  return w
}

// ---- 1. 浮上来的是「库里的记录」，不是「你注意到」
{
  const w = world()
  try {
    const t1 = consciousnessBlock(w.db, w.aid)
    check('兜底句还在（不然又会沉回库里）', t1.includes(MARK), t1.slice(0, 200))
    check('不是第一人称替我说', !t1.includes('你注意到') && !t1.includes('如果自然'), t1.includes('你注意到'))
    check('两句原话都摆出来', t1.includes(OLD) && t1.includes(NEW))

    const t2 = consciousnessBlock(w.db, w.aid)
    check('同一条只浮一次', !t2.includes(MARK), t2.includes(MARK))
  } finally { w.close() }
}

// ---- 2. 已经排过问句的：交给主动消息那条线，这里一句不提（不管是待发还是发过）
{
  const w = world()
  try {
    w.db.prepare("INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)")
      .run('prc_q', w.aid, '你先前说「…」，可后来又说「…」——到底哪个才是现在的呀？', 'conflict:cfl_surf', 'R', 'delivered', iso(3600000), iso(3000000))
    const t = consciousnessBlock(w.db, w.aid)
    check('问句发过之后不再兜底（一天后也不念）', !t.includes(MARK), t.slice(0, 200))
  } finally { w.close() }
}

// ---- 3. 结案了就不提
{
  const w = makeWorld()
  try {
    w.db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,evidence)
      VALUES(?,?,?,?, 'resolved', ?, ?)`)
      .run('cfl_done', w.aid, 'm_c', 'm_d', iso(60000), JSON.stringify({ a_text: OLD, b_text: NEW }))
    const t = consciousnessBlock(w.db, w.aid)
    check('结案的冲突不浮', !t.includes(MARK), t.slice(0, 200))
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
