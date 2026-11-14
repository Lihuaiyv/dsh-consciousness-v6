/**
 * 模型预算零件 · 考卷
 *
 * 管的是「今天还能不能再叫一次模型」：日顶、分桶记账、蒸馏满了或顶见底就该推迟抽取。
 * 不跑模型，不写记忆正文。
 *
 * 运行：node test/exam-budget.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { writeParam } from '../src/kernel.js'
import {
  llmBudgetAllow, llmBudgetBump, llmBudgetSnapshot, llmDailyCap, shouldDeferExtract, deferExtractForDay,
  llmDiaryAllow, llmDiarySnapshot, llmDiaryCap,
} from '../src/modules/llm_budget.js'
import { enqueueExtraction } from '../src/modules/extract_queue.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-budget-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_budget'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'budget', 'daily', 'active', now())

const D1 = '2026-11-01'
const D2 = '2026-11-02'
const D3 = '2026-11-03'
const D4 = '2026-11-04'
const D5 = '2026-11-05'

// ================================================================ 默认不限额，照样记账
{
  check('默认日顶是 16', llmDailyCap(db, aid) === 16)
  writeParam(db, aid, 'memory.llm.daily_cap', 0)
  check('拧成 0 就是不限额', llmBudgetAllow(db, aid, D1, 1).ok === true)

  const a = llmBudgetBump(db, aid, 'refine', D1, 1)
  check('记一次提炼', a.used === 1 && a.detail.refine === 1, a)
  const b = llmBudgetBump(db, aid, 'diary', D1, 2)
  check('日记按次数记进自己的桶', b.used === 3 && b.detail.diary === 2, b)
  const c = llmBudgetBump(db, aid, 'nope', D1, 1)
  check('不认识的种类记进抽取桶', c.used === 4 && c.detail.extract === 1 && c.detail.refine === 1, c)
  const k = llmBudgetBump(db, aid, 'cluster', D1, 1)
  check('聚类记进自己的桶', k.detail.cluster === 1 && k.detail.extract === 1, k)
  check('不限额、已经记了几次，仍许', llmBudgetAllow(db, aid, D1, 1).ok === true)

  const other = llmBudgetSnapshot(db, aid, D2)
  check('另一天是空账', other.used === 0 && other.detail.refine === 0 && other.detail.extract === 0, other)
}

// ================================================================ 蒸馏自己的顶
{
  for (let i = 0; i < 5; i++) llmBudgetBump(db, aid, 'distill', D2, 1)
  const early = shouldDeferExtract(db, aid, D2)
  check('蒸馏没满，不推迟抽取', early.defer === false, early)
  llmBudgetBump(db, aid, 'distill', D2, 1)
  const full = shouldDeferExtract(db, aid, D2)
  check('蒸馏记满就推迟抽取', full.defer === true && full.reason === 'distill_cap', full)
}

// ================================================================ 拧开日顶才挡
{
  writeParam(db, aid, 'memory.llm.daily_cap', 4)
  check('日顶拧到 4，空的一天还许一次', llmDailyCap(db, aid) === 4 && llmBudgetAllow(db, aid, D3, 1).ok === true)
  llmBudgetBump(db, aid, 'extract', D3, 3)
  const mid = llmBudgetAllow(db, aid, D3, 1)
  const over = llmBudgetAllow(db, aid, D3, 2)
  check('剩 1 次时许 1 次、不许 2 次', mid.ok === true && over.ok === false, { mid, over })
  llmBudgetBump(db, aid, 'extract', D3, 1)
  const snap = llmBudgetSnapshot(db, aid, D3)
  check('记满之后不许再记', llmBudgetAllow(db, aid, D3, 1).ok === false && snap.used === 4 && snap.left === 0, snap)

  writeParam(db, aid, 'memory.llm.daily_cap', 2)
  llmBudgetBump(db, aid, 'extract', D4, 2)
  const defer = shouldDeferExtract(db, aid, D4)
  check('顶见底就推迟抽取', defer.defer === true && defer.reason === 'daily_cap', defer)
}

// ================================================================ 蒸馏开关关掉
{
  writeParam(db, aid, 'memory.llm.daily_cap', 0)
  writeParam(db, aid, 'memory.episode.distill', 'off')
  llmBudgetBump(db, aid, 'distill', D5, 6)
  const off = shouldDeferExtract(db, aid, D5)
  check('蒸馏关掉后，记满也不为它推迟', off.defer === false, off)
  writeParam(db, aid, 'memory.llm.daily_cap', 100)
  check('顶写成 100 会被夹到 64', llmDailyCap(db, aid) === 64)
}

{
  enqueueExtraction(db, aid, [{ role: 'user', text: '预算推迟这一条' }])
  const n = deferExtractForDay(db, aid, D5, 'daily_cap')
  const row = db.prepare('SELECT next_at, last_error, state FROM extract_queue WHERE agent_id=?').get(aid)
  const [y, m, dd] = D5.split('-').map(Number)
  const nextMorning = new Date(y, m - 1, dd + 1, 0, 5, 0).toISOString()
  check('满了就把抽取推迟到次日', n === 1 && row && row.state === 'pending' && row.last_error === 'deferred:daily_cap' && row.next_at === nextMorning, row)
}

// ================================================================ 日记单独立额：抽取再忙也挤不掉它
{
  const D6 = '2026-11-06'
  writeParam(db, aid, 'memory.llm.daily_cap', 4)
  check('日记默认日额是 8', llmDiaryCap(db, aid) === 8)
  // 总顶被抽取吃满
  llmBudgetBump(db, aid, 'extract', D6, 4)
  check('总顶吃满：抽取不许', llmBudgetAllow(db, aid, D6, 1).ok === false)
  check('总顶吃满：日记仍许', llmDiaryAllow(db, aid, D6, 1).ok === true)
  // 日记自己记账：记账进总顶，但日记额度只数自己的桶
  for (let i = 0; i < 8; i++) llmBudgetBump(db, aid, 'diary', D6, 1)
  check('日记记满 8 次就不许', llmDiaryAllow(db, aid, D6, 1).ok === false)
  check('日记的已用只数日记桶', llmDiarySnapshot(db, aid, D6).used === 8)
  check('另一天的日记是空账', llmDiaryAllow(db, aid, '2026-11-07', 1).ok === true)
  writeParam(db, aid, 'memory.llm.diary_cap', 0)
  check('日记顶拧成 0 就是不限额', llmDiaryAllow(db, aid, D6, 1).ok === true)
  writeParam(db, aid, 'memory.llm.diary_cap', 100)
  check('日记顶写成 100 就是 100（上限 999）', llmDiaryCap(db, aid) === 100)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
