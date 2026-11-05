/**
 * 记忆衰减与分层零件 · 考卷
 *
 * 管的是「一条记忆现在多清晰、该沉到哪一层、还值不值得每轮被想起」。
 * 不管「该召回哪条」（召回零件），也不管「旧事的话要不要说糊」（注入）。
 *
 * 运行：node test/exam-tiers.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import {
  halfLifeDays, seedScores, heatOf, bandOf, nowRow, refreshHeat,
  retrievability, touch, tierStats, ensureHeatBootstrapped,
} from '../src/modules/tiers.js'
import { targetTemp, tickTemps, tempStats, COLD_DAYS, ARCHIVE_DAYS, HOT_HITS, HYSTERESIS } from '../src/modules/temps.js'
import { run as algoRun } from '../src/algo/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const DAY = 86400000
const at = Date.parse('2026-11-05T12:00:00.000Z')
const daysAgo = (n) => new Date(at - n * DAY).toISOString()

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-tiers-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_tiers'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '分层', 'daily', 'active', now())

// ================================================================ 半衰期
{
  check('不重要的半衰期 30 天', halfLifeDays(0) === 30, halfLifeDays(0))
  check('半重要的半衰期 60 天', halfLifeDays(0.5) === 60, halfLifeDays(0.5))
  check('最重要的半衰期 90 天', halfLifeDays(1) === 90, halfLifeDays(1))
  check('重要度越界当 0/1 处理', halfLifeDays(2) === 90 && halfLifeDays(-1) === 30, [halfLifeDays(2), halfLifeDays(-1)])
}

// ================================================================ 热度：五项加权
{
  const base = { importance: 0.5, created_at: daysAgo(0), salience: 0 }
  const h0 = heatOf(base, at)
  check('刚出生、没被想起：0.42', Math.abs(h0 - 0.42) < 1e-9, h0)
  const h60 = heatOf({ ...base, created_at: daysAgo(60) }, at)
  check('过一个半衰期，新鲜度减半', Math.abs(h60 - (0.2 + 0.22 * 0.5)) < 1e-3, h60)
  const hLocked = heatOf({ ...base, mark: 'locked' }, at)
  check('钉住加 0.10', Math.abs(hLocked - 0.52) < 1e-9, hLocked)
  const hHits = heatOf({ ...base, hits: 8 }, at)
  check('被想起八次，强化满格', Math.abs(hHits - 0.6) < 1e-9, hHits)
  const hSal = heatOf({ ...base, salience: 1 }, at)
  check('出生时激动加满 0.10', Math.abs(hSal - 0.52) < 1e-9, hSal)
  const hWeight = heatOf({ importance: undefined, weight: 0.5, created_at: daysAgo(0) }, at)
  check('没 importance 时退回 weight', Math.abs(hWeight - 0.42) < 1e-9, hWeight)
  check('热度夹在 0~1', heatOf({ ...base, importance: 5, hits: 99, mark: 'locked', salience: 5 }, at) === 1)
  check('空行热度 0', heatOf(null, at) === 0)
}

// ================================================================ 档位：只影响排序
{
  const base = { created_at: daysAgo(0) }
  check('钉住一律短期', bandOf({ ...base, mark: 'locked' }, 0.1) === 'short')
  check('两天内一律短期', bandOf({ ...base, created_at: daysAgo(1) }, 0.1) === 'short')
  check('热度够高 → 短期', bandOf({ ...base, created_at: daysAgo(10), heat: 0.52 }, 0.52) === 'short')
  check('热度中等 → 中期', bandOf({ ...base, created_at: daysAgo(40), heat: 0.4 }, 0.4) === 'mid')
  check('老旧又低热 → 长期', bandOf({ ...base, created_at: daysAgo(200), heat: 0.1 }, 0.1) === 'long')
  check('三十天没想起的反思 → 长期', bandOf({ ...base, type: 'reflection', hits: 0, created_at: daysAgo(40) }, 0.9) === 'long')
  check('反思被想起过就不压长期', bandOf({ ...base, type: 'reflection', hits: 2, created_at: daysAgo(40) }, 0.4) === 'mid')
  check('空行给中期', bandOf(null) === 'mid')
}

// ================================================================ 可提取性 R
{
  const row = { stability: 1, last_decay_at: daysAgo(0), created_at: daysAgo(0) }
  check('刚复习过 R=1', retrievability(row, at) === 1, retrievability(row, at))
  const half = retrievability({ ...row, last_decay_at: daysAgo(9) }, at)
  check('过 9 倍稳定性天数 → R=0.5', Math.abs(half - 0.5) < 1e-9, half)
  check('稳定性越高忘得越慢', retrievability({ ...row, stability: 2, last_decay_at: daysAgo(9) }, at) > half)
  check('没有 last_decay_at 时退回创建时间', Math.abs(retrievability({ stability: 1, created_at: daysAgo(9) }, at) - 0.5) < 1e-9)
  check('空行 R=1', retrievability(null, at) === 1)

  const row2 = { importance: 0.5, stability: 1, last_decay_at: daysAgo(30), created_at: daysAgo(30) }
  const byTiers = retrievability(row2, at)
  const byAlgo = algoRun('decay', 'v1', {}, { row: row2, now: at }).R
  check('和 decay@v1 是同一套公式', Math.abs(byTiers - byAlgo) < 1e-4, { byTiers, byAlgo })
  const byV1b = algoRun('decay', 'v1b', {}, { row: row2, now: at }).R
  check('对照版忘得更快', byV1b < byV1b + 1 && byV1b < byAlgo, { byV1b, byAlgo })
  const scaled = algoRun('decay', 'v1', {}, { row: row2, now: at, scale: 2 }).R
  check('时间倍数放大 → 忘得更慢', scaled > byAlgo, { scaled, byAlgo })
}

// ================================================================ 强化：想起来一次
{
  const id = addMemory(db, aid, { text: '答应周末画记忆面板的图', type: 'fact', importance: 0.9 }).id
  db.prepare('UPDATE memory_items SET last_decay_at=?, last_hit_at=?, stability=1.0, hits=0 WHERE id=?')
    .run(daysAgo(9), daysAgo(9), id)
  const before = db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)
  check('强化前 R 约 0.5', Math.abs(retrievability(before, at) - 0.5) < 1e-6, retrievability(before, at))
  check('强化返回条数', touch(db, [id, id, null], at) === 1)
  const after = db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)
  check('想起一次 hits+1', Number(after.hits) === 1, after.hits)
  check('时钟拨回现在', after.last_decay_at === new Date(at).toISOString(), after.last_decay_at)
  check('稳定性往上涨', Number(after.stability) > 1, after.stability)
  check('强化后 R 回到 1', retrievability(after, at) === 1)
  check('强度涨得不超过 25%', Number(after.stability) <= 1.25 + 1e-9, after.stability)
  check('热度也跟着重算', Number(after.heat) > 0, after.heat)

  // 越费劲想起（R 低）涨得越多
  const id2 = addMemory(db, aid, { text: '一条很久没想起的旧事', type: 'fact', importance: 0.5 }).id
  db.prepare('UPDATE memory_items SET last_decay_at=?, last_hit_at=?, stability=1.0, hits=0 WHERE id=?')
    .run(daysAgo(80), daysAgo(80), id2)
  touch(db, [id2], at)
  const far = Number(db.prepare('SELECT stability FROM memory_items WHERE id=?').get(id2).stability)
  check('越模糊想起来，稳定性涨得越多', far > Number(after.stability), { far, easy: after.stability })

  const capId = addMemory(db, aid, { text: '一条已经很不稳定的记忆', type: 'fact', importance: 0.5 }).id
  db.prepare('UPDATE memory_items SET last_decay_at=?, last_hit_at=?, stability=59.9, hits=0 WHERE id=?')
    .run(daysAgo(9), daysAgo(9), capId)
  touch(db, [capId], at)
  check('稳定性封顶 60 天', Number(db.prepare('SELECT stability FROM memory_items WHERE id=?').get(capId).stability) <= 60)
}

// ================================================================ 温度：目标状态
{
  const base = { created_at: daysAgo(0) }
  check('钉住的永远是 hot', targetTemp({ ...base, mark: 'locked' }, at) === 'hot')
  check('90 天没碰 → cold', targetTemp({ ...base, created_at: daysAgo(COLD_DAYS + 1) }, at) === 'cold', targetTemp({ ...base, created_at: daysAgo(COLD_DAYS + 1) }, at))
  check('180 天没碰 → archived', targetTemp({ ...base, created_at: daysAgo(ARCHIVE_DAYS + 1) }, at) === 'archived')
  check('30 天内被想起三次 → hot', targetTemp({ ...base, hits: HOT_HITS, last_hit_at: daysAgo(5) }, at) === 'hot')
  check('想起过两次还不够热', targetTemp({ ...base, hits: HOT_HITS - 1, last_hit_at: daysAgo(5) }, at) === 'warm')
  check('其余 → warm', targetTemp({ ...base, created_at: daysAgo(10) }, at) === 'warm')
  check('空行给 warm', targetTemp(null) === 'warm')
}

// ================================================================ 温度：迟滞
{
  const mk = (id, temp, ageDays, mark = 'normal') => {
    addMemory(db, aid, { text: '温度测试 ' + id, type: 'fact', importance: 0.5 })
    db.prepare('UPDATE memory_items SET temp_state=?, state_streak=0, created_at=?, last_hit_at=NULL, mark=? WHERE text=?')
      .run(temp, daysAgo(ageDays), mark, '温度测试 ' + id)
  }
  mk('a', 'warm', COLD_DAYS + 5)
  const r1 = tickTemps(db, aid, at)
  const a1 = db.prepare("SELECT temp_state,state_streak FROM memory_items WHERE text='温度测试 a'").get()
  check('往下降第一天不迁（迟滞）', a1.temp_state === 'warm' && Number(a1.state_streak) === 1, a1)
  check('第一天没有迁移记录', !r1.some((x) => x.id && x.to === 'cold'), r1)
  const r2 = tickTemps(db, aid, at)
  const a2 = db.prepare("SELECT temp_state,state_streak FROM memory_items WHERE text='温度测试 a'").get()
  check('连续两天一致才迁到 cold', a2.temp_state === 'cold' && Number(a2.state_streak) === 0, a2)
  check('迁移有记录', r2.some((x) => x.to === 'cold'), r2)

  mk('b', 'cold', 5)
  const r3 = tickTemps(db, aid, at)
  const b1 = db.prepare("SELECT temp_state FROM memory_items WHERE text='温度测试 b'").get()
  check('往上升立刻生效（不用等两次）', b1.temp_state === 'warm', b1)
  check('上升也有记录', r3.some((x) => x.to === 'warm'), r3)

  const stats = tempStats(db, aid)
  check('温度统计把状态加起来', Number(stats.cold) >= 1 && Number(stats.warm) >= 1, stats)
}

// ================================================================ 巡检与补账
{
  addMemory(db, aid, { text: '新写下的偏好：喜欢靠窗', type: 'fact', importance: 0.7 })
  const counts = refreshHeat(db, aid, at)
  check('巡检给出三档条数', counts && typeof counts.short === 'number', counts)
  const sum = Number(counts.short) + Number(counts.mid) + Number(counts.long)
  check('三档条数等于有效记忆数', sum === Number(db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid).n), { counts, sum })

  const n1 = ensureHeatBootstrapped(db)
  const n2 = ensureHeatBootstrapped(db)
  check('补账只跑一次', n1 >= 1 && n2 === 0, { n1, n2 })
  check('补账留了标记', !!db.prepare("SELECT value FROM flags WHERE key='tiers.bootstrapped'").get())

  const row = db.prepare("SELECT * FROM memory_items WHERE text='新写下的偏好：喜欢靠窗'").get()
  const shown = nowRow(row, at)
  check('面板读数是现算的', typeof shown.heat === 'number' && ['short', 'mid', 'long'].includes(shown.band), shown)
  check('温度也现算一份给眼睛', ['hot', 'warm', 'cold', 'archived'].includes(shown.temp_now), shown.temp_now)

  const st = tierStats(db, aid, at)
  check('面板汇总有最热十条', Array.isArray(st.hot) && st.hot.length <= 10, st.hot && st.hot.length)
  check('汇总带各层条数', st.facts && typeof st.facts.total === 'number', st.facts)
}

// ================================================================ 出生分数
{
  const promise = seedScores('答应周末把图重画', 'fact', 0.3)
  check('承诺类出生就重要', Math.abs(promise.importance - 0.85) < 1e-9, promise.importance)
  check('显著度取当时的情绪强度', promise.salience === 0.3, promise.salience)
  const pref = seedScores('喜欢靠窗的位置', 'fact', 0)
  check('偏好类次之', Math.abs(pref.importance - 0.65) < 1e-9, pref.importance)
  const episode = seedScores('今天聊了代码', 'episode', 0)
  check('一次对话最轻', Math.abs(episode.importance - 0.45) < 1e-9, episode.importance)
  const withV = seedScores('普通一句话', 'fact', 0, -0.4)
  check('出生效价原样带上', withV.valence === -0.4, withV.valence)
  check('没给效价就不写', seedScores('普通一句话', 'fact', 0).valence === undefined)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
