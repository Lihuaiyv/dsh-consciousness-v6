/**
 * 开环（open loops）：还没闭合的事——答应过的、要提醒的、没做完的、悬着的。
 *
 * 为什么单独一张表，而不是塞进 memory_items：
 *   这类东西的价值不在「跟这句话有多相关」，而在「它还没完」。
 *   走 recall 的证据门，一句「今天天气不错」永远召不回「你答应周末陪我修那个脚本」；
 *   走时间通道，到期 / 久未提及它就自己冒出来——这就是「浮上来」和「被问才想起来」的区别。
 *
 * 三条不变量：
 *   1. 同一件事只挂一条（同 agent 下字面相近就并）；关掉之后可以再挂新的。
 *   2. 浮现有节流：同一条 6 小时内只提一次；提满 5 次还没解决就自动收掉（不再念叨）。
 *   3. 关掉要留痕：closed_by = user_done / expired / manual。
 */
import { now } from '../db.js'

/** 用户说这些，表示「这件事完了」。 */
const CLOSE_RE = /(好了|搞定|弄好了|完成|做完了|用不上了|不用了|算了|解决了|已经做了|结束了|可以了)/

/** 文本里自己带「已经完成」的，不挂开环（否则每次总结都会挂一条假待办）。 */
const DONE_RE = /(已经|完成了|搞定了|解决了|做完了|做好的|完成了的)/

/** 值得挂起来的信号。宁可漏，不要挂一堆假待办。 */
const LOOP_RE = /(答应|说好|承诺|约定|提醒我|别忘|回头|过两天|下次|改天|还没|待办|剩下|收尾|最后一步|等会|一会儿|之后|再说|留到|回头再|下周|明天|后天|周末|下周[一二三四五六日天])/

/** 「什么都会」的泛句不算：没有指向的短句不挂。 */
const VAGUE_RE = /^(好的|嗯|嗯嗯|行|可以|继续|然后呢|收到|ok)[。！!？?]*$/

/**
 * 技术陈述：提到代码 / 函数 / 接口 / 表结构，又不像「要去做点什么」。
 *
 * 开环是从记忆条目里长出来的，而记忆条目常常是第三人称的技术讨论
 * （「用户正在检查某段代码的缺陷」「BAD_TAIL 的判定范围过宽」）。
 * 以前这些会被挂成待办，然后每轮提醒我「你还挂着这件事」——那不是承诺，是噪音。
 */
const TECH_RE = /(`[^`]{1,40}`|\w+\(\)|函数|接口|变量|字段|参数|数据表|表结构|报错|异常|缺陷|bug|日志|编译|依赖|代码)/
/** 真要做一件事时才会出现的词。技术词 + 这个 = 技术待办，可以挂。 */
const INTENT_RE = /(待办|需要|还要|得先|该|记得|别忘|回头|明天|后天|下次|一会儿|帮我|请你|麻烦|先.{0,4}(改|修|跑|写|删|加|测))/

/**
 * 状态汇报体：整句在说「事情进行到哪一步」。
 *
 * 「当前任务已进入收尾阶段，待办包括重载规则兜底修复、线上终验和汇总前后数据」
 * 这句带「待办」两个字，以前被当成任务挂了起来。可它只是叙述进度，没人在给谁派活——
 * 挂上去的结果是过两天我去催主人「那个还没弄完吧」，显得又记错账又没眼力见。
 * 判据故意取窄：只有「已进入 / 已处于 / 正在进行」这类进行态，且整句没有我/你。
 */
const STATUS_RE = /(已进入|已处于|正在进行|正在收尾|正在推进)/
/** 句子里有人称，才可能是在交代谁去做。 */
const PERSON_RE = /(我|你|咱|给你|帮我|替我)/

const DAY = 86400000
const HOUR = 3600000

function stamp(at) {
  return new Date(at).toISOString()
}

function localHour(text) {
  const m = /(\d{1,2})\s*[点:：]/.exec(text)
  if (!m) return null
  const h = Number(m[1])
  if (!Number.isFinite(h) || h < 0 || h > 23) return null
  return h
}

/**
 * 从一句话里解析到期时间。解析不出来返回 null（走「久未提及」通道，不设死线）。
 * 只做保守规则：认不出就当没有 due，绝不猜。
 */
export function parseDue(text, at = Date.now()) {
  const t = String(text || '')
  if (!t) return null
  const hour = localHour(t)
  const dayStart = (d) => {
    const x = new Date(at + d * DAY)
    x.setHours(hour == null ? 9 : hour, 0, 0, 0)
    return x.getTime()
  }
  if (/大后天/.test(t)) return stamp(dayStart(3))
  if (/后天/.test(t)) return stamp(dayStart(2))
  if (/明天|明早|明晚/.test(t)) return stamp(dayStart(1))
  if (/今晚|今天/.test(t)) return stamp(at + Math.max(2, (hour == null ? 20 : hour) - new Date(at).getHours()) * HOUR)
  if (/周末|周六|周日|星期[六日天]/.test(t)) {
    const d = new Date(at)
    const w = d.getDay() // 0=周日
    const add = w === 6 ? 0 : w === 0 ? 6 : 6 - w
    const x = new Date(at + add * DAY)
    x.setHours(hour == null ? 10 : hour, 0, 0, 0)
    if (x.getTime() <= at) x.setTime(x.getTime() + 7 * DAY)
    return stamp(x.getTime())
  }
  if (/下周/.test(t)) return stamp(dayStart(7))
  if (/下个月|月底/.test(t)) return stamp(dayStart(30))
  if (/过两天|过几天|回头|下次|改天|再说|之后/.test(t)) return null
  if (/一会儿|等会|等一下/.test(t)) return stamp(at + 2 * HOUR)
  return null
}

function kindOf(text) {
  if (/答应|说好|承诺|约定/.test(text)) return 'promise'
  if (/提醒我|别忘|记着/.test(text)) return 'reminder'
  return 'task'
}

/**
 * 这句话里有没有一件「该记挂的事」。
 * @returns {{kind:string, due_at:string|null, stale_after:string}|null}
 */
export function detectLoop(text, at = Date.now()) {
  const t = String(text || '').trim()
  if (t.length < 6 || VAGUE_RE.test(t)) return null
  if (!LOOP_RE.test(t)) return null
  if (DONE_RE.test(t)) return null
  // 状态汇报不是待办：说「进入收尾阶段」的人，没在给谁派活
  if (STATUS_RE.test(t) && !PERSON_RE.test(t)) return null
  // 技术讨论不是待办：有技术词、却没有「要去做点什么」的意图
  if (TECH_RE.test(t) && !INTENT_RE.test(t)) return null
  const due = parseDue(t, at)
  // 没到期线的：两天后如果还没再被提到，就算「挂着」。到期线的：过期一天后开始提醒。
  const stale = due ? stamp(Date.parse(due) + DAY) : stamp(at + 2 * DAY)
  return { kind: kindOf(t), due_at: due, stale_after: stale }
}

function norm(text) {
  return String(text || '').replace(/[\s\p{P}]/gu, '')
}

function overlapChars(a, b) {
  const A = new Set(Array.from(norm(a)))
  const B = new Set(Array.from(norm(b)))
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const c of A) if (B.has(c)) hit++
  return hit / Math.min(A.size, B.size)
}

function rowOf(db, aid, id) {
  return db.prepare('SELECT * FROM open_loops WHERE id=? AND agent_id=?').get(id, aid) || null
}

/**
 * 挂一条开环。同一件事（字面相近）已经挂着就不重复挂，只把来源补上。
 * @returns {{id:string, created:boolean, row:object|null}}
 */
export function addLoop(db, aid, opt = {}) {
  const text = String(opt.text || '').trim()
  if (!text) return { id: null, created: false, row: null }
  const at = opt.at || Date.now()
  const open = db.prepare("SELECT * FROM open_loops WHERE agent_id=? AND state IN ('open','half_said')").all(aid)
  for (const r of open) {
    if (norm(r.text) === norm(text) || overlapChars(r.text, text) >= 0.6) {
      if (opt.memory_id && !r.memory_id) {
        db.prepare('UPDATE open_loops SET memory_id=?, updated_at=? WHERE id=?').run(opt.memory_id, stamp(at), r.id)
      }
      return { id: r.id, created: false, row: rowOf(db, aid, r.id) }
    }
  }
  const id = 'lp_' + Math.random().toString(16).slice(2, 12)
  const due = opt.due_at || null
  const stale = opt.stale_after || (due ? stamp(Date.parse(due) + DAY) : stamp(at + 2 * DAY))
  db.prepare(`INSERT INTO open_loops(id,agent_id,kind,text,memory_id,source_turn_id,due_at,stale_after,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?, 'open', ?, ?)`)
    .run(id, aid, opt.kind || 'task', text, opt.memory_id || null, opt.source_turn_id || null, due, stale, stamp(at), stamp(at))
  return { id, created: true, row: rowOf(db, aid, id) }
}

/**
 * 这一轮该浮现的开环。
 * 到期（due_at <= now）优先；没到期线的，要「至少两天没被提过」才算挂着。
 * 同一条 6 小时节流；提满 5 次自动收掉。
 */
export function pendingLoops(db, aid, opt = {}) {
  const at = opt.at || Date.now()
  const throttle = Number(opt.throttleHours == null ? 6 : opt.throttleHours) * HOUR
  const limit = Math.max(1, Math.min(5, Number(opt.limit) || 1))
  // half_said = 说过一次、还没收尾的。默认仍然取（跟改造前一样能再提醒），
  // 只有显式要「还没开口的事」时才用 onlyOpen 排掉它。
  const states = opt.onlyOpen ? "('open')" : "('open','half_said')"
  const rows = db.prepare("SELECT * FROM open_loops WHERE agent_id=? AND state IN " + states).all(aid)
  const out = []
  for (const r of rows) {
    if (Number(r.fire_count || 0) >= 5) continue
    const fired = Date.parse(r.fired_at || '')
    if (Number.isFinite(fired) && at - fired < throttle) continue
    const due = Date.parse(r.due_at || '')
    const stale = Date.parse(r.stale_after || '')
    const ready = (Number.isFinite(due) && due <= at) || (Number.isFinite(stale) && stale <= at)
    if (!ready) continue
    const rank = Number.isFinite(due) ? due : (Number.isFinite(stale) ? stale : 0)
    out.push({ ...r, rank })
  }
  // 排序：先「已到期」的后到期的，再按被提过的次数由少到多（不然两条老待办会永远占住名额，
  // 新挂的一直冒不上来），最后才比时间先后。
  const overdue = (x) => (Number.isFinite(Date.parse(x.due_at || '')) && Date.parse(x.due_at) <= at ? 0 : 1)
  // 说了一半的先说：那是「我话没说完」，比一件还没开口的事更该被接上。
  const half = (x) => (String(x.state) === 'half_said' ? 0 : 1)
  out.sort((a, b) => half(a) - half(b) || overdue(a) - overdue(b)
    || Number(a.fire_count || 0) - Number(b.fire_count || 0)
    || a.rank - b.rank
    || String(a.created_at).localeCompare(String(b.created_at)))
  return out.slice(0, limit)
}

/** 浮现记账：谁被提过、提了几次。 */
export function markLoopsFired(db, ids, at = Date.now()) {
  const list = [...new Set((ids || []).filter(Boolean))]
  if (!list.length) return 0
  // 说过一次就转 half_said：它不再是「还没说出口的事」，而是「我话没说完」。
  const up = db.prepare("UPDATE open_loops SET fired_at=?, fire_count=fire_count+1, state=CASE WHEN state='open' THEN 'half_said' ELSE state END, updated_at=? WHERE id=?")
  for (const id of list) up.run(stamp(at), stamp(at), id)
  return list.length
}

/** 关掉：user_done（用户说好了）/ expired（提满 5 次）/ manual。 */
export function closeLoops(db, aid, ids, by = 'manual', at = Date.now()) {
  const list = [...new Set((ids || []).filter(Boolean))]
  let n = 0
  const up = db.prepare("UPDATE open_loops SET state='closed', closed_at=?, closed_by=?, updated_at=? WHERE id=? AND agent_id=? AND state IN ('open','half_said')")
  for (const id of list) {
    const r = up.run(stamp(at), by, stamp(at), id, aid)
    if (r && r.changes) n++
  }
  return n
}

/**
 * 用户说「好了 / 搞定了」时，把刚刚提过的那条关掉。
 * 只认两小时内被浮现过的——否则一句随口的「好了」会把不相干的待办全关掉。
 */
export function settleLoopsFromUser(db, aid, turns = [], opt = {}) {
  const at = opt.at || Date.now()
  const done = (turns || []).filter((x) => x && x.role === 'user' && CLOSE_RE.test(String(x.text || '')))
  if (!done.length) return 0
  const rows = db.prepare("SELECT * FROM open_loops WHERE agent_id=? AND state IN ('open','half_said') ORDER BY fired_at DESC").all(aid)
  const ids = []
  for (const r of rows) {
    const fired = Date.parse(r.fired_at || '')
    if (Number.isFinite(fired) && at - fired <= 2 * HOUR) ids.push(r.id)
  }
  if (!ids.length) {
    // 没提过就关：只在用户这句话本身对上了那条开环时才关（「那个脚本我修好了」）。
    const text = done.map((x) => x.text).join(' ')
    for (const r of rows) if (overlapChars(r.text, text) >= 0.35) ids.push(r.id)
  }
  return closeLoops(db, aid, ids, 'user_done', at)
}

/** 提满 5 次还没解决：自动收掉，别念叨。 */
export function expireLoops(db, aid, at = Date.now()) {
  const rows = db.prepare("SELECT id FROM open_loops WHERE agent_id=? AND state IN ('open','half_said') AND fire_count>=5").all(aid)
  return closeLoops(db, aid, rows.map((r) => r.id), 'expired', at)
}

/**
 * 开环注入的引导语：欠账（答应过 / 提醒）抬成「最在意的其实是这件事」，
 * 其余仍是「心里还挂着的事」。纯函数，方便单测；focusOn=off 时与改前一致。
 */
export function loopPrefixOf(kinds, { focusOn = true } = {}) {
  const owed = focusOn && Array.isArray(kinds) && (kinds[0] === 'promise' || kinds[0] === 'reminder')
  return owed
    ? '（你现在最在意的其实是这件事，可以自然提起，不用解释来源）：\n'
    : '（你自己心里还挂着的事，可以自然提起，不用解释来源）：\n'
}

/** 注入用的一行。 */
export function loopLineFor(db, aid, opt = {}) {
  const at = opt.at || Date.now()
  const limit = Math.max(1, Math.min(5, Number(opt.limit) || 1))
  // 多取几条：欠账（答应过 / 提醒）要能排到第一条。只在注入侧排，
  // 不改 pendingLoops 的排序——那边还挂着主动开口，改了会连带改开口顺序。
  const rows = pendingLoops(db, aid, { at, limit: Math.max(limit, 5), throttleHours: opt.throttleHours })
  if (!rows.length) return { text: '', ids: [], kinds: [] }
  const owedFirst = (r) => (r.kind === 'promise' || r.kind === 'reminder' ? 0 : 1)
  rows.sort((a, b) => owedFirst(a) - owedFirst(b))
  const picked = rows.slice(0, limit)
  const text = picked.map((r) => {
    const due = Date.parse(r.due_at || '')
    const note = Number.isFinite(due)
      ? (due <= at ? '已经到期了' : '约在 ' + new Date(due).toLocaleDateString('zh-CN'))
      : '还没做完'
    return '- 还挂着：' + String(r.text).replace(/\s+/g, ' ').slice(0, 45) + '（' + note + '）'
  }).join('\n')
  return { text, ids: picked.map((r) => r.id), kinds: picked.map((r) => String(r.kind || 'task')) }
}

export function loopStats(db, aid) {
  const r = db.prepare(`SELECT
    SUM(CASE WHEN state IN ('open','half_said') THEN 1 ELSE 0 END) open,
    SUM(CASE WHEN state='closed' THEN 1 ELSE 0 END) closed,
    MAX(fire_count) max_fire FROM open_loops WHERE agent_id=?`).get(aid) || {}
  return { open: Number(r.open || 0), closed: Number(r.closed || 0), max_fire: Number(r.max_fire || 0) }
}
