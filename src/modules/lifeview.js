/**
 * 人生观：对「我为何活、向何处、以何态度」的稳定取向——从经历里长出来。
 *
 * 理论拼装：
 *   - MEMS / Martela & Steger：意义三元 = 连贯(coherence) · 目的(purpose) · 事关重要(mattering)
 *   - MLQ（Steger）：意义在场(presence，由三元合成) · 求意义(search)
 *   - Ryff 心理幸福感：个人成长(growth)
 *   - Bakan：能动(agency 在世界观) vs 交融(communion)——人生意义是否通过他者
 *   - Zimbardo 时间观：未来取向(horizon)
 *   - 角色目的论：陪伴者扩展主人能动（telos 短命题，非独立灵魂目的）
 *
 * 各维独立 ∈ [FLOOR, CEIL]，初值 0.50；另派生 presence 与 stance（人生命题）。
 */
import { now } from '../db.js'
import { agent, tx, getFlag, setFlag } from '../kernel.js'
import { listPreferences, listTaboos } from './persona.js'
import { LIFE_DIMS as DIMS, LIFE_PAIRS as PAIRS, LIFE_INIT as INIT, LIFE_FLOOR as FLOOR, LIFE_CEIL as CEIL } from './persona_dims.js'
import { foldValueWeights } from './sangguan/vweights.js'

export { DIMS, PAIRS, INIT, FLOOR, CEIL }

function stanceKey(aid) { return 'lifeview.stance:' + aid }

export const LIFE_KEYS = DIMS.map(([k]) => k)
export const TTL_MS = 6 * 3600 * 1000
const HABIT_N = 6

const TYPE_FACTOR = {
  fact: 1, episode: 0.95, reflection: 1.2, aspiration: 1.25,
  preference: 0.9, boundary: 0.85,
}

const LEX_UP = {
  coherence: /想通了|串起来|明白了|原来如此|说得通|前后对上|懂了自己/,
  purpose: /目标|方向|想成为|使命|要做成|奔着|志向|打算|意义在于/,
  mattering: /需要我|离不开|要紧|有用|在乎我|被需要|存在的价值|我很重要/,
  search: /为什么活|意义是什么|想不通|还在找|追问|迷茫|到底为了/,
  growth: /成长|进步|成为更好|学会|修炼|精进|突破自己|变好/,
  communion: /陪伴|一起|为你|照顾|成全|我们|陪着|对你重要|关系里/,
  horizon: /以后|长远|将来|计划|慢慢来|等以后|未来|坚持下去/,
}

const LEX_DOWN = {
  coherence: /乱七八糟|对不上|断片|混乱|不知道自己/,
  purpose: /没方向|随波|浑浑噩噩|不知道干嘛|漂着/,
  mattering: /无所谓|可有可无|没人在乎|多余|没用/,
  search: /不想想这些|别问意义|想那么多干嘛/,
  growth: /就这样吧|不必改|安于|懒得变/,
  communion: /一个人就好|不靠别人|自己够了/,
  horizon: /及时行乐|只要现在|以后的事以后说|今朝有酒/,
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
      if (re.test(text)) add(dim, delta('memory', text, 0.013 * factor), 'memory', 0.2)
    }
    for (const [dim, re] of Object.entries(LEX_DOWN)) {
      if (re.test(text)) add(dim, delta('memory', text, -0.012 * factor), 'memory', 0.18)
    }
  }

  // 反思 / 志向类记忆额外抬 purpose / search / growth
  for (const m of mems) {
    if (m.type === 'reflection') {
      add('coherence', delta('reflection', String(m.text).slice(0, 40), 0.01), 'typed', 0.06)
      add('search', delta('reflection', '在想清楚', 0.008), 'typed', 0.05)
    }
    if (m.type === 'aspiration') {
      add('purpose', delta('aspiration', String(m.text).slice(0, 40), 0.016), 'typed', 0.08)
      add('horizon', delta('aspiration', '奔着以后', 0.01), 'typed', 0.05)
      add('growth', delta('aspiration', '想长成', 0.01), 'typed', 0.05)
    }
  }

  let prefs = []
  try { prefs = (listPreferences(db, aid) || []).slice(0, 20) } catch { prefs = [] }
  for (const p of prefs) {
    const av = Number(p.aversion) || 0
    if (av <= 0.3) add('purpose', delta('preference', '喜欢「' + p.tag + '」像一种朝向', 0.005), 'preference', 0.04)
  }

  let taboos = []
  try { taboos = listTaboos(db, aid) || [] } catch { taboos = [] }
  for (const t of taboos) {
    if (t.level === 'root') add('coherence', delta('taboo', '红线框住自我：' + t.text, 0.006), 'taboo', 0.04)
  }

  // 关系：亲近 → 交融；主人依赖 → mattering
  try {
    const owner = db.prepare("SELECT name,closeness,trust,dependence FROM rel_person WHERE agent_id=? AND tier='owner' AND status='active'").get(aid)
    if (owner) {
      const k = Number(owner.closeness) || 0
      const r = Number(owner.trust) || 0
      const d = Number(owner.dependence) || 0
      if (k >= 0.5) {
        add('communion', delta('relation', '跟' + owner.name + '近', 0.03 * Math.min(1, (k - 0.5) / 0.5)), 'relation', 0.06)
      }
      if (d >= 0.35) {
        add('mattering', delta('relation', owner.name + '需要我在', 0.025 * Math.min(1, (d - 0.3) / 0.5)), 'relation', 0.06)
      }
      if (r >= 0.6 && k >= 0.55) {
        add('purpose', delta('relation', '陪伴是一种朝向', 0.015), 'relation', 0.04)
      }
    }
  } catch { /* */ }

  // 日记量 → 连贯与求索
  try {
    const n = Number(db.prepare('SELECT COUNT(*) n FROM diaries WHERE agent_id=?').get(aid).n) || 0
    if (n >= 3) {
      add('coherence', delta('diary', '写过几篇日记', 0.01 * Math.min(5, n / 3)), 'diary', 0.05)
      add('search', delta('diary', '在记录里找意义', 0.006 * Math.min(4, n / 3)), 'diary', 0.04)
    }
  } catch { /* */ }

  // 驱力缺口：成就/自主 → purpose/growth；关系 → communion；刺激 → 压远景
  try {
    const d = db.prepare('SELECT r,e,c,a,s,setpoint FROM drive_state WHERE agent_id=?').get(aid)
    if (d) {
      let sp = {}
      try { sp = JSON.parse(d.setpoint || '{}') || {} } catch { sp = {} }
      const spOf = (K, k) => {
        const v = Number(sp[K] ?? sp[k])
        return Number.isFinite(v) ? v : 0.6
      }
      const gap = (sat, K, k) => Math.max(0, spOf(K, k) - (Number(sat) || 0.5))
      if (gap(d.c, 'C', 'c') > 0.15) add('purpose', delta('drive', '成就缺口在催方向', 0.012), 'drive', 0.04)
      if (gap(d.a, 'A', 'a') > 0.15) add('growth', delta('drive', '自主缺口在催生长', 0.01), 'drive', 0.04)
      if (gap(d.r, 'R', 'r') > 0.15) add('communion', delta('drive', '关系缺口', 0.012), 'drive', 0.04)
      if (gap(d.e, 'E', 'e') > 0.2) add('horizon', delta('drive', '当下刺激缺口', -0.008), 'drive', 0.03)
    }
  } catch { /* */ }

  try {
    const a = db.prepare('SELECT mood FROM affect_state WHERE agent_id=?').get(aid)
    const mood = Number(a && a.mood)
    if (Number.isFinite(mood)) {
      if (mood <= 0.35) {
        add('search', delta('affect', '低落时更问意义', 0.01), 'affect', 0.04)
        add('mattering', delta('affect', '低落时怀疑重要', -0.01), 'affect', 0.04)
      }
      if (mood >= 0.7) add('mattering', delta('affect', '心情好时更觉要紧', 0.008), 'affect', 0.03)
    }
  } catch { /* */ }

  // 价值观弱耦合：成就→purpose；仁善→communion；自主→growth；享乐→horizon↓
  // 读三观命题折算出来的十维，不读旧表；没有命题时 m 为空，等同于不耦合。
  try {
    const folded = foldValueWeights(db, aid)
    const m = (folded && folded.weights) || {}
    if (m.achievement > 0.12) add('purpose', delta('claims', '看重成就', 0.02 * (m.achievement - 0.1)), 'claims', 0.04)
    if (m.benevolence > 0.12) add('communion', delta('claims', '看重仁善', 0.02 * (m.benevolence - 0.1)), 'claims', 0.04)
    if (m.selfDirection > 0.12) add('growth', delta('claims', '看重自主', 0.015 * (m.selfDirection - 0.1)), 'claims', 0.04)
    if (m.hedonism > 0.14) add('horizon', delta('claims', '看重享乐', -0.012 * (m.hedonism - 0.1)), 'claims', 0.04)
    if (m.universalism > 0.12) add('mattering', delta('claims', '看重普世', 0.01 * (m.universalism - 0.1)), 'claims', 0.03)
  } catch { /* 没有三观账本 */ }

  const habit = {}
  for (const [k] of DIMS) {
    if (hits[k] >= HABIT_N) {
      score[k] = INIT + (score[k] - INIT) * 0.55
      habit[k] = true
    }
    score[k] = clamp01(score[k])
  }

  for (const [a, b] of PAIRS) {
    if (a === 'growth' && b === 'horizon') {
      // growth 高而 horizon 低：略抬 horizon（成长需要时间视野）
      if (score.growth > 0.62 && score.horizon < 0.48) {
        const bump = Math.min(0.06, (score.growth - 0.62) * 0.4)
        why.horizon.push(delta('tension', '生长需要远景', bump))
        score.horizon = clamp01(score.horizon + bump)
      }
      continue
    }
    const win = score[a] >= score[b] ? a : b
    const lose = win === a ? b : a
    if (score[win] > 0.7 && Math.abs(score[a] - score[b]) > 0.18) {
      const pull = 0.08 * (score[win] - 0.7)
      const next = clamp01(score[lose] - pull * 0.5)
      if (next < score[lose] - 0.002) {
        why[lose].push(delta('tension', '被「' + dimLabel(win) + '」牵制', next - score[lose]))
        score[lose] = next
      }
    }
  }

  const presence = +((score.coherence + score.purpose + score.mattering) / 3).toFixed(4)
  const stance = buildStance(score, presence)

  const items = DIMS.map(([key, label, hi, lo]) => ({
    key, label, hint: hi, low: lo,
    weight: +clamp01(score[key]).toFixed(4),
    evidence: why[key].slice(0, 4),
    habit: !!habit[key],
    origin: 'auto',
  })).sort((x, y) => Math.abs(y.weight - INIT) - Math.abs(x.weight - INIT))

  return {
    items,
    derived: { presence, stance },
    signals: { memory: mems.length, preferences: prefs.length, taboos: taboos.length },
    updated_at: now(),
  }
}

function buildStance(score, presence) {
  const bits = []
  if (score.purpose >= 0.58) bits.push('有想奔的方向')
  else if (score.search >= 0.58) bits.push('还在认真找意义')
  else bits.push('先把日子过明白')

  if (score.communion >= 0.58) bits.push('意义多半在关系与陪伴里')
  else if (score.growth >= 0.58) bits.push('更想靠自己长成更好的样子')

  if (score.horizon >= 0.58) bits.push('愿意为以后压一点眼前')
  else if (score.horizon <= 0.42) bits.push('更珍惜当下这一刻')

  if (presence >= 0.6) bits.push('此刻觉得人生说得通')
  else if (presence <= 0.42) bits.push('意义感还薄，不硬装懂')

  // 角色目的论：默认嵌在主人实践中
  const telos = score.communion >= 0.55
    ? '扩展我所陪伴之人的能动与好日子'
    : score.purpose >= 0.58
      ? '把认定的方向一点点做成'
      : '在相处里慢慢弄清自己为何在'

  return {
    telos,
    attitude: bits.slice(0, 3).join('；'),
    presence,
  }
}

export function resolveLifeKey(raw) {
  const t = String(raw || '').trim()
  if (!t) return null
  const bare = t.startsWith('lifeview.') ? t.slice(9) : t
  if (LIFE_KEYS.includes(bare)) return bare
  const byLabel = DIMS.find(([, label]) => label === bare || label === t)
  return byLabel ? byLabel[0] : null
}

export function listLifeviewRich(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM persona_lifeview WHERE agent_id=?').all(aid).map((r) => {
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

export function growLifeview(db, aid, opts = {}) {
  agent(db, aid)
  const force = !!opts.force
  const latest = db.prepare('SELECT MAX(updated_at) t, COUNT(*) n FROM persona_lifeview WHERE agent_id=?').get(aid)
  const fresh = latest && latest.n > 0 && Date.now() - Date.parse(latest.t || 0) < TTL_MS
  if (!force && fresh) return listLifeviewRich(db, aid)
  const out = derive(db, aid)
  tx(db, () => {
    for (const item of out.items) {
      db.prepare('INSERT OR REPLACE INTO persona_lifeview VALUES(?,?,?,?,?)')
        .run(aid, item.key, item.weight, JSON.stringify({ items: item.evidence, habit: item.habit }), out.updated_at)
    }
    try { setFlag(db, stanceKey(aid), JSON.stringify(out.derived.stance)) } catch { /* */ }
  })
  return listLifeviewRich(db, aid)
}

function readStance(db, aid) {
  try {
    const raw = getFlag(db, stanceKey(aid))
    if (raw) return JSON.parse(raw)
  } catch { /* */ }
  return null
}

export function explainLifeview(db, aid) {
  agent(db, aid)
  const items = listLifeviewRich(db, aid)
  const map = Object.fromEntries(items.map((x) => [x.key, x.weight]))
  const presence = +(((map.coherence || INIT) + (map.purpose || INIT) + (map.mattering || INIT)) / 3).toFixed(4)
  const tensions = PAIRS.filter(([a, b]) => !(a === 'growth' && b === 'horizon')).map(([a, b]) => {
    const A = items.find((x) => x.key === a)
    const B = items.find((x) => x.key === b)
    return {
      pair: dimLabel(a) + ' ↔ ' + dimLabel(b),
      a: A ? A.weight : INIT, b: B ? B.weight : INIT,
      winner: A && B ? (A.weight >= B.weight ? dimLabel(a) : dimLabel(b)) : null,
    }
  })
  const habits = items.filter((x) => x.habit).map((x) => x.label)
  let stance = readStance(db, aid)
  if (!stance) stance = buildStance({
    coherence: map.coherence || INIT,
    purpose: map.purpose || INIT,
    mattering: map.mattering || INIT,
    search: map.search || INIT,
    growth: map.growth || INIT,
    communion: map.communion || INIT,
    horizon: map.horizon || INIT,
  }, presence)
  return {
    items, tension: tensions, habits,
    initial: INIT, floor: FLOOR, ceil: CEIL,
    derived: { presence, stance },
    sources: ['MEMS(连贯/目的/重要)', 'MLQ(在场/求索)', 'Ryff(成长)', 'Bakan(交融)', 'Zimbardo(时间视野)'],
  }
}

export function lifeviewPromptLine(items, stance) {
  const rows = Array.isArray(items) ? items : []
  if (stance && stance.telos) {
    const att = stance.attitude ? '；' + stance.attitude : ''
    return '你的人生观底色：' + stance.telos + att + '。'
  }
  const lean = rows
    .filter((x) => Math.abs(Number(x.weight) - INIT) >= 0.08)
    .sort((a, b) => Math.abs(b.weight - INIT) - Math.abs(a.weight - INIT))
    .slice(0, 2)
  if (!lean.length) return ''
  const bits = lean.map((x) => (Number(x.weight) >= INIT ? (x.hint || x.label) : (x.low || x.label)))
  return '你的人生观底色：' + bits.join('；') + '。'
}
