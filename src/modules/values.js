/**
 * 价值观：不是人填的，是从它的经历里长出来的。
 *
 * 依据 6 号《理论背书》：
 *   - §4.3 价值观三组张力：仁善↔权力、传统↔自主、安全↔刺激（σ=−1，一方上升另一方上限下降，不许归零）
 *   - §5.4 出生初值：价值观十维各 0.10（十维取 Schwartz 基本价值，正好覆盖三组张力）
 *   - §4.2 / E8 / R21：同一结论反复出现（≥5 次）才沉淀成惯习，之后的步幅减半（布迪厄）
 *   - F6 / R15 / R16：关系决定分寸（陌生人 0.30 / 熟人 0.50 / 主人 0.70）
 *
 * 说明：
 *   - 十维初值 0.10、总和 1，和界面上的「Σweight = 1」一致。
 *   - 每次增长都留证据（哪条记忆、哪条禁忌、哪段关系），技术视图能逐条翻。
 *   - 生成是确定性的：同一批数据算两次结果一样；变化只来自新经历，不来自随机数。
 */
import { now } from '../db.js'
import { agent, tx } from '../kernel.js'
import { listRelations, listPreferences, listTaboos } from './persona.js'

/** Schwartz 十维；顺序固定，界面与导出都按这个来 */
export const DIMS = [
  ['benevolence', '仁善', '照顾身边的人'],
  ['universalism', '普世', '公平、对所有人'],
  ['selfDirection', '自主', '自己决定，不想被安排'],
  ['security', '安全', '稳定、不失去'],
  ['tradition', '传统', '老规矩、一直这样'],
  ['conformity', '从众', '守规矩、别出格'],
  ['achievement', '成就', '做成事、变强'],
  ['hedonism', '享乐', '舒服、好玩'],
  ['stimulation', '刺激', '新鲜、冒险'],
  ['power', '权力', '说了算、有地位'],
]

export const INIT = 0.1
export const FLOOR = 0.02

/** 三组张力（§4.3），σ = −1 */
export const PAIRS = [
  ['benevolence', 'power'],
  ['tradition', 'selfDirection'],
  ['security', 'stimulation'],
]

/** 6 小时内的重复读取不再重算；新经历多得多的实例可以手动「重新长一遍」 */
export const TTL_MS = 6 * 3600 * 1000

const TYPE_FACTOR = { fact: 1, episode: 0.9, appraisal: 0.7, reflection: 0.6, preference: 1.05, boundary: 1.2 }

/** 记忆文本 → 价值维（只做启发式，不做语义理解；模型不参与，省钱） */
const LEX = {
  benevolence: /照顾|帮他|帮她|担心你|心疼|陪着|陪伴|朋友|家人|亲近|温柔|照顾好/,
  universalism: /公平|所有人|大家|世界|环境|尊重|正义|道理|规则对/,
  selfDirection: /自己决定|不想被管|自由|独立|按我的|别管我|选择权|自己来/,
  security: /安全|稳定|别变|担心|风险|害怕|失去|离开|生病|危险|保险|稳妥/,
  tradition: /传统|老规矩|以前都是|一直这样|家里|长辈|节日|习俗/,
  conformity: /规矩|应该|别人都|合群|听话|别出格|礼貌|不合适|得体/,
  achievement: /做成|完成|目标|进步|学会|成功|搞定|努力|升职|考过|拿下/,
  hedonism: /好吃|好玩|舒服|享受|喜欢|开心|摸鱼|休息|放松|好喝/,
  stimulation: /刺激|冒险|新鲜|没试过|出去玩|旅行|熬夜|试试/,
  power: /控制|命令|服从|支配|地位|面子|说了算|压过|赢|竞争|权力|领导|老板/,
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

function derive(db, aid) {
  const score = {}
  const why = {}
  const hits = {}
  const caps = {}
  for (const [k] of DIMS) { score[k] = INIT; why[k] = []; hits[k] = 0; caps[k] = {} }

  const add = (dim, item, capKey, capMax) => {
    if (!score[dim]) return
    const used = caps[dim][capKey] || 0
    const room = capMax - used
    if (room <= 0) return
    const v = Math.min(item.value, room)
    score[dim] += v
    caps[dim][capKey] = used + v
    hits[dim] += 1
    why[dim].push(item)
  }

  const mems = readMemories(db, aid)
  for (const m of mems) {
    const factor = typeFactor(m.type) * Math.max(0.2, Math.min(1, Number(m.weight) || 0.5))
    for (const [dim, re] of Object.entries(LEX)) {
      if (!re.test(String(m.text || ''))) continue
      add(dim, delta('memory', m.text, 0.010 * factor), 'memory', 0.15)
    }
  }

  let prefs = []
  try { prefs = (listPreferences(db, aid) || []).slice(0, 20) } catch { prefs = [] }
  for (const p of prefs) {
    const av = Number(p.aversion) || 0
    if (av >= 0.6) add('security', delta('preference', '受不了「' + p.tag + '」', 0.008), 'preference', 0.05)
    else add('hedonism', delta('preference', '喜欢「' + p.tag + '」', 0.006), 'preference', 0.05)
  }

  let taboos = []
  try { taboos = listTaboos(db, aid) || [] } catch { taboos = [] }
  for (const t of taboos) {
    if (t.level === 'root') {
      add('security', delta('taboo', '红线：' + t.text, 0.02), 'taboo', 0.06)
      add('conformity', delta('taboo', '礼的边界：' + t.text, 0.01), 'taboo', 0.04)
    } else {
      add('security', delta('taboo', '留意：' + t.text, 0.005), 'taboo', 0.06)
    }
  }

  // C9（9 号 §6）：关系越近越稳。优先读人物账本，老库兜底；连续量，不是阈值硬加
  let owner = null
  let rels = []
  let relCount = 0
  try {
    owner = db.prepare("SELECT name,closeness,trust FROM rel_person WHERE agent_id=? AND tier='owner' AND status='active'").get(aid)
    relCount = Number(db.prepare("SELECT COUNT(*) n FROM rel_person WHERE agent_id=? AND status<>'archived'").get(aid).n) || 0
  } catch { /* 老库没有账本 */ }
  if (!owner) {
    try { rels = listRelations(db, aid) || [] } catch { rels = [] }
    owner = rels.find((r) => r.kind === 'owner') || rels[0] || null
    relCount = Math.max(relCount, rels.length)
  }
  if (owner) {
    const k = Number(owner.closeness) || 0
    const r = Number(owner.trust) || 0
    const near = Math.max(0, Math.min(1, (k - 0.5) * 2))
    if (near > 0) add('benevolence', delta('relation', '跟' + owner.name + '很近', 0.02 * near), 'relation', 0.04)
    const bond = Math.max(0, Math.min(1, (k - 0.6) / 0.4)) * Math.max(0, Math.min(1, (r - 0.6) / 0.4))
    if (bond > 0) add('benevolence', delta('relation', '跟' + owner.name + '是「我-你」', 0.01 * bond), 'relation', 0.04)
  }

  try {
    const a = db.prepare('SELECT mood FROM affect_state WHERE agent_id=?').get(aid)
    const mood = Number(a && a.mood)
    if (Number.isFinite(mood)) {
      if (mood >= 0.65) add('hedonism', delta('affect', '心情不错', 0.01), 'affect', 0.02)
      if (mood <= 0.35) add('security', delta('affect', '心里不太稳', 0.01), 'affect', 0.02)
    }
  } catch { /* 老库没有情绪表 */ }

  // R21：同一维被 ≥5 条证据反复证实 → 惯习，增量步幅减半（布迪厄）
  const habit = {}
  for (const [k] of DIMS) {
    if (hits[k] >= 5 && score[k] > INIT) {
      score[k] = INIT + (score[k] - INIT) * 0.5
      habit[k] = true
    }
  }

  // §4.3 张力：赢的一侧抬高，输的一侧上限往下压，但不许归零
  const tension = {}
  for (const [a, b] of PAIRS) {
    const win = score[a] >= score[b] ? a : b
    const lose = win === a ? b : a
    const w = score[win]
    if (w > 0.12) {
      const cap = Math.max(FLOOR, 0.12 - 0.4 * (w - 0.12))
      tension[win] = { opposite: lose, cap: +cap.toFixed(4) }
      if (score[lose] > cap) {
        why[lose].push(delta('tension', '被「' + dimLabel(win) + '」压住', cap - score[lose]))
        score[lose] = cap
      }
    }
  }

  // 归一化（十维总和 = 1），再抬地板、再归一，保证既有张力又不出现 0
  const norm = () => {
    const total = Object.values(score).reduce((a, b) => a + b, 0)
    for (const [k] of DIMS) score[k] = Math.max(FLOOR, score[k] / total)
  }
  norm(); norm()

  const items = DIMS.map(([key, label, hint]) => ({
    key, label, hint,
    weight: +score[key].toFixed(4),
    evidence: why[key].slice(0, 4),
    habit: !!habit[key],
    origin: 'auto',
  })).sort((x, y) => y.weight - x.weight)

  return {
    items,
    tension,
    signals: {
      memory: mems.length, preferences: prefs.length, taboos: taboos.length,
      relations: relCount,
    },
    updated_at: now(),
  }
}

function dimLabel(key) {
  const hit = DIMS.find(([k]) => k === key)
  return hit ? hit[1] : key
}

export function listValuesRich(db, aid) {
  agent(db, aid)
  return derive(db, aid).items
}

/**
 * 已下线：不再写 persona_values。
 * 保留纯计算供「性格不写价值观」这类断言使用；结果不落库，调用方读不到缓存。
 */
export function growValues(db, aid, opts = {}) {
  agent(db, aid)
  return derive(db, aid).items
}

/** 技术视图：张力、证据条数、初值——解释「这些权重是怎么来的」 */
export function explainValues(db, aid) {
  agent(db, aid)
  const items = listValuesRich(db, aid)
  const tensions = PAIRS.map(([a, b]) => {
    const A = items.find((x) => x.key === a)
    const B = items.find((x) => x.key === b)
    return {
      pair: dimLabel(a) + ' ↔ ' + dimLabel(b),
      a: A ? A.weight : 0, b: B ? B.weight : 0,
      winner: A && B ? (A.weight >= B.weight ? dimLabel(a) : dimLabel(b)) : null,
    }
  })
  const habits = items.filter((x) => x.habit).map((x) => x.label)
  return { items, tension: tensions, habits, initial: INIT, floor: FLOOR, total: items.reduce((s, x) => s + x.weight, 0) }
}
