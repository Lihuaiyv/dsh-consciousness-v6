/**
 * 改造前后的对照模拟（可重复跑，不碰线上库）。
 *
 *   node scripts/sim-emotion-memory.mjs
 *
 * 三块：
 *   A 注入：旧的内联「说话分寸」 vs 新的表达层——统计「关系说热情、情绪说冷淡」同轮打架的次数
 *   B 浮现：旧版只有「用户开口才召回」 → 0 条自发；新版跑 30 天心跳，看自发条数 / 重复率 / 冷却
 *   C 回读：低落时连续说热络话 / 冷淡话，看慢情绪怎么走
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { surfaceQueueTick, takeSurface, pendingSurface } from '../src/modules/pulse.js'
import { applySelfRead, readReplyTone } from '../src/modules/self_read.js'
import { expressionState } from '../src/modules/expression_state.js'
import { toneOf } from '../src/algo/reldyn.js'

const now = () => new Date().toISOString()
const r2 = (x) => Math.round(x * 100) / 100

// ---------------- A：注入文案 ----------------

/** 旧版：index.js 里那段内联「这一轮的说话分寸」。 */
function oldDiktat(affect) {
  const slow = affect.v3 ? Number(affect.v3.slow) : 0
  const intensity = Number(affect.intensity) || 0
  if (slow <= -0.2) return { text: '只说 1 句，不主动起话头，语气偏冷', tone: 'cool', sentences: 1 }
  if (intensity > 0.8) return { text: '只说 1 句，短促，不主动提问', tone: 'short', sentences: 1 }
  if (intensity > 0.6) return { text: '最多 2 句，直接，不主动展开', tone: 'plain', sentences: 2 }
  if (slow >= 0.25) return { text: '可以多说一点，愿意展开', tone: 'warm', sentences: 4 }
  return { text: '可以 3~4 句，有一点温度', tone: 'plain', sentences: 3 }
}

function simInjection() {
  const labels = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
  let conflicts = 0
  let warmButCold = 0
  const sentDist = {}
  const N = 400
  for (let i = 0; i < N; i++) {
    const label = labels[i % labels.length]
    const slow = -1 + 2 * ((i * 37) % 100) / 100
    const intensity = ((i * 53) % 100) / 100
    const affect = { primary_label: label, intensity, mood: 0.5, v3: { slow, total: slow, baseline: 0 } }
    const rel = toneOf({ closeness: 0.94, trust: 0.74, kind: 'owner', mood: 0.5, extraversion: 0.5 })
    const old = oldDiktat(affect)
    const neu = expressionState({ affect, relation: { ...rel, closeness: 0.94, trust: 0.74 }, ei: 0.5 })
    // 冲突：关系明明「热情」，旧版却命令她冷
    if (rel.warmth >= 0.7 && old.tone === 'cool') warmButCold++
    if (old.tone !== neu.tone) conflicts++
    sentDist[neu.sentences] = (sentDist[neu.sentences] || 0) + 1
  }
  return { N, warmButCold, conflicts, sentDist, pct: r2(100 * warmButCold / N) }
}

// ---------------- B：自发浮现 ----------------

function seedAgent(db, name) {
  const id = 'agt_sim_' + Math.random().toString(36).slice(2, 8)
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(id, name, 'chat', 'active', now())
  db.prepare('INSERT OR REPLACE INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, 0, 0, 0, 0, now(), now())
  return id
}

/** 旧版：只有用户开口才会召回 → 没人说话时自发浮现 = 0。 */
function simSurfacing(db) {
  const aid = seedAgent(db, '浮现模拟')
  const texts = [
    '主人喜欢夜里听雨声。', '主人不吃内脏。', '主人周五下午过一遍进度。',
    '主人在做意识体插件。', '主人说过想去看海。', '主人怕被连续追问。',
    '主人喜欢先给结论再解释。', '主人提过小时候养过一只猫。',
  ]
  texts.forEach((t, i) => addMemory(db, aid, { text: t, type: 'fact', weight: 0.4 + 0.06 * i }))

  // 30 天 × 一天两次对话 × 每 10 分钟一次心跳（只在两次对话之间跑）
  const DAYS = 30
  const TURNS_PER_DAY = 2
  let surfaced = 0
  const seenAt = new Map()
  let dupWithin3Days = 0
  const t0 = Date.now() - DAYS * 86400000
  for (let d = 0; d < DAYS; d++) {
    for (let t = 0; t < TURNS_PER_DAY; t++) {
      const at = t0 + d * 86400000 + t * 6 * 3600000
      // 两次对话之间跑 6 次心跳
      for (let k = 0; k < 6; k++) surfaceQueueTick(db, aid, { at: at + k * 600000 })
      const row = takeSurface(db, aid, at + 3600000)
      if (!row) continue
      surfaced++
      const prev = seenAt.get(row.memory_id)
      if (prev != null && at - prev < 3 * 86400000) dupWithin3Days++
      seenAt.set(row.memory_id, at)
    }
  }
  return {
    days: DAYS, turns: DAYS * TURNS_PER_DAY, surfaced,
    perDay: r2(surfaced / DAYS),
    unique: seenAt.size,
    dupWithin3Days,
  }
}

// ---------------- C：回读 ----------------

function simSelfRead(db) {
  const warm = '好呀好呀，你说嘛，我在听～'
  const cold = '算了，随便，不想说这个。'
  const run = (start, text, n) => {
    const aid = seedAgent(db, '回读模拟')
    db.prepare('UPDATE affect_v3 SET slow=?, total=? WHERE agent_id=?').run(start, start, aid)
    const trail = []
    for (let i = 0; i < n; i++) {
      applySelfRead(db, aid, text, { at: Date.now() + i * 60000 })
      trail.push(db.prepare('SELECT slow FROM affect_v3 WHERE agent_id=?').get(aid).slow)
    }
    return { start, end: trail[trail.length - 1], delta: r2(trail[trail.length - 1] - start) }
  }
  const up = run(-0.5, warm, 8)
  const down = run(0.4, cold, 8)
  return {
    up, down,
    warmRead: readReplyTone(warm).warmth,
    coldRead: readReplyTone(cold).warmth,
    // 向下修正只取一半：同样的偏离，往下的位移应该明显小于往上
    asym: Math.abs(down.delta) < Math.abs(up.delta),
  }
}

// ---------------- 跑 ----------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-'))
const db = openDb(path.join(dir, 'app.db'))

const A = simInjection()
const B = simSurfacing(db)
const C = simSelfRead(db)

const idx = fs.readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8')
const oldCommandLeft = idx.includes('这一轮的说话分寸')

console.log(JSON.stringify({
  injection: A,
  surfacing: B,
  selfRead: C,
  source: { oldCommandLeft },
}, null, 2))

db.close()
