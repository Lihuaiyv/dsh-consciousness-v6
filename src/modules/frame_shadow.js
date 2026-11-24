// 影子帧（2026-11-22）：每轮回复后，异步切出这一段的核，写进副表。只写不读。
//
// 为什么是影子：先证明「真对话里也能切出核」，再决定要不要注入。
// 开关 `affect.frame.shadow` 默认 off；off 时这个函数第一行就返回，不做任何事。
//
// 三条硬规矩（照验收-影子帧）：
//   1. 不挡回复：调用方不要 await（扔出去）。
//   2. 不许把失败抛给对话：整段包在 try 里。
//   3. 不调强模型：只用本地（localComplete，块 'chat'），不新开进程。
//
// 2026-11-23：拆成「链」跑（chain.js）——切句 → 提件 → 站队 → 补判 → 落表，
// 每步记账；提件换宿主/本地只换 runner，链的形状不变。设计见 8-工程-门禁与文档/设计-链与块-2026-11-23.md
import { localComplete } from './local_llm.js'
import { hostComplete } from './host_llm.js'
import { getFlag, nid, model as kernelModel } from '../kernel.js'
import { runChain } from './chain.js'

const MARKS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'

const STOPCH = new Set([...'的了和与及在是对把给让这那有没有还不是就也都很更再又呢吧啊吗么我你他她它们东西一个上下来去到说做着过'])
const GENERIC = ['主人', '所以', '我们', '什么', '这个', '那个', '一样', '一个', '没有', '可以', '就是', '还是', '如果', '因为', '但是', '而且', '然后', '现在', '时候', '这样', '那样', '知道', '觉得', '出来', '起来', '不是', '是不是', '真的', '已经', '可能']
export function keysOf(text) {
  let t = String(text).replace(/[^\u4e00-\u9fa5]/g, '')
  for (const g of GENERIC) t = t.split(g).join('\u0000')
  const set = new Set()
  for (const seg of t.split('\u0000')) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const k = seg.slice(i, i + 2)
      if (!STOPCH.has(k[0]) && !STOPCH.has(k[1])) set.add(k)
    }
  }
  return set
}

// 连边：新写的这几行连到「已有的帧里话题词共享最多的那一帧」，一个旧帧最多被连 2 次。
// 为什么放在这里：树不落表（没有单独的边表），under_id 就是边；写的时候就该连上，
// 否则查出来是一堆散行，永远要另一个脚本事后补。
export function linkUnder(db, cores, selfIds) {
  const prev = db.prepare(`SELECT id, core, text, under_id FROM frame_shadow
    WHERE id NOT IN (${selfIds.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT 40`).all(...selfIds)
  if (!prev.length) return
  const keyOf = f => keysOf(String(f.core || '') + String(f.text || ''))
  const prevKeys = prev.map(f => ({ f, k: keyOf(f) }))
  const used = {}
  for (const c of cores) {
    // 已经挂在本轮目的下的，不许改（同轮父子优先于跨轮连边）
    const cur = db.prepare('SELECT under_id FROM frame_shadow WHERE id=?').get(c.id)
    if (cur && cur.under_id) continue
    const ck = keysOf(String(c.core || '') + String(c.text || ''))
    let best = null, bs = 0
    for (const p of prevKeys) {
      let n = 0
      for (const k of ck) if (p.k.has(k)) n++
      const cnt = used[p.f.id] || 0
      // 一个旧帧最多被连两次；已经满了就跳过（避免树长成柱子）
      if (n > bs && cnt < 2) { bs = n; best = p.f }
    }
    if (best && bs >= 1) used[best.id] = (used[best.id] || 0) + 1
    db.prepare('UPDATE frame_shadow SET under_id=?, rel=? WHERE id=?').run(best && bs >= 1 ? best.id : null, best && bs >= 1 ? 'continue' : null, c.id)
  }
}

export function ensureTable(db) {
  // frame_shadow：一核一段（核句 + 补话）；frame_edges：段内/段间的边。
  // 注意顺序：旧表先补列，再建索引——否则旧表没有新列时，建索引会抛错，
  // 整段设表失败被吞掉，写帧每轮静默失败（2026-11-23 真库踩过）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS frame_shadow (
      id TEXT PRIMARY KEY,
      turn_id TEXT,
      seg TEXT,
      created_at TEXT,
      core TEXT,
      core_goal TEXT,
      sents TEXT,
      text TEXT,
      under_id TEXT,
      role TEXT,
      head_id TEXT,
      rel TEXT,
      sat TEXT,
      plan TEXT
    );
    CREATE TABLE IF NOT EXISTS frame_edges (
      id TEXT PRIMARY KEY,
      from_id TEXT,
      to_id TEXT,
      rel TEXT,
      created_at TEXT
    );
  `)
  // 老库补列
  for (const col of ['rel', 'seg', 'role', 'head_id', 'sat']) {
    try { db.exec(`ALTER TABLE frame_shadow ADD COLUMN ${col} TEXT`) } catch { /* 已有 */ }
  }
  // 列齐了再建索引
  for (const ddl of [
    'CREATE INDEX IF NOT EXISTS idx_frame_shadow_turn ON frame_shadow(turn_id)',
    'CREATE INDEX IF NOT EXISTS idx_frame_shadow_seg ON frame_shadow(seg)',
    'CREATE INDEX IF NOT EXISTS idx_frame_edges_from ON frame_edges(from_id)',
  ]) {
    try { db.exec(ddl) } catch { /* 建不上不拖累写帧 */ }
  }
}

export const strip = (t) => String(t || '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/`[^`]*`/g, '')
  .replace(/[*#>|_~]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
// 分句：只按句末标点切（分号不切）。纯符号段（「——」「……」「!!」）不算句子——
// 2026-11-23 实测：「——」会漏成一句进提件，给模型添噪音。要求至少一个汉字/字母/数字。
export const toSent = (t) => strip(t)
  .split(/(?<=[。！？!?])/)
  .map((x) => x.trim())
  .filter((x) => x.length >= 2 && /[\u4e00-\u9fa5A-Za-z0-9]/.test(x))

const grabArr = (raw) => { const t = String(raw); const i = t.indexOf('['), k = t.lastIndexOf(']'); if (i < 0 || k <= i) return null; try { return JSON.parse(t.slice(i, k + 1)) } catch { return null } }
const grabObj = (raw) => { const t = String(raw); const i = t.indexOf('{'), k = t.lastIndexOf('}'); if (i >= 0 && k > i) { try { return JSON.parse(t.slice(i, k + 1)) } catch { } } return null }
const parseAssign = (raw) => {
  const o = grabObj(raw)
  const norm = {}
  for (const [k, v] of Object.entries((o && o.assign) || {})) {
    const n = String(k).replace(/[^0-9]/g, '')
    if (n) norm[n] = String(v).toUpperCase().replace(/[^ABCDN]/g, '').replace(/N/g, '')
  }
  if (Object.keys(norm).length) return norm
  for (const m of String(raw).matchAll(/"?\s*\.?\s*(\d+)\s*"?\s*:\s*"([A-Za-z]+)"/g)) norm[m[1]] = String(m[2]).toUpperCase()
  return norm
}

// 活着的目的事：最近几条没挂父的帧（跨轮的每个目的核都在里面）。
// 给模型的候选，让它答「这一段接着哪一条往下走」——这是真语义，字面共享只当兜底。
function recentGoals(db, excludeTurn = '', limit = 5) {
  try {
    // 排除本轮自己（重跑时库里还留着上一遍的行，会把「接哪条」答成自己接自己）
    // 新数据的段头是 role='nucleus'；老数据没有 role，用「under_id 为空」当段头。
    return db.prepare(`SELECT id, core FROM frame_shadow
      WHERE (role = 'nucleus' OR (role IS NULL AND under_id IS NULL)) AND turn_id IS NOT ?
      ORDER BY rowid DESC LIMIT ?`)
      .all(excludeTurn || null, limit)
  } catch { return [] }
}

// ---------------- 链：切句 → 提件 → 站队 → 补判 → 落表 ----------------

// 模型返回的原文：runner 生产里给 { text }，单测/别的 runner 可能直接给字符串。
function rawText(raw) {
  if (typeof raw === 'string') return raw
  return String((raw && raw.text) || '')
}

// 第 1 步：纯代码分句。少于两句直接正常结束（单句没有「一件事 + 它的动作」）。
function splitStep(ctx) {
  ctx.sents = toSent(ctx.reply)
  // 一句话也可能承载一个核（2026-11-23 改：原先不足 2 句就整条链停，短回复全被丢掉）
  if (!ctx.sents.length) return { stop: true }
  return null
}

// 第 2 步：题（v18 ①）——这段在谈什么。三种问法**分开问**（各一次调用），取交集。
// 隔离是故意的：三问塞进同一个 prompt，模型会顺着上一问的答案答，越答越像。
// 上限 4 是工程护栏（防凑数），不是语义要求：有几件写几件，别硬分。
const TOPIC_ASKS = [
  '这一段在说哪几件事？',
  '这一段在回答哪些问题？',
  '如果别人问「你刚才在说几件事」，你会列出哪几件？',
]
function topicReq(i) {
  return (ctx) => ({
    system: `只输出一个 JSON 对象：{"topics":["…","…"]}
${TOPIC_ASKS[i]}
有几件写几件，别为凑数硬分；最多不超过 4 个核（再多说明这段太碎，先合并）。每个核一个不超过 10 字的短语，直接写核本身。不要解释。`,
    text: ctx.text || ctx.sents.join(''),
    maxTokens: 200, format: '', timeoutMs: 30000,
  })
}
function topicRun(key) {
  return (ctx, raw) => {
    const o = grabObj(rawText(raw))
    const arr = Array.isArray(o && o.topics) ? o.topics : []
    ctx.topicSets[key] = arr.map((x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 12)).filter(Boolean).slice(0, 4)
    return null
  }
}
function topicsMergeStep(ctx) {
  const sets = ['a', 'b', 'c'].map((k) => new Set(ctx.topicSets[k] || []))
  const inAll = [...sets[0]].filter((t) => sets[1].has(t) && sets[2].has(t))
  if (inAll.length) {
    ctx.topics = inAll.slice(0, 4)
  } else {
    // 交集空（换个说法就重了）：退到「至少两问都说过」的题
    const cnt = {}
    for (const set of sets) for (const t of set) cnt[t] = (cnt[t] || 0) + 1
    ctx.topics = Object.keys(cnt).filter((t) => cnt[t] >= 2).slice(0, 4)
  }
  ctx.shouldSplit = ctx.topics.length >= 2
  return null
}

// 判官（宿主）：一次调用。读整段原文 + 三份候选，合并同义、删非事、补漏。
// 关键逻辑：先在心里回答「这段话在回答什么问题」——那个回答才是核；围着回答说的是补话，补话不算核。
function judgeRequest(ctx) {
  const candidates = ['a', 'b', 'c'].map((k, i) => `问${i + 1}：${JSON.stringify(ctx.topicSets[k] || [])}`).join('\n')
  return {
    system: `核 = 这段话里承重的一或几件事；围着它/它们转的句子都是它的补话。同一个核的不同说法，是它的补话，不是两个核。如果核被抽走，这段话会变成不明所指的空话。
先回答一个问题：这段话在回答什么问题？——围着回答说的都是补话，补话不算核。
现在你是判官。读整段原文和三份候选名字，给出这一段「在说哪几个核」的名单。
规则：
1) 说的是同一个核的合并成一个，名字取最具体的说法；
2) 删掉不是核的补话；
3) 候选都漏了、但原文确实在说的核，补上；
4) 每个核不超过 10 字，直接写核本身；最多 6 个核。
输出：{"things":[{"what":"…"}]}。不要解释。`,
    text: `整段原文：\n${ctx.text || ctx.sents.join('')}\n\n三份候选：\n${candidates}\n\n本地合并（参考）：${JSON.stringify(ctx.topics || [])}`,
    maxTokens: 400, format: '', timeoutMs: 30000,
  }
}
function judgeStep(ctx, raw) {
  const text = rawText(raw)
  const parsed = grabObj(text)
  const arr = Array.isArray(parsed && parsed.things) ? parsed.things : (grabArr(text) || [])
  ctx.things = arr
    .map((x) => ({ what: String((x && (x.what || x.name || x.question)) || '').trim() }))
    .filter((x) => x.what).slice(0, 6)
  // 判官空/失败 → 回退本地字面合并的题名，别让链停
  if (!ctx.things.length) ctx.things = (ctx.topics || []).map((t) => ({ what: t }))
  return null
}

// 第 4·5 步：接续——这一段接着哪条线往下走。放在分配之后：先知道本轮有哪几件，再判接谁。
// 候选先用「最近几件」（右边界候选是下一步）；没有候选就跳过，不拖累写帧。
function attachRequest(ctx) {
  ctx.goals = recentGoals(ctx.db, ctx.turnId)
  if (!ctx.goals.length) return null
  return {
    system: `只输出一个 JSON 对象：{"link":编号}
这一段可能接着下面某一条线往下走，也可能新开。接着哪条就写它的编号（1 开始），新开写 0。不要解释。`,
    text: ctx.goals.map((c, i) => `${i + 1}. ${c.core}`).join('\n') + '\n\n这一段在说：\n' + ctx.things.map((t) => '· ' + t.what).join('\n'),
    maxTokens: 100, format: '', timeoutMs: 15000,
  }
}
function attachStep(ctx, raw) {
  const o = grabObj(rawText(raw))
  const no = Number(o && o.link)
  ctx.linkTo = Number.isInteger(no) && no >= 1 && no <= ctx.goals.length ? ctx.goals[no - 1] : null
  return null
}

// 第 3 步：站队（每句归哪个核）。只有这一步能改句子归属。
function candidateList(ctx) {
  const letters = 'ABCD'.slice(0, ctx.things.length)
  ctx.letters = letters
  return { letters, list: ctx.things.map((w, i) => `${letters[i]}. ${w.what}`).join('\n') }
}
function assignRequest(ctx) {
  const { letters, list } = candidateList(ctx)
  return {
    system: `只输出一个 JSON 对象：{"assign":{"1":"A"},"empty":[]}
先按件挑句子：每个件（${letters.split('').join(' / ')}）从下面句子里挑出它管的那几句——看句子意思是不是在说这件事，不是看词重合；每件至少一句（真的挑不出才算了）。
再把每句标成字母（最贴的件）；一句真在说两件就给两个；N=纯接话。
只有真的挑不出一句的件，才写进 empty。不要把不同主题的句子凑进一件。不要解释。`,
    text: '候选核：\n' + list + '\n\n句子：\n' + ctx.sents.map((x, i) => `句${i + 1}：${x}`).join('\n'),
    maxTokens: 500, format: '', timeoutMs: 30000,
  }
}
function missingOf(asg, total) {
  const out = []
  for (let i = 1; i <= total; i++) if (!String(asg[i] || '').replace(/[^ABCD]/g, '')) out.push(i)
  return out
}
function assignStep(ctx, raw) {
  const text = rawText(raw)
  const o = grabObj(text)
  const parsed = parseAssign(text)
  const letters = ctx.letters || candidateList(ctx).letters
  const valid = new Set([...letters, 'N'])
  ctx.assign = {}
  // 模型可能给不存在的字母（候选核少了还答 B）——只认候选里有的，别凭空多出一个核
  for (const [i, v] of Object.entries(parsed)) {
    const kept = String(v).split('').filter((L) => valid.has(L)).join('')
    if (kept) ctx.assign[i] = kept
  }
  // 零句子核：判官给了、但一句都没分到的件——记下来，别无声丢
  const empty = new Set()
  for (const L of letters) {
    if (!Object.values(ctx.assign).some((v) => String(v).includes(L))) empty.add(L)
  }
  if (Array.isArray(o && o.empty)) for (const x of o.empty) {
    const L = String(x).trim().toUpperCase()
    if (letters.includes(L)) empty.add(L)
  }
  ctx.emptyCores = [...empty]
  ctx.missing = missingOf(ctx.assign, ctx.sents.length)
  return null
}

// 第 4 步：补判（只问漏掉的句子；没漏就不跑，when 挡）。
function fixRequest(ctx) {
  const { letters, list } = candidateList(ctx)
  return {
    system: `只输出一个 JSON 对象：{"assign":{"1":"A"}}
值只能是 ${letters.split('').join(' / ')} / 两个字母 / N（纯接话）。每句都要给。不要解释。`,
    text: '候选核：\n' + list + '\n\n只判这几句：\n' + ctx.missing.map((i) => `句${i}：${ctx.sents[i - 1]}`).join('\n'),
    maxTokens: 300, format: '', timeoutMs: 30000,
  }
}
function fixStep(ctx, raw) {
  const fx = parseAssign(rawText(raw))
  const letters = ctx.letters || candidateList(ctx).letters
  const valid = new Set([...letters, 'N'])
  for (const i of ctx.missing) {
    const v = fx[i] ?? fx[String(i)]
    if (!v) continue
    const kept = String(v).split('').filter((L) => valid.has(L)).join('')
    if (kept) ctx.assign[i] = kept
  }
  ctx.missing = missingOf(ctx.assign, ctx.sents.length)
  return null
}

// 字面证据（v18 ④，纯代码）：一句命中另一个核名里的两个两字词 → 加挂第二件；
// 只许加挂，不许否掉主判（所以只往后加字母，永不删）。
function literalStep(ctx) {
  for (let i = 1; i <= ctx.sents.length; i++) {
    const cur = String(ctx.assign[i] || '')
    if (!cur || cur.length >= 2) continue
    const k = keysOf(ctx.sents[i - 1])
    for (let j = 0; j < ctx.things.length; j++) {
      const L = ctx.letters[j]
      if (!L || cur.includes(L)) continue
      const overlap = [...keysOf(ctx.things[j].what)].filter((x) => k.has(x)).length
      if (overlap >= 2) { ctx.assign[i] = cur + L; break }
    }
  }
  return null
}

// 回指（v18 ⑤，模型，可选）：两个核其实在说同一件事 → 合并件。
// 只合并、不改单句归属；合并后 assign 里被并的字母替换成保留的字母。
function corefRequest(ctx) {
  const groups = ctx.letters.split('').map((L, j) => (ctx.things[j] ? `${L}. ${ctx.things[j].what}` : '')).filter(Boolean).join('\n')
  return {
    system: `只输出一个 JSON 对象：{"merge":{"B":"A"}}
如果两个核其实在说同一件事（句子里的「它/这个/那个」指的是同一个东西），把后面的并进前面的：键=被并的字母，值=保留的字母。没有就输出 {}。不要解释。`,
    text: '候选核：\n' + groups + '\n\n句子：\n' + ctx.sents.map((x, i) => `句${i + 1}：${x}`).join('\n'),
    maxTokens: 200, format: '', timeoutMs: 30000,
  }
}
function corefStep(ctx, raw) {
  const o = grabObj(rawText(raw))
  const merge = (o && o.merge) || {}
  ctx.merged = {}
  for (const [fromRaw, toRaw] of Object.entries(merge)) {
    const from = String(fromRaw).toUpperCase().replace(/[^ABCD]/g, '').slice(0, 1)
    const to = String(toRaw).toUpperCase().replace(/[^ABCD]/g, '').slice(0, 1)
    if (!from || !to || from === to) continue
    if (!ctx.letters.includes(from) || !ctx.letters.includes(to)) continue
    if (ctx.merged[to]) continue // 防链式：A→B、B→C 只认一次
    for (let i = 1; i <= ctx.sents.length; i++) {
      const cur = String(ctx.assign[i] || '')
      if (cur.includes(from)) ctx.assign[i] = cur.split('').map((L) => (L === from ? to : L)).join('')
    }
    ctx.merged[from] = to
  }
  return null
}

// 第 5 步：接续——每句接着前面哪一句说（可选步骤：失败降级，不中断写帧）。
// 产出 ctx.links：{ 句号: 父句号 }，0 = 开头或接不上。它只给「塌」用，不改进归属。
function linksRequest(ctx) {
  return {
    system: `只输出一个 JSON 对象：{"links":{"2":1,"3":2}}
给每个句子一个父句编号：它接在前面哪一句后面说；开头、或接不上任何一句，写 0；不能写自己。每句都要给。不要解释。`,
    text: '句子：\n' + ctx.sents.map((x, i) => `句${i + 1}：${x}`).join('\n'),
    maxTokens: 300, format: '', timeoutMs: 30000,
  }
}
function linksStep(ctx, raw) {
  const o = grabObj(rawText(raw))
  const src = o && o.links
  const n = ctx.sents.length
  const links = {}
  const put = (i, p) => {
    i = Number(i); p = Number(p) || 0
    if (!i || i < 1 || i > n || p === i) return
    links[i] = Math.min(Math.max(p, 0), n)
  }
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [k, v] of Object.entries(src)) put(String(k).replace(/[^0-9]/g, ''), v)
  } else if (Array.isArray(src)) {
    src.forEach((v, idx) => put(idx + 1, v))
  }
  for (let i = 1; i <= n; i++) if (links[i] == null) links[i] = 0
  ctx.links = links
  ctx.linksReady = true
  return null
}

// 第 6 步：塌——按接续图入度裁核（纯代码，先只标记不删核）。
// 口径：核 L 的入度 = 有多少句「不归 L 的句子」接着 L 里的句子。
// 入度 0 且不含第 1 句 → 孤立（开口没人接是正常的，所以含第一句的核不判孤立）。
function collapseStep(ctx) {
  const n = ctx.sents.length
  // 一句可以归两个核（拓扑相交）：owner 用集合，别用单个字母覆盖
  const ownerSets = {}
  for (const [k, v] of Object.entries(ctx.assign)) {
    const i = Number(k)
    if (!ownerSets[i]) ownerSets[i] = new Set()
    for (const L of String(v)) ownerSets[i].add(L)
  }
  const indeg = {}
  for (const set of Object.values(ownerSets)) for (const L of set) indeg[L] = indeg[L] || 0
  for (let i = 1; i <= n; i++) {
    const p = ctx.links[i] || 0
    if (!p) continue
    const parentSet = ownerSets[p]
    if (!parentSet) continue                    // 父句游离，没有可承重的核
    const childSet = ownerSets[i] || new Set()
    for (const L of parentSet) if (!childSet.has(L)) indeg[L] = (indeg[L] || 0) + 1 // 外面有人接它（共享句两边都算）
  }
  const hasFirstOf = (L) => Object.entries(ownerSets).some(([i, set]) => set.has(L) && Number(i) === 1)
  const orphans = new Set()
  for (const L of Object.keys(indeg)) if (indeg[L] === 0 && !hasFirstOf(L)) orphans.add(L)
  ctx.indeg = indeg
  ctx.orphans = orphans
  return null
}

// 第 7 步：归堆 + 落表（纯代码）。塌的标记写进 plan 列（先只标记、不删核）。
function planOf(ctx, L) {
  if (!ctx.indeg) return null
  return JSON.stringify({ indeg: ctx.indeg[L] || 0, orphan: !!(ctx.orphans && ctx.orphans.has(L)), split: !!ctx.shouldSplit })
}
// 平级边（2026-11-23）：RST-DT 的多核关系（并列/顺序）没有父，不能放 under_id。
// 只做结构判定（交叉→parallel、相邻→sequence）；语义关系（因果/证据/对立）留空等判官——不硬造。
function recordPairEdges(ctx, out) {
  if (out.length < 2) return
  const ins = ctx.db.prepare('INSERT OR REPLACE INTO frame_edges (id, from_id, to_id, rel, created_at) VALUES (?,?,?,?,?)')
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const A = out[i], B = out[j]
      const sa = new Set(A.sents), sb = new Set(B.sents)
      const onlyA = [...sa].filter((x) => !sb.has(x))
      const onlyB = [...sb].filter((x) => !sa.has(x))
      const inter = [...sa].filter((x) => sb.has(x))
      // 包含/相等：一个的句子全在另一个里 → 子挂在父下（parent，方向 子→父）
      if (!onlyA.length || !onlyB.length) {
        if (!onlyA.length && !onlyB.length) continue // 两句集完全相同：同一个核，不写自环
        const childIsA = !onlyA.length
        const child = childIsA ? A : B
        const parent = childIsA ? B : A
        const cId = `${ctx.turnId}-${child.L}`
        const pId = `${ctx.turnId}-${parent.L}`
        const id = `fe_${cId.replace(/[^A-Za-z0-9]/g, '_')}_${pId.replace(/[^A-Za-z0-9]/g, '_')}_parent`
        ins.run(id, cId, pId, 'parent', ctx.at)
        continue
      }
      const rel = inter.length ? 'parallel' : 'sequence' // 交叉=并列，相邻=顺序
      const aId = `${ctx.turnId}-${A.L}`
      const bId = `${ctx.turnId}-${B.L}`
      const id = `fe_${aId.replace(/[^A-Za-z0-9]/g, '_')}_${bId.replace(/[^A-Za-z0-9]/g, '_')}`
      ins.run(id, aId, bId, rel, ctx.at)
    }
  }
}

// 归堆（纯代码）：把「句子→字母」收成核，供判官和落表用。
function collectStep(ctx) {
  const by = {}
  for (const [k, v] of Object.entries(ctx.assign)) for (const L of String(v)) (by[L] = by[L] || []).push(Number(k))
  ctx.cores = Object.entries(by).map(([L, sids]) => {
    // 同一句可能被模型重复归给同一个字母（"AA"），先去重再排
    const sorted = [...new Set(sids)].sort((a, b) => a - b)
    const th = ctx.things[ctx.letters.indexOf(L)] || { what: L }
    return { L, core: th.what, sents: sorted, text: sorted.map((i) => ctx.sents[i - 1]).join('') }
  })
  if (!ctx.cores.length) { ctx.rows = 0; return { stop: true } }
  for (const c of ctx.cores) c.linkTo = ctx.linkTo
  return null
}

// 判官（模型，可选）：判核间语义关系（因果/证据/对立/并列/顺序）和段间关系（同线/换线/对立）。
// 14B 判关系不稳（实测只会「顺序」），所以 optional：失败就只保留结构判出来的边。
function relateRequest(ctx) {
  const cores = ctx.cores.map((c, i) => `${i + 1}. ${c.core}（${c.sents.length}句）`).join('\n')
  return {
    system: `只输出一个 JSON 对象：{"pairs":[{"a":编号,"b":编号,"rel":"cause|evidence|contrast|parallel|sequence"}],"link":"continue|switch|oppose"}
pairs：这段里几件事之间的关系，只写拿得准的，最多 3 对；rel 只能从这五个里选（cause=因果，evidence=证据，contrast=对立，parallel=并列，sequence=顺序）。
link：这一段和「上一段」的关系：continue=同一件事接着讲，switch=换了一件，oppose=对着说。没有上一段就不写 link。
不要解释。`,
    text: '这几件事：\n' + cores + (ctx.linkTo ? `\n\n上一段是：${ctx.linkTo.core || ''}` : ''),
    maxTokens: 300, format: '', timeoutMs: 30000,
  }
}
function relateStep(ctx, raw) {
  const o = grabObj(rawText(raw))
  const ins = ctx.db.prepare('INSERT OR REPLACE INTO frame_edges (id, from_id, to_id, rel, created_at) VALUES (?,?,?,?,?)')
  const edgeId = (a, b, rel) => `fe_${String(a).replace(/[^A-Za-z0-9]/g, '_')}_${String(b).replace(/[^A-Za-z0-9]/g, '_')}_${rel}`
  for (const p of (Array.isArray(o && o.pairs) ? o.pairs : []).slice(0, 3)) {
    const a = Number(p && p.a), b = Number(p && p.b), rel = String((p && p.rel) || '')
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue
    if (!['cause', 'evidence', 'contrast', 'parallel', 'sequence'].includes(rel)) continue
    const A = ctx.cores[a - 1], B = ctx.cores[b - 1]
    if (!A || !B) continue
    const aId = `${ctx.turnId}-${A.L}`, bId = `${ctx.turnId}-${B.L}`
    ins.run(edgeId(aId, bId, rel), aId, bId, rel, ctx.at)
  }
  const link = String((o && o.link) || '')
  if (ctx.linkTo && ctx.linkTo.id && ['continue', 'switch', 'oppose'].includes(link)) {
    const head = ctx.cores.reduce((x, y) => (y.sents.length > x.sents.length ? y : x), ctx.cores[0])
    const hId = `${ctx.turnId}-${head.L}`
    ins.run(edgeId(hId, ctx.linkTo.id, link), hId, ctx.linkTo.id, link, ctx.at)
  }
  return null
}

function writeStep(ctx) {
  const out = ctx.cores || []
  if (!out.length) { ctx.rows = 0; return null }

  const ins = ctx.db.prepare('INSERT OR REPLACE INTO frame_shadow (id, turn_id, seg, created_at, core, core_goal, sents, text, under_id, role, head_id, rel, sat, plan) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  // 一段 = 一个核 + 服务它的句子（核句 + 卫星句都攒在这一段的 sents/sat 里）。
  // 一轮提了几个核就是几段；卫星句先按「核句第一句、其余卫星」结构分，细分留给判官。
  for (const c of out) {
    const id = `${ctx.turnId}-${c.L}`
    const seg = `${ctx.turnId}-${c.L}`
    // sents 存句子编号（结构用），sat 存补话的原话（读的时候直接念）
    const sat = c.sents.slice(1).map((i) => ctx.sents[i - 1]).join('')
    ins.run(id, ctx.turnId, seg, ctx.at, c.core, '', c.sents.join(','), c.text, null,
      'nucleus', null, null, sat || null, planOf(ctx, c.L))
  }
  // 同段内平级边：并列/顺序（没有父，进 frame_edges）
  try { recordPairEdges(ctx, out) } catch { /* 边写坏了不影响核 */ }
  // 段间边由判官步 relate 写；判官失败就没有段间边（降级）。
  ctx.rows = out.length
  ctx.cores = out
  return null
}

/**
 * 找核写链（frame.write）——这条链怎么读、怎么改：
 *
 *   切句（code）→ 提件（local）→ 站队（local）→ 补判（local，有漏才跑）→ 落表（code）
 *
 * - 每步只做一件事：split 产 sentences；things 产 things + linkTo；assign 产 assign + missing；
 *   fix 补 missing；write 归堆落表。后一步只读前一步写在 ctx 上的字段（sents/things/assign/missing）。
 * - 模型步的 request 由 ctx 构造请求、run 解析返回写回 ctx；步骤之间不传局部变量，全在 ctx 上。
 * - 任何一步返回 { stop: true } = 正常提前收工（单句不切、提件空），不算失败。
 * - onError='abort'：任一步抛错就停，记 failedStep，不抛给回复。
 *
 * 怎么换执行体：只换 ctx.runner。现在 runner.local 走 localComplete；
 * 以后提件换宿主就是加 runner.host（用 hostComplete）并把 things 步的 kind 改成 'host'，
 * 链的顺序、解析、落表一律不动。
 *
 * 怎么加一步：在 steps 里插，块号只能同块或往上（验证会在 validateChain 里做），
 * request 从 ctx 取输入、run 把结果写回 ctx；别在步骤里 await 别的链。
 */
export const FRAME_WRITE_CHAIN = {
  id: 'frame.write',
  block: 'chat',
  onError: 'abort',
  steps: [
    { id: 'split', kind: 'code', run: splitStep },
    // ① 题：只判「该不该切帧」，不改结构。可选：模型答不出就跳过。
    // 题：三种问法各一次调用（互相隔离），再取交集——三个塞一起会越答越像
    { id: 'topicsA', kind: 'local', block: 'chat', label: 'frame:write-topics-a', request: topicReq(0), run: topicRun('a'), optional: true, when: (ctx) => ctx.sents.length >= 1 },
    { id: 'topicsB', kind: 'local', block: 'chat', label: 'frame:write-topics-b', request: topicReq(1), run: topicRun('b'), optional: true, when: (ctx) => ctx.sents.length >= 1 },
    { id: 'topicsC', kind: 'local', block: 'chat', label: 'frame:write-topics-c', request: topicReq(2), run: topicRun('c'), optional: true, when: (ctx) => ctx.sents.length >= 1 },
    { id: 'topicsMerge', kind: 'code', run: topicsMergeStep, when: (ctx) => ctx.sents.length >= 1 },
    // 判官（宿主）：合并三份候选 + 看整段补漏/删非事。失败回退本地合并，不拖垮写帧。
    { id: 'judge', kind: 'host', block: 'chat', label: 'frame:write-judge', request: judgeRequest, run: judgeStep, optional: true, when: (ctx) => ctx.sents.length >= 1 },
    { id: 'assign', kind: 'local', block: 'chat', label: 'frame:write-assign', request: assignRequest, run: assignStep },
    { id: 'fix', kind: 'local', block: 'chat', label: 'frame:write-fix', request: fixRequest, run: fixStep, when: (ctx) => Array.isArray(ctx.missing) && ctx.missing.length > 0 },
    // ④ 字面证据：纯代码加挂第二件。
    { id: 'literal', kind: 'code', run: literalStep },
    // ⑤ 回指：合并件。可选：失败就不合并。
    { id: 'coref', kind: 'local', block: 'chat', label: 'frame:write-coref', request: corefRequest, run: corefStep, optional: true, when: (ctx) => ctx.sents.length >= 1 && ctx.things.length >= 2 },
    // ⑥ 接续：可选步骤，只给塌用；模型失败就降级（linksReady 不置），塌被 when 跳过，写帧照常。
    { id: 'links', kind: 'local', block: 'chat', label: 'frame:write-links', request: linksRequest, run: linksStep, optional: true, when: (ctx) => ctx.sents.length >= 1 },
    // 接续：分配之后才问「这一段接哪条线往下走」（候选核定了再判接谁）。
    { id: 'attach', kind: 'local', block: 'chat', label: 'frame:write-attach', request: attachRequest, run: attachStep, optional: true, when: (ctx) => ctx.things.length >= 1 },
    // ⑦ 塌：按接续图入度裁核；先只标记（plan.indeg / plan.orphan），不删核。
    { id: 'collapse', kind: 'code', run: collapseStep, when: (ctx) => ctx.linksReady === true },
    // 归堆：把句子收成核（判官和落表都要）
    { id: 'collect', kind: 'code', run: collectStep },
    // 判官：核间语义关系 + 段间关系；可选，失败只保留结构边
    { id: 'relate', kind: 'local', block: 'chat', label: 'frame:write-relate', request: relateRequest, run: relateStep, optional: true },
    { id: 'write', kind: 'code', run: writeStep },
  ],
}

// 入口：调用方**不要 await**（扔出去），它自己吞掉所有错误。
// 保留这个签名：replay-frames.mjs 和 turn_write.js 都直接调它。
export async function shadowFrame(db, aid, { reply, turnId, at }) {
  try {
    if (String(getFlag(db, 'affect.frame.shadow') || 'off') !== 'on') return
    const ts = at || new Date().toISOString()
    const tid = turnId || ts
    ensureTable(db)
    const ctx = {
      db, aid, reply, turnId: tid, at: ts, text: String(reply || ''),
      sents: [], things: [], topicSets: { a: [], b: [], c: [] }, emptyCores: [], linkTo: null, assign: {}, missing: [], rows: 0,
      runner: {
        local: (req, meta) => localComplete(db, { ...req, block: meta.block, label: meta.label }),
        host: (req, meta) => hostComplete(db, {
          ...req, agent: aid, label: meta.label, block: meta.block, priority: 1,
          complete: (r) => kernelModel.complete(r),
        }),
      },
      key: tid,
    }
    const res = await runChain(FRAME_WRITE_CHAIN, ctx, {
      onStep: (rec) => { try { recordStep(db, aid, tid, rec) } catch { /* 记账失败不影响链 */ } },
    })
    try {
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
        nid('evt_'), aid, 'frame.write',
        JSON.stringify({
          turnId: tid, ok: res.ok, rows: ctx.rows, ms: res.ms, stopped: !!res.stopped,
          failedStep: res.failedStep || null,
          topics: ctx.topics || [], split: !!ctx.shouldSplit, merged: ctx.merged || {}, emptyCores: ctx.emptyCores || [],
          // 2026-11-23：记下判官给的核和分配的归属，0 行时能一眼看出丢在判官还是分配
          things: (ctx.things || []).map((x) => x.what),
          assign: ctx.assign || {}, missing: ctx.missing || [],
          steps: res.steps.map((s) => ({ id: s.id, ok: s.ok, ms: s.ms, skipped: !!s.skipped, stop: !!s.stop, optional: !!s.optional, degraded: !!s.degraded, err: s.err })),
        }),
        new Date().toISOString(),
      )
    } catch { /* 记账失败不影响影子 */ }
  } catch { /* 影子失败不影响对话，也不打日志（影子是只写不读的旁路，噪音比信息多） */ }
}

// 每步一条小账：失败、提前收工、慢步骤（>3s）各记一条；正常快步骤只进 frame.write 汇总，别把 events 撑爆。
const SLOW_STEP_MS = 3000
function recordStep(db, aid, turnId, rec) {
  const slow = rec.ok && !rec.stop && rec.ms >= SLOW_STEP_MS
  if (rec.ok && !rec.stop && !slow) return
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
      nid('evt_'), aid, 'frame.write.step',
      JSON.stringify({ turnId, step: rec.id, kind: rec.kind, ok: rec.ok, ms: rec.ms, slow, stop: !!rec.stop, err: rec.err }),
      new Date().toISOString(),
    )
  } catch { /* 记账失败不影响链 */ }
}
