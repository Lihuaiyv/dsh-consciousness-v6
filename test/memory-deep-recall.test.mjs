/**
 * P2 去翻翻：问「记不记得」或常规一条都没捞着时，往旧账里翻一次，并标注「刚翻出来的」。
 * 运行：node test/memory-deep-recall.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve, deepRecall, wantsDeep } from '../src/modules/retrieve.js'
import { packInjection } from '../src/modules/pack.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-deep-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_deep'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '翻旧账', 'daily', 'active', new Date().toISOString())

// ---- 触发词 ----
check('「你还记得吗」触发', wantsDeep('你还记得上次说的那件事吗'))
check('「以前」触发', wantsDeep('以前那个方案是怎么回事'))
check('「不记得」触发', wantsDeep('我不记得当时怎么定的了'))
check('普通问题不触发', !wantsDeep('今天天气不错'), '今天天气不错')
check('普通任务不触发', !wantsDeep('帮我把这行改一下'))

// ---- 旧账：一条冷掉的记忆 ----
const old = addMemory(db, aid, { text: '那次我们把注入层改成分段拼的，先止血再开道', type: 'fact', source: 'extract', confidence: 0.7, importance: 0.5 })
db.prepare("UPDATE memory_items SET temp_state='cold' WHERE id=?").run(old.id)
// 再塞几条冷账，测 k 上限
for (let i = 0; i < 4; i++) {
  const m = addMemory(db, aid, { text: '旧账第' + i + '条：注入层分段拼的细节都记在这', type: 'fact', source: 'extract', confidence: 0.7 })
  db.prepare("UPDATE memory_items SET temp_state='cold' WHERE id=?").run(m.id)
}

const NO_FLOAT = { anchor: 0, fresh: 0 }
const normal = retrieve(db, aid, '注入层 分段拼', { k: 6, selfQuota: 0, ...NO_FLOAT, noUpgrade: true })
check('常规注入翻不到冷掉的旧账', !normal.items.some((x) => x.id === old.id), normal.items.map((x) => x.id))

const deep = deepRecall(db, aid, '注入层 分段拼', { k: 3 })
check('深翻能翻到冷掉的旧账', deep.some((x) => x.id === old.id), deep.map((x) => x.id))
check('深翻结果都标 via=deep', deep.every((x) => x.via === 'deep'), deep.map((x) => x.via))
check('深翻最多 k 条', deepRecall(db, aid, '注入层 分段拼', { k: 2 }).length <= 2)
check('空查询深翻返回数组', Array.isArray(deepRecall(db, aid, '', { k: 2 })))

// ---- 注入时标注「刚翻出来的」 ----
const packed = packInjection({ items: [{ partition: 'T2', text: '很久以前我们把注入层改成了分段拼', via: 'deep', e: 0.4 }] }, {})
check('注入带「刚翻出来的」提示', packed.text.includes('刚翻旧账翻出来的'), packed.text.slice(0, 120))
check('提示行算进 token', packed.tokens > 0)
const plain = packInjection({ items: [{ partition: 'T2', text: '很久以前我们把注入层改成了分段拼', e: 0.4 }] }, {})
check('没有深翻条目时不加提示', !plain.text.includes('刚翻旧账翻出来的'), plain.text.slice(0, 120))
const offNote = packInjection({ items: [{ partition: 'T2', text: '旧事', via: 'deep', e: 0.4 }] }, { deepNote: false })
check('deepNote=false 时不加提示', !offNote.text.includes('刚翻旧账翻出来的'))

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
