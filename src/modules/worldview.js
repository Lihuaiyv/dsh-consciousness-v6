/**
 * 世界观：对「世界是怎样的」的基本信念——不是人填的，从经历里长出来。
 *
 * 理论拼装（可计算、可解释，维数可控）：
 *   - Primals（Clifton et al.）：Safe / Enticing / Alive → 世界总体性格
 *   - World Assumptions（Janoff-Bulman WAS）：公正、可控、人性善意
 *   - Social Axioms（Leung & Bond）：努力有报、情境复杂、命运可控度的反面即能动
 *   - 认识姿态：知识可修订（epistemic humility / Ethics of AI Belief）
 *
 * 与价值观不同：各维独立 ∈ [FLOOR, CEIL]，初值 0.50，不要求 Σ=1。
 * 世界观更稳：惯习门槛更高（≥7），张力更弱，大冲击才大幅偏离中线。
 */
import { now } from '../db.js'
import { agent, tx } from '../kernel.js'
import { listPreferences, listTaboos } from './persona.js'
import { WORLD_DIMS as DIMS, WORLD_PAIRS as PAIRS, WORLD_INIT as INIT, WORLD_FLOOR as FLOOR, WORLD_CEIL as CEIL } from './persona_dims.js'
import { foldValueWeights } from './sangguan/vweights.js'

export { DIMS, PAIRS, INIT, FLOOR, CEIL }

/** [key, 中文, 高分含义, 低分含义]。名字在 persona_dims.js。 */

export const WORLD_KEYS = DIMS.map(([k]) => k)

export const TTL_MS = 6 * 3600 * 1000
const HABIT_N = 7

const TYPE_FACTOR = { fact: 1, episode: 0.9, preference: 1.05, boundary: 1.15, reflection: 1.1, aspiration: 0.85 }

/** 记忆文本 → 世界观维（启发式；模型不参与） */
const LEX_UP = {
  safe: /安全|放心|没事|稳妥|善意|保护|庇护|世界还好|人间值得|温暖/,
  enticing: /有趣|好奇|发现|新鲜|探索|好玩|迷人|丰盛|到处都是|想去看/,
  alive: /缘分|注定|冥冥|回应|意味|有意|呼应|信号|冥冥中|冥冥之中|宇宙/,
  just: /公平|公正|报应|应得|善有善报|讲理|公道|正义/,
  agency: /努力|自己搞定|选择|能动|可以改|靠自己|掌握|做成|规划|办法/,
  trustPeople: /信任|靠谱|好人|真诚|托付|相信人|人性|善意的人/,
  complexity: /看情况|不一定|多种|灵活|场合|因人而异|没有唯一|复杂/,
  revisable: /我错了|改看法|被说服|证据|不确定|可能记错|再想想|修正/,
}

const LEX_DOWN = {
  safe: /危险|吓人|怕|不安全|坑|害人|黑暗|险恶|防着/,
  enticing: /无聊|没劲|乏味|没意思|千篇一律|灰蒙蒙/,
  alive: /机械|随机|偶然|没意义|冷冰冰|纯物理|碰巧/,
  just: /不公|冤枉|倒霉|世道|凭什么|黑箱|暗箱/,
  agency: /认命|命运|运气|没法|无解|听天由命|随缘吧|改不了/,
  trustPeople: /骗子|虚伪|提防|不可信|人性恶|人心隔肚皮|坑人/,
  complexity: /必须|只能|死规矩|一条道|绝对|没有例外/,
  revisable: /永远正确|听不进|就是这样|别争了|成见|固执/,
}

function delta(kind, text, value) {
  return { kind, text: String(text || '').slice(0, 40), value: +value.toFixed(4) }
}

function typeFactor(t) {
  return TYPE_FACTOR[String(t || 'fact')] ?? 1
}

function readMemories(db, aid, limit = 80) {
  try {
    return db.prepare(
      "SELECT text,type,weight,created_at FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL ORDER BY weight DESC, created_at DESC LIMIT ?",
    ).all(aid, limit)
  } catch { return [] }
}

function dimLabel(key) {
  const hit = DIMS.find(([k]) => k === key)
  return hit ? hit[1] : key
}

function clamp01(v) {
  return Math.max(FLOOR, Math.min(CEIL, v))
}

function derive(db, aid) {
  const score = {}
  const why = {}
  const hits = {}
  const caps = {}
  for (const [k] of DIMS) { score[k] = INIT; why[k] = []; hits[k] = 0; caps[k] = {} }

  const add = (dim, item, capKey, capMax) => {
    if (score[dim] == null) return
    const used = caps[dim][capKey] || 0
    const room = capMax - used
    if (room <= 0) return
    const v = item.value > 0 ? Math.min(item.value, room) : Math.max(item.value, -room)
    score[dim] += v
    caps[dim][capKey] = used + Math.abs(v)
    hits[dim] += 1
    why[dim].push(item)
  }

  const mems = readMemories(db, aid)
  for (const m of mems) {
    const factor = typeFactor(m.type) * Math.max(0.2, Math.min(1, Number(m.weight) || 0.5))
    const text = String(m.text || '')
    for (const [dim, re] of Object.entries(LEX_UP)) {
      if (re.test(text)) add(dim, delta('memory', text, 0.012 * factor), 'memory', 0.18)
    }
    for (const [dim, re] of Object.entries(LEX_DOWN)) {
      if (re.test(text)) add(dim, delta('memory', text, -0.012 * factor), 'memory', 0.18)
    }
  }

  let prefs = []
  try { prefs = (listPreferences(db, aid) || []).slice(0, 20) } catch { prefs = [] }
  for (const p of prefs) {
    const av = Number(p.aversion) || 0
    if (av >= 0.65) {
      add('safe', delta('preference', '受不了「' + p.tag + '」', -0.01), 'preference', 0.06)
      add('trustPeople', delta('preference', '讨厌「' + p.tag + '」', -0.006), 'preference', 0.04)
    } else if (av <= 0.25) {
      add('enticing', delta('preference', '喜欢「' + p.tag + '」', 0.008), 'preference', 0.05)
    }
  }

  let taboos = []
  try { taboos = listTaboos(db, aid) || [] } catch { taboos = [] }
  for (const t of taboos) {
    if (t.level === 'root') {
      add('safe', delta('taboo', '红线：' + t.text, -0.015), 'taboo', 0.06)
      add('just', delta('taboo', '边界即规矩：' + t.text, 0.008), 'taboo', 0.04)
    }
  }

  // 关系：亲近+信任 → 人性可托、安全世界
  try {
    const owner = db.prepare("SELECT name,closeness,trust FROM rel_person WHERE agent_id=? AND tier='owner' AND status='active'").get(aid)
    if (owner) {
      const k = Number(owner.closeness) || 0
      const r = Number(owner.trust) || 0
      if (k >= 0.55 && r >= 0.55) {
        const bond = Math.min(1, ((k - 0.55) / 0.45) * ((r - 0.55) / 0.45))
        add('trustPeople', delta('relation', '跟' + owner.name + '信得过', 0.025 * bond), 'relation', 0.05)
        add('safe', delta('relation', '有依靠', 0.015 * bond), 'relation', 0.04)
      }
      if (r < 0.35) add('trustPeople', delta('relation', '对' + owner.name + '还看不清', -0.02), 'relation', 0.05)
    }
  } catch { /* 老库 */ }

  try {
    const a = db.prepare('SELECT mood FROM affect_state WHERE agent_id=?').get(aid)
    const mood = Number(a && a.mood)
    if (Number.isFinite(mood)) {
      if (mood >= 0.65) {
        add('enticing', delta('affect', '心情不错', 0.01), 'affect', 0.03)
        add('safe', delta('affect', '心里安', 0.008), 'affect', 0.03)
      }
      if (mood <= 0.35) {
        add('safe', delta('affect', '心里不稳', -0.012), 'affect', 0.04)
        add('just', delta('affect', '觉得不公', -0.008), 'affect', 0.03)
      }
    }
  } catch { /* */ }

  // 冲突未解 → 公正与可修订性受压，但可修订略升（被迫面对）
  try {
    const open = Number(db.prepare("SELECT COUNT(*) n FROM conflicts WHERE agent_id=? AND state='open'").get(aid).n) || 0
    if (open >= 1) {
      add('just', delta('conflict', '有未解冲突', -0.01 * Math.min(3, open)), 'conflict', 0.05)
      add('revisable', delta('conflict', '必须再想想', 0.008 * Math.min(3, open)), 'conflict', 0.04)
      add('complexity', delta('conflict', '事没那么简单', 0.006 * Math.min(3, open)), 'conflict', 0.04)
    }
  } catch { /* */ }

  // 价值观弱耦合：读三观命题折算出来的十维，不读旧表；没有命题时 m 为空，等同于不耦合。
  try {
    const folded = foldValueWeights(db, aid)
    const m = (folded && folded.weights) || {}
    if (m.universalism > 0.12) add('just', delta('claims', '看重普世', 0.02 * (m.universalism - 0.1)), 'claims', 0.04)
    if (m.benevolence > 0.12) add('trustPeople', delta('claims', '看重仁善', 0.02 * (m.benevolence - 0.1)), 'claims', 0.04)
    if (m.selfDirection > 0.12) add('agency', delta('claims', '看重自主', 0.018 * (m.selfDirection - 0.1)), 'claims', 0.04)
    if (m.security > 0.14) add('safe', delta('claims', '看重安全', -0.01 * (m.security - 0.1)), 'claims', 0.03)
    if (m.stimulation > 0.12) add('enticing', delta('claims', '看重刺激', 0.015 * (m.stimulation - 0.1)), 'claims', 0.04)
  } catch { /* 没有三观账本 */ }

  const habit = {}
  for (const [k] of DIMS) {
    if (hits[k] >= HABIT_N) {
      // 惯习：向当前偏离收缩一半步幅（更稳）
      score[k] = INIT + (score[k] - INIT) * 0.55
      habit[k] = true
    }
    score[k] = clamp01(score[k])
  }

  const tension = {}
  for (const [a, b] of PAIRS) {
    const win = score[a] >= score[b] ? a : b
    const lose = win === a ? b : a
    const w = score[win]
    if (w > 0.68) {
      const pull = 0.12 * (w - 0.68)
      const next = clamp01(score[lose] - pull)
      if (next < score[lose] - 0.002) {
        why[lose].push(delta('tension', '被「' + dimLabel(win) + '」略压', next - score[lose]))
        score[lose] = next
      }
      tension[win] = { opposite: lose, pull: +pull.toFixed(4) }
    }
  }

  const items = DIMS.map(([key, label, hi, lo]) => ({
    key, label, hint: hi, low: lo,
    weight: +clamp01(score[key]).toFixed(4),
    evidence: why[key].slice(0, 4),
    habit: !!habit[key],
    origin: 'auto',
  })).sort((x, y) => Math.abs(y.weight - INIT) - Math.abs(x.weight - INIT))

  const good = +((score.safe + score.enticing + score.alive) / 3).toFixed(4)

  return {
    items,
    tension,
    derived: { good, label: good >= 0.58 ? '偏善好世界' : good <= 0.42 ? '偏严峻世界' : '中性世界观' },
    signals: { memory: mems.length, preferences: prefs.length, taboos: taboos.length },
    updated_at: now(),
  }
}

export function resolveWorldKey(raw) {
  const t = String(raw || '').trim()
  if (!t) return null
  const bare = t.startsWith('worldview.') ? t.slice(10) : t
  if (WORLD_KEYS.includes(bare)) return bare
  const byLabel = DIMS.find(([, label]) => label === bare || label === t)
  return byLabel ? byLabel[0] : null
}

export function listWorldviewRich(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM persona_worldview WHERE agent_id=?').all(aid).map((r) => {
    const meta = DIMS.find(([k]) => k === r.key)
    let raw = null
    try { raw = JSON.parse(r.evidence || 'null') } catch { raw = null }
    const evidence = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : [])
    return {
      key: r.key,
      label: meta ? meta[1] : r.key,
      hint: meta ? meta[2] : '',
      low: meta ? meta[3] : '',
      weight: Number(r.weight),
      evidence: evidence.slice(0, 4),
      habit: !!(raw && raw.habit),
      origin: 'auto',
      updated_at: r.updated_at,
    }
  }).sort((a, b) => Math.abs(b.weight - INIT) - Math.abs(a.weight - INIT))
}

export function growWorldview(db, aid, opts = {}) {
  agent(db, aid)
  const force = !!opts.force
  const latest = db.prepare('SELECT MAX(updated_at) t, COUNT(*) n FROM persona_worldview WHERE agent_id=?').get(aid)
  const fresh = latest && latest.n > 0 && Date.now() - Date.parse(latest.t || 0) < TTL_MS
  if (!force && fresh) return listWorldviewRich(db, aid)
  const out = derive(db, aid)
  tx(db, () => {
    for (const item of out.items) {
      db.prepare('INSERT OR REPLACE INTO persona_worldview VALUES(?,?,?,?,?)')
        .run(aid, item.key, item.weight, JSON.stringify({ items: item.evidence, habit: item.habit }), out.updated_at)
    }
  })
  return listWorldviewRich(db, aid)
}

export function explainWorldview(db, aid) {
  agent(db, aid)
  const items = listWorldviewRich(db, aid)
  const map = Object.fromEntries(items.map((x) => [x.key, x.weight]))
  const tensions = PAIRS.map(([a, b]) => {
    const A = items.find((x) => x.key === a)
    const B = items.find((x) => x.key === b)
    return {
      pair: dimLabel(a) + ' ↔ ' + dimLabel(b),
      a: A ? A.weight : INIT, b: B ? B.weight : INIT,
      winner: A && B ? (A.weight >= B.weight ? dimLabel(a) : dimLabel(b)) : null,
    }
  })
  const habits = items.filter((x) => x.habit).map((x) => x.label)
  const good = +(((map.safe || INIT) + (map.enticing || INIT) + (map.alive || INIT)) / 3).toFixed(4)
  const lean = items
    .filter((x) => Math.abs(x.weight - INIT) >= 0.08)
    .slice(0, 3)
    .map((x) => (x.weight >= INIT ? x.hint : x.low))
  return {
    items, tension: tensions, habits,
    initial: INIT, floor: FLOOR, ceil: CEIL,
    derived: { good, label: good >= 0.58 ? '偏善好世界' : good <= 0.42 ? '偏严峻世界' : '中性世界观' },
    lean,
    sources: ['Primals(Safe/Enticing/Alive)', 'WAS(公正/可控/人性)', 'Social Axioms', 'Epistemic humility'],
  }
}

/** 注入用短句：只在有明显偏离时说 */
export function worldviewPromptLine(items) {
  const rows = Array.isArray(items) ? items : []
  const lean = rows
    .filter((x) => Math.abs(Number(x.weight) - INIT) >= 0.08)
    .sort((a, b) => Math.abs(b.weight - INIT) - Math.abs(a.weight - INIT))
    .slice(0, 2)
  if (!lean.length) return ''
  const bits = lean.map((x) => (Number(x.weight) >= INIT
    ? (x.hint || x.label)
    : (x.low || ('不太信「' + x.label + '」'))))
  return '你对世界的基本看法：' + bits.join('；') + '。'
}
