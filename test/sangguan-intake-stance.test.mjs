/**
 * P2 进料补漏：冲突 → W、志向 → L 两条通道原来不问「是不是立场」，现在要问。
 * 运行：node test/sangguan-intake-stance.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-intake-'))
process.env.DSH_HOME = home
const { openDb } = await import('../src/db.js')
const api = await import('../src/api.js')
const { intakeCandidates } = await import('../src/modules/sangguan/intake.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}

const db = openDb(path.join(home, 'app.db'))
const aid = (await api.handle(db, { method: 'POST', path: '/v1/agents', token: 'user', body: { name: '进料', __idempotencyKey: 'mk' } })).body.id
await api.handle(db, { method: 'PUT', path: '/v1/agents/' + aid + '/sangguan/config', token: 'user', body: { enabled: true, __idempotencyKey: 'on' } })

let n = 0
const mem = (text, type) => {
  const id = 'mem_test_' + (++n)
  const now = new Date().toISOString()
  db.prepare('INSERT INTO memory_items(id,agent_id,type,text,source,last_decay_at,status,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, aid, type, text, 'test', now, 'active', now)
  return id
}
const conflict = (a, b) => {
  const id = 'cf_test_' + (++n)
  db.prepare('INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at) VALUES(?,?,?,?,?,?)')
    .run(id, aid, a, b, 'open', new Date().toISOString())
  return id
}

// 工程句（原来会一路进 W / L）
const techA = mem('电脑关机或插件没开，这套服务就不存在，微信也发不出去。', 'fact')
const techB = mem('线上 536 个测试全过，代码本身没有问题。', 'fact')
conflict(techA, techB)
const techAsp = mem('先做开机自启和后台守护，把本机长时间在线跑顺，再考虑上服务器。', 'aspiration')

// 真立场
const stanceAsp = mem('我想弄清楚，陪一个人到底是什么意思。', 'aspiration')

const got = intakeCandidates(db, aid)
const texts = got.map((x) => x.text)

check('工程文本没进 W', !texts.some((t) => t.includes('插件没开')), texts)
check('工程文本（测试/代码）没进 W', !texts.some((t) => t.includes('536 个测试')), texts)
check('待办式志向没进 L', !texts.some((t) => t.includes('开机自启')), texts)
check('真立场进了 L', texts.some((t) => t.includes('陪一个人到底是什么意思')), texts)
check('候选只留该留的（数量 1）', got.length === 1, got.map((x) => x.layer + ':' + x.text))

// 第二次调用：同一条不重复出（seen 标记仍然生效）
const again = intakeCandidates(db, aid)
check('同一来源只出一次', again.length === 0, again)

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
