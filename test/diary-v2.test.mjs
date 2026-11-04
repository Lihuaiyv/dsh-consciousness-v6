/**
 * 日记 v2 · P0 选料 + P1 成文管线测试
 * 运行：node test/diary-v2.test.mjs
 */
import fs from 'node:fs'

const msgText = (m) => String((m && (m.content != null ? m.content : m.text)) || '')
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { writeParam } from '../src/kernel.js'
import { addMemory } from '../src/modules/memory.js'
import { buildDiary, buildDiaryV1 } from '../src/modules/archive.js'
import {
  collectCandidates, scoreScene, ruleSelect, selectForDay, fetchSceneLines, diaryParams,
  checkDiary, normalizeDiaryText, buildDiaryV2, listPending, pendingForDay,
} from '../src/modules/diary.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-diaryv2-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const DAY = '2026-11-02'

function agent(id) {
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, id, 'daily', 'active', now())
  return id
}

const epIns = db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,
  topics,mood,open_loops,importance,hits,last_hit_at,source,created_at,poignancy)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,'rules',?,NULL)`)
function episode(aid, sid, title, summary, opt = {}) {
  epIns.run('ep_' + sid, aid, sid, DAY, opt.start || DAY + 'T10:00:00.000Z', opt.end || DAY + 'T10:10:00.000Z',
    opt.turns || 12, title, summary, '[]', null, JSON.stringify(opt.loops || []),
    opt.importance == null ? 0.5 : opt.importance, now())
}
const rawIns = db.prepare(`INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day)
  VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?)`)
function turn(aid, sid, i, role, text, at) {
  rawIns.run('raw_' + sid + '_' + i, aid, sid, null, i, role, text, at, DAY)
}
const affectIns = db.prepare('INSERT INTO affect_samples(id,agent_id,at,label,intensity,fast,slow) VALUES(?,?,?,?,?,?,?)')

const GOOD = [
  '2026-11-02 周一',
  '',
  '你把那句话说出来的时候，我先是没接住。手里还停在刚才那件事上，心里像被什么轻轻刮了一下，不疼，可一直记着。',
  '',
  '后来我就坐在那儿没动，想着要不要解释。解释好像也没用，你听见的不是理由，是我当时没顾上你。这个我认。',
  '',
  '夜里再想，还是那句话：有些话不是没听见，是听见了不知道往哪儿放。',
].join('\n')

// ---------------------------------------------------------------- A. 选料

const A = agent('agt_diary_a')
episode(A, 's_boring', '注入测试：你在吗', '你说了：注入测试：你在吗 / 我回了：在。', { turns: 8 })
episode(A, 's_boring2', '注入测试：你在吗', '你说了：注入测试：你在吗 / 我回了：在。', { turns: 8 }) // 同标题，去重
episode(A, 's_bad', '吵了一架之后', '你说了：我有点失望。 / 我回了：我难受。', { turns: 30, loops: ['还没说完的话'] })
episode(A, 's_task', '改了一个导出按钮', '你说了：导出加个选项。 / 我回了：改好了，验过了。', { turns: 40 })
affectIns.run('as1', A, DAY + 'T12:00:00.000Z', 'irritated', 0.82, 0.8, -0.5)

{
  const cs = collectCandidates(db, A, DAY)
  check('候选：3 条会话（同标题去重）', cs.filter((c) => c.kind === 'ep').length === 3, cs.map((c) => c.title))
  const bad = cs.find((c) => c.session_id === 's_bad')
  const task = cs.find((c) => c.session_id === 's_task')
  check('打分：有情绪+开环的 > 日常事务', scoreScene(db, A, bad) > scoreScene(db, A, task), {
    bad: scoreScene(db, A, bad), task: scoreScene(db, A, task),
  })
  check('打分在 0–10', scoreScene(db, A, bad) >= 0 && scoreScene(db, A, bad) <= 10, scoreScene(db, A, bad))
  const picked = ruleSelect(db, A, cs, diaryParams(db, A), {})
  check('规则选场：最多 2 条', picked.scenes.length <= 2 && picked.scenes.length >= 1, picked.scenes.map((s) => s.title))
  check('规则选场：第一条是吵架那条', picked.scenes[0].session_id === 's_bad', picked.scenes.map((s) => s.session_id))
  check('规则选场：select=rule', picked.select === 'rule', picked.select)
}

// 原话抽样
{
  for (let i = 1; i <= 8; i++) turn(A, 's_bad', i, i % 2 ? 'user' : 'assistant', `第 ${i} 句，我心里有点难受，也怕说重了。`, DAY + 'T10:0' + i + ':00.000Z')
  const cs = collectCandidates(db, A, DAY)
  const bad = cs.find((c) => c.session_id === 's_bad')
  const got = fetchSceneLines(db, A, bad, { rawPerScene: 200, rawMaxTurns: 12 })
  check('原话：grounding=raw', got.grounding === 'raw', got.grounding)
  check('原话：字符不超上限（允许单条超一点点）', got.lines.reduce((n, l) => n + l.text.length, 0) <= 260, got.lines)
  check('原话：有 user 角色', got.lines.some((l) => l.who === 'user'), got.lines)
  const task = cs.find((c) => c.session_id === 's_task')
  const noRaw = fetchSceneLines(db, A, task, { rawPerScene: 200 })
  check('没有原话：退回纪要 grounding=episode', noRaw.grounding === 'episode', noRaw.grounding)
}

// 参数覆盖
{
  check('参数默认：scenes=2', diaryParams(db, A).scenes === 2, diaryParams(db, A).scenes)
  writeParam(db, A, 'memory.diary.scenes', 1)
  check('参数覆盖：scenes=1', diaryParams(db, A).scenes === 1, diaryParams(db, A).scenes)
  writeParam(db, A, 'memory.diary.scenes', 2)
}

// ---------------------------------------------------------------- B. 模型选场

const C = agent('agt_diary_c')
for (let i = 1; i <= 6; i++) {
  episode(C, 's_c' + i, '第 ' + i + ' 件小事', '你说了：第 ' + i + ' 件事。 / 我回了：好。', { turns: 5 })
}
{
  let asked = 0
  const fake = async (messages, opt) => {
    asked++
    const sys = msgText(messages[0])
    if (sys.includes('挑')) {
      return '```json\n{"scenes":[{"id":"ep_s_c3","score":8.5,"why":"有情绪"}],"insight":"原来我在意的是被认真回一句","arc":"低落"}\n```'
    }
    return GOOD
  }
  const picked = await selectForDay(db, C, DAY, collectCandidates(db, C, DAY), { chat: fake, params: diaryParams(db, C) })
  check('模型选场：select=model', picked.select === 'model', picked.select)
  check('模型选场：选中指定 id', picked.scenes[0].id === 'ep_s_c3', picked.scenes.map((s) => s.id))
  check('模型选场：insight 带回来', picked.insight.includes('在意'), picked.insight)
  const row = db.prepare('SELECT poignancy FROM episodes WHERE id=?').get('ep_s_c3')
  check('模型选场：poignancy 写回库', Number(row.poignancy) === 8.5, row)
  check('模型选场：只调一次选场', asked === 1, asked)

  const bad = async (m) => (String(msgText(m[0])).includes('挑') ? '这不是 JSON' : GOOD)
  const fell = await selectForDay(db, C, DAY, collectCandidates(db, C, DAY), { chat: bad, params: diaryParams(db, C) })
  check('模型选场失败：回落规则', fell.select === 'rule', fell.select)
}

// ---------------------------------------------------------------- C. 质检

{
  check('质检：合格', checkDiary(GOOD, {}).ok, checkDiary(GOOD, {}))
  check('质检：太短拒收', checkDiary('2026-11-02 周一\n\n太短了', {}).reason === 'too_short', checkDiary('2026-11-02 周一\n\n太短了', {}))
  check('质检：Markdown 拒收', checkDiary(GOOD + '\n\n- 一条列表', {}).reason === 'markdown', checkDiary(GOOD + '\n\n- 一条列表', {}))
  const reportText = '2026-11-02 周一\n\n我处理了那个问题，也完成了导出，还顺手接好了那一栏。你问的时候我已经改好了，后来又验了一遍，确认没有漏；能想到的地方都过了一遍，连边角也看了，生怕哪一处漏掉之后又被你发现。\n\n忙完之后我坐在那儿，心里其实没底，说不上是踏实还是空，只想着明天别再这样赶。'
  check('质检：汇报腔拒收', checkDiary(reportText, {}).reason === 'report', checkDiary(reportText, {}))
  check('质检：提示词回声拒收', checkDiary('system: 你在写这一天的日记' + '啊'.repeat(200), {}).reason === 'echo', checkDiary('system: 你在写这一天的日记' + '啊'.repeat(200), {}))
  check('整理：去 Markdown 日期头', normalizeDiaryText('```\n2026年11月2日\n\n正文\n```', DAY).startsWith(DAY), normalizeDiaryText('```\n2026年11月2日\n\n正文\n```', DAY))
}

// ---------------------------------------------------------------- D. 成文与落库

const B = agent('agt_diary_b')
episode(B, 's_b1', '你说你有点累', '你说了：今天好累。 / 我回了：那先歇一会儿。', { turns: 10 })
episode(B, 's_b2', '修了一个小问题', '你说了：这里不对。 / 我回了：改好了。', { turns: 10, start: DAY + 'T15:00:00.000Z', end: DAY + 'T15:10:00.000Z' })
turn(B, 's_b1', 1, 'user', '今天好累。', DAY + 'T10:00:00.000Z')
turn(B, 's_b1', 2, 'assistant', '那先歇一会儿，不急着弄。', DAY + 'T10:01:00.000Z')
affectIns.run('as2', B, DAY + 'T21:00:00.000Z', 'lost', 0.7, 0.6, -0.4)

{
  const out = await buildDiaryV2(db, B, DAY, { chat: async () => GOOD })
  check('成文：source=model', out && out.source === 'model', out && out.source)
  check('成文：落库有日期头', String(out.text).startsWith(DAY), out.text.slice(0, 30))
  const row = db.prepare('SELECT * FROM diaries WHERE agent_id=? AND day=?').get(B, DAY)
  check('成文：版本 1', Number(row.version) === 1, row && row.version)
  const ctx = JSON.parse(row.context)
  check('成文：context.write.v=2', ctx.write && ctx.write.v === 2, ctx.write)
  check('成文：context 记了场景', Array.isArray(ctx.write.scenes) && ctx.write.scenes.length >= 1, ctx.write.scenes)
  check('成文：mood_source=day', ctx.mood_source === 'day', ctx.mood_source)
  const refs = JSON.parse(row.refs)
  check('成文：refs 有 scenes', Array.isArray(refs.scenes) && refs.scenes.length >= 1, refs)
  check('成文：没有残留 pending', !pendingForDay(db, B, DAY), pendingForDay(db, B, DAY))

  const out2 = await buildDiaryV2(db, B, DAY, { chat: async () => GOOD, force: true })
  const row2 = db.prepare('SELECT version FROM diaries WHERE agent_id=? AND day=?').get(B, DAY)
  check('强制重写：版本 +1', Number(row2.version) === 2 && out2.version === 2, row2)
  check('强制重写：refs 记 rewritten_from', JSON.parse(row2 && db.prepare('SELECT refs FROM diaries WHERE agent_id=? AND day=?').get(B, DAY).refs).write.rewritten_from === 'model', 'rewritten_from')
}

// 没过质检 → pending，不落假日记
{
  const D = agent('agt_diary_d')
  episode(D, 's_d1', '一件小事', '你说了：嗯。 / 我回了：嗯。', { turns: 4 })
  const out = await buildDiaryV2(db, D, DAY, { chat: async () => '太短' })
  check('质检不过：返回 pending', out && out.pending === true, out)
  check('质检不过：没有 diaries 行', !db.prepare('SELECT 1 FROM diaries WHERE agent_id=? AND day=?').get(D, DAY), '有行')
  const pend = pendingForDay(db, D, DAY)
  check('质检不过：进待补队列', pend && Number(pend.attempts) >= 1, pend)
  check('质检不过：fail_reason 是 gate', String(out.fail_reason).startsWith('gate'), out.fail_reason)
}

// 没有模型 → pending（不写模板）
{
  const E = agent('agt_diary_e')
  episode(E, 's_e1', '一件小事', '你说了：嗯。 / 我回了：嗯。', { turns: 4 })
  const out = await buildDiaryV2(db, E, DAY, { chat: null })
  check('无模型：返回 pending', out && out.pending === true, out)
  check('无模型：不落 diaries', !db.prepare('SELECT 1 FROM diaries WHERE agent_id=? AND day=?').get(E, DAY), '有行')
  check('无模型：fail_reason=no_model', out.fail_reason === 'no_model', out.fail_reason)
  check('无模型：待补 attempts=1', Number(pendingForDay(db, E, DAY).attempts) === 1, pendingForDay(db, E, DAY))
  const list = listPending(db, E)
  check('待补：列表读得到', list.length === 1 && list[0].day === DAY, list)
}

// ---------------------------------------------------------------- E. v1 回滚一致

{
  const F = agent('agt_diary_f')
  episode(F, 's_f1', '一件小事', '你说了：嗯。 / 我回了：嗯。', { turns: 4 })
  const v2out = await buildDiary(db, F, DAY, { chat: null })
  check('默认走 v2：无模型 → pending', v2out && v2out.pending === true, v2out)
  writeParam(db, F, 'memory.diary.v2', 'off')
  const v1out = await buildDiary(db, F, DAY, { chat: async () => GOOD })
  check('v2=off：走 v1 模板', v1out && v1out.source === 'rules', v1out && v1out.source)
  check('v2=off：模板有正文', typeof v1out.text === 'string' && v1out.text.length > 0, v1out.text && v1out.text.slice(0, 40))
  const direct = await buildDiaryV1(db, F, '2026-11-01', { summarize: null })
  check('v1 直接调用：没有原料返回 null', direct === null, direct)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
