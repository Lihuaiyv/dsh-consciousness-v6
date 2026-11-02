/**
 * G1-5：as-of 查询 + 冷库出证，设计文档 §6 的 18 个场景各一个夹具；
 * 另验：as-of 前后热度 / 命中数完全不变；关参数即不可用；单条历史；工具口。
 * 运行：node test/g1-5-asof.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RealDate = Date
let fakeNow = RealDate.parse('2026-03-01T09:00:00+08:00')
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(fakeNow); else super(...args) }
  static now() { return fakeNow }
}
globalThis.Date = FakeDate

const { openDb } = await import('../src/db.js')
const { writeParam } = await import('../src/kernel.js')
const { addMemory, softDelete, restoreMemory, resolveConflict } = await import('../src/modules/memory.js')
const { applyWrite } = await import('../src/modules/gate.js')
const { appendTurn } = await import('../src/modules/archive.js')
const { invalidateMemory, auditTimeline, eventsOf, backfillAgent } = await import('../src/modules/timeline.js')
const { retrieveAsOf, renderAsOf, memoryHistory, asOfSearch } = await import('../src/modules/asof.js')
const { purgeExpired } = await import('../src/core.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}

const D0 = fakeNow
const DAY = 86400000
const at = (d, h = 0) => new RealDate(D0 + d * DAY + h * 3600000).toISOString()
const goto = (d, h = 0) => { fakeNow = D0 + d * DAY + h * 3600000 }
const localDayRange = (iso) => {
  const t = new RealDate(iso)
  return { from: new RealDate(t.getFullYear(), t.getMonth(), t.getDate()).toISOString(), to: new RealDate(t.getFullYear(), t.getMonth(), t.getDate() + 1).toISOString() }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-g15-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_g15'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(aid, 'g15', 'daily', 'active', at(0))
const write = (cand) => addMemory(db, aid, { text: cand.text, type: 'fact', fact_key: cand.fact_key || null, source: 'extract', skipConflict: true, turn_id: cand.turn_id || null })
const gw = (text, o = {}) => applyWrite(db, aid, { text, ...o }, (c) => write({ ...c, fact_key: o.fact_key, turn_id: o.turn_id }))
const ask = (q, o) => retrieveAsOf(db, aid, q, { now: at(200), ...o })
const find = (v, sub) => (v.items || []).find((x) => String(x.text).includes(sub) || String(x.from_text || '').includes(sub))

// ---------------- 剧本 ----------------
goto(5); const coffeeA = gw('我喜欢喝美式咖啡，不加糖')
goto(6); const spicyA = gw('我喜欢吃辣的川菜')
goto(10); const swim = gw('每周二晚上去游泳', { fact_key: 'habit.swim' })
goto(20); const dog = addMemory(db, aid, { text: '以前养过一只狗', type: 'fact', source: 'extract' })
invalidateMemory(db, aid, dog.id, { clearValidAt: true, reason: 'past_fact' })
goto(40); const gtr = addMemory(db, aid, { text: '我在学弹吉他', type: 'fact', source: 'manual' })
goto(40, 1); softDelete(db, gtr.id)
goto(42); restoreMemory(db, gtr.id)
goto(43); const piano = addMemory(db, aid, { text: '我在学弹钢琴', type: 'fact', source: 'manual' })
goto(44); softDelete(db, piano.id)
goto(50); const up = gw('每周二和周四晚上去游泳', { fact_key: 'habit.swim' })
// #7 夜巡滞后：d70 22:00 说话，23:00 纪要蒸馏入库
goto(70, 13)
appendTurn(db, aid, { sessionId: 's70', role: 'user', text: '我开始养多肉植物了', at: at(70, 13), turnId: 't70' })
db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,created_at) VALUES(?,?,?,?,?,?,?)`)
  .run('ep70', aid, 's70', '2026-05-10', at(70, 13), at(70, 13.5), at(70, 14))
goto(70, 14)
const succ = addMemory(db, aid, { text: '我在养多肉植物', type: 'fact', source: 'episode', turn_id: 'ep70', payload: { episode_id: 'ep70' } })
// #12 取代链（走 addMemory 的同 key 取代；门控会把同 key 改成原地改写，那是 #5）
const addKey = (text, key, turn) => addMemory(db, aid, { text, type: 'fact', fact_key: key, source: 'manual', skipConflict: true, turn_id: turn || null })
goto(80); const homeA = addKey('我住在杭州', 'home')
goto(90); const homeB = addKey('我住在上海', 'home')
goto(100); const homeC = addKey('我住在北京', 'home')
// #8 跨零点：本地 00:30 说话，01:00 入库
const midnight = new RealDate(2026, 5, 15, 0, 30)
fakeNow = +midnight
appendTurn(db, aid, { sessionId: 's615', role: 'user', text: '我在学做饭', at: midnight.toISOString(), turnId: 't615' })
fakeNow = +midnight + 30 * 60000
const cook = addMemory(db, aid, { text: '我在学做饭', type: 'fact', source: 'extract', turn_id: 't615' })
// #13 取代者说话更早
goto(109); appendTurn(db, aid, { sessionId: 's109', role: 'user', text: '我在一家书店上班', at: at(109), turnId: 't109' })
goto(110); const jobA = addKey('我在一家咖啡馆上班', 'job')
goto(111); const jobB = addKey('我在一家书店上班', 'job', 't109')
// #1–#4
goto(120); const coffeeB = gw('我现在不喜欢喝美式咖啡了，改喝手冲')
goto(121); const spicyB = gw('我不喜欢吃辣的川菜')
goto(130)
resolveConflict(db, aid, coffeeB.conflict_id, { keep: 'b' })
resolveConflict(db, aid, spicyB.conflict_id, { keep: 'a' })
// #18 老数据：一条没有时效索引的记忆，补录
goto(140); const old = addMemory(db, aid, { text: '我喜欢看科幻电影', type: 'fact', source: 'manual' })
db.prepare('DELETE FROM memory_timeline WHERE memory_id=?').run(old.id)
backfillAgent(db, aid)
goto(200)

check('剧本：冲突都开了', coffeeB.action === 'conflict' && spicyB.action === 'conflict', { coffeeB, spicyB })
check('剧本：改写走 update', up.action === 'update', up)
check('剧本：取代链三条不同记忆', new Set([homeA.id, homeB.id, homeC.id]).size === 3 && jobA.id !== jobB.id)

// 热度快照（as-of 之后必须一模一样）
const snap = () => JSON.stringify(db.prepare('SELECT id,hits,last_hit_at,heat,band,temp_state,weight FROM memory_items ORDER BY id').all())
const heatBefore = snap()

// #1 d60：A 当时有效
{
  const v = ask('咖啡', { at: at(60) })
  const a = find(v, '美式咖啡，不加糖')
  check('#1 d60 美式当时有效', a && a.label === 'valid', v.items)
  check('#1 d60 没有手冲', !find(v, '手冲'), v.items)
  check('#1 现在：已改口', a && /已改口为「我现在不喜欢喝美式咖啡了/.test(a.now || ''), a)
}
// #2 d121：B 有效，A 有争议
{
  const v = ask('咖啡', { at: at(121) })
  const b = find(v, '手冲')
  const a = find(v, '美式咖啡，不加糖')
  check('#2 d121 手冲有效且标争议', b && b.label === 'valid' && b.disputed, b)
  check('#2 d121 美式「当时有争议」', a && a.label === 'disputed', a)
}
// #3 结案保留新
{
  const v1 = ask('咖啡', { at: at(125) })
  check('#3 d125 美式仍有争议', find(v1, '美式咖啡，不加糖')?.label === 'disputed', v1.items)
  const v2 = ask('咖啡', { at: at(131) })
  check('#3 d131 只有手冲', !find(v2, '美式咖啡，不加糖') && find(v2, '手冲')?.label === 'valid', v2.items)
}
// #4 结案保留旧
{
  const v1 = ask('川菜', { at: at(125) })
  check('#4 d125 不吃辣有效、吃辣有争议', find(v1, '不喜欢吃辣')?.label === 'valid' && find(v1, '我喜欢吃辣')?.label === 'disputed', v1.items)
  const v2 = ask('川菜', { at: at(131) })
  check('#4 d131 吃辣有效、不吃辣不在', find(v2, '我喜欢吃辣')?.label === 'valid' && !find(v2, '不喜欢吃辣'), v2.items)
}
// #5 原地改写
{
  const a = ask('游泳', { at: at(30) })
  check('#5 d30 每周二（旧句）', find(a, '每周二晚上去游泳')?.text === '每周二晚上去游泳', a.items)
  check('#5 d30 现在：二四', /每周二和周四/.test(find(a, '每周二晚上去游泳')?.now || ''), a.items)
  const b = ask('游泳', { at: at(60) })
  check('#5 d60 二四（现行）', b.items[0] && b.items[0].text === '每周二和周四晚上去游泳' && !b.items[0].now, b.items)
  const c = ask('游泳', { from: at(40), to: at(55) })
  const it = c.items[0]
  check('#5 d40–55 期间改过 旧→新', it && it.label === 'revised' && it.from_text === '每周二晚上去游泳' && it.text === '每周二和周四晚上去游泳', c.items)
}
// #6 过去事实
{
  check('#6 d10 无', !find(ask('狗', { at: at(10) }), '狗'))
  const v = ask('狗', { at: at(30) })
  check('#6 d30 历史陈述', find(v, '养过一只狗')?.label === 'historical' && !find(v, '养过一只狗').now, v.items)
}
// #7 夜巡滞后：按纪要起点算到说话那天
{
  const ev = eventsOf(db, aid, succ.id)[0]
  check('#7 valid_from = 纪要起点', ev.valid_from === at(70, 13), ev)
  const r = localDayRange(at(70, 13))
  const v = ask('多肉', r)
  check('#7 「那天」命中', !!find(v, '多肉'), v)
}
// #8 跨零点
{
  const v = ask('2026年6月15日学做饭')
  check('#8 「6月15日」命中', !!find(v, '做饭'), v)
  const v2 = ask('2026年6月14日学做饭')
  check('#8 「6月14日」不命中', !find(v2, '做饭'), v2.items)
  check('#8 原话在窗口内', find(v, '做饭')?.quotes?.[0]?.inWindow === true, find(v, '做饭'))
}
// #9 软删 / 恢复
{
  check('#9 恢复后 d41 照常显示', !!find(ask('吉他', { at: at(41) }), '吉他'))
  check('#9 未恢复的任何时间都不显示', !find(ask('钢琴', { at: at(43, 12) }), '钢琴'))
}
check('#1–#9 只读查询：热度 / 命中 / 温度完全不变', snap() === heatBefore)

// #10 硬删：主表、出生句、改写旧句、索引全无
{
  goto(201)
  const t = gw('每周六去爬山', { fact_key: 'habit.hike' })
  goto(202); gw('每周六和周日去爬山', { fact_key: 'habit.hike' })
  softDelete(db, t.id)
  db.prepare('UPDATE memory_items SET deleted_at=? WHERE id=?').run(at(190), t.id)
  purgeExpired(db)
  const pre = t.id + ':'
  check('#10 硬删后什么都不剩', !db.prepare('SELECT 1 FROM memory_items WHERE id=?').get(t.id)
    && db.prepare('SELECT COUNT(*) n FROM fact_archive WHERE memory_id=? OR substr(memory_id,1,?)=?').get(t.id, pre.length, pre).n === 0
    && eventsOf(db, aid, t.id).length === 0)
  goto(200)
}
// #11 同毫秒两次改写
{
  goto(203)
  const t = gw('每周三去打羽毛球', { fact_key: 'habit.badminton' })
  gw('每周三和周五去打羽毛球', { fact_key: 'habit.badminton' })
  gw('每周三周五周日去打羽毛球', { fact_key: 'habit.badminton' })
  const h = memoryHistory(db, aid, t.id)
  check('#11 同毫秒两次改写：三个版本都在', h && h.versions.length === 3 && h.versions[0].text === '每周三去打羽毛球' && h.versions[1].text === '每周三和周五去打羽毛球', h && h.versions)
  goto(200)
}
// #12 取代链
const heatMid = snap()
{
  check('#12 d85 杭州', find(ask('住在', { at: at(85) }), '杭州')?.label === 'valid')
  const v95 = ask('住在', { at: at(95) })
  check('#12 d95 上海，不含杭州', !!find(v95, '上海') && !find(v95, '杭州'), v95.items)
  const v105 = ask('住在', { at: at(105) })
  check('#12 d105 北京', !!find(v105, '北京') && !find(v105, '上海'), v105.items)
  const bAdd = eventsOf(db, aid, homeB.id).find((e) => e.op === 'ADD')
  const edge = ask('住在', { at: bAdd.valid_from })
  check('#12 交界时刻归 B', !!find(edge, '上海') && !find(edge, '杭州'), edge.items)
}
// #13 取代者说话更早：A 不倒挂、不冒出来
{
  const h = memoryHistory(db, aid, jobA.id)
  check('#13 A 无倒挂区间', h.active.every(([s, e]) => e == null || e >= s), h.active)
  const v = ask('上班', { at: at(110, 12) })
  check('#13 d110 中午只有书店', !!find(v, '书店') && !find(v, '咖啡馆'), v.items)
}
// #14 出生前
{
  const v = ask('2025年3月我喜欢什么')
  check('#14 出生前：空 + before_birth', v.ok && v.items.length === 0 && v.before_birth, v)
  check('#14 渲染「那时还没有任何记录」', /那时还没有任何记录/.test(renderAsOf(v)))
}
// #15 未来 / 今天
{
  const fut = ask('2027年我喜欢什么')
  check('#15 未来 → 不走 as-of', !fut.ok && (fut.reason === 'future' || fut.reason === 'no_time'), fut)
  check('#15 显式未来区间 → future', ask('咖啡', { from: at(300), to: at(310) }).reason === 'future')
  check('#15 今天 → no_time（走普通检索）', ask('今天我喜欢什么').reason === 'no_time')
}
check('#12–#15 只读查询：热度不变', snap() === heatMid)
// #16 冷 / 归档不影响
{
  db.prepare("UPDATE memory_items SET temp_state='archived' WHERE id=?").run(swim.id)
  check('#16 归档温度照常显示', !!find(ask('游泳', { at: at(30) }), '游泳'))
  db.prepare("UPDATE memory_items SET temp_state='warm' WHERE id=?").run(swim.id)
}
// #17 钩子漏写 → 对账后 as-of 反映
{
  db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(at(150), cook.id)
  auditTimeline(db, aid)
  const v = ask('做饭', { at: at(160) })
  check('#17 对账后 d160 学做饭已不在', !find(v, '做饭'), v.items)
  const v2 = ask('做饭', { at: at(140) })
  check('#17 对账前的 d140 仍在', !!find(v2, '做饭'), v2.items)
}
// #18 老数据补录 → 标近似
{
  const v = ask('科幻', { at: at(150) })
  const it = find(v, '科幻')
  check('#18 补录的条目标近似', it && it.approx, it)
  check('#18 渲染含「早期记录，时间为近似」', /早期记录，时间为近似/.test(renderAsOf(v)))
}

// 渲染
const heatTail = snap()
{
  const t = renderAsOf(ask('咖啡', { at: at(60) }))
  check('渲染：头部声明不代表现在', /那时的记忆，不代表现在/.test(t), t)
  check('渲染：标签 + 现在', /\[当时有效/.test(t) && /（现在：已改口为/.test(t), t)
  const r = renderAsOf(ask('游泳', { from: at(40), to: at(55) }))
  check('渲染：期间改过 旧 → 新', /\[期间改过[^\]]*\] 每周二晚上去游泳 → 每周二和周四晚上去游泳/.test(r), r)
}
// 单条历史
{
  const h = memoryHistory(db, aid, swim.id)
  check('history：两版', h.versions.length === 2 && h.versions[0].text === '每周二晚上去游泳' && h.versions[1].to === null, h.versions)
  check('history：软删的不给', memoryHistory(db, aid, piano.id) === null)
}
// recorded 轴：用入库时间（#7 那条：纪要 23:00 入库）
{
  const r = localDayRange(at(70, 13))
  const said = ask('多肉', { ...r, axis: 'said' })
  const rec = ask('多肉', { ...r, axis: 'recorded' })
  check('recorded 轴 since = 入库时间', find(rec, '多肉')?.since === at(70, 14) && find(said, '多肉')?.since === at(70, 13), { said: find(said, '多肉'), rec: find(rec, '多肉') })
}
// 工具口
{
  goto(200)
  const v = asOfSearch(db, aid, '咖啡', '2026-04-30')
  check('工具 as_of=日期', v.ok && !!find(v, '美式'), v)
  const n = asOfSearch(db, aid, '咖啡', '那时候')
  check('工具 as_of 无锚点 → no_time', !n.ok && n.reason === 'no_time')
}
check('渲染 / 历史 / 工具口：热度不变', snap() === heatTail)
// 回放日志 ASOF
check('回放日志记了 ASOF', db.prepare("SELECT COUNT(*) n FROM retrieval_log WHERE scene='ASOF'").get().n > 0)
// 关参数
{
  writeParam(db, aid, 'memory.asof', 'off')
  check('memory.asof=off → 不可用', ask('咖啡', { at: at(60) }).reason === 'off')
  writeParam(db, aid, 'memory.asof', 'on')
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
