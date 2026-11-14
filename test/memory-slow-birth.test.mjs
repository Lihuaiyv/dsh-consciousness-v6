/**
 * 记忆出生时记下「那一阵往哪边偏」（slow_at_creation）。
 * 有取数口就用它给的数，没取数口就写 NULL——不拿 0 冒充「当时正好中性」。
 * 运行：node test/memory-slow-birth.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory, setSlowProvider } from '../src/modules/memory.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-slowbirth-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

let n = 0
function makeAgent() {
  const id = 'agt_slow_' + (++n)
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, id, 'daily', 'active', new Date().toISOString())
  return id
}
const slowOf = (id) => db.prepare('SELECT slow_at_creation FROM memory_items WHERE id=?').get(id).slow_at_creation

// 1) 有取数口：写下当下的慢情绪
{
  setSlowProvider(() => -0.42)
  const aid = makeAgent()
  const m = addMemory(db, aid, { text: '今天有点沉。', type: 'fact', source: 'extract' })
  check('注入的慢情绪写进了记忆', slowOf(m.id) === -0.42, slowOf(m.id))
}

// 2) 没取数口：NULL，不冒充中性
{
  setSlowProvider(null)
  const aid = makeAgent()
  const m = addMemory(db, aid, { text: '没有取数口的一条。', type: 'fact', source: 'extract' })
  check('没有取数口时写 null', slowOf(m.id) == null, slowOf(m.id))
}

// 3) 取数口拿不到数（老库没情绪行）：NULL，不写 0
{
  setSlowProvider(() => null)
  const aid = makeAgent()
  const m = addMemory(db, aid, { text: '取数口这次拿不到数。', type: 'fact', source: 'extract' })
  check('取数口返回 null 时写 null', slowOf(m.id) == null, slowOf(m.id))
}

// 4) 调用方显式给：优先，并夹在 -1~1
{
  setSlowProvider(() => 0.9)
  const aid = makeAgent()
  const m = addMemory(db, aid, { text: '显式给一个超范围的值。', type: 'fact', source: 'manual', slow_at_creation: 3 })
  check('显式值优先且夹在 -1~1', slowOf(m.id) === 1, slowOf(m.id))
}

// 5) 真的中性写 0，和 NULL 分得开
{
  setSlowProvider(() => 0)
  const aid = makeAgent()
  const m = addMemory(db, aid, { text: '正好平静的一阵。', type: 'fact', source: 'extract' })
  check('真的中性写 0', slowOf(m.id) === 0, slowOf(m.id))
}

// 6) 老记忆不受影响：列是后加的，旧行保持 NULL
{
  const aid = makeAgent()
  db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
      last_decay_at,valid_at,invalid_at,status,created_at,deleted_at,version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('mem_old_row', aid, 'fact', 'normal', '一条早就在的旧记忆。', 'extract', 0.5, 0.5, 1, 5,
      new Date().toISOString(), null, null, 'active', new Date().toISOString(), null, 1)
  check('旧行没有这一项时是 null', slowOf('mem_old_row') == null, slowOf('mem_old_row'))
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
