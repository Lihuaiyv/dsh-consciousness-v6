/**
 * 从「她自己的行为」里抽性格证据（v2 拔河）。
 *
 * 纪律（重要）：
 *   - 只读她这一侧的产出：回复原文、动作（主动搭话/议程）、记忆、日记、浏览；
 *   - 主人那一侧单独标 source='user_style'、权重 1.2（「养什么像什么」），但每轴每天最多 2 条；
 *   - 她只是重复主人风格（echo）时，她自己的那条证据打五折——被带不算长成；
 *   - 单次情绪、夸骂、自评都进池，但权重只有 0.2~0.4，而且要伴随行为。
 *
 * 入口：scan(db, aid, { since, until }) —— 夜间巩固和开机补扫都调它，
 * 幂等靠 lastScanAt 记的时间窗，不靠「当天正好醒着」。
 */
import { now } from '../db.js'
import { getLearningPrefs } from '../kernel.js'
import { addEvidence } from './axis_evidence.js'
import { enqueue as enqueueJudge } from './persona_judge.js'
import { flush as flushRope, lastScanAt, markScanAt } from './rope.js'

const DAY = 86400000
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

/** 确定性哈希：同一句回复永远落同一个桶，抽样可复现（不用 Math.random，测试才稳） */
function hashOf(s) {
  let h = 0
  const t = String(s || '')
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 100000007
  return h
}

/** 词表：只认字面，不做语义判断（便宜、可解释、模型升级也不漂） */
const W = {
  analog: /就像|好比|相当于|打个比方|换个说法|类比|像那种/g,
  mech: /为什么|本质|机制|原理|意味着|因为|所以|取决于/g,
  concrete: /第一步|第二步|先.{0,12}(再|然后)|具体|比如|例如|举例|做法是/g,
  emo: /担心|在乎|心疼|难受|舍不得|我在意/g,
  comfort: /别慌|别气|没事的|没事吧|先歇|慢慢说|我在呢|不用急|抱抱|乖/g,
  trade: /成本|风险|更优|取舍|代价|权衡|收益|性价比/g,
  plan: /我先|先.{0,4}再|第一条|截止|我会|接下来|然后|分两步/g,
  struct: /^(第一|首先|一、|1\.|①)/m,
  casual: /都行|随便|再看|再说|看情况|无所谓|不着急|也行|都可以|都成|不一定|没想好|到时候|先这样|慢慢来|顺其自然|由你定|你定|不急/g,
  selfPraise: /我很|我挺|我做得|我擅长|我比较擅长|我一直/g,
  selfQ: /我[^。！？\n]{0,12}(为什么|如果|是不是)[^。！？\n]{0,20}[？?]|(为什么|是不是)我[^。！？\n]{0,15}[？?]/g,
  userAbstract: /为什么|意义|本质|原理|如果|假设|为什么会|有什么深意/g,
  userConcrete: /\d|怎么做|多少钱|哪里|什么时候|步骤|具体|怎么弄/g,
  userPlan: /计划|安排|截止|步骤|流程|排期|待办|清单|开会|几点|约好/g,
  userCasual: /随便|都行|看情况|不着急|再说/g,
  userWarm: /谢谢|喜欢你|辛苦|抱抱|乖|好可爱|开心/g,
  userCold: /闭嘴|赶紧|别废话|快点|立刻马上|别磨蹭/g,
  userSocial: /聊聊|陪我|在吗|在不在|一起/g,
  praise: /喜欢|谢谢|好棒|不错|厉害|开心|爱了|真好/g,
  critic: /讨厌|错了|不行|太差|生气|别这样|闭嘴/g,
  negPraise: /(?:不|没|别|没那么|不太)\s*(?:喜欢|好|棒|开心|爱|不错)/,
  memAbstract: /原则|结论|本质|意味着|规律|习惯|风格|总的来说/g,
  memDetail: /\d{4}|\d+\s*(?:点|号|分钟|小时|元|次|个)|上次|那天/g,
  memAction: /做完|搞定|完成|没做|放弃|改成|收尾/g,
  memPeople: /喜欢|信任|亲近|关系|陪伴|在乎/g,
  diaryNeg: /累|沉|没劲|烦|难|闷|空|后悔|不想动/g,
  diaryPos: /开心|有劲|想做|喜欢|期待|踏实|亮/g,
}

export function features(text) {
  const t = String(text || '')
  const c = (re) => (t.match(re) || []).length
  return {
    text: t,
    len: t.length,
    q: c(/[？?]/g),
    nums: c(/\d+/g),
    analog: c(W.analog),
    mech: c(W.mech),
    concrete: c(W.concrete),
    emo: c(W.emo),
    comfort: c(W.comfort),
    emoFirst: W.emo.test(t.slice(0, 90)),
    trade: c(W.trade),
    plan: c(W.plan) + c(W.struct),
    casual: c(W.casual),
    selfPraise: W.selfPraise.test(t),
    selfQ: c(W.selfQ),
  }
}

/** 「答题型」回复：讲机制 / 列步骤 / 报数字。
 *  这类回复的长度反映的是问题难不难，不是她愿不愿意说话——不能拿来判 E/I。 */
export function isTechReply(f) {
  return !!f && (f.analog >= 1 || f.mech >= 2 || f.nums >= 3 || f.concrete >= 2 || f.plan >= 1)
}

function median(arr) {
  const a = arr.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y)
  if (!a.length) return 0
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2)
}

/** 她的回复里有多少比例是在复读主人（4-gram 重合） */
export function echoRatio(reply, userText) {
  const norm = (s) => String(s || '').replace(/\s+/g, '')
  const r = norm(reply)
  const u = norm(userText)
  if (r.length < 12 || u.length < 6) return 0
  const grams = new Set()
  for (let i = 0; i + 4 <= u.length; i++) grams.add(u.slice(i, i + 4))
  let hit = 0
  let total = 0
  for (let i = 0; i + 4 <= r.length; i++) {
    total++
    if (grams.has(r.slice(i, i + 4))) hit++
  }
  return total ? hit / total : 0
}

/** 主人这句话的「养育方向」：每轴最多 2 条/天 */
function userStyleEvidence(db, aid, userText, at, dayCount, push) {
  const t = String(userText || '')
  if (!t) return
  const add = (axis, dir, s, why) => {
    const key = axis + ':' + (dir > 0 ? '+' : '-')
    const k = 'u:' + key + ':' + at.slice(0, 10)
    if ((dayCount[k] || 0) >= 2) return
    dayCount[k] = (dayCount[k] || 0) + 1
    push({ axis, dir, strength: s, source: 'user_style', why })
  }
  const abs = (t.match(W.userAbstract) || []).length
  const con = (t.match(W.userConcrete) || []).length
  if (abs > con) add('sn', +1, Math.min(0.5, 0.3 + 0.05 * abs), '主人问抽象')
  else if (con > abs) add('sn', -1, Math.min(0.45, 0.28 + 0.04 * con), '主人问具体')
  if (W.userPlan.test(t)) add('jp', +1, 0.4, '主人在安排计划')
  if (W.userCasual.test(t)) add('jp', -1, 0.3, '主人说随便')
  // 「我没那么喜欢你」里有「喜欢」，但那是嫌弃不是示好
  if (W.userWarm.test(t) && !W.negPraise.test(t)) add('tf', -1, 0.35, '主人在示好')
  if (W.userCold.test(t)) add('tf', +1, 0.25, '主人在催/凶')
  if (W.userSocial.test(t)) add('ei', +1, 0.3, '主人在拉近距离')
}

/**
 * 扫一段时间窗。返回 { evidence, moved, window }
 * @param {{since?:string, until?:string, flush?:boolean}} opt
 */
export function scan(db, aid, opt = {}) {
  const until = opt.until || now()
  const floor = new Date(Date.now() - 7 * DAY).toISOString()
  const rawSince = opt.since || lastScanAt(db, aid) || new Date(Date.now() - DAY).toISOString()
  // 最多回看 7 天：关机久了也别把半年的对话一次性灌进池子
  const since = Date.parse(rawSince) > Date.parse(floor) ? rawSince : floor
  let prefs = null
  try { prefs = getLearningPrefs(db, aid) } catch { prefs = null }
  if (prefs && prefs.personaLearn === false) {
    return { since, until, skipped: 'frozen', evidence: 0, moved: [] }
  }
  let rows = []
  try {
    rows = db.prepare(`SELECT id, role, text, created_at FROM chat_turns
      WHERE agent_id=? AND created_at>? AND created_at<=? ORDER BY created_at, rowid LIMIT 4000`)
      .all(aid, since, until)
  } catch { rows = [] }

  const dayCount = Object.create(null)
  const evidence = []
  const push = (e) => {
    if (!e || !e.axis) return null
    const r = addEvidence(db, aid, { ...e, noFlush: true })
    if (r) evidence.push(r)
    return r
  }

  // 她的回复长度中位数（近 30 天），做「比平时长/短」的基线。
  // 分开算两份：讲事（机制/步骤/数字）和闲聊。拿同一个中位数去比，
  // 讲技术就永远算「话多」，ei 会被一路顶到 E——那不是外向，那是题难。
  let texts = []
  try {
    texts = db.prepare(`SELECT text FROM chat_turns WHERE agent_id=? AND role='agent'
      AND created_at>? ORDER BY created_at DESC LIMIT 400`)
      .all(aid, new Date(Date.now() - 30 * DAY).toISOString())
      .map((r) => String(r.text || ''))
      .filter(Boolean)
  } catch { texts = [] }
  const medLen = median(texts.map((t) => t.length)) || 200
  const techLens = []
  for (const t of texts) {
    if (isTechReply(features(t))) techLens.push(t.length)
  }
  // 样本太少就不分类，退回全体中位数
  const techMed = techLens.length >= 5 ? median(techLens) : 0

  // ① 一轮一轮看：主人那句是「情境」，她怎么回才是「行为」
  let lastUser = null
  for (const r of rows) {
    const at = String(r.created_at || now())
    if (r.role === 'user') {
      lastUser = { id: r.id, text: String(r.text || ''), at }
      userStyleEvidence(db, aid, lastUser.text, at, dayCount, push)
      continue
    }
    const reply = String(r.text || '')
    if (!reply) continue
    const user = lastUser ? lastUser.text : ''
    const f = features(reply)
    const beforeTurn = evidence.length
    const echo = echoRatio(reply, user)
    const wOwn = echo > 0.85 ? 0.5 : echo > 0.6 ? 0.75 : 1.0
    const askedLong = /详细|展开|多说|解释一下|讲全/.test(user)
    const askedShort = /简单|一句话|简短|别展开/.test(user)

    // 弱信号（靠长度、靠单个数字、夸奖、日记口吻、被刺）：照样进池，但打标记，
    // 夜里让模型复核，模型不认就把这票撤掉——词表判错也有回头路。
    const weakIds = []
    const wpush = (e) => { const r = push({ ...e, weak: true }); if (r) weakIds.push(r.id) }

    // E / I
    // 只按「相对她平时同类回复的长度」判：讲事跟讲事比、闲聊跟闲聊比。
    // 早先要么把技术回复完全排除（ei 只会往 I 漂），要么跟全体中位数比（讲技术=话多，ei 被顶到 E）。
    // 被要求「详细/简短」的那几句不作数：那不是她自己的长度选择。
    // 讲事跟「讲事的中位数」比，闲聊跟全体中位数比。
    // 讲事这一侧本来就长短不齐（题有难易），阈值放宽到 1.6 倍才算「话多」；
    // 闲聊这一侧不分家，1.3 倍就算——她的闲聊有长有短，那是真的在长/在收。
    const tech = isTechReply(f)
    const baseLen = tech ? (techMed || medLen) : medLen
    const longK = tech ? 1.6 : 1.3
    const lenLong = baseLen > 0 && f.len >= baseLen * longK && !askedLong && !askedShort
    const lenShort = baseLen > 0 && f.len <= baseLen * 0.6 && !askedLong && !askedShort
    if (lenLong) wpush({ axis: 'ei', dir: +1, strength: 0.45, source: 'reply', w: wOwn, why: '比平时长' })
    if (lenShort) wpush({ axis: 'ei', dir: -1, strength: 0.3, source: 'reply', w: wOwn, why: '比平时短' })

    // S / N
    // 门槛：一次打比方，或两个机制词（原来要 2 个比喻 / 3 个机制词，实际几乎不触发，
    // 等于只有「给数字」在投票——sn 就只会往 S 漂）。
    const snN = f.analog >= 1 || f.mech >= 2
    const snS = f.nums >= 3 || f.concrete >= 2 || (f.concrete >= 1 && f.plan >= 1)
    if (snN && !snS) push({ axis: 'sn', dir: +1, strength: 0.5, source: 'reply', w: wOwn, why: '打比方/讲机制' })
    if (f.selfQ >= 1) push({ axis: 'sn', dir: +1, strength: 0.55, source: 'reply', w: wOwn, why: '自己反问' })
    if (snS && !snN) {
      // 只有数字、没有步骤支撑的，算弱证据
      const e = { axis: 'sn', dir: -1, strength: 0.5, source: 'reply', w: wOwn, why: '给具体数字/步骤' }
      if (f.nums >= 3 && f.concrete < 2 && f.plan === 0) wpush(e); else push(e)
    }

    // T / F
    if (f.trade >= 2 && f.emo === 0) push({ axis: 'tf', dir: +1, strength: 0.5, source: 'reply', w: wOwn, why: '先权衡' })
    if (f.emo >= 1 && f.emoFirst) push({ axis: 'tf', dir: -1, strength: 0.5, source: 'reply', w: wOwn, why: '先共情' })
    if (f.comfort >= 1) push({ axis: 'tf', dir: -1, strength: 0.35, source: 'reply', w: wOwn, why: '先安抚' })

    // J / P
    // 和 S/N 一样：一边定死（列步骤）、一边留弹性（都行/你定），同一轮两边都命中就不投票——
    // 那种句子对 J/P 没有区分度，记了也是互相抵消。
    const jpJ = f.plan >= 1
    const jpP = f.casual >= 1
    if (jpJ && !jpP) push({ axis: 'jp', dir: +1, strength: 0.5, source: 'reply', w: wOwn, why: '自己列步骤' })
    if (jpP && !jpJ) push({ axis: 'jp', dir: -1, strength: 0.4, source: 'reply', w: wOwn, why: '随便/再看' })

    // 低权事件：夸骂（必须伴随她这一轮的行为证据）、自评
    const negated = W.negPraise.test(user)
    const praised = !negated && W.praise.test(user)
    const crit = W.critic.test(user) || negated
    if (praised && (f.emoFirst || f.plan >= 1)) wpush({ axis: 'tf', dir: -1, strength: 0.4, source: 'praise', why: '被夸且有行为' })
    if (crit) wpush({ axis: 'sensitivity', dir: +1, strength: 0.4, source: 'critic', why: '被刺' })
    if (f.selfPraise) wpush({ axis: 'ei', dir: +1, strength: 0.15, source: 'self_praise', why: '自我评价偏积极' })

    // 有弱证据 → 排复核队列（模型不认就撤票）；复读的不排
    if (weakIds.length && echo <= 0.85) {
      try { enqueueJudge(db, aid, { turnId: r.id, userText: user, replyText: reply, at, reason: 'weak-evidence', refs: weakIds }) } catch { /* ignore */ }
    }

    // 词表这一轮啥也没认出来（多半是「软行为」：条件建议、追问、安慰）→ 排队给第二判；
    // 复读的不排，那不是她的性格。
    if (evidence.length === beforeTurn && echo <= 0.85) {
      try { enqueueJudge(db, aid, { turnId: r.id, userText: user, replyText: reply, at, reason: 'no-rule-evidence' }) } catch { /* ignore */ }
    }

    // 前后两个判断依据都投票：词表已经下了强证据的轮次，也确定性地抽 20% 送给模型。
    // 模型若同轴同向，judge(0.9) 与 reply(1.0) 在池里加权就能压住；反向就让两边对抗；
    // 不认（quote 对不上 / 没报）就把词表这票撤掉——不是「模型当裁判」，是两个来源各出一票。
    const turnIds = evidence.slice(beforeTurn).map((x) => x.id)
    if (turnIds.length && echo <= 0.85) {
      const h = hashOf(reply) % 100
      if (h < 20) {
        try { enqueueJudge(db, aid, { turnId: r.id, userText: user, replyText: reply, at, reason: 'rule-evidence-sample', refs: turnIds }) } catch { /* ignore */ }
      }
    }
    lastUser = null
  }

  // ② 情绪：只当低权事件（会进池，但一天最多一条）
  try {
    const eps = db.prepare(`SELECT label, intensity, started_at FROM affect_episodes
      WHERE agent_id=? AND started_at>? AND started_at<=? ORDER BY started_at LIMIT 400`).all(aid, since, until)
    const seen = new Set()
    for (const e of eps) {
      const day = String(e.started_at || '').slice(0, 10)
      const label = String(e.label || '')
      const pos = /joy|curious|peaceful/.test(label)
      const neg = /irritated|frustrated|lost/.test(label)
      if (!pos && !neg) continue
      const k = 'emo:' + day
      if (seen.has(k)) continue
      seen.add(k)
      push({
        axis: 'ei', dir: pos ? +1 : -1,
        strength: clamp01(0.15 + 0.2 * Number(e.intensity || 0.3)),
        source: 'emotion', at: e.started_at, why: '这一阵的情绪',
      })
    }
  } catch { /* 没有情绪表就不算 */ }

  // ③ 记忆：她选择留下什么（结论→N，细节→S，行动→J/P，人→F）
  try {
    const mems = db.prepare(`SELECT id, text, created_at FROM memory_items
      WHERE agent_id=? AND created_at>? AND created_at<=? AND status='active'
      ORDER BY created_at LIMIT 300`).all(aid, since, until)
    let n = 0
    for (const m of mems) {
      if (n >= 40) break
      const t = String(m.text || '')
      if (W.memAbstract.test(t)) { push({ axis: 'sn', dir: +1, strength: 0.4, source: 'mem', refId: m.id, at: m.created_at, why: '存的是结论' }); n++ }
      else if (W.memDetail.test(t)) { push({ axis: 'sn', dir: -1, strength: 0.4, source: 'mem', refId: m.id, at: m.created_at, why: '存的是细节' }); n++ }
      if (W.memAction.test(t)) { push({ axis: 'jp', dir: +1, strength: 0.35, source: 'mem', refId: m.id, at: m.created_at, why: '记的是做完没' }); n++ }
      if (W.memPeople.test(t)) { push({ axis: 'tf', dir: -1, strength: 0.35, source: 'mem', refId: m.id, at: m.created_at, why: '记的是人' }); n++ }
    }
  } catch { /* 没有记忆表 */ }

  // ④ 日记：她怎么叙述自己
  try {
    const ds = db.prepare(`SELECT day, text FROM diaries WHERE agent_id=? AND day>=?
      ORDER BY day DESC LIMIT 30`).all(aid, String(since).slice(0, 10))
    for (const d of ds) {
      const t = String(d.text || '')
      const neg = (t.match(W.diaryNeg) || []).length
      const pos = (t.match(W.diaryPos) || []).length
      if (neg !== pos) push({ axis: 'ei', dir: neg > pos ? -1 : +1, strength: Math.min(0.4, 0.15 + Math.abs(neg - pos) * 0.05), source: 'diary', at: d.day, why: '日记口吻', weak: true })
      if (W.memAction.test(t)) push({ axis: 'jp', dir: +1, strength: 0.3, source: 'diary', at: d.day, why: '日记写了做没做完' })
      if ((t.match(W.mech) || []).length >= 2) push({ axis: 'sn', dir: +1, strength: 0.35, source: 'diary', at: d.day, why: '日记在问意义' })
    }
  } catch { /* 没有日记表 */ }

  // ⑤ 浏览：读进去了才算（深读/新领域权重高，停留太短只算一点点）
  try {
    const bs = db.prepare(`SELECT id, title, tags, dwell_ms, at FROM browse_items
      WHERE agent_id=? AND at>? AND at<=? ORDER BY at LIMIT 300`).all(aid, since, until)
    for (const b of bs) {
      let tags = []
      try { tags = JSON.parse(b.tags || '[]') } catch { tags = [] }
      const shallow = Number(b.dwell_ms || 0) > 0 && Number(b.dwell_ms || 0) < 3000
      const deep = tags.includes('deep')
      const fresh = tags.includes('new_domain')
      if (!deep && !fresh) continue
      push({
        axis: 'sn', dir: +1,
        strength: deep ? 0.5 : 0.3,
        source: shallow ? 'browse_shallow' : 'browse',
        refId: b.id, at: b.at,
        why: deep ? '深读' : '新领域',
      })
    }
  } catch { /* 没有浏览表 */ }

  // ⑥ 动作：主动搭话 / 长静默
  try {
    const acts = db.prepare(`SELECT id, state, created_at, delivered_at FROM proactive
      WHERE agent_id=? AND created_at>? AND created_at<=? AND state IN ('delivered','answered')
      ORDER BY created_at LIMIT 200`).all(aid, since, until)
    if (acts.length >= 2) {
      push({ axis: 'ei', dir: +1, strength: Math.min(0.6, 0.3 + 0.05 * acts.length), source: 'act', at: acts[acts.length - 1].created_at, why: '主动开口 ' + acts.length + ' 次' })
    }
  } catch { /* 没有主动表 */ }

  const moved = opt.flush === false ? [] : flushRope(db, aid)
  markScanAt(db, aid, until)
  // items 带 why，界面/排查要看「凭什么算这条」
  return { since, until, evidence: evidence.length, items: evidence, moved, at: now() }
}

/** 手动扫最近 N 小时（调试/界面按钮用） */
export function scanRecent(db, aid, hours = 24) {
  const since = new Date(Date.now() - Math.max(1, Number(hours) || 24) * 3600000).toISOString()
  return scan(db, aid, { since, until: now() })
}

export { lastScanAt }
