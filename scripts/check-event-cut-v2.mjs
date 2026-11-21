/**
 * 切事件 v4（影子）验收（2026-11-18）
 *
 * 锁的是「worker 影子路径」：cutDayV4 用注入的模型跑完 → writeEventsV2 落库。
 * 用临时库 + 假模型（不花钱、不联网）：
 *   1. 粗切出段、每段有一次记叙调用；
 *   2. 判缝有调用（多段时）；
 *   3. 出件写库后，当天每条 clean 碎片都恰好在 event_members 里一次；
 *   4. 件数 = events_v2 行数；标题非空；
 *   5. 不碰 cold_events / hot_events。
 */
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { writeEventsV2 } from '../src/modules/event_split_v2.js'
import { cutDayV4 } from '../src/modules/event_cut_v4.js'

const P = path.join(os.tmpdir(), 'dsh-check-cut-v2-' + Date.now() + '.db')
let fails = 0
const ok = (name, cond, extra) => {
  if (cond) console.log('PASS', name)
  else { fails++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500)) }
}

const db = openDb(P)
const aid = 'a1'
const day = '2026-11-17'
const texts = [
  ['user', '先把情绪链的窗口定下来，别再按长度缩'],
  ['assistant', '窗口固定五句，这样切事的假刀口会少一些'],
  ['user', '好，那就固定五句，重载前先跑门禁'],
  ['assistant', '门禁跑完了，593 全过，窗口这刀可以落'],
  ['user', '接着看检索那边，浮现和检索是一码事吗'],
  ['assistant', '不是，浮现是候选池挑一条，检索是撞'],
  ['user', '那这两条先别混着改，各自留个开关'],
  ['assistant', '两条各留开关，默认关，删行即回滚'],
]
for (const [i, [role, text]] of texts.entries()) {
  db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('f' + i, aid, 's1', 't' + Math.floor(i / 2), i, role, text, new Date(Date.parse('2026-11-17T01:00:00Z') + i * 60000).toISOString(), day)
}
// 末尾再补 2 句：粗切会切出不足 4 句的尾段，这条锁「短段并进邻居、不丢碎片」（D82）
db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('i0', aid, 's1', 't14', 15, 'user', '种子词要重排一遍', '2026-11-17T03:12:00Z', day)
db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('i1', aid, 's1', 't14', 16, 'assistant', '重排完再跑一轮标注看分布', '2026-11-17T03:13:00Z', day)
// （硬断点不能落在尾部 4 句内——那里有「离边太近不切」的保护，所以后面再补 4 条）
db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('g1', aid, 's1', 't9', 9, 'user', '词表那边我下载了 501 个情绪词', '2026-11-17T03:00:00Z', day)
db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('g2', aid, 's1', 't9', 10, 'assistant', '词表太旧，换个新版词表再拆', '2026-11-17T03:02:00Z', day)
for (let i = 0; i < 4; i++) {
  db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('h' + i, aid, 's1', 't' + (11 + Math.floor(i / 2)), 11 + i, i % 2 ? 'assistant' : 'user',
      ['词表拆完先补 24 个种子词', '种子词够跑一轮标注吗', '够，先跑 30 条看看分布', '分布出来了，偏在安和欲两头'][i],
      new Date(Date.parse('2026-11-17T03:04:00Z') + i * 60000).toISOString(), day)
}

// 2026-11-19：第二个会话（s2），时间故意交错在 s1 里 —— 锁「件按会话分组连续输出」（D88）
const s2 = [
  ['user', '另一个窗口：阳台上的薄荷要不要换盆', '2026-11-17T01:30:00Z'],
  ['assistant', '薄荷根已经盘满了，换个大一号的盆，土别太湿', '2026-11-17T02:00:00Z'],
  ['user', '那旧土还能用吗，掺点新土行不行', '2026-11-17T02:30:00Z'],
  ['assistant', '旧土掺三成新土就行，盆底先垫一层小石子', '2026-11-17T02:45:00Z'],
]
for (const [i, [role, text, at]] of s2.entries()) {
  db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('k' + i, aid, 's2', 'u' + Math.floor(i / 2), i, role, text, at, day)
}


// 2026-11-19：判据先后——专名无交集 + 新词率高 → 直接判 new（不问模型）。造两段不同专名的同一会话
const day3 = '2026-11-19'
const win = ['今天先把情绪链窗口定下来', '窗口固定成五句吧', '那窗口要不要按会话长度缩', '不缩，固定五句', '好，窗口这块先这样', '窗口的逻辑我改好了', '改完跑一遍门禁', '门禁绿了，窗口这刀落了']
const dic = ['词典下载好了，501 个情绪词', '词典太旧，换个新版', '新版词典拆开有多少', '拆完先补 24 个种子词', '种子词够跑一轮标注', '标注分布出来了', '分布偏在安和欲两头', '词典这轮先到这']
for (let i = 0; i < 8; i++) {
  db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('w' + i, aid, 's3', 'tw' + Math.floor(i / 2), i, i % 2 ? 'assistant' : 'user', win[i], new Date(Date.parse('2026-11-19T01:00:00Z') + i * 60000).toISOString(), day3)
  db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('d' + i, aid, 's3', 'td' + Math.floor(i / 2), 8 + i, i % 2 ? 'assistant' : 'user', dic[i], new Date(Date.parse('2026-11-19T01:20:00Z') + i * 60000).toISOString(), day3)
}

const embed = async (list) => list.map((t) => {
  const v = new Array(16).fill(0)
  for (const ch of String(t)) v[ch.codePointAt(0) % 16] += 1
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1
  return v.map((x) => x / n)
})
let narrCalls = 0, joinCalls = 0, titleCalls = 0
const joinTexts = []
const complete = async ({ system, text }) => {
  if (String(system).startsWith('你在给')) {
    // 件标题综合（2026-11-19 后置）：一件一次，按件内容给标题
    titleCalls++
    const mint = String(text).includes('薄荷')
    return JSON.stringify(mint
      ? { title: '给薄荷换盆·旧土掺新', anchors: ['薄荷', '旧土'] }
      : { title: '把情绪链窗口定成五句', anchors: ['五句', '情绪链'] })
  }
  if (String(system).startsWith('你在读一段对话')) {
    narrCalls++
    // 两个会话的抓手要在各自原文里找得到（s2 是薄荷那段），不然 cues 会被清洗成空
    const mint = String(text).includes('薄荷')
    const dict = String(text).includes('词典')
    if (dict) {
      return JSON.stringify({
        title: '整理情绪词典', anchors: ['词典', '标注'],
        cause: '旧词典不够用', process: '换新版词典、拆词、跑标注', result: '标注跑完了，可用',
        place: '终端里', who: ['我', '主人'], realm: '工作',
      })
    }
    return JSON.stringify(mint ? {
      title: '给薄荷换盆', anchors: ['薄荷', '旧土'],
      cause: '薄荷根盘满了', process: '换个大一号的盆，旧土掺新土', result: '盆换好了，还等旧土回填',
      place: '家里', who: ['我', '主人'], realm: '生活',
    } : {
      title: '定情绪链窗口', anchors: ['五句', '情绪链'],
      cause: '要定窗口', process: '把窗口固定成五句', result: '窗口这刀落了',
      place: '终端里', who: ['我', '主人'], realm: '工作',
    })
  }
  if (String(system).startsWith('你在看同一天里')) {
    joinCalls++
    joinTexts.push(String(text))
    return JSON.stringify({ verdict: 'next', why: '接着办同一批事' })
  }
  return '{}'
}

const coldBefore = db.prepare('SELECT COUNT(*) c FROM cold_events').get().c
const hotBefore = db.prepare('SELECT COUNT(*) c FROM hot_events').get().c

const out = await cutDayV4(db, aid, day, { complete, embed })
ok('切出段且每段记叙一次', out.stats.segments >= 1 && narrCalls === out.stats.segments, { seg: out.stats.segments, narrCalls })
// 换会话的缝是代码直接判 new、不调模型；隔多久不再硬断（2026-11-19 主人定）
ok('换会话的缝不调模型', joinCalls <= Math.max(0, out.stats.segments - 1), { joinCalls, seg: out.stats.segments })
ok('出件非空', out.events.length >= 1, out.events.length)

const w = writeEventsV2(db, aid, { day, events: out.events })
ok('写库 added = 件数', w.added === out.events.length && w.failed === 0, w)

// 2026-11-18：事帧的「事」当判缝第二份参考（默认关）
const putFrame = (tid, summary) => db.prepare(
  'INSERT INTO affect_v4_shadow(id,agent_id,turn_id,at,frame_json) VALUES(?,?,?,?,?)',
).run('av4_' + tid, aid, tid, '2026-11-17T03:00:00Z', JSON.stringify({ summary }))
putFrame('t9', '· 我在最后检查窗口这一刀')
putFrame('t11', '· 我在跑假刀口统计')
const noFrameTexts = joinTexts.join('\n')
const mark = joinTexts.length
await cutDayV4(db, aid, day, { complete, embed, withFrame: true })
const yesFrameTexts = joinTexts.slice(mark).join('\n')
ok('withFrame 关：判缝 prompt 里没有事帧', !noFrameTexts.includes('在干什么'), noFrameTexts.slice(-120))
ok('withFrame 开：判缝 prompt 里带上事帧', /在干什么/.test(yesFrameTexts) && yesFrameTexts.includes('最后检查窗口这一刀'), yesFrameTexts.slice(-220))
// 机器量数据可整块关掉（对照：只给原文+记叙）
const mark2 = joinTexts.length
await cutDayV4(db, aid, day, { complete, embed, withFeat: false })
const noFeatTexts = joinTexts.slice(mark2).join('\n')
ok('withFeat 关：判缝 prompt 里没有边界形状数据', !noFeatTexts.includes('边界形状'), noFeatTexts.slice(-160))

// 2026-11-19：判缝上下文加宽（D87）——默认前后各 4 句，关掉回退 2 句
const mark3 = joinTexts.length
await cutDayV4(db, aid, day, { complete, embed, wideCtx: false })
const narrowTexts = joinTexts.slice(mark3).join('\n')
const wideTexts = joinTexts.slice(0, mark).join('\n')
ok('wideCtx 开：判缝 prompt 前后各 4 句', wideTexts.includes('最近4句原话'), wideTexts.slice(0, 160))
ok('wideCtx 关：回退前后各 2 句', narrowTexts.includes('最近2句原话'), narrowTexts.slice(0, 160))

// 2026-11-19：质量指标改口径（D86）——看「≤3 句件数」，不看单段比例
ok('stats 带 tiny / oneSeg 指标', Number.isFinite(out.stats.tiny) && Number.isFinite(out.stats.oneSeg), out.stats)
ok('假模型全 next：没有 ≤3 句的碎件', out.stats.tiny === 0, out.stats)

// 2026-11-19：件按会话分组连续（D88）——两个会话都出件，且同一会话不被打断
const runs = []
for (const e of out.events) if (!runs.length || runs[runs.length - 1] !== e.sessionId) runs.push(e.sessionId)
ok('两个会话都出件', new Set(out.events.map((e) => e.sessionId)).size === 2, out.events.map((e) => e.sessionId))
ok('件按会话分组连续（同一会话不被打断）', new Set(runs).size === runs.length, runs)

// 2026-11-19：件标题后置综合——件定形后一件调一次，标题带整件事的专名
ok('件标题一件一次综合调用', out.stats.titleCalls === out.events.length && out.events.length > 0, { stats: out.stats, events: out.events.length })
ok('综合标题带专名（不是段标题）', out.events.every((e) => e.title.includes('窗口') || e.title.includes('薄荷')), out.events.map((e) => e.title))
const markT = titleCalls
const out2 = await cutDayV4(db, aid, day, { complete, embed, titleSynth: false })
ok('titleSynth 关：不调标题模型、回退段标题', titleCalls === markT && out2.events.every((e) => !e.title.startsWith('把情绪链窗口定成五句')), { titleCalls, markT, titles: out2.events.map((e) => e.title) })

// 2026-11-19：专名交给模型整体比（不靠字面相等）——判缝 prompt 要带上两段的专名列表
const markTxt = joinTexts.length
const out3 = await cutDayV4(db, aid, day3, { complete, embed })
const txt3 = joinTexts.slice(markTxt).join('\n')
ok('判缝 prompt 带上两边专名', out3.stats.segments >= 2 && txt3.includes('专名：五句') && txt3.includes('专名：词典、标注'), txt3.slice(0, 200))
ok('件带 sessionId（落库用）', out.events.every((e) => !!e.sessionId), out.events.map((e) => e.sessionId))
// 2026-11-19：件带状态三值——挂着 / 收起（不判「阶段还是完全」，只看还要不要管）
const st = out.events.map((e) => e.status)
ok('件带状态：挂着和收起都能判出来', st.includes('挂着') && st.includes('收起') && st.every((s) => s === '挂着' || s === '收起'), st)

const all = db.prepare('SELECT COUNT(*) c FROM fragments WHERE agent_id=? AND day=? AND role IN (\'user\',\'assistant\')').get(aid, day).c
const members = db.prepare('SELECT fragment_id FROM event_members WHERE agent_id=? AND day=?').all(aid, day).map((r) => r.fragment_id)
ok('成员覆盖全部碎片且不重', members.length === all && new Set(members).size === all, { all, members: members.length })
ok('件数 = 表行数', db.prepare('SELECT COUNT(*) c FROM events_v2').get().c === out.events.length)
ok('标题非空', out.events.every((e) => !!e.title && !!e.summary), out.events.map((e) => e.title))
// 2026-11-18：标题去重 + 每件线索至少两个
const titles = out.events.map((e) => e.title)
ok('标题不重名', new Set(titles).size === titles.length, titles)
ok('每件线索至少两个', out.events.every((e) => Array.isArray(e.cues) && e.cues.length >= 2), out.events.map((e) => (e.cues || []).length))
ok('冷热库没被动', db.prepare('SELECT COUNT(*) c FROM cold_events').get().c === coldBefore && db.prepare('SELECT COUNT(*) c FROM hot_events').get().c === hotBefore)

console.log(`\n通过 ${fails === 0 ? '全部' : '有失败'}（段 ${out.stats.segments} / 件 ${out.stats.events} / 调用 ${out.stats.calls}）`)
if (fails) process.exitCode = 1
