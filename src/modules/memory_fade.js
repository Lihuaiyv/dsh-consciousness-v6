/**
 * 记忆的内容级模糊（保守版）。
 *
 * 现状：旧事只在前面挂一块「有点糊」的牌子，正文还是原话照抄，一个字没少。
 * 那不叫糊，叫穿了件旧衣服。
 *
 * 这里做**纯删除**：只把括号注释、数字、引号里的原话拿掉，不改写、不生成、不调模型。
 * 所以「输出是输入的子序列」这条永远成立——多出一个字就算 bug。
 *
 * 保守在哪：
 *   1. 30 天以内一个字都不动；
 *   2. 带因果 / 否定 / 承诺词的句子，数字和引号一律不碰（那些多半是重点）；
 *   3. 括号里若是原因（含保护词），括号也不删；
 *   4. 删到只剩原文 60% 以下就整档回退——宁可啰嗦，也不许削成「主人说过一件事」。
 *
 * 为什么不用 R：tiers.touch() 每次召回都把 last_decay_at 拨回现在，
 * 用 R 当年龄等于永远不老。这里只认 created_at。
 */

/** 保护词：出现这些，说明这句话有「原因 / 边界 / 承诺」，不能当细节削。 */
// 「别」要排除「特别 / 别的 / 告别」这类假阳性，否则一句无关的话也会被整句保下来。
// 「怕」同理，排除「哪怕」。
const PROTECT_RE = /(因为|所以|但是|不过|不想|不要|不许|不准|必须|答应|承诺|约定|边界|讨厌|喜欢|最怕|记得|千万|(?<![哪])怕|(?<![特告级类])别(?![的人处样]))/

/** 年龄 → 档位。30 / 90 / 180 天。 */
export function fadeLevel(days) {
  if (days == null || !Number.isFinite(Number(days))) return 0
  const d = Number(days)
  if (d < 30) return 0
  if (d < 90) return 1
  if (d < 180) return 2
  return 3
}

/** 删括号注释（中英文都算）。括号里带保护词的保留。 */
function stripParens(s) {
  return s.replace(/（([^）]{1,40})）|\(([^)]{1,40})\)/g, (m, a, b) => {
    const inner = a || b || ''
    return PROTECT_RE.test(inner) ? m : ''
  })
}

/**
 * 删「什么时候 / 隔了多久」，整段一起删，不留半截。
 *
 * 只认**数字 + 时间单位**。中文的「一 / 两 / 十」本身是普通字：
 * 连「一起 / 一定 / 一下 / 一点 / 一直 / 两个人」一起删，句子就废了
 * （真实库 1117 条上实测，旧写法误伤 14 条）。所以：
 *   - 中文数字后面必须紧跟时间单位（「三天」「两个月」「十分钟」）；
 *   - 裸「月 / 点 / 分」只跟阿拉伯数字走（「3 月」「3 点」），
 *     否则「一月」「三点」这类会被拆掉；
 *   - 「个 / 块 / 条 / 页 / 行 / 次」这类量词一律不认——
 *     行号、个数、金额不是「记糊了」该糊的东西。
 */
const NUM_TIME_RE = new RegExp(
  // 阿拉伯数字 + 时间单位（含裸「月 / 点 / 分 / 秒」）
  '\\d{1,4}(?:\\.\\d+)?\\s*(?:个?月(?!份)|年|日|号|天|周|点|分|秒|小时|分钟)(?:钟|半)?(?:前|后|左右|多|以上|以下)?'
  // 中文数字 + 时间单位（不含裸「月 / 点 / 分」）
  + '|[一二三四五六七八九十两]{1,3}\\s*(?:个?月(?!份)|年|日|号|天|周|小时|分钟)(?:前|后|左右|多|以上|以下)?',
  'g',
)

function stripNumbers(s) {
  // 有保护词就整句不动：删掉「十点以后别吵」里的十点，等于把这句废了
  if (PROTECT_RE.test(s)) return s
  return s.replace(NUM_TIME_RE, '')
}

/** 删引号里的原话：原话最容易记岔，但引号里常常正是承诺的内容。 */
function stripQuotes(s) {
  if (PROTECT_RE.test(s)) return s
  return s.replace(/「[^」]{1,40}」|『[^』]{1,40}』|“[^”]{1,40}”|"[^"]{1,40}"/g, '')
}

/** 删完收拾一下标点：不留「，，」「，。」这种残渣。 */
function tidy(s) {
  return String(s)
    .replace(/[，、；：]{2,}/g, '，')
    .replace(/[，、；：]([。！？])/g, '$1')
    .replace(/^[，、；：\s]+/, '')
    .replace(/[，、；：\s]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 类型 → importance 门槛（A1）。
 *
 * 原来是一个数 0.7 卡所有类型。真实库 1142 条一跑就看出问题：793 条 `reflection`
 * （我自己写的反思）分数是双峰的——一半 0.50、一半 0.95，中间几乎没有。
 * 0.7 的门槛等于把「高分的反思」整类豁免，规则看着在跑，其实只筛到两种类型。
 *
 * 所以改成按类型给门槛：类型决定「这一类比别的类多容易被糊」，
 * importance 只在同一类里做「特别重要就留全」的补充。
 *
 * 不在表里的类型（含空）一律不删——将来加了新类型，默认不会被悄悄改掉。
 */
const IMPORTANCE_GATE = {
  // 发生过的事 / 见闻 / 对事对人的评价：打过高分的那条单独留着
  fact: 0.7,
  episode: 0.7,
  appraisal: 0.7,
  // 我自己的反思：只有最高那一档（0.95）留全，其余照样会糊。
  // 日记的细节本来就该记不清——但不能因为它分数天生偏高就整类免疫。
  reflection: 0.95,
}

/**
 * 一个字都不许删的类型：立场 / 边界 / 承诺 / 禁忌 / 身份 / 冲突。
 * 单独一张表，不能靠「门槛设成 1.01」糊弄——importance 本来就很少到 1，
 * 那样写等于「永远放行」，方向正好反了。
 */
const KEEP_TYPES = new Set(['value', 'boundary', 'taboo', 'promise', 'identity', 'conflict'])

/**
 * 这条记忆要不要参与模糊。钉住的一律不动，豁免类型不动，类型不在门槛表里的不动。
 */
export function shouldFade(item, days) {
  if (!item) return false
  if (String(item.mark || '') === 'locked') return false
  const type = String(item.type || '')
  if (KEEP_TYPES.has(type)) return false
  const gate = IMPORTANCE_GATE[type]
  if (gate == null) return false
  if (Number(item.importance || 0) >= gate) return false
  return fadeLevel(days) > 0
}

/**
 * 复习抵年龄（第 1 步）。
 *
 * 现在的年龄是单调的：一条被反复想起的旧事，和一条一年没人提的，糊得一样狠。
 * 真实记忆不是这样——复习过的更牢。
 *
 * 所以算一个「有效年龄」：真实年龄 ÷ (1 + log(1+hits)/4)，最近 7 天被想起过再打 15% 折。
 * 两个护栏：
 *   - hits 封顶 30，防止一个热门锚点把年龄抹成 0；
 *   - 有效年龄不低于真实的 50%，别把一年说成半年以下。
 *
 * @param {number} ageDays 真实年龄（天）
 * @param {number} hits 被想起次数
 * @param {string|number} lastHitAt 最后一次被想起
 * @param {number} [now]
 */
export function rehearseAdjustedAge(ageDays, hits, lastHitAt, now = Date.now()) {
  if (ageDays == null) return ageDays
  const age = Number(ageDays)
  if (!Number.isFinite(age) || age < 0) return ageDays
  const h = Math.min(30, Math.max(0, Number(hits) || 0))
  const credit = 1 + Math.log1p(h) / 4
  let eff = age / credit
  const t = typeof lastHitAt === 'number' ? lastHitAt : Date.parse(String(lastHitAt || ''))
  if (Number.isFinite(t) && now - t < 7 * 86400000) eff *= 0.85
  return Math.max(age * 0.5, eff)
}

/**
 * 删完读一遍（第 2 步）。
 *
 * 只卡长度不够——删出来的句子可能通顺但缺主语，读着像缺牙：
 * 「（主人）今天在改接线」删掉括号就没人了。
 *
 * 四道最便宜的检查：不能是空/太短、不能以标点开头、不能以虚词结尾、
 * 原来有主语的话删完还得有主语。
 */
const SUBJECT_RE = /(主人|你|我|他|她|它)/
// 只拦真正的残句：「和 / 与 / 或 / 跟 / 比」结尾，说明宾语被删掉了。
// 原来还拦「的了吗呢吧啊着过」——中文里这些字做句尾完全合法
// （「然后再说别的」「你吃了吗」），拦了只会把整档砍掉，删不出任何东西。
const BAD_TAIL = /[和与或跟比]$/

export function stillReadable(before, after) {
  const a = String(after || '')
  const b = String(before || '')
  if (Array.from(a).length < 12) return false
  if (/^[，。、；：！？,.;:!?]/.test(a)) return false
  if (BAD_TAIL.test(a)) return false
  // 原来点了名，删完不能把点名删掉
  if (SUBJECT_RE.test(b) && !SUBJECT_RE.test(a)) return false
  return true
}

/**
 * @param {string} text
 * @param {number|null} days
 * @param {{maxLevel?:number}} [opt]
 * @returns {{text:string, level:number, removed:number}}
 */
export function fadeText(text, days, opt = {}) {
  const src = String(text || '')
  const wanted = Math.min(Number(opt.maxLevel == null ? 3 : opt.maxLevel), fadeLevel(days))
  // 门槛跟 floor 对齐（都是 12 字）：低于这个长度连 floor 都过不了，直接原样返回。
  // 原来是 20 字——但调用方先 oneLine 裁过一轮，句号也被吃掉了，
  // 一句 20 字的记忆裁完剩 19 字，就永远进不来。
  const len = Array.from(src).length
  if (!src || wanted <= 0 || len < 12) return { text: src, level: 0, removed: 0 }

  // 下限两档：绝对 12 字，加相对一半。
  // 原来是六成——太严了。中文括号注释常占三到四成，删掉一个「（那部分一直没弄完）」
  // 就跌破 60%，等于永远删不动。一半 + 12 字 + 再读一遍，够守住「不许削成半句」。
  const floor = Math.max(12, Math.ceil(len * 0.5))
  let out = src
  let applied = 0
  for (let L = 1; L <= wanted; L++) {
    let next = out
    if (L >= 1) next = tidy(stripParens(next))
    if (L >= 2) next = tidy(stripNumbers(next))
    if (L >= 3) next = tidy(stripQuotes(next))
    // 削过头就停：宁可停在这一档，也不许把句子削成半句
    if (Array.from(next).length < floor) break
    // 删完读不通（缺主语 / 尾巴是虚词）也停在这一档
    if (!stillReadable(src, next)) break
    // 这一档没删掉东西不代表下一档也没有（比如没括号但有数字），继续往下走
    if (next !== out) { out = next; applied = L }
  }
  return { text: out, level: applied, removed: len - Array.from(out).length }
}
