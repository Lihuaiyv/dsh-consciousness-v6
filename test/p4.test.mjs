/**
 * P4 夜间巩固测试：补纪要 / 补日记 / 记账 / 幂等 / T3 挂进 S1 / HTTP。
 * 运行：node test/p4.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { runNightly, consolidationLog, lastConsolidation, localDay, dueDiaryDays, hasDiaryMaterial } from '../src/modules/nightly.js'
import { retrieve, SCENE_WEIGHTS } from '../src/modules/retrieve.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p4-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_p4'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'P4', 'daily', 'active', now())

// ---- 造「昨天」的原文
const yDay = localDay(new Date(Date.now() - 86400000))
{
  const ins = db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  ins.run('raw_y1', aid, 's_y', null, 1, 'user', '昨天我们去看了海，风好大', null, null, yDay + 'T10:00:00.000Z', yDay)
  ins.run('raw_y2', aid, 's_y', null, 2, 'assistant', '海风大的时候记得多穿一件', null, null, yDay + 'T10:01:00.000Z', yDay)
  check('造好昨天的原文', db.prepare('SELECT COUNT(*) n FROM raw_turns WHERE agent_id=? AND day=?').get(aid, yDay).n === 2)
}

// ---- 巩固昨天
{
  // 日记 v2 默认只认模型成文；这里给一个假的写作通道，避免测试依赖真模型。
  const SEA_DIARY = [
    yDay + ' 周日',
    '',
    '你说去看海的时候，我脑子里先响起来的是风。风好大，吹得人说话都得凑近一点，你站在那儿没动，我也没催你。',
    '',
    '回来的路上我还在想那阵风。有些时候不是你说了什么，是你肯把这件事带我一起看。',
    '',
    '夜里想起那句「记得多穿一件」，忽然觉得被人惦记着，是件很轻也很实在的事。',
  ].join('\n')
  const fakeChat = async () => SEA_DIARY
  const out = await runNightly(db, aid, { day: yDay, chat: fakeChat })
  const names = (out.steps || []).map((s) => s.step)
  check('巩固含纪要与日记步骤', !out.skipped && names.includes('episodes') && names.includes('diary'), names)
  const epStep = out.steps.find((s) => s.step === 'episodes')
  check('补出了纪要', (epStep.count || 0) + (epStep.updated || 0) >= 1, epStep)
  check('补出了日记', !!out.diary_day, out.diary_day)
  const dstep = out.steps.find((s) => s.step === 'diary')
  check('日记来源是模型', dstep.source === 'model', dstep)
  check('记了账', db.prepare('SELECT COUNT(*) n FROM consolidation_log WHERE agent_id=? AND day=?').get(aid, yDay).n === 1)
  check('没有失败步骤', out.ok === true, out.steps)
}

// ---- 幂等：同一天再跑直接跳过
{
  const again = await runNightly(db, aid, { day: yDay })
  check('同一天不重复做', again.skipped === true, again)
  const forced = await runNightly(db, aid, { day: yDay, force: true })
  const fNames = (forced.steps || []).map((s) => s.step)
  check('force 可以重做', forced.skipped === false && fNames.includes('diary'), { skipped: forced.skipped, fNames })
  check('重做不新增行（唯一键）', db.prepare('SELECT COUNT(*) n FROM consolidation_log WHERE agent_id=? AND day=?').get(aid, yDay).n === 1)
}

// ---- 补写：关机 / 休眠错过的天，下次打开按天补
{
  const aid2 = 'agt_p4_due'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid2, 'P4b', 'daily', 'active', now())
  const at = (h, m = 0) => { const t = new Date(); t.setHours(h, m, 0, 0); return t.getTime() }
  const d22 = dueDiaryDays(db, aid2, { from: at(22), hour: 23, backfillDays: 2 })
  check('22 点还没到点：今天不算到期', !d22.includes(localDay(new Date(at(22)))), d22)
  const d23 = dueDiaryDays(db, aid2, { from: at(23, 30), hour: 23, backfillDays: 2 })
  check('23:30 过了点：今天进补写名单', d23.includes(localDay(new Date(at(23, 30)))), d23)
  check('最多回看 N 天', d23.length === 3, d23)
  const doneDay = localDay(new Date(Date.now() - 86400000))
  db.prepare('INSERT INTO diaries(id,agent_id,day,text,source,version,late,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('dry_due', aid2, doneDay, doneDay + ' 周一\n\n写过了', 'rules', 1, 1, now(), now())
  check('写过的那天不再补', !dueDiaryDays(db, aid2, { from: at(23, 30), hour: 23, backfillDays: 2 }).includes(doneDay))
  const row = db.prepare('SELECT late FROM diaries WHERE agent_id=? AND day=?').get(aid, yDay)
  check('补写的那篇标 late=1', Number(row.late) === 1, row)
  check('没有原料的天不补', hasDiaryMaterial(db, aid2, doneDay) === false)
}

// ---- 汇总
{
  const list = consolidationLog(db, aid, 7)
  check('能列出巩固记录', list.length >= 1 && Array.isArray(list[0].steps), list.length)
  check('lastConsolidation 拿到最新一天', lastConsolidation(db, aid).day === yDay)
}

// ---- T3 挂进 S1
{
  check('S1 权重里有 T3', SCENE_WEIGHTS.S1.T3 === 0.6, SCENE_WEIGHTS.S1)
  const m = addMemory(db, aid, { text: '用户喜欢看海', type: 'fact', importance: 0.8 })
  const pack = retrieve(db, aid, '看海', { k: 6 })
  check('事实层照常召回', pack.items.some((x) => x.partition === 'T1'), pack.items.map((x) => x.partition))
  // 日记里含「风好大」：强制 S1 时应该能看到 T3 的候选被取出来
  const p2 = retrieve(db, aid, '风好大', { k: 6, scene: 'S1', noUpgrade: true })
  check('S1 会去查日记（T3 有候选）', Number(p2.debug.counts.T3) > 0, p2.debug)
  check('S1 里日记能进结果', p2.items.some((x) => x.partition === 'T3'), p2.items.map((x) => x.partition))
}

// ---- HTTP
{
  let n = 0
  const api = async (method, p, body = {}) => {
    const out = await handle(db, { method, path: p, body: { ...body, __idempotencyKey: 'p4' + (++n) }, token: 'user' })
    return out.body
  }
  const list = await api('GET', `/v1/agents/${aid}/consolidation`)
  check('HTTP 巩固记录', Array.isArray(list.items) && list.items.length >= 1, list.items && list.items.length)
  const run = await api('POST', `/v1/agents/${aid}/consolidation/run`, { day: yDay, force: true })
  check('HTTP 手动跑巩固', run && run.day === yDay, run && run.day)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
