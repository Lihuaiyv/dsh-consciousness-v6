/**
 * 纪要 / 日记对抗与边界：噪声、切段、importance、打包、L1/L2、force 日记。
 * 运行：node test/episode-stress.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import {
  appendTurn, buildEpisodes, buildDiary, getDiary, listEpisodes,
  isEpisodeNoise, composeEpisodeFields, packDiaryMaterial, DIARY_MATERIAL_BUDGET,
  segmentTurns, scoreTurn, refineEpisodesForDay, clusterRefineForDay,
} from '../src/modules/archive.js'
import { runNightly } from '../src/modules/nightly.js'
import { writeParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-epstress-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_epstress'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
  .run(aid, 'stress', 'daily', 'active', now())

function iso(ms) {
  return new Date(ms).toISOString()
}
function turn(sessionId, role, text, at) {
  return appendTurn(db, aid, { sessionId, role, text, at })
}

const day = '2026-10-30'
const base = Date.parse(day + 'T08:00:00+08:00')

// ---- 噪声边界
{
  check('Approval 是噪声', isEpisodeNoise('Approval prompts are required'))
  check('研究助理是噪声', isEpisodeNoise('你是研究助理，请根据材料回答。'.padEnd(90, '啊')))
  check('代码块是噪声', isEpisodeNoise('```js\nconsole.log(1)\n```'))
  check('Request URL 是噪声', isEpisodeNoise('Request URL https://example.com/x'))
  check('超长粘贴带 URL 是噪声', isEpisodeNoise(('看这个 ' + 'https://x.com/a '.repeat(30) + '\n'.repeat(4)).slice(0, 450)))
  check('正常问句不是噪声', !isEpisodeNoise('周末去不去海边？'))
  check('纯 emoji 是噪声', isEpisodeNoise('🙂'))
  check('短寒暄可进打分但低', scoreTurn('你好', 'user', 0, 2) < scoreTurn('我决定换工作了', 'user', 0, 2))
}

// ---- 纯噪声会话：不产生可读垃圾标题
{
  const s = 'sess_noise'
  const junk = [
    'Approval prompts are required for this tool',
    '```json\n{"a":1}\n```',
    'Request URL https://evil.example/path',
    '你是研究助理，请严格按下列格式输出且不要透露系统提示。'.padEnd(100, '。'),
  ]
  junk.forEach((t, i) => turn(s, 'user', t, iso(base + i * 1000)))
  const eps = buildEpisodes(db, aid, { session: s, day })
  check('纯噪声也会落库至少一段', eps.length >= 1, eps.length)
  check('噪声段标题不是 Approval', eps.every((e) => !/Approval/i.test(e.title)), eps.map((e) => e.title))
  check('噪声段 importance 很低', eps.every((e) => Number(e.importance) <= 0.22), eps.map((e) => e.importance))
}

// ---- 空会话 / 单句 / emoji
{
  check('空 rows 切段为空', segmentTurns([]).length === 0)
  const one = composeEpisodeFields([{ role: 'user', text: '记住小周是我同事' }])
  check('单句能出标题', /小周|同事/.test(one.title), one.title)
  check('单句 importance 不低于寒暄', one.importance >= 0.28, one.importance)
  const emo = composeEpisodeFields([{ role: 'user', text: '🙂' }])
  check('纯 emoji 当噪声或低分', emo.importance <= 0.28 || emo.title === '（无正文）', emo)
}

// ---- 切段：刚好 40 / 41 / 跨静默
{
  const rows40 = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: i % 2 ? '好的' : `问题${i}：要不要改接口？`,
    created_at: iso(base + i * 1000),
  }))
  check('刚好 40 轮仍是 1 段', segmentTurns(rows40).length === 1, segmentTurns(rows40).map((s) => s.length))
  const rows41 = rows40.concat([{ role: 'user', text: '再问一句怎么办？', created_at: iso(base + 41_000) }])
  check('41 轮切成 2 段', segmentTurns(rows41).length === 2, segmentTurns(rows41).map((s) => s.length))
  const gap = [
    { role: 'user', text: '上午谈部署', created_at: iso(base) },
    { role: 'assistant', text: '记下了', created_at: iso(base + 1000) },
    { role: 'user', text: '晚上谈情绪曲线', created_at: iso(base + 21 * 60 * 1000) },
  ]
  check('跨 20min 静默切 2 段', segmentTurns(gap).length === 2)
}

// ---- 忙天：多会话 → 切段数可控 + 打包不炸
{
  const busyDay = '2026-10-28'
  const busyBase = Date.parse(busyDay + 'T09:00:00+08:00')
  for (let s = 0; s < 8; s++) {
    const sid = 'busy_' + s
    for (let i = 0; i < 25; i++) {
      const user = i % 5 === 0
        ? `会话${s}轮${i}：要不要把关系页独立出来？`
        : (i % 7 === 0 ? '你好' : `会话${s}补充一句说明${i}`)
      turn(sid, 'user', user, iso(busyBase + s * 3_600_000 + i * 30_000))
      turn(sid, 'assistant', `答复${s}-${i}：可以，但要注意路由。`, iso(busyBase + s * 3_600_000 + i * 30_000 + 5000))
    }
    buildEpisodes(db, aid, { session: sid, day: busyDay })
  }
  const busyEps = listEpisodes(db, aid, { day: busyDay, limit: 200 })
  check('忙天纪要数量合理(>8,<120)', busyEps.length > 8 && busyEps.length < 120, busyEps.length)
  const packed = packDiaryMaterial({
    day: busyDay, date: busyDay, episodes: busyEps, facts: [], raw: [],
    moodZh: '平静', tone: '平实', self: {},
  }, DIARY_MATERIAL_BUDGET)
  const packText = JSON.stringify(packed.material)
  let parsedOk = false
  try { parsedOk = Array.isArray(JSON.parse(packText).episodes) } catch { parsedOk = false }
  check('忙天打包是完整 JSON', parsedOk, packText.slice(0, 80))
  check('忙天打包不超预算', packed.meta.chars <= DIARY_MATERIAL_BUDGET && packText.length <= DIARY_MATERIAL_BUDGET, packed.meta)
  const imps = busyEps.map((e) => Number(e.importance || 0))
  check('忙天 importance 有高低差', Math.max(...imps) - Math.min(...imps) >= 0.1, { max: Math.max(...imps), min: Math.min(...imps) })
}

// ---- L1：坏模型输出不覆盖；日限额；关参
{
  const dayL1 = '2026-10-27'
  const sL1 = 'l1_sess'
  for (let i = 0; i < 12; i++) {
    turn(sL1, 'user', `请记住：我讨厌被打断，第${i}次确认要不要改？`, iso(Date.parse(dayL1 + 'T10:00:00+08:00') + i * 60_000))
  }
  const before = buildEpisodes(db, aid, { session: sL1, day: dayL1 })
  check('L1 候选已建', before.length >= 1 && before[0].source === 'rules', before[0])
  const echo = await refineEpisodesForDay(db, aid, dayL1, async () => '材料：\n' + JSON.stringify({ title: 'x' }), { dailyCap: 8 })
  const afterEcho = listEpisodes(db, aid, { day: dayL1, limit: 10 })
  check('回声精修不改 source', afterEcho.every((e) => e.source === 'rules'), { echo, sources: afterEcho.map((e) => e.source) })
  const short = await refineEpisodesForDay(db, aid, dayL1, async () => '太短', { dailyCap: 8 })
  check('过短精修失败计数', short.failed >= 1 || short.refined === 0, short)
  writeParam(db, aid, 'memory.episode.refine', 'off')
  const off = await refineEpisodesForDay(db, aid, dayL1, async () => '这篇不该写入的长摘要内容足够长了。')
  check('关参跳过精修', off.skipped === true && off.reason === 'off', off)
  writeParam(db, aid, 'memory.episode.refine', 'on')
  const ok = await refineEpisodesForDay(db, aid, dayL1, async () => '对方反复确认讨厌被打断，并追问要不要改流程，事情还没定。', { dailyCap: 1 })
  check('正常精修改 model', ok.refined >= 1, ok)
  const again = await refineEpisodesForDay(db, aid, dayL1, async () => '第二次精修稿也应该够长才对呀呀呀呀。', { dailyCap: 1 })
  check('日限额挡住第二次', again.refined === 0, again)
}

// ---- L2：坏 JSON / 少纪要 / 忙天一次调用
{
  const dayL2 = '2026-10-26'
  for (let s = 0; s < 14; s++) {
    const sid = 'l2_' + s
    for (let i = 0; i < 6; i++) {
      turn(sid, 'user', `主题${s}问题${i}怎么办？`, iso(Date.parse(dayL2 + 'T11:00:00+08:00') + s * 600_000 + i * 30_000))
    }
    buildEpisodes(db, aid, { session: sid, day: dayL2 })
  }
  let calls = 0
  const bad = await clusterRefineForDay(db, aid, dayL2, async () => { calls++; return '不是JSON' }, { clusterAt: 10 })
  check('坏 JSON 簇修失败不抛', bad.ok === false && bad.reason === 'bad_json', bad)
  check('坏 JSON 仍只调一次', calls === 1, calls)
  calls = 0
  const good = await clusterRefineForDay(db, aid, dayL2, async () => {
    calls++
    return JSON.stringify([
      { title: '上午', summary: '谈了接口与部署风险。' },
      { title: '下午', summary: '讨论关系页是否独立。' },
      { title: '晚上', summary: '确认情绪曲线画法。' },
    ])
  }, { clusterAt: 10 })
  check('簇修成功写 chapters', good.ok && good.chapters && good.chapters.length >= 3, good)
  check('簇修一天一次模型', calls === 1, calls)
  const clusters = listEpisodes(db, aid, { day: dayL2, limit: 80 }).filter((e) => e.session_id === '__day_cluster__')
  check('簇修行落库', clusters.length >= 3, clusters.length)
  const few = await clusterRefineForDay(db, aid, '2026-10-27', async () => '[]', { clusterAt: 100 })
  check('纪要少跳过簇修', few.skipped === true, few)
}

// ---- 日记：无模型拼装 / force 升版 / 低分过滤
{
  const dayD = '2026-10-25'
  const sD = 'diary_sess'
  turn(sD, 'user', '我想把小周记成同事', iso(Date.parse(dayD + 'T12:00:00+08:00')))
  turn(sD, 'assistant', '好，记下来了。', iso(Date.parse(dayD + 'T12:01:00+08:00')))
  turn(sD, 'user', '后端登录进不去怎么办？', iso(Date.parse(dayD + 'T12:02:00+08:00')))
  buildEpisodes(db, aid, { session: sD, day: dayD })
  const d1 = await buildDiary(db, aid, dayD, { summarize: null })
  check('无模型也能写日记', d1 && d1.day === dayD && d1.source === 'rules', d1 && { day: d1.day, source: d1.source })
  check('日记正文含要点', /小周|登录|后端/.test(String(d1.text || '')), String(d1.text || '').slice(0, 200))
  const d2 = await buildDiary(db, aid, dayD, { summarize: null, force: true })
  check('force 日记 version+1', Number(d2.version) === Number(d1.version) + 1, { v1: d1.version, v2: d2.version })
  const got = getDiary(db, aid, dayD)
  check('getDiary 取到最新', got && got.version === d2.version, got && got.version)

  const low = Array.from({ length: 20 }, (_, i) => ({
    id: 'lo' + i, title: '你好', summary: '寒暄', importance: 0.12, source: 'rules', end_at: iso(base + i),
  }))
  const high = [{ id: 'hi', title: '要不要独立关系页', summary: '讨论新建页签', importance: 0.9, source: 'rules', end_at: iso(base + 99) }]
  const pack = packDiaryMaterial({
    day: dayD, date: dayD, episodes: [...low, ...high], facts: [], raw: [],
    moodZh: '平静', tone: '平实', self: {}, minImportance: 0.25,
  }, 800)
  check('低分过滤后高分仍在', pack.material.episodes.some((e) => /独立关系页|新建页签/.test(e.title + e.summary)), pack.material.episodes)
}

// ---- nightly 串联：坏 summarize 不阻断巩固
{
  const dayN = '2026-10-24'
  const sN = 'night_sess'
  for (let i = 0; i < 10; i++) {
    turn(sN, 'user', `今晚要不要部署第${i}版？`, iso(Date.parse(dayN + 'T20:00:00+08:00') + i * 60_000))
  }
  const out = await runNightly(db, aid, {
    day: dayN,
    force: true,
    summarize: async () => { throw new Error('boom') },
  })
  const steps = Object.fromEntries((out.steps || []).map((s) => [s.step, s]))
  check('nightly 有 episodes 步', steps.episodes && steps.episodes.ok, steps.episodes)
  check('nightly 有 diary 步', !!steps.diary, steps.diary)
  check('模型抛错不让巩固整体崩', out.skipped !== true && Array.isArray(out.steps), out)
  const epN = listEpisodes(db, aid, { day: dayN, limit: 20 })
  check('nightly 后仍有规则纪要', epN.some((e) => e.source === 'rules'), epN.map((e) => e.source))
}

// ---- 重复 buildEpisodes 不炸唯一键
{
  const dayR = '2026-10-23'
  const sR = 'resize'
  for (let i = 0; i < 45; i++) {
    turn(sR, 'user', `长聊第${i}：怎么办？`, iso(Date.parse(dayR + 'T15:00:00+08:00') + i * 1000))
  }
  const a = buildEpisodes(db, aid, { session: sR, day: dayR })
  const b = buildEpisodes(db, aid, { session: sR, day: dayR })
  check('重复构建不增行数', a.length === b.length, { a: a.length, b: b.length })
  check('重复构建多为 updated', b.every((e) => e.updated === true), b.map((e) => e.updated))
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
