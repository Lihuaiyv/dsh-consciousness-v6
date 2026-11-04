/**
 * 事后复查（影子）：挑哪条、怎么判「变了没」、写不写历史、额度与冷却。
 * 运行：node test/review.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { seedAffect, pickReviewCandidates, verdictOf, reviewTick, reviewStats, whyMismatchOf } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-review-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_review'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '复查', 'daily', 'active', now())
seedAffect(db, aid)

const H = 3600000
const NOW = Date.parse('2026-11-03T18:00:00+08:00')
let seq = 0
function ev(text, at, { gate = 1, rel = 0.5, cong = -0.3, label = 'irritated', sig = 0.2, theta = 0.1, why = '说了「还是不对」', target = 'me', whyFlag = null } = {}) {
  const id = 'ev' + (++seq)
  db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,rel,cong,sig,theta,gate,label,why,target,why_flag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid, new Date(at).toISOString(), text, rel, cong, sig, theta, gate, label, why, target, whyFlag)
  return id
}
function flag(key, v) {
  db.prepare('INSERT OR REPLACE INTO flags(key,value) VALUES(?,?)').run(key, String(v))
}

// ---------- 〇、理由和标签打架 ----------
const CALM_WHY = '只是继续交代任务，语气平，没有催促或纠错词'
check('负向标签 + why 说没事 → neg_but_calm', whyMismatchOf('frustrated', CALM_WHY, 'me') === 'neg_but_calm',
  { v: whyMismatchOf('frustrated', CALM_WHY, 'me') })
check('负向标签 + 不冲我来 → neg_but_none', whyMismatchOf('irritated', '在说别人', 'none') === 'neg_but_none')
check('同一个词两种打架时，none 优先', whyMismatchOf('irritated', CALM_WHY, 'none') === 'neg_but_none')
check('正向标签不查', whyMismatchOf('joy', CALM_WHY, 'none') === null)
check('calm 不查', whyMismatchOf('calm', CALM_WHY, 'none') === null)
check('负向标签 + why 有实指 → 不标', whyMismatchOf('irritated', '「还是不对」是在纠错', 'me') === null,
  { v: whyMismatchOf('irritated', '「还是不对」是在纠错', 'me') })
check('空 why 不硬判', whyMismatchOf('irritated', '', 'me') === null)
check('看不出也算「明说没事」', whyMismatchOf('confused', '看不出这句在说什么', 'me') === 'neg_but_calm')

// ---------- 一、verdictOf：两次判断差得算不算变了 ----------
const base = { rel: 0.8, cong: -0.4, label: 'irritated' }
check('同标签同方向小波动 → same', verdictOf(base, { rel: 0.9, cong: -0.5, label: 'irritated' }) === 'same')
check('量变了方向没变 → drift', verdictOf(base, { rel: 0.9, cong: -0.05, label: 'irritated' }) === 'drift',
  { v: verdictOf(base, { rel: 0.9, cong: -0.05, label: 'irritated' }) })
check('标签变了 → flip', verdictOf(base, { rel: 0.8, cong: -0.4, label: 'joy' }) === 'flip')
check('方向翻面 → flip', verdictOf(base, { rel: 0.8, cong: 0.5, label: 'irritated' }) === 'flip')
check('完全一致 → same', verdictOf(base, { ...base }) === 'same')
check('关切差很多但方向不变 → drift', verdictOf(base, { rel: 0.2, cong: -0.4, label: 'irritated' }) === 'drift')
check('空值不当 NaN 用', verdictOf({}, {}) === 'same')

// ---------- 二、挑谁 ----------
ev('刚说的', NOW - 1 * H)
check('刚发生的还没到 6 小时，不挑', pickReviewCandidates(db, aid, { at: NOW }).length === 0)

const old1 = ev('七小时前那句', NOW - 7 * H)
const c1 = pickReviewCandidates(db, aid, { at: NOW })
check('超过 6 小时的会进候选', c1.length === 1 && c1[0].id === old1, { n: c1.length })

ev('没进闸门的那句', NOW - 8 * H, { gate: 0 })
check('gate=0 不进候选', pickReviewCandidates(db, aid, { at: NOW, limit: 5 }).every((r) => r.gate === 1))

const noWhy = ev('没写理由的那句', NOW - 9 * H, { why: '' })
const nearLine = ev('贴着闸门线的那句', NOW - 6.5 * H, { sig: 0.101, theta: 0.1 })
const mismatch = ev('理由和标签打架的那句', NOW - 12 * H, { why: CALM_WHY, whyFlag: 'neg_but_calm' })
const c2 = pickReviewCandidates(db, aid, { at: NOW, limit: 5 })
check('打架的排在 why 空的前面', c2[0].id === mismatch, { first: c2[0] && c2[0].id, all: c2.map((r) => r.id) })
check('why 空的排第二', c2[1].id === noWhy, { second: c2[1] && c2[1].id })

// 复查掉最优先的两条（打架的、没写理由的），边界那条上位
await reviewTick(db, aid, {
  at: NOW,
  judge: async () => ({ goal_relevance: 0.5, goal_congruence: -0.3, label: 'irritated', why: '还是那句' }),
})
check('打架那条第一个被复查', db.prepare('SELECT COUNT(*) n FROM affect_review WHERE event_id=?').get(mismatch).n === 1)
await reviewTick(db, aid, {
  at: NOW + 3 * H,
  judge: async () => ({ goal_relevance: 0.5, goal_congruence: -0.3, label: 'irritated', why: '还是那句' }),
})
check('复查过的不会再被挑', pickReviewCandidates(db, aid, { at: NOW, limit: 5 }).every((r) => r.id !== noWhy && r.id !== mismatch))
const c3 = pickReviewCandidates(db, aid, { at: NOW, limit: 5 })
check('边界那条接着上', c3[0] && c3[0].id === nearLine, { first: c3[0] && c3[0].id })

// ---------- 三、reviewTick 写什么 ----------
const rows = db.prepare('SELECT * FROM affect_review WHERE agent_id=? ORDER BY reviewed_at').all(aid)
check('复查写了两行', rows.length === 2, { n: rows.length })
const r = rows.find((x) => String(x.text || '').includes('没写理由'))
check('记下了新旧两侧', r && r.old_label === 'irritated' && r.new_label === 'irritated', r)
check('verdict 是 same', r && r.verdict === 'same', { v: r && r.verdict })
check('原文留着', !!r, { rows: rows.map((x) => x.text) })

const evAfter = db.prepare('SELECT * FROM affect_events WHERE id=?').get(noWhy)
check('历史那行一个字段都没动', evAfter.rel === 0.5 && evAfter.cong === -0.3 && evAfter.label === 'irritated', evAfter)
check('也没往 affect_events 加新行', db.prepare('SELECT COUNT(*) n FROM affect_events WHERE agent_id=?').get(aid).n === 6)

// ---------- 四、冷却 ----------
const r2 = await reviewTick(db, aid, {
  at: NOW + 60 * 1000,
  judge: async () => { throw new Error('不该被调用') },
})
check('两小时内不再撞模型', r2.skipped === 'cooldown', r2)

// ---------- 五、额度 ----------
/* 已经复查了 2 条（打架的 + 没写理由的），再凑 2 条就满 4 条。 */
for (let i = 0; i < 2; i++) {
  db.prepare('INSERT INTO affect_review(id,agent_id,event_id,text,verdict,at,reviewed_at) VALUES(?,?,?,?,?,?,?)')
    .run('pad' + i, aid, 'x' + i, '凑额度', 'same', new Date(NOW).toISOString(), new Date(NOW).toISOString())
}
flag('review.last:' + aid, 0) // 清掉冷却，只看额度
const r3 = await reviewTick(db, aid, { at: NOW + 3 * H, judge: async () => ({}) })
check('一天 4 条用满就停', r3.skipped === 'quota', r3)

// ---------- 六、开关 ----------
db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
  .run(aid, 'affect.review.enabled', '0', now())
flag('review.last:' + aid, 0)
const r4 = await reviewTick(db, aid, { at: NOW + 24 * H, judge: async () => ({}) })
check('affect.review.enabled=0 整个跳过', r4.skipped === 'off', r4)

// ---------- 七、统计 ----------
const st = reviewStats(db, aid, { at: NOW + 24 * H })
check('统计把 4 条都数上', st.total === 4, st)
check('same 计数对', st.same === 4, st)
check('recent 最多 8 条', st.recent.length <= 8)

try { db.close() } catch { /* node:sqlite 可能没有 close */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不报 */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
