/**
 * 冲突「来报」：属性矛盾开案 + 排主动问句 + 不重复问。
 * 运行：node test/conflict-ask.test.mjs
 *
 * 验的是「咖啡热/冰」那条链：
 *   - 摘要（reflection）里的「1. 事实：…」也参与比对，不再因为类型被跳过；
 *   - 没有否定词也能判：同骨架、互斥取值（热/冰、喜欢/讨厌）；
 *   - 开案之后真的排一条问句（proactive），同一个冲突只问一次；
 *   - 不同属性（酸 vs 冰）、不同主语不误判；
 *   - memory.conflict.ask=off 时只开案、不排问句。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { writeParam } from '../src/kernel.js'
import { addMemory, resolveConflict } from '../src/modules/memory.js'
import { attrConflict, sentences, valuesIn } from '../src/modules/contradict.js'
import { applyWrite } from '../src/modules/gate.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-cask-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_cask'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'cask', 'daily', 'active', now())

const openCount = () => Number(db.prepare("SELECT COUNT(*) n FROM conflicts WHERE agent_id=? AND state='open'").get(aid).n)
const askCount = () => Number(db.prepare('SELECT COUNT(*) n FROM proactive WHERE agent_id=?').get(aid).n)

// ---------------------------------------------------------------- 判据本身
{
  check('同骨架不同温度判冲突', !!attrConflict('咖啡是热的', '咖啡是冰的'))
  check('同值不判', !attrConflict('咖啡是热的', '咖啡是热的'))
  check('不同属性不判（酸 ≠ 冷热）', !attrConflict('咖啡是冰的', '咖啡是酸的'))
  check('不同主语不判', !attrConflict('咖啡是冰的', '茶是冰的'))
  check('拆句去掉摘要编号', sentences('1. 用户的事实：昨天喝的咖啡是冰的。 2. 偏好：…').includes('用户的事实：昨天喝的咖啡是冰的'))
  check('并列「冰/热」不当成取值', valuesIn('对冰/热咖啡的偏好', ['热', '冰', '冷']).length === 2)
}

// ---------------------------------------------------------------- 摘要里的热/冰
const S1 = '1. 用户的事实：昨天喝的咖啡是冰的。  \n2. 用户的偏好与情绪：用户未明确表达对冰/热咖啡的偏好，也未表露明显情绪。  \n3. 用户的边界：用户未提出任何边界或禁忌。'
const S2 = '1. 事实：用户昨天喝的咖啡是热的。  \n2. 偏好与情绪：对话未体现用户对咖啡冷热或口味的明确偏好，也未表达明显情绪。  \n3. 边界：用户没有提及任何个人边界、禁忌或不愿讨论的话题。'
const S3 = '用户提到自己昨天喝的咖啡是酸的。对话中未明确表达其他偏好、情绪或边界。目前信息不足以判断用户对酸味咖啡的态度。'

{
  const a = addMemory(db, aid, { text: S1, type: 'reflection', importance: 0.85, source: 'summary' })
  check('第一条摘要不报冲突', !a.conflict, a)
  const b = addMemory(db, aid, { text: S2, type: 'reflection', importance: 0.85, source: 'summary' })
  check('热/冰判成冲突', b.conflict === true, b)
  check('只开一条冲突', openCount() === 1, openCount())
  const c = db.prepare("SELECT * FROM conflicts WHERE agent_id=? AND state='open' LIMIT 1").get(aid)
  check('冲突种类是 attribute', c && c.kind === 'attribute', c && c.kind)
  check('严重度 high', c && c.severity === 'high', c && c.severity)
  const ev = JSON.parse((c && c.evidence) || '{}')
  check('留痕带双方句子', !!(ev.attribute && ev.attribute.sentence_a && ev.attribute.sentence_b), ev.attribute)
  check('旧摘要没有被判失效', db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(a.id).invalid_at === null)

  const q = db.prepare('SELECT * FROM proactive WHERE agent_id=? AND reason=?').get(aid, 'conflict:' + c.id)
  check('排了一条问句', !!q && q.state === 'pending', q)
  check('问句里两个值都在', !!(q && /冰/.test(q.text) && /热/.test(q.text)), q && q.text)
  check('问句按时间顺序：先冰后热', !!q && q.text.indexOf('冰') < q.text.indexOf('热') && q.text.indexOf('冰') >= 0, q && q.text)
  check('问句不带「1. 事实：」这种编号', !!(q && !/^\d/.test(q.text) && !q.text.includes('事实：')), q && q.text)

  const s3 = addMemory(db, aid, { text: S3, type: 'reflection', importance: 0.5, source: 'summary' })
  check('酸不比冷热，不新开冲突', s3.conflict !== true && openCount() === 1, { s3, open: openCount() })
  check('也没有第二条问句', askCount() === 1, askCount())
}

// ---------------------------------------------------------------- 否定词翻转也排问句
{
  addMemory(db, aid, { text: '用户的生日是十月三日', type: 'fact', importance: 0.9 })
  const n = addMemory(db, aid, { text: '用户的生日不是十月三日吧', type: 'fact', importance: 0.9 })
  check('否定翻转仍判冲突', n.conflict === true, n)
  check('否定冲突也排问句', askCount() === 2, askCount())
  const q = db.prepare('SELECT * FROM proactive WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)
  check('问句挂在冲突上', !!(q && String(q.reason).startsWith('conflict:')), q)
}

// ---------------------------------------------------------------- 门控抽取：同一对只问一遍
{
  addMemory(db, aid, { text: '用户喜欢喝美式咖啡，不加糖', type: 'fact', importance: 0.6 })
  const before = askCount()
  const out = applyWrite(db, aid, { text: '用户不喜欢喝美式咖啡了' }, (cand) => addMemory(db, aid, {
    text: cand.text, type: 'fact', importance: 0.6,
  }))
  check('门控也判冲突', out.action === 'conflict', out)
  check('同一对说法只问一遍', askCount() === before + 1, { before, after: askCount() })
}

// ---------------------------------------------------------------- 开关
{
  writeParam(db, aid, 'memory.conflict.ask', 'off')
  addMemory(db, aid, { text: '今天天气很热', type: 'fact', importance: 0.6 })
  const beforeOpen = openCount()
  const beforeAsk = askCount()
  const c = addMemory(db, aid, { text: '今天天气很冷', type: 'fact', importance: 0.6 })
  check('off 时仍开案', c.conflict === true && openCount() === beforeOpen + 1, { c, open: openCount() })
  check('off 时不排问句', askCount() === beforeAsk, { beforeAsk, after: askCount() })
}

// ---------------------------------------------------------------- 拍板之后：待发问句要撤掉
{
  const pending = db.prepare("SELECT reason FROM proactive WHERE agent_id=? AND state='pending' AND reason LIKE 'conflict:%' LIMIT 1").get(aid)
  check('还有待发问句可测', !!pending, pending)
  const cid = String(pending.reason).slice('conflict:'.length)
  resolveConflict(db, aid, cid, { keep: 'both' })
  const left = db.prepare("SELECT COUNT(*) n FROM proactive WHERE agent_id=? AND state='pending' AND reason=?").get(aid, pending.reason).n
  check('冲突拍板后撤掉问句', Number(left) === 0, left)
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
