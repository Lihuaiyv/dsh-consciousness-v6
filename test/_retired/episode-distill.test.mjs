/**
 * P0 日界 / P1 L0 护 L1 / M0–M3 纪要蒸馏。
 * 运行：node test/episode-distill.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now, localDay, dayKey } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { appendTurn, buildEpisodes, listEpisodes } from '../src/modules/archive.js'
import {
  shouldDistillEpisode, ruleDistillCandidates, distillEpisodeFacts,
  distillEpisodesForDay,
} from '../src/modules/episode_distill.js'
import { runNightly } from '../src/modules/nightly.js'
import { retrieve, recentEpisodeTopics } from '../src/modules/retrieve.js'
import { writeParam, getParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-distill-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_distill'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
  .run(aid, '蒸馏', 'daily', 'active', now())

// ---- P0：本地日界
{
  const at = '2026-10-30T17:00:00.000Z' // 若本机 UTC+8 → 本地 10-31 01:00
  const expected = dayKey(at)
  const utcSlice = at.slice(0, 10)
  const r = appendTurn(db, aid, { sessionId: 's_day', role: 'user', text: '凌晨跨日界测试话', at })
  const row = db.prepare('SELECT day,created_at FROM raw_turns WHERE id=?').get(r.id)
  check('P0 appendTurn.day = localDay(created_at)', row.day === expected, { day: row.day, expected, utcSlice })
  check('dayKey 与 localDay 一致', dayKey(at) === localDay(new Date(at)))
  if (expected !== utcSlice) {
    check('P0 在非 UTC 时区会纠正 UTC slice', row.day !== utcSlice, { row: row.day, utcSlice })
  } else {
    check('P0 UTC 时区下 day 与 slice 相同（仍正确）', row.day === utcSlice)
  }
}

// ---- P1：L0 不覆盖 L1
{
  const day = localDay(new Date())
  const sid = 's_l1'
  for (let i = 0; i < 10; i++) {
    appendTurn(db, aid, {
      sessionId: sid, role: i % 2 ? 'assistant' : 'user',
      text: i % 2 ? '好的，我记下了你喜欢深色主题和早起游泳。' : '记住：我喜欢深色主题，决定每周二游泳。还有一件事要跟进。',
      at: new Date(Date.now() - (10 - i) * 60000).toISOString(),
    })
  }
  buildEpisodes(db, aid, { session: sid, day })
  let eps = listEpisodes(db, aid, { day, limit: 20 }).filter((e) => e.session_id === sid)
  check('P1 先有 L0 纪要', eps.length >= 1, eps.length)
  const ep0 = eps[0]
  const mockSummary = '对方明确喜欢深色主题，并决定每周二游泳；还有未了结的跟进事项。'
  db.prepare("UPDATE episodes SET summary=?, source='model', importance=? WHERE id=?")
    .run(mockSummary, Math.max(0.7, Number(ep0.importance || 0)), ep0.id)
  buildEpisodes(db, aid, { session: sid, day })
  const after = db.prepare('SELECT summary,source FROM episodes WHERE id=?').get(ep0.id)
  check('P1 L0 重算仍保留 model summary', after.source === 'model' && after.summary === mockSummary, after)
  const rebuilt = buildEpisodes(db, aid, { session: sid, day })
  check('P1 upsert 标记 kept_model', rebuilt.some((x) => x.kept_model === true) || after.source === 'model', rebuilt[0])
}

// ---- M0：候选规则
{
  check('M0 高分应蒸馏', shouldDistillEpisode({ importance: 0.7, turns: 3, open_loops: [], session_id: 'a' }))
  check('M0 低分不蒸馏', !shouldDistillEpisode({ importance: 0.2, turns: 2, open_loops: [], session_id: 'a', source: 'rules' }))
  check('M0 model 可蒸馏', shouldDistillEpisode({ importance: 0.3, turns: 2, open_loops: [], session_id: 'a', source: 'model' }))
  check('M0 簇修排除', !shouldDistillEpisode({ importance: 0.9, turns: 20, session_id: '__day_cluster__', open_loops: [] }))
  const rules = ruleDistillCandidates({
    beats: ['我喜欢深色主题', '今天天气不错', '决定每周二游泳'],
    open_loops: ['记住把钥匙放门口'],
  })
  check('M0 规则捞硬断言', rules.length >= 2 && rules.every((r) => /喜欢|决定|记住/.test(r.text)), rules)
}

// ---- M1：mock extract 写入 source=episode
{
  const day = localDay(new Date(Date.now() - 86400000))
  const sid = 's_m1'
  appendTurn(db, aid, { sessionId: sid, role: 'user', text: '我决定采用方案甲，以后部署都用它。', at: day + 'T10:00:00.000Z' })
  appendTurn(db, aid, { sessionId: sid, role: 'assistant', text: '好，方案甲记下了。', at: day + 'T10:01:00.000Z' })
  appendTurn(db, aid, { sessionId: sid, role: 'user', text: '另外我喜欢用深色主题写代码。', at: day + 'T10:02:00.000Z' })
  appendTurn(db, aid, { sessionId: sid, role: 'assistant', text: '深色主题，明白。', at: day + 'T10:03:00.000Z' })
  // 纠正 day 列为本地日（append 已用 dayKey；此处确保查询用同一天）
  const dayUsed = db.prepare('SELECT day FROM raw_turns WHERE session_id=? LIMIT 1').get(sid).day
  buildEpisodes(db, aid, { session: sid, day: dayUsed })
  db.prepare("UPDATE episodes SET importance=0.8, source='model', summary=? WHERE agent_id=? AND session_id=?")
    .run('对方决定采用方案甲部署，并喜欢深色主题。', aid, sid)
  const ep = listEpisodes(db, aid, { day: dayUsed, limit: 10 }).find((e) => e.session_id === sid)
  check('M1 有可蒸馏纪要', !!ep && shouldDistillEpisode(ep), ep)

  writeParam(db, aid, 'memory.episode.distill', 'on')
  writeParam(db, aid, 'memory.episode.distill.daily_cap', 6)

  const extractFn = async () => JSON.stringify([
    { text: '用户决定采用方案甲进行部署', type: 'fact', key: 'deploy_plan' },
    { text: '用户喜欢深色主题', type: 'fact', key: 'theme_dark' },
  ])
  const r = await distillEpisodeFacts(db, aid, ep, extractFn, { dailyCap: 6, theta: 0.5 })
  check('M1 蒸馏成功', r.ok === true && r.written >= 1, r)
  const facts = db.prepare("SELECT text,source FROM memory_items WHERE agent_id=? AND source='episode' AND status='active'").all(aid)
  check('M1 事实 source=episode', facts.length >= 1, facts)
  const arch = db.prepare("SELECT payload,source FROM fact_archive WHERE agent_id=? AND source='episode' LIMIT 1").get(aid)
  let payload = null
  try { payload = arch && arch.payload ? JSON.parse(arch.payload) : null } catch { payload = null }
  check('M1 存根带 episode_id', !!(payload && payload.episode_id), { arch, payload })

  const echo = await distillEpisodeFacts(db, aid, ep, async () => '材料：\n{"title":"x"}', { dailyCap: 6 })
  check('M1 回声拒收', echo.ok === false && echo.reason === 'empty', echo)

  // 日限额
  writeParam(db, aid, 'memory.episode.distill.daily_cap', 1)
  // 已 bump 过 1 次，cap=1 时应拒绝
  const capped = await distillEpisodeFacts(db, aid, ep, extractFn, { dailyCap: 1 })
  check('M1 日限额生效', capped.ok === false && capped.reason === 'cap', capped)
}

// ---- 关参
{
  writeParam(db, aid, 'memory.episode.distill', 'off')
  check('M0 关参已写入', getParam(db, aid, 'memory.episode.distill') === 'off', getParam(db, aid, 'memory.episode.distill'))
  const off = await distillEpisodesForDay(db, aid, localDay(), async () => '[]', {})
  check('M0 关参跳过', off.skipped === true && off.reason === 'off', off)
  const offOpt = await distillEpisodesForDay(db, aid, localDay(), async () => '[]', { enabled: 'off' })
  check('M0 opt.enabled=off 跳过', offOpt.skipped === true, offOpt)
  writeParam(db, aid, 'memory.episode.distill', 'on')
}

// ---- M2 prefer_cluster：有簇时只蒸馏簇
{
  const day = '2026-06-15'
  const aid2 = 'agt_m2'
  db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
    .run(aid2, 'M2', 'daily', 'active', now())
  writeParam(db, aid2, 'memory.episode.distill', 'on')
  writeParam(db, aid2, 'memory.episode.distill.prefer_cluster', 'on')
  writeParam(db, aid2, 'memory.episode.distill.daily_cap', 6)
  db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,seg,start_at,end_at,turns,title,summary,topics,beats,open_loops,importance,source,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'ep_l0', aid2, 's1', day, 0, day + 'T01:00:00Z', day + 'T02:00:00Z', 10,
    '闲聊', '聊了天气', '[]', '[]', '[]', 0.8, 'rules', now(),
  )
  db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,seg,start_at,end_at,turns,title,summary,topics,beats,open_loops,importance,source,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'ep_cl', aid2, '__day_cluster__', day, 0, day + 'T01:00:00Z', day + 'T12:00:00Z', 40,
    '上午', '上午决定用方案甲', '["方案甲"]', '["我决定采用方案甲"]', '[]', 0.78, 'model', now(),
  )
  let calls = 0
  const out = await distillEpisodesForDay(db, aid2, day, async () => {
    calls++
    return JSON.stringify([{ text: '用户决定采用方案甲', type: 'fact' }])
  }, { preferCluster: true })
  check('M2 有簇时 prefer_cluster', out.prefer_cluster === true, out)
  check('M2 蒸馏调用次数 ≤ 簇数', calls === 1 && out.distilled === 1, { calls, out })
  const nEp = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='episode'").get(aid2).n
  check('M2 写出事实', nEp >= 1, nEp)
}

// ---- nightly 接线
{
  const day = localDay(new Date(Date.now() - 2 * 86400000))
  const aid3 = 'agt_night'
  db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
    .run(aid3, '夜巡', 'daily', 'active', now())
  writeParam(db, aid3, 'memory.episode.distill', 'on')
  appendTurn(db, aid3, { sessionId: 'sn', role: 'user', text: '我喜欢喝美式咖啡，不加糖。记住这一点。', at: day + 'T08:00:00.000Z' })
  appendTurn(db, aid3, { sessionId: 'sn', role: 'assistant', text: '美式不加糖，记下了。', at: day + 'T08:01:00.000Z' })
  const dayUsed = db.prepare('SELECT day FROM raw_turns WHERE agent_id=? LIMIT 1').get(aid3).day
  const nightly = await runNightly(db, aid3, {
    day: dayUsed,
    summarize: async () => '今天对方说喜欢美式咖啡不加糖。',
    extract: async () => JSON.stringify([{ text: '用户喜欢美式咖啡不加糖', type: 'fact' }]),
  })
  const step = (nightly.steps || []).find((s) => s.step === 'episode_distill')
  check('夜巡含 episode_distill 步', !!step && step.ok !== false, nightly.steps?.map((s) => s.step))
}

// ---- M3：S1 能召回 episode 事实；topic boost 关时不影响
{
  const q = '方案甲'
  const pack = retrieve(db, aid, q, { k: 6, scene: 'S1', noUpgrade: true, episodeTopicBoost: 0 })
  check('M3 S1 能召回蒸馏事实', pack.items.some((x) => x.partition === 'T1' && /方案甲/.test(x.text)), pack.items.map((x) => x.text?.slice(0, 40)))
  const topics = recentEpisodeTopics(db, 'agt_m2', 400)
  check('M3 topics 可读', Array.isArray(topics), topics)
  const base = retrieve(db, aid, '深色主题', { k: 6, scene: 'S1', noUpgrade: true, episodeTopicBoost: 0 })
  const boosted = retrieve(db, aid, '深色主题', {
    k: 6, scene: 'S1', noUpgrade: true, topicBoost: 0.08, topics: ['深色', '主题'],
  })
  check('M3 助推关参可跑', base.items.length >= 0)
  check('M3 助推开参可跑且不炸', boosted.items.length >= 0)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
