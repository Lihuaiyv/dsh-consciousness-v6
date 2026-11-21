/**
 * events_v2 写库验收（2026-11-18）
 *
 * 锁的是「切出来的件怎么进新事件库」：
 *   1. 一件一行：title/summary 必填，时间取首末碎片真实时间，day 是本地日；
 *   2. 成员表权威：event_members 覆盖当天所有入件碎片，不重不漏；
 *   3. turn_ids 与成员对得上（副本不撒谎）；
 *   4. quotes 必须一字不差能在 fragments 找到；
 *   5. cues 过滤泛词、半句；
 *   6. 幂等：同一天同内容重写 → skip，行数不变；
 *   7. 一件坏数据 → 整批回滚，一行不落地；
 *   8. 不碰 cold_events / hot_events（冻结的两张表一行不动）。
 * 用临时库跑，不碰真库。
 */
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { writeEventsV2 } from '../src/modules/event_split_v2.js'

const P = path.join(os.tmpdir(), 'dsh-check-events-v2-' + Date.now() + '.db')
let fails = 0
const ok = (name, cond, extra) => {
  if (cond) console.log('PASS', name)
  else { fails++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)) }
}

const day = '2026-11-17'
const aid = 'a1'
const db = openDb(P)

// 6 句碎片，两件：f1..f3 一件、f4..f6 一件
const frag = (id, t, turn, text, role = 'user') => db.prepare(
  'INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)',
).run(id, aid, 's1', turn, Number(id.slice(1)), role, text, t, day)

frag('f1', '2026-11-17T01:00:00Z', 't1', '先把情绪链的 window 定下来')
frag('f2', '2026-11-17T01:05:00Z', 't2', 'window 固定五句，不按长度缩')
frag('f3', '2026-11-17T01:10:00Z', 't3', '好，这样切事的假刀口会少很多')
frag('f4', '2026-11-17T02:00:00Z', 't4', '接着看检索那边，浮现和检索是不是一码事')
frag('f5', '2026-11-17T02:06:00Z', 't5', '不是，浮现是候选池挑一条，检索是撞')
frag('f6', '2026-11-17T02:12:00Z', 't6', '那这两条先别混着改')

const coldBefore = db.prepare('SELECT COUNT(*) c FROM cold_events').get().c
const hotBefore = db.prepare('SELECT COUNT(*) c FROM hot_events').get().c

const events = [
  {
    title: '定情绪链窗口',
    summary: '把情绪链的窗口定成固定五句，去掉按会话长度缩的算法',
    quotes: ['window 固定五句，不按长度缩', '好，这样切事的假刀口会少很多'],
    cues: ['情绪链', '假刀口'],
    fragmentIds: ['f1', 'f2', 'f3'],
  },
  {
    title: '区分浮现与检索',
    summary: '确认浮现是候选池挑一条、检索是撞，两条先不混着改',
    quotes: ['不是，浮现是候选池挑一条，检索是撞'],
    cues: ['候选池', '检索'],
    fragmentIds: ['f4', 'f5', 'f6'],
  },
]

const r1 = writeEventsV2(db, aid, { day, events })
ok('两件写进去', r1.added === 2 && r1.skipped === 0, r1)
ok('events_v2 两行', db.prepare('SELECT COUNT(*) c FROM events_v2').get().c === 2)
ok('event_members 六行（全覆盖）', db.prepare('SELECT COUNT(*) c FROM event_members').get().c === 6)

const evs = db.prepare('SELECT * FROM events_v2 ORDER BY start_at').all()
const e1 = evs[0], e2 = evs[1]
ok('时间是首末碎片的真实时间', e1.start_at === '2026-11-17T01:00:00Z' && e1.end_at === '2026-11-17T01:10:00Z' && e2.start_at === '2026-11-17T02:00:00Z', { e1: [e1.start_at, e1.end_at], e2: [e2.start_at, e2.end_at] })
ok('day 是本地日', e1.day === day && e2.day === day, { d1: e1.day, d2: e2.day })
ok('title / summary 非空', !!e1.title && !!e1.summary && !!e2.title && !!e2.summary)
ok('事件带会话列（2026-11-19）', e1.session_id === 's1' && e2.session_id === 's1', { s1: e1.session_id, s2: e2.session_id })
ok('turn_ids 与成员对得上', (() => {
  const turns = new Set(db.prepare("SELECT turn_id FROM fragments WHERE id IN ('f1','f2','f3')").all().map((x) => x.turn_id))
  const got = JSON.parse(e1.turn_ids)
  return got.length === 3 && got.every((t) => turns.has(t))
})(), JSON.parse(e1.turn_ids))
ok('quotes 一字不差在库里找得到', JSON.parse(e1.quotes).every((s) => db.prepare('SELECT COUNT(*) c FROM fragments WHERE text=?').get(s).c === 1))

// 幂等：同内容再写
const r2 = writeEventsV2(db, aid, { day, events })
ok('重写幂等：added=0 / skipped=2', r2.added === 0 && r2.skipped === 2, r2)
ok('重写不增行', db.prepare('SELECT COUNT(*) c FROM events_v2').get().c === 2 && db.prepare('SELECT COUNT(*) c FROM event_members').get().c === 6)

// 2026-11-19 主人定：重切 = 那天旧件清掉重写（replace），不是新旧叠加
const r5 = writeEventsV2(db, aid, {
  day, replace: true, events: [{
    title: '重切后合并成一件',
    summary: '重切把那天旧两件清掉，只留这一件',
    quotes: ['window 固定五句，不按长度缩'],
    cues: ['情绪链'],
    fragmentIds: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
  }],
})
ok('重切替换：旧两件清掉、只留新一件', r5.removed === 2 && r5.added === 1 && db.prepare('SELECT COUNT(*) c FROM events_v2').get().c === 1, r5)
ok('重切替换：成员跟着换（6 条全在新件里）', db.prepare('SELECT COUNT(*) c FROM event_members').get().c === 6)
ok('重切替换：别的天一行不动', db.prepare('SELECT COUNT(*) c FROM events_v2 WHERE day<>?').get(day).c === 0)
ok('重切替换：不留孤儿成员（整天替换干净）', db.prepare('SELECT COUNT(*) c FROM event_members m WHERE NOT EXISTS (SELECT 1 FROM events_v2 e WHERE e.id=m.event_id)').get().c === 0)

// 坏数据：一件没 title → 整批回滚（新的一天，免得和上面的幂等打架）
const day2 = '2026-11-18'
frag('g1', '2026-11-18T01:00:00Z', 'u1', '一句', 'user') // 同日
const bad = [
  { title: '好的一件', summary: '这件的成员都在', quotes: ['一句'], cues: ['一句'], fragmentIds: ['g1'] },
  { title: '', summary: '没有标题', quotes: [], cues: [], fragmentIds: [] },
]
const r3 = writeEventsV2(db, aid, { day: day2, events: bad })
ok('坏数据整批不落地', r3.added === 0 && r3.failed >= 1, r3)
ok('回滚后那天一行没有', db.prepare('SELECT COUNT(*) c FROM events_v2 WHERE day=?').get(day2).c === 0)
ok('回滚后成员表没脏行', db.prepare('SELECT COUNT(*) c FROM event_members WHERE fragment_id=?').get('g1').c === 0)

// 冻结的两张表不动
ok('cold_events / hot_events 没被动',
  db.prepare('SELECT COUNT(*) c FROM cold_events').get().c === coldBefore
  && db.prepare('SELECT COUNT(*) c FROM hot_events').get().c === hotBefore,
  { cold: [coldBefore, db.prepare('SELECT COUNT(*) c FROM cold_events').get().c] })

// cues 过滤：泛词不进（另起一条带「检索」的碎片，抓手要能在原文里找到）
frag('g2', '2026-11-18T02:00:00Z', 'u2', '再查一下检索命中率，尤其是继续那种短句')
const r4 = writeEventsV2(db, aid, { day: day2, events: [{ title: '泛词测试', summary: '抓手只剩专名', quotes: ['再查一下检索命中率，尤其是继续那种短句'], cues: ['继续', '这个', '检索'], fragmentIds: ['g2'] }] })
ok('泛词抓手被过滤，专名留下', (() => {
  const row = db.prepare('SELECT cues FROM events_v2 WHERE title=?').get('泛词测试')
  const cues = row ? JSON.parse(row.cues) : []
  return r4.added === 1 && cues.length === 1 && cues[0] === '检索'
})(), db.prepare('SELECT cues FROM events_v2 WHERE title=?').get('泛词测试'))

console.log(`\n通过 ${fails === 0 ? '全部' : '有失败'}`)
if (fails) process.exitCode = 1
