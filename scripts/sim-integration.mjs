/**
 * 整体功能模拟：走一遍真实的写入路径（不是手搓行），看下一轮拼出来的提示词。
 *   node scripts/sim-integration.mjs
 *
 * 链路：appraise() → applyEmotionV3() → 写 affect_events + affect_samples
 *        → recordUnsaid() → events
 *        → consciousnessBlock() → 「上一句落在我身上的样子」那一行
 *
 * 这一条链就是真机上每轮走的那条，只是模型换成了固定答案。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { seedAffect, appraise } from '../src/core.js'
import { recordUnsaid } from '../src/features.js'
import { consciousnessBlock } from '../index.js'
import { seedTiers } from '../src/modules/relations.js'
import { writeParam } from '../src/kernel.js'
import { feltSnapshot } from '../src/modules/felt_snapshot.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

const now = () => new Date().toISOString()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-int-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sim_int'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())
const put = db.prepare('INSERT INTO persona(agent_id,path,value,updated_at) VALUES(?,?,?,?)')
put.run(aid, 'style.tone', JSON.stringify('可爱粘人'), now())
put.run(aid, 'style.address', JSON.stringify('主人'), now())
put.run(aid, 'axis.ei', JSON.stringify(0.35), now())
seedTiers(db)
db.prepare(`INSERT INTO rel_person(id,agent_id,name,tier,closeness,trust,dependence,salience,status,
  first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('rp_1', aid, '主人', 'owner', 0.94, 0.74, 0.22, 1, 'active', now(), now(), now(), now())
seedAffect(db, aid)

const S = (main) => {
  const o = {}
  for (const k of ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']) o[k] = 0.125
  o[main] = 1 - 0.125 * 7
  return o
}
const hintOf = (label, { target = 'me', kind = 'chat', unsaid = '', why = '测试用固定答案' } = {}) => ({
  source: 'model', kind, label, target, unsaid, why,
  concern_relevance: 0.6, concern_congruence: label === 'peaceful' || label === 'joy' ? 0.4 : -0.3,
  change: 0.2, novelty: 0.3, certainty: 0.8, agency: 'other', none: false, receive: 'follow',
  scores: S(label), user_scores: S('peaceful'), user_label: 'peaceful',
})

const counts = () => ({
  e: db.prepare('SELECT COUNT(*) n FROM affect_events WHERE agent_id=?').get(aid).n,
  s: db.prepare('SELECT COUNT(*) n FROM affect_samples WHERE agent_id=?').get(aid).n,
  u: db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='unsaid.moment'").get(aid).n,
})

// ---------------- 第一轮：真的走评价写库 ----------------
const c0 = counts()
let res = null
try {
  res = await appraise(db, aid, '我可不舍得说难听的话', { hint: hintOf('peaceful', { unsaid: '其实想被你多抱一会儿，但没说' }) })
} catch (e) {
  console.log('appraise 抛了：' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e))
}
const c1 = counts()
check('第一轮：写了 affect_events', c1.e === c0.e + 1, { c0, c1 })
check('第一轮：写了 affect_samples', c1.s === c0.s + 1, { c0, c1 })
check('第一轮：评价有结果', !!res && !!res.label, res && res.label)

// 影子落库（真机上由 appraiseWithEdges 调）
recordUnsaid(db, aid, { text: '其实想被你多抱一会儿，但没说', eventId: res && res.id, cause: '我可不舍得说难听的话' })
const c2 = counts()
check('第一轮：咽回去那句落库了', c2.u === c1.u + 1, { c1, c2 })

// ---------------- 快照读得到 ----------------
const snap = feltSnapshot(db, aid, {})
check('快照：配对成功', !!snap && snap.paired === true, snap)
check('快照：原话对', !!snap && snap.cause === '我可不舍得说难听的话', snap && snap.cause)
check('快照：数对（跟写进去的一致）', !!snap && typeof snap.slow === 'number' && typeof snap.fast === 'number', snap)

// ---------------- 下一轮拼提示词 ----------------
const block = consciousnessBlock(db, aid)
check('注入：有「上一句落在我身上的样子」', block.includes('（上一句落在我身上'), block.includes('（上一句落在我身上'))
check('注入：带原话', block.includes('我可不舍得说难听的话'), '')
check('注入：影子不回读（unsaid 不出现）', !block.includes('多抱一会儿'), block.match(/多抱[^\n]*/)?.[0])
check('注入：快照在情绪行之后', block.indexOf('感觉现在大概') < block.indexOf('（上一句落在我身上'), {
  felt: block.indexOf('感觉现在大概'), snap: block.indexOf('（上一句落在我身上'),
})

// ---------------- 第二轮：快照要换成新的那句 ----------------
await appraise(db, aid, '那你明天提醒我一下体检', { hint: hintOf('calm', { target: 'none', kind: 'task' }) })
const s2 = feltSnapshot(db, aid, {})
check('第二轮：快照跟着换到最新那轮', !!s2 && s2.cause === '那你明天提醒我一下体检', s2 && s2.cause)
const block2 = consciousnessBlock(db, aid)
check('第二轮：注入里是新原话', block2.includes('那你明天提醒我一下体检'), '')

// ---------------- 关掉开关就逐字回旧 ----------------
writeParam(db, aid, 'affect.inject.snapshot', 'off')
const off = consciousnessBlock(db, aid)
check('关掉：快照整行消失', !off.includes('（上一句落在我身上'), off.includes('（上一句落在我身上'))

console.log('\n—— 实际拼出来的那一行 ——')
console.log(s2 ? s2.line : '(无)')
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
