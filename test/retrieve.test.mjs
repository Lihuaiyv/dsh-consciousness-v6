/**
 * P1a 检索骨架测试：路由 / 证据门 / RRF / 缓冲 / HTTP。
 * 运行：node test/retrieve.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { appendTurn } from '../src/modules/archive.js'
import { pushTurn, recentRounds, bufferSize, hydrateFromRaw, clearBuffer } from '../src/modules/buffer.js'
import { routeScene, evidenceOf, overlap, fuseRRF, retrieve, searchFacts, GATE, stripSceneWords } from '../src/modules/retrieve.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-retrieve-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_ret'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '检索', 'daily', 'active', now())

// ---- 路由
{
  check('S1 默认', routeScene('今天吃什么').scene === 'S1')
  check('S2 回看关键词', routeScene('你上次说的那个').scene === 'S2')
  check('S3 深检索关键词', routeScene('我是不是说过这件事').scene === 'S3')
  check('S3 优先于 S2', routeScene('上次说的事我都想不起来了').scene === 'S3')
  const stripped = stripSceneWords('你上次说的那个检索骨架')
  check('触发词不参与检索', stripped === '检索骨架', stripped)
  check('全被去光时退回原句', stripSceneWords('上次') === '上次', stripSceneWords('上次'))
}

// ---- 证据分与 RRF（纯函数）
{
  check('完全命中 E=1', evidenceOf({ text: '用户喜欢喝美式咖啡', fts: 0 }, '咖啡') === 1)
  check('无关 E=0', evidenceOf({ text: '用户喜欢猫', fts: 0 }, '咖啡') === 0)
  const weak = evidenceOf({ text: '其实还是不是很好看', fts: 0.25 }, '事实存根')
  check('只有 FTS 套话命中 → 打折', weak < 0.11, weak)
  const q = overlap('用户明天要早起体检', '用户明天要早起体检')
  check('自重叠为 1', q === 1, q)
  const fused = fuseRRF({
    T1: [{ id: 'a', text: 'a', e: 0.9 }, { id: 'b', text: 'b', e: 0.5 }],
    T2: [{ id: 'c', text: 'c', e: 0.8 }],
  }, { T1: 1, T2: 0.7 })
  check('RRF 第一名是双路都命中的 a', fused[0].id === 'a', fused)
  check('RRF 只混名次：分值是 1/(k+rank)', Math.abs(fused[0].rrf - 1 / 61) < 1e-6, fused[0])
  const c = fused.find((x) => x.id === 'c')
  check('RRF 按分区权重缩放', c && Math.abs(c.rrf - 0.7 / 61) < 1e-6, c)
  const one = fuseRRF({ T1: [{ id: 'x', text: 'x', e: 0.1 }] }, { T1: 1 })
  check('空权重的分区不参与', fuseRRF({ T1: [{ id: 'x', text: 'x', e: 0.1 }] }, { T2: 1 }).length === 0 && one.length === 1)
}

// ---- 分区检索 + 门
{
  addMemory(db, aid, { text: '用户喜欢喝美式咖啡，不加糖', type: 'fact', importance: 0.9 })
  addMemory(db, aid, { text: '用户养了一只叫团子的猫', type: 'fact', importance: 0.5 })
  addMemory(db, aid, { text: '用户在做 DSH 意识体插件', type: 'fact', importance: 0.7 })
  const facts = searchFacts(db, aid, '咖啡')
  check('两字查询也能召回（LIKE 兜底）', facts.length >= 1 && /咖啡/.test(facts[0].text), facts.length)

  const r1 = retrieve(db, aid, '咖啡', { k: 5, float: false })
  check('S1 场景', r1.scene === 'S1', r1.scene)
  check('S1 只召回到咖啡那条', r1.items.length === 1 && /咖啡/.test(r1.items[0].text), r1.items.map((x) => x.text))
  check('S1 门是 0.35', r1.debug.gate === GATE.S1, r1.debug.gate)

  const r2 = retrieve(db, aid, '量子色动力学的正则化', { k: 5, float: false })
  check('完全无关 → 升级成 S3 且结果为空', r2.scene === 'S3' && r2.items.length === 0, { scene: r2.scene, n: r2.items.length })
  check('升级有理由', (r2.why || []).some((w) => /升级/.test(w)), r2.why)

  const r3 = retrieve(db, aid, '你上次说的那个量子色动力学', { k: 5 })
  check('S2 无命中 → 升级 S3', r3.scene === 'S3' && (r3.why || []).some((w) => /S2 无命中/.test(w)), { scene: r3.scene, why: r3.why })
}

// ---- 明显高分的不会被误升级
{
  // 「团子这只猫」会被 3-gram 确认打到 0.3（过不了 S1 门）——测「高分」要用能拿到 E=1 的说法
  const r = retrieve(db, aid, '团子的猫', { k: 5 })
  check('高分不升级', r.scene === 'S1' && r.items.length >= 1, { scene: r.scene, n: r.items.length })
}

// ---- 缓冲：最多 20 条、注入只取最近 2 轮
{
  clearBuffer(aid)
  const sid = 'sess_r1'
  for (let i = 1; i <= 14; i++) {
    pushTurn(aid, { role: 'user', text: '第' + i + '句', sessionId: sid })
    pushTurn(aid, { role: 'assistant', text: '回第' + i + '句', sessionId: sid })
  }
  check('缓冲上限 20 条', bufferSize(aid) === 20, bufferSize(aid))
  const last = recentRounds(aid, 2)
  check('注入只取最近 2 轮（4 条）', last.length === 4 && last[3].text === '回第14句', last.map((x) => x.text))
  check('缓冲是旧→新', last[0].text === '第13句', last[0].text)
  // 重启重放
  appendTurn(db, aid, { sessionId: 'sess_db', role: 'user', text: '库里的一句' })
  appendTurn(db, aid, { sessionId: 'sess_db', role: 'assistant', text: '库里的回话' })
  clearBuffer(aid)
  const n = hydrateFromRaw(db, aid)
  check('重启后从 T4 重放', n === 2 && bufferSize(aid) === 2, { n, size: bufferSize(aid) })
  check('重放内容是库里的', recentRounds(aid, 1)[0].text === '库里的一句')
}

// ---- HTTP 调试接口
{
  let n = 0
  const api = async (method, p, body = {}) => {
    const out = await handle(db, { method, path: p, body: { ...body, __idempotencyKey: 'tr' + (++n) }, token: 'user' })
    return out.body
  }
  const r = await api('GET', `/v1/agents/${aid}/retrieve?q=` + encodeURIComponent('咖啡'))
  check('HTTP 检索带场景', r.scene === 'S1' && Array.isArray(r.items) && r.items.length >= 1, r)
  check('HTTP 检索带证据分与 RRF', Number(r.items[0].e) > 0 && Number(r.items[0].rrf) > 0, r.items[0])
  check('HTTP 检索带分区名', r.items[0].partition === 'T1', r.items[0].partition)
  const forced = await api('GET', `/v1/agents/${aid}/retrieve?q=` + encodeURIComponent('咖啡') + '&scene=S3')
  check('可以强制场景', forced.scene === 'S3', forced.scene)
  const empty = await api('GET', `/v1/agents/${aid}/retrieve?q=`)
  // 空查询不炸；注入路径允许垫「锚点 / 新近」配额位，所以不要求 items 为空，
  // 但要求进来的只能是配额项，不能是字面命中。
  check('空查询不炸（配额项可以垫底）', Array.isArray(empty.items) && empty.buffer !== undefined
    && empty.items.every((x) => x.via === 'anchor' || x.via === 'fresh'), { scene: empty.scene, n: empty.items.length, via: empty.items.map((x) => x.via) })
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
