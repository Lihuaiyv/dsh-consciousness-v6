/**
 * 分层记忆测试：T4 原文 / T2 纪要 / T3 日记 / 热度档位。
 * 运行：node test/tiers.test.mjs
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now, dayKey, localDay } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory, recall } from '../src/modules/memory.js'
import { purgeExpired } from '../src/core.js'
import { appendTurn, listRaw, searchRaw, listSessions, buildEpisode, buildEpisodes, listEpisodes, buildDiary, getDiary,
  isEpisodeNoise, composeEpisodeFields, packDiaryMaterial, DIARY_MATERIAL_BUDGET,
  segmentTurns, scoreTurn, shouldRefineEpisode, refineEpisode, refineEpisodesForDay, clusterRefineForDay,
  archiveFact, listFactArchive, searchFactArchive } from '../src/modules/archive.js'
import { writeParam } from '../src/kernel.js'
import { heatOf, bandOf, refreshHeat, touch, tierStats } from '../src/modules/tiers.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-tiers-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_tiers'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
  .run(aid, '分层', 'daily', 'active', now())

// ---- 热度与档位
{
  const fresh = { importance: 0.9, hits: 0, created_at: new Date().toISOString(), mark: 'normal' }
  const old = { importance: 0.1, hits: 0, created_at: new Date(Date.now() - 400 * 86400000).toISOString(), mark: 'normal' }
  const hot = heatOf(fresh)
  const cold = heatOf(old)
  check('热度：新的高于旧的', hot > cold, { hot, cold })
  check('档位：重要且新 = 短期', bandOf(fresh, hot) === 'short', { hot})
  check('档位：老且低 = 长期', bandOf(old, cold) === 'long', { cold })
  const locked = { importance: 0.1, created_at: old.created_at, mark: 'locked' }
  check('锁定的强制短期', bandOf(locked, heatOf(locked)) === 'short')
  // 默认出生热度约 0.42：应进中期，不能只靠「刚写完」就占满短期桌面
  const typical = { importance: 0.5, hits: 0, created_at: new Date().toISOString(), mark: 'normal' }
  const th = heatOf(typical)
  check('档位：普通新事实 = 中期', bandOf(typical, th) === 'mid' && th < 0.52, { th })
  const young = { importance: 0.5, hits: 0, created_at: new Date(Date.now() - 1.5 * 86400000).toISOString(), mark: 'normal' }
  const yh = heatOf(young)
  check('档位：两天内不自动短期', bandOf(young, yh) === 'mid' && yh < 0.52, { yh })
  // importance 地板 ~0.34 不够 0.45：老承诺也要进得了长期
  const oldImp = { importance: 0.85, hits: 0, created_at: new Date(Date.now() - 400 * 86400000).toISOString(), mark: 'normal' }
  const oi = heatOf(oldImp)
  check('档位：老且重要无召回 = 长期', bandOf(oldImp, oi) === 'long' && oi < 0.45, { oi })
}

// ---- 写入即带重要度，刷新后分档
{
  const m1 = addMemory(db, aid, { text: '用户明天要早起体检', type: 'fact', importance: 0.95 })
  const m2 = addMemory(db, aid, { text: '很久以前的一件小事', type: 'fact', importance: 0.05 })
  const r1 = db.prepare('SELECT * FROM memory_items WHERE id=?').get(m1.id)
  check('写入带重要度', Number(r1.importance) === 0.95 && r1.band, r1)
  const counts = refreshHeat(db, aid)
  check('刷新热度有分档', counts.short + counts.mid + counts.long >= 2, counts)
  // 把第二条改成很老
  db.prepare("UPDATE memory_items SET created_at=? WHERE id=?").run(new Date(Date.now() - 500 * 86400000).toISOString(), m2.id)
  refreshHeat(db, aid)
  const oldBand = db.prepare('SELECT band FROM memory_items WHERE id=?').get(m2.id).band
  check('老记忆落到长期', oldBand === 'long', oldBand)
}

// ---- 强化：被想起 → hits 增加、热度上升
{
  const m = addMemory(db, aid, { text: '用户喜欢深色主题', type: 'fact', importance: 0.5 })
  const before = db.prepare('SELECT hits,heat FROM memory_items WHERE id=?').get(m.id)
  touch(db, [m.id])
  const after = db.prepare('SELECT hits,heat FROM memory_items WHERE id=?').get(m.id)
  check('强化记一次命中', Number(after.hits) === Number(before.hits) + 1, { before, after })
  check('强化后热度不降', Number(after.heat) >= Number(before.heat), { before, after })
}

// ---- T4 原文：只追加、去重、能搜、能按会话翻
{
  const s1 = 'sess_a'
  const a1 = appendTurn(db, aid, { sessionId: s1, role: 'user', text: '我昨天去看了海，风很大' })
  const a2 = appendTurn(db, aid, { sessionId: s1, role: 'assistant', text: '海风大的时候记得多穿一件' })
  const dup = appendTurn(db, aid, { sessionId: s1, role: 'user', text: '我昨天去看了海，风很大' })
  check('原文写入有 seq', a1.seq === 1 && a2.seq === 2, { a1, a2 })
  check('原文重复不重复写', dup.duplicate === true && dup.id === a1.id, dup)
  const all = listRaw(db, aid, { session: s1 })
  check('原文能按会话取回', all.length === 2 && all[0].role === 'user', all)
  const hit = searchRaw(db, aid, '海风')
  check('原文能搜到', hit.length >= 1 && /海风/.test(JSON.stringify(hit)), hit)
  const sessions = listSessions(db, aid)
  check('会话目录有统计', sessions.length === 1 && Number(sessions[0].turns) === 2, sessions)
}

// ---- T2 纪要
// day 必须用本地日历日（dayKey/localDay），不能 now().slice(0,10)——UTC 跨日会跟 raw_turns.day 对不上
{
  const day = localDay()
  const ep = buildEpisode(db, aid, { session: 'sess_a', day })
  check('纪要生成', ep && ep.turns === 2 && /海/.test(ep.title), ep)
  const again = buildEpisode(db, aid, { session: 'sess_a', day })
  check('纪要不重复建', again.id === ep.id && again.updated === true, again)
  const list = listEpisodes(db, aid, { day })
  check('纪要能列出', list.length === 1 && Array.isArray(list[0].topics), list)

  // 回归：用户句全是长句时 title 会回落到 meaningful[0]——以前 TDZ 直接崩
  const sLong = 'sess_long'
  const longLine = '这是一句超过四十个字的用户话，用来触发标题回落路径，确保不会再 ReferenceError。'
  appendTurn(db, aid, { sessionId: sLong, role: 'user', text: longLine })
  appendTurn(db, aid, { sessionId: sLong, role: 'assistant', text: '收到了' })
  let epLong = null
  let epErr = null
  try { epLong = buildEpisode(db, aid, { session: sLong, day }) }
  catch (e) { epErr = e }
  check('长句会话纪要不 TDZ', !epErr && epLong && epLong.turns === 2, { epErr: epErr && epErr.message, epLong })

  // E0：滤噪 + 打分抽样 + 切段
  check('噪声识别：Approval', isEpisodeNoise('The approval policy changed from "ask" to "never"'))
  check('噪声识别：研究助理提示', isEpisodeNoise('你是研究助理。任务：为「驱力」收集资料……'))
  check('正常人话不是噪声', !isEpisodeNoise('我昨天去看了海，风很大'))
  check('问句分高于寒暄', scoreTurn('周末去不去海边？', 'user', 0, 2) > scoreTurn('你好', 'user', 0, 2))
  const noisy = composeEpisodeFields([
    { role: 'user', text: 'Time sampled [Asia/Shanghai]' },
    { role: 'user', text: '周末去不去海边？' },
    { role: 'user', text: '顺便说下我喜欢看海' },
    { role: 'assistant', text: '```js\nconsole.log(1)\n```' },
    { role: 'assistant', text: '可以啊，记得带外套。' },
  ])
  check('纪要丢掉噪声标题', /海边|看海/.test(noisy.title) && !/Time sampled/.test(noisy.title), noisy)
  check('纪要摘要是要点不是粘贴', /对方：/.test(noisy.summary) && /我：/.test(noisy.summary) && noisy.summary.length <= 220, noisy)
  check('纪要记下未闭环', (noisy.open_loops || []).some((x) => /海边/.test(x)), noisy.open_loops)
  check('纪要 beats 含高分句', (noisy.beats || []).some((b) => /海边|看海/.test(b)), noisy.beats)
  check('有效对话 importance 高于纯寒暄', (() => {
    const hi = composeEpisodeFields([
      { role: 'user', text: '我们要不要把日记改成模型写？' },
      { role: 'user', text: '我决定先做纪要切段。' },
      { role: 'assistant', text: '好，先切段再打包。' },
    ]).importance
    const lo = composeEpisodeFields([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '嗨' },
    ]).importance
    return hi > lo + 0.08
  })())

  // 用本地时钟造「同日早晚」——避免 UTC 22:00 在 +8 掉到次日
  const morning = new Date(2026, 9, 30, 8, 0, 0)
  const evening = new Date(2026, 9, 30, 22, 0, 0)
  const gapRows = []
  for (let i = 0; i < 3; i++) {
    gapRows.push({ role: 'user', text: '早上话题' + i, created_at: new Date(morning.getTime() + i * 60000).toISOString() })
  }
  for (let i = 0; i < 3; i++) {
    gapRows.push({ role: 'user', text: '晚上还没做完吗？', created_at: new Date(evening.getTime() + i * 60000).toISOString() })
  }
  check('静默切段成 2 段', segmentTurns(gapRows).length === 2, segmentTurns(gapRows).map((s) => s.length))
  const many = Array.from({ length: 45 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: '轮次内容' + i + (i === 10 ? '怎么办？' : ''),
    created_at: new Date(2026, 9, 30, 12, i, 0).toISOString(),
  }))
  check('满 40 轮会切段', segmentTurns(many).length >= 2, segmentTurns(many).map((s) => s.length))

  const sSeg = 'sess_seg'
  const segDay = dayKey(gapRows[0].created_at)
  for (const r of gapRows) {
    appendTurn(db, aid, { sessionId: sSeg, role: r.role, text: r.text, at: r.created_at })
  }
  const segs = buildEpisodes(db, aid, { session: sSeg, day: segDay })
  check('落库多段纪要', segs.length === 2 && segs[0].seg === 0 && segs[1].seg === 1, segs.map((s) => s.seg))
  const listed = listEpisodes(db, aid, { day: segDay })
  check('列表能看到多段', listed.filter((e) => e.session_id === sSeg).length === 2, listed.filter((e) => e.session_id === sSeg))

  // 日记打包：再多纪要也不砍半截 JSON
  const manyEps = Array.from({ length: 30 }, (_, i) => ({
    title: '话题' + i,
    summary: '对方：这是一段故意写得很长的纪要摘要用来测试预算打包会不会把 JSON 砍成半截。'.repeat(3),
    open_loops: ['还没做完' + i],
    importance: (i % 10) / 10,
    end_at: '2026-10-30T12:00:00.' + String(i).padStart(3, '0') + 'Z',
  }))
  const packed = packDiaryMaterial({
    day: '2026-10-30',
    date: '2026年10月30日 周五',
    episodes: manyEps,
    facts: [{ text: '喜欢美式', importance: 0.9 }],
    raw: Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '聊天内容' + i })),
    moodZh: '平静，强度 0.2',
    tone: '平实',
    self: {},
  }, DIARY_MATERIAL_BUDGET)
  const rawJson = JSON.stringify(packed.material)
  check('打包不超预算', packed.meta.chars <= DIARY_MATERIAL_BUDGET && rawJson.length <= DIARY_MATERIAL_BUDGET, packed.meta)
  check('打包是完整 JSON', (() => { try { JSON.parse(rawJson); return true } catch { return false } })())
  check('有纪要时默认不塞原文', packed.material.episodes.length >= 4 && packed.material.conversation.length === 0, packed.material.conversation.length)
  // 故意把预算压很小，确认超限时丢低优先级、且绝不产出半截 JSON
  const tight = packDiaryMaterial({
    day: '2026-10-30', date: '2026年10月30日 周五',
    episodes: manyEps, facts: [{ text: '喜欢美式', importance: 0.9 }], raw: [],
    moodZh: '平静', tone: '平实', self: {},
  }, 800)
  check('小预算会丢低优先纪要', tight.meta.dropped_episodes > 0 && tight.material.episodes.length < 30, tight.meta)
  check('小预算仍是完整 JSON', (() => { try { JSON.parse(JSON.stringify(tight.material)); return tight.meta.chars <= 800 } catch { return false } })())

  // E1：低分纪要不占日记坑
  const mixed = [
    ...Array.from({ length: 20 }, (_, i) => ({
      title: '闲聊' + i, summary: '对方：你好。', beats: ['你好'], open_loops: [],
      importance: 0.15, end_at: '2026-10-30T10:00:00.000Z',
    })),
    {
      title: '改纪要切段', summary: '对方：我决定先做纪要切段。', beats: ['我决定先做纪要切段'],
      open_loops: ['还要不要接模型？'], importance: 0.72, end_at: '2026-10-30T20:00:00.000Z',
    },
    {
      title: '日记怎么写', summary: '对方：日记会不会又被砍断？', beats: ['日记会不会又被砍断？'],
      open_loops: [], importance: 0.55, end_at: '2026-10-30T21:00:00.000Z',
    },
  ]
  const filtered = packDiaryMaterial({
    day: '2026-10-30', date: '2026年10月30日 周五',
    episodes: mixed, facts: [], raw: [], moodZh: '平静', tone: '平实', self: {},
    minImportance: 0.25,
  }, 5500)
  check('低分纪要被跳过', filtered.meta.skipped_low >= 20, filtered.meta)
  check('高分纪要进包', filtered.material.episodes.some((e) => /切段|日记/.test(e.title)), filtered.material.episodes)
  check('忙天低分不占满', filtered.material.episodes.length <= 5, filtered.material.episodes.length)
  const onlyLow = packDiaryMaterial({
    day: '2026-10-30', date: 'x',
    episodes: mixed.filter((e) => e.importance < 0.25), facts: [], raw: [],
    moodZh: '平静', tone: '平实', self: {}, minImportance: 0.25,
  }, 5500)
  check('全低分时回退 Top3', onlyLow.meta.fallback_low === true && onlyLow.material.episodes.length === 3, onlyLow.meta)

  // E2 金标精修
  check('应精修：高分', shouldRefineEpisode({ importance: 0.7, turns: 3, open_loops: [] }, { theta: 0.55 }))
  check('不应精修：低分短聊', !shouldRefineEpisode({ importance: 0.2, turns: 2, open_loops: [] }, { theta: 0.55, minTurns: 8 }))
  const sRef = 'sess_refine'
  const dayR = localDay(new Date())
  const refBase = new Date()
  refBase.setHours(12, 0, 0, 0)
  appendTurn(db, aid, { sessionId: sRef, role: 'user', text: '我们要不要把日记改成模型写？还没定。', at: new Date(refBase.getTime()).toISOString() })
  appendTurn(db, aid, { sessionId: sRef, role: 'user', text: '我决定先做纪要切段，再接精修。', at: new Date(refBase.getTime() + 60000).toISOString() })
  appendTurn(db, aid, { sessionId: sRef, role: 'assistant', text: '好，先切段再精修，失败就留规则稿。', at: new Date(refBase.getTime() + 120000).toISOString() })
  for (let i = 0; i < 6; i++) {
    appendTurn(db, aid, { sessionId: sRef, role: 'user', text: '补充细节' + i + '，还要继续吗？', at: new Date(refBase.getTime() + (3 + i) * 60000).toISOString() })
  }
  const refEps = buildEpisodes(db, aid, { session: sRef, day: dayR })
  const target = refEps.sort((a, b) => b.importance - a.importance)[0]
  writeParam(db, aid, 'memory.episode.refine', 'off')
  const off = await refineEpisodesForDay(db, aid, dayR, async () => '不该被调用')
  check('精修关参跳过', off.skipped === true && off.reason === 'off', off)
  writeParam(db, aid, 'memory.episode.refine', 'on')
  writeParam(db, aid, 'memory.episode.refine.daily_cap', 8)
  writeParam(db, aid, 'memory.episode.refine.theta', 0.3)
  writeParam(db, aid, 'memory.episode.refine.min_turns', 4)
  const okRefine = await refineEpisode(db, aid, target, async () => '今天你们先把纪要切段做完，再决定日记要不要接模型。还留着「要不要继续」没了结。', {
    theta: 0.3, minTurns: 4, dailyCap: 8,
  })
  check('精修成功改 source=model', okRefine.ok && okRefine.episode && okRefine.episode.source === 'model', okRefine)
  const keptRules = await refineEpisode(db, aid, target, async () => 'system: 你在写这一天的日记\n材料：{}', {
    theta: 0.3, minTurns: 4, dailyCap: 8,
  })
  check('精修拒收回声不覆盖', !keptRules.ok && db.prepare('SELECT source,summary FROM episodes WHERE id=?').get(target.id).source === 'model', keptRules)
  writeParam(db, aid, 'memory.episode.refine.daily_cap', 1)
  // 计数已因成功精修+1，再跑应撞 cap（同日）
  const capped = await refineEpisodesForDay(db, aid, dayR, async () => '又一篇精修稿，不应该写入。', {
    theta: 0.01, minTurns: 1, dailyCap: 1,
  })
  check('精修日限额生效', capped.refined === 0 && (capped.reasons || []).includes('cap'), capped)

  // E3 簇修
  writeParam(db, aid, 'memory.episode.cluster_at', 3)
  const manyDay = '2026-10-28'
  for (let s = 0; s < 5; s++) {
    const sid = 'sess_cl_' + s
    appendTurn(db, aid, { sessionId: sid, role: 'user', text: '话题' + s + '怎么办？', at: manyDay + 'T1' + s + ':00:00.000Z' })
    appendTurn(db, aid, { sessionId: sid, role: 'assistant', text: '先记下来' + s, at: manyDay + 'T1' + s + ':01:00.000Z' })
    buildEpisodes(db, aid, { session: sid, day: manyDay })
  }
  let calls = 0
  const clustered = await clusterRefineForDay(db, aid, manyDay, async () => {
    calls++
    return JSON.stringify([
      { title: '上午', summary: '先处理了几件问号里的事。' },
      { title: '下午', summary: '继续往下推进，还留着尾巴。' },
      { title: '晚上', summary: '收尾时把要点记牢。' },
    ])
  }, { clusterAt: 3 })
  check('簇修调用一次模型', calls === 1 && clustered.ok && clustered.chapters.length >= 2, { calls, clustered })
  const few = await clusterRefineForDay(db, aid, dayR, async () => { calls++; return '[]' }, { clusterAt: 100 })
  check('纪要少时不簇修', few.skipped === true && few.reason === 'few', few)
}

// ---- T3 日记
{
  const day = localDay()
  const d1 = await buildDiary(db, aid, day)
  check('日记生成', d1 && d1.text.length > 10 && d1.source === 'rules', d1)
  const d2 = await buildDiary(db, aid, day)
  check('同一天默认不覆盖', d2.skipped === true, d2)
  const d3 = await buildDiary(db, aid, day, { force: true })
  check('强制重建版本 +1', d3.version === 2, d3)
  const got = getDiary(db, aid, day)
  check('日记能取回', got && got.day === day, got)
}

// ---- 召回：带档位、且命中会被强化
{
  const m = addMemory(db, aid, { text: '用户喜欢喝美式咖啡', type: 'fact', importance: 0.9 })
  const pack = recall(db, aid, '咖啡', 5, 512)
  check('召回带档位字段', pack.items.every((x) => x.band), pack)
  const row = db.prepare('SELECT hits FROM memory_items WHERE id=?').get(m.id)
  check('召回后命中 +1', Number(row.hits) >= 1, row)
  const stats = tierStats(db, aid)
  check('档位统计完整', stats.facts.total >= 3 && stats.facts.short + stats.facts.mid + stats.facts.long === stats.facts.total, stats.facts)
  check('统计里有事实存根条数', Number(stats.facts_archived) >= 3, stats.facts_archived)
}

// ---- T4 事实存根：事实「出生时」的原样留一份，主表怎么变它都不动
{
  const m = addMemory(db, aid, { text: '用户的生日是十月三日', type: 'fact', importance: 0.9 })
  const a = db.prepare('SELECT * FROM fact_archive WHERE memory_id=?').all(m.id)
  check('事实生成即留存根', a.length === 1 && a[0].text === '用户的生日是十月三日', a)
  check('存根记下当时的参数', Number(a[0].importance) === 0.9 && a[0].type === 'fact', a[0])
  const again = archiveFact(db, aid, { memory_id: m.id, text: '后来改过的说法' })
  const kept = db.prepare('SELECT text FROM fact_archive WHERE memory_id=?').get(m.id).text
  check('存根只写一次、不改写', again.duplicate === true && kept === '用户的生日是十月三日', { again, kept })
  // 主表被推翻 / 软删，存根都还在
  db.prepare('UPDATE memory_items SET invalid_at=?, status=?, deleted_at=? WHERE id=?').run(now(), 'soft_deleted', now(), m.id)
  check('主表失效+软删，存根还在', Number(db.prepare('SELECT COUNT(*) n FROM fact_archive WHERE memory_id=?').get(m.id).n) === 1)
  const s = searchFactArchive(db, aid, '生日是')
  check('存根能搜到', s.length >= 1 && /生日/.test(JSON.stringify(s)), s)
  check('存根有列表', listFactArchive(db, aid, { limit: 5 }).length >= 1)
  // 明确硬删（软删满 7 天）→ 连存根一起清：答应要忘的得真忘
  db.prepare('UPDATE memory_items SET deleted_at=? WHERE id=?').run(new Date(Date.now() - 8 * 86400000).toISOString(), m.id)
  purgeExpired(db)
  check('硬删连存根一起清', Number(db.prepare('SELECT COUNT(*) n FROM fact_archive WHERE memory_id=?').get(m.id).n) === 0)
}

// ---- HTTP 路由
{
  let n = 0
  const api = async (method, p, body = {}) => {
    const out = await handle(db, { method, path: p, body: { ...body, __idempotencyKey: 'tk' + (++n) }, token: 'user' })
    return out.body
  }
  const tiers = await api('GET', `/v1/agents/${aid}/tiers`)
  check('HTTP 档位统计', tiers.facts && tiers.raw_turns >= 2, tiers)
  const raw = await api('GET', `/v1/agents/${aid}/archive?session=sess_a`)
  check('HTTP 原文时间线', Array.isArray(raw.items) && raw.items.length === 2, raw)
  const found = await api('GET', `/v1/agents/${aid}/archive?q=${encodeURIComponent('海风')}`)
  check('HTTP 原文检索', found.mode === 'search' && found.items.length >= 1, found)
  const day = localDay()
  const one = await api('GET', `/v1/agents/${aid}/diaries/${day}`)
  check('HTTP 单日日记', one && one.day === day, one)
  const eps = await api('GET', `/v1/agents/${aid}/episodes`)
  check('HTTP 纪要列表', Array.isArray(eps) && eps.length >= 1, eps)
  const ses = await api('GET', `/v1/agents/${aid}/sessions`)
  check('HTTP 会话目录', Array.isArray(ses) && ses.length >= 1, ses)
  const fa = await api('GET', `/v1/agents/${aid}/archive/facts?limit=10`)
  check('HTTP 事实存根列表', Array.isArray(fa.items) && fa.items.length >= 2 && !!fa.items[0].memory_id, fa)
  const fq = await api('GET', `/v1/agents/${aid}/archive/facts?q=` + encodeURIComponent('咖啡'))
  check('HTTP 事实存根检索', fq.mode === 'search' && fq.items.length >= 1, fq)
  const rawStill = await api('GET', `/v1/agents/${aid}/archive?session=sess_a`)
  check('存根没污染原文层', Array.isArray(rawStill.items) && rawStill.items.length === 2, rawStill)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
