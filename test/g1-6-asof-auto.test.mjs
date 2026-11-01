/**
 * G1-6：每轮注入的「那时」段（memory.asof.auto）。
 * 验：默认关 = 与改造前逐字一致；开了只在问句带过去时间时出；行带标签、不被按句号截；
 * 只读（热度 / 命中不变）；chatReply 端到端能带出来；memory.asof=off 时 auto 也不生效。
 * 运行：node test/g1-6-asof-auto.test.mjs
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
const { addMemory, resolveConflict } = await import('../src/modules/memory.js')
const { applyWrite } = await import('../src/modules/gate.js')
const { asofInjectItems, retrieveAsOf } = await import('../src/modules/asof.js')
const { packInjection } = await import('../src/modules/pack.js')
const { retrieve } = await import('../src/modules/retrieve.js')
const { chatReply } = await import('../src/features.js')
const { seedAffect } = await import('../src/modules/affect.js')

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-g16-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_g16'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(aid, 'g16', 'daily', 'active', at(0))
seedAffect(db, aid)
const write = (cand) => addMemory(db, aid, { text: cand.text, type: 'fact', fact_key: cand.fact_key || null, source: 'extract', skipConflict: true })
const gw = (text, o = {}) => applyWrite(db, aid, { text, ...o }, (c) => write({ ...c, fact_key: o.fact_key }))

goto(5); gw('我喜欢喝美式咖啡，不加糖')
goto(10); gw('每周二晚上去游泳', { fact_key: 'habit.swim' })
goto(50); gw('每周二和周四晚上去游泳', { fact_key: 'habit.swim' })
goto(120); const coffeeB = gw('我现在不喜欢喝美式咖啡了，改喝手冲')
goto(130); resolveConflict(db, aid, coffeeB.conflict_id, { keep: 'b' })
goto(200)

const snap = () => JSON.stringify(db.prepare('SELECT id,hits,last_hit_at,heat,band,temp_state,weight FROM memory_items ORDER BY id').all())
const asofLogs = () => db.prepare("SELECT COUNT(*) n FROM retrieval_log WHERE agent_id=? AND scene='ASOF'").get(aid).n

check('剧本：咖啡冲突开了', coffeeB.action === 'conflict', coffeeB)

// 1) 默认关：什么都不出，也不记 ASOF 日志
{
  const n0 = asofLogs()
  const o = asofInjectItems(db, aid, '半年前我喜欢喝什么咖啡')
  check('默认关：无条目', o.items.length === 0 && o.view === null, o)
  check('默认关：不写 ASOF 日志', asofLogs() === n0)
  const base = retrieve(db, aid, '半年前我喜欢喝什么咖啡', { k: 6 })
  const p0 = packInjection({ items: base.items }, { budget: 400 })
  check('默认关：注入文本里没有「那时」', !/那时·/.test(p0.text), p0.text)
}

writeParam(db, aid, 'memory.asof.auto', 'on', 'test')

// 2) 开了但问句没时间：不出
{
  const n0 = asofLogs()
  const o = asofInjectItems(db, aid, '我喜欢喝什么咖啡')
  check('无时间锚：无条目', o.items.length === 0 && o.view === null, o)
  check('无时间锚：不写 ASOF 日志（不白跑）', asofLogs() === n0)
  const o2 = asofInjectItems(db, aid, '之前说的那家咖啡店叫什么')
  check('「之前」不算时间锚', o2.items.length === 0, o2.items)
  const o3 = asofInjectItems(db, aid, '明天喝什么咖啡')
  check('将来时间：不出', o3.items.length === 0, o3.items)
}

// 3) 半年前（≈d17）：美式当时有效 + 现在已改口
const before = snap()
{
  const o = asofInjectItems(db, aid, '半年前我喜欢喝什么咖啡')
  const a = o.items.find((x) => x.text.includes('美式咖啡，不加糖'))
  check('半年前：出美式那条', !!a, o.items)
  check('半年前：条目是 T1 + asof 标记', a && a.partition === 'T1' && a.asof === true, a)
  check('半年前：带「那时·当时有效」标签', a && /那时·当时有效）/.test(a.text), a)
  check('半年前：带现在的改口', a && /（现在：已改口为「/.test(a.text), a)
  check('半年前：没有手冲（那时还没说）', !o.items.some((x) => x.text.includes('手冲') && !x.text.includes('现在：')), o.items)
  const p = packInjection({ items: o.items }, { budget: 400 })
  const line = p.lines.find((l) => l.text.includes('美式咖啡'))
  check('装箱：整行保留（不按逗号/句号截掉「现在」）', line && /现在：/.test(line.text), p.lines)
  check('装箱：在 T1 段', line && line.section === 'T1', line)
}
// 4) 两个月前（≈d140）：手冲当时有效
{
  const o = asofInjectItems(db, aid, '两个月前我喜欢喝什么咖啡')
  const b = o.items.find((x) => x.text.includes('手冲'))
  check('两个月前：手冲当时有效', b && /当时有效/.test(b.text), o.items)
  check('两个月前：手冲没有「现在」注（现在仍是它）', b && !/（现在：/.test(b.text), b)
}
// 5) 游泳：问 d50 前后都覆盖的范围 → 期间改过
{
  const o = asofInjectItems(db, aid, '五个月前我什么时候去游泳')
  const s = o.items.find((x) => x.text.includes('游泳'))
  check('五个月前：游泳出现', !!s, o.items)
  check('五个月前：游泳版本对（那时已是二四）或标改过', s && (/二和周四/.test(s.text) || /期间改过/.test(s.text)), s)
}
check('只读：前后热度 / 命中完全一致', snap() === before)

// 6) chatReply 端到端
{
  const r = await chatReply(db, aid, { text: '半年前我喜欢喝什么咖啡' })
  const hit = (r.pack || []).find((x) => x.asof && String(x.text).includes('美式'))
  check('chatReply：pack 带「那时」条目', !!hit, r.pack)
  check('chatReply：那时条目排在最前', r.pack && r.pack[0] && r.pack[0].asof === true, r.pack && r.pack[0])
  const r2 = await chatReply(db, aid, { text: '我喜欢喝什么咖啡' })
  check('chatReply：无时间锚不带', !(r2.pack || []).some((x) => x.asof), r2.pack)
}

// 6b) 回调没带 skipConflict（remember 工具 / 模拟器的写法）：同一次改口只能有一条冲突
{
  const raw = (text) => applyWrite(db, aid, { text }, (c) => addMemory(db, aid, { text: c.text, type: 'fact', source: 'remember', skipConflict: false }))
  goto(201); const a = raw('我喜欢吃辣的川菜')
  goto(202); const b = raw('我不喜欢吃辣的川菜')
  const n = db.prepare("SELECT COUNT(*) n FROM conflicts WHERE agent_id=? AND state='open' AND ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?))").get(aid, a.id, b.id, b.id, a.id).n
  check('改口：判成冲突', b.action === 'conflict', b)
  check('改口：同一对只挂一条待裁冲突（不双写）', n === 1, { n })
  check('改口：返回的 conflict_id 就是那一条', !!db.prepare("SELECT 1 FROM conflicts WHERE id=? AND state='open'").get(b.conflict_id), b)
  resolveConflict(db, aid, b.conflict_id, { keep: 'b' })
  // 模拟器里真实出现过的形状：两边都判 high、都开着
  goto(203); const c = raw('我喜欢喝绿茶，不加糖')
  goto(204); const e = raw('我现在不喜欢喝绿茶了，改喝红茶')
  const openCE = () => db.prepare("SELECT COUNT(*) n FROM conflicts WHERE agent_id=? AND state='open' AND ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?))").get(aid, c.id, e.id, e.id, c.id).n
  check('改口（高风险形状）：判成冲突', e.action === 'conflict', e)
  check('改口（高风险形状）：只挂一条', openCE() === 1, { n: openCE() })
  if (e.conflict_id) resolveConflict(db, aid, e.conflict_id, { keep: 'b' })
  check('改口（高风险形状）：裁决一次就清', openCE() === 0, { n: openCE() })
  check('改口：裁决后不留悬案', db.prepare("SELECT COUNT(*) n FROM conflicts WHERE agent_id=? AND state='open' AND (a_id IN (?,?) OR b_id IN (?,?))").get(aid, a.id, b.id, a.id, b.id).n === 0)
}

// 6c) 「此刻」点查询：at = 现在这一毫秒，不能被「不看未来」的截断压成空窗
{
  const v = retrieveAsOf(db, aid, '咖啡', { at: new Date().toISOString() })
  check('at=此刻：照样能答（窗口不为空）', v.ok && v.items.some((x) => x.text.includes('手冲')), v.items)
}

// 7) 总开关关：auto 跟着失效
writeParam(db, aid, 'memory.asof', 'off', 'test')
{
  const o = asofInjectItems(db, aid, '半年前我喜欢喝什么咖啡')
  check('memory.asof=off：auto 不生效', o.items.length === 0, o)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
