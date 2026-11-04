/**
 * 评价的理由（why）和靶子（target）：模型给的脏值要清干净，缺省要合理。
 * 运行：node test/appraise-why.test.mjs
 */
import { finalizeAppraisal } from '../src/model.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

// ---- why ----
const a = finalizeAppraisal({ kind: 'directive', polarity: -0.5, why: '  "还是" 加 "不对" = 在纠错  ', target: 'me' })
check('why 保留原意', a.why.includes('还是') && a.why.includes('在纠错'), { why: a.why })
check('why 首尾空白去掉', a.why === a.why.trim(), { why: a.why })

const b = finalizeAppraisal({ kind: 'directive', polarity: -0.5, why: '换\n行\t制表  多空格', target: 'me' })
check('why 压平换行和多余空格', !/[\n\t]/.test(b.why) && !/ {2,}/.test(b.why), { why: b.why })

const long = '啊'.repeat(300)
const c = finalizeAppraisal({ kind: 'eval', polarity: 0.4, why: long, target: 'me' })
check('why 截到 120 字', c.why.length <= 120, { len: c.why.length })

const none = finalizeAppraisal({ kind: 'task' })
check('task 没给 why 就是空串', none.why === '', { why: none.why })

// ---- target ----
check('target 照抄 me', finalizeAppraisal({ kind: 'eval', polarity: -0.5, target: 'me' }).target === 'me')
check('target 照抄 other', finalizeAppraisal({ kind: 'eval', polarity: -0.5, target: 'other' }).target === 'other')
check('target 非法值按 none 兜成 none', finalizeAppraisal({ kind: 'task', target: 'xyz' }).target === 'none')
check('判成没事时默认 none', finalizeAppraisal({ kind: 'task' }).target === 'none')
check('有事又没给 target 时默认 me', finalizeAppraisal({ kind: 'eval', polarity: -0.5 }).target === 'me')

// ---- 不影响原来的字段 ----
check('原来的关切度还在', Number.isFinite(none.goal_relevance) && Number.isFinite(a.goal_congruence), { a: a.goal_relevance })

/* ---- 全链路：模型 hint → appraise 算子 → affect_events ----
   这一条是补的：前面只测了 finalizeAppraisal，中间那层算子把 why 白名单掉了，
   真实库里 1266 条事件的 why 全是 null，复查只能靠光秃秃的文本重判。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { seedAffect, appraise } from '../src/modules/affect.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-why-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_why'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '理由', 'daily', 'active', now())
seedAffect(db, aid)
const LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']

await appraise(db, aid, '还是不对，重来', {
  labels: LABELS,
  hint: {
    label: 'irritated',
    goal_relevance: 0.8,
    goal_congruence: -0.6,
    certainty: 0.8,
    novelty: 0.3,
    source: 'model',
    why: '「还是不对」是在纠错',
    target: 'me',
  },
})
const row = db.prepare('SELECT why,target FROM affect_events WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)
check('链路没把 why 丢掉', !!row && row.why === '「还是不对」是在纠错', row)
check('链路没把 target 丢掉', !!row && row.target === 'me', row)

await appraise(db, aid, '把表格导出成 Excel', {
  labels: LABELS,
  hint: {
    label: 'calm', kind: 'task', none: true,
    goal_relevance: 0.1, goal_congruence: 0,
    certainty: 0.8, novelty: 0.2, source: 'model',
    why: '', target: 'none',
  },
})
const row2 = db.prepare('SELECT why,target FROM affect_events WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)
check('没事的时候 why 是 null 不是空串', !!row2 && row2.why === null, row2)
check('没事的时候 target=none', !!row2 && row2.target === 'none', row2)

try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不报 */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
