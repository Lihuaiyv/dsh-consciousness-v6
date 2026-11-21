/**
 * 记忆汇流（confluence）· 单元测试
 *
 * 要保证：
 *   1) reconstructScene 能拼出：窗口（带 gap）、锚点、记忆（带 quote / 落点）、状态、预算；
 *   2) **只读**：调用前后各表行数一致、记忆的 last_decay_at 不变（不 touch）；
 *   3) **遗忘优先**：记忆 HIDE 后，记忆条目与它指向的原话轮次都不进包；
 *   4) asof 出证同样过滤，并报 hidden_quotes；
 *   5) runConfluence 拼出的 system 段含三条硬规则，超预算会裁且不超；
 *   6) buildSnapshot 轻/重两档字段不同。
 *
 * 运行：node test/confluence.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { appendTurn } from '../src/modules/archive.js'
import { addMemory } from '../src/modules/memory.js'
import { logEvent } from '../src/modules/timeline.js'
import { forgottenTurnIds } from '../src/modules/visibility.js'
import { reconstructScene, runConfluence, buildSnapshot, recordScene, rememberBlock, sceneView, logConfluence, pruneScenes, recordRevisit, parseBackCommand, replayScene, selfReturnTick } from '../src/modules/confluence.js'
import { retrieveAsOf } from '../src/modules/asof.js'
import { WRITES } from '../src/ports/ownership.js'
import { PARTS } from '../src/modules/parts.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// 本地（Asia/Shanghai）某天 h:m → ISO（存库是 Z）
const T = (h, m) => new Date(Date.UTC(2026, 10, 5, h - 8, m)).toISOString()

const w = makeWorld()
const { db, aid } = w
try {
  // ---------- 铺一段普通的下午 ----------
  const S = 'session-confluence-1'
  appendTurn(db, aid, { sessionId: S, role: 'user', text: '早，今天有点累', at: T(10, 0), turnId: 't1' })
  appendTurn(db, aid, { sessionId: S, role: 'assistant', text: '累就少做点，别硬撑', at: T(10, 2), turnId: 't2' })
  appendTurn(db, aid, { sessionId: S, role: 'user', text: '还记得那道题吗', at: T(10, 20), turnId: 't3' })
  appendTurn(db, aid, { sessionId: S, role: 'assistant', text: '记得，你说过要重做一遍', at: T(10, 21), turnId: 't4' })
  appendTurn(db, aid, { sessionId: S, role: 'user', text: '嗯，等我缓过来', at: T(10, 25), turnId: 't5' })
  // 中间挖一段沉默：44 分钟后再说一句（测 gap）
  appendTurn(db, aid, { sessionId: S, role: 'user', text: '睡了会儿，好多了', at: T(11, 9), turnId: 't6' })

  const m1 = addMemory(db, aid, {
    text: '用户今天有点累', type: 'fact', speaker: 'user', quote: '今天有点累', inferred: 0, turn_id: 't1',
  })
  const m2 = addMemory(db, aid, {
    text: '她说记得那道题', type: 'fact', speaker: 'self', quote: '记得，你说过要重做一遍', inferred: 0, turn_id: 't4',
  })

  // 状态事件（真实库里由评估链写；测试里手工铺，验证的是投影取数）
  const ev = db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
  ev.run('evt_cf_affect', aid, 'affect.appraised', JSON.stringify({ label: 'tired', sig: 0.4, v3: { slow: -0.2, fast: 0.1 }, algo: { hint_label: 'tired' } }), T(10, 15))
  ev.run('evt_cf_drive', aid, 'drive.evaluated', JSON.stringify({ band: 'D2', D: { a: 0.4, b: 0.2 }, D_sum: 0.6, unlocked: { c1: true } }), T(10, 15))
  db.prepare(`INSERT INTO rel_event(id,agent_id,kind,source,session_id,turn_id,speaker_id,text,payload,at,fingerprint,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('rel_cf_1', aid, 'utterance', 'test', S, 't1', 'owner', '他说今天有点累', '{}', T(10, 1), 'fp_cf_1', T(10, 1))
  db.prepare('INSERT INTO affect_user_read(agent_id,episode_id,guess_label,actual_label,note,created_at) VALUES(?,?,?,?,?,?)')
    .run(aid, 'ep_cf_1', 'tired', 'tired', '', T(10, 10))

  const tables = ['memory_items', 'fragments', 'fact_archive', 'memory_timeline', 'memory_provenance', 'events']
  const countsBefore = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]))
  const decayBefore = db.prepare('SELECT last_decay_at FROM memory_items WHERE id=?').get(m1.id).last_decay_at

  // ---------- 1. reconstructScene ----------
  const b = reconstructScene(db, aid, T(10, 20))
  check('bundle ok', b.ok === true, b)
  check('锚点落在 10:20 那句', b.ok && b.anchor.turn_id === 't3', b.anchor)
  check('窗口覆盖锚点前后（≤ 2K+1 轮）', b.ok && b.window.length >= 5 && b.window.length <= 9, b.window.length)
  check('锚点被标出来', b.ok && b.window.filter((x) => x.anchor).length === 1)
  check('gap_min 有值且 44 分钟被看出来', b.ok && b.window.some((x) => x.gap_min === 44), b.ok && b.window.map((x) => x.gap_min))
  check('谁先开口 = user', b.ok && b.state.time.whoStarted === 'user', b.ok && b.state.time)
  check('情绪按 T 投影（tired）', b.ok && b.state.affect && b.state.affect.label === 'tired', b.ok && b.state.affect)
  check('驱力 D 有向量', b.ok && b.state.drive && b.state.drive.D && b.state.drive.D.a === 0.4, b.ok && b.state.drive)
  check('关系取到真实事件（不是 decay）', b.ok && b.state.relation && b.state.relation.kind === 'utterance', b.ok && b.state.relation)
  check('对方当时的状态', b.ok && b.state.other && b.state.other.actual === 'tired', b.ok && b.state.other)
  check('记忆带上原话', b.ok && b.memories.some((m) => m.id === m1.id && m.quote === '今天有点累'), b.ok && b.memories)
  check('记忆落点是 turn', b.ok && b.memories.some((m) => m.id === m1.id && m.landing.startsWith('turn:')), b.ok && b.memories)
  check('记忆回链成功（不是窗口兜底）', b.ok && b.memories.every((m) => m.via === 'turn'), b.ok && b.memories.map((m) => m.via))
  check('预算为正且含四块', b.ok && b.budget.tokens > 0 && Object.keys(b.budget.parts).length === 4, b.ok && b.budget)

  // ---------- 2. 只读 ----------
  const countsAfter = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]))
  check('只读：六张表行数不变', tables.every((t) => countsBefore[t] === countsAfter[t]), { countsBefore, countsAfter })
  const decayAfter = db.prepare('SELECT last_decay_at FROM memory_items WHERE id=?').get(m1.id).last_decay_at
  check('只读：不 touch（last_decay_at 不变）', decayBefore === decayAfter, { decayBefore, decayAfter })

  // 冷库纯净（E10）：原文层与存根层的内容指纹不变
  const digest = (sql) => crypto.createHash('sha1').update(db.prepare(sql).all().map((r) => JSON.stringify(r)).join('\n')).digest('hex')
  const rawDigest = digest('SELECT id,text FROM fragments ORDER BY id')
  const faDigest = digest('SELECT id,text FROM fact_archive ORDER BY id')
  reconstructScene(db, aid, T(10, 20))
  check('E10 冷库纯净：fragments 指纹不变', rawDigest === digest('SELECT id,text FROM fragments ORDER BY id'))
  check('E10 冷库纯净：fact_archive 指纹不变', faDigest === digest('SELECT id,text FROM fact_archive ORDER BY id'))

  // ---------- 3. 遗忘优先 ----------
  logEvent(db, aid, m1.id, 'HIDE', { reason: 'user', at: T(11, 0) })
  const forg = forgottenTurnIds(db, aid)
  check('遗忘集合包含 t1', forg.has('t1'), [...forg])
  const b2 = reconstructScene(db, aid, T(10, 20))
  check('忘掉的记忆不进包', b2.ok && !b2.memories.some((m) => m.id === m1.id), b2.ok && b2.memories.map((m) => m.id))
  check('忘掉的轮次整轮不进窗口', b2.ok && !b2.window.some((x) => x.turn_id === 't1'), b2.ok && b2.window.map((x) => x.turn_id))

  // 锚点本身被忘 → 拒绝重建
  logEvent(db, aid, m2.id, 'HIDE', { reason: 'user', at: T(11, 1) })
  const b3 = reconstructScene(db, aid, T(10, 20)) // 锚点是 t3（用户那句），m2 挂 t4 → 锚点没被忘
  check('锚点没被忘时仍可重建', b3.ok === true, b3)
  const b4 = reconstructScene(db, aid, T(10, 21)) // 锚点 t4 被忘 → 拒绝
  check('锚点被忘时拒绝重建', b4.ok === false && b4.reason === 'forgotten-anchor', b4)

  // ---------- 4. asof 出证也过滤 ----------
  const asof = retrieveAsOf(db, aid, '累', { from: T(9, 50), to: T(10, 30), k: 5, log: false })
  check('asof 报出被挡掉的原话数', asof.ok === true && asof.hidden_quotes >= 1, { hidden: asof && asof.hidden_quotes })
  check('asof 不端出被忘的那句', asof.ok === true && !(asof.quotes || []).some((q) => String(q.text).includes('有点累')), asof && asof.quotes)

  // 4b. 老账没有 turn 链（现库 55 条 HIDE 全是这样）：仍然要封
  //     做法：把记忆的创建时间挪进查询窗、再把 turn 链抹掉，模拟「老条目」
  db.prepare('UPDATE memory_items SET source_turn_id=NULL, created_at=? WHERE id=?').run(T(10, 21), m2.id)
  db.prepare('UPDATE fact_archive SET source_turn_id=NULL, created_at=? WHERE memory_id=?').run(T(10, 21), m2.id)
  const asof2 = retrieveAsOf(db, aid, '题', { from: T(10, 15), to: T(10, 30), k: 5, log: false })
  check('无链老账：保守窗封住原话', asof2.ok === true && (asof2.quotes || []).length === 0, asof2 && asof2.quotes)
  check('无链老账：报出挡掉数', asof2.ok === true && asof2.hidden_quotes >= 1, asof2 && asof2.hidden_quotes)

  // 4c. 保守窗只封那一段，不能把别的日子也封掉
  appendTurn(db, aid, { sessionId: 'session-confluence-2', role: 'user', text: '今天还是有点累', at: T(56, 10), turnId: 't7' })
  const far = retrieveAsOf(db, aid, '累', { from: T(56, 9), to: T(56, 11), k: 5, log: false })
  check('远处的日子不被连带封', far.ok === true && (far.quotes || []).length >= 1, far && far.quotes)

  // ---------- 5. runConfluence ----------
  const sys = runConfluence(b, { ask: '你现在想起什么' })
  check('system 段 ok', sys.ok === true, sys)
  check('带「回到」与三条硬规则', sys.ok && /回到 \d{4}-\d{2}-\d{2}/.test(sys.system) && sys.system.includes('只读') && sys.system.includes('不同意'), sys.ok && sys.system.slice(0, 120))
  check('带锚点原话', sys.ok && sys.system.includes('还记得那道题吗'), sys.ok && sys.system.slice(0, 200))
  const small = runConfluence(b, { ask: '你现在想起什么', budget: 120 })
  check('预算下限 200 生效且不超 cap', small.ok && small.budget.tokens <= small.budget.cap, small.budget)
  check('裁过有记录', small.ok && small.dropped.length > 0, small.dropped)

  // ---------- 6. 截面两档 ----------
  const light = buildSnapshot(db, aid, T(10, 20), { tier: 'light' })
  const heavy = buildSnapshot(db, aid, T(10, 20), { tier: 'heavy' })
  check('轻截面有情绪', light && light.affect_json && JSON.parse(light.affect_json).slow !== undefined, light)
  check('轻截面不写人格', light && light.persona_json === null, light)
  check('重截面带人格说明', heavy && heavy.persona_json && heavy.persona_json.includes('版本'), heavy)

  // ---------- 6b. 深夜锚点：day 列是本地日，不能拿 UTC 的日期去查 ----------
  const LATE = new Date(Date.UTC(2026, 10, 5, 16, 30)).toISOString() // 本地 11-06 00:30
  appendTurn(db, aid, { sessionId: 'session-confluence-3', role: 'user', text: '这么晚还没睡', at: LATE, turnId: 't8' })
  const night = reconstructScene(db, aid, LATE, { level: 'L0' })
  check('深夜锚点找得到（本地日对）', night.ok === true && night.anchor.turn_id === 't8', night)
  check('L0 默认只取锚点一轮', night.ok === true && night.window.length === 1, night.ok && night.window.length)

  // ---------- 8. 写侧：留底（P1）----------
  const cnt = (t, where = '') => db.prepare(`SELECT COUNT(*) n FROM ${t} ${where}`).get().n
  const baseArchive = cnt('scene_archive')
  rememberBlock('session-confluence-w', '这是那一轮的注入块原文')
  const w1 = recordScene(db, aid, { turnId: 'tW1', sessionId: 'session-confluence-w', at: T(10, 20) })
  check('留底：写了注入块原文', w1.ok && cnt('scene_archive') === baseArchive + 1, w1)
  check('留底：写了轻截面', w1.ok && w1.wrote.light === 1 && cnt("state_scene WHERE tier='light'") === 1, w1)
  const w2 = recordScene(db, aid, { turnId: 'tW1', sessionId: 'session-confluence-w', at: T(10, 20) })
  check('同一轮重复调用不写第二行', w2.ok && cnt('scene_archive') === baseArchive + 1 && cnt("state_scene WHERE tier='light'") === 1, w2)
  for (let i = 2; i <= 20; i++) {
    recordScene(db, aid, { turnId: 'tW' + i, sessionId: 'session-confluence-w', at: T(10, 19 + i) })
  }
  check('到 20 轮写下重截面', cnt("state_scene WHERE tier='heavy'") === 1, cnt("state_scene WHERE tier='heavy'"))
  const offBase = { ss: cnt('state_scene'), sa: cnt('scene_archive') }
  db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
    .run(aid, 'scene.archive', '"off"', T(11, 0))
  const wOff = recordScene(db, aid, { turnId: 'tWOFF', sessionId: 'session-confluence-w', at: T(10, 45) })
  check('scene.archive=off 时一行不写', wOff.ok === false && wOff.reason === 'off' && cnt('state_scene') === offBase.ss && cnt('scene_archive') === offBase.sa, wOff)
  db.prepare('DELETE FROM agent_params WHERE agent_id=? AND key=?').run(aid, 'scene.archive')

  // ---------- 8.6 会话约束（11-09 已定：锚点也要按会话） ----------
  const SA = 'sess_alpha', SB = 'sess_beta'
  appendTurn(db, aid, { sessionId: SA, role: 'user', text: 'A0 这边先开口', at: T(14, 0), turnId: 'a0' })
  appendTurn(db, aid, { sessionId: SB, role: 'user', text: 'B0 隔壁本子的第一句', at: T(14, 2), turnId: 'b0' })
  appendTurn(db, aid, { sessionId: SA, role: 'assistant', text: 'A1 这边回一句', at: T(14, 4), turnId: 'a1' })
  const onlyB = reconstructScene(db, aid, T(14, 2), { level: 'L0', sessionId: SB })
  check('会话约束：显式会话只翻这本', onlyB.ok === true && onlyB.anchor.session_id === SB && onlyB.window.length === 1, onlyB.anchor)
  const preferA = reconstructScene(db, aid, T(14, 2), { level: 'L1', sessionId: SA })
  check('会话约束：显式会话压过更近的隔壁', preferA.ok === true && preferA.anchor.session_id === SA && preferA.window.every((w) => !w.text.includes('B0')), preferA.anchor)
  const auto = reconstructScene(db, aid, T(14, 2), { level: 'L0' })
  check('会话约束：不指定时按最近的一句（不改旧口径）', auto.ok === true && auto.session && auto.session.filtered === false, auto.session)
  // 半截话守卫：抽取截断出来的短生活碎片（实测「那句话是不是」6 字）不进包
  db.prepare("INSERT INTO memory_items(id,agent_id,type,text,source,status,created_at,last_decay_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('mem_shortlife', aid, 'fact', '那句话是不是', 'life', 'active', T(13, 0), T(13, 0))
  const shortLife = reconstructScene(db, aid, T(13, 30), { level: 'L1' })
  check('半截话：太短的生活碎片不摆进现场', shortLife.ok === true && shortLife.state.life === null, shortLife.ok && shortLife.state.life)
  const viewA = sceneView(db, aid, { at: '2026-11-05 14:02', level: 'L0', sessionId: SA })
  check('会话约束：手动入口能带会话', viewA.ok === true && viewA.session && viewA.session.filtered === true && viewA.bundle.anchor.session_id === SA, viewA.session)
  const none = reconstructScene(db, aid, T(14, 2), { level: 'L0', sessionId: 'sess_no_such' })
  check('会话约束：指定了一条没话的会话 → no-turns', none.ok === false && none.reason === 'no-turns')

  // ---------- 9. 手动入口 / 审计 / 保留策略 ----------
  const view = sceneView(db, aid, { at: '2026-11-05 10:20', level: 'L0' })
  check('手动入口：能拼出可读现场', view.ok === true && view.system.includes('回到 2026-11-05'), view && view.system.slice(0, 80))
  check('手动入口：L0 只取锚点一轮', view.ok === true && view.bundle.window.length === 1, view && view.bundle.window.length)
  const badAt = sceneView(db, aid, { at: '不是时间' })
  check('手动入口：坏时间给原因', badAt.ok === false && badAt.reason === 'bad-at', badAt)
  const logId = logConfluence(db, aid, { at: view.at, level: 'L0', bundle: view.bundle, mode: 'manual' })
  check('审计账落了一行', !!logId && cnt('confluence_log') >= 1, logId)

  const oldAt = new Date(Date.now() - 400 * 86400000).toISOString()
  db.prepare('INSERT INTO scene_archive(turn_id,agent_id,at,session_id,block,block_hash,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('old_block_1', aid, oldAt, 's', 'x', 'h', 1, oldAt)
  db.prepare('INSERT INTO state_scene(id,agent_id,at,turn_id,tier,created_at) VALUES(?,?,?,?,?,?)')
    .run('old_ss_1', aid, oldAt, 'old_block_1', 'light', oldAt)
  const pr = pruneScenes(db, aid, { days: 180 })
  check('保留策略：按天清掉老行', pr.archive >= 1 && pr.light >= 1, pr)
  check('保留策略：老块没了', cnt('scene_archive', "WHERE turn_id='old_block_1'") === 0)
  for (let i = 0; i < 3; i++) {
    db.prepare('INSERT INTO scene_archive(turn_id,agent_id,at,session_id,block,block_hash,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('cap_' + i, aid, new Date(Date.now() - i * 1000).toISOString(), 's', 'b', 'h', 1, new Date().toISOString())
  }
  pruneScenes(db, aid, { days: 9999, maxArchive: 2 })
  check('保留策略：按行数封顶', cnt('scene_archive') <= 2, cnt('scene_archive'))

  // ---------- 9.3 保留：0 = 永不删（11-10 定） ----------
  const beforeAll = cnt('scene_archive')
  const pr0 = pruneScenes(db, aid, { days: 0, maxArchive: 0 })
  check('保留：0 表示永不删', pr0.archive === 0 && cnt('scene_archive') === beforeAll, pr0)

  // ---------- 9.4 自己发起（P4） ----------
  const at0 = T(200, 0)              // 测试世界里的「八天后」
  const ten = T(10, 10)              // 那时之前的一个重截面
  db.prepare("INSERT INTO state_scene(id,agent_id,at,turn_id,tier,affect_json,created_at) VALUES(?,?,?,?,?,?,?)")
    .run('ss_self', aid, ten, 't_self', 'heavy', JSON.stringify({ label: 'calm' }), ten)
  check('自己发起：默认关', selfReturnTick(db, aid, { at: at0 }).reason === 'off')
  db.prepare("INSERT INTO revisit(id,agent_id,at,anchor_turn,memory_ids,mood,note,source,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run('rv_manual_1', aid, T(24 * 7, 0), null, null, null, '手动', 'manual', at0)
  check('自己发起：间隔不够就不开', selfReturnTick(db, aid, { at: at0, force: true }).reason === 'too_soon')
  db.prepare("DELETE FROM revisit WHERE id='rv_manual_1'").run()
  const self1 = selfReturnTick(db, aid, { at: at0, force: true })
  check('自己发起：触发一次', self1.ok === true && String(self1.system).includes('记忆汇流'), self1.reason)
  check('自己发起：留一条 self 账', db.prepare("SELECT COUNT(*) n FROM revisit WHERE source='self'").get().n === 1)
  const self2 = selfReturnTick(db, aid, { at: at0, force: true })
  check('自己发起：当天水位挡住第二次', self2.ok === false && self2.reason === 'waterline', self2.reason)

  // ---------- 9.5 L2 整段重放（P5） ----------
  rememberBlock('session-confluence-l2', '这是那一轮的注入块原文（L2 测试用）')
  recordScene(db, aid, { turnId: 'tL2', sessionId: 'session-confluence-l2', at: T(10, 20) })
  const rp = replayScene(db, aid, { at: T(10, 20), sessionId: 'session-confluence-l2' })
  check('整段重放：取得到那一轮的注入块', !!rp && String(rp.block).includes('L2 测试用'), rp && rp.bytes)
  const l2 = sceneView(db, aid, { at: '2026-11-05 10:20', level: 'L2', sessionId: 'session-confluence-l2' })
  check('整段重放：L2 走整段而不是重建', l2.ok === true && String(l2.system).includes('整段重放'), l2.ok && l2.budget)
  check('整段重放：预算单开（cap 8000）', l2.ok === true && l2.budget.cap === 8000)
  // 2026-11-18：L2 也要有「时间感」，不能只给日期
  check('整段重放：带时间感（几点 + 时段）', l2.ok === true && /时间感：那是 \d\d:\d\d/.test(String(l2.system)), String(l2.system).slice(0, 160))
  appendTurn(db, aid, { sessionId: 'sess_l2miss', role: 'user', text: '这条会话没有留底', at: T(16, 6), turnId: 'l2m1' })
  const l2miss = sceneView(db, aid, { at: '2026-11-05 16:06', level: 'L2', sessionId: 'sess_l2miss' })
  check('整段重放：没留底就退回 16 轮并明说', l2miss.ok === true && l2miss.note === 'no-archive', l2miss && { ok: l2miss.ok, note: l2miss.note, reason: l2miss.reason })

  // ---------- 9.6 来路 / 去路（P3.5） ----------
  for (let i = 0; i < 14; i++) {
    appendTurn(db, aid, { sessionId: 'sess_ctx', role: i % 2 === 0 ? 'user' : 'assistant', text: 'c' + i + ' 这一句是给来路去路测试用的', at: T(16, i), turnId: 'c' + i })
  }
  const cb = reconstructScene(db, aid, T(16, 6), { level: 'L1', sessionId: 'sess_ctx' })
  check('来路：窗口前有那两句', !!cb.context && !!cb.context.before && cb.context.before.lines.length >= 1, cb.context && cb.context.before)
  check('来路：每句压到 ≤32 字', !!cb.context && !!cb.context.before && cb.context.before.lines.every((x) => x.length <= 32))
  check('去路：窗口后有那两句', !!cb.context && !!cb.context.after && cb.context.after.lines.length >= 1, cb.context && cb.context.after)
  const ctxChars = JSON.stringify(cb.context || {}).length
  check('来路去路：合计不胀（≤300 字符）', ctxChars <= 300, ctxChars)
  const sysCtx = runConfluence(cb, {})
  check('来路去路：进得了现场段', String(sysCtx.system).includes('来路：') && String(sysCtx.system).includes('去路：'))

  // ---------- 9.7 「回到某天」口令（P3.6） ----------
  const bc1 = parseBackCommand('回到 2026-11-05 15:22')
  check('口令：认「回到 日期 时间」', !!bc1 && bc1.at === '2026-11-05T07:22:00.000Z', bc1)
  const bc2 = parseBackCommand('宝宝，翻回 2026-11-09')
  check('口令：默认下午三点、能带称呼', !!bc2 && bc2.at === '2026-11-09T07:00:00.000Z', bc2)
  check('口令：普通闲聊不当命令', parseBackCommand('今天吃什么') === null)
  check('口令：没带日期不当命令', parseBackCommand('回到那天') === null)
  const idxOut = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  check('口令接进了提示词（index.js）', idxOut.includes('backToSceneLine(d, sid)'))
  check('口令在收消息那刻就备好现场（index.js）', idxOut.includes('stashBackScene(db, aid, sid, t)'))

  // ---------- 9.8 「这次想起」落账 ----------
  const rvAt = T(15, 0)
  const rvId = recordRevisit(db, aid, { at: rvAt, anchorTurn: 'a0', mood: 'tired', note: '刚回到那天看了一眼', source: 'test' })
  const rvRow = db.prepare('SELECT * FROM revisit WHERE id=?').get(rvId)
  check('这次想起：落一行', !!rvId && !!rvRow && rvRow.anchor_turn === 'a0', rvRow)
  check('这次想起：带心情和话', !!rvRow && rvRow.mood === 'tired' && String(rvRow.note).includes('回到那天'))
  check('这次想起：只写自己的表', db.prepare('SELECT COUNT(*) n FROM revisit WHERE id=?').get(rvId).n === 1)

  // ---------- 9.9 两条回复链都留底 ----------
  const idxSrc = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  check('桌面回复链也调 recordScene', idxSrc.includes('recordScene(db, aid, { turnId: tid, sessionId: sid'))
  const featSrc2 = fs.readFileSync(new URL('../src/features.js', import.meta.url), 'utf8')
  check('外部通道回复链也调 recordScene', featSrc2.includes('recordScene(db, aid'))

  // ---------- 10. 登记：表 / 域 / 零件 / 导出 / 清理 ----------
  const NEED = ['state_scene', 'scene_archive', 'confluence_log', 'revisit']
  const have = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  check('新表建出来了', NEED.every((t) => have.includes(t)), NEED.filter((t) => !have.includes(t)))
  check('WRITES 登记了 confluence 域', Array.isArray(WRITES.confluence) && NEED.every((t) => WRITES.confluence.includes(t)), WRITES.confluence)
  // 只要求「至少 28 个、并且含 confluence」：写死等于数会让每次加零件都要来改这一行，
  // 那是维护摩擦，不是保护。
  check('PARTS 至少 28 个且含 confluence', PARTS.length >= 28 && PARTS.some((p) => p.id === 'confluence'), { len: PARTS.length })
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
  const featSrc = src('../src/features.js')
  const opsSrc = src('../src/modules/ops.js')
  check('全量导出清单含新表', NEED.every((t) => featSrc.includes(`'${t}'`)), NEED.filter((t) => !featSrc.includes(`'${t}'`)))
  check('记忆导出含 revisit', /MEM_TABLES\s*=\s*\[[^\]]*'revisit'/.test(featSrc))
  check('清理清单含新表', NEED.every((t) => opsSrc.includes(`'${t}'`)), NEED.filter((t) => !opsSrc.includes(`'${t}'`)))
} finally {
  try { w.close && w.close() } catch { /* ignore */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
