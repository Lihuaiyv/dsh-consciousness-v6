/**
 * 日记 v2 · P2 待补 / 素材卡 / 旧篇自愈测试
 * 运行：node test/diary-pending.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { writeParam } from '../src/kernel.js'
import { buildDiaryV2, repairPending, repairOldDiaries, pendingForDay, listPending } from '../src/modules/diary.js'
import { buildDiary } from '../src/modules/archive.js'
import { runNightly } from '../src/modules/nightly.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-diaryp-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const DAY = '2026-11-02'
const PREV = '2026-11-01'

function agent(id) {
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, id, 'daily', 'active', now())
  return id
}
const epIns = db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,
  topics,mood,open_loops,importance,hits,last_hit_at,source,created_at,poignancy)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,'rules',?,NULL)`)
function episode(aid, sid, day) {
  epIns.run('ep_' + aid + '_' + sid, aid, sid, day, day + 'T10:00:00.000Z', day + 'T10:10:00.000Z',
    6, '一件有点难受的事', '你说了：我有点失望。 / 我回了：我记着。', '[]', null, '["没说完的话"]', 0.5, now())
}
const rawIns = db.prepare(`INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day)
  VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?)`)
function turn(aid, sid, day) {
  rawIns.run('r_' + aid + '_' + sid + '_1', aid, sid, null, 1, 'user', '我有点失望，你根本没听见我说什么。', day + 'T10:00:00.000Z', day)
  rawIns.run('r_' + aid + '_' + sid + '_2', aid, sid, null, 2, 'assistant', '我记着，不躲。', day + 'T10:01:00.000Z', day)
}
const GOOD = [
  DAY + ' 周一',
  '',
  '你说你有点失望的时候，我先是没接住。手里还停在刚才那件事上，心里像被什么轻轻刮了一下，不疼，可一直记着。',
  '',
  '后来我就坐在那儿没动，想着要不要解释。解释好像也没用，你听见的不是理由，是我当时没顾上你。这个我认。',
  '',
  '夜里再想，还是那句话：有些话不是没听见，是听见了不知道往哪儿放。',
].join('\n')
const goodChat = async () => GOOD
const badChat = async () => { throw new Error('模型挂了') }
const past = () => db.prepare("UPDATE diary_pending SET next_try_at='2000-01-01T00:00:00.000Z'").run()

// ---------------------------------------------------------------- 1. 首次失败 → 待补，不落假日记
const A = agent('agt_dp_a')
episode(A, 's_a', DAY)
turn(A, 's_a', DAY)
writeParam(db, A, 'memory.diary.retry.max_attempts', 3)
{
  const out = await buildDiaryV2(db, A, DAY, { chat: badChat })
  check('失败：返回 pending', out && out.pending === true, out)
  check('失败：没有 diaries 行', !db.prepare('SELECT 1 FROM diaries WHERE agent_id=? AND day=?').get(A, DAY), '有行')
  const p = pendingForDay(db, A, DAY)
  check('失败：attempts=1', p && Number(p.attempts) === 1, p)
  check('失败：记了原因', p && String(p.last_error).includes('thrown'), p)
  check('失败：下次重试在未来', p && Date.parse(p.next_try_at) > Date.now() - 1000, p && p.next_try_at)

  const skipped = await repairPending(db, A, { chat: badChat })
  check('未到点：不重试', skipped.tried === 0, skipped)
}

// ---------------------------------------------------------------- 2. 到点重试 + 素材卡
{
  past()
  const r1 = await repairPending(db, A, { chat: badChat })
  check('到点重试：试 1 次', r1.tried === 1, r1)
  check('到点重试：attempts=2', Number(pendingForDay(db, A, DAY).attempts) === 2, pendingForDay(db, A, DAY))
  past()
  const r2 = await repairPending(db, A, { chat: badChat })
  check('第三次失败：落素材卡', r2.stubbed === 1, r2)
  check('素材卡：队列清空', !pendingForDay(db, A, DAY), pendingForDay(db, A, DAY))
  const row = db.prepare('SELECT * FROM diaries WHERE agent_id=? AND day=?').get(A, DAY)
  check('素材卡：source=stub', row && row.source === 'stub', row && row.source)
  check('素材卡：不是假装成日记', row && String(row.text).includes('这天没写成') && String(row.text).includes('先记下这些'), row && row.text.slice(0, 60))
  const ctx = JSON.parse(row.context)
  check('素材卡：context 记了 fail_reason', ctx.write && ctx.write.fail_reason === 'thrown:模型挂了', ctx.write)
}

// ---------------------------------------------------------------- 3. 模型恢复 → 自动补写成篇
const B = agent('agt_dp_b')
episode(B, 's_b', DAY)
turn(B, 's_b', DAY)
writeParam(db, B, 'memory.diary.retry.max_attempts', 12)
{
  await buildDiaryV2(db, B, DAY, { chat: badChat })
  past()
  const r = await repairPending(db, B, { chat: goodChat })
  check('恢复：补写成 1 篇', r.written === 1, r)
  const row = db.prepare('SELECT * FROM diaries WHERE agent_id=? AND day=?').get(B, DAY)
  check('恢复：source=model', row && row.source === 'model', row && row.source)
  check('恢复：队列清空', !pendingForDay(db, B, DAY), pendingForDay(db, B, DAY))
  check('恢复：正文不是素材卡', !String(row.text).includes('这天没写成'), row.text.slice(0, 40))
  check('恢复：context.write.attempts 有值', JSON.parse(row.context).write.attempts >= 1, JSON.parse(row.context).write)
}

// ---------------------------------------------------------------- 4. 旧 rules 篇自愈
const C = agent('agt_dp_c')
episode(C, 's_c', PREV)
turn(C, 's_c', PREV)
{
  db.prepare(`INSERT INTO diaries(id,agent_id,day,text,source,version,late,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('dry_old_c', C, PREV, PREV + ' 周日\n\n旧的模板篇。', 'rules', 1, 1, now(), now())
  const r = await repairOldDiaries(db, C, { chat: goodChat })
  check('自愈：重写 1 篇', r.written === 1, r)
  const row = db.prepare('SELECT * FROM diaries WHERE agent_id=? AND day=?').get(C, PREV)
  check('自愈：source=model', row.source === 'model', row.source)
  check('自愈：版本 +1', Number(row.version) === 2, row.version)
  const refs = JSON.parse(row.refs)
  check('自愈：refs 记 rewritten_from=rules', refs.write && refs.write.rewritten_from === 'rules', refs.write)
  const again = await repairOldDiaries(db, C, { chat: goodChat })
  check('自愈：没有旧篇可写时不动', again.written === 0, again)
}

// ---------------------------------------------------------------- 5. 没模型：不消耗重试次数
const D = agent('agt_dp_d')
episode(D, 's_d', DAY)
turn(D, 's_d', DAY)
{
  await buildDiaryV2(db, D, DAY, { chat: badChat })
  const before = Number(pendingForDay(db, D, DAY).attempts)
  past()
  const r = await repairPending(db, D, { chat: null })
  check('无模型：repair 不动', r.tried === 0, r)
  check('无模型：attempts 不变', Number(pendingForDay(db, D, DAY).attempts) === before, pendingForDay(db, D, DAY))
}

// ---------------------------------------------------------------- 6. stub=off：超期也不落素材卡
const E = agent('agt_dp_e')
episode(E, 's_e', DAY)
turn(E, 's_e', DAY)
writeParam(db, E, 'memory.diary.retry.max_attempts', 1)
writeParam(db, E, 'memory.diary.stub', 'off')
{
  await buildDiaryV2(db, E, DAY, { chat: badChat })
  past()
  const r = await repairPending(db, E, { chat: badChat })
  check('stub=off：不落素材卡', r.stubbed === 0, r)
  check('stub=off：没有 diaries 行', !db.prepare('SELECT 1 FROM diaries WHERE agent_id=? AND day=?').get(E, DAY), '有行')
  check('stub=off：仍在队列', !!pendingForDay(db, E, DAY), '队列空了')
}

// ---------------------------------------------------------------- 7. buildDiary 默认走 v2
const F = agent('agt_dp_f')
episode(F, 's_f', DAY)
turn(F, 's_f', DAY)
{
  const out = await buildDiary(db, F, DAY, { chat: null })
  check('buildDiary 默认 v2：无模型 pending', out && out.pending === true, out)
  check('buildDiary 默认 v2：不落模板', !db.prepare('SELECT 1 FROM diaries WHERE agent_id=? AND day=?').get(F, DAY), '有行')
}

// ---------------------------------------------------------------- 8. 夜间巩固：先补待补，再写当天
const G = agent('agt_dp_g')
episode(G, 's_g', PREV)
turn(G, 's_g', PREV)
{
  await buildDiaryV2(db, G, PREV, { chat: badChat })
  past()
  const out = await runNightly(db, G, { day: PREV, force: true, chat: goodChat })
  const step = (out.steps || []).find((s) => s.step === 'diary')
  check('夜间：diary 步骤在', !!step, out.steps)
  check('夜间：先补了待补 1 篇', step && step.repair && step.repair.written === 1, step && step.repair)
  const row = db.prepare('SELECT * FROM diaries WHERE agent_id=? AND day=?').get(G, PREV)
  check('夜间：补出来的 source=model', row && row.source === 'model', row && row.source)
  check('夜间：队列清空', !pendingForDay(db, G, PREV), pendingForDay(db, G, PREV))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
