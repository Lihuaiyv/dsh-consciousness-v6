/**
 * 主动开口 · 偏好（零件内）
 *
 * 开关、每天几句、安静时段、是否推送。
 * 存在 flags 的 `proactive:<aid>` 键上——这是开口自己的键；flags 表本身是共享基础设施。
 * 这个文件不 import 别的业务零件，只碰自己的键。
 */

export const PROACTIVE_DEFAULTS = {
  enabled: true, per_day: 1, idle_hours: 6,
  quiet: true, quiet_from: '23:30', quiet_to: '07:30',
  // push：把待发那句直接推进会话（不再等你先开口）。默认关，打开才算授权。
  push: false,
}

function getFlag(db, key) {
  const r = db.prepare('SELECT value FROM flags WHERE key=?').get(key)
  return r ? r.value : null
}

function setFlag(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO flags(key,value) VALUES(?,?)').run(key, String(value))
}

export function getProactivePrefs(db, aid) {
  const raw = getFlag(db, 'proactive:' + aid)
  if (!raw) return { ...PROACTIVE_DEFAULTS }
  try { return { ...PROACTIVE_DEFAULTS, ...JSON.parse(raw) } } catch { return { ...PROACTIVE_DEFAULTS } }
}

export function setProactivePrefs(db, aid, body) {
  const cur = getProactivePrefs(db, aid)
  const hhmm = (v, d) => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim()) ? String(v).trim() : d)
  const next = {
    enabled: body.enabled === undefined ? cur.enabled : !!body.enabled,
    per_day: Math.max(0, Math.min(10, Number(body.per_day ?? cur.per_day))),
    idle_hours: Math.max(0, Math.min(720, Number(body.idle_hours ?? cur.idle_hours))),
    quiet: body.quiet === undefined ? cur.quiet : !!body.quiet,
    quiet_from: hhmm(body.quiet_from ?? cur.quiet_from, PROACTIVE_DEFAULTS.quiet_from),
    quiet_to: hhmm(body.quiet_to ?? cur.quiet_to, PROACTIVE_DEFAULTS.quiet_to),
    push: body.push === undefined ? !!cur.push : !!body.push,
  }
  setFlag(db, 'proactive:' + aid, JSON.stringify(next))
  return next
}
