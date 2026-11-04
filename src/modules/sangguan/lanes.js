/**
 * 三列的生长：世界观在夜巡批量归纳，人生观按周成章。
 *
 * 为什么不在快环做：快环只看得到一小段对话，看不出「同一件事在三个场景里都这样」；
 * 而且每轮跑三套抽取既贵又吵。夜巡一周看一次，场景计数、复用向量、控制成本都容易。
 *
 * 开关：sangguan.lanes.W / L，默认关；关掉时这里一步都不跑，行为与改造前一致。
 */
import { laneOn } from './config.js'
import { append, newId } from './ledger.js'
import { hasJob } from './events.js'
import { call } from './llm.js'
import { laneCheck } from './gates.js'
import { loadState } from './projection.js'
import { theta } from './fold.js'
import { isoWeek } from './budget.js'

const DAY = 86400000
const jobKey = (day, lane) => 'sg:lane' + lane + ':' + day
const dayOf = (now, opt) => String(opt.day || now).slice(0, 10)

/** 一周的材料：经历摘要 + 落空的预料。都只读。 */
export function weekBag(db, aid, now) {
  const from = new Date(Date.parse(now) - 7 * DAY).toISOString()
  let episodes = []
  try {
    episodes = db.prepare(
      'SELECT id, day, title, summary, topics FROM episodes WHERE agent_id=? AND day>=? ORDER BY day DESC LIMIT 20',
    ).all(aid, from.slice(0, 10)).reverse()
  } catch { episodes = [] }
  let misses = []
  try {
    misses = db.prepare(`
      SELECT p.expect, p.observe FROM claim_predictions p
      JOIN claim_proj_nu n ON n.id=p.id AND n.agent_id=p.agent_id
      WHERE p.agent_id=? AND n.outcome='miss' ORDER BY n.last_seq DESC LIMIT 10
    `).all(aid)
  } catch { misses = [] }
  return { episodes: episodes.map((e) => ({ id: e.id, day: e.day, title: e.title, summary: e.summary })), misses }
}

function cleanScene(list) {
  return (Array.isArray(list) ? list : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
}

/** 一条候选 → 账本里的一笔。拒收也记账（reason 可回查）。 */
function writeCandidate(db, aid, now, c, opts) {
  const meta = {
    scene: cleanScene(c.scene),
    expectation: c.expectation ? String(c.expectation).trim().slice(0, 200) : null,
    observe: c.observe ? String(c.observe).trim().slice(0, 200) : null,
    falsifier: c.falsifier ? String(c.falsifier).trim().slice(0, 200) : null,
    lane_phase: 'W-nightly',
  }
  const x = { layer: 'W', kind: c.kind || 'belt', text: String(c.belief || '').trim(), boundary: [], meta }
  const reason = laneCheck(x, { W: true })
  if (reason) {
    append(db, aid, [{
      type: 'REJECT', actor: 'sys', at: now,
      gate_report: { w: 'W1', reason, lane: 'W' },
      payload: { text: x.text.slice(0, 300), layer: 'W', kind: x.kind },
    }])
    return { ok: false, reason }
  }
  const id = newId('claims', now)
  const events = [{
    type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: now,
    gate_report: { w: 'W5', lane: 'W' },
    payload: {
      claims: [{ id, layer: 'W', kind: x.kind, text: x.text, origin: 'extract', boundary: [], meta }],
      q_hint: null,
    },
  }]
  if (meta.expectation) {
    const s = loadState(db, aid)
    const days = Math.max(1, Math.min(30, Math.round(theta(s, 'T_nu'))))
    events.push({
      type: 'NU_REGISTER', actor: 'sys', at: now,
      payload: { nus: [{ claim_id: id, expect: meta.expectation, observe: meta.observe || '观察', p: 0.6, due_at: new Date(Date.parse(now) + days * DAY).toISOString() }] },
    })
  }
  append(db, aid, events)
  return { ok: true, id }
}

/**
 * 世界观：一周跑一次，从经历里归纳「世界是怎样的」，每条必须带可检验预期。
 * opt.ask 可注入（测试用）；默认走 J30。
 */
export async function runLaneW(db, aid, now, opt = {}) {
  if (!laneOn(db, aid, 'W')) return { skipped: 'off' }
  const day = dayOf(now, opt)
  if (opt.job !== false && hasJob(db, aid, jobKey(day, 'W'))) return { skipped: 'dup' }
  const bag = weekBag(db, aid, now)
  if (!bag.episodes.length) return { skipped: 'no_material' }
  const ask = opt.ask || ((input) => call({ db, aid, day, at: now }, 'J30', input))
  const r = await ask(bag)
  if (!r || !r.ok) return { skipped: r && r.code === 'BUDGET' ? 'budget' : 'model' }
  const cands = (r.out && r.out.candidates) || []
  const did = []
  const rejected = []
  const seen = new Set()
  for (const c of cands) {
    const t = String((c && c.belief) || '').trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    try {
      const w = writeCandidate(db, aid, now, c, opt)
      if (w.ok) did.push(w.id)
      else rejected.push({ text: t.slice(0, 60), reason: w.reason })
    } catch (e) {
      rejected.push({ text: t.slice(0, 60), reason: (e && e.code) || 'ERROR' })
    }
  }
  if (opt.job !== false) {
    try {
      append(db, aid, [{ type: 'JOB_DONE', actor: 'sys', at: now, job_key: jobKey(day, 'W'), payload: { lane: 'W', did: did.length, rejected: rejected.length } }])
    } catch { /* 幂等键已存在：说明别人先跑完了 */ }
  }
  return { did, rejected, scanned: bag.episodes.length }
}

// ---------- 人生观：每周成章 ----------

/**
 * 投入证据：她实际把日子花在哪。
 * 只认「那天真的在对话里有若干回合」这件事本身，不认模型说她投入了什么。
 * 取不到就返回空表——空表会让 L 的门直接关掉，这是有意的（没有证据就不是人生观）。
 */
export function investOf(db, aid, now, days = 30) {
  const from = new Date(Date.parse(now) - days * DAY).toISOString().slice(0, 10)
  let rows = []
  try {
    rows = db.prepare(`
      SELECT day, COUNT(*) n FROM raw_turns
      WHERE agent_id=? AND day>=? AND role IN ('assistant','agent')
      GROUP BY day HAVING n>=5 ORDER BY day
    `).all(aid, from)
  } catch { rows = [] }
  return rows.map((r) => ({ ref: 'turns:' + r.day, kind: 'invest', at: r.day + 'T12:00:00.000Z' }))
}

/** 这一周的日记与以前写过的章节。 */
export function weekTexts(db, aid, now) {
  const from = new Date(Date.parse(now) - 7 * DAY).toISOString().slice(0, 10)
  let diaries = []
  try { diaries = db.prepare('SELECT day, text FROM diaries WHERE agent_id=? AND day>=? ORDER BY day').all(aid, from) } catch { diaries = [] }
  let chapters = []
  try { chapters = db.prepare("SELECT text FROM claim_summaries WHERE agent_id=? AND layer='L' ORDER BY built_at DESC LIMIT 3").all(aid) } catch { chapters = [] }
  return { diaries: diaries.map((d) => ({ day: d.day, text: String(d.text || '').slice(0, 600) })), chapters: chapters.map((c) => String(c.text || '').slice(0, 200)) }
}

/** 人生观：每周跑一次。没有投入证据时不写，只留一条跳过原因。 */
export async function runLaneL(db, aid, now, opt = {}) {
  if (!laneOn(db, aid, 'L')) return { skipped: 'off' }
  const day = dayOf(now, opt)
  const key = 'sg:laneL:' + isoWeek(day)
  if (opt.job !== false && hasJob(db, aid, key)) return { skipped: 'dup' }
  const texts = weekTexts(db, aid, now)
  const investment = investOf(db, aid, now)
  if (!texts.diaries.length) return { skipped: 'no_material' }
  const ask = opt.ask || ((input) => call({ db, aid, day, at: now }, 'J31', input))
  const r = await ask({ ...texts, investment })
  if (!r || !r.ok) return { skipped: r && r.code === 'BUDGET' ? 'budget' : 'model' }
  const cands = (r.out && r.out.candidates) || []
  const did = []
  const rejected = []
  const seen = new Set()
  for (const c of cands) {
    const t = String((c && c.self) || '').trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    const meta = {
      direction: c.direction ? String(c.direction).trim().slice(0, 60) : null,
      scene: cleanScene(c.scene),
      investment: investment.slice(-12),
      lane_phase: 'L-weekly',
    }
    const x = { layer: 'L', kind: 'chapter', text: t, boundary: [], meta }
    const reason = laneCheck(x, { L: true })
    if (reason) {
      append(db, aid, [{
        type: 'REJECT', actor: 'sys', at: now,
        gate_report: { w: 'W1', reason, lane: 'L' },
        payload: { text: t.slice(0, 300), layer: 'L', kind: 'chapter' },
      }])
      rejected.push({ text: t.slice(0, 60), reason })
      continue
    }
    try {
      const id = newId('claims', now)
      append(db, aid, [{
        type: 'CLAIM_EXP', layer: 'L', actor: 'sys', at: now,
        gate_report: { w: 'W5', lane: 'L' },
        payload: { claims: [{ id, layer: 'L', kind: 'chapter', text: t, origin: 'extract', boundary: [], meta }], q_hint: null },
      }])
      did.push(id)
    } catch (e) {
      rejected.push({ text: t.slice(0, 60), reason: (e && e.code) || 'ERROR' })
    }
  }
  if (opt.job !== false) {
    try {
      append(db, aid, [{ type: 'JOB_DONE', actor: 'sys', at: now, job_key: key, payload: { lane: 'L', did: did.length, rejected: rejected.length } }])
    } catch { /* 幂等键已存在 */ }
  }
  return { did, rejected, invest: investment.length }
}
