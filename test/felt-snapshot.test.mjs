/**
 * 感受快照：上一句的原话 + 当时的数。只读。
 * 运行：node test/felt-snapshot.test.mjs
 *
 * 重点覆盖「配错」这一类：
 *   affect_samples 有一半左右的样本不是评价写的（decayAffect / spontaneousTick），
 *   旁边没有那句话。只看时间差就会把自发抖动的数配到上一句话上——这里逐条堵死。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { feltSnapshot } from '../src/modules/felt_snapshot.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-snap-'))
const db = openDb(path.join(dir, 'app.db'))
const T0 = Date.parse('2026-11-03T22:00:00.000Z')

let seq = 0
function mkAgent(name) {
  seq++
  const id = 'agt_snap_' + seq
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, name, 'daily', 'active', new Date(T0).toISOString())
  return id
}
function iso(ms) { return new Date(ms).toISOString() }
function insEv(aid, at, cause, label, gate = 0) {
  const id = 'aev_' + Math.random().toString(16).slice(2, 10)
  db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,label,gate) VALUES(?,?,?,?,?,?)')
    .run(id, aid, iso(at), cause, label, gate)
  return id
}
function insSm(aid, at, label, intensity, slowObj, padObj) {
  const id = 'afs_' + Math.random().toString(16).slice(2, 10)
  db.prepare('INSERT INTO affect_samples(id,agent_id,at,label,intensity,fast,slow) VALUES(?,?,?,?,?,?,?)')
    .run(id, aid, iso(at), label, intensity, JSON.stringify(padObj || { pleasure: 0.2, arousal: 0.1, dominance: 0.1 }),
      typeof slowObj === 'string' ? slowObj : JSON.stringify(slowObj))
  return id
}
const SLOW = { slow: 0.11, fast: 0.2, total: 0.18, fast_self: 0.02, fast_empathy: 0.18 }
const counts = (aid) => ({
  e: db.prepare('SELECT COUNT(*) n FROM affect_events WHERE agent_id=?').get(aid).n,
  s: db.prepare('SELECT COUNT(*) n FROM affect_samples WHERE agent_id=?').get(aid).n,
})

// ---------------- 1 空库 ----------------
{
  const aid = mkAgent('空')
  check('空库：null，不抛', feltSnapshot(db, aid, { at: T0 }) === null)
}

// ---------------- 2 正常配对 ----------------
{
  const aid = mkAgent('配对')
  const at = T0
  insEv(aid, at, '我可不舍得说难听的话', 'peaceful', 1)
  insSm(aid, at + 1, 'peaceful', 0.766, SLOW)
  const s = feltSnapshot(db, aid, { at: at + 60000 })
  check('配对：paired=true', s && s.paired === true, s)
  check('配对：带原话', !!s && s.line.includes('我可不舍得说难听的话'), s && s.line)
  check('配对：带慢情绪的数', !!s && s.line.includes('慢 +0.11'), s && s.line)
  check('配对：带快情绪的数', !!s && s.line.includes('快 +0.20'), s && s.line)
  check('配对：说清这是那时候的读数', !!s && s.line.includes('那时候'), s && s.line)
  check('配对：算出年龄（1 分钟）', !!s && s.ageMin === 1, s && s.ageMin)
}

// ---------------- 3 样本晚了 40 秒（旁边那句话不是它） ----------------
{
  const aid = mkAgent('错位')
  insEv(aid, T0, '发测试', 'peaceful', 0)
  insSm(aid, T0 + 40000, 'peaceful', 0.7, SLOW)
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('错位：paired=false', s && s.paired === false, s)
  check('错位：原话不出现', !!s && !s.line.includes('发测试'), s && s.line)
  check('错位：仍然给数', !!s && s.line.includes('慢 +0.11'), s && s.line)
}

// ---------------- 3b 机器消息不能当「你说的话」 ----------------
{
  const aid = mkAgent('控制标')
  // 上一条：人话
  insEv(aid, T0 - 60000, '别嫌自己吵，最喜欢跟你说话了', 'joy', 1)
  insSm(aid, T0 - 60000 + 1, 'joy', 0.8, { slow: 0.3, fast: 0.3, total: 0.3, fast_self: 0, fast_empathy: 0.3 })
  // 最新一条：宿主塞的控制标
  insEv(aid, T0, '<goal_complete>\nObjective: "按计划把剩下的做完"', 'joy', 0)
  insSm(aid, T0 + 1, 'joy', 0.85, { slow: 0.35, fast: 0.42, total: 0.4, fast_self: 0, fast_empathy: 0.42 })
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('控制标：原话不出现', !!s && !s.line.includes('goal_complete'), s && s.line)
  check('控制标：退回上一句人话', !!s && s.line.includes('别嫌自己吵'), s && s.line)
}

{
  const aid = mkAgent('只有控制标')
  insEv(aid, T0, '<goal_round>\nObjective: 继续干活', 'joy', 0)
  insSm(aid, T0 + 1, 'joy', 0.5, { slow: 0.2, fast: 0.2 })
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('只有控制标：不给原话', !!s && !s.line.includes('Objective'), s && s.line)
  check('只有控制标：仍然给那一刻的数', !!s && s.line.includes('快 +0.20'), s && s.line)
}

{
  const aid = mkAgent('运行时上下文')
  insEv(aid, T0, 'Current runtime context. This snapshot supersedes earlier snapshots.', 'calm', 0)
  insSm(aid, T0 + 1, 'calm', 0.4, { slow: 0.1, fast: 0.1 })
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('运行时上下文：不念', !!s && !s.line.includes('Current runtime'), s && s.line)
}

// ---------------- 4 label 对不上 ----------------
{
  const aid = mkAgent('标签不同')
  insEv(aid, T0, '随便一句', 'peaceful', 0)
  insSm(aid, T0 + 1, 'irritated', 0.7, SLOW)
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('label 不同：paired=false', s && s.paired === false, s)
  check('label 不同：原话不出现', !!s && !s.line.includes('随便一句'), s && s.line)
}

// ---------------- 5 时间倒过来（样本在前） ----------------
{
  const aid = mkAgent('倒序')
  insEv(aid, T0 + 500, '倒着来', 'peaceful', 0)
  insSm(aid, T0, 'peaceful', 0.7, SLOW)
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('倒序：paired=false（事件必须在前）', s && s.paired === false, s)
}

// ---------------- 6 太旧 ----------------
{
  const aid = mkAgent('过夜')
  insEv(aid, T0, '昨晚那句', 'peaceful', 0)
  insSm(aid, T0 + 1, 'peaceful', 0.7, SLOW)
  const s = feltSnapshot(db, aid, { at: T0 + 13 * 3600000 })
  check('超过 12 小时：null', s === null, s)
  const s2 = feltSnapshot(db, aid, { at: T0 + 13 * 3600000, maxAgeMin: 24 * 60 })
  check('放宽到 24 小时：又拿得到', !!s2 && s2.paired === true, s2)
}

// ---------------- 7 slow JSON 坏了 ----------------
{
  const aid = mkAgent('坏数')
  insEv(aid, T0, '坏了', 'curious', 0)
  insSm(aid, T0 + 1, 'curious', 0.55, '{不是 json')
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('slow 坏掉：不抛、仍然出一行', !!s && typeof s.line === 'string' && s.line.length > 0, s)
  check('slow 坏掉：退回到力度', !!s && s.line.includes('力度 0.55'), s && s.line)
  check('slow 坏掉：数值为 null', !!s && s.slow === null && s.fast === null, s)
}

// ---------------- 8 原话带路径 / 凭据 ----------------
{
  const aid = mkAgent('技术噪音')
  insEv(aid, T0, 'C:\\Users\\ygys1\\Desktop\\ds\\token.txt 里的那个 key', 'calm', 0)
  insSm(aid, T0 + 1, 'calm', 0.4, SLOW)
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('技术噪音：原话不出现', !!s && !s.line.includes('token'), s && s.line)
  check('技术噪音：还是给数', !!s && s.line.includes('慢 +0.11'), s && s.line)
  check('技术噪音：cause 记为 null', !!s && s.cause === null, s && s.cause)
}

// ---------------- 9 只有事件、没有样本 ----------------
{
  const aid = mkAgent('只有事件')
  insEv(aid, T0, '只有原话', 'joy', 1)
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('只有事件：不抛', s === null || typeof s.line === 'string', s)
  check('只有事件：不给原话（没数就没那一刻）', !s || !s.line.includes('只有原话'), s && s.line)
}

// ---------------- 10 只读 ----------------
{
  const aid = mkAgent('只读')
  insEv(aid, T0, '别改库', 'peaceful', 0)
  insSm(aid, T0 + 1, 'peaceful', 0.7, SLOW)
  const before = counts(aid)
  feltSnapshot(db, aid, { at: T0 + 60000 })
  feltSnapshot(db, aid, { at: T0 + 60000 })
  const after = counts(aid)
  check('只读：行数不变', before.e === after.e && before.s === after.s, { before, after })
}

// ---------------- 12b 共情那一份：异号不许说「其中」 ----------------
{
  const aid = mkAgent('异号')
  insEv(aid, T0, '你明天提醒我体检', 'joy', 0)
  insSm(aid, T0 + 1, 'joy', 0.5, { slow: 0.23, fast: 0.39, total: 0.3, fast_self: 0.51, fast_empathy: -0.12 })
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('异号：不再说「其中 … 浮上来」', !!s && !s.line.includes('浮上来'), s && s.line)
  check('异号：两个总数还在', !!s && s.line.includes('快 +0.39'), s && s.line)
}
{
  const aid = mkAgent('同号负')
  insEv(aid, T0, '算了吧', 'frustrated', 0)
  insSm(aid, T0 + 1, 'frustrated', 0.6, { slow: -0.2, fast: -0.3, total: -0.25, fast_self: -0.1, fast_empathy: -0.2 })
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('同号负：说「被你的情绪带下去」', !!s && s.line.includes('带下去'), s && s.line)
}

// ---------------- 12d 词要有细节：不能只有一个「平」 ----------------
{
  const aid = mkAgent('词细节')
  insEv(aid, T0, '好吧', 'calm', 0)
  insSm(aid, T0 + 1, 'calm', 0.62, { slow: 0.11, fast: 0.21, total: 0.18, fast_self: 0.21, fast_empathy: 0.0 }, { pleasure: 0.21, arousal: 0.45, dominance: -0.3 })
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('说得出「绷着」', !!s && s.line.includes('绷着'), s && s.line)
  check('说得出「没太有底气」', !!s && s.line.includes('没太有底气'), s && s.line)
  check('标签词还在', !!s && s.line.includes('读出的是平'), s && s.line)
}
{
  const aid = mkAgent('老样本没轴')
  insEv(aid, T0, '嗯', 'calm', 0)
  insSm(aid, T0 + 1, 'calm', 0.4, { slow: 0.05, fast: 0.1, total: 0.08, fast_self: 0.1, fast_empathy: 0 })
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('老样本没有这两个键：不猜、不乱加词', !!s && !s.line.includes('绷着') && !s.line.includes('底气'), s && s.line)
}

// ---------------- 12c 共情几乎为零：必须说清这个数是谁的 ----------------
{
  const aid = mkAgent('几乎没共情')
  insEv(aid, T0, '咋都是跟着我浮上来的', 'peaceful', 0)
  insSm(aid, T0 + 1, 'peaceful', 0.4, { slow: 0.11, fast: 0.33, total: 0.22, fast_self: 0.329, fast_empathy: 0.001 })
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('近零共情：明说「几乎全是我自己的」', !!s && s.line.includes('几乎全是我自己的'), s && s.line)
  check('近零共情：不再出现「是跟着你的情绪浮上来的」', !!s && !s.line.includes('是跟着你的情绪浮上来的'), s && s.line)
}
{
  const aid = mkAgent('共情仍在')
  insEv(aid, T0, '你明天提醒我体检', 'joy', 0)
  insSm(aid, T0 + 1, 'joy', 0.5, { slow: 0.23, fast: 0.39, total: 0.3, fast_self: 0.31, fast_empathy: 0.08 })
  const s = feltSnapshot(db, aid, { at: T0 + 60000 })
  check('共情够大：仍说「其中 … 浮上来」，不被新分支盖掉', !!s && s.line.includes('浮上来'), s && s.line)
  check('共情够大：不说「几乎全是我自己的」', !!s && !s.line.includes('几乎全是我自己的'), s && s.line)
}

// ---------------- 12 注入预算：整行丢，不许剪半句 ----------------
{
  const { clampInjection } = await import('../src/features.js')
  const SNAP = '（上一句落在我身上的样子：你说「我可不舍得说难听的话」，那一刻 慢 +0.11 / 快 +0.20，读出的是平静、力度 0.77。这是那时候的读数。）'
  const filler = Array.from({ length: 30 }, (_, i) => '（记忆第 ' + i + ' 条：' + '填充'.repeat(20) + '）')
  const lines = ['## 意识体：X', '感觉现在大概：没什么要赶的。', SNAP, ...filler]
  // 给足预算：快照留着
  const wide = clampInjection(lines.slice(), 4000)
  check('预算够：快照整行在', wide.text.includes(SNAP), wide.text.slice(0, 120))
  check('预算够：没被削', !wide.dropped.includes('snapshot'), wide.dropped)
  // 预算压死：整行消失，且不掉半句
  const tight = clampInjection(lines.slice(), 200)
  check('预算紧：快照整行没了', !tight.text.includes('（上一句落在我身上'), tight.text.slice(0, 200))
  check('预算紧：没剩半句「那一刻 慢」', !tight.text.includes('那一刻 慢'), tight.text.slice(0, 200))
  check('预算紧：记录为整行丢弃', tight.dropped.includes('snapshot'), tight.dropped)
}

// ---------------- 13 多 agent 不串 ----------------

{
  const a1 = mkAgent('甲')
  const a2 = mkAgent('乙')
  insEv(a1, T0, '甲的话', 'joy', 0)
  insSm(a1, T0 + 1, 'joy', 0.8, SLOW)
  const s = feltSnapshot(db, a2, { at: T0 + 60000 })
  check('多 agent：乙拿不到甲的快照', s === null, s)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
