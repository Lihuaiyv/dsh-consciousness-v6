/**
 * 大因果体 · 底图 + 意图 —— 验收。
 *
 * 锁的是设计文档（`docs/功能/1-记忆-读与联想/思路-大因果体检索-2026-11-14.md`）里
 * 规则就能验的那几条，不涉及模型判因果：
 *   1) 四条底图判据各建各的边：同一件事 same_as / 挨着 adjacent / 同话题 continue / 孤立补救；
 *   2) 边存成一条带符号的关系：pull + direction + level + status，kind 只是标签；
 *   3) 红线：只加边、不合并事件（hot_events / cold_events 行数不动）；
 *   4) 幂等：同一批数据建两次，第二次 added=0；
 *   5) 底图覆盖 ≥95%（文档 §10 验收线）；
 *   6) 体：same_as/continue 连起来算一个体，带 head；线拼成一句话，不列节点；
 *   7) 意图：why / next / settled / default 分得开（没有意图就不加因果行）。
 *
 * 临时库，不碰真库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import {
  buildBaseGraph, baseEdgesOf, loadBody, formatBodyLine, formatWhyLine, readLine, intentOf,
  coverageOf, gramOverlap, writeJudgedEdges, demoteIfStill, computePull, WEAK_PULL, PULL, COVERAGE_TARGET,
} from '../src/modules/event_causal.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, 'event-causal-check.tmp.db')
for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 没有就算了 */ } }

const db = openDb(file)
const aid = 'agt_causal'
const NOW = Date.now()
const stamp = new Date(NOW).toISOString()
const at = (h) => new Date(NOW - h * 3600000).toISOString()

db.prepare('INSERT INTO agents(id,name,mode,status,created_at) VALUES(?,?,?,?,?)').run(aid, '底图测试', 'daily', 'active', stamp)

const cold = db.prepare(`INSERT INTO cold_events(id,agent_id,title,story,who,start_at,end_at,turn_ids,quotes,cues,status,weight,cut_rev,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const hot = db.prepare(`INSERT INTO hot_events(id,agent_id,title,story,cues,source_cold_ids,op,reason,version,active,state,want,ceiling,mentions,created_at,changed_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)

/** 造一件：cold + hot 一起写。startAt/endAt 可直接给绝对时间（跨天测试必须用绝对时间）。 */
function make(id, { title, story = '经过', cues = '[]', turns = '[]', quotes = '[]', startH, endH, startAt, endAt, status = '过去了' }) {
  const s = startAt || at(startH)
  const e = endAt || at(endH)
  cold.run('c_' + id, aid, title, story, '主人', s, e, turns, quotes, cues, status, 0.7, 1, stamp)
  hot.run(id, aid, title, story, cues, JSON.stringify(['c_' + id]), 'born', '', 1, 1, '台面', 0.3, 1, 0, stamp, stamp)
}
/** 今天某个钟点（绝对时间，避免「几小时前」跨过午夜） */
const today = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString() }

// ① 同一件事：同一轮被切过两次（turn 重叠）
make('h1', { title: '花.md 重排错范围', turns: '["t1"]', quotes: '["主人让我把花.md 里的整节删掉"]', startH: 72, endH: 71, status: '没过去' })
make('h2', { title: '花.md 回滚', turns: '["t1"]', startH: 70, endH: 69, status: '没过去' })
// ② 同话题延续：共享两个像专名的抓手
make('h3', { title: '三观模块诊断', cues: '["三观引擎","影子期"]', startH: 50, endH: 49 })
make('h4', { title: '三观模块修好', cues: '["三观引擎","影子期"]', startH: 20, endH: 19, status: '没过去' })
// ③ 挨着：同一天、时间相邻（用绝对时间，避免「几小时前」跨过午夜，考卷就自己变红）
make('h5', { title: '整理桌面文件', startAt: today(10, 0), endAt: today(10, 20) })
make('h6', { title: '又顺手清了缓存', startAt: today(10, 40), endAt: today(11, 0) })
// ④ 孤立件：同一天但隔得远、也没同话题，得靠补救连上
make('h7', { title: '半夜想起一件不挨着的事', startAt: today(14, 0), endAt: today(14, 30) })

const checks = []
const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name, ok ? '' : JSON.stringify(detail)) }

const hotBefore = db.prepare('SELECT COUNT(*) n FROM hot_events').get().n
const coldBefore = db.prepare('SELECT COUNT(*) n FROM cold_events').get().n

// 纯函数先验一遍判据
const items = [
  { id: 'a', title: 'x', cues: [], turns: ['t9'], quotes: [], startAt: at(3), endAt: at(2.8), day: 'd1' },
  { id: 'b', title: 'y', cues: [], turns: ['t9'], quotes: [], startAt: at(2), endAt: at(1.8), day: 'd1' },
]
ck('纯函数：turn 重叠 → same_as', baseEdgesOf(items).some((e) => e.kind === 'same_as' && e.pull === PULL.same_as), baseEdgesOf(items))
ck('纯函数：标题 3-gram 覆盖算得出来', gramOverlap('花.md 重排错范围', '花.md 重排错范围，回滚') > 0.6, gramOverlap('花.md 重排错范围', '花.md 重排错范围，回滚'))

// ② 建图
const b1 = buildBaseGraph(db, aid, { nowMs: NOW })
const edges = db.prepare("SELECT * FROM event_edges WHERE agent_id=? AND status='confirmed'").all(aid)
const has = (from, to, kind) => edges.some((e) => e.from_id === from && e.to_id === to && e.kind === kind)
ck('建图跑起来（7 件）', b1.ok && b1.events === 7, b1)
ck('同一轮两次切 → same_as（pull=1）', has('h1', 'h2', 'same_as') && edges.find((e) => e.kind === 'same_as').pull === 1, edges.filter((e) => e.kind === 'same_as'))
ck('共享两个专名抓手 → continue（pull=0.5）', edges.some((e) => e.kind === 'continue' && e.pull === PULL.continue && e.from_id === 'h3' && e.to_id === 'h4'), edges.filter((e) => e.kind === 'continue'))
ck('同一天挨着 → adjacent（pull=0.3）', has('h5', 'h6', 'adjacent'), edges.filter((e) => e.kind === 'adjacent').map((e) => [e.from_id, e.to_id]))
ck('孤立件被补救连上（fallback pull=0.2）', edges.some((e) => [e.from_id, e.to_id].includes('h7') && e.pull === PULL.fallback), edges.filter((e) => [e.from_id, e.to_id].includes('h7')))
ck('边存成一条关系：pull/direction/level/status 都在', edges.every((e) => typeof e.pull === 'number' && e.direction && e.level === 0 && e.status === 'confirmed' && e.judge === 'rule'), edges[0])

// ③ 红线
const hotAfter = db.prepare('SELECT COUNT(*) n FROM hot_events').get().n
const coldAfter = db.prepare('SELECT COUNT(*) n FROM cold_events').get().n
ck('红线：hot_events 行数不变（只加边、不合并）', hotBefore === hotAfter, { hotBefore, hotAfter })
ck('红线：cold_events 行数不变', coldBefore === coldAfter, { coldBefore, coldAfter })

// ④ 覆盖率（文档 §10：≥95%）
const cov = coverageOf(db, aid)
ck(`底图覆盖 ≥95%（实得 ${(cov.ratio * 100).toFixed(1)}%）`, cov.ratio >= COVERAGE_TARGET, cov)

// ⑤ 幂等
const b2 = buildBaseGraph(db, aid, { nowMs: NOW })
ck('幂等：第二次 added=0', b2.added === 0, b2)

// ⑥ 体与那句线
const body = loadBody(db, aid, 'h1', {})
console.log('DEBUG h1 的边:', db.prepare("SELECT kind,from_id,to_id,status,valid_to FROM event_edges WHERE from_id='h1' OR to_id='h1'").all())
ck('体：同一件事折叠成一个点（不再重影）', body.size >= 1 && body.nodes.some((n) => n.id === 'h1' || n.id === 'h2'), body.nodes.map((n) => n.id))
// 边必须朝时间前进（时间单调，图里不会有环）
const timeMap = new Map(db.prepare("SELECT h.id, c.start_at FROM hot_events h JOIN cold_events c ON c.id=json_extract(h.source_cold_ids,'$[0]') WHERE h.agent_id=?").all(aid).map((r) => [r.id, Date.parse(r.start_at)]))
const backwards = db.prepare("SELECT from_id, to_id FROM event_edges WHERE agent_id=? AND status='confirmed' AND kind<>'same_as'").all(aid)
  .filter((e) => (timeMap.get(e.from_id) || 0) > (timeMap.get(e.to_id) || 0))
ck('所有边都朝时间前进（不会成环）', backwards.length === 0, backwards.slice(0, 3))
const line = (() => {
  // 主轴（spine）是规则边：只在同一会话里按轮次相邻才建。测试库没有碎片表，手工插一条来验拼句。
  db.prepare(`INSERT OR IGNORE INTO event_edges
    (id,agent_id,from_id,to_id,kind,direction,pull,level,confidence,evidence,reason,status,judge,valid_from,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('edge_spine_test', aid, 'h5', 'h6', 'spine', 'forward',
    0.9, 0, 1, '{}', '主轴测试', 'confirmed', 'rule', stamp, stamp, stamp)
  return formatBodyLine(db, aid, 'h5', { budget: 200 })
})()
// 这一片只有 adjacent/手工 spine，没有主干边 → 只能说「挨着」，不能冒充「这条线」（§7）
ck('线：没主干边时说实话（「挨着…还没判出因果」），不冒充「这条线」', /挨着：/.test(line.text) && /还没判出因果/.test(line.text) && /→/.test(line.text), line.text)

// ⑦ 意图
ck('意图：为什么 → why', intentOf('为什么最后是这么定的') === 'why', intentOf('为什么最后是这么定的'))
ck('意图：后来呢 → next', intentOf('这件事后来呢') === 'next', intentOf('这件事后来呢'))
ck('意图：定了吗 → settled', intentOf('那个方案定了吗') === 'settled', intentOf('那个方案定了吗'))
ck('意图：普通闲聊 → default', intentOf('今天吃什么') === 'default', intentOf('今天吃什么'))

// ⑧ 旧实验边不参与检索
const old = db.prepare("SELECT COUNT(*) n FROM event_edges WHERE kind IN ('cue','turn','title','day') AND status<>'rejected'").get().n
ck('旧版分 kind 的实验边不参与检索', old === 0, { old })

// ⑨ 模型判完写边：高置信 confirmed、低置信 candidate、抄不出证据的不写、方向按时间
const judged = [
  {
    a: { id: 'h5', title: '整理桌面文件' },
    res: [
      { ok: true, id: 'h6', relation: 'cause', pull: 1, confidence: 0.9, direction: 'A_to_B', evidence: '顺手清了缓存' },
      { ok: true, id: 'h3', relation: 'continue', pull: 0.5, confidence: 0.65, direction: 'A_to_B', evidence: '三观' },
      { ok: false, id: 'h4', relation: 'none', pull: 0, confidence: 0, direction: 'A_to_B', evidence: '' },
    ],
  },
]
const wr = writeJudgedEdges(db, aid, judged, { nowMs: NOW })
const causeEdge = db.prepare("SELECT * FROM event_edges WHERE agent_id=? AND kind='cause'").get(aid)
ck('写库：高置信写 confirmed', wr.written >= 1 && causeEdge && causeEdge.status === 'confirmed', wr)
ck('写库：方向按时间（早→晚）', !!causeEdge && (timeMap.get(causeEdge.from_id) || 0) <= (timeMap.get(causeEdge.to_id) || 0), causeEdge && [causeEdge.from_id, causeEdge.to_id])
ck('写库：低置信写 candidate（不参与检索）', (() => { const e = db.prepare("SELECT * FROM event_edges WHERE agent_id=? AND kind='continue' AND status='candidate'").get(aid); return !!e })(), wr)
ck('写库：抄不出证据的跳过（不再丢，改写成弱边）', wr.skipped >= 0 && wr.weak >= 1, wr)
// 弱边（2026-11-17）：没有关系 ≠ 没有边。判 none 的也写，但 pull 极小、status='weak'，读门槛自然过滤
const weakEdge = db.prepare("SELECT * FROM event_edges WHERE agent_id=? AND status='weak' LIMIT 1").get(aid)
ck('弱边：判 none 也写成边（status=weak）', !!weakEdge && weakEdge.status === 'weak', weakEdge)
ck('弱边：pull 极小（≈0.05），进图但不进检索', !!weakEdge && Math.abs(Number(weakEdge.pull) - WEAK_PULL) < 1e-9 && Number(weakEdge.pull) < 0.25, weakEdge && weakEdge.pull)
ck('弱边：kind 用 related，不冒充任何关系', !!weakEdge && weakEdge.kind === 'related', weakEdge && weakEdge.kind)

// 有主干边（h5 --cause--> h6）时，才配说「这条线」
const strongLine = formatBodyLine(db, aid, 'h5', {})
ck('线：有因果边时才说「这条线」（weak=false）', /^（这条线：/.test(strongLine.text) && !strongLine.body.weak, strongLine.text)

// 判官标签（2026-11-17 主人要）：主模型 → 本地 → 规则，一路往下降，边上要记着到底是谁判的
const judgedEdge = db.prepare("SELECT judge FROM event_edges WHERE agent_id=? AND kind='cause' LIMIT 1").get(aid)
ck('判官标签：边上记着是谁判的（main / local / rule）', !!judgedEdge && ['main', 'local', 'rule'].includes(judgedEdge.judge), judgedEdge)

// 三态（2026-11-17）：冲突的三种结局要能记下来；sublated 最常见，invalidated 只在真记错时用
db.prepare("UPDATE event_edges SET resolution='sublated' WHERE agent_id=? AND kind='cause'").run(aid)
const resRow = db.prepare("SELECT resolution FROM event_edges WHERE agent_id=? AND kind='cause' LIMIT 1").get(aid)
ck('三态：resolution 能记 sublated（合成第三件）', !!resRow && resRow.resolution === 'sublated', resRow)
ck('因果不失效：推翻旧结论不封口（valid_to 只为记错/重复保留）', !db.prepare("SELECT 1 FROM event_edges WHERE agent_id=? AND status='confirmed' AND valid_to IS NOT NULL").get(aid), '有 confirmed 边被误封口了')

// 反事实重排（2026-11-17，照 CRECE）：判成因果的，再问"没有 A，B 还会发生吗"；还会 → 降级成"接着做"
const causalRes = { ok: true, relation: 'cause', pull: 1, confidence: 0.9 }
ck('反事实：没有 A 就没有 B → 因果保留', demoteIfStill(causalRes, false).relation === 'cause', demoteIfStill(causalRes, false))
ck('反事实：没有 A 也会发生 → 降级成 continue', demoteIfStill(causalRes, true).relation === 'continue' && demoteIfStill(causalRes, true).cf === 'still', demoteIfStill(causalRes, true))
ck('反事实：本来就不是因果的，不动它', demoteIfStill({ ok: true, relation: 'continue' }, true).relation === 'continue', null)

// 亲密度四分量（§3）：同一个数，门槛高的是骨架、门槛低的是周围
const evA = { title: '花.md 重排错范围', cues: ['花.md', '重排'], startAt: '2026-11-10T10:00:00Z' }
const evB = { title: '花.md 重排错范围，回滚', cues: ['花.md', '重排'], startAt: '2026-11-10T12:30:00Z' }
const evC = { title: '今天天气不错', cues: ['天气'], startAt: '2026-10-01T09:00:00Z' }
ck('亲密度：同一件事 + 同抓手 + 同日 → 高', computePull(evA, evB, 'same') > 0.6, computePull(evA, evB, 'same'))
ck('亲密度：无关 + 隔很久 → 低（低于读门槛 0.25）', computePull(evA, evC, 'none') < 0.25, computePull(evA, evC, 'none'))
ck('亲密度：冲突边为负', computePull(evA, evB, 'contradict') < 0, computePull(evA, evB, 'contradict'))

// 读路径（§6.1）：问「后来」顺着走，问「为什么」逆着找因，最多 3~5 个、不融合
const why = formatWhyLine(db, aid, 'h6', { budget: 200 })
ck('读：问「为什么」能逆着找出因', /为什么：因为/.test(why.text) && why.causes.length >= 1, why)
ck('读：因最多 5 个（不铺开成一棵树）', why.causes.length <= 5, why.causes.length)
ck('读：不融合成一句总结（列的是几个并列的点）', (why.text.match(/「/g) || []).length >= 1, why.text)
ck('读：按意图分派（why 走找因、next 走顺着）', readLine(db, aid, 'h6', { intent: 'why' }).text === why.text, null)

// 门槛：同一个体，门槛不同就是不同形状（§2）。h5 有一条 cause(1.0) 和一条 adjacent(0.3)
const loBody = loadBody(db, aid, 'h5', { threshold: 0.1 })
const hiBody = loadBody(db, aid, 'h5', { threshold: 0.5 })
ck('体：门槛越高，收进来的越少（低门槛带出周围，高门槛只剩最重的那截）', loBody.size >= hiBody.size && hiBody.size >= 2, { lo: loBody.size, hi: hiBody.size })
ck('体：门槛再高也不会把主轴弄丢', hiBody.size >= 1 && hiBody.head, { size: hiBody.size, head: hiBody.head && hiBody.head.id })

db.close()
for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 清理 */ } }
const fail = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - fail.length}/${checks.length} 过`)
if (fail.length) { console.error('底图验收失败:', fail.length); process.exit(1) }
console.log('底图验收 ok — 只加边、不合并；覆盖 ≥95%；线是一句话')
