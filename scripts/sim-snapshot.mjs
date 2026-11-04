/**
 * 感受快照的「防照着念」模拟：同一批场景，开/关各跑一遍，比注入文本。
 *   node scripts/sim-snapshot.mjs
 *
 * 它不调模型（本地拼提示词），所以它验的不是「她会不会念数字」——
 * 那要真机看。它验的是**我们能控的那一半**：
 *   1) 快照行里没有命令词（命令会让她照着演，这是 plan P2 的底线）；
 *   2) 数字只出现在快照行里，不会漏到别的行去；
 *   3) 开与关相比，记忆条数不掉、token 增幅不超 15%；
 *   4) 该不给的场景（陌生人 / QQ 非主人 / 超龄 / 技术噪音）真的不给。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { consciousnessBlock } from '../index.js'
import { writeParam } from '../src/kernel.js'
import { seedTiers } from '../src/modules/relations.js'
import { addMemory } from '../src/modules/memory.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

const now = () => new Date().toISOString()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-snap-'))
const db = openDb(path.join(dir, 'app.db'))
const SNAP = '（上一句落在我身上'

let seq = 0
function mkAgent(tag) {
  seq++
  const aid = 'agt_sim_' + seq
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '小汐' + seq, 'chat', 'active', now())
  const put = db.prepare('INSERT INTO persona(agent_id,path,value,updated_at) VALUES(?,?,?,?)')
  put.run(aid, 'style.tone', JSON.stringify('可爱粘人'), now())
  put.run(aid, 'style.address', JSON.stringify('主人'), now())
  put.run(aid, 'axis.ei', JSON.stringify(0.35), now())
  db.prepare(`INSERT INTO affect_state(agent_id,primary_label,secondary_label,intensity,mood,pleasure,arousal,dominance,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(aid, 'peaceful', null, 0.6, 0.55, 0.2, 0.1, 0.1, now())
  db.prepare('INSERT INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)')
    .run(aid, 0.05, 0.12, 0.2, 0.18, now(), now())
  seedTiers(db)
  db.prepare(`INSERT INTO rel_person(id,agent_id,name,tier,closeness,trust,dependence,salience,status,
    first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('rp_' + aid, aid, '主人', 'owner', 0.94, 0.74, 0.22, 1, 'active', now(), now(), now(), now())
  for (let i = 0; i < 6; i++) {
    addMemory(db, aid, { text: '第 ' + (i + 1) + ' 条可真可假的旧事：主人以前说过想做点什么。', type: 'fact' })
  }
  return aid
}
function snapRows(aid, { minutesAgo = 1, cause = '我可不舍得说难听的话', label = 'peaceful' } = {}) {
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString()
  const at2 = new Date(Date.now() - minutesAgo * 60000 + 1).toISOString()
  db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,label,gate) VALUES(?,?,?,?,?,?)')
    .run('aev_' + Math.random().toString(16).slice(2, 10), aid, at, cause, label, 1)
  db.prepare('INSERT INTO affect_samples(id,agent_id,at,label,intensity,fast,slow) VALUES(?,?,?,?,?,?,?)')
    .run('afs_' + Math.random().toString(16).slice(2, 10), aid, at2, label, 0.766,
      JSON.stringify({ pleasure: 0.2, arousal: 0.1, dominance: 0.1 }),
      JSON.stringify({ slow: 0.11, fast: 0.2, total: 0.18, fast_self: 0.02, fast_empathy: 0.18 }))
}

const est = (t) => Math.ceil(String(t).length / 2)
const memCount = (t) => {
  const i = t.indexOf('关于这句话，你能想起的事')
  if (i < 0) return 0
  return t.slice(i).split('\n').filter((l) => l.startsWith('- ')).length
}
const digitsOf = (t) => (String(t).match(/[+-]?\d+\.\d+/g) || [])
const DIGIT_LINE = /（上一句落在我身上|（\d\d:\d\d 那会儿的读数/

function run(aid, opt = {}) {
  return consciousnessBlock(db, aid, opt)
}

// ============ 场景 1：正常配对，开 / 关 ============
{
  const aid = mkAgent('正常')
  snapRows(aid)
  const on = run(aid)
  writeParam(db, aid, 'affect.inject.snapshot', 'off')
  const off = run(aid)
  writeParam(db, aid, 'affect.inject.snapshot', 'on')

  check('开：快照在', on.includes(SNAP), on.slice(0, 160))
  check('关：快照不在', !off.includes(SNAP), off.includes(SNAP))
  const snapLine = on.split('\n').find((l) => DIGIT_LINE.test(l)) || ''
  check('快照行不含命令词', !/(必须|照这个|照着|你应该|别忘了念|按这个)/.test(snapLine), snapLine)
  {
    /* 数字只允许出现在快照行里：把快照行抠掉之后，开版与关版的数字应该一样多 */
    const onRest = digitsOf(on.split('\n').filter((l) => !DIGIT_LINE.test(l)).join('\n')).length
    const offAll = digitsOf(off).length
    check('数字不外漏：别的行数字个数没变', onRest <= offAll, { onRest, offAll, snapLine: snapLine.slice(0, 80) })
  }
  const dTok = est(on) - est(off)
  check('token 增幅在 15% 以内', dTok <= est(off) * 0.15, { dTok, offTok: est(off), pct: (dTok / est(off) * 100).toFixed(1) })
  const dMem = memCount(off) - memCount(on)
  check('记忆条数最多只掉 1 条', dMem <= 1, { onMem: memCount(on), offMem: memCount(off) })
  console.log('   → 开 ' + est(on) + ' tok / 关 ' + est(off) + ' tok；记忆 ' + memCount(on) + ' / ' + memCount(off) + ' 条')
}

// ============ 场景 2：该不给的 ============
{
  const aid = mkAgent('不给')
  snapRows(aid, { minutesAgo: 60 * 13 })          // 13 小时前
  check('超龄 13h：不给', !run(aid).includes(SNAP), 'age')
  const aid2 = mkAgent('技术噪音')
  snapRows(aid2, { cause: 'C:\\Users\\ygys1\\Desktop\\ds\\token.txt 里的 key' })
  const b = run(aid2)
  check('技术噪音：不念原话', !b.includes('token.txt') && !b.includes('C:\\'), b.match(/（上一句[^\n]*/)?.[0])
  check('技术噪音：仍然给数（有那一刻）', b.includes(SNAP), b.slice(0, 120))
  const aid3 = mkAgent('陌生人')
  snapRows(aid3)
  check('陌生人：不给', !run(aid3, { audience: 'stranger' }).includes(SNAP), 'stranger')
  const aid4 = mkAgent('QQ非主人')
  snapRows(aid4)
  check('QQ 非主人：不给', !run(aid4, { snap: 'off' }).includes(SNAP), 'qq')
}

// ============ 场景 3：未配对（样本旁边没有那句话） ============
{
  const aid = mkAgent('未配对')
  const at = new Date(Date.now() - 40 * 1000).toISOString()
  db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,label,gate) VALUES(?,?,?,?,?,?)')
    .run('aev_np_' + aid, aid, at, '这句话旁边没有数', 'peaceful', 0)
  db.prepare('INSERT INTO affect_samples(id,agent_id,at,label,intensity,fast,slow) VALUES(?,?,?,?,?,?,?)')
    .run('afs_np_' + aid, aid, new Date(Date.now() - 5 * 1000).toISOString(), 'peaceful', 0.7,
      JSON.stringify({}), JSON.stringify({ slow: 0.11, fast: 0.2 }))
  const b = run(aid)
  check('未配对：原话不出现', !b.includes('这句话旁边没有数'), b.match(/（[^\n]*读数[^\n]*/)?.[0])
  check('未配对：仍然给那一刻的数', b.includes('那会儿的读数'), b.slice(0, 160))
}

// ============ 场景 4：预算紧 ============
{
  const aid = mkAgent('预算紧')
  snapRows(aid)
  writeParam(db, aid, 'memory.inject.budget', 120)
  const b = run(aid)
  check('预算 120：整行丢', !b.includes(SNAP), b.slice(0, 200))
  check('预算 120：不漏半句', !b.includes('那一刻 慢'), b.slice(0, 200))
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
