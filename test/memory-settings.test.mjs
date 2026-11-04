/**
 * 记忆设置四个旋钮的独立测试（不依赖 run-tests.mjs）：
 * 衰减速度、遗忘阈值、自动记忆、每轮注入预算，外加 v3 召回路径的阈值。
 * 用法：node test/memory-settings.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { attachDb } from '../src/algo/index.js'
import { clampInjection } from '../src/features.js'
import { recallWithAlgo } from '../src/core.js'
import { retrieve } from '../src/modules/retrieve.js'
import { decayV1 } from '../src/algo/decay.js'

process.env.DSHC_TEST_NO_LIMIT = '1'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-mem-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

const pass = []
const fail = []
function check(name, cond, detail) {
  if (cond) { pass.push(name); console.log('PASS ' + name) } else { fail.push(name); console.log('FAIL ' + name + '  ' + JSON.stringify(detail)) }
}
const key = () => 'mset-' + Math.random().toString(36).slice(2)

async function api(method, p, body = {}, withKey = false) {
  const env = { method, path: p, body: { ...body }, token: 'user' }
  if (withKey) env.body.__idempotencyKey = key()
  const out = await handle(db, env)
  return out.body
}

try {
  const ag = await api('POST', '/v1/agents', { name: '记忆设置测试' }, true)
  const aid = ag.id
  check('建意识体', !!aid, ag)

  const ps = await api('GET', `/v1/agents/${aid}/params`)
  const keys = ['memory.decay.lambda', 'memory.recall.floor', 'memory.inject.budget', 'memory.auto']
  check('四个参数都在目录里', keys.every((k) => ps.some((p) => p.key === k)), ps.length)

  // 衰减速度：只改 R 的斜率，时间倍数越小忘得越快
  const aged = { last_decay_at: new Date(Date.now() - 100 * 86400000).toISOString(), stability: 1 }
  const rSlow = decayV1.run({}, { row: aged, scale: 2 }).R
  const rBase = decayV1.run({}, { row: aged }).R
  const rFast = decayV1.run({}, { row: aged, scale: 0.5 }).R
  check('衰减速度改的是 R 的斜率', rSlow > rBase && rBase > rFast, { rSlow, rBase, rFast })

  // 自动记忆开关：布尔不能存成 NaN
  await api('PUT', `/v1/agents/${aid}/params/memory.auto`, { value: false }, true)
  const autoRow = db.prepare('SELECT value FROM agent_params WHERE agent_id=? AND key=?').get(aid, 'memory.auto')
  const autoNow = (await api('GET', `/v1/agents/${aid}/params`)).find((p) => p.key === 'memory.auto').value
  check('自动记忆开关存成布尔', autoNow === false && String(autoRow.value) === 'false', { autoNow, autoValue: autoRow && autoRow.value })

  // 注入预算：硬上限（身份段再长也不能超）
  const huge = ['## 意识体：X', '长'.repeat(1200), '关于这句话，你能想起的事：\n- ' + '记'.repeat(1600)]
  const hard = clampInjection(huge, 200)
  check('注入预算硬上限不超', hard.tokens <= 200, { tokens: hard.tokens, dropped: hard.dropped })
  check('超预算会削短并留痕', hard.text.includes('…') && (hard.dropped.includes('truncate') || hard.dropped.includes('shrink')), hard.dropped)

  // 准备一条旧记忆（10 天没动过，R≈0.47）
  const memText = '用户喜欢下雨天散步'
  const m1 = await api('POST', `/v1/agents/${aid}/memory`, { text: memText }, true)
  db.prepare('UPDATE memory_items SET last_decay_at=? WHERE id=?')
    .run(new Date(Date.now() - 10 * 86400000).toISOString(), m1.id)
  const lo = recallWithAlgo(db, aid, memText, { floor: 0.2, k: 8, touch: false })
  const hi = recallWithAlgo(db, aid, memText, { floor: 0.8, k: 8, touch: false })
  check('遗忘阈值过滤 v2 召回', lo.count >= 1 && hi.count < lo.count, { lo: lo.count, hi: hi.count })

  // v3 检索路径也要认阈值
  const v3lo = retrieve(db, aid, memText, { k: 6, floor: 0.2, decayVersion: 'v1', decayScale: 1 })
  const v3hi = retrieve(db, aid, memText, { k: 6, floor: 0.8, decayVersion: 'v1', decayScale: 1 })
  const t1lo = v3lo.items.filter((x) => x.partition === 'T1').length
  const t1hi = v3hi.items.filter((x) => x.partition === 'T1').length
  check('遗忘阈值过滤 v3 检索', t1lo >= 1 && t1hi === 0, { lo: t1lo, hi: t1hi, scene: v3lo.scene })

  // 参数写回：阈值与预算
  await api('PUT', `/v1/agents/${aid}/params/memory.recall.floor`, { value: 0.3 }, true)
  await api('PUT', `/v1/agents/${aid}/params/memory.inject.budget`, { value: 600 }, true)
  const after = await api('GET', `/v1/agents/${aid}/params`)
  const val = (k) => (after.find((p) => p.key === k) || {}).value
  check('阈值与预算写得进读得出', Number(val('memory.recall.floor')) === 0.3 && Number(val('memory.inject.budget')) === 600, { floor: val('memory.recall.floor'), budget: val('memory.inject.budget') })
} catch (e) {
  console.error(e)
  fail.push('顶层异常：' + (e && e.message))
}

console.log('\n通过 ' + pass.length + ' / ' + (pass.length + fail.length))
if (fail.length) { console.error('失败: ' + JSON.stringify(fail)); process.exit(1) }
