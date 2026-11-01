/**
 * 需求观测代理（地基 §2.6）→ 满足度增量。
 * 跨域只读聚合；由 evaluate / 对话编排调用，不驱动业务写入以外的逻辑。
 */
import { now } from '../db.js'
import { browseSummary } from './browse.js'

function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)) }

function daysSince(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 86400000) : 999
}

/**
 * @returns {{ proxies: Record<string,number>, detail: object, deltas: Record<string,number> }}
 */
export function computeNeedProxies(db, aid) {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(aid)
  const idle = agent?.last_interaction_at ? daysSince(agent.last_interaction_at) : 30
  const freshness = Math.exp(-idle / 7)

  // 近 20 条用户/助手轮：正向粗判
  let turns = []
  try {
    turns = db.prepare("SELECT role, text, mood, created_at FROM chat_turns WHERE agent_id=? ORDER BY rowid DESC LIMIT 40").all(aid)
  } catch { turns = [] }
  const recent = turns.slice(0, 20)
  // 只看对方说的话：把自己的发言算进「正性互动」等于自己哄自己，会虚高 R。
  const userRecent = recent.filter((t) => t.role === 'user')
  const posWords = ['谢谢', '喜欢', '好', '棒', '开心', '可以', '不错', '爱']
  const negWords = ['烦', '讨厌', '错', '滚', '别', '不要', '生气', '恨']
  let pos = 0, neg = 0
  for (const t of userRecent) {
    const s = String(t.text || '')
    if (posWords.some((w) => s.includes(w)) || t.mood === 'joy' || t.mood === 'calm') pos++
    if (negWords.some((w) => s.includes(w)) || t.mood === 'irritated' || t.mood === 'frustrated') neg++
  }
  const pos20 = userRecent.length ? clamp01(pos / userRecent.length) : 0.4
  const receipt = recent.filter((t) => t.role === 'agent').length
  const reciprocity = userRecent.length
    ? clamp01(userRecent.length / Math.max(1, receipt))
    : 0.5

  // 探索：近记忆里新类型占比 + 未解冲突反向
  let memN = 0, memNew = 0
  try {
    const week = new Date(Date.now() - 7 * 86400000).toISOString()
    memN = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active'").get(aid).n
    memNew = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND created_at>?").get(aid, week).n
  } catch { /* */ }
  const noveltyRaw = memN ? clamp01(memNew / memN) : 0.3
  // 年轻实例不是「探索得很充分」，只是还没老：按年龄把「新记忆占比」折一下，
  // 最少打 55 折，满七天之后才按原值算。否则出生三天、记忆全是新的，E 永远 1.0。
  const ageDays = agent?.created_at ? Math.max(1, (Date.now() - Date.parse(agent.created_at)) / 86400000) : 30
  const ageFactor = 0.55 + 0.45 * Math.min(1, ageDays / 7)
  const novelty = clamp01(noveltyRaw * ageFactor)
  let openQ = 0
  try {
    openQ = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND text LIKE '%？%'").get(aid).n
  } catch { /* */ }
  const openRatio = memN ? clamp01(openQ / memN) : 0.2
  const gain = clamp01(0.5 + novelty * 0.5)

  // 胜任（C）= 做的事成不成：行动成功率 + 主动开口被接住的比率
  //
  // 2026-10-30 修：不同行动路径写的状态词不一样（浏览/评论写 'ok'、提醒写 'queued'、
  // 发消息写 'sent'），原来只认 ('sent','fetched','queued')，把两次成功的浏览算成了失败，
  // tool 从 1.0 掉到 0.333 —— C 常年「饿」的不是能力，是一个字符串。
  // 现在按「已知成功 / 已知失败」两套词表判，未知状态不计入分母：词表以后再变也不会咬人。
  const OK_STATUS = new Set(['ok', 'sent', 'queued', 'fetched'])
  const BAD_STATUS = new Set(['failed', 'error', 'denied', 'unavailable', 'not_logged_in', 'unreachable', 'timeout'])
  let sentTotal = 0, sentOk = 0
  let acts = []
  try {
    sentTotal = db.prepare('SELECT COUNT(*) n FROM proactive WHERE agent_id=?').get(aid).n
    sentOk = db.prepare('SELECT COUNT(*) n FROM proactive WHERE agent_id=? AND answered=1').get(aid).n
    acts = db.prepare('SELECT status FROM action_log WHERE agent_id=? ORDER BY created_at DESC LIMIT 50').all(aid)
  } catch { /* */ }
  const graded = acts.filter((a) => OK_STATUS.has(String(a.status)) || BAD_STATUS.has(String(a.status)))
  const actOk = graded.filter((a) => OK_STATUS.has(String(a.status))).length
  const actN = graded.length
  // 2026-10-30 晚：小样本不能当结论。
  // 原来 n=3 全成功就是 tool=1.0、n=2 里 1 条被答应就是 answered=0.5，
  // 于是 C 被两个样本钉死在 0.80，一年都不会动——那不是「我胜任」，那是「没数据」。
  // 现在向先验收缩（Beta / Laplace 平滑）：样本越少越靠近「不知道」，
  // 攒够样本才敢说满话。这不是把 C 调饿，是把「证据不足」如实算进去。
  const shrink = (ok, n, prior, k) => clamp01((Number(ok) + prior * k) / (Number(n) + k))
  const answered = sentTotal ? shrink(sentOk, sentTotal, 0.55, 5) : 0.4
  const tool = actN ? shrink(actOk, actN, 0.5, 6) : 0.5

  // 自主（A）= 能不能自己决定并执行：授权面 + 自己的变更站不站得住 + 有没有被推翻。
  // 不再复用「主动被回应」那个数，否则 A 和 C 量的是同一件事。
  let portsAll = 0, portsOn = 0
  try {
    const p = db.prepare('SELECT enabled FROM action_ports WHERE agent_id=?').all(aid)
    portsAll = p.length
    portsOn = p.filter((x) => Number(x.enabled)).length
  } catch { /* */ }
  // 2026-10-30 修：rolled_back_at 是 TEXT，但有些路径往里写了 '手调' / 'shrink' 这种
  // 说明性文字。原来用 `IS NULL` 判断，等于把「这一行有没有被写过字」当成了回滚率：
  // 五次手调敏感度 → 五次「回滚」，survival 恒在 0.96。现在只认 ISO 时间戳。
  const isStamp = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)
  let changeN = 0, rolledBack = 0
  try {
    const c = db.prepare('SELECT rolled_back_at FROM changes WHERE agent_id=?').all(aid)
    changeN = c.length
    rolledBack = c.filter((x) => isStamp(x.rolled_back_at)).length
  } catch { /* */ }
  let propN = 0, overridden = 0
  try {
    const p = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN state IN ('rejected','rolled_back') THEN 1 ELSE 0 END) o FROM proposals WHERE agent_id=?").get(aid)
    propN = Number(p?.n || 0)
    overridden = Number(p?.o || 0)
  } catch { /* */ }
  const portFreedom = portsAll ? clamp01(portsOn / portsAll) : 0.5
  const survival = changeN ? clamp01(1 - rolledBack / changeN) : 0.6
  const override = (changeN + propN) ? clamp01((rolledBack + overridden) / (changeN + propN)) : 0
  const scope = agent?.status === 'active' ? 0.7 : 0.3
  const A = clamp01(0.4 * scope + 0.3 * portFreedom + 0.2 * survival + 0.1 * (1 - override))

  // 安全：冲突 / 告警 / 过载
  let openConflict = 0, alerts = 0, overload = 0
  try {
    openConflict = db.prepare("SELECT COUNT(*) n FROM conflicts WHERE agent_id=? AND state='open'").get(aid).n
    alerts = db.prepare("SELECT COUNT(*) n FROM alerts WHERE agent_id=? AND state='open'").get(aid).n
    const cond = db.prepare('SELECT load, state FROM condition_state WHERE agent_id=?').get(aid)
    overload = cond && (cond.state === 'overload' || Number(cond.load) > 0.8) ? 1 : 0
  } catch { /* */ }
  const violation = clamp01(alerts / 5)
  const conflict = clamp01(openConflict / 3)
  // 安全不只是「没出事」：悬着没定的事（草案/影子/待批）也会让底子不稳，
  // 否则没告警时 S 恒等于 1.0，安全维就永远不会动。
  let pendingProp = 0
  try {
    pendingProp = db.prepare("SELECT COUNT(*) n FROM proposals WHERE agent_id=? AND state IN ('draft','shadowed','promoted')").get(aid).n
  } catch { /* */ }
  const unsettled = clamp01(pendingProp / 4)
  // 安全只算「关系/系统出了事」；过载属于工况（E9 已经单独作用于情绪），不再混进安全感。
  const S = clamp01(1 - 0.5 * violation - 0.35 * conflict - 0.2 * unsettled)

  const R = clamp01(0.4 * freshness + 0.4 * pos20 + 0.2 * reciprocity)
  const E = clamp01(0.4 * novelty + 0.4 * gain + 0.2 * (1 - openRatio))
  const C = clamp01(0.6 * tool + 0.4 * answered)

  const proxies = { R, E, C, A, S }
  const detail = {
    freshness: +freshness.toFixed(3), pos20: +pos20.toFixed(3), reciprocity: +reciprocity.toFixed(3),
    novelty: +novelty.toFixed(3), novelty_raw: +noveltyRaw.toFixed(3), age_factor: +ageFactor.toFixed(3),
    gain: +gain.toFixed(3), openRatio: +openRatio.toFixed(3),
    answered: +answered.toFixed(3), tool: +tool.toFixed(3),
    samples: { acts: actN, proactive: sentTotal },
    port_freedom: +portFreedom.toFixed(3), survival: +survival.toFixed(3), override: +override.toFixed(3),
    violation: +violation.toFixed(3), conflict: +conflict.toFixed(3), unsettled: +unsettled.toFixed(3),
    overload, age_days: +ageDays.toFixed(2),
    idle_days: +idle.toFixed(2), at: now(),
  }

  // 相对当前满足度温和拉近（只反映可观测代理，步幅封顶交由 applySatisfaction）
  const row = db.prepare('SELECT r,e,c,a,s FROM drive_state WHERE agent_id=?').get(aid)
  const dims = row
    ? { R: row.r, E: row.e, C: row.c, A: row.a, S: row.s }
    : { R: 0.55, E: 0.55, C: 0.55, A: 0.55, S: 0.6 }
  const deltas = {}
  // 0.30（原 0.25）：跟手快一点，缺口才会随日子起伏，而不是被 21 天的习惯抹平
  const PULL = 0.3 // 每评估周期最多向代理靠拢的比例（再被 0.08 封顶）
  for (const k of ['R', 'E', 'C', 'A', 'S']) {
    const d = (proxies[k] - Number(dims[k])) * PULL
    if (Math.abs(d) >= 0.005) deltas[k] = d
  }

  // ---------------- v3 传感器（8 号 §4.3，P2） ----------------
  // 与 v2 并行算：shadow 只写事件、不接管；on 才用这一版替换满足度。INV5 不变。
  let v3 = null
  try {
    const DIMS5 = ['R', 'E', 'C', 'A', 'S']
    // R：不再量「你在不在」，改量「话说得实不实」
    const lastUser = turns.find((t) => t.role === 'user')
    const hoursSinceUser = lastUser && lastUser.created_at ? (Date.now() - Date.parse(lastUser.created_at)) / 3600000 : 999
    const fresh = Math.exp(-Math.max(0, hoursSinceUser) / 24)
    const depth = userRecent.length
      ? clamp01(userRecent.reduce((n, t) => n + String(t.text || '').length, 0) / userRecent.length / 80)
      : 0.3
    const dayAgo = new Date(Date.now() - 86400000).toISOString()
    // 连续性是「这一整天里有多少个小时还连着」，不是「说了多少句话」：
    // 用轮次数当分子时，一次长对话就能把 20 打满，之后一整天都是 1.0，等于没测。
    let turns24h = 0
    try { turns24h = Number(db.prepare('SELECT COUNT(*) n FROM chat_turns WHERE agent_id=? AND created_at>?').get(aid, dayAgo).n || 0) } catch { /* 老库 */ }
    let hours24h = 0
    try { hours24h = Number(db.prepare("SELECT COUNT(DISTINCT substr(created_at,12,2)) h FROM chat_turns WHERE agent_id=? AND created_at>?").get(aid, dayAgo).h || 0) } catch { /* 老库 */ }
    const continuity = clamp01(hours24h / 24)
    // 「没夸也没骂」是中性，不是负面：只按正词率算时，平平常常一句话就被记成 0，R 会无故塌掉。
    // v2 的 pos20 保留原语义（历史对照用），v3 换成中性的 0.5 基准。
    let posCnt = 0, negCnt = 0
    for (const t of userRecent) {
      const s = String(t.text || '')
      if (posWords.some((w) => s.includes(w)) || t.mood === 'joy' || t.mood === 'calm') posCnt++
      if (negWords.some((w) => s.includes(w)) || t.mood === 'irritated' || t.mood === 'frustrated') negCnt++
    }
    const posCentered = userRecent.length
      ? clamp01(0.5 + 0.5 * ((posCnt - negCnt) / userRecent.length))
      : 0.5
    const R3 = clamp01(0.30 * fresh + 0.30 * posCentered + 0.25 * depth + 0.15 * continuity)

    // E：novelty + 真接触到的新实体 + 未解疑问 + 浏览新领域
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()
    let newEnt = 0
    try { newEnt = Number(db.prepare('SELECT COUNT(*) n FROM entities WHERE agent_id=? AND created_at>?').get(aid, weekAgo).n || 0) } catch { /* 老库 */ }
    // 分母 315 = 每天 45 个新实体 × 7 天：按真实速率定，不是按「感觉多」定（原来 /8，266 个直接把 1.0 打满）
    const discovery = clamp01(newEnt / 315)
    const browse = browseSummary(db, aid, 3)
    // 缺数据不是 0.5 分：没接过浏览就把这一项整个摘掉，剩下的权重归一——
    // 否则 browseNew 的 0.5 会一直把 E 往中间拽，看起来「稳定」其实是没测。
    const eParts = [[0.40, novelty], [0.25, discovery], [0.20, 1 - openRatio]]
    if (browse.total > 0) eParts.push([0.15, browse.browseNew])
    const eW = eParts.reduce((n, [w]) => n + w, 0)
    const E3 = clamp01(eParts.reduce((n, [w, v]) => n + w * v, 0) / (eW || 1))

    // C：行动成功率 + 主动被接住 + 提案走到底
    let propRows = []
    try { propRows = db.prepare('SELECT state FROM proposals WHERE agent_id=? ORDER BY created_at DESC LIMIT 10').all(aid) } catch { propRows = [] }
    const adopted = propRows.filter((p) => ['promoted', 'done'].includes(String(p.state))).length
    const delivery = propRows.length ? clamp01(adopted / propRows.length) : 0.5
    const adoption = propRows.length >= 3 ? clamp01(adopted / propRows.length) : 0.5
    // 同理：提案不足 3 条，「走到底的比例」样本太小，摘掉、归一，不拿 0.5 充数
    const cParts = [[0.55, tool], [0.25, answered]]
    if (propRows.length >= 3) cParts.push([0.20, delivery])
    const cW = cParts.reduce((n, [w]) => n + w, 0)
    const C3 = clamp01(cParts.reduce((n, [w, v]) => n + w * v, 0) / (cW || 1))

    // A：能自己做多少事、做了的事站不站得住
    const WRITE_PORTS = ['send_message', 'browse', 'comment', 'remind', 'canvas', 'voice']
    const READ_PORTS = ['look']
    const pmap = new Map()
    try { for (const p of db.prepare('SELECT name,enabled FROM action_ports WHERE agent_id=?').all(aid)) pmap.set(String(p.name), Number(p.enabled) ? 1 : 0) } catch { /* 老库 */ }
    const writeOn = WRITE_PORTS.filter((p) => pmap.get(p) === 1).length
    const writeShare = writeOn / WRITE_PORTS.length
    const scopeV3 = clamp01(0.6 * writeShare + 0.4 * adoption)
    let wSum = 0, wOn = 0
    for (const p of WRITE_PORTS) { wSum += 1; wOn += pmap.get(p) || 0 }
    for (const p of READ_PORTS) { wSum += 0.3; wOn += 0.3 * (pmap.get(p) || 0) }
    const portFreedomV3 = wSum ? clamp01(wOn / wSum) : 0.5
    let initiative = 0.5
    try {
      const ch = db.prepare('SELECT actor,source FROM changes WHERE agent_id=? ORDER BY applied_at DESC LIMIT 20').all(aid)
      if (ch.length) initiative = clamp01(ch.filter((x) => String(x.actor) === 'agent' && String(x.source) !== 'user').length / ch.length)
    } catch { /* 老库 */ }
    const A3 = clamp01(0.30 * scopeV3 + 0.25 * portFreedomV3 + 0.20 * survival + 0.15 * (1 - override) + 0.10 * initiative)
    // A 被端口配置压住时，这不是「我不想自主」，是「我没被允许」：单独标出来，也给一个「全开的话能到多少」的上限
    const aCeiling = clamp01(0.30 * clamp01(0.6 * 1 + 0.4 * adoption) + 0.25 * 1 + 0.20 * survival + 0.15 * (1 - override) + 0.10 * initiative)
    const configBlocked = writeOn === 0 ? 'write_ports_off' : null

    // S：除了「没出事」，还要看最近真弄坏过什么、欠着多少没处理
    let damageN = 0
    try {
      const t72 = new Date(Date.now() - 72 * 3600000).toISOString()
      const rb = Number(db.prepare('SELECT COUNT(*) n FROM changes WHERE agent_id=? AND rolled_back_at IS NOT NULL AND rolled_back_at>?').get(aid, t72).n || 0)
      const bad = Number(db.prepare("SELECT COUNT(*) n FROM action_log WHERE agent_id=? AND created_at>? AND status IN ('failed','error','denied','unavailable','timeout','unreachable')").get(aid, t72).n || 0)
      damageN = rb + bad
    } catch { /* 老库 */ }
    const damage = clamp01(damageN / 8)
    let backlogN = 0
    try { backlogN = Number(db.prepare("SELECT COUNT(*) n FROM inbox_items WHERE agent_id=? AND state='pending'").get(aid).n || 0) } catch { /* 老库 */ }
    const backlog = clamp01(backlogN / 10)
    const S3 = clamp01(1 - 0.30 * violation - 0.25 * conflict - 0.15 * unsettled - 0.20 * damage - 0.10 * backlog)

    const proxiesV3 = { R: R3, E: E3, C: C3, A: A3, S: S3 }
    const deltasV3 = {}
    for (const k of DIMS5) {
      const dd = (proxiesV3[k] - Number(dims[k])) * PULL
      if (Math.abs(dd) >= 0.005) deltasV3[k] = dd
    }
    v3 = {
      proxies: proxiesV3,
      deltas: deltasV3,
      detail: {
        fresh: +fresh.toFixed(3), depth: +depth.toFixed(3), continuity: +continuity.toFixed(3),
        hours24h, turns24h, pos_centered: +posCentered.toFixed(3),
        discovery: +discovery.toFixed(3), new_entities: newEnt,
        browseNew: +browse.browseNew.toFixed(3), browse_items: browse.total, browse_used: browse.total > 0,
        e_weights: eW,
        delivery: +delivery.toFixed(3), adoption: +adoption.toFixed(3), proposals_n: propRows.length, delivery_used: propRows.length >= 3,
        write_share: +writeShare.toFixed(3), write_on: writeOn, port_freedom: +portFreedomV3.toFixed(3), initiative: +initiative.toFixed(3),
        a_ceiling: +aCeiling.toFixed(3), config_blocked: configBlocked,
        damage: +damage.toFixed(3), damage_raw: damageN, backlog: +backlog.toFixed(3), backlog_n: backlogN,
        at: now(),
      },
    }
  } catch { v3 = null } // 新传感器算不出来不能拖垮评估

  return { proxies, detail, deltas, v3 }
}
