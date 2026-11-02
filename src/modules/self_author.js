/**
 * 自我改写（P 通道）：她可以改自己的「样子」，但只开一条窄门。
 *
 * 为什么另起一条，而不是放进 C1/C2/C3：
 *   那三条是算法/结构/分类法，要令牌、要二十条独立证据、要影子跑 20 轮。
 *   「我说话的语气」「我最近对什么感兴趣」不是系统参数，拿那套门槛去卡，
 *   结果就是提案永远停在 draft（库里就有一条卡在 D0）。
 *
 * 这条通道只做三件事：
 *   1) 白名单：语气 / 口头禅 / 兴趣权重；别的字段一律拒绝。
 *   2) 每天最多一条，同一字段 30 天冷却，改完 7 天观察。
 *   3) 全量 before/after 落 changes（source='self-authorship'），随时能回滚。
 */
import { now } from '../db.js'
import { nid, event, err, active } from '../kernel.js'
import { setPersonaAuto } from './persona.js'
import { restorePersonaFromChange } from './selfmod.js'

const DAY = 86400000

export const AUTHOR = Object.freeze({
  perDay: 1,
  cooldownDays: 30,
  observeDays: 7,
})

/** 语气 / 口头禅：主人写的那几张卡（address / card / banned）不在里面。 */
export const AUTHOR_WHITELIST = Object.freeze([
  { path: 'style.tone', label: '语气', max: 8 },
  { path: 'style.catchphrase', label: '口头禅', max: 6 },
])

const INTEREST_RE = /^interest\.[\u4e00-\u9fffA-Za-z0-9_-]{1,16}$/

export function isInterestPath(path) {
  return INTEREST_RE.test(String(path || ''))
}

export function authorTarget(path) {
  const hit = AUTHOR_WHITELIST.find((x) => x.path === path)
  if (hit) return hit
  if (isInterestPath(path)) return { path, label: '兴趣', max: 16 }
  return null
}

function dayStart(at) {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

export function authorCountToday(db, aid, at = Date.now()) {
  try {
    return Number(db.prepare("SELECT COUNT(*) n FROM changes WHERE agent_id=? AND source='self-authorship' AND applied_at>=?")
      .get(aid, dayStart(at)).n || 0)
  } catch { return 0 }
}

/**
 * 改一处。返回 before/after 和观察截止；调用方不需要知道 persona 表长什么样。
 */
export function authorChange(db, aid, body = {}, at = Date.now()) {
  active(db, aid)
  const path = String(body.path || '').trim()
  const target = authorTarget(path)
  if (!target) err(400, 'NOT_WHITELISTED', '只能改语气、口头禅、兴趣：' + path)

  let value = body.value
  if (isInterestPath(path)) {
    value = Number(value)
    if (!Number.isFinite(value) || value < 0 || value > 1) err(400, 'INVALID_ARGUMENT', '兴趣权重要在 0~1 之间')
  } else {
    value = String(value == null ? '' : value).trim()
    if (!value) err(400, 'INVALID_ARGUMENT', '值不能为空')
    if ([...value].length > target.max) err(400, 'INVALID_ARGUMENT', path + ' 最多 ' + target.max + ' 字')
  }

  if (authorCountToday(db, aid, at) >= AUTHOR.perDay) {
    err(409, 'AUTHOR_BUDGET', '今天已经改过一次了，明天再说')
  }

  const field = 'persona.' + path
  const coolSince = new Date(at - AUTHOR.cooldownDays * DAY).toISOString()
  const cool = db.prepare("SELECT applied_at FROM changes WHERE agent_id=? AND field=? AND source='self-authorship' AND applied_at>=? ORDER BY applied_at DESC LIMIT 1")
    .get(aid, field, coolSince)
  if (cool) err(409, 'AUTHOR_COOLDOWN', '这个字段 ' + AUTHOR.cooldownDays + ' 天内改过了：' + path)

  const row = db.prepare('SELECT value FROM persona WHERE agent_id=? AND path=?').get(aid, path)
  let before = null
  if (row) { try { before = JSON.parse(row.value) } catch { before = row.value } }
  if (JSON.stringify(before) === JSON.stringify(value)) err(409, 'AUTHOR_SAME', '和现在一样，不用改')

  setPersonaAuto(db, aid, path, value, String(body.reason || '').slice(0, 200))
  const id = nid('chg_')
  const appliedAt = new Date(at).toISOString()
  const until = new Date(at + AUTHOR.observeDays * DAY).toISOString()
  db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, null, aid, field, JSON.stringify(before), JSON.stringify(value), appliedAt, 'self', 'self', 'self-authorship', null, until)
  event(db, aid, 'self.change', {
    change_id: id, path, before, after: value,
    reason: String(body.reason || '').slice(0, 300),
    evidence: body.evidence ?? null,
    observing_until: until,
  })
  return { ok: true, id, path, before, after: value, observing_until: until }
}

/** 回滚她自己改的一处：只还原 persona，不碰算法。 */
export function rollbackAuthor(db, aid, cid) {
  const ch = db.prepare('SELECT * FROM changes WHERE id=? AND agent_id=?').get(cid, aid)
  if (!ch) err(404, 'NOT_FOUND', '找不到这条改动')
  if (ch.source !== 'self-authorship') err(409, 'CONFLICT', '这不是她自己改的，走原有的回滚')
  if (ch.rolled_back_at) err(409, 'CONFLICT', '已经回滚过了')
  const ok = restorePersonaFromChange(db, ch)
  db.prepare('UPDATE changes SET rolled_back_at=? WHERE id=?').run(now(), cid)
  event(db, aid, 'self.change.rolled_back', { change_id: cid, path: ch.field })
  return { ok, id: cid, field: ch.field }
}

/** 最近 30 天她自己改了什么（自修改页那一栏）。 */
export function authorStats(db, aid, at = Date.now()) {
  const since = new Date(at - 30 * DAY).toISOString()
  let rows = []
  try {
    rows = db.prepare("SELECT * FROM changes WHERE agent_id=? AND source='self-authorship' AND applied_at>=? ORDER BY applied_at DESC")
      .all(aid, since)
  } catch { rows = [] }
  return {
    total: rows.length,
    rolled: rows.filter((r) => r.rolled_back_at).length,
    fields: [...new Set(rows.map((r) => r.field))],
    rows: rows.map((r) => ({
      id: r.id, field: r.field, before: r.before, after: r.after,
      applied_at: r.applied_at, rolled_back_at: r.rolled_back_at, observing_until: r.observing_until,
    })),
  }
}
