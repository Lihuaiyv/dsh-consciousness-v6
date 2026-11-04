/**
 * 开环前后对比：拿真库里那 45 条历史开环做语料，比「改前 / 改后」两种判法。
 *   node scripts/sim-loops.mjs
 *
 * 只读真库（不写），旧逻辑在这里原样重写一份做对照——不参与线上。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { detectLoop } from '../src/modules/loops.js'
import { openDb } from '../src/db.js'

const DB = process.env.DSHC_DB || path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
if (!fs.existsSync(DB)) { console.error('找不到库：' + DB); process.exit(2) }

// ---------- 旧逻辑（改前）原样重写 ----------
const OLD_LOOP_RE = /(答应|说好|承诺|约定|提醒我|别忘|回头|过两天|下次|改天|还没|待办|剩下|收尾|最后一步|等会|一会儿|之后|再说|留到|回头再|下周|明天|后天|周末|下周[一二三四五六日天])/
const VAGUE_RE = /^(好的|嗯|嗯嗯|行|可以|继续|然后呢|收到|ok)[。！!？?]*$/
const DONE_RE = /(已经|完成了|搞定了|解决了|做完了|做好的|完成了的)/
const STATUS_RE = /(已进入|已处于|正在进行|正在收尾|正在推进)/
const PERSON_RE = /(我|你|咱|给你|帮我|替我)/
const INTENT_RE = /(待办|需要|还要|得先|该|记得|别忘|回头|明天|后天|下次|一会儿|帮我|请你|麻烦|先.{0,4}(改|修|跑|写|删|加|测))/
const TECH_RE = /(`[^`]{1,40}`|\w+\(\)|函数|接口|变量|字段|参数|数据表|表结构|报错|异常|缺陷|bug|日志|编译|依赖|代码)/
function oldDetect(text) {
  const t = String(text || '').trim()
  if (t.length < 6 || VAGUE_RE.test(t)) return false
  if (!OLD_LOOP_RE.test(t)) return false
  if (DONE_RE.test(t)) return false
  if (STATUS_RE.test(t) && !PERSON_RE.test(t)) return false
  if (TECH_RE.test(t) && !INTENT_RE.test(t)) return false
  return true
}
const norm = (s) => String(s || '').replace(/[\s\p{P}]/gu, '')
function oldOverlap(a, b) {
  const A = new Set(Array.from(norm(a)))
  const B = new Set(Array.from(norm(b)))
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const c of A) if (B.has(c)) hit++
  return hit / Math.min(A.size, B.size)
}
function longestRun(a, b) {
  const A = norm(a); const B = norm(b)
  let best = 0
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      let k = 0
      while (i + k < A.length && j + k < B.length && A[i + k] === B[j + k]) k++
      if (k > best) best = k
    }
  }
  return best
}

// ---------- 语料：真库里历史开环 ----------
const ro = new DatabaseSync(DB, { readOnly: true })
const rows = ro.prepare('SELECT text, state, closed_by FROM open_loops ORDER BY rowid').all()
ro.close()
console.log('语料：真库 open_loops ' + rows.length + ' 条（只读）\n')

let oldHang = 0
let newHang = 0
for (const r of rows) {
  if (oldDetect(r.text)) oldHang++
  if (detectLoop(r.text) !== null) newHang++
}
console.log('【挂不挂】改前会挂 ' + oldHang + ' / ' + rows.length + '；改后 ' + newHang + ' / ' + rows.length)
console.log('         少挂 ' + (oldHang - newHang) + ' 条（本来就不是待办的那些）\n')

// ---------- 关不关：拿「好了」类句子压一次 ----------
const CLOSERS = ['好了', '好了，搞定了', '行，可以了', '算了不用了']
const db = openDb(path.join(os.tmpdir(), 'dshc-sim-loops-' + Date.now() + '.db'))
const now = () => new Date().toISOString()
const aid = 'agt_sim_loops'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '对照', 'chat', 'active', now())
// 把语料灌进去（全部 open，且都没被浮现过——这是最容易误关的状态）
for (const r of rows) {
  db.prepare('INSERT INTO open_loops(id,agent_id,kind,text,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('lp_' + Math.random().toString(16).slice(2, 12), aid, 'task', r.text, 'open', now(), now())
}
const all = db.prepare('SELECT id,text FROM open_loops WHERE agent_id=?').all(aid)
let oldClosed = 0
let newClosed = 0
for (const c of CLOSERS) {
  for (const r of all) {
    if (oldOverlap(r.text, c) >= 0.35) oldClosed++
    if (longestRun(r.text, c) >= 4) newClosed++
  }
}
console.log('【关得对不对】4 句「好了」压过去：')
console.log('  改前（字符集重合 ≥0.35）：误关 ' + oldClosed + ' 次')
console.log('  改后（连续 4 字）：误关 ' + newClosed + ' 次')
