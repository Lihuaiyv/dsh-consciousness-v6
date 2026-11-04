/**
 * P3「咽回去的那半句」：字段透传 + 影子落库。
 * 运行：node test/unsaid.test.mjs
 *
 * 这个功能最大的风险不是坏，是**悄悄丢**：字段在中间某一层被白名单吃掉，
 * 库里一条都没有，谁也不报错。所以这里逐层验：prompt → finalize → normalize → 落库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { promptFor, finalizeAppraisal } from '../src/model.js'
import { appraiseV1 } from '../src/algo/appraise.js'
import { recordUnsaid } from '../src/features.js'
import { writeParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-unsaid-'))
const db = openDb(path.join(dir, 'app.db'))
const now = () => new Date().toISOString()
const aid = 'agt_unsaid'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())

// ---------------- 1 提示词里有这个字段 ----------------
{
  const p = promptFor('concern')
  check('prompt：JSON 模板里有 unsaid', p.includes('"unsaid"'), p.slice(0, 80))
  check('prompt：有一条规则讲它', /15\.\s*unsaid/.test(p), 'no rule 15')
  check('prompt：说明「没有就留空」', p.includes('留空'), '')
}

// ---------------- 2 finalizeAppraisal 透传 ----------------
{
  const a = finalizeAppraisal({ kind: 'chat', unsaid: '想顶回去，但没说' })
  check('finalize：unsaid 留住了', a.unsaid === '想顶回去，但没说', a.unsaid)
  const b = finalizeAppraisal({ kind: 'chat' })
  check('finalize：没给就是空串', b.unsaid === '', b.unsaid)
  const c = finalizeAppraisal({ kind: 'chat', unsaid: '  多  空格   ' })
  check('finalize：压平空白', c.unsaid === '多 空格', c.unsaid)
  const long = '很'.repeat(300)
  check('finalize：截到 120 字', finalizeAppraisal({ unsaid: long }).unsaid.length === 120, finalizeAppraisal({ unsaid: long }).unsaid.length)
}

// ---------------- 3 normalizeHint（白名单那一层） ----------------
{
  const hint = { source: 'model', kind: 'chat', label: 'calm', unsaid: '算了，不说了', why: '看不出', target: 'none', receive: 'follow' }
  const out = appraiseV1.run({}, { text: '随便说一句', hint })
  check('normalize：unsaid 没被白名单吃掉', out.unsaid === '算了，不说了', out.unsaid)
  const out2 = appraiseV1.run({}, { text: '没有 hint', hint: null })
  check('normalize：没有 hint 时是空串', out2.unsaid === '', out2.unsaid)
}

// ---------------- 4 落库 ----------------
{
  const ok = recordUnsaid(db, aid, { text: '想被抱一下，但没说', eventId: 'aev_x', cause: '好了' })
  check('落库：写了', ok === true, ok)
  const row = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='unsaid.moment' ORDER BY rowid DESC LIMIT 1").get(aid)
  check('落库：类型对', !!row, row)
  let p = {}
  try { p = JSON.parse(row.payload) } catch { p = {} }
  check('落库：text 在', p.text === '想被抱一下，但没说', p)
  check('落库：event_id 在', p.event_id === 'aev_x', p)
  check('落库：cause 在', p.cause === '好了', p)
}

// ---------------- 5 不该写的 ----------------
{
  const before = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='unsaid.moment'").get(aid).n
  check('空串：不写', recordUnsaid(db, aid, { text: '   ' }) === false, 'wrote empty')
  writeParam(db, aid, 'affect.unsaid', 'off')
  check('开关 off：不写', recordUnsaid(db, aid, { text: '这句不该进去' }) === false, 'wrote although off')
  writeParam(db, aid, 'affect.unsaid', 'on')
  const after = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='unsaid.moment'").get(aid).n
  check('次数没变', before === after, { before, after })
}

// ---------------- 6 不碰情绪表 ----------------
{
  const c = (t) => db.prepare('SELECT COUNT(*) n FROM ' + t + ' WHERE agent_id=?').get(aid).n
  const b = { e: c('affect_events'), s: c('affect_samples') }
  recordUnsaid(db, aid, { text: '只记这一条' })
  const a = { e: c('affect_events'), s: c('affect_samples') }
  check('影子：不动 affect_events', b.e === a.e, { b, a })
  check('影子：不动 affect_samples', b.s === a.s, { b, a })
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
