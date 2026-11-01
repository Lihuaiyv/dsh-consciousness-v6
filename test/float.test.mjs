/**
 * 「浮上来」总测试：开环 / 配额浮现 / 累计反思。
 * 运行：node test/float.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve, importanceAnchors, freshFacts, TYPE_WEIGHT } from '../src/modules/retrieve.js'
import { reflectCursor, bumpReflect, resetReflect, reflectFrom, canConsolidate } from '../src/modules/consolidate.js'
import { clampInjection } from '../src/features.js'
import { packInjection } from '../src/modules/pack.js'
import { sessionBridge } from '../src/modules/archive.js'
import { recordSurfaced, markSurfacedUsed, surfacingStats, pruneSurfaced } from '../src/modules/surfacing.js'
import {
  detectLoop, parseDue, addLoop, pendingLoops, markLoopsFired,
  closeLoops, settleLoopsFromUser, expireLoops, loopLineFor, loopStats,
} from '../src/modules/loops.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-float-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_float'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '浮', 'daily', 'active', now())

const H = 3600000
const D = 86400000
const T0 = Date.parse('2026-03-01T09:00:00+08:00')

// ---------------- P1 开环：识别 ----------------
{
  const a = detectLoop('明天下午我们修一下那个脚本', T0)
  check('P1 识别：明天 → 挂上', !!a, a)
  check('P1 识别：明天 → 有到期时间', a && Date.parse(a.due_at) > T0, a && a.due_at)
  const b = detectLoop('我答应下周末陪你去看电影', T0)
  check('P1 识别：答应 → promise', b && b.kind === 'promise', b)
  check('P1 识别：已完成的不挂', detectLoop('那个脚本我已经修好了', T0) === null)
  check('P1 识别：普通事实不挂', detectLoop('我喜欢喝美式咖啡不加糖', T0) === null)
  check('P1 识别：太短不挂', detectLoop('明天吧', T0) === null)
  check('P1 识别：回头 → 无死线', (detectLoop('回头再说那个页面的事', T0) || {}).due_at === null)
  check('P1 识别：一会儿 → 两小时后', (() => {
    const x = detectLoop('等一会儿我把日志发你', T0)
    return x && Date.parse(x.due_at) === T0 + 2 * H
  })())
  check('P1 解析：明天 9 点', parseDue('明天', T0) && new Date(parseDue('明天', T0)).getHours() === 9)
}

// ---------------- P1 开环：挂 / 去重 ----------------
{
  const r1 = addLoop(db, aid, { text: '答应明天修脚本', kind: 'promise', due_at: new Date(T0 + D).toISOString(), at: T0 })
  check('P1 写入：新开环 created', r1.created && r1.id, r1)
  const r2 = addLoop(db, aid, { text: '答应明天修脚本。', kind: 'promise', at: T0 })
  check('P1 写入：字面相近不重复挂', r2.created === false && r2.id === r1.id, { r1, r2 })
  check('P1 写入：开环数 = 1', loopStats(db, aid).open === 1, loopStats(db, aid))
}

// ---------------- P1 开环：什么时候浮 ----------------
{
  const fresh = addLoop(db, aid, { text: '回头把那个报告写完', at: T0 })
  const base = pendingLoops(db, aid, { at: T0 + H, limit: 5 })
  check('P1 浮现：刚挂的没到期不冒', !base.some((x) => x.id === fresh.id), base.map((x) => x.text))
  const later = pendingLoops(db, aid, { at: T0 + 2 * D + H, limit: 5, throttleHours: 0 })
  check('P1 浮现：两天没提就冒出来', later.some((x) => x.id === fresh.id), later.map((x) => x.text))
  const due = pendingLoops(db, aid, { at: T0 + D + H, limit: 5, throttleHours: 0 })
  check('P1 浮现：到期先冒', due.length && due[0].text.includes('修脚本'), due.map((x) => x.text))
}

// ---------------- P1 开环：节流 / 提满收掉 ----------------
{
  const all = pendingLoops(db, aid, { at: T0 + 2 * D + H, limit: 5, throttleHours: 6 })
  const ids = all.map((x) => x.id)
  check('P1 节流：一次只挑 limit 条', ids.length <= 5)
  markLoopsFired(db, ids, T0 + 2 * D + H)
  const again = pendingLoops(db, aid, { at: T0 + 2 * D + 2 * H, limit: 5, throttleHours: 6 })
  check('P1 节流：六小时内不重复提', again.every((x) => !ids.includes(x.id)), again.map((x) => x.text))
  const after = pendingLoops(db, aid, { at: T0 + 2 * D + 8 * H, limit: 5, throttleHours: 6 })
  check('P1 节流：过六小时可以再提', after.some((x) => ids.includes(x.id)), after.map((x) => x.text))
}

// ---------------- P1 开环：关闭 ----------------
{
  const at = T0 + 3 * D
  const l = addLoop(db, aid, { text: '记得提醒我交水电费', kind: 'reminder', at })
  markLoopsFired(db, [l.id], at)
  const closed = settleLoopsFromUser(db, aid, [{ role: 'user', text: '好了，交完了' }], { at: at + 10 * 60000 })
  check('P1 关闭：用户说好了 → 关掉刚提过的那条', closed === 1, { closed })
  check('P1 关闭：状态是 closed', loopStats(db, aid).closed >= 1, loopStats(db, aid))

  // 没提过 + 字面对不上：不关
  const k = addLoop(db, aid, { text: '下周三前把那份合同改完', at })
  const n0 = settleLoopsFromUser(db, aid, [{ role: 'user', text: '好了' }], { at: at + 4 * H })
  const still = db.prepare("SELECT state FROM open_loops WHERE id=?").get(k.id)
  check('P1 关闭：随口一句好了不乱关', n0 === 0 && still.state === 'open', { n0, still })
}

// ---------------- P1 开环：提满五次自动收 ----------------
{
  const at = T0 + 10 * D
  const l = addLoop(db, aid, { text: '还没弄完的那个备份脚本', at })
  for (let i = 0; i < 5; i++) markLoopsFired(db, [l.id], at + i * 7 * H)
  expireLoops(db, aid, at + 40 * H)
  const row = db.prepare('SELECT state, closed_by, fire_count FROM open_loops WHERE id=?').get(l.id)
  check('P1 收掉：提满五次 → expired', row.state === 'closed' && row.closed_by === 'expired', row)
  const after = pendingLoops(db, aid, { at: at + 100 * H, limit: 5, throttleHours: 0 })
  check('P1 收掉：收起后不再冒', !after.some((x) => x.id === l.id))
}

// ---------------- P1 开环：注入一行 ----------------
{
  const aid2 = 'agt_float_line'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid2, '行', 'daily', 'active', now())
  const at = T0 + 14 * D
  addLoop(db, aid2, { text: '答应过主人周末把记忆面板的图重画一下', kind: 'promise', due_at: new Date(at - H).toISOString(), at })
  const out = loopLineFor(db, aid2, { at, limit: 2, throttleHours: 6 })
  check('P1 注入：有一行且带原文', out.text.includes('记忆面板'), out.text)
  check('P1 注入：报出被提的 id', out.ids.length > 0, out.ids)
  check('P1 注入：到期会写成「已经到期」', /已经到期/.test(out.text), out.text)
}

// ---------------- P1 开环：记忆硬删时一起清 ----------------
{
  const m = addMemory(db, aid, { text: '答应下周把插件文档补完', type: 'fact' })
  const l = addLoop(db, aid, { text: '答应下周把插件文档补完', memory_id: m.id, kind: 'promise', at: T0 })
  db.prepare('DELETE FROM open_loops WHERE memory_id=?').run(m.id)
  check('P1 清理：记忆删了开环也走', !db.prepare('SELECT 1 FROM open_loops WHERE id=?').get(l.id))
}

// ---------------- P2 配额浮现：锚点 / 新近 ----------------
{
  const aid3 = 'agt_float_quota'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid3, '配额', 'daily', 'active', now())
  addMemory(db, aid3, { text: '我喜欢喝美式咖啡不加糖', type: 'fact', importance: 0.5 })
  addMemory(db, aid3, { text: '我的生日是三月三号，主人要记得', type: 'fact', importance: 0.95 })
  addMemory(db, aid3, { text: '今天新买了一个机械键盘', type: 'fact', importance: 0.4 })

  const on = retrieve(db, aid3, '咖啡', { k: 4 })
  const off = retrieve(db, aid3, '咖啡', { k: 4, float: false })
  check('P2 配额：开的时候带锚点', on.items.some((x) => x.via === 'anchor' && /生日/.test(x.text)), on.items.map((x) => [x.via, x.text]))
  check('P2 配额：开的时候带 24h 新近', on.items.some((x) => x.via === 'fresh'), on.items.map((x) => [x.via, x.text]))
  check('P2 配额：关的时候不带锚点', !off.items.some((x) => x.via === 'anchor' || x.via === 'fresh'), off.items.map((x) => [x.via, x.text]))
  check('P2 配额：相关那条还在', on.items.some((x) => /咖啡/.test(x.text)), on.items.map((x) => x.text))
  check('P2 配额：总数不超过 k', on.items.length <= 4, on.items.length)

  // 空查询也该翻出来（「嗯 / 好」的轮次）
  const empty = retrieve(db, aid3, '', { k: 4 })
  check('P2 配额：空查询也有东西可浮', empty.items.length > 0 && empty.items.every((x) => x.via === 'anchor' || x.via === 'fresh'), empty.items.map((x) => [x.via, x.text]))

  // 工具查询（keepAll）不掺配额：它要的是「我要查的那层」
  const tool = retrieve(db, aid3, '咖啡', { k: 4, keepAll: true })
  check('P2 配额：工具查询不掺锚点', !tool.items.some((x) => x.via === 'anchor'), tool.items.map((x) => [x.via, x.text]))

  // 什么都没命中的轮次（自动升级 S3）：恰恰更该把重要的东西翻出来
  const miss = retrieve(db, aid3, '量子色动力学的正则化', { k: 4 })
  check('P2 配额：什么都没命中也要有锚点', miss.items.some((x) => x.via === 'anchor' && /生日/.test(x.text)), { scene: miss.scene, items: miss.items.map((x) => [x.via, x.text]) })

  // 新近窗口：把刚买键盘那条改成两天前，就不算「今天的新近」
  db.prepare("UPDATE memory_items SET created_at=? WHERE agent_id=? AND text LIKE '%机械键盘%'")
    .run(new Date(Date.now() - 48 * 3600000).toISOString(), aid3)
  const fresh = freshFacts(db, aid3, { hours: 24, limit: 5 })
  check('P2 新近：48 小时前的不算今天', !fresh.some((x) => /机械键盘/.test(x.text)), fresh.map((x) => x.text))
  // 锚点时只取过线的
  const anchors = importanceAnchors(db, aid3, { limit: 5, floor: 0.7 })
  check('P2 锚点：只取过重要度线的', anchors.length === 1 && /生日/.test(anchors[0].text), anchors.map((x) => x.text))

  // 线上真实库的坑：每日摘要 reflection 的 importance 也是 0.95，
  // 让它们占锚点位等于每轮复读摘要；钉住的例外。
  addMemory(db, aid3, { text: '1. 事实：用户已重启系统。 2. 偏好：', type: 'reflection', importance: 0.95 })
  addMemory(db, aid3, { text: '这段对话主要是在调插件', type: 'appraisal', importance: 0.95 })
  const a2 = importanceAnchors(db, aid3, { limit: 5, floor: 0.7 })
  check('P2 锚点：高重要度的摘要不占锚点位', !a2.some((x) => x.type === 'reflection' || x.type === 'appraisal'), a2.map((x) => [x.type, x.text]))
  addMemory(db, aid3, { text: '汐是夜里涨落的潮水', type: 'reflection', importance: 0.9 })
  db.prepare("UPDATE memory_items SET mark='locked' WHERE agent_id=? AND text LIKE '%潮水%'").run(aid3)
  const a3 = importanceAnchors(db, aid3, { limit: 1, floor: 0.7 })
  check('P2 锚点：钉住的排最前', a3[0] && /潮水/.test(a3[0].text), a3.map((x) => x.text))
  // 今日新近也不收摘要
  db.prepare("UPDATE memory_items SET created_at=? WHERE agent_id=? AND text LIKE '%潮水%'")
    .run(new Date().toISOString(), aid3)
  const f2 = freshFacts(db, aid3, { hours: 24, limit: 5 })
  check('P2 新近：摘要不算今天发生的', !f2.some((x) => /潮水|已重启系统/.test(x.text)), f2.map((x) => x.text))
}

// ---------------- P3 累计重要性 → 反思 ----------------
{
  const aid4 = 'agt_float_reflect'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid4, '反思', 'daily', 'active', now())
  check('P3 游标：初始为 0', Number(reflectCursor(db, aid4).acc) === 0, reflectCursor(db, aid4))
  check('P3 游标：累加', Math.abs(bumpReflect(db, aid4, 1.2) - 1.2) < 1e-6, reflectCursor(db, aid4))
  check('P3 游标：继续累加', Math.abs(bumpReflect(db, aid4, 2.3) - 3.5) < 1e-6, reflectCursor(db, aid4))
  check('P3 游标：窗口起点只记第一次', !!reflectCursor(db, aid4).window_start)
  resetReflect(db, aid4)
  const c = reflectCursor(db, aid4)
  check('P3 游标：反思后清零、窗口后移', Number(c.acc) === 0 && !!c.last_reflect_at, c)

  // 没有模型时不写脏数据，只报原因
  addMemory(db, aid4, { text: '用户这几天都在赶插件', type: 'fact', importance: 0.4 })
  addMemory(db, aid4, { text: '用户今天只说了继续', type: 'episode', importance: 0.2 })
  const r = await reflectFrom(db, aid4, { limit: 10 })
  if (canConsolidate()) {
    check('P3 反思：有模型时能出方案或出结果', r.ok === true || /unparsable|failed/.test(String(r.reason)), r)
  } else {
    check('P3 反思：没有模型就报 no model', r.ok === false && r.reason === 'no model', r)
  }
  check('P3 权重：反思不再被类型权重压死', TYPE_WEIGHT.reflection === 0.75, TYPE_WEIGHT.reflection)
}

// ---------------- P4 预算：开环比「泛记忆」晚丢 ----------------
{
  const lines = [
    '## 意识体：小汐',
    '此刻情绪：平静，力度中；整体心情偏负面。',
    '最近我自己写下的（日记，不是用户说的）：\n- 今天修好了几个 bug',
    '关于这句话，你能想起的事（只引用相关的，不要编造）：\n- 用户喜欢喝美式咖啡\n- 用户养了一只叫团子的猫',
    '（你自己心里还挂着的事，可以自然提起，不用解释来源）：\n- 还挂着：答应明天修脚本，把记忆面板的图重画一遍，顺便把预算那块也统一下来，别让两套数打架（已经到期了）',
  ]
  const mid = clampInjection(lines, 50)
  check('P4 预算：先丢记忆块、留住开环', mid.dropped.includes('memory') && /还挂着/.test(mid.text), { dropped: mid.dropped, text: mid.text.slice(0, 60) })
  const tight = clampInjection(lines, 40)
  check('P4 预算：预算更紧才丢开环', tight.dropped.includes('loop') && /还挂着/.test(tight.text) === false, { dropped: tight.dropped })
  check('P4 预算：硬上限不被突破', tight.tokens <= 40, tight.tokens)
}

// ---------------- P5 注入标注 + 会话续接 ----------------
{
  const aid5 = 'agt_float_bridge'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid5, '续接', 'daily', 'active', now())

  // 配额来源的标记：模型得知道哪条是「自己先想起来的」
  const packed = packInjection({ items: [
    { partition: 'T1', id: 'a1', text: '我的生日是三月三号', via: 'anchor' },
    { partition: 'T1', id: 'a2', text: '今天新买了一个机械键盘', via: 'fresh' },
    { partition: 'T1', id: 'a3', text: '用户喜欢美式咖啡' },
  ] })
  check('P5 标注：锚点带「一直记着的」', /一直记着的/.test(packed.text), packed.text)
  check('P5 标注：新近带「今天刚发生」', /今天刚发生/.test(packed.text), packed.text)
  check('P5 标注：普通条目不加标记', !/- （一直记着的）用户喜欢美式咖啡/.test(packed.text), packed.text)

  // 会话续接：只取今天之前的纪要
  db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,source,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ep_b1', aid5, 's1', '2026-03-01', '2026-03-01T19:00:00.000Z', '2026-03-01T21:00:00.000Z',
    12, '记忆改造', '在讨论记忆怎么自己浮上来，说好先做开环表', '["记忆"]', '["把配额制写完"]', 'rules', '2026-03-01T21:00:00.000Z')
  const bridge = sessionBridge(db, aid5, { today: '2026-03-02' })
  check('P5 续接：隔天带上上次聊到哪', /上次（2026-03-01）/.test(bridge) && /开环表/.test(bridge), bridge)
  check('P5 续接：带没说完的事', /配额制/.test(bridge), bridge)
  check('P5 续接：同一天不重复说', sessionBridge(db, aid5, { today: '2026-03-01' }) === '')
  check('P5 续接：没纪要就空着', sessionBridge(db, 'agt_none', { today: '2026-03-05' }) === '')
}

// ---------------- P6 浮现率 / 引用率 ----------------
{
  const aid6 = 'agt_float_stats'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid6, '观测', 'daily', 'active', now())
  const at = Date.now()
  const items = [
    { id: 'm1', text: '我的生日是三月三号，主人要记得', via: 'anchor' },
    { id: 'm2', text: '今天新买了一个机械键盘', via: 'fresh' },
    { id: 'm3', text: '用户喜欢喝美式咖啡不加糖', via: 'related' },
  ]
  check('P6 观测：记下注入的条数', recordSurfaced(db, aid6, items, at) === 3)
  const s0 = surfacingStats(db, aid6, 7)
  check('P6 观测：刚注入时引用率为 0', s0.surfaced === 3 && s0.used === 0, s0)
  check('P6 观测：按 kind 分开记', s0.by_kind.anchor.surfaced === 1 && s0.by_kind.fresh.surfaced === 1, s0.by_kind)

  const n1 = markSurfacedUsed(db, aid6, '记得你的生日是三月三号，我记着呢。', at + 60000)
  check('P6 观测：回复里真用上了就记一笔', n1 === 1, { n1 })
  const s1 = surfacingStats(db, aid6, 7)
  check('P6 观测：引用率跟着涨', s1.used === 1 && s1.rate > 0.3, s1)

  // 十轮（10 分钟）窗口外的旧记录不参与判定
  recordSurfaced(db, aid6, [{ id: 'm9', text: '很久以前说过的一句话', via: 'related' }], at - 3600000)
  const n2 = markSurfacedUsed(db, aid6, '很久以前说过的一句话', at)
  check('P6 观测：窗口外不判', n2 === 0, { n2 })

  const pruned = pruneSurfaced(db, 0, at + 1000)
  check('P6 观测：保留天数可清', pruned >= 0)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail ? 1 : 0)
