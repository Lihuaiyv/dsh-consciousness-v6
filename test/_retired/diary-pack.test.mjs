/**
 * 纪要→日记 D0–D3：打包构成、prefer_cluster、日情绪、截断、缺日记修复。
 * 运行：node test/diary-pack.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'

/** 指定本地日的钟点 → ISO（写入 raw_turns 后 day 仍落在该本地日） */
function atLocal(day, h = 12, m = 0) {
  const [y, mo, d] = String(day).split('-').map(Number)
  return new Date(y, mo - 1, d, h, m, 0).toISOString()
}
import { attachDb } from '../src/algo/index.js'
import {
  packDiaryMaterial, DIARY_MATERIAL_BUDGET, buildDiary, getDiary,
  clipDiaryBody, diaryMoodForDay, appendTurn, buildEpisodes,
} from '../src/modules/archive.js'
import { runNightly, localDay } from '../src/modules/nightly.js'
import { writeParam } from '../src/kernel.js'
import { handle } from '../src/api.js'

process.env.DSHC_TEST_NO_LIMIT = '1'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-diary-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_diary_d'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
  .run(aid, 'diary', 'daily', 'active', now())

// ---- D0 meta 构成
{
  const eps = [
    { title: '簇上午', summary: '谈了部署。', importance: 0.78, source: 'model', session_id: '__day_cluster__', end_at: 'T1' },
    { title: '簇下午', summary: '谈了关系页。', importance: 0.78, source: 'model', session_id: '__day_cluster__', end_at: 'T2' },
    { title: '精修段', summary: '决定先切段再精修。', importance: 0.8, source: 'model', session_id: 's1', end_at: 'T3' },
    ...Array.from({ length: 20 }, (_, i) => ({
      title: '规则' + i, summary: '对方：随便聊聊' + i, beats: ['随便聊聊' + i],
      importance: 0.6, source: 'rules', session_id: 's' + i, end_at: 'T4' + i,
    })),
  ]
  const packed = packDiaryMaterial({
    day: '2026-10-30', date: '2026年10月30日 周五',
    episodes: eps, facts: [], raw: [], moodZh: '平静', tone: '平实', self: {},
    minImportance: 0.25, preferCluster: true, l0FillRatio: 0.45,
  }, DIARY_MATERIAL_BUDGET)
  check('D0 meta 有 n_cluster', Number(packed.meta.n_cluster) >= 2, packed.meta)
  check('D0 meta 有 n_model', Number(packed.meta.n_model) >= 1, packed.meta)
  check('D0 prefer_cluster 开启', packed.meta.prefer_cluster === true, packed.meta)
  check('D0 chars 不超预算', packed.meta.chars <= DIARY_MATERIAL_BUDGET, packed.meta)
}

// ---- D1 prefer_cluster：L0 受 fill 约束
{
  const clusters = Array.from({ length: 4 }, (_, i) => ({
    title: '时段' + i, summary: ('簇修摘要内容要足够长才占预算。').repeat(8) + i,
    importance: 0.78, source: 'model', session_id: '__day_cluster__', end_at: 'C' + i,
  }))
  const rules = Array.from({ length: 30 }, (_, i) => ({
    title: '低优规则' + i, summary: ('规则纪要正文占坑。').repeat(6) + i,
    beats: ['规则要点' + i], importance: 0.7, source: 'rules', session_id: 'r' + i, end_at: 'R' + i,
  }))
  const withPrefer = packDiaryMaterial({
    day: 'x', date: 'x', episodes: [...clusters, ...rules], facts: [], raw: [],
    moodZh: '平静', tone: '平实', self: {}, preferCluster: true, l0FillRatio: 0.2,
  }, 2200)
  const offPrefer = packDiaryMaterial({
    day: 'x', date: 'x', episodes: [...clusters, ...rules], facts: [], raw: [],
    moodZh: '平静', tone: '平实', self: {}, preferCluster: false, l0FillRatio: 0.2,
  }, 2200)
  check('D1 有簇时进了簇', withPrefer.meta.n_cluster >= 1, withPrefer.meta)
  check('D1 prefer 时规则条数受限', withPrefer.meta.n_rules <= offPrefer.meta.n_rules, {
    with: withPrefer.meta.n_rules, off: offPrefer.meta.n_rules,
  })
  check('D1 关 prefer 仍能打包', offPrefer.material.episodes.length >= 1, offPrefer.meta)
}

// ---- D2 clip + mood
{
  const long = '开头。' + '这是一句完整的话。'.repeat(200)
  const clipped = clipDiaryBody(long, 120)
  check('D2 截断不超长', clipped.length <= 120, clipped.length)
  check('D2 优先句号收尾', /[。！？]$/.test(clipped) || clipped.length === 120, clipped.slice(-8))

  const dayM = '2026-10-22'
  db.prepare(`INSERT INTO affect_state(agent_id,primary_label,intensity,mood,updated_at)
    VALUES(?,?,?,?,?)`).run(aid, 'calm', 0.2, 0.5, now())
  db.prepare(`INSERT INTO affect_episodes(id,agent_id,cause,label,intensity,started_at)
    VALUES(?,?,?,?,?,?)`).run('ae1', aid, '忙', 'frustrated', 0.81, dayM + 'T18:00:00.000Z')
  const mood = diaryMoodForDay(db, aid, dayM)
  check('D2 日情绪优先当日 episode', mood.mood_source === 'day' && mood.label === 'frustrated', mood)
  const live = diaryMoodForDay(db, aid, '2099-01-01')
  check('D2 无当日时退 live', live.mood_source === 'live' && live.label === 'calm', live)
}

// ---- D2/D3 buildDiary mood_source + force
{
  const dayD = '2026-10-21'
  appendTurn(db, aid, { sessionId: 'dpack', role: 'user', text: '小周是我同事，记住。', at: atLocal(dayD, 12, 0) })
  appendTurn(db, aid, { sessionId: 'dpack', role: 'user', text: '后端登录怎么办？', at: atLocal(dayD, 12, 1) })
  buildEpisodes(db, aid, { session: 'dpack', day: dayD })
  db.prepare(`INSERT INTO affect_episodes(id,agent_id,cause,label,intensity,started_at)
    VALUES(?,?,?,?,?,?)`).run('ae2', aid, '登录', 'curious', 0.66, dayD + 'T12:30:00.000Z')
  const d1 = await buildDiary(db, aid, dayD, { summarize: null })
  check('D2 日记 mood_source=day', d1.mood_source === 'day', d1)
  check('D2 context 记下 mood_source', d1.context?.write?.mood_source === 'day', d1.context?.write)
  check('D0 pack meta 写入 context', d1.pack && typeof d1.pack.n_rules === 'number', d1.pack)
  const d2 = await buildDiary(db, aid, dayD, { summarize: null, force: true })
  check('D3 force version+1', Number(d2.version) === Number(d1.version) + 1, { v1: d1.version, v2: d2.version })
}

// ---- D3 缺日记修复
{
  const dayR = '2026-10-20'
  appendTurn(db, aid, { sessionId: 'repair', role: 'user', text: '今晚要不要部署？', at: atLocal(dayR, 20, 0) })
  check('D3 原料落在本地日', db.prepare('SELECT day FROM raw_turns WHERE session_id=?').get('repair').day === dayR)
  const first = await runNightly(db, aid, { day: dayR, summarize: null })
  check('D3 首次巩固写出日记', !!first.diary_day && !first.skipped, first)
  db.prepare('DELETE FROM diaries WHERE agent_id=? AND day=?').run(aid, dayR)
  check('D3 模拟日记丢失', !getDiary(db, aid, dayR))
  const repaired = await runNightly(db, aid, { day: dayR, summarize: null })
  check('D3 有账无日记会修复', repaired.repaired === true && !!getDiary(db, aid, dayR), repaired)
  const diaryStep = (repaired.steps || []).find((s) => s.step === 'diary')
  check('D3 修复步带 pack', diaryStep && diaryStep.pack && typeof diaryStep.pack.chars === 'number', diaryStep)
}

// ---- HTTP rewrite
{
  const dayH = '2026-10-19'
  appendTurn(db, aid, { sessionId: 'httpd', role: 'user', text: '关系页独立出来好不好？', at: atLocal(dayH, 11, 0) })
  await buildDiary(db, aid, dayH, { summarize: null })
  const before = getDiary(db, aid, dayH)
  const out = await handle(db, {
    method: 'POST',
    path: '/v1/agents/' + aid + '/diaries/rewrite',
    body: { day: dayH, __idempotencyKey: 'diary-rewrite-1' },
    token: 'user',
  })
  check('D3 HTTP rewrite 200', out.status === 200 && out.body && out.body.day === dayH, { status: out.status, body: out.body })
  check('D3 HTTP rewrite 升版本', Number(out.body.version) === Number(before.version) + 1, { before: before.version, after: out.body && out.body.version })
}

// ---- 参数关 prefer
{
  writeParam(db, aid, 'memory.diary.prefer_cluster', 'off')
  const dayP = '2026-10-18'
  // 造簇+规则
  db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,seg,start_at,end_at,turns,title,summary,topics,beats,open_loops,importance,source,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'ep_c1', aid, '__day_cluster__', dayP, 0, now(), now(), 0, '簇', '簇摘要很长用来占位。', '[]', '[]', '[]', 0.78, 'model', now(),
  )
  for (let i = 0; i < 5; i++) {
    db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,seg,start_at,end_at,turns,title,summary,topics,beats,open_loops,importance,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'ep_r' + i, aid, 'sx' + i, dayP, 0, now(), now(), 3, '规则' + i, '规则摘要' + i, '[]', JSON.stringify(['要点' + i]), '[]', 0.7, 'rules', now(),
    )
  }
  appendTurn(db, aid, { sessionId: 'sx0', role: 'user', text: '占位原料', at: atLocal(dayP, 9, 0) })
  const built = await buildDiary(db, aid, dayP, { summarize: null, force: true })
  check('D1 关参后 prefer_cluster=false', built.pack && built.pack.prefer_cluster === false, built.pack)
  writeParam(db, aid, 'memory.diary.prefer_cluster', 'on')
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
