/**
 * 性格四轴「拔河」（v2）
 *
 * 一根轴 = 左右两个拉力池 + 一个慢值 + 一个极慢基线。
 *   ① 证据只进池，不直接改轴；
 *   ② 池子自己衰减（半衰期 7 天），所以「昨天吵赢一次」不会永久有效；
 *   ③ 一边明显领先（净力 ≥0.30、≥3 条、平均强度 ≥0.25）才允许挪一步，
 *      步幅跟净力成比例（0.008~0.02），弱证据只能推小步；
 *   ④ 挪完两边各泄一半劲，防止同一批证据连推多步；
 *   ④' 一侧顶到上限后溢出的力去顶对面，否则两边各自顶满、净力恒 0，轴永久锁死；
 *   ⑤ 没有强拉力时，慢值往基线回弹（半衰期 60 天）；
 *   ⑥ 基线每 30 天结算一次，最多 ±0.02——这就是「长期不像墙头草」。
 *
 * 为什么这么分：Whole Trait Theory 说特质是状态密度分布的均值（详见 14 号文档），
 * 单次事件属于状态，只有反复出现才配沉成特质。
 *
 * 融合（多来源）：
 *   每个来源先自己表态（net = (正-负)/(正+负+K)），再按来源权重加权平均；
 *   分母只算真的投了票的来源。不用 clamp 相减，是因为那样会把「投 2 条」和
 *   「投 500 条」抹成一个价，正反都过百条的来源净力恒 0，大来源反而变成哑巴。
 *   同一来源同一天的量还要等比缩到 SRC_DAY_CAP 条，防止一个来源靠刷屏长期绑住轴。
 */
import { now } from '../db.js'
import { nid, getFlag, setFlag } from '../kernel.js'
import { AXIS_KEYS, AXIS_DEFAULTS, NEUTRAL, STEP, axisRows, setAxisAuto, nudgeAxis, SOURCE_WEIGHTS } from './traits.js'

export const ROPE = {
  HALF_LIFE_DAYS: 7,      // 拉力池半衰期
  BASE_HL_DAYS: 60,       // 回弹到基线的半衰期
  FORCE_MIN: 0.30,        // 净力阈值
  MIN_COUNT: 3,           // 赢的一边至少要几条
  MIN_AVG: 0.25,          // 赢的一边平均强度
  GAIN: 0.025,            // 步幅 = 净力 × GAIN，力到 0.8 左右刚好顶到日上限，整段都保持比例
  STEP_MIN: 0.01,         // 刚过阈值也给个小碎步，别一步不动
  DAILY_MAX: 0.02,        // 每根轴每天最多挪这么多（一天一步）。0.05 时三天就能翻个字母，太快了
  WALL_END: 0.40,         // 漂移极限：离 0.5 最远到这里（0.90 / 0.10），越近越难推
  SPRING_UNDER: 0.10,     // 净力小于它就回弹
  NET_K: 0.6,             // 来源净力 = (正-负)/(正+负+K)：小样本自然收敛，大来源不被削平
  SRC_DAY_CAP: 4,         // 同一来源、同一天、同一方向最多算几条（防 mem 这种天天刷屏的）
  STREAK_FREE: 3,         // 连续同向推几天之内不减速
  STREAK_DECAY: 0.04,     // 之后每多一天，步幅再乘 (1-0.04)
  STREAK_FLOOR: 0.6,      // 最多只减到 6 折——再狠就推不出字母了
  BASE_EVERY_DAYS: 30,    // 基线结算周期
  BASE_GAP: 0.08,         // 偏离多少才动基线
  BASE_GAIN: 0.10,        // 每次把差距吃掉多少
  BASE_MAX: 0.02,         // 单次基线最大移动
  CAP: 1.0,               // 单侧池子上限
}

const DAY = 86400000
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))
const decayOf = (ms) => Math.pow(0.5, Math.max(0, Number(ms) || 0) / (ROPE.HALF_LIFE_DAYS * DAY))

/**
 * 漂移阻力：离 0.5 越远越小，到 WALL_END（默认 ±0.40，即 0.10~0.90）归零。
 * 0.50 → 1.0（全速）、0.60 → 0.75、0.80 → 0.25、0.90 → 0。
 */
export function wallFactor(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return 1
  return Math.max(0, 1 - Math.abs(clamp01(v) - NEUTRAL) / ROPE.WALL_END)
}

/** 这根轴今天已经挪了多少（flag 里按「日期:累计」记） */
function dayUsed(db, aid, axis) {
  try {
    const v = String(getFlag(db, 'axis.move.day:' + axis + ':' + aid) || '')
    const [d, n] = v.split(':')
    return d === now().slice(0, 10) ? Number(n) || 0 : 0
  } catch { return 0 }
}
function addDayUsed(db, aid, axis, step) {
  try { setFlag(db, 'axis.move.day:' + axis + ':' + aid, now().slice(0, 10) + ':' + (dayUsed(db, aid, axis) + Math.abs(step)).toFixed(4)) } catch { /* ignore */ }
}

/** 人工清掉「今天已挪」的账（测试/调试用；正常不该碰） */
export function resetDaily(db, aid, axis = null) {
  for (const a of axis ? [axis] : AXIS_KEYS) {
    try { setFlag(db, 'axis.move.day:' + a + ':' + aid, '') } catch { /* ignore */ }
  }
  return { reset: axis || AXIS_KEYS }
}

function blank(axis) {
  // base 用「这轴自己的出厂值」，不是统一的 0.5：ei 生下来就 0.60、敏感 0.80，
  // 拿 0.5 当基线会把出厂人格当成「偏离」，慢慢抹回去。
  return {
    axis, pos: 0, pos_n: 0, pos_s: 0, neg: 0, neg_n: 0, neg_s: 0,
    base: AXIS_DEFAULTS[axis] ?? NEUTRAL, at: now(), base_at: null, src: {},
  }
}

/** 单个来源自己的净力（-1~1）。
 *
 *  用「比例」而不是「clamp 后相减」：
 *    旧写法 net = clamp01(pos) - clamp01(neg)，任何来源只要攒到 2 条就顶满 1，
 *    投 2 条和投 500 条一个价；reply 这种正反都过 200 条的来源，两边都被 clamp 到 1，
 *    净力恒 0 —— 占 75% 证据的最大来源反而成了哑巴，只会在分母里稀释别人。
 *    比例式 (pos-neg)/(pos+neg+K) 保方向、保力度、小样本自动收敛到 0 附近，
 *    而且不需要 K 之外的上限（单来源桶不再截断）。
 */
export function srcNet(b) {
  const pos = Math.max(0, Number(b && b.pos) || 0)
  const neg = Math.max(0, Number(b && b.neg) || 0)
  const tot = pos + neg
  if (tot <= 1e-9) return 0
  return (pos - neg) / (tot + ROPE.NET_K)
}

/** 每个来源自己表态，再按来源权重加权平均。
 *  分母只算「真的投了票」的来源（正负都为 0 的来源不占权重），
 *  免得一个哑巴来源把别人的力摊薄。 */
function weightedForce(st) {
  const src = (st && st.src) || {}
  const parts = {}
  let wsum = 0
  let sum = 0
  for (const [k, v] of Object.entries(src)) {
    const pos = Math.max(0, Number(v && v.pos) || 0)
    const neg = Math.max(0, Number(v && v.neg) || 0)
    if (pos + neg <= 1e-9) continue
    const w = SOURCE_WEIGHTS[k] != null ? Number(SOURCE_WEIGHTS[k]) : 1
    const net = srcNet({ pos, neg })
    parts[k] = { w, net: +net.toFixed(3), pos: +pos.toFixed(3), neg: +neg.toFixed(3) }
    sum += w * net
    wsum += w
  }
  return { force: wsum > 0 ? sum / wsum : 0, parts, wsum: +wsum.toFixed(3) }
}

/** 这根轴最近是不是在「连续同向」推。存成 `方向:连了几天:最后一天`。 */
export function streakOf(db, aid, axis) {
  try {
    const v = String(getFlag(db, 'axis.streak:' + axis + ':' + aid) || '')
    const [dir, n, day] = v.split(':')
    return { dir: Number(dir) || 0, n: Number(n) || 0, day: day || '' }
  } catch { return { dir: 0, n: 0, day: '' } }
}

/** 连续同向的减速系数：前 STREAK_FREE 天 1.0，之后每天 ×(1-STREAK_DECAY)，最低 STREAK_FLOOR。
 *  防的是「几十天同一方向一路滑到墙」，不是防正常漂移，所以只削 6 折封顶。 */
export function streakFactor(db, aid, axis, dir, atMs = Date.now()) {
  const prev = streakOf(db, aid, axis)
  if (prev.dir !== dir || !prev.day) return { factor: 1, streak: 1 }
  const gap = (atMs - Date.parse(prev.day)) / DAY
  // 隔了太久（超过 3 天没推）就不算「连着」
  const streak = gap <= 3 ? prev.n + 1 : 1
  const factor = Math.max(ROPE.STREAK_FLOOR, 1 - ROPE.STREAK_DECAY * Math.max(0, streak - ROPE.STREAK_FREE))
  return { factor: +factor.toFixed(3), streak }
}

/** 记下这次推进，供下一次算连击 */
function saveStreak(db, aid, axis, dir, streak) {
  try { setFlag(db, 'axis.streak:' + axis + ':' + aid, dir + ':' + streak + ':' + now().slice(0, 10)) } catch { /* ignore */ }
}

/** 人工清掉连击账（测试/调试用） */
function parseSrc(raw) {
  if (!raw) return {}
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : {}
  } catch { return {} }
}

/** 取一行，顺手按「距离上次更新多久」衰减（懒衰减：不读就不算，省得开定时器） */
export function state(db, aid, axis) {
  let row = null
  try {
    row = db.prepare('SELECT * FROM axis_rope WHERE agent_id=? AND axis=?').get(aid, axis)
  } catch { row = null }
  if (!row) return blank(axis)
  const k = decayOf(Date.now() - Date.parse(row.at || now()))
  const src = {}
  for (const [key, v] of Object.entries(parseSrc(row.src))) {
    if (!v || typeof v !== 'object') continue
    src[key] = {
      // 单来源桶不夹到 1：比例式净力要靠原始量级区分「投 2 条」和「投 200 条」
      pos: Math.max(0, Number(v.pos) * k), neg: Math.max(0, Number(v.neg) * k),
      pos_n: Math.max(0, Math.round(Number(v.pos_n || 0) * k)),
      neg_n: Math.max(0, Math.round(Number(v.neg_n || 0) * k)),
      pos_s: Number(v.pos_s || 0) * k, neg_s: Number(v.neg_s || 0) * k,
      // 当日限额的账本不参与衰减，跨天在 add() 里重置
      d: v.d || null,
      np: Math.max(0, Math.round(Number(v.np) || 0)), nn: Math.max(0, Math.round(Number(v.nn) || 0)),
      tp: Math.max(0, Number(v.tp) || 0), tn: Math.max(0, Number(v.tn) || 0),
      cp: Math.max(0, Number(v.cp) || 0), cn: Math.max(0, Number(v.cn) || 0),
    }
  }
  // 老库（src 列刚补上、里面还是空的）里已有的拉力别浪费：
  // 拿总池当一票 legacy 投进去，等新证据把它按 7 天半衰期自然代谢掉。
  if (!Object.keys(src).length) {
    const p = clamp01(Number(row.pos) * k)
    const n = clamp01(Number(row.neg) * k)
    if (p + n > 1e-9) {
      src.legacy = {
        pos: p, neg: n,
        pos_n: Math.max(0, Math.round(Number(row.pos_n) * k)),
        neg_n: Math.max(0, Math.round(Number(row.neg_n) * k)),
        pos_s: Number(row.pos_s) * k, neg_s: Number(row.neg_s) * k,
        d: null, np: 0, nn: 0, tp: 0, tn: 0, cp: 0, cn: 0,
      }
    }
  }
  return {
    axis,
    pos: clamp01(Number(row.pos) * k),
    // 条数按四舍五入衰减：用 floor 的话，连续记账时 dt≈0 也会被截掉一条（踩过）
    pos_n: Math.max(0, Math.round(Number(row.pos_n) * k)),
    pos_s: Number(row.pos_s) * k,
    neg: clamp01(Number(row.neg) * k),
    neg_n: Math.max(0, Math.round(Number(row.neg_n) * k)),
    neg_s: Number(row.neg_s) * k,
    base: Number.isFinite(Number(row.base)) ? Number(row.base) : NEUTRAL,
    at: row.at || now(),
    base_at: row.base_at || null,
    src,
  }
}

function save(db, aid, s) {
  db.prepare(`INSERT OR REPLACE INTO axis_rope
    (agent_id, axis, pos, pos_n, pos_s, neg, neg_n, neg_s, base, at, base_at, src)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    aid, s.axis,
    clamp01(s.pos), Math.max(0, Math.round(s.pos_n)), Math.max(0, s.pos_s),
    clamp01(s.neg), Math.max(0, Math.round(s.neg_n)), Math.max(0, s.neg_s),
    clamp01(s.base), s.at || now(), s.base_at || null,
    JSON.stringify(s.src || {}),
  )
  return s
}

/**
 * 记一条证据：进池 + 落审计行。
 * @param {{axis:string, dir:number, strength:number, source:string, refId?:string, w?:number}} e
 */
export function add(db, aid, e = {}) {
  const axis = String(e.axis || '')
  if (!AXIS_KEYS.includes(axis)) return null
  const dir = Number(e.dir) < 0 ? -1 : 1
  const s = clamp01(e.strength == null ? 0.4 : e.strength)
  const w = Number.isFinite(Number(e.w)) ? Math.max(0.05, Math.min(2, Number(e.w))) : 1
  const srcKey = String(e.source || 'chat')
  // 单条权重（复读打五折、低权事件）先折进力气；来源权重在 flush 时按「每个来源一票」再乘。
  const sW = s * w
  const st = state(db, aid, axis)
  if (!st.src || typeof st.src !== 'object') st.src = {}
  const b = st.src[srcKey] || {
    pos: 0, neg: 0, pos_n: 0, neg_n: 0, pos_s: 0, neg_s: 0,
    d: null, np: 0, nn: 0, tp: 0, tn: 0, cp: 0, cn: 0,
  }
  st.src[srcKey] = b
  // 当日限额：同一来源、同一天最多算 SRC_DAY_CAP 条。
  // 关键是「等比缩」而不是「直接丢」：reply 一天 +300/−50，硬砍成 4/4 会变成 1:1，信号归零；
  // 按当日条数把所有证据同乘一个系数，正负比例保住，量被压到 CAP 以内。
  // mem 这种一天固定投十几条的来源，从「16 条的分量」降到「4 条的分量」。
  const day = String(e.at || now()).slice(0, 10)
  if (b.d !== day) { b.d = day; b.np = 0; b.nn = 0; b.tp = 0; b.tn = 0; b.cp = 0; b.cn = 0 }
  if (dir > 0) { b.np += 1; b.tp += sW }
  else { b.nn += 1; b.tn += sW }
  const nToday = b.np + b.nn
  const k = nToday > ROPE.SRC_DAY_CAP ? ROPE.SRC_DAY_CAP / nToday : 1
  const tgtP = b.tp * k
  const tgtN = b.tn * k
  // 只把「今天的份额变化」加到池子里；前几天已经落进池子的量不动
  b.pos = Math.max(0, b.pos + (tgtP - b.cp))
  b.neg = Math.max(0, b.neg + (tgtN - b.cn))
  b.cp = tgtP
  b.cn = tgtN
  // 单来源桶不截断：比例式净力要靠原始量级区分「投 2 条」和「投 200 条」
  if (dir > 0) { b.pos_n += 1; b.pos_s += s } else { b.neg_n += 1; b.neg_s += s }
  if (dir > 0) {
    const nextAll = st.pos + sW
    if (nextAll > ROPE.CAP) { st.neg = Math.max(0, st.neg - (nextAll - ROPE.CAP)); st.pos = ROPE.CAP }
    else st.pos = nextAll
    st.pos_n += 1; st.pos_s += s
  } else {
    const nextAll = st.neg + sW
    if (nextAll > ROPE.CAP) { st.pos = Math.max(0, st.pos - (nextAll - ROPE.CAP)); st.neg = ROPE.CAP }
    else st.neg = nextAll
    st.neg_n += 1; st.neg_s += s
  }
  st.at = now()
  try { save(db, aid, st) } catch { return null }
  const id = nid('axe_')
  try {
    db.prepare(`INSERT INTO axis_evidence
      (id, agent_id, axis, dir, strength, source, ref_id, at, used, pole, w, why, weak)
      VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)`)
      .run(id, aid, axis, dir, Math.round(s * 1000) / 1000, srcKey,
        e.refId || null, e.at || now(), dir > 0 ? '+' : '-', w, e.why ? String(e.why) : null, e.weak ? 1 : 0)
  } catch {
    // 老库没有 pole/w 列时退回旧写法，证据照记
    try {
      db.prepare(`INSERT INTO axis_evidence(id,agent_id,axis,dir,strength,source,ref_id,at,used)
        VALUES(?,?,?,?,?,?,?,?,0)`)
        .run(id, aid, axis, dir, Math.round(s * 1000) / 1000, srcKey, e.refId || null, e.at || now())
    } catch { /* 审计失败不影响池子 */ }
  }
  return { id, axis, dir, strength: s, w, source: srcKey, amount: s * w }
}

/**
 * 把四轴过一遍：够力就挪一步，不够就回弹；顺便按月结算基线。
 * @returns {Array<{axis,before,after,force,why}>}
 */
export function flush(db, aid, opt = {}) {
  const out = []
  const atMs = Number(opt.at) || Date.now()
  for (const axis of AXIS_KEYS) {
    let st
    try { st = state(db, aid, axis) } catch { continue }
    // 净力 = 各来源自己表态后按权重加权平均（见 weightedForce），不是条数累加
    const wf = weightedForce(st)
    const force = wf.force
    const side = force >= 0 ? 'pos' : 'neg'
    const n = side === 'pos' ? st.pos_n : st.neg_n
    const sum = side === 'pos' ? st.pos_s : st.neg_s
    const avg = n > 0 ? sum / n : 0
    const cur = axisRows(db, aid)[axis]

    // ① 够力 → 走一步：步幅跟净力成比例（不是一律 0.05），
    //    刚过阈值只给 0.01~0.03，真压得住才接近上限——这样弱证据推不动，来回晃也会变小。
    //    再叠一层日上限：每根轴一天最多挪 DAILY_MAX（默认 0.05），
    //    不然一次吵架就能把轴顶到极端，那是情绪不是性格。
    if (Math.abs(force) >= ROPE.FORCE_MIN && n >= ROPE.MIN_COUNT && avg >= ROPE.MIN_AVG) {
      const dir = force >= 0 ? 1 : -1
      // 一天一步：今天已经挪过就等明天。
      // （不能因为越靠边步幅被 wall 削小，就在同一天里连刷几次凑够 0.05）
      if (dayUsed(db, aid, axis) > 1e-6) { continue }
      const budget = ROPE.DAILY_MAX
      // 越极端越难：离 0.5 越远系数越小，到 WALL_END（默认 0.90/0.10）归零。
      // 不能只靠回弹：回弹是 60 天半衰期（每天约 1.2%），漂是每天 5%，追不上。
      const wallK = wallFactor(cur.value)
      if (wallK <= 1e-6) { continue }
      // 连续同向推了几天之后稍微减速：一路同方向滑到墙的，多半不是「性格在长」，是日子太单一。
      const sf = streakFactor(db, aid, axis, dir, atMs)
      const step = Math.max(0, Math.min(STEP, Math.abs(force) * ROPE.GAIN, budget)) * wallK * sf.factor
      if (step <= 1e-6) { continue }
      let res = null
      try {
        res = setAxisAuto(db, aid, axis, dir * step, `拔河 ${dir > 0 ? '+' : '−'}${n}条(均${avg.toFixed(2)}) 力${force.toFixed(2)} 步${step.toFixed(3)} 连${sf.streak}`)
      } catch { res = null }
      if (res && res.changed) {
        addDayUsed(db, aid, axis, step)
        saveStreak(db, aid, axis, dir, sf.streak)
        // 泄劲：两边各剩一半，条数与强度和一起减半；每个来源桶也各自减半
        st.pos = clamp01(st.pos * 0.5); st.pos_n = Math.round(st.pos_n * 0.5); st.pos_s *= 0.5
        st.neg = clamp01(st.neg * 0.5); st.neg_n = Math.round(st.neg_n * 0.5); st.neg_s *= 0.5
        for (const key of Object.keys(st.src || {})) {
          const b = st.src[key]
          if (!b || typeof b !== 'object') continue
          // 单来源桶不 clamp：比例式净力要靠原始量级区分强弱
          b.pos = Math.max(0, Number(b.pos || 0) * 0.5); b.neg = Math.max(0, Number(b.neg || 0) * 0.5)
          b.pos_n = Math.round(Number(b.pos_n || 0) * 0.5); b.neg_n = Math.round(Number(b.neg_n || 0) * 0.5)
          b.pos_s = Number(b.pos_s || 0) * 0.5; b.neg_s = Number(b.neg_s || 0) * 0.5
          // 当天份额也已经折进池子并被减半了，账本跟着清零，否则下次 add 会按旧份额再算一遍
          b.d = null; b.np = 0; b.nn = 0; b.tp = 0; b.tn = 0; b.cp = 0; b.cn = 0
        }
        st.at = now()
        try { save(db, aid, st) } catch { /* ignore */ }
        try {
          db.prepare('UPDATE axis_evidence SET used=1 WHERE agent_id=? AND axis=? AND used=0 AND pole=?')
            .run(aid, axis, dir > 0 ? '+' : '-')
        } catch { /* ignore */ }
        out.push({ axis, before: res.before, after: res.after, force: +force.toFixed(3), why: 'rope' })
      }
      continue
    }

    // ② 没强拉力 → 往基线回弹（慢，不再看冷却）
    if (Math.abs(force) < ROPE.SPRING_UNDER && Number.isFinite(Number(cur && cur.value))) {
      const base = st.base
      const dt = Math.max(0, atMs - Date.parse(st.at || now()))
      const relax = 1 - Math.pow(0.5, dt / (ROPE.BASE_HL_DAYS * DAY))
      if (relax > 0 && Math.abs(base - cur.value) > 0.002) {
        try {
          const r2 = nudgeAxis(db, aid, axis, cur.value + (base - cur.value) * relax, '回弹基线')
          if (r2 && r2.changed) out.push({ axis, before: r2.before, after: r2.after, force: +force.toFixed(3), why: 'spring' })
        } catch { /* ignore */ }
      }
    }

    // ③ 基线月结：偏离够大才动，单次 ≤0.02
    const lastBase = st.base_at ? Date.parse(st.base_at) : 0
    if (atMs - lastBase >= ROPE.BASE_EVERY_DAYS * DAY) {
      const gap = Number(cur.value) - st.base
      if (Number.isFinite(gap) && Math.abs(gap) > ROPE.BASE_GAP) {
        const move = Math.max(-ROPE.BASE_MAX, Math.min(ROPE.BASE_MAX, gap * ROPE.BASE_GAIN))
        st.base = clamp01(st.base + move)
      }
      st.base_at = new Date(atMs).toISOString()
      st.at = now()
      try { save(db, aid, st) } catch { /* ignore */ }
    }
  }
  return out
}

/**
 * 撤票：词表判错、复核没通过的那条证据，从池子里扣掉。
 * 只做近似扣减（池子可能已经泄过劲），够用了——证据本来就是一票一票的。
 * @returns {number} 实际撤掉几条
 */
export function voidEvidence(db, aid, ids = []) {
  let n = 0
  for (const id of ids) {
    let row = null
    try { row = db.prepare('SELECT * FROM axis_evidence WHERE id=? AND agent_id=?').get(String(id), aid) } catch { row = null }
    if (!row || Number(row.used) === 2) continue
    const s = Number(row.strength || 0)
    const amt = s * (Number.isFinite(Number(row.w)) ? Number(row.w) : 1)
    const srcKey = String(row.source || 'chat')
    let st
    try { st = state(db, aid, row.axis) } catch { continue }
    if (!st.src || typeof st.src !== 'object') st.src = {}
    const b = st.src[srcKey] || null
    if (Number(row.dir) > 0) {
      st.pos = Math.max(0, st.pos - amt)
      st.pos_n = Math.max(0, st.pos_n - 1)
      st.pos_s = Math.max(0, st.pos_s - s)
      if (b) { b.pos = Math.max(0, Number(b.pos) - amt); b.pos_n = Math.max(0, Number(b.pos_n || 0) - 1); b.pos_s = Math.max(0, Number(b.pos_s || 0) - s) }
    } else {
      st.neg = Math.max(0, st.neg - amt)
      st.neg_n = Math.max(0, st.neg_n - 1)
      st.neg_s = Math.max(0, st.neg_s - s)
      if (b) { b.neg = Math.max(0, Number(b.neg) - amt); b.neg_n = Math.max(0, Number(b.neg_n || 0) - 1); b.neg_s = Math.max(0, Number(b.neg_s || 0) - s) }
    }
    st.at = now()
    try { save(db, aid, st) } catch { continue }
    try { db.prepare('UPDATE axis_evidence SET used=2 WHERE id=?').run(String(id)) } catch { /* ignore */ }
    n++
  }
  return n
}

/** 给界面/调试：每根轴现在两边各多少力，以及「谁在投票」 */
export function snapshot(db, aid) {
  const axes = axisRows(db, aid)
  return AXIS_KEYS.map((axis) => {
    const st = state(db, aid, axis)
    const wf = weightedForce(st)
    return {
      axis,
      value: axes[axis].value,
      origin: axes[axis].origin,
      pos: +st.pos.toFixed(3),
      neg: +st.neg.toFixed(3),
      pos_n: st.pos_n,
      neg_n: st.neg_n,
      force: +wf.force.toFixed(3),
      src: wf.parts,
      base: +st.base.toFixed(3),
      lead: wf.force >= 0 ? '+' : '-',
    }
  })
}

/** 人工重置一个轴的两池（不碰慢值和基线） */
export function clearPools(db, aid, axis = null) {
  const list = axis ? [axis] : AXIS_KEYS
  for (const a of list) {
    if (!AXIS_KEYS.includes(a)) continue
    const st = state(db, aid, a)
    st.pos = 0; st.pos_n = 0; st.pos_s = 0
    st.neg = 0; st.neg_n = 0; st.neg_s = 0
    st.src = {}
    st.at = now()
    try { save(db, aid, st) } catch { /* ignore */ }
  }
  return { cleared: list }
}

/** 上次扫描到哪（夜间补扫用） */
export function lastScanAt(db, aid) {
  try { return getFlag(db, 'persona.scan_at:' + aid) || null } catch { return null }
}

export function markScanAt(db, aid, iso = now()) {
  try { setFlag(db, 'persona.scan_at:' + aid, iso) } catch { /* ignore */ }
  return iso
}
