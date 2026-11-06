/**
 * 考卷 · 待发消息队列（proactive）
 * 运行：node test/proactive-queue.test.mjs
 *
 * 这张卷子管：排一条、标投递、标回应、标忽略、划掉、作废、按事由撤销。
 * 不管：该不该说、句子怎么写——那是主动开口和说话的卷子。
 * 它要钉住的是「写权单点」搬完之后，行为跟搬家前一模一样。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import {
  enqueueProactive, markDelivered, markAnswered, markIgnored,
  dismissProactive, expireStaleProactive, dropPendingByReason,
} from '../src/modules/proactive.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-test-queue-'))
const db = openDb(path.join(dir, 'app.db'))
const AID = 'agt_queue_test'

const row = (id) => db.prepare('SELECT * FROM proactive WHERE id=?').get(id)

// ---------------- 1 排一条 ----------------
{
  const id = enqueueProactive(db, AID, { text: '在吗', reason: 'share:x', dim: 'R' })
  const r = row(id)
  check('排进去是 pending', r && r.state === 'pending', r)
  check('还没投递：delivered_at 是空', r && r.delivered_at == null, r && r.delivered_at)
  check('正文 / 事由 / 维度都存住', r && r.text === '在吗' && r.reason === 'share:x' && r.dim === 'R', r)
  check('id 带 prc_ 前缀', String(id).startsWith('prc_'), id)
  check('created_at 有值', r && !!r.created_at, r)
}

// ---------------- 2 标投递 ----------------
{
  const id = enqueueProactive(db, AID, { text: '到了吗', reason: 'r1', dim: 'R' })
  const n = markDelivered(db, id)
  const r = row(id)
  check('标投递：state=delivered', r.state === 'delivered', r)
  check('标投递：delivered_at 仍留空（主动推不算已读）', r.delivered_at == null, r.delivered_at)
  check('标投递返回改了 1 行', n === 1, n)
  check('重复标投递不再改（只动 pending）', markDelivered(db, id) === 0)
}

// ---------------- 3 标回应 ----------------
{
  const id = enqueueProactive(db, AID, { text: '回我一句嘛', reason: 'r2', dim: 'S' })
  markDelivered(db, id)
  const n = markAnswered(db, id)
  const r = row(id)
  check('标回应：answered=1', Number(r.answered) === 1, r.answered)
  check('标回应：answered_at 有值', !!r.answered_at, r.answered_at)
  check('标回应返回改了 1 行', n === 1, n)
}

// ---------------- 4 标忽略 ----------------
{
  const id = enqueueProactive(db, AID, { text: '没回我', reason: 'r3', dim: 'R' })
  markDelivered(db, id)
  const n = markIgnored(db, id)
  const r = row(id)
  check('标忽略：ignored=1', Number(r.ignored) === 1, r.ignored)
  check('标忽略返回改了 1 行', n === 1, n)
}

// ---------------- 5 划掉 ----------------
{
  const id = enqueueProactive(db, AID, { text: '算了', reason: 'r4', dim: 'R' })
  const n = dismissProactive(db, id)
  const r = row(id)
  check('划掉：state=dismissed', r.state === 'dismissed', r)
  check('划掉返回改了 1 行', n === 1, n)
}

// ---------------- 6 作废陈年 pending ----------------
{
  const oldId = enqueueProactive(db, AID, { text: '七天了', reason: 'r5', dim: 'R', at: '2026-10-01T00:00:00.000Z' })
  const freshId = enqueueProactive(db, AID, { text: '今天', reason: 'r6', dim: 'R' })
  const n = expireStaleProactive(db, '2026-10-08T00:00:00.000Z')
  check('作废只动超过时限的 pending', row(oldId).state === 'expired' && row(freshId).state === 'pending', { old: row(oldId).state, fresh: row(freshId).state })
  check('作废返回条数', n >= 1, n)
  check('作废不改已投递的', (() => {
    const did = enqueueProactive(db, AID, { text: '已投', reason: 'r7', at: '2026-10-01T00:00:00.000Z' })
    markDelivered(db, did)
    expireStaleProactive(db, '2026-10-08T00:00:00.000Z')
    return row(did).state === 'delivered'
  })())
}

// ---------------- 7 按事由撤销（冲突拍板） ----------------
{
  const pending = enqueueProactive(db, AID, { text: '到底是哪个', reason: 'conflict:c1', dim: 'R' })
  const delivered = enqueueProactive(db, AID, { text: '早发了', reason: 'conflict:c2', dim: 'R' })
  markDelivered(db, delivered)
  const n = dropPendingByReason(db, AID, 'conflict:c1')
  check('按事由撤销：pending 那条没了', row(pending) == null)
  check('按事由撤销：已投递的不动', row(delivered) != null)
  check('按事由撤销返回条数', n === 1, n)
}

// ---------------- 8 两个 agent 互不串 ----------------
{
  const other = 'agt_queue_other'
  const mine = enqueueProactive(db, AID, { text: '我的', reason: 'r8' })
  dropPendingByReason(db, other, 'r8')
  check('撤销只动自己 agent 的', row(mine) != null)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
