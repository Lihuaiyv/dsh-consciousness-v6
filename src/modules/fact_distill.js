/**
 * C2 事实蒸馏（2026-11-15 21:3x，按主人定稿改）
 *
 * 口径：提示词写规则（抽象、防僵化）；**事实要客观具体**（人名/数字/时间/决定/原话）。
 * 只有 world 这一格允许写可复用的规律，但必须能说反例。
 * 标签：profile / preference / boundary / project / behavior / world。
 *
 * 流程：事件 → 候选（tag/text/why/cue/effect）→ 判官 → 跨事件聚类（只并同一件具体事实，取最具体）
 *       → 升格（behavior ≥2；world 有反例；其余一次即可）。
 * 只写影子；不碰 memory_items。
 */

export const KINDS = new Set(['profile', 'preference', 'boundary', 'project', 'behavior', 'world'])
export const SUBJECTS = new Set(['owner', 'stranger', 'self', 'system', 'world'])
export const STATUSES = new Set(['now', 'past', 'unknown'])
export const VAGUE = /(某些|部分|有时|可能|相关|影响|通常|一般|往往|各种|各类)/

export const DISTILL_SYSTEM = [
  '你在从这段对话里抽取客观、具体、以后查得到的事实，存进事实库。',
  '不写：空泛道理、一次性的情绪、寒暄、没有原文依据的推断。',
  '',
  '标签（每个只写属于自己的内容）：',
  '  profile    = 某对象的身份、工作方式、长期处境；要具体。',
  '  preference = 某对象喜欢/不喜欢什么；要具体，能对回原话。',
  '  boundary   = 某对象的禁忌、不想被怎样对待；要具体。',
  '  project    = 某对象的决定、状态、数字、时间；要具体，可过期。',
  '  behavior   = 在什么情境下通常怎么做；是倾向，不是一次性行为。',
  '  world      = 可复用的规律/道理；可以抽象，但必须有依据、说得出反例、能改变判断。',
  '',
  'subject 只能是：owner（主人）/ stranger（陌生人或外部的人）/ self（你自己）/ system（系统、工具、项目）/ world（一般规律）。',
  'subject_id 写具体是谁：owner 固定 owner；stranger 写原文能确认的标识（人名、昵称、群名、渠道号，如 stranger:阿强、stranger:qq_12345）；self / system 照写；拿不准写 stranger:unknown。',
  'status 只能是：now（现在仍成立）/ past（曾经成立，现在不一定）/ unknown（拿不准）；带日期就写 valid_from / valid_until。',
  '',
  'basis 只能是：said（用户明确说的）/ inferred（你推断的）/ measured（某次量到的数字）。',
  'confidence：0~1；inferred 必填，said 写 0.9，measured 写 0.8。',
  'importance：1~5（以后想起来重不重要）。',
  'sensitivity：private（不能给陌生人看）/ family / work / public。',
  'scope：属于哪个项目或主题（project 类必填，其它可空）。',
  '每条 text 一句话，≤60 字，只讲一件事（不要流水账、不要多个转折）。',
  '每条 why 从原文逐字复制；每条写 cue（下次遇到什么情境会想起它）和 effect（想起后做法有什么不同），写不出就不输出这条。',
  '只输出 {"facts":[{"kind":"…","subject":"…","subject_id":"…","status":"…","basis":"…","confidence":0.9,"importance":3,"sensitivity":"…","scope":"…","text":"…","why":"…","cue":"…","effect":"…","valid_from":"…","valid_until":"…"}]}；没有就输出 {"facts":[]}。',
].join('\n')

export const JUDGE_SYSTEM = [
  '你是事实库的守门人。给你原文、已有事实、候选。',
  '逐条判断：这是不是「客观、具体、可核对的事实」？按标签判：',
  '  profile / preference / boundary / project：必须具体、可核对（人名/数字/时间/决定/原话）；带时间数字是加分，不是缺点。',
  '  behavior：必须是反复出现的倾向（一次的行为不算），能说出「在什么情境下」。',
  '  world：可以抽象，但必须说得出反例、有依据、能改变判断。',
  '再核两样：',
  '  subject：owner / stranger / self / system / world。写错的直接改（把主人写成 stranger、把系统事实写成 owner 都算错）。',
  '  subject_id：具体是谁。stranger 必须带标识（人名/昵称/群名/渠道号）；没有标识写 stranger:unknown；两个不同的人不许共用一个 id。',
  '  status：now（现在仍成立）/ past（曾经成立现在不一定）/ unknown（拿不准）。明明过期却写 now 的改 past；拿不准改 unknown。',
  '  - 不收：空泛道理（「一切行为受条件影响」）、一次性的情绪和寒暄、没有原文依据的推断。',
  '  - 与已有事实矛盾 → 标 conflict，不硬收。',
  '  - 以后检索得到、能改变下次做法 → 优先收。',
  '不收原因：vague（空泛）/ emotion（情绪或寒暄）/ dup（重复）/ conflict（与已有冲突）/ unfaithful（扭曲或没依据）。',
  '反例：「系统中断可能影响任务执行」→ vague；「我今天有点烦」→ emotion。',
  '正例：「qwen3 关掉思考后 109ms，默认 2054ms」→ 收（具体、有数字）；「他不想要主动推送」→ 收（限制）。',
  '一场事最多收 3 条。',
  '只输出 JSON：{"judge":[{"i":1,"verdict":"accept|vague|emotion|dup|conflict|unfaithful","subject":"…","status":"…","reason":"一句话"}]}，i 是候选序号。',
].join('\n')

export const CLUSTER_SYSTEM = [
  '你在把从很多件事里抽出的候选，合并成「同一件具体事实」。',
  '规则：',
  '1) 只有说的是同一件事实才并组；subject 或 subject_id 不同不并（陌生人 A 和 B 即使偏好相同也不并）；只是话题相近，不并。',
  '2) 合并后取**信息最全、最具体**的那条作为表述（保留名字、数字、时间、决定），不要概括、不要抽象。',
  '3) 只有 world 类可以合并成规律句；其它类合并后必须仍是具体事实。',
  '4) 一组最多 5 条候选；超过就拆。',
  '5) 只输出 JSON：{"clusters":[{"members":[1,3],"kind":"preference","text":"最具体的那条","why":"…"}]}',
  '6) 合并后 subject / status / valid_from / valid_until 沿用「最具体那条」的，不要另编。',
  '7) 每条候选都要落进某个组；归不了类的单独成组。',
].join('\n')

const MAX_TEXT = 120

function safeText(s) {
  const t = String(s == null ? '' : s).trim()
  if (!t) return ''
  return Array.from(t).slice(0, MAX_TEXT).join('')
}

/** 第一道：事件 → 候选事实。 */
export async function distillEvent(db, localComplete, ev) {
  const text = `事件时间：${ev.created_at || ''}\n事件：${ev.title}\n经过：${String(ev.story || '').slice(0, 500)}\n原话：${String(ev.quotes || '').slice(0, 300)}`
  const r = await localComplete(db, { system: DISTILL_SYSTEM, text, maxTokens: 500 })
  let parsed = null
  try { parsed = JSON.parse(String(r && r.text || '')) } catch { parsed = null }
  const arr = parsed && Array.isArray(parsed.facts) ? parsed.facts : []
  return {
    raw: String(r && r.text || '').slice(0, 300),
    facts: arr
      .map((f) => ({
        kind: String(f && f.kind || '').trim(),
        subject: String(f && f.subject || '').trim(),
        subject_id: String(f && f.subject_id || '').trim(),
        status: String(f && f.status || '').trim(),
        basis: String(f && f.basis || '').trim(),
        confidence: f && f.confidence != null ? Number(f.confidence) : null,
        importance: f && f.importance != null ? Number(f.importance) : null,
        sensitivity: String(f && f.sensitivity || '').trim(),
        scope: String(f && f.scope || '').trim(),
        text: safeText(f && f.text),
        why: safeText(f && f.why),
        cue: safeText(f && f.cue),
        effect: safeText(f && f.effect),
        valid_from: safeText(f && f.valid_from),
        valid_until: safeText(f && f.valid_until),
      }))
      .map((f) => ({
        ...f,
        subject_id: f.subject_id || (f.subject === 'stranger' ? 'stranger:unknown' : f.subject),
        basis: ['said', 'inferred', 'measured'].includes(f.basis) ? f.basis : 'inferred',
        confidence: Number.isFinite(f.confidence) ? Math.max(0, Math.min(1, f.confidence)) : (f.basis === 'said' ? 0.9 : 0.6),
        importance: Number.isFinite(f.importance) ? Math.max(1, Math.min(5, Math.round(f.importance))) : 3,
        sensitivity: ['private', 'family', 'work', 'public'].includes(f.sensitivity) ? f.sensitivity : (f.subject === 'owner' ? 'private' : 'public'),
        scope: f.scope || '',
      }))
      .filter((f) => KINDS.has(f.kind) && SUBJECTS.has(f.subject) && STATUSES.has(f.status) && f.text && f.why),
  }
}

/** 第二道：判官。 */
export async function judgeFacts(localComplete, { facts, sourceText, existing = [] }) {
  const list = Array.isArray(facts) ? facts : []
  if (!list.length) return { kept: [], dropped: [], raw: '' }
  const cand = list.map((f, i) => `${i + 1}. [${f.kind}] ${f.text}\n   依据：${f.why}`).join('\n')
  const text = `原文：\n${String(sourceText || '').slice(0, 1500)}\n\n已有事实：\n${(existing || []).slice(0, 20).map((x) => '- ' + x).join('\n') || '（无）'}\n\n候选：\n${cand}`
  const r = await localComplete(null, { system: JUDGE_SYSTEM, text, maxTokens: 900 })
  let parsed = null
  try { parsed = JSON.parse(String(r && r.text || '')) } catch { parsed = null }
  const rows = parsed && Array.isArray(parsed.judge) ? parsed.judge : []
  const kept = []
  const dropped = []
  for (const row of rows) {
    const i = Number(row && row.i) - 1
    const f = list[i]
    if (!f) continue
    const verdict = String(row && row.verdict || '').trim()
    if (verdict === 'accept') {
      const subject = SUBJECTS.has(String(row.subject || '').trim()) ? String(row.subject).trim() : f.subject
      const status = STATUSES.has(String(row.status || '').trim()) ? String(row.status).trim() : f.status
      const subjectId = String(row.subject_id || '').trim() || f.subject_id
      kept.push({ ...f, subject, status, subject_id: subjectId, reason: String(row.reason || '').slice(0, 60) })
    } else dropped.push({ ...f, reason: (verdict || 'no-verdict').slice(0, 20) })
  }
  for (let i = 0; i < list.length; i++) {
    if (!rows.some((r2) => Number(r2 && r2.i) === i + 1)) dropped.push({ ...list[i], reason: 'not-judged' })
  }
  return { kept, dropped, raw: String(r && r.text || '').slice(0, 300) }
}

/** 第三道：聚类（同一件事实才并，取最具体）。 */
export async function clusterCandidates(localComplete, candidates) {
  const list = Array.isArray(candidates) ? candidates : []
  if (!list.length) return []
  const lines = list.map((c, i) => `${i + 1}. [${c.kind}] ${c.text}`).join('\n')
  const r = await localComplete(null, { system: CLUSTER_SYSTEM, text: `候选：\n${lines}`, maxTokens: 1200 })
  let parsed = null
  try { parsed = JSON.parse(String(r && r.text || '')) } catch { parsed = null }
  const rows = parsed && Array.isArray(parsed.clusters) ? parsed.clusters : []
  const out = []
  const used = new Set()
  for (const row of rows) {
    const members = (Array.isArray(row && row.members) ? row.members : [])
      .map((x) => Number(x) - 1)
      .filter((x) => x >= 0 && x < list.length && !used.has(x))
    if (!members.length) continue
    for (const m of members) used.add(m)
    const kind = KINDS.has(String(row.kind || '').trim()) ? String(row.kind).trim() : list[members[0]].kind
    // 取成员里信息最全的那条（文本最长、含数字/日期优先），而不是概括
    const best = members.map((i) => list[i]).sort((a, b) => score(a.text) - score(b.text))[members.length - 1] || list[members[0]]
    out.push({ members, kind, subject: best.subject, subject_id: best.subject_id, status: best.status, basis: best.basis, confidence: best.confidence, importance: best.importance, sensitivity: best.sensitivity, scope: best.scope, text: safeText(row.text) || best.text, why: best.why, cue: best.cue, effect: best.effect, valid_from: best.valid_from, valid_until: best.valid_until })
  }
  for (let i = 0; i < list.length; i++) {
    if (!used.has(i)) out.push({ members: [i], kind: list[i].kind, subject: list[i].subject, subject_id: list[i].subject_id, status: list[i].status, basis: list[i].basis, confidence: list[i].confidence, importance: list[i].importance, sensitivity: list[i].sensitivity, scope: list[i].scope, text: list[i].text, why: list[i].why, cue: list[i].cue, effect: list[i].effect, valid_from: list[i].valid_from, valid_until: list[i].valid_until })
  }
  return out
}

/** 具体度打分：有数字/日期/人名（对话里出现的名字）加分；纯概括减分。 */
function score(text) {
  const t = String(text || '')
  let s = Math.min(t.length, 120) / 20
  if (/\d/.test(t)) s += 3
  if (/(\d{1,2}月|\d{1,2}日|星期|点|分钟|小时|ms|秒)/.test(t)) s += 3
  if (VAGUE.test(t)) s -= 4
  return s
}

/**
 * 升格：behavior ≥2 件；world 必须有反例；其它类一次明确陈述即可收（project/preference/boundary/profile）。
 * 组内 ≤5；text 长度合理；cue/effect 可选但建议有。
 */
export function promoteClusters(clusters, candidateEvents) {
  const promoted = []
  const weak = []
  for (const c of Array.isArray(clusters) ? clusters : []) {
    const rawEv = (c.members || []).map((i) => candidateEvents[i]).filter(Boolean)
    const seenEv = new Set()
    const events = []
    for (const e of rawEv) {
      const id = typeof e === 'string' ? e : (e && e.id)
      if (!id || seenEv.has(id)) continue
      seenEv.add(id)
      events.push(e)
    }
    const members = Array.isArray(c.members) ? c.members.length : 0
    const text = String(c.text || '').trim()
    const len = Array.from(text).length
    let reason = ''
    if (members > 5) reason = 'oversized'
    else if (!text) reason = 'empty'
    else if (len > 80) reason = 'too-long'
    else if (!String(c.cue || '').trim() || !String(c.effect || '').trim()) reason = 'no-use'
    else if (/[；;]/.test(text)) reason = 'merged'
    else if (c.kind === 'behavior' && events.length < 2) reason = 'need-2-events'
    else if (c.kind === 'world' && !String(c.falsifier || '').trim()) reason = 'no-falsifier'
    else if (VAGUE.test(text)) reason = 'vague'
    if (!reason) {
      const firstAt = (events[0] && events[0].at) || ''
      const validFrom = String(c.valid_from || '').trim() || (c.basis === 'measured' ? String(firstAt).slice(0, 10) : '')
      promoted.push({ ...c, valid_from: validFrom, events, support: events.length })
    }
    else weak.push({ ...c, events, support: events.length, weakReason: reason })
  }
  return { promoted, weak }
}
