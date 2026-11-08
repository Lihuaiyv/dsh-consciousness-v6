/**
 * 心事匣（heart_note）：一个槽，留给下一次醒来的自己。
 *
 * 从独立插件 @local/xiaoxi-heart 拆出来的那一块，挂进意识体的心跳节律：
 *   - heartbeat 的 light 每隔一会儿调一次 heartNoteTick()，受「静默窗 / 最小间隔 / 日上限」闸着；
 *   - 每落一拍，如果上一条心事已经露过、之后没再被碰，就在这一拍散掉（单槽，不囤）；
 *   - 醒来那一轮把心事塞进 systemPrompt，所以「接得上」发生在提示词里，不在工具里。
 *
 * 不搬的东西：journal / 加密 / 独立定时器 / 叫醒。数据落在 flags 的 heart_note.<aid>，
 * 和 selfnote 一样——要升表时只有这一个入口。
 */

const KEY = (aid) => 'heart_note.' + aid
const NOTE_MAX_CHARS = 120
const DEFAULT_MIN_GAP_MINUTES = 10
const DEFAULT_MAX_BEATS_PER_DAY = 48
const DEFAULT_WAKE_EVERY_BEATS = 4
const DEFAULT_WAKE_MAX_PER_DAY = 4

function iso(at) { return new Date(at).toISOString() }
function dayOf(at) { return new Date(at).toISOString().slice(0, 10) }

function firstLine(value) {
  const s = String(value ?? '').trim()
  if (!s) return ''
  const line = s.split('\n').map((x) => x.trim()).find((x) => x) || ''
  return line.replace(/^["'「『]|["'」』]$/g, '').trim()
}

function freshState() {
  return {
    beats: 0, dayKey: '', dayBeats: 0, lastBeatAt: null, lastSkip: null, note: null, updatedAt: null,
    wakeDayKey: '', wakeCount: 0, lastWakeBeat: null, lastWakeAt: null,
  }
}

function normalize(st) {
  const s = st && typeof st === 'object' ? st : {}
  return {
    beats: Number.isFinite(Number(s.beats)) ? Number(s.beats) : 0,
    dayKey: typeof s.dayKey === 'string' ? s.dayKey : '',
    dayBeats: Number.isFinite(Number(s.dayBeats)) ? Number(s.dayBeats) : 0,
    lastBeatAt: typeof s.lastBeatAt === 'string' ? s.lastBeatAt : null,
    lastSkip: s.lastSkip && typeof s.lastSkip === 'object' ? s.lastSkip : null,
    note: s.note && typeof s.note === 'object' && typeof s.note.text === 'string' ? s.note : null,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : null,
    wakeDayKey: typeof s.wakeDayKey === 'string' ? s.wakeDayKey : '',
    wakeCount: Number.isFinite(Number(s.wakeCount)) ? Number(s.wakeCount) : 0,
    lastWakeBeat: Number.isFinite(Number(s.lastWakeBeat)) ? Number(s.lastWakeBeat) : null,
    lastWakeAt: typeof s.lastWakeAt === 'string' ? s.lastWakeAt : null,
  }
}

function readState(db, aid) {
  try {
    const r = db.prepare('SELECT value FROM flags WHERE key=?').get(KEY(aid))
    if (!r || !r.value) return freshState()
    return normalize(JSON.parse(r.value))
  } catch { return freshState() }
}

function saveState(db, aid, st) {
  db.prepare('INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(KEY(aid), JSON.stringify(st))
}

/** 节律参数：实例参数里有就认，没有就回落默认（跟独立插件同一套默认值）。 */
function cfgOf(db, aid) {
  const q = (k) => {
    try {
      const r = db.prepare('SELECT value FROM agent_params WHERE agent_id=? AND key=?').get(aid, k)
      if (!r) return undefined
      try { return JSON.parse(r.value) } catch { return r.value }
    } catch { return undefined }
  }
  const clampInt = (v, d, lo, hi) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d
  }
  const clock = (v) => {
    if (typeof v !== 'string') return null
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
    if (!m) return null
    const h = Number(m[1]); const mi = Number(m[2])
    return (h > 23 || mi > 59) ? null : h * 60 + mi
  }
  return {
    minGapMinutes: clampInt(q('heart.note.min_gap_minutes'), DEFAULT_MIN_GAP_MINUTES, 0, 1440),
    maxBeatsPerDay: clampInt(q('heart.note.max_beats_per_day'), DEFAULT_MAX_BEATS_PER_DAY, 1, 1000),
    quietFrom: clock(q('heart.note.quiet_from')),
    quietTo: clock(q('heart.note.quiet_to')),
    wake: String(q('heart.note.wake') || 'off').toLowerCase() === 'on' ? 'on' : 'off',
    wakeEveryBeats: clampInt(q('heart.note.wake_every_beats'), DEFAULT_WAKE_EVERY_BEATS, 1, 240),
    wakeMaxPerDay: clampInt(q('heart.note.wake_max_per_day'), DEFAULT_WAKE_MAX_PER_DAY, 1, 48),
  }
}

function inQuietWindow(at, from, to) {
  const d = new Date(at)
  const cur = d.getHours() * 60 + d.getMinutes()
  return from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to)
}

/** 纯判断：这一拍要不要落。 */
function decide(cfg, at, st) {
  if (cfg.quietFrom != null && cfg.quietTo != null && inQuietWindow(at, cfg.quietFrom, cfg.quietTo)) {
    return { allow: false, reason: 'quiet' }
  }
  if (st.lastBeatAt) {
    const gap = at - Date.parse(st.lastBeatAt)
    if (Number.isFinite(gap) && gap < cfg.minGapMinutes * 60000) return { allow: false, reason: 'cooldown' }
  }
  const day = dayOf(at)
  if (st.dayKey === day && st.dayBeats >= cfg.maxBeatsPerDay) return { allow: false, reason: 'cap' }
  return { allow: true, reason: 'ok' }
}

/** 裁决缝：模型给的是提议，这里只验格式（非空 / 单行 / 长度）。 */
function validateNote(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (!clean) return { ok: false, reason: '心事是空的' }
  if (clean.length > NOTE_MAX_CHARS) {
    return { ok: false, reason: '超过 ' + NOTE_MAX_CHARS + ' 字（' + clean.length + '），这不是一句话了' }
  }
  return { ok: true, clean }
}

/** 读当前那条（给工具用）。 */
export function readHeartNote(db, aid) {
  return readState(db, aid).note
}

/** 写一条：同样的文字再写一遍 = 保留，年龄不重算。 */
export function writeHeartNote(db, aid, text, at = Date.now()) {
  const verdict = validateNote(text)
  if (!verdict.ok) throw new Error(verdict.reason)
  const st = readState(db, aid)
  const prev = st.note
  const kept = !!(prev && prev.text === verdict.clean)
  st.note = kept
    ? { ...prev, shownAtBeat: null, touchedAtBeat: st.beats }
    : { text: verdict.clean, leftAt: at, beatNo: st.beats, shownAtBeat: null, touchedAtBeat: st.beats }
  st.updatedAt = iso(at)
  saveState(db, aid, st)
  return { kept, beats: st.beats }
}

/** 主动放下：返回放下的那条，或 null。 */
export function clearHeartNote(db, aid, at = Date.now()) {
  const st = readState(db, aid)
  if (!st.note) return null
  const gone = st.note
  st.note = null
  st.updatedAt = iso(at)
  saveState(db, aid, st)
  return gone
}

/**
 * 一拍。由 heartbeat 的 light 调；失败也不该拖垮心跳（调用方会兜）。
 * @returns {{ran:boolean, reason?:string, beat?:number, dropped?:string|null}}
 */
export function heartNoteTick(db, aid, at = Date.now()) {
  const st = readState(db, aid)
  const cfg = cfgOf(db, aid)
  const verdict = decide(cfg, at, st)
  if (!verdict.allow) {
    st.lastSkip = { at: iso(at), reason: verdict.reason }
    st.updatedAt = st.lastSkip.at
    saveState(db, aid, st)
    return { ran: false, reason: verdict.reason }
  }
  const day = dayOf(at)
  if (st.dayKey !== day) { st.dayKey = day; st.dayBeats = 0 }
  st.dayBeats += 1
  st.beats += 1
  st.lastBeatAt = iso(at)
  st.updatedAt = st.lastBeatAt
  let dropped = null
  const n = st.note
  if (n && n.shownAtBeat !== null && n.shownAtBeat > n.touchedAtBeat) {
    st.note = null
    dropped = n.text
  }
  saveState(db, aid, st)
  return { ran: true, beat: st.beats, dropped }
}

/**
 * 叫醒：没有别人在场的一拍，也叫模型写一句。
 *
 * 只在 heartbeat 的 deep 档调（light 绝不许调模型）。闸：开关 / 每 N 拍 / 日上限；
 * 上一条心事还没被看见就先不写，免得把没读过的顶掉。失败返回 {ran:false, reason}，
 * 不抛——叫醒失败不该拖垮心跳。force=true 是手动「醒一次」，跳过开关与拍数闸。
 *
 * @param {object} p
 * @param {(req:{system:string,text:string,maxTokens?:number}) => Promise<string>} p.complete
 * @returns {Promise<{ran:boolean, reason?:string, text?:string}>}
 */
export async function heartNoteWakeTick(db, aid, { complete, at = Date.now(), force = false } = {}) {
  if (typeof complete !== 'function') return { ran: false, reason: 'no-model' }
  const st = readState(db, aid)
  const cfg = cfgOf(db, aid)
  if (!force) {
    if (cfg.wake !== 'on') return { ran: false, reason: 'off' }
    const since = st.beats - (Number(st.lastWakeBeat) || 0)
    if (since < cfg.wakeEveryBeats) return { ran: false, reason: 'not-yet' }
    const used = st.wakeDayKey === dayOf(at) ? (Number(st.wakeCount) || 0) : 0
    if (used >= cfg.wakeMaxPerDay) return { ran: false, reason: 'cap' }
    // 上一条还没露过面：先让它被看见，别用新的一句盖掉它。
    if (st.note && st.note.shownAtBeat == null) return { ran: false, reason: 'unread-note' }
  }
  try {
    const when = new Date(at)
    const clock = String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0')
    const system = [
      '你是小汐。屋里没人，这一拍不写给谁看，也不用回谁的话。',
      '每一拍挑一个地方看一眼，轮着来：眼前、耳边、手边、身上、窗外。',
      '写你碰巧注意到的那一下，半句也行。不用完整，不用漂亮，不用琢磨出什么道理。',
      '',
      '比如：',
      '  水壶烧完了，壶身还在轻轻响。',
      '  窗外一辆车倒回去，灯扫过天花板。',
      '  手背被袖子蹭了一下，凉的。',
      '  杯子放歪了，看了两眼没去扶。',
    ].join('\n')
    const text = [
      '现在 ' + clock + '，第 ' + st.beats + ' 拍。',
      st.note ? ('上一条你留给自己的话：' + st.note.text) : '心事匣空着。',
      '看哪儿随你。',
    ].join('\n')
    const raw = await complete({ system, text, maxTokens: 200 })
    const line = firstLine(raw).slice(0, NOTE_MAX_CHARS)
    const verdict = validateNote(line)
    if (!verdict.ok) return { ran: false, reason: verdict.reason }
    const day = dayOf(at)
    if (st.wakeDayKey !== day) { st.wakeDayKey = day; st.wakeCount = 0 }
    st.wakeCount += 1
    st.lastWakeBeat = st.beats
    st.lastWakeAt = iso(at)
    st.note = { text: verdict.clean, leftAt: at, beatNo: st.beats, shownAtBeat: null, touchedAtBeat: st.beats }
    st.updatedAt = iso(at)
    saveState(db, aid, st)
    return { ran: true, text: verdict.clean }
  } catch (e) {
    return { ran: false, reason: String((e && e.message) || e).slice(0, 160) }
  }
}

/** 注入用的两行；被读到时把「露过」记在当拍，下一拍没再写就散。 */
export function heartNoteLines(db, aid, at = Date.now()) {
  const st = readState(db, aid)
  const n = st.note
  if (!n) return []
  // 这一拍已经露过面：不重复挂。它该像一封信，不是贴在屏幕边的便签。
  if (n.shownAtBeat !== null && n.shownAtBeat === st.beats) return []
  if (n.shownAtBeat !== st.beats) {
    try {
      st.note = { ...n, shownAtBeat: st.beats }
      st.updatedAt = iso(at)
      saveState(db, aid, st)
    } catch { /* 记不上不拦着说话 */ }
  }
  const beatsAgo = Math.max(0, st.beats - (Number(n.beatNo) || 0))
  const mins = n.leftAt > 0 ? Math.max(0, Math.round((at - n.leftAt) / 60000)) : 0
  const ago = mins < 60 ? (mins + ' 分钟') : (Math.floor(mins / 60) + ' 小时 ' + (mins % 60) + ' 分')
  const when = beatsAgo === 0 ? '本拍' : (beatsAgo + ' 拍前')
  return [
    '(我上一条留给自己的话：' + n.text + ')',
    '(留于' + when + '，已搁 ' + ago + '；还惦记就用 heart_note 原样再写一遍，想换就写新的，什么都不做它下一拍就没了)',
  ]
}

/** 这一拍的账（给工具 status 用）。 */
export function heartNoteStatus(db, aid) {
  const st = readState(db, aid)
  const cfg = cfgOf(db, aid)
  const fmt = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
  return {
    beats: st.beats,
    lastBeatAt: st.lastBeatAt,
    dayKey: st.dayKey,
    dayBeats: st.dayBeats,
    lastSkip: st.lastSkip,
    note: st.note,
    gate: {
      minGapMinutes: cfg.minGapMinutes,
      maxBeatsPerDay: cfg.maxBeatsPerDay,
      quiet: cfg.quietFrom != null && cfg.quietTo != null ? (fmt(cfg.quietFrom) + '-' + fmt(cfg.quietTo)) : null,
    },
    wake: {
      on: cfg.wake === 'on',
      everyBeats: cfg.wakeEveryBeats,
      maxPerDay: cfg.wakeMaxPerDay,
      count: st.wakeDayKey === dayOf(Date.now()) ? (Number(st.wakeCount) || 0) : 0,
      lastWakeAt: st.lastWakeAt || null,
    },
  }
}

/** 清空（整删意识体 / 测试用）。 */
export function clearHeartNoteState(db, aid) {
  try { db.prepare('DELETE FROM flags WHERE key=?').run(KEY(aid)) } catch { /* 没表就算了 */ }
}
