/**
 * 「读人」：出现人物 → 判断关系 → 记录人物。
 *
 * 规则抽取（relations.extractMentions）只管句式，漏的话没人补。这一层换个思路：
 *   1) 先看这句话里有没有「人的信号」——称呼、亲属、名字、已知的人；
 *   2) 有就把原话交给模型，让它把「提到谁、是谁的谁、跟我算什么」读出来；
 *   3) 写回账本：人、和主人的边、人和人的边，都走 relations 的正式入口。
 *
 * 模型是异步的：入队（rel_extract_queue）→ worker 慢慢跑，进程重启不丢。
 */
import * as R from './relations.js'
import { now } from '../db.js'

const ROLE_HINT = /(?:朋友|同事|同学|室友|闺蜜|兄弟|姐妹|邻居|客户|领导|老板|老师|医生|师傅|教练|搭档|队友|房东|亲戚|家人|叔叔|阿姨|舅舅|姑姑|表哥|表姐|堂哥|堂姐|哥哥|姐姐|弟弟|妹妹|爸爸|妈妈|儿子|女儿|老公|老婆|丈夫|妻子|对象|男友|女友|前妻|前夫|前任)/

/** 中文昵称的常见起手：小周、老王、阿念、大刘；姓氏表覆盖不到的那些见 NICK_ANY。 */
const NAME_HINT = /(?:叫|名叫|名字是|名字叫|姓[\u4e00-\u9fa5])/
const HONOR_HINT = /[\u4e00-\u9fa5]{1,2}(?:哥|姐|总|老师|叔|姨|医生|师傅)/

/**
 * 昵称不止「小 + 姓氏」：小黑、小白、小七都不在百家姓里，可它们就是人。
 * 这一层只回答「值不值得跑一次模型」，所以宁可放行——是不是人由模型判。
 * NICK_STOP 挡的是「小时 / 小区 / 老家」这种天天出现、肯定不是人的词。
 */
const NICK_ANY = /[小老阿大][\u4e00-\u9fa5]/g
const NICK_STOP = new Set([
  '小时', '小心', '小区', '小事', '小声', '小米', '小说', '小组', '小数', '小孩', '小伙',
  '小结', '小写', '小计', '小量', '小样', '小窗', '小游戏', '小程序', '小工具',
  '老乡', '老家', '老师', '老板', '老大', '老实', '老化', '老鼠', '老外', '老是', '老早',
  '大家', '大概', '大约', '大量', '大学', '大气', '大脑', '大楼', '大会', '大纲', '大小', '大屏',
  '阿姨',
])

/** 「早上我遇到了小黑」：没有称呼、没有「叫」，但动词后面跟着一个像人名的词。 */
const CONTACT_HINT = /(?:遇到|碰见|遇见|见到|认识了|认识)(?:了|到|过)?\s*[「“]?([\u4e00-\u9fa5]{2,4})/
const NOT_NAME_CHAR = new Set(Array.from('的了着过个人们位次些点种下上中里外前后都很也太真还再又才刚已不是没有会想要说这那你我他她它谁哪啥什'))

/** 名称类脏词：分类不是人，模型偶尔会把「主人」写在 persons 里。 */
const NOT_A_PERSON = new Set([
  '主人', '熟人', '生人', '陌生人', '意识体', '我', '你', '他', '她', '它', '他们', '她们',
  '大家', '别人', '有人', '朋友', '同事', '同学', '老板', '领导', '客户', '老师', '家人',
  '老公', '老婆', '对象', '丈夫', '妻子', '儿子', '女儿', '爸爸', '妈妈', '哥哥', '姐姐',
  '弟弟', '妹妹', '亲戚', '用户', '对方', '这个人', '那个人',
])

/** 「小X / 老X / 阿X / 大X」里有一个不在 NICK_STOP 里的。 */
function nickLike(s) {
  for (const m of String(s || '').matchAll(NICK_ANY)) {
    if (!NICK_STOP.has(m[0])) return true
  }
  return false
}

/** 「遇到 / 碰见 / 见到」后面那个词像人名：「遇到麻烦了」「遇到一个问题」不算。 */
function contactLike(s) {
  const m = String(s || '').match(CONTACT_HINT)
  if (!m) return false
  if (NOT_A_PERSON.has(m[1])) return false
  return Array.from(m[1]).every((c) => /[\u4e00-\u9fa5]/.test(c) && !NOT_NAME_CHAR.has(c))
}

/** 这句话里有没有「人」。宁可多跑一次模型，也别把「我朋友小周」漏成背景。 */
export function hasPersonSignal(db, aid, text) {
  const s = String(text || '')
  if (s.length < 2) return false
  if (ROLE_HINT.test(s) || NAME_HINT.test(s) || HONOR_HINT.test(s)) return true
  // 姓氏表覆盖不到的昵称（小黑）和「遇到某人」（张三）也要进模型，别在门口就漏掉。
  if (nickLike(s) || contactLike(s)) return true
  try {
    const persons = db.prepare("SELECT name,aliases FROM rel_person WHERE agent_id=? AND status<>'archived'").all(aid)
    for (const p of persons) {
      const names = [p.name, ...JSON.parse(p.aliases || '[]')].filter(Boolean)
      if (names.some((n) => String(n).length >= 2 && s.includes(n))) return true
    }
  } catch { /* 表还没建好就当没信号 */ }
  return false
}

const PROMPT = [
  '你是关系账本的「读人」器。输入是用户刚说的一句话（可能有前一句上下文）。',
  '任务：找出话里被提到的所有第三人（说话人「我」和对话对象「你」不算人）。',
  '对每个人判断三件事：叫什么（用原话里的称呼）、跟主人是什么关系（朋友/同事/夫妻/父子……原话里的关系词）、跟意识体该算什么分寸（owner 主人 / acquaintance 熟人候选 / stranger 生人；没明说就 stranger）。',
  '两个人之间有关系（「小周和老陈是夫妻」），单独写一条边。',
  '只认话里出现过的名字，不能编；名字必须从原话里原样截取，能长不短（原话是「小小尼姑」就写「小小尼姑」，不能缩成「小小尼」）；拿不准的名字只放进 unclear，不要写进 persons；没有人物就返回空数组。',
  '只输出 JSON：{"persons":[{"name":"小周","tier":"acquaintance","relation_to_user":"朋友","summary":"主人的朋友","confidence":0.9,"evidence":"原话片段"}],"edges":[{"from":"小周","to":"老陈","role":"夫妻","confidence":0.9,"evidence":"原话片段"}],"unclear":["拿不准的称呼"]}',
].join('\n')

export function enqueueRelationRead(db, aid, opts = {}) {
  const text = String(opts.text == null ? '' : opts.text).trim()
  if (!text) return null
  if (!hasPersonSignal(db, aid, text)) return null
  const eventId = opts.eventId ? String(opts.eventId) : null
  try {
    if (eventId) {
      const dup = db.prepare("SELECT id FROM rel_extract_queue WHERE agent_id=? AND event_id=? LIMIT 1").get(aid, eventId)
      if (dup) return dup.id
    }
    const id = 'rq_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const ts = now()
    db.prepare(`INSERT INTO rel_extract_queue(id,agent_id,event_id,turns,state,attempts,next_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, aid, eventId, JSON.stringify([{ role: 'user', text: text.slice(0, 2000) }]),
      'pending', 0, ts, ts, ts,
    )
    return id
  } catch { return null }
}

function parseJson(raw) {
  const s = String(raw || '')
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error('not json')
  return JSON.parse(s.slice(first, last + 1))
}

/**
 * 模型偶尔回一段坏 JSON（少逗号、多一个逗号、被截断）。整句丢掉太亏：
 * 名字一定在 "name":"…" 里，扫一遍就能把人捞回来（和 appraise 的兜底同一思路）。
 * 只认原话里出现过的名字——模型把输入里的 known 列回显时不会长出假人。
 */
function salvagePersons(raw, text) {
  const s = String(raw || '')
  const out = []
  const seen = new Set()
  for (const m of s.matchAll(/"name"\s*:\s*"([^"\\\r\n]{1,24})"/g)) {
    const name = m[1]
    if (!name || seen.has(name) || !text.includes(name)) continue
    seen.add(name)
    const near = s.slice(m.index, m.index + 240)
    const tier = (near.match(/"tier"\s*:\s*"(owner|acquaintance|stranger)"/) || [])[1] || 'stranger'
    const summary = (near.match(/"summary"\s*:\s*"([^"\\\r\n]{1,120})"/) || [])[1] || null
    out.push({ name, tier, summary, confidence: 0.6 })
  }
  return out.length ? { persons: out, edges: [] } : null
}

/** 「同学叫小花」里模型可能把「叫小花」整个当名字：引称动词不成名，先剥掉。 */
const NAME_LEAD = /^(?:叫做?|名叫|名字叫|名字是|是)/

/** 称呼后缀：模型把四字昵称截成三字时，只补这些字，不补后面的普通词。 */
const NAME_TAIL = new Set(Array.from('姑姐妹哥弟姨叔婶总'))

/**
 * 「小小尼姑」被模型回成「小小尼」：名字是原话子串，光靠 includes 校验抓不住。
 * 按原话往后看一位，紧跟着是称呼后缀就补回去——「小绿今天」的「今」不在表里，不会被吞。
 */
function extendTail(name, text) {
  let full = name
  for (let i = 0; i < 2; i++) {
    const at = String(text).indexOf(full)
    if (at < 0) break
    const ch = String(text)[at + full.length]
    if (!ch || !NAME_TAIL.has(ch)) break
    full += ch
  }
  return full
}

function cleanName(name, text) {
  let n = String(name == null ? '' : name).trim().replace(/^[「"'“”‘’]+|[」"'“”‘’]+$/g, '')
  const bare = n.replace(NAME_LEAD, '').trim()
  if (bare.length >= 2) n = bare
  if (!n || n.length > 16) return ''
  if (NOT_A_PERSON.has(n)) return ''
  // 聊功能的时候模型会把界面词当人名：「关系图」「手动添加」不是人
  if (/添加|删除|关系|菜单|设置|功能|页面|按钮|下拉|收起|展开|导入|导出|刷新|保存|取消/.test(n)) return ''
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(n)) return ''
  // 模型爱编：名字必须在原话里出现过
  if (!String(text).includes(n)) return ''
  n = extendTail(n, text)
  if (n.length > 16) return ''
  return n
}

function findPerson(db, aid, name) {
  const q = R.normalizeName(name)
  return R.listPersons(db, aid, {}).find((p) =>
    [p.name, ...(p.aliases || [])].some((n) => R.normalizeName(n) === q)) || null
}

/**
 * 把模型读出来的结果写进账本：人 → 边（对主人）→ 边（他-他）。
 * 幂等：同一个人、同一条边重复写只会更新，不会多出一个。
 */
export function applyRead(db, aid, data, meta = {}) {
  const text = String(meta.text || '')
  const out = { persons: [], edges: [], skipped: [] }
  const byName = new Map()
  const owner = R.ownerPerson(db, aid)
  for (const raw of Array.isArray(data?.persons) ? data.persons : []) {
    const name = cleanName(raw && raw.name, text)
    if (!name) { out.skipped.push(String(raw && raw.name || '')); continue }
    const tierRaw = raw && raw.tier
    const tier = R.TIER_KEYS.includes(tierRaw) ? tierRaw : 'stranger'
    const summary = String(raw && raw.summary || '').slice(0, 200) || null
    const aliases = Array.isArray(raw && raw.aliases) ? raw.aliases.filter((a) => cleanName(a, text)).slice(0, 4) : []
    const roleToUser = String(raw && raw.relation_to_user || '').slice(0, 12)
    const confidence = Math.max(0.1, Math.min(1, Number(raw && raw.confidence) || 0.6))
    let person = findPerson(db, aid, name)
    if (person) {
      // 已有的人：补空摘要、补别名，tier 只在没被人手动改过时听模型的
      const patch = { name: person.name }
      if (!person.summary && summary) patch.summary = summary
      const allAlias = Array.from(new Set([...(person.aliases || []), ...aliases]))
      if (allAlias.length > (person.aliases || []).length) patch.aliases = allAlias
      if (person.source === 'chat' && tier !== person.tier) patch.tier = tier
      if (Object.keys(patch).length > 1) R.remember(db, aid, patch, { source: 'auto' })
      person = findPerson(db, aid, person.name) || person
    } else {
      R.remember(db, aid, { name, tier, summary, aliases }, { source: 'auto' })
      person = findPerson(db, aid, name)
    }
    if (!person) { out.skipped.push(name); continue }
    byName.set(name, person.id)
    if (owner && owner.id !== person.id && roleToUser) {
      R.upsertEdgeApi(db, aid, {
        from_id: owner.id, to_id: person.id, kind: 'relation', role_label: roleToUser, confidence,
      })
      out.edges.push(owner.name + '—' + person.name + ' ' + roleToUser)
    }
    out.persons.push(person.name)
  }
  for (const raw of Array.isArray(data?.edges) ? data.edges : []) {
    const a = cleanName(raw && raw.from, text)
    const b = cleanName(raw && raw.to, text)
    if (!a || !b || a === b) continue
    const pa = byName.get(a) || (findPerson(db, aid, a) || {}).id
    const pb = byName.get(b) || (findPerson(db, aid, b) || {}).id
    if (!pa || !pb) continue
    const role = String(raw && raw.role || '').slice(0, 12)
    R.upsertEdgeApi(db, aid, {
      from_id: pa, to_id: pb, kind: 'relation', role_label: role || null,
      confidence: Math.max(0.1, Math.min(1, Number(raw && raw.confidence) || 0.6)),
    })
    out.edges.push(a + '—' + b + ' ' + (role || '有关系'))
  }
  return out
}

let reading = false

/** worker：一次处理一条到期的「读人」任务。 */
export async function tickRelationRead(db, aid, opts = {}) {
  if (reading) return { skipped: 'busy' }
  if (typeof opts.complete !== 'function') return { skipped: 'no-model' }
  reading = true
  try {
    const ts = now()
    const row = db.prepare("SELECT * FROM rel_extract_queue WHERE agent_id=? AND state IN ('pending','running') AND next_at<=? ORDER BY created_at LIMIT 1").get(aid, ts)
    if (!row) return { skipped: 'empty' }
    db.prepare("UPDATE rel_extract_queue SET state='running', updated_at=? WHERE id=?").run(ts, row.id)
    let turns = []
    try { turns = JSON.parse(row.turns || '[]') } catch { turns = [] }
    const text = turns.map((t) => t.text).join('\n').slice(0, 2000)
    const known = R.listPersons(db, aid, {}).map((p) => p.name).slice(0, 60)
    let data = null
    try {
      const raw = await opts.complete({
        system: PROMPT,
        text: JSON.stringify({ owner: (R.ownerPerson(db, aid) || {}).name || '主人', known, said: text }),
      })
      try { data = parseJson(raw) } catch (parseErr) {
        // 坏 JSON：先尽量把名字捞回来；捞不到才按失败重试，别把整句话丢了
        data = salvagePersons(raw, text)
        if (!data) throw parseErr
      }
    } catch (e) {
      const attempts = Number(row.attempts || 0) + 1
      const state = attempts >= 3 ? 'failed' : 'pending'
      const nextAt = new Date(Date.now() + attempts * 30000).toISOString()
      db.prepare('UPDATE rel_extract_queue SET state=?, attempts=?, next_at=?, last_error=?, updated_at=? WHERE id=?')
        .run(state, attempts, nextAt, String(e && e.message || e).slice(0, 200), now(), row.id)
      return { ok: false, error: String(e && e.message || e) }
    }
    const applied = applyRead(db, aid, data, { text })
    db.prepare("UPDATE rel_extract_queue SET state='done', last_error=NULL, updated_at=? WHERE id=?").run(now(), row.id)
    return { ok: true, ...applied }
  } finally {
    reading = false
  }
}

/** 测试 / 补跑用：清掉队列里失败的任务。 */
