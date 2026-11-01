/**
 * 情绪通路模拟：把「一条消息 → 评价 → 边/五轴 → 动力学 → 情绪表/片段」整条链跑一遍，
 * 覆盖 off / shadow / on 三种挡位、四种鱼格、八类刺激，外加衰减、标签惯性、12 道门、
 * 自述与日记取材、以及 30 轮连续对话。
 *
 * 用法：node scripts/sim-affect-v2.mjs
 * 退出码：0 = 全过；1 = 有断言失败。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { seedState } from '../src/core.js'
import { appraiseWithEdges, decideSpeak } from '../src/features.js'
import { decayAffect, getAffect } from '../src/modules/affect.js'
import { readAxes, setAxisAuto, stimulusStrength, traitAmp, sensitivityOf } from '../src/modules/traits.js'
import { computeEdgeBias } from '../src/modules/edges.js'
import { getSelfview } from '../src/modules/selfview.js'
import { diaryContext, diaryTone } from '../src/modules/archive.js'

let pass = 0
const fails = []
function check(name, ok, detail) {
  if (ok) { pass++; return }
  fails.push({ name, detail })
  console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-affect-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
let seq = 0
function mkAgent(tag) {
  const id = 'agt_sim_' + (++seq)
  db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, tag, 'daily', 'active', now())
  seedState(db, id)
  return id
}
function setAxes(aid, axes) {
  for (const [k, v] of Object.entries(axes)) {
    db.prepare('UPDATE persona SET value=? WHERE agent_id=? AND path=?').run(String(v), aid, 'axis.' + k)
  }
}
function setMode(aid, mode) {
  db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
    .run(aid, 'persona.axes.mode', JSON.stringify(mode), now())
}
function resetAffect(aid) {
  db.prepare('DELETE FROM affect_episodes WHERE agent_id=?').run(aid)
  db.prepare('UPDATE affect_state SET primary_label=?, intensity=?, mood=?, pleasure=?, arousal=?, dominance=?, updated_at=? WHERE agent_id=?')
    .run('calm', 0.2, 0.6, 0.1, -0.1, 0, now(), aid)
}
const LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']

const PROFILES = {
  neutral: { ei: 0.5, sn: 0.5, tf: 0.5, jp: 0.5, sensitivity: 0.5 },
  sensitive: { ei: 0.5, sn: 0.5, tf: 0.9, jp: 0.5, sensitivity: 0.9 },
  blunt: { ei: 0.5, sn: 0.5, tf: 0.9, jp: 0.5, sensitivity: 0.1 },
  extreme: { ei: 0.95, sn: 0.05, tf: 0.95, jp: 0.05, sensitivity: 0.95 },
}

const UTTS = [
  { kind: 'praise', text: '谢谢你，我很喜欢你' },
  { kind: 'critic', text: '你错了，真差劲，别说了' },
  { kind: 'neutral', text: '今天天气不错' },
  { kind: 'why', text: '为什么天空是蓝色的？' },
  { kind: 'plan', text: '计划改了，来不及了，今天必须交' },
  { kind: 'warm', text: '我一直在，别担心' },
  { kind: 'cold', text: '随便你，都行' },
  { kind: 'threat', text: '危险，别删，密码会泄露' },
]

async function oneTurn(aid, text) {
  const t0 = Date.now()
  const res = await appraiseWithEdges(db, aid, text)
  return { res, ms: Date.now() - t0 }
}

// ---------------- 1) 单轮：off / shadow / on × 四鱼格 × 八类刺激 ----------------
const single = {}
for (const mode of ['off', 'shadow', 'on']) {
  for (const [pname, axes] of Object.entries(PROFILES)) {
    const aid = mkAgent('单轮·' + pname)
    setMode(aid, mode)
    setAxes(aid, axes)
    single[mode] = single[mode] || {}
    single[mode][pname] = {}
    for (const u of UTTS) {
      resetAffect(aid)
      const { res, ms } = await oneTurn(aid, u.text)
      single[mode][pname][u.kind] = {
        label: res.label, intensity: res.intensity, S: res.edges && res.edges.intensityMul,
        ms, pleasure: res.pleasure, arousal: res.arousal, mood: res.mood,
      }
      check(`通路跑通 ${mode}/${pname}/${u.kind}`, Number.isFinite(res.intensity) && res.intensity >= 0 && res.intensity <= 1
        && LABELS.includes(res.label), { label: res.label, intensity: res.intensity })
      check(`PAD 有限 ${mode}/${pname}/${u.kind}`,
        [res.pleasure, res.arousal, res.dominance, res.mood].every((x) => Number.isFinite(x)),
        { p: res.pleasure, a: res.arousal, d: res.dominance, m: res.mood })
    }
  }
}

// off：四鱼格结果完全一样（性格不参与）
for (const u of UTTS) {
  const vals = Object.values(single.off).map((x) => x[u.kind].intensity)
  check('off：鱼格不影响强度 ' + u.kind, new Set(vals.map((v) => v.toFixed(6))).size === 1, vals)
}
// shadow：结果与 off 相同（只算不用）
for (const u of UTTS) {
  const a = single.off.neutral[u.kind].intensity
  const b = single.shadow.neutral[u.kind].intensity
  check('shadow：结果等于 off ' + u.kind, Math.abs(a - b) < 1e-9, { off: a, shadow: b })
}
// shadow 期写出了影子采样
{
  const n = db.prepare("SELECT COUNT(*) n FROM metric_samples WHERE key='axis.shadow.intensity'").get().n
  check('shadow：写了影子采样', Number(n) > 0, n)
}
// on：中性鱼格与 off 相同（σ=.5、A=0 → ×1.000）
for (const u of UTTS) {
  const a = single.off.neutral[u.kind].intensity
  const b = single.on.neutral[u.kind].intensity
  check('on：中性鱼格不被拧 ' + u.kind, Math.abs(a - b) < 1e-9, { off: a, on: b })
}
// on：敏感 > 钝感（同一个 tf=.9，只差 σ）
for (const kind of ['praise', 'critic', 'threat']) {
  const s = single.on.sensitive[kind].intensity
  const b = single.on.blunt[kind].intensity
  check('on：敏感比钝感更响 ' + kind, s > b, { sensitive: s, blunt: b })
}

// ---------------- 2) 门槛：S < T 时不放大 ----------------
{
  const axes = PROFILES.blunt
  const s = stimulusStrength({ goal_congruence: 0, novelty: 0, certainty: 0.9, goal_relevance: 0.2 }, 0.4)
  const amp = traitAmp(axes, { ei: 1, sn: 1, tf: 1, jp: 1 }, s)
  check('门槛：小事不算（A=0）', amp.A === 0 && s < sensitivityOf(axes).threshold, { s, t: sensitivityOf(axes).threshold })
  const axes2 = PROFILES.sensitive
  const s2 = stimulusStrength({ goal_congruence: -0.8, novelty: 0.7, certainty: 0.2, goal_relevance: 0.9 }, 0.9)
  const amp2 = traitAmp(axes2, { ei: 1, sn: 1, tf: 1, jp: 1 }, s2)
  check('门槛：大事算（A>0）', amp2.A > 0, { s: s2, A: amp2.A })
}

// ---------------- 3) 衰减：敏感的人恢复更慢 ----------------
for (const [pname, axes] of [['sensitive', PROFILES.sensitive], ['blunt', PROFILES.blunt]]) {
  const aid = mkAgent('衰减·' + pname)
  setMode(aid, 'off')
  setAxes(aid, axes)
  resetAffect(aid)
  db.prepare('UPDATE affect_state SET intensity=?, primary_label=? WHERE agent_id=?').run(0.8, 'irritated', aid)
  decayAffect(db, aid, 24)
  single.decay = single.decay || {}
  single.decay[pname] = getAffect(db, aid).intensity
  check('衰减跑通 ' + pname, Number.isFinite(single.decay[pname]), single.decay[pname])
}
check('衰减：敏感的人 24h 后剩得更多', single.decay.sensitive > single.decay.blunt, single.decay)

// ---------------- 4) 标签惯性：新标签要连续两轮 ----------------
{
  const aid = mkAgent('惯性')
  setMode(aid, 'off')
  setAxes(aid, PROFILES.neutral)
  resetAffect(aid)
  const r1 = (await oneTurn(aid, '你错了，真差劲')).res
  const r2 = (await oneTurn(aid, '你错了，真差劲')).res
  check('惯性：第一轮不一定换标签', r1.label === 'calm' || r1.label === 'irritated', r1.label)
  check('惯性：连续两轮后换到 irritated', r2.label === 'irritated', { r1: r1.label, r2: r2.label })
}

// ---------------- 5) 12 道门：三档都跑完 ----------------
{
  const aid = mkAgent('闸门')
  setMode(aid, 'on')
  setAxes(aid, PROFILES.extreme)
  db.prepare('UPDATE drive_state SET r=0.2 WHERE agent_id=?').run(aid)
  let last = null
  for (let i = 0; i < 3; i++) {
    last = decideSpeak(db, aid)
    check('闸门：字段齐全 #' + i, typeof last.reason === 'string' && Array.isArray(last.gates) && last.gates.length === 12, Object.keys(last))
  }
  check('闸门：给了解释', typeof last.explain === 'string' && last.explain.length > 0, last.explain && last.explain.slice(0, 40))
}

// ---------------- 6) 自述 / 日记：五轴进得去 ----------------
{
  const aid = mkAgent('取材')
  setAxes(aid, PROFILES.extreme)
  const sv = getSelfview(db, aid)
  check('自述：now 里是五轴', Array.isArray(sv.now.axes) && sv.now.axes.length === 5, sv.now && Object.keys(sv.now))
  const ctx = diaryContext(db, aid)
  check('日记：快照带五轴', Number(ctx.axes.tf) > 0.9, ctx.axes)
  check('日记：口吻能出来', typeof diaryTone(ctx) === 'string' && diaryTone(ctx).length > 0, diaryTone(ctx))
}

// ---------------- 7) 30 轮连续对话：不炸、不 NaN、不锁死 ----------------
{
  const aid = mkAgent('连跑')
  setMode(aid, 'on')
  setAxes(aid, PROFILES.extreme)
  resetAffect(aid)
  const seen = new Set()
  let min = 1
  let max = 0
  for (let i = 0; i < 30; i++) {
    const u = UTTS[i % UTTS.length]
    const res = await oneTurn(aid, u.text)
    check(`连跑 30 轮：第 ${i + 1} 轮有限`, Number.isFinite(res.res.intensity) && Number.isFinite(res.res.mood), { i, v: res.res.intensity })
    seen.add(res.res.label)
    min = Math.min(min, res.res.intensity)
    max = Math.max(max, res.res.intensity)
    decayAffect(db, aid, 1)
  }
  check('连跑 30 轮：强度在 0~1', min >= 0 && max <= 1, { min, max })
  check('连跑 30 轮：标签没全卡死', seen.size >= 2, [...seen])
}

// ---------------- 汇总 ----------------
const fmt = (x) => Number(x).toFixed(3)
const rows = Object.entries(PROFILES).map(([p]) => {
  const cells = UTTS.map((u) => u.kind + '=' + fmt(single.on[p][u.kind].intensity)).join('  ')
  return p.padEnd(10) + cells
})
console.log('\n单轮强度（on）')
for (const r of rows) console.log('  ' + r)
console.log('\n衰减 24h：敏感 ' + fmt(single.decay.sensitive) + ' / 钝感 ' + fmt(single.decay.blunt))
console.log('通过 ' + pass + ' / ' + (pass + fails.length))
if (fails.length) {
  console.log('失败:', fails.map((f) => f.name))
  process.exitCode = 1
}
try { db.close() } catch { /* 已关 */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 上句柄可能还挂着，下次重启再清 */ }
