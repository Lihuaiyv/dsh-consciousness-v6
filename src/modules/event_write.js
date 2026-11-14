/**
 * 切事写入器：把「切出来的一件事」直接写进事件库（冷库 + 热库 born）。
 *
 * 2026-11-13：补上「切→导→热」缺的那一环。
 * 以前 splitDay 只吐 JSON 文件；导入要另跑脚本、还得手加 --hot，格式还差一层。
 * 这里让插件自己走完：splitDay（dry）→ 校验 → 冷库 → 热库初版，幂等。
 *
 * 规矩（照 docs/计划-记忆统一-v2 §2.1）：
 *   - 冷库只追加：同一个稳定 id 已存在就跳过，不覆盖
 *   - 入库前再校验：quotes 必须原文子串、turn_ids 必须存在，不合格整条不进
 *   - 抓手硬门：2~6 个、每个 2~8 字、至少一个像专名（≥3 字或含字母数字），不合格拒收
 *   - 热库初版：op=born、来源=一条冷库 id、想头按 w 给起点（与旧导入器一致）
 */
import crypto from 'node:crypto'
import { now, localDay } from '../db.js'
import { nid, getFlag, setFlag } from '../kernel.js'
import { splitDay, splitDayBatch } from './event_split.js'

const CUE_MIN = 2
const CUE_MAX = 6

/** 抓手硬门。返回 { ok, cues, reasons }。 */
export function cueGate(cues) {
  const list = [...new Set(
    (Array.isArray(cues) ? cues : [])
      .map((x) => String(x == null ? '' : x).trim())
      .filter((x) => x && Array.from(x).length >= 2 && Array.from(x).length <= 12),
  )]
  const reasons = []
  if (list.length < CUE_MIN) reasons.push('cues<2')
  const nameLike = list.some((c) => Array.from(c).length >= 3 || /[A-Za-z0-9]/.test(c))
  if (list.length && !nameLike) reasons.push('no-name-like')
  return { ok: reasons.length === 0, cues: list.slice(0, CUE_MAX), reasons }
}

function stableId(aid, ev, turns) {
  return 'cev_' + crypto.createHash('sha1')
    .update([aid, ev.title, String(ev.started_at || ''), turns[0], turns[turns.length - 1]].join('\u0001'))
    .digest('hex').slice(0, 20)
}

/** 某天某 agent 最新一条碎片的时间（没有则空串）。 */
export function latestFragmentAt(db, aid, day) {
  try {
    const r = db.prepare('SELECT MAX(created_at) mx FROM fragments WHERE agent_id=? AND day=?').get(aid, day)
    return r && r.mx ? String(r.mx) : ''
  } catch { return '' }
}

/**
 * 给一天盖章。2026-11-14（D39）：done 必须带指纹（doneAt = 盖章时切到的最晚碎片时间），
 * 否则「当天还没结束就先切一次」会把后面的话永久判成已切。
 * 同时写三处键：`<day>.state`、`<day>.<aid>.state`、`<day>.<aid>`——worker 与旧闸各读各的，别再打架。
 */
export function stampDayCut(db, aid, day, state) {
  const stamp = latestFragmentAt(db, aid, day)
  try { setFlag(db, `events.cut.${day}.state`, state) } catch { /* 记账失败不挡这一轮 */ }
  try { setFlag(db, `events.cut.${day}.${aid}.state`, state) } catch { /* 同上 */ }
  if (state === 'done') {
    try { setFlag(db, `events.cut.${day}.doneAt`, stamp || now()) } catch { /* 同上 */ }
    try { setFlag(db, `events.cut.${day}.${aid}`, 'done') } catch { /* 同上 */ }
  }
  return stamp
}

/** 某天冷库事件已经覆盖到的最晚结束时间（用来判断「回填其实已经切到尾了」）。 */
export function coldCoveredUntil(db, aid, day) {
  try {
    const r = db.prepare("SELECT MAX(end_at) mx FROM cold_events WHERE agent_id=? AND start_at >= ? AND start_at < ?")
      .get(aid, day + 'T00:00:00', day + 'T23:59:59.999Z')
    return r && r.mx ? String(r.mx) : ''
  } catch { return '' }
}

/**
 * 这一天现在还该不该切。返回 { cut, reason, latest, doneAt }。
 *   - done 但没指纹（老闸）→ legacy-done：不批量重切（避免历史重复），但要报出来、补指纹；
 *   - 指纹之后又来了新碎片 → new-fragments：要续切；
 *   - 切完且没有新碎片 → up-to-date：跳过。
 */
export function dayCutGate(db, aid, day) {
  const state = String(getFlag(db, `events.cut.${day}.${aid}.state`) || getFlag(db, `events.cut.${day}.state`) || '')
  const agtDone = String(getFlag(db, `events.cut.${day}.${aid}`) || '') === 'done'
  const doneAt = String(getFlag(db, `events.cut.${day}.doneAt`) || '')
  const pos = String(getFlag(db, `events.cut.${day}.pos`) || '')
  const latest = latestFragmentAt(db, aid, day)
  if (!latest) return { cut: false, reason: 'no-fragments', latest, doneAt }
  if (state === 'done') {
    if (!doneAt) return { cut: false, reason: 'legacy-done', latest, doneAt, backfillGap: true }
    if (latest > doneAt) return { cut: true, reason: 'new-fragments', latest, doneAt }
    return { cut: false, reason: 'up-to-date', latest, doneAt }
  }
  // 回填盖的章（有 agt=done、但没有断点 pos）不重切，只补指纹——否则会把整天的切事再跑一遍。
  if (agtDone && !pos) return { cut: false, reason: 'legacy-done', latest, doneAt, backfillGap: true }
  // 有 pos、但冷库已经覆盖到最新碎片（回填后来补过）：也算切完，只补指纹，不重切。
  if (agtDone && pos) {
    const covered = coldCoveredUntil(db, aid, day)
    if (covered && covered >= latest) return { cut: false, reason: 'covered-by-events', latest, doneAt, backfillGap: true }
  }
  // 有 pos 的（切到一半断了）要继续，哪怕 agt=done 也作废：那就是「太早盖章」本身。
  return { cut: true, reason: 'not-done', latest, doneAt }
}

/**
 * 写一批事件。调用方已经切好（events 是 clean 后的对象数组）。
 * @returns {{added:number, skipped:number, rejected:number, hotAdded:number, rejects:Array, ids:string[]}}
 */
export function writeColdEvents(db, aid, events, { dry = false } = {}) {
  const out = { added: 0, skipped: 0, rejected: 0, hotAdded: 0, rejects: [], ids: [] }
  const allText = db.prepare('SELECT text FROM fragments WHERE agent_id=?').all(aid)
    .map((r) => String(r.text || '')).join('\n')
  const turnStmt = db.prepare('SELECT 1 ok FROM fragments WHERE turn_id=? LIMIT 1')
  const timeStmt = db.prepare('SELECT created_at FROM fragments WHERE agent_id=? AND turn_id=? ORDER BY created_at LIMIT 1')
  const coldStmt = db.prepare('SELECT 1 ok FROM cold_events WHERE id=?')
  const hotStmt = db.prepare("SELECT 1 ok FROM hot_events WHERE source_cold_ids LIKE ? LIMIT 1")
  const stamp = now()

  for (const ev of events || []) {
    if (!ev || !ev.title) { out.rejected++; out.rejects.push({ title: '', reason: 'no-title' }); continue }
    const quotes = (Array.isArray(ev.quotes) ? ev.quotes : []).filter((q) => q && allText.includes(String(q)))
    const turns = (Array.isArray(ev.turn_ids) ? ev.turn_ids : []).filter((id) => { try { return !!turnStmt.get(String(id)) } catch { return false } })
    if (!quotes.length || !turns.length) {
      out.rejected++
      out.rejects.push({ title: String(ev.title).slice(0, 40), reason: 'evidence', quotes: (ev.quotes || []).length - quotes.length, turns: (ev.turn_ids || []).length - turns.length })
      continue
    }
    const g = cueGate(ev.cues)
    if (!g.ok) {
      out.rejected++
      out.rejects.push({ title: String(ev.title).slice(0, 40), reason: 'cues:' + g.reasons.join('+') })
      continue
    }
    // A2 时间门：模型写的时间不可信，用 turn_ids 的真实碎片时间兜底。
    let startedAt = String(ev.started_at || '')
    let endedAt = String(ev.ended_at || '')
    const times = turns.map((tid) => {
      try { const r = timeStmt.get(aid, String(tid)); return r ? Date.parse(r.created_at) : NaN } catch { return NaN }
    }).filter(Number.isFinite)
    if (times.length) {
      const lo = Math.min(...times), hi = Math.max(...times)
      const t0 = Date.parse(startedAt), t1 = Date.parse(endedAt)
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 < lo - 3600e3 || t1 > hi + 3600e3) {
        startedAt = new Date(lo).toISOString()
        endedAt = new Date(hi).toISOString()
      }
    }
    // 幂等 id 不吃模型时间：用兜底后的时间算，重切/模型乱写日期不会长新行。
    const id = stableId(aid, { ...ev, started_at: startedAt, ended_at: endedAt }, turns)
    if (coldStmt.get(id)) { out.skipped++; out.ids.push(id); continue }
    if (!dry) {
      db.prepare(`INSERT INTO cold_events(id,agent_id,title,story,who,start_at,end_at,turn_ids,quotes,cues,status,weight,quality,cut_rev,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, aid, String(ev.title || '').slice(0, 60), String(ev.story || ''),
        String(ev.who || ''), startedAt, endedAt,
        JSON.stringify(turns), JSON.stringify(quotes), JSON.stringify(g.cues),
        String(ev.status || ''), Number(ev.weight) || 0.5, String(ev.quality || 'model'), 1, stamp,
      )
    }
    out.added++
    out.ids.push(id)

    if (!hotStmt.get('%' + id + '%')) {
      const w = Number(ev.weight) || 0.5
      const want = Math.min(0.35, 0.2 + 0.1 * w)
      if (!dry) {
        db.prepare(`INSERT INTO hot_events(id,agent_id,title,story,cues,source_cold_ids,op,reason,version,active,state,want,ceiling,mentions,quality,created_at,changed_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          nid('hev_'), aid, String(ev.title || '').slice(0, 60), String(ev.story || ''),
          JSON.stringify(g.cues), JSON.stringify([id]), 'born', '夜里第一刀切出来', 1, 1, '台面',
          want, 1.0, 0, String(ev.quality || 'model'), stamp, stamp,
        )
      }
      out.hotAdded++
    }
  }
  return out
}

/**
 * 切一天 + 直接入库（不走 JSON 文件）。dry=true 只切不写。
 * complete 可注入（测试用假模型）；不传就走宿主模型。
 */
export async function cutAndIngest(db, aid, day, { complete = null, dry = false } = {}) {
  const split = await splitDay(db, aid, day, { dry: true, complete })
  if (!split.ok) return { ok: false, day, reason: split.reason || 'split-failed' }
  const events = []
  for (const r of split.results || []) for (const ev of r.events || []) events.push(ev)
  const write = dry ? { dry: true, would: events.length } : writeColdEvents(db, aid, events)
  return {
    ok: true,
    day,
    split: { rows: split.rows, clean: split.clean, segments: split.segments, events: split.events },
    write,
  }
}

/**
 * 批量切一天 + 每块落库 + 断点续切 + 每日硬顶（B2）。
 *
 * 和 cutAndIngest 的区别：
 *   - cutAndIngest：整天空等 splitDay 跑完才写一次——中途断了全丢（11-12 的教训）；
 *   - cutDayBatch：每切完一块就写库、存进度；断了下次从断点续，不重付前面的钱。
 *   - 次数硬顶：flags `events.cut.<day>.calls` 累加，到 maxCalls 就停（默认 15）。
 *   - 状态：flags `events.cut.<day>.state` = done / pending / capped。
 */
export async function cutDayBatch(db, aid, day, { complete = null, dry = false, lockTtlMs = 10 * 60000 } = {}) {
  // 2026-11-13：同一天只能有一个切事在跑。
  // 教训：worker 启动跳和手动 API 同时切 10-27，冷库多出一条重复（「抽 dsh.js 宿主适配层」×2）。
  // 锁用 flags 存时间戳；进程死了 10 分钟后自动过期，不锁死。
  const lockFlag = `events.cut.${day}.lock`
  const heldAt = Number(getFlag(db, lockFlag) || 0)
  if (heldAt && Date.now() - heldAt < lockTtlMs) {
    return { ok: false, day, reason: 'locked', heldAt }
  }
  try { setFlag(db, lockFlag, String(Date.now())) } catch { /* 拿不到锁就继续，靠幂等兜 */ }
  try {
    const capFlag = `events.cut.${day}.calls`
    const used = Number(getFlag(db, capFlag) || 0)
    // 2026-11-13：不设次数上限。冷库要完整——切不完就断点续，不能因为「预算」把一天丢下；
    // 碎片虽然还在，但没切成事，那天在事件库里就是永久的洞。护栏只剩两道：并发锁、断点续。
    const write = { added: 0, skipped: 0, rejected: 0, hotAdded: 0, rejects: [] }
    const res = await splitDayBatch(db, aid, day, {
      complete,
      onEvents: (events) => {
        if (dry) return
        const w = writeColdEvents(db, aid, events)
        write.added += w.added
        write.skipped += w.skipped
        write.rejected += w.rejected
        write.hotAdded += w.hotAdded
        for (const r of w.rejects || []) write.rejects.push(r)
      },
    })
    const total = used + Number(res.calls || 0)
    try { setFlag(db, capFlag, String(total)) } catch { /* 记账失败不挡这一轮 */ }
    // 2026-11-14（D39）：done 带指纹；指纹之后有新碎片会被 dayCutGate 判回「要续切」
    const state = res.ok ? (res.finished ? 'done' : 'pending') : 'pending'
    stampDayCut(db, aid, day, state)
    return { ...res, write, usedCalls: total, state }
  } finally {
    try { setFlag(db, lockFlag, '0') } catch { /* 锁没释放会 10 分钟后过期 */ }
  }
}

/**
 * 回填：从昨天往回 N 天，逐天切 + 入库。
 *
 * 2026-11-13（P1b）：一次回填 7 天要跑不少模型调用，所以：
 *   - 默认跳过已切过的天（`events.cut.<day>.<aid>=done` 闸）；
 *   - 顺序逐天跑，单天失败不拖垮整批；
 *   - dry=true 只切不写，用来先看「切出来像不像」。
 * 只能在插件进程里跑（宿主注入的 llm 才可用），API 入口见 api.js 的 events/backfill。
 */
export async function backfillDays(db, aid, opt = {}) {
  const days = Math.max(1, Math.min(30, Number(opt.days) || 7))
  const out = { ok: true, days: [], totals: { days: 0, events: 0, added: 0, skipped: 0, rejected: 0, hotAdded: 0 } }
  for (let i = 1; i <= days; i++) {
    const day = localDay(new Date(Date.now() - i * 86400000))
    const key = 'events.cut.' + day + '.' + aid
    if (opt.skipMarked !== false) {
      try {
        if (String(getFlag(db, key) || '') === 'done') { out.days.push({ day, skipped: 'marked' }); continue }
      } catch { /* flag 读不到就照切 */ }
    }
    let r
    try {
      r = await cutAndIngest(db, aid, day, { complete: opt.complete || null, dry: !!opt.dry })
    } catch (e) {
      out.days.push({ day, ok: false, reason: String((e && e.message) || e).slice(0, 160) })
      continue
    }
    if (!r.ok) { out.days.push({ day, ok: false, reason: r.reason }); continue }
    const w = r.write || {}
    out.totals.days++
    out.totals.events += Number((r.split && r.split.events) || 0)
    out.totals.added += Number(w.added || 0)
    out.totals.skipped += Number(w.skipped || 0)
    out.totals.rejected += Number(w.rejected || 0)
    out.totals.hotAdded += Number(w.hotAdded || 0)
    if (!opt.dry) {
      // 0 件不算「切完」：这一天明明有干净的碎片，却一件都没切出来，多半是模型空回。
      // 2026-11-14（D39）：done 一律带指纹（切到的最晚碎片时间）；0 件只标 pending，不盖 done。
      const ev = Number((r.split && r.split.events) || 0)
      const clean = Number((r.split && r.split.clean) || 0)
      const emptyDay = clean > 0 && ev === 0
      stampDayCut(db, aid, day, emptyDay ? 'pending' : 'done')
      if (emptyDay) {
        try { setFlag(db, key, 'empty:' + clean) } catch { /* 写入幂等，闸丢了重跑也不写两遍 */ }
      }
    }
    out.days.push({ day, ok: true, events: (r.split && r.split.events) || 0, added: w.added || 0, skipped: w.skipped || 0, rejected: w.rejected || 0 })
  }
  return out
}
