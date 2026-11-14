/**
 * 事件的「沉浮」：想头随时间涨、天花板随时间沉、随手掷骰忽然想起。
 *
 * 规则来自 docs/设计-记忆与联想-v3-2026-11-12.md 第五节：
 *   想头 r0 = 0.06 × (0.5 + w)          ← 平常每小时涨多少
 *   r(t) = r0 × 提一提 × 缺口同向
 *   想头 = min(天花板, 想头 + r × Δt)
 *   浮现后 想头 −0.4，天花板 ×(0.6 + 0.35×w)
 *   天花板每周 ×0.98（没人提，自己往下沉）；被提到一次 +0.05
 *   门槛：想头 ≥ 0.5 = 待联想
 *
 * 随机联想（没抓手那条路）：
 *   每小时掷一次，8%；一次之后冷却 3 小时
 *   只从「7 天以上没浮现过」的台面事件里抽，概率 ∝ 1/(1+天数)
 *   不消耗、不结算——不降想头、不降天花板、不算被提到
 */
import { now } from '../db.js'

export const WANT_LINE = 0.5        // 待联想门槛
export const SURFACE_DROP = 0.4     // 浮现后想头掉多少
export const WEEK_FLOOR = 0.98      // 天花板每周乘这个
export const RANDOM_P = 0.08        // 每小时掷骰概率
export const RANDOM_COOLDOWN_H = 3  // 一次随机之后冷却几小时
export const RANDOM_MIN_AGE_D = 7   // 只抽多久没浮现的
export const CEILING_FLOOR = 0.42   // 天花板的下限：沉到底也得能再被提起来（浮一次连门槛都够不到就成死的了）
export const RANDOM_MAX_PER_DAY = 1 // 随机联想一天最多几次（8%/小时理论上一小时能掷，但一天顶多一次才像人）
export const SINK_AFTER_DAYS = 90   // 沉这么久没被想起，就从「台面」挪到「沉底」，不再每轮推进

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const hoursBetween = (a, b) => Math.max(0, (b - a) / 3600000)

/** 这件事的重量和「过没过」：都用冷库那条的（找不到就按 0.5 / 空）。 */
function infoOf(db, row) {
  try {
    const c = db.prepare("SELECT weight, status FROM cold_events WHERE id = json_extract(?, '$[0]')").get(row.source_cold_ids)
    return {
      weight: c ? num(c.weight, 0.5) : 0.5,
      status: c ? String(c.status || '') : '',
    }
  } catch { return { weight: 0.5, status: '' } }
}

/**
 * 完成了的事，涨得慢——但**还能浮**。
 *
 * 2026-11-12 改：原来这里把「完成」当成「不再浮」，错了。
 * 人做完一件事，当然还能被提起、还能想起来，只是不再老惦记。
 * 主人一句话定的：**放下的待遇 = 完成**。所以不另立「放下」状态，
 * 一件事放下了就是它「过去了」，按同一档走——涨得慢，不是封死。
 */
const DONE_SLOW = 0.5   // 过去了的事，涨速乘这个

/**
 * 把想头推进到 nowMs。
 * @param {object} opt
 *   - mentionBoost：这次要额外加速的事件 id 集合（刚被提到过的）
 *   - gapBoost：这件事是否正对着此刻缺的东西（bool）
 * @returns {{ ticked:number, crossed:Array }}
 */
export function tickWant(db, aid, { nowMs = Date.now(), gapBoost = false } = {}) {
  let rows = []
  try {
    rows = db.prepare("SELECT id, want, ceiling, source_cold_ids, last_surface_at, ticked_at, created_at FROM hot_events WHERE agent_id=? AND active=1 AND state IN ('台面','待联想')").all(aid)
  } catch { return { ticked: 0, crossed: [] } }

  const upd = db.prepare('UPDATE hot_events SET want=?, ceiling=?, ticked_at=?, changed_at=?, state=? WHERE id=?')
  const iso = new Date(nowMs).toISOString()
  let ticked = 0
  const crossed = []

  for (const r of rows) {
    const info = infoOf(db, r)
    const w = info.weight
    // 第一次推进：从它出生那一刻算起（没有 ticked_at，也没有浮现过）
    const last = r.ticked_at ? Date.parse(r.ticked_at)
      : (r.last_surface_at ? Date.parse(r.last_surface_at)
        : (r.created_at ? Date.parse(r.created_at) : nowMs - 3600000))
    const dt = hoursBetween(last, nowMs)
    if (dt <= 0) continue

    // 天花板：没人提就按周往下沉
    let ceiling = num(r.ceiling, 1)
    const weeks = dt / (24 * 7)
    if (weeks > 0) ceiling *= Math.pow(WEEK_FLOOR, weeks)

    // 想头：按速率涨。过去了的事涨得慢——不是不涨，是不再老惦记（能浮，只是少）。
    let r0 = 0.06 * (0.5 + w)
    if (info.status === '过去了') r0 *= DONE_SLOW
    const sinceSurface = r.last_surface_at ? hoursBetween(Date.parse(r.last_surface_at), nowMs) : 999
    if (sinceSurface < 0.5) r0 *= 1.2          // 被提到后 30 分钟内
    if (gapBoost) r0 *= 1.5
    const want = Math.min(ceiling, num(r.want, 0.25) + r0 * dt)

    const state = want >= WANT_LINE ? '待联想' : '台面'
    upd.run(want, ceiling, iso, iso, state, r.id)
    ticked++
    if (want >= WANT_LINE) crossed.push({ id: r.id, want, ceiling })
  }
  return { ticked, crossed }
}

/** 一件事被浮现了：想头掉一截，天花板收一点。 */
export function markSurfaced(db, id, { nowMs = Date.now(), kind = 'cue' } = {}) {
  const iso = new Date(nowMs).toISOString()
  try {
    const r = db.prepare('SELECT want, ceiling, source_cold_ids FROM hot_events WHERE id=?').get(id)
    if (!r) return null
    const w = infoOf(db, r).weight
    const want = Math.max(0, num(r.want, 0.25) - SURFACE_DROP)
    // 天花板有下限：沉不代表死。没有下限的话浮几次就永远够不到门槛，那件事就再也想不起来了。
    const ceiling = Math.max(CEILING_FLOOR, num(r.ceiling, 1) * (0.6 + 0.35 * w))
    db.prepare('UPDATE hot_events SET want=?, ceiling=?, last_surface_at=?, ticked_at=?, state=?, changed_at=? WHERE id=?')
      .run(want, ceiling, iso, iso, '台面', iso, id)
    return { id, want, ceiling, kind }
  } catch { return null }
}

/**
 * 被提到一次：**只记一笔，不抬天花板**。
 *
 * 这里改过一次方向，原因是主人一句话点破的：「提一次，水位不该落吗？」
 * 对——一件事刚被聊过，短期应该是「说过了，饱了」，想头往下走；
 * 只有「被反复提起说明它要紧」这一层，长期才让它不那么容易沉底。
 *
 * 所以现在的分工：
 *   - 想头往下掉：在 markSurfaced 里（-0.4）
 *   - 涨得稍快（30 分钟内 ×1.2）：在 tickWant 里，靠 last_mention_at 判
 *   - 天花板：**只由浮现次数往下削**，不再因为「被提到」往上托
 *
 * 原来那版「被提到 +0.05 天花板」是反的：说过了反而更能再浮，越聊越黏，会滚雪球。
 *
 * 防刷屏照旧留两条（30 分钟窗口、每天最多 3 次）——它们现在只影响「记不记这一笔」，
 * 也就是只影响那 1.2 倍速的判定，不再影响天花板。
 */
export function markMentioned(db, id, { nowMs = Date.now(), windowMin = 30, dailyCap = 3 } = {}) {
  const iso = new Date(nowMs).toISOString()
  try {
    const r = db.prepare('SELECT ceiling, mentions, last_mention_at, agent_id FROM hot_events WHERE id=?').get(id)
    if (!r) return null
    // ① 30 分钟窗口内只算一次
    if (r.last_mention_at) {
      const since = (nowMs - Date.parse(r.last_mention_at)) / 60000
      if (Number.isFinite(since) && since < windowMin) return { id, skipped: 'window', sinceMin: Math.round(since) }
    }
    // ② 当天次数（查 events 里今天记过的 mention）
    try {
      const dayStart = new Date(nowMs)
      dayStart.setHours(0, 0, 0, 0)
      const t = db.prepare(`SELECT COUNT(*) n FROM events
        WHERE agent_id=? AND type='event.mention' AND created_at>=?
          AND json_extract(payload,'$.id')=?`).get(r.agent_id, dayStart.toISOString(), id)
      if (Number(t && t.n) >= dailyCap) return { id, skipped: 'daily-cap', today: Number(t.n) }
    } catch { /* 查不到就按没超算 */ }

    db.prepare('UPDATE hot_events SET mentions=?, last_mention_at=?, changed_at=? WHERE id=?')
      .run(num(r.mentions, 0) + 1, iso, iso, id)
    try {
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
        'evt_' + Math.random().toString(36).slice(2, 12), r.agent_id, 'event.mention', JSON.stringify({ id }), iso,
      )
    } catch { /* 记账失败不影响 */ }
    return { id, mentions: num(r.mentions, 0) + 1, ceiling: num(r.ceiling, 1) }
  } catch { return null }
}

/**
 * 沉底：很久没被想起、天花板也一直贴着下限的那些，从「台面」挪到「沉底」。
 * 不删、不丢——它还在，只是不再每轮推进、不占台面。要真想它，从冷库重新长一条。
 */
export function archiveSunk(db, aid, { nowMs = Date.now(), days = SINK_AFTER_DAYS } = {}) {
  const iso = new Date(nowMs).toISOString()
  const cutoff = new Date(nowMs - days * 86400000).toISOString()
  try {
    const r = db.prepare(`UPDATE hot_events SET state='沉底', changed_at=?
      WHERE agent_id=? AND active=1 AND state IN ('台面','待联想')
        AND ceiling <= ? AND (last_surface_at IS NULL OR last_surface_at < ?)`)
      .run(iso, aid, CEILING_FLOOR, cutoff)
    return { sunk: Number(r.changes) || 0 }
  } catch { return { sunk: 0 } }
}

/**
 * 随机联想：这一刻有没有「没来由忽然想起」一件。
 * 不消耗、不结算——所以它不调 markSurfaced，只记 last_surface_at 用来算冷却。
 * @param {function} rng 0..1 的随机数函数（可注入，方便复现）
 */
export function randomDrift(db, aid, { nowMs = Date.now(), rng = Math.random } = {}) {
  let rows = []
  try {
    rows = db.prepare("SELECT id, title, want, last_surface_at, created_at FROM hot_events WHERE agent_id=? AND active=1 AND state IN ('台面','待联想')").all(aid)
  } catch { return { ok: false, reason: 'no-table' } }
  if (!rows.length) return { ok: true, picked: null, reason: 'empty' }

  // 冷却：最近 3 小时已经随机过一次就不掷
  let lastRandom = 0
  try {
    const lr = db.prepare("SELECT MAX(at) t FROM events WHERE agent_id=? AND type='event.random_surface'").get(aid)
    if (lr && lr.t) lastRandom = Date.parse(lr.t)
  } catch { /* 没记录就视为没冷却 */ }
  if (lastRandom && hoursBetween(lastRandom, nowMs) < RANDOM_COOLDOWN_H) {
    return { ok: true, picked: null, reason: 'cooldown', coolLeftH: RANDOM_COOLDOWN_H - hoursBetween(lastRandom, nowMs) }
  }

  // 一天最多 RANDOM_MAX_PER_DAY 次：8%/小时的骰子单看没问题，一天能中好几次，那就不是「忽然想起」了
  try {
    const dayStart = new Date(nowMs)
    dayStart.setHours(0, 0, 0, 0)
    const t = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='event.random_surface' AND created_at>=?").get(aid, dayStart.toISOString())
    if (Number(t && t.n) >= RANDOM_MAX_PER_DAY) return { ok: true, picked: null, reason: 'daily-cap' }
  } catch { /* 算不出来就照常掷 */ }

  if (rng() >= RANDOM_P) return { ok: true, picked: null, reason: 'dice' }

  // 候选：7 天以上没浮现过（从没浮现过按 created_at 算）
  const cands = []
  for (const r of rows) {
    const base = r.last_surface_at ? Date.parse(r.last_surface_at) : Date.parse(r.created_at || '')
    const days = hoursBetween(base, nowMs) / 24
    if (days < RANDOM_MIN_AGE_D) continue
    cands.push({ ...r, days, weightP: 1 / (1 + days) })
  }
  if (!cands.length) return { ok: true, picked: null, reason: 'no-candidate' }

  // 概率 ∝ 1/(1+天数)
  const total = cands.reduce((s, c) => s + c.weightP, 0)
  let x = rng() * total
  let pick = cands[cands.length - 1]
  for (const c of cands) { x -= c.weightP; if (x <= 0) { pick = c; break } }

  const iso = new Date(nowMs).toISOString()
  try {
    db.prepare('UPDATE hot_events SET last_surface_at=?, changed_at=? WHERE id=?').run(iso, iso, pick.id)
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
      'evt_' + Math.random().toString(36).slice(2, 12), aid, 'event.random_surface',
      JSON.stringify({ id: pick.id, title: pick.title, days: Math.round(pick.days) }), iso,
    )
  } catch { /* 记不上也照样返回，别让日志挡住联想 */ }
  return { ok: true, picked: { id: pick.id, title: pick.title, days: Math.round(pick.days) }, reason: 'picked', at: now() }
}
