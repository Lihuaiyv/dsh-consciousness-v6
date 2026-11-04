/**
 * 三观 · 命题扩展字段（meta_json）+ 目录扩项（DERIVES / invest）。
 * 运行：node test/sangguan-meta-json.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, SangguanError } from '../src/modules/sangguan/ledger.js'
import { loadState, rebuild, snapshot } from '../src/modules/sangguan/projection.js'
import { normalizeMeta, metaOf, sceneOf, testableOf } from '../src/modules/sangguan/meta.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
function throwsCode(name, fn, code) {
  try { fn(); check(name, false, '没有抛错') } catch (e) {
    check(name, e instanceof SangguanError && (!code || e.code === code), { code: e.code, msg: e.message })
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgmeta-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sgmeta'
const T0 = '2026-11-03T02:00:00.000Z'
const T1 = '2026-11-03T03:00:00.000Z'

const claimEv = (text, meta, extra = {}) => ({
  type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: T0,
  payload: {
    claims: [{
      layer: 'W', kind: 'belt', text, origin: 'extract',
      boundary: [{ text: '在你跟我说话的时候', testable: true }],
      meta,
      ...extra,
    }],
  },
})

// ---------- 纯函数 ----------
check('缺省：null → 空对象', Object.keys(normalizeMeta(null)).length === 0)
check('坏形状：字符串 → null', normalizeMeta('x') === null)
check('坏形状：数组 → null', normalizeMeta([]) === null)
const cleaned = normalizeMeta({
  scene: ['你说数据不对的时候', '', 123], expectation: '你倒苦水时我给方案，你会更冷',
  observe: '你说完难受后我给了方案，你隔很久只回一个字', falsifier: '你明确说想要方案',
  direction: '做能把话接住的人', unknown: '丢掉',
  investment: [{ ref: 'act:1', kind: 'act', at: T0 }, { nope: 1 }],
  variants: [{ text: '旧说法', claim_id: 'cl_old', at: T0 }],
  derives: ['cl_a'], lane_phase: 'W-nightly',
})
check('白名单：未知字段丢掉', !('unknown' in cleaned))
check('列表：去掉空项', cleaned.scene.length === 1 && cleaned.investment.length === 1, cleaned)
check('非法 lane_phase 丢掉', normalizeMeta({ lane_phase: 'X' }).lane_phase === undefined)
const long = normalizeMeta({ expectation: '啊'.repeat(500) })
check('超长截断', long.expectation.length === 300)

// ---------- 落库与读回 ----------
append(db, aid, [claimEv('人难受的时候多数不是要答案，是要有人把话接住', {
  scene: ['你说难受的时候'],
  expectation: '你倒苦水时我先给方案，你会更冷',
  observe: '你说完难受，我给了方案，你隔很久只回一个字',
  lane_phase: 'W-nightly',
})])
const state1 = loadState(db, aid)
const c1 = Object.values(state1.claims)[0]
check('读回：meta 跟着命题进状态', !!c1 && c1.meta && c1.meta.expectation.includes('更冷'), c1 && c1.meta)
check('读回：scene 可用', sceneOf(c1).length === 1)
check('读回：可检验性判定为真', testableOf(c1) === true)

const raw = db.prepare('SELECT meta_json FROM persona_claims WHERE agent_id=?').get(aid)
check('落库：meta_json 是 JSON 字符串', typeof raw.meta_json === 'string' && JSON.parse(raw.meta_json).lane_phase === 'W-nightly')

// 空 meta：存 null，读时默认值
append(db, aid, [claimEv('世界大体是有回应的', null, {})])
const state2 = loadState(db, aid)
const noMeta = Object.values(state2.claims).find((c) => c.text === undefined ? false : true)
const all = Object.values(state2.claims)
check('空 meta：不写字符串 null', db.prepare("SELECT COUNT(*) n FROM persona_claims WHERE agent_id=? AND meta_json IS NULL").get(aid).n === 1)
check('空 meta：metaOf 给默认值', all.every((c) => metaOf(c).scene.length >= 0))

// ---------- 投影重建后仍在 ----------
const before = JSON.stringify(snapshot(db, aid).claims)
rebuild(db, aid)
const after = JSON.stringify(snapshot(db, aid).claims)
check('重建：投影快照一致', before === after)
const state3 = loadState(db, aid)
check('重建：meta 没丢', Object.values(state3.claims).find((c) => c.id === c1.id).meta.expectation === c1.meta.expectation)

// ---------- 目录扩项 ----------
const rid = append(db, aid, [{
  type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: T1,
  payload: { claims: [{ layer: 'W', kind: 'obs', text: '多数分歧来自信息没给到', origin: 'extract' }] },
}])
const newId = rid.entities.claims[0]
let ok = true
try {
  append(db, aid, [{
    type: 'EDGE_ADD', actor: 'sys', at: T1,
    payload: { edges: [{ type: 'DERIVES', from_id: c1.id, to_id: newId }] },
  }])
} catch (e) { ok = false; console.log('  edge error:', e.message) }
check('边：DERIVES 可入账', ok)

ok = true
try {
  append(db, aid, [{
    type: 'EVIDENCE', actor: 'sys', at: T1,
    payload: { evidence: [{ kind: 'invest', target_type: 'claim', target_id: c1.id, sign: 1, weight: 0.5, ref: 'act:test-1' }] },
  }])
} catch (e) { ok = false; console.log('  evidence error:', e.message) }
check('证据：invest 可入账', ok)

throwsCode('证据：未知 kind 被拒', () => append(db, aid, [{
  type: 'EVIDENCE', actor: 'sys', at: T1,
  payload: { evidence: [{ kind: 'guess', target_type: 'claim', target_id: c1.id, sign: 1, weight: 0.5, ref: 'act:x' }] },
}]), 'INVALID')

throwsCode('meta 形状不对被拒', () => append(db, aid, [claimEv('世界是安全的', '不是对象')]), 'INVALID')

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
