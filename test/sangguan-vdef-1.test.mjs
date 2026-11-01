/**
 * 价值观默认走折算：空表是初值，偏离的旧表迁成保护带命题，总开关关闭也能进料。
 * 运行：node test/sangguan-vdef-1.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { readViews } from '../src/modules/sangguan/bridge.js'
import { ingestValues, claimUserValue } from '../src/modules/sangguan/values_intake.js'
import { DIMS } from '../src/modules/values.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-vdef1-'))
const db = openDb(path.join(dir, 'app.db'))
const T = '2026-11-01T12:00:00.000Z'
const add = (id) => db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, id, 'daily', 'active', T)

add('agt_empty')
{
  const v = readViews(db, 'agt_empty')
  const sum = Object.values(v.V.weights).reduce((a, b) => a + b, 0)
  check('没有命题：十维都是 0.1，提示词不提价值观', v.source.V === 'engine' && v.V.line === '' && DIMS.every(([k]) => v.V.weights[k] === 0.1) && Math.abs(sum - 1) < 1e-9, v.V.weights)
  check('空账本不写命题', Object.keys(loadState(db, 'agt_empty').claims).length === 0)
}

add('agt_one')
{
  // 一条手写命题就能把那一维抬起来，且不需要任何旧表
  const r = claimUserValue(db, 'agt_one', { key: 'benevolence', weight: 0.9 })
  const v = readViews(db, 'agt_one', { at: T })
  const sum = Object.values(v.V.weights).reduce((a, b) => a + b, 0)
  const top = Object.entries(v.V.weights).sort((a, b) => b[1] - a[1])[0][0]
  check('一条命题就能折算', r.claimed === true && top === 'benevolence' && Math.abs(sum - 1) < 0.02, { r, w: v.V.weights })
  check('提示词只列抬起来的维，不混低维', v.V.line === '你看重：仁善。', v.V.line)
}

add('agt_feed')
const mem = (id, type, text) => db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
  last_decay_at,valid_at,invalid_at,status,created_at,deleted_at,version)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'agt_feed', type, 'normal', text, 'manual', 0.5, 0.5, 1, 5, T, null, null, 'active', T, null, 1)
mem('mr', 'reflection', '我想照顾身边的人，把他们放在前面')
{
  const before = Object.keys(loadState(db, 'agt_feed').claims).length
  const fed = await ingestValues(db, 'agt_feed', T)
  const claims = Object.values(loadState(db, 'agt_feed').claims).filter((c) => c.layer === 'V')
  check('总开关关闭时反思仍进价值候选', fed.offered === 1 && claims.length === before + 1 && claims[0].kind === 'norm', { fed, n: claims.length })
  const again = await ingestValues(db, 'agt_feed', T)
  check('同一条反思不进第二次', again.offered === 0 && Object.values(loadState(db, 'agt_feed').claims).filter((c) => c.layer === 'V').length === claims.length)
  const short = await ingestValues(db, 'agt_feed', '2026-11-02T00:00:00.000Z', { user: '你好' })
  check('太短的用户原话不进命题', short.offered === 0)
}

console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
