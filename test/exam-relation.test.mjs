/**
 * 关系动力零件 · 考卷
 *
 * 管的是「一件事发生之后，亲近 / 信任 / 依赖各自挪多少」：有界、边际递减、伤比暖快，
 * 以及衰减回基线、修复只回信任、关系怎么投影成说话分温度。
 * 不管「这件事算不算冲她来的」（情绪评价 / 边）、不管「要不要记进记忆」（冷暖）。
 *
 * 运行：node test/exam-relation.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AXIS_MAX, REL_DEFAULTS, SOURCE_WEIGHT, DEP_BY_KIND,
  eventValence, moodAdjust, habitOf, weightOf,
  applyEvent, decayAxis, decayRelation, repairTrust, toneOf, stimulusKey,
} from '../src/algo/reldyn.js'
import { run as algoRun, list as algoList } from '../src/algo/index.js'
import { openDb, now } from '../src/db.js'
import * as REL from '../src/modules/relations.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) <= eps
const S = (c, t, d) => ({ closeness: c, trust: t, dependence: d })
const run = (v, input) => algoRun('relation_dyn', v, {}, input)

// ================================================================ 效价：什么算一件事
{
  const good = eventValence({ goalCongruence: 0.8, total: 1, directed: true, agency: 'other', kind: 'chat' })
  check('冲我来的、合我意 → 正', near(good, 0.8), good)
  const half = eventValence({ goalCongruence: 0.8, total: 1, directed: false, agency: 'other' })
  check('不冲我来的，只算一半', near(half, 0.4), half)
  const self = eventValence({ goalCongruence: 0.8, total: 1, directed: true, agency: 'self' })
  check('自己做的事，关系几乎不动（×0.3）', near(self, 0.24), self)
  check('越界 / 禁忌 → 直落 -1', eventValence({ goalCongruence: 0.5, taboo: true }) === -1)
  check('boundary 一律算 -1', eventValence({ goalCongruence: 1, kind: 'boundary' }) === -1)
  const weak = eventValence({ goalCongruence: -0.5, total: 0, directed: true, agency: 'other' })
  check('没说多重的批评也有分量（地板 0.4）', near(weak, -0.2), weak)
  const strong = eventValence({ goalCongruence: -0.5, total: 1, directed: true, agency: 'other' })
  check('说得很重的批评更疼', strong < weak, { weak, strong })
  check('效价夹在 -1..1', eventValence({ goalCongruence: 9, total: 9, directed: true }) <= 1)
}

// ================================================================ 心情与习惯：为什么同一句会越来越不疼
{
  const posMood = moodAdjust(0.5, 1)
  const lowMood = moodAdjust(0.5, 0)
  check('心情好，正向被放大', posMood > lowMood, { posMood, lowMood })
  check('负向不受心情影响（不给她「心情差所以更恨」的通道）', moodAdjust(-0.6, 0) === -0.6 && moodAdjust(-0.6, 1) === -0.6)
  check('放大后仍不超过 1', moodAdjust(1, 1) <= 1)

  check('第一次来，不打折', habitOf({ count: 0, lastAt: null }).factor === 1)
  const now = 1_700_000_000_000
  const twice = habitOf({ count: 1, lastAt: now, now })
  check('同类第二次，冲击变小', twice.factor < 1 && twice.factor > 0.7, twice)
  const later = habitOf({ count: 1, lastAt: now - 72 * 3600000, now })
  check('隔了 72 小时，恢复大半', later.factor > twice.factor, { twice: twice.factor, later: later.factor })
  const forever = habitOf({ count: 50, lastAt: now, now })
  check('再腻也留 0.2，不会归零', forever.factor >= REL_DEFAULTS.habitFloor, forever)
  check('习惯化交回下一次的计数与时间', typeof twice.nextCount === 'number' && twice.nextAt === now, twice)
}

// ================================================================ 权重：谁说的话更算数
{
  check('面对面聊天权重 1', weightOf({ source: 'chat' }) === 1)
  check('工具调用不算面对面', weightOf({ source: 'tool' }) === SOURCE_WEIGHT.tool && weightOf({ source: 'tool' }) < 0.5)
  check('系统自己的话最轻', weightOf({ source: 'system' }) === 0.2)
  check('被她想起来时更算数，但不超过 1', weightOf({ source: 'chat', recalled: true }) === 1)
  check('工具 + 被想起 = 0.48', near(weightOf({ source: 'tool', recalled: true }), 0.48))
  check('习惯化同时进权重', weightOf({ source: 'chat', habit: 0.741 }) < 1)
  check('未知来源按 1 算，不炸', weightOf({ source: 'nope' }) === 1)
}

// ================================================================ 三条性质：有界、边际递减、伤比暖快
{
  let x = S(0.5, 0.5, 0.2)
  for (let i = 0; i < 300; i++) x = applyEvent(x, { v: 1, w: 1, kind: 'chat' })
  check('一直对她好，也顶得到 0.999 不到 1', x.closeness > 0.99 && x.closeness <= AXIS_MAX && x.trust <= AXIS_MAX, x)

  const cold = applyEvent(S(0.2, 0.2, 0.2), { v: 1, w: 1, kind: 'chat' })
  const warm = applyEvent(S(0.9, 0.9, 0.9), { v: 1, w: 1, kind: 'chat' })
  check('越亲越难再近（边际递减）', cold.delta.closeness > warm.delta.closeness, { cold: cold.delta, warm: warm.delta })

  const up = applyEvent(S(0.5, 0.5, 0.2), { v: 1, w: 1, kind: 'chat' })
  const down = applyEvent(S(0.5, 0.5, 0.2), { v: -1, w: 1, kind: 'chat' })
  check('信任破得比涨得快（不对称）', Math.abs(down.delta.trust) > up.delta.trust, { up: up.delta.trust, down: down.delta.trust })
  check('涨信任比破信任慢一倍以上', up.delta.trust * 2 < Math.abs(down.delta.trust), { up: up.delta.trust, down: down.delta.trust })

  const cap = applyEvent(S(0, 0, 0), { v: 1, w: 1, kind: 'help' })
  check('单次变化有上限（0.05）', Math.abs(cap.delta.closeness) <= REL_DEFAULTS.stepCap + 1e-9 && cap.delta.closeness > 0.04, cap.delta)

  const high = applyEvent(S(0.9, 0.2, 0.2), { v: -1, w: 1, kind: 'chat' })
  const low = applyEvent(S(0.2, 0.2, 0.2), { v: -1, w: 1, kind: 'chat' })
  check('越亲被伤得越狠（负向乘当前值）', Math.abs(high.delta.closeness) > Math.abs(low.delta.closeness), { high: high.delta, low: low.delta })

  const help = applyEvent(S(0.5, 0.5, 0.2), { v: 1, w: 1, kind: 'help' })
  const chat = applyEvent(S(0.5, 0.5, 0.2), { v: 1, w: 1, kind: 'chat' })
  check('被帮忙 / 被分享，依赖涨得比闲聊多', help.delta.dependence > chat.delta.dependence, { help: help.delta, chat: chat.delta })
  check('闲聊只轻轻碰依赖（0.3 比例）', near(chat.delta.dependence, (1 - 0.2) * REL_DEFAULTS.dPos * DEP_BY_KIND.chat), chat.delta.dependence)

  const flat = applyEvent(S(0.5, 0.5, 0.2), { v: 0, w: 1, kind: 'chat' })
  check('没有好坏信号就一点都不动', flat.delta.closeness === 0 && flat.delta.trust === 0 && flat.delta.dependence === 0, flat.delta)
  check('依赖的起点是 0.2，不是 0', near(applyEvent(S(0.5, 0.5, undefined), { v: 1 }).delta.dependence,
    (1 - 0.2) * REL_DEFAULTS.dPos * 0.3), '默认 0.2')
  check('结果永远落在 0..0.999', [1, -1].every((v) => {
    const o = applyEvent(S(AXIS_MAX, 0, AXIS_MAX), { v, w: 1 })
    return o.closeness >= 0 && o.closeness <= AXIS_MAX && o.trust >= 0 && o.trust <= AXIS_MAX
  }), '边界')
}

// ================================================================ 衰减：淡回基线的一半
{
  const half = decayAxis(0.9, 0.5, 10, 10)
  check('隔了半个半衰期以上、正好一半 → 回到中点', near(half, 0.7, 1e-6), half)
  check('基线就是当前值 → 不动', near(decayAxis(0.6, 0.6, 30, 10), 0.6, 1e-9))
  check('没给半衰期 → 不动（主人的 κ/ρ 走 R09，不走曲线）', decayAxis(0.9, 0.5, 30, 0) === 0.9)
  check('今天刚动过 → 不动', decayAxis(0.9, 0.5, 0, 10) === 0.9)
  const long = decayAxis(0.9, 0.5, 100, 10)
  check('越久越贴近基线，但不到基线', long > 0.5 && long < 0.51, long)
  check('往下也回（比基线低的往回升）', decayAxis(0.2, 0.6, 10, 5) > 0.2)

  const r = decayRelation({ closeness: 0.9, trust: 0.8, dependence: 0.5 }, { idleDays: 10, baseline: { closeness: 0.5, trust: 0.6, dependence: 0.3 }, halfLife: { closeness: 10 } })
  check('三轴一起回归', near(r.closeness, 0.7, 1e-6), r)
  check('没给半衰期的轴不动', r.trust === 0.8 && near(r.dependence, 0.5), r)
  check('基线缺省时退回当前值，不动', near(decayRelation({ closeness: 0.9 }, { idleDays: 5, halfLife: { closeness: 10 } }).closeness, 0.9), '默认基线')
}

// ================================================================ 修复：只回信任，且回不到受损前
{
  const p = REL_DEFAULTS
  const gain = (1 - 0.4) * p.rPos * 0.6
  const rep = repairTrust({ closeness: 0.7, trust: 0.4, dependence: 0.3 }, { strength: 0.6, w: 1 })
  check('道歉只补信任', rep.trust > 0.4 && near(rep.delta, gain), rep)

  const capped = repairTrust({ trust: 0.4 }, { strength: 0.6, w: 1, ceiling: 0.41 })
  check('受损上限挡住「一次修回原样」', near(capped.trust, 0.41), capped)
  const uncapped = repairTrust({ trust: 0.4 }, { strength: 0.6, w: 1 })
  check('没有上限时也只是慢慢回', uncapped.trust < 0.45, uncapped)
  check('不给力度就一点不回', repairTrust({ trust: 0.4 }, { strength: 0, w: 1 }).delta === 0)
  check('修复不会超过 0.999', repairTrust({ trust: AXIS_MAX }, { strength: 1, w: 1 }).trust <= AXIS_MAX)
}

// ================================================================ 投影成话：关系怎么变成语气
{
  const owner = toneOf({ closeness: 0.89, trust: 0.9, kind: 'owner', mood: 0.5, extraversion: 0.9 })
  check('对着主人，默认就是暖的', owner.warmth > 0.9 && owner.label === '热情', owner)
  check('对着陌生人，话就收着', toneOf({ closeness: 0.05, kind: 'stranger', mood: 0.5 }).label === '疏离',
    toneOf({ closeness: 0.05, kind: 'stranger', mood: 0.5 }))
  const near1 = toneOf({ closeness: 0.9, kind: 'owner', mood: 0.5 })
  const far1 = toneOf({ closeness: 0.2, kind: 'owner', mood: 0.5 })
  check('越亲越暖', near1.warmth > far1.warmth, { near: near1.warmth, far: far1.warmth })
  check('越亲越不端着（正式度下降）', near1.formality < far1.formality, { near: near1.formality, far: far1.formality })
  check('披露有帽子：不超过这一档的底数', toneOf({ closeness: 1, trust: 1, kind: 'owner' }).disclosure <= 0.70 + 1e-9,
    toneOf({ closeness: 1, trust: 1, kind: 'owner' }).disclosure)
  const happy = toneOf({ closeness: 0.6, kind: 'acquaintance', mood: 1 })
  const sad = toneOf({ closeness: 0.6, kind: 'acquaintance', mood: 0 })
  check('心情好更愿意往前一步（主动）', happy.initiative > sad.initiative, { happy: happy.initiative, sad: sad.initiative })
  check('四样都夹在 0..1', [owner, happy, sad].every((t) => t.warmth >= 0 && t.warmth <= 1
    && t.formality >= 0 && t.formality <= 1 && t.disclosure >= 0 && t.disclosure <= 1
    && t.initiative >= 0 && t.initiative <= 1))
  check('认不出的档位按熟人来，不炸', toneOf({ kind: 'nope', closeness: 0.5 }).label !== undefined)
}

// ================================================================ 两个版本与算法册
{
  const names = algoList().filter((a) => a.name === 'relation_dyn').map((a) => a.version).sort()
  check('v1 / v1b 都已登记', names.join(',') === 'v1,v1b', names)
  const spec = algoList().find((a) => a.name === 'relation_dyn' && a.version === 'v1')
  check('算法册认到关系动力这个零件', spec && spec.owner === 'relation', spec && spec.owner)
  check('算法册指得到实现文件', spec && /reldyn\.js$/.test(String(spec.file).replace(/^file:\/\/\//, '')), spec && spec.file)

  const st = { closeness: 0.5, trust: 0.5, dependence: 0.2 }
  const direct = applyEvent(st, { v: 1, w: 1, kind: 'help' })
  const viaReg = run('v1', { mode: 'apply', state: st, event: { v: 1, w: 1, kind: 'help' } })
  check('注册表跑出来和直调一模一样', near(direct.closeness, viaReg.closeness) && near(direct.trust, viaReg.trust)
    && near(direct.dependence, viaReg.dependence), { direct, viaReg })
  check('注册表会说出自己是谁（v1）', viaReg.algo && viaReg.algo.version === 'v1', viaReg.algo)

  const regDec = run('v1', { mode: 'decay', state: { intensity: 1 }, hours: 1 })
  check('注册表的衰减模式也能走', regDec.algo && regDec.algo.mode === 'decay', regDec.algo)
  const regRep = run('v1', { mode: 'repair', state: { trust: 0.4 }, strength: 0.6 })
  check('注册表的修复模式也能走', regRep.algo && regRep.algo.mode === 'repair', regRep.algo)

  const a = applyEvent(st, { v: 1, w: 1, kind: 'chat' })
  const b = run('v1b', { mode: 'apply', state: st, event: { v: 1, w: 1, kind: 'chat' } })
  check('v1b 比 v1 更容易被感动（步长更大）', b.closeness > a.closeness && b.trust > a.trust, { v1: a, v1b: b })
  // 上限：同样从 0 起步，v1 顶到 0.05，v1b 顶到 0.06（cap 1.2）
  const capA = run('v1', { mode: 'apply', state: { closeness: 0, trust: 0, dependence: 0 }, event: { v: 1, w: 1, kind: 'chat' } })
  const capB = run('v1b', { mode: 'apply', state: { closeness: 0, trust: 0, dependence: 0 }, event: { v: 1, w: 1, kind: 'chat' } })
  check('v1b 的变化上限也放宽了（0.05 → 0.06）', near(capA.delta.closeness, 0.05) && near(capB.delta.closeness, 0.06), { v1: capA.delta.closeness, v1b: capB.delta.closeness })

  check('同一件事的指纹：同类型 + 同标签才合并', stimulusKey('joy', 'praise') === stimulusKey('joy', 'praise')
    && stimulusKey('joy', 'praise') !== stimulusKey('calm', 'praise'))
}

// ================================================================ 落到账本上：修复只回信任
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-exam-rel-'))
  const db = openDb(path.join(dir, 'app.db'))
  const aid = 'agt_exam_rel'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
    .run(aid, '考卷关系', 'daily', 'active', now(), 13)
  REL.bootstrap(db, aid)
  const before = REL.ownerPerson(db, aid)
  const beforeEv = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
  const rep = REL.bumpRelation(db, aid, { v: 0.5, kind: 'repair', source: 'chat', reason: '考卷：道歉' })
  const after = REL.ownerPerson(db, aid)
  const afterEv = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
  check('账本上修复只回信任，亲近不动', rep.changed.length === 1 && rep.changed[0].field.startsWith('relations.')
    && Math.abs(after.closeness - before.closeness) < 1e-9 && after.trust > before.trust,
    { before, after, changed: rep.changed })
  check('修复也记一笔账', Number(afterEv) === Number(beforeEv) + 1, { beforeEv, afterEv })
  REL.bumpRelation(db, aid, { v: 0.8, kind: 'praise', source: 'chat' })
  const praised = REL.ownerPerson(db, aid)
  REL.bumpRelation(db, aid, { v: -0.8, kind: 'critic', source: 'chat' })
  const hurt = REL.ownerPerson(db, aid)
  check('账本上夸奖抬信任、批评压信任（同一个人同一份账）', praised.trust > after.trust && hurt.trust < praised.trust,
    { after: after.trust, praised: praised.trust, hurt: hurt.trust })
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
