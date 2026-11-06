/**
 * 记忆整理零件 · 考卷
 *
 * 管的是「把重复的自省合成一条、把一段日子的流水压成一条结论」：
 * 聚类 → 调模型 → 合并稿落库 → 被合并的退场（软删，能顺着指针找回）。
 *
 * 不管「记忆怎么衰减」（记忆衰减与分层）、不管「写不写」（记忆写入闸）。
 *
 * 运行：node test/exam-consolidate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { model } from '../src/kernel.js'
import { addMemory } from '../src/modules/memory.js'
import {
  planBatches, mergeBatch, consolidatePending, reflectFrom, clusterRows, isThin,
  reflectCursor, bumpReflect, resetReflect, canConsolidate,
} from '../src/modules/consolidate.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-exam-csl-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_exam_csl'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '考卷整理', 'daily', 'active', new Date().toISOString())

const realComplete = model.complete
const realCaps = model.capabilities
model.capabilities = () => ({ ...(realCaps ? realCaps.call(model) : {}), complete: true })
let calls = 0
function stub(reply) {
  model.complete = async () => { calls++; return typeof reply === 'function' ? reply(calls) : reply }
}

const REPEAT = [
  '用户在这段对话中只说了“继续”，没有透露可验证的个人事实，偏好推进当前任务。',
  '用户在对话中只说了“继续”，未提供新的个人信息，希望助手接着推进当前任务。',
  '用户只说了“继续”，没有透露身份或背景，倾向让助手延续当前任务。',
  '这段对话里用户只说了继续，没有提供个人信息，希望继续当前任务。',
  '用户又说继续，没有新信息，还是想接着推进手上的事。',
]
const seedRepeat = (n = 5) => REPEAT.slice(0, n).map((t) => addMemory(db, aid, { text: t, type: 'reflection' }).id)

// ================================================================ 先看有没有模型
{
  check('替身模型在：能整理', canConsolidate() === true)
}

// ================================================================ 聚类：同义的才凑一批
{
  const ids = seedRepeat(5)
  const keepFact = addMemory(db, aid, { text: '用户喜欢美式咖啡不加糖', type: 'fact' }).id
  const batches = planBatches(db, aid, { limit: 5 })
  const hit = batches.find((b) => b.filter((m) => ids.includes(m.id)).length >= 3)
  check('同义的几条聚成一批', !!hit, batches.map((b) => b.length))
  check('fact 不参与自省整理', !batches.some((b) => b.some((m) => m.id === keepFact)))
  check('批最多 3 条（maxBatch）', planBatches(db, aid, { maxBatch: 3, limit: 5 }).every((b) => b.length <= 3))

  const few = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-exam-csl2-')), 'a.db'))
  few.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run('agt_few', 'f', 'daily', 'active', new Date().toISOString())
  addMemory(few, 'agt_few', { text: '用户只说了继续，没有新信息', type: 'reflection' })
  addMemory(few, 'agt_few', { text: '用户只说了继续，没有新信息，接着来', type: 'reflection' })
  check('只有两条：不够一批', planBatches(few, 'agt_few', {}).length === 0)
  check('不相干的不会硬并', planBatches(few, 'agt_few', { minSim: 0.95 }).length === 0)
}

// ================================================================ 合并一批：写稿 + 旧条退场
{
  const members = planBatches(db, aid, { limit: 1 })[0]
  check('拿到一批用来合并', members.length >= 3, members && members.length)
  stub('{"keep":true,"text":"用户一直只说继续，没有新的个人信息，是想接着推进当前任务。","importance":0.4}')
  const out = await mergeBatch(db, aid, members)
  check('合并成功、写了一条', out.ok === true && out.keep === true && !!out.id, out)
  const created = db.prepare('SELECT text,type,source,importance FROM memory_items WHERE id=?').get(out.id)
  check('合并稿是 reflection / source=consolidate', created && created.type === 'reflection' && created.source === 'consolidate', created)
  check('分量按模型给的来', Number(created.importance) === 0.4, created)
  const olds = db.prepare('SELECT id,invalid_at,superseded_by FROM memory_items WHERE id IN (' + members.map(() => '?').join(',') + ')').all(...members.map((m) => m.id))
  check('旧条全部退场', olds.every((r) => r.invalid_at), olds)
  check('旧条指向合并稿', olds.every((r) => r.superseded_by === out.id), olds)
  check('退场条数对得上', Array.isArray(out.superseded) ? out.superseded.length === members.length : out.superseded === members.length, out.superseded)
}

// ================================================================ 不合规的模型回复：一条都不动
{
  seedRepeat(5)
  const members = planBatches(db, aid, { limit: 1 })[0]
  const before = db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND invalid_at IS NOT NULL').get(aid).n
  if (!members) { check('还有一批可以试', false, '没有可用批'); }
  else {
    stub('我觉得它们挺像的，但我不想输出 JSON。')
    const bad = await mergeBatch(db, aid, members)
    const after = db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND invalid_at IS NOT NULL').get(aid).n
    check('解析失败：不写也不退场', bad.ok === false && bad.reason === 'unparsable' && after === before, { bad, before, after })

    stub('{"keep":false,"reason":"都是流水账"}')
    const drop = await mergeBatch(db, aid, members)
    check('模型说没价值：不写合并稿', drop.ok === true && drop.keep === false && !drop.id, drop)
    const still = db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND invalid_at IS NOT NULL').get(aid).n
    check('说没价值时旧条也先留着（由上层决定退不退）', still === after, { after, still })

    stub('{"keep":true,"text":"只合这一条","importance":0.5}')
    const dry = await mergeBatch(db, aid, members, { dryRun: true })
    check('dryRun：只出方案不落库', dry.ok === true && dry.dryRun === true && !dry.id, dry)
    check('dryRun 之后旧条也没退', db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND invalid_at IS NOT NULL').get(aid).n === after)
  }
  check('太少（1 条）：too few', (await mergeBatch(db, aid, [members ? members[0] : { id: 'x', text: 'y' }])).reason === 'too few')
}

// ================================================================ 反思：只压流水账，不吞事实
{
  // 清一块白纸
  db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(aid)
  // 游标先开窗：窗口从这一刻起，后面的记忆都算进来
  bumpReflect(db, aid, 0.5, Date.now())
  const acc1 = reflectCursor(db, aid).acc
  bumpReflect(db, aid, 0.25, Date.now())
  check('累加：0.5 → 0.75', Math.abs(reflectCursor(db, aid).acc - 0.75) < 1e-9, { acc1, now: reflectCursor(db, aid).acc })
  check('负数不往回减', bumpReflect(db, aid, -9, Date.now()) === 0.75)
  const thin1 = addMemory(db, aid, { text: '今天天气晴朗，出去走了走。', type: 'episode', importance: 0.2 }).id
  const thin2 = addMemory(db, aid, { text: '今天天气不错，出门走了几步。', type: 'episode', importance: 0.2 }).id
  const keep = addMemory(db, aid, { text: '用户喜欢美式咖啡不加糖，这件事要一直记着。', type: 'fact', importance: 0.9 }).id
  const pending = addMemory(db, aid, { text: '我还没想好要不要去看海，等忙完这阵之后再说。', type: 'episode', importance: 0.2 }).id

  check('流水账：算可压的', isThin(db.prepare('SELECT * FROM memory_items WHERE id=?').get(thin1)) === true)
  check('重要的：不压', isThin(db.prepare('SELECT * FROM memory_items WHERE id=?').get(keep)) === false)
  check('带未完成状态的：不压', isThin(db.prepare('SELECT * FROM memory_items WHERE id=?').get(pending)) === false)
  check('同话题两条能聚', clusterRows([
    { id: 'a', text: '今天天气晴朗' }, { id: 'b', text: '今天天气不错' }, { id: 'c', text: '内存条坏了' },
  ]).length >= 2)
  check('全是散的：返回空', clusterRows([{ id: 'a', text: '今天晴朗' }, { id: 'b', text: '内存条坏' }]).length === 0)

  stub('{"keep":true,"text":"这段时间天气都不错，她出门走了走；别的没什么要紧的。","importance":0.4}')
  const dry = await reflectFrom(db, aid, { dryRun: true, force: true })
  check('反思 dryRun：出结论不落库', dry.ok === true && dry.dryRun === true && !dry.id, dry)
  check('dryRun 不清游标', reflectCursor(db, aid).acc === 0.75)

  const out = await reflectFrom(db, aid, { force: true })
  check('反思写成一条', out.ok === true && out.keep === true && !!out.id, out)
  const created = db.prepare('SELECT text,type,source FROM memory_items WHERE id=?').get(out.id)
  check('反思是 reflection / source=reflect', created && created.type === 'reflection' && created.source === 'reflect', created)
  check('流水账被压掉', db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(thin1).invalid_at, thin1)
  check('重要事实原样留着', !db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(keep).invalid_at)
  check('未完成状态原样留着', !db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(pending).invalid_at)
  const ev = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='memory.reflect_merged'").get(aid)
  check('留一条合并回链', !!ev && JSON.parse(ev.payload).by === out.id, ev)
  check('反思完游标清零', reflectCursor(db, aid).acc === 0)
  check('记下这次反思的时间', !!reflectCursor(db, aid).last_reflect_at)

  resetReflect(db, aid, Date.now())
  check('reset：清零并记时间', reflectCursor(db, aid).acc === 0 && !!reflectCursor(db, aid).last_reflect_at)
}

// ================================================================ 跑一批：没料就不硬跑
{
  db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(aid)
  const out = await consolidatePending(db, aid, { limit: 3 })
  check('空库：不跑也不炸', out.ok === true && out.done === 0, out)
}

model.complete = realComplete
model.capabilities = realCaps
db.close?.()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
